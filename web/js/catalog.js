// Left panel: search catalog by item / fluid / machine, production & consumption.
import { $t } from './i18n.js';
import { api } from './api.js';
import { esc, num, slotHtml, iconHtml, seconds, TIERS, nm, mname } from './fmt.js';
import { prefs } from './prefs.js';

export function recipeCardHtml(r, ds, opts = {}) {
  const ins = r.inputs.map(e => slotHtml(e, ds)).join('');
  const outs = r.outputs.map(e => slotHtml(e, ds)).join('');
  const gt = r.gt;
  const info = gt
    ? `${gt.durationTicks != null ? seconds(gt.durationTicks) + ` (${gt.durationTicks} t)` : $t('— с')} · ${gt.eut != null ? num(gt.eut) + ' EU/t' : '— EU/t'}${gt.tierName ? ' · ' + gt.tierName : ''}`
    : $t('без данных GT (длительность/EU не экспортированы)');
  const meta = (gt?.metadata || []).map(m => `${esc(m.key)}=${num(m.value)}`).join(', ');
  const custom = r.dataset === 'custom';
  const src = custom ? `<span class="badge custom">${$t("свой")}</span>${r.source?.type === 'copy' ? ` <small>${$t("копия")} ${esc(r.source.recipeId)}</small>` : ''}` : '';
  return `<div class="rcard ${opts.cls || ''}" draggable="true" data-recipe="${esc(r.id)}">
    <div class="rhead"><span>${esc(mname(r.machine))}</span>${src}</div>
    <div class="rbody"><div class="rslots">${ins}</div><div class="rarrow">➜</div><div class="rslots">${outs}</div></div>
    <div class="rinfo">${info}${meta ? `<br><small>${meta}</small>` : ''}</div>
    <div class="ractions"><small class="rid" title="${$t("Стабильный ID рецепта")}">${esc(r.id)}</small>
      <button data-act="add" title="${$t("Добавить на холст")}">${$t("На холст")}</button>
      ${custom ? `<button data-act="edit">${$t("Изменить")}</button><button data-act="del" title="${$t("Удалить из своей базы")}">✕</button>` : `<button data-act="copy" title="${$t("Скопировать в свою базу (с сохранением источника)")}">${$t("В свои")}</button>`}
    </div></div>`;
}

export class CatalogPanel {
  constructor(el, app) {
    this.el = el; this.app = app;
    this.mode = 'goods';
    this.state = null; // {view:'goods'|'machine'|'custom', ...}
    el.innerHTML = `
      <div class="ptabs"><button data-mode="goods" class="on">${$t("Ресурсы")}</button><button data-mode="machine">${$t("Машины")}</button><button data-mode="custom">${$t("Свои рецепты")}</button></div>
      <div class="searchbox"><input type="search" placeholder="${$t("Поиск: предмет, жидкость или ID (рус./англ.)…")}" autocomplete="off"></div>
      <div class="pending" hidden></div>
      <div class="cbody"></div>`;
    this.input = el.querySelector('input');
    this.body = el.querySelector('.cbody');
    this.pendingEl = el.querySelector('.pending');
    let timer;
    this.input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => this.search(), 200); });
    this.input.addEventListener('keydown', e => { if (e.key === 'Enter') { clearTimeout(timer); this.search(); } });
    el.querySelector('.ptabs').addEventListener('click', e => {
      const m = e.target.dataset.mode; if (!m) return;
      this.setMode(m);
    });
    this.body.addEventListener('click', e => this.onClick(e));
    this.body.addEventListener('dragstart', e => {
      const c = e.target.closest('.rcard'); if (!c) return;
      e.dataTransfer.setData('text/gtnh-recipe', c.dataset.recipe);
    });
    this.body.addEventListener('change', e => {
      if (e.target.matches('select.mfilter')) { this.state.machine = e.target.value || null; this.state.offset = 0; this.loadRecipes(); }
    });
  }

  /** Redraw after the name language changes. */
  rerender() { if (this.state) this.loadRecipes(); else this.search(); }

  setMode(m, { search = true } = {}) {
    this.mode = m;
    for (const b of this.el.querySelectorAll('.ptabs button')) b.classList.toggle('on', b.dataset.mode === m);
    this.input.placeholder = m === 'machine' ? $t('Поиск машины / карты рецептов…') : m === 'custom' ? $t('Фильтр своих рецептов…') : $t('Поиск: предмет, жидкость или ID (рус./англ.)…');
    if (search) this.search();
  }

  /** Recipes that make (production) or use (consumption) a resource — R / U keys. */
  showGoods(id, mode) {
    this.setMode('goods', { search: false });
    return this.openGoods(id, mode).catch(e => this.app.toast(e.message, 'error'));
  }

  /** Favourite and recently opened resources (shown while the search box is empty). */
  quickListsHtml() {
    const ds = this.app.iconDataset();
    const row = g => `<div class="li goods" data-goods="${esc(g.id)}">${iconHtml(g, ds, 'small')}<span>${esc(nm(g))}${g.kind === 'fluid' ? ` <i class="fl">${$t("жидк.")}</i>` : ''}</span></div>`;
    const favs = prefs.favs(), rec = prefs.recent().filter(g => !favs.some(f => f.id === g.id));
    return (favs.length ? `<h5 class="qh">★ ${$t("Избранное")}</h5><div class="list">${favs.map(row).join('')}</div>` : '')
      + (rec.length ? `<h5 class="qh">${$t("Недавние")}</h5><div class="list">${rec.map(row).join('')}</div>` : '');
  }

  setPending(info) {
    this.pending = info;
    if (!info) { this.pendingEl.hidden = true; return; }
    this.pendingEl.hidden = false;
    this.pendingEl.innerHTML = `${$t("Связь ждёт рецепт:")} <b>${esc(nm(info.res))}</b> (${info.dir === 'out' ? $t('потребитель') : $t('производитель')}) <button>${$t("отмена")}</button>`;
    this.pendingEl.querySelector('button').onclick = () => this.setPending(null);
  }

  async search() {
    const q = this.input.value.trim();
    if (this.mode === 'custom') return this.showCustom(q);
    if (!this.app.status?.catalog) { this.body.innerHTML = `<div class="note warn">${esc(this.app.status?.catalogError || $t('Каталог не загружен'))}</div>`; return; }
    if (this.mode === 'machine') {
      const r = await api.search(q, 'machine');
      this.body.innerHTML = `<div class="list">${r.machines.map(m => `<div class="li" data-machine="${esc(m.name)}"><span>${esc(mname(m))}</span><small>${esc(mname(m) !== m.name ? m.name + ' · ' : '')}${esc(m.category)} · ${m.recipes}</small></div>`).join('')}</div>`;
      return;
    }
    if (!q) { this.body.innerHTML = this.quickListsHtml() + `<div class="note">${$t("Введите название предмета или жидкости по-русски или по-английски, например")} <i>${$t("пыль магния")}</i>, <i>${$t("кислород")}</i>, <i>oxygen</i>${$t(", или ID вида")} <code>i:minecraft:sand:0</code>${$t(". Слова можно писать в любом порядке и форме.")}</div>`; return; }
    const r = await api.search(q);
    const ds = this.app.iconDataset();
    this.body.innerHTML = r.goods.length ? `<div class="list">${r.goods.map(g => `<div class="li goods" data-goods="${esc(g.id)}">${iconHtml(g, ds, 'small')}<span>${esc(nm(g))}${g.kind === 'fluid' ? ` <i class="fl">${$t("жидк.")}</i>` : ''}</span><small title="${$t("производится / потребляется")}">▲${g.producedBy} ▼${g.consumedBy}</small></div>`).join('')}</div>`
      : `<div class="note">${$t("Ничего не найдено.")}</div>`;
  }

  async openGoods(id, mode = 'production') {
    const keep = this.state?.view === 'goods' ? this.state : null;
    this.state = { view: 'goods', id, mode, machine: null, offset: 0, q: '', side: 'any', maxTier: keep?.maxTier ?? '' };
    const g = await api.goods(id);
    this.state.goods = g;
    prefs.addRecent(g);
    await this.loadRecipes();
  }

  async openMachine(name) {
    this.state = { view: 'machine', name, q: '', side: 'any', maxTier: '', offset: 0 };
    await this.loadRecipes();
  }

  filterHtml(s, total) {
    const tiers = TIERS.map((t, i) => `<option value="${i}" ${String(s.maxTier) === String(i) ? 'selected' : ''}>${$t("до")} ${t}</option>`).join('');
    return `<div class="rfilter">
      <input class="rq" type="search" placeholder="${$t("фильтр рецептов: magnesium, out:oxygen")}" value="${esc(s.q)}" title="${$t("Несколько условий через запятую — должны выполняться все. Префиксы in: / out: (вх: / вых:) задают сторону для отдельного условия. Ищет по названию и ID.")}">
      <div class="rrow"><select class="rside"><option value="any" ${s.side === 'any' ? 'selected' : ''}>${$t("во входах и выходах")}</option><option value="in" ${s.side === 'in' ? 'selected' : ''}>${$t("только во входах")}</option><option value="out" ${s.side === 'out' ? 'selected' : ''}>${$t("только в выходах")}</option></select>
      <select class="rtier"><option value="">${$t("любой уровень")}</option>${tiers}</select></div>
      <small class="rcount">${$t("найдено:")} ${total}</small></div>`;
  }

  async loadRecipes(append = false) {
    const s = this.state, ds = this.app.iconDataset();
    const seq = this.seq = (this.seq || 0) + 1;
    let res;
    if (s.view === 'goods') res = await api.recipes(s.id, s.mode, s.machine, s.offset, s.q, s.side, s.maxTier);
    else res = await api.machine(s.name, s.q, s.offset, s.side, s.maxTier);
    if (seq !== this.seq) return; // a newer request superseded this one
    const cards = [...(append ? [] : (res.custom || [])), ...res.recipes].map(r => recipeCardHtml(r, ds)).join('');
    if (append) {
      this.body.querySelector('.more')?.remove();
      this.body.querySelector('.rlist').insertAdjacentHTML('beforeend', cards);
    } else {
      const focused = document.activeElement?.classList.contains('rq');
      const total = res.total + (res.custom?.length || 0);
      let head;
      if (s.view === 'goods') {
        const g = s.goods;
        const machines = Object.entries(res.machines || {}).sort((a, b) => b[1] - a[1]);
        head = `<div class="ghead">${iconHtml(g, ds)}<div><b>${esc(nm(g))}</b><br><small>${nm(g) !== g.name ? esc(g.name) + ' · ' : ''}${esc(g.id)}${g.kind === 'fluid' ? $t(' · жидкость') + (g.isGas ? $t(' (газ)') : '') : ''}</small></div></div>
          <div class="gactions"><button data-act="source">${$t("+ Источник")}</button><button data-act="fav" title="${$t("Избранное: показывается в начале поиска")}">${prefs.isFav(g.id) ? '★' : '☆'}</button><button data-act="back">${$t("← к поиску")}</button></div>
          <div class="ptabs small"><button data-gmode="production" class="${s.mode === 'production' ? 'on' : ''}">${$t("Производится (")}${g.producedBy})</button><button data-gmode="consumption" class="${s.mode === 'consumption' ? 'on' : ''}">${$t("Потребляется (")}${g.consumedBy})</button></div>
          ${this.filterHtml(s, total)}
          ${machines.length > 1 || s.machine ? `<select class="mfilter"><option value="">${$t("Все машины (")}${machines.reduce((a, m) => a + m[1], 0)})</option>${machines.map(([m, c]) => `<option value="${esc(m)}" ${m === s.machine ? 'selected' : ''}>${esc(m)} (${c})</option>`).join('')}</select>` : ''}`;
      } else {
        head = `<div class="ghead"><div><b>${esc(mname({ name: s.name }))}</b><br><small>${$t("карта рецептов")}</small></div></div>
          <div class="gactions"><button data-act="back">${$t("← к списку")}</button></div>${this.filterHtml(s, total)}`;
      }
      this.body.innerHTML = head + `<div class="rlist">${cards || `<div class="note">${$t("Рецептов нет.")}</div>`}</div>`;
      const rq = this.body.querySelector('.rq');
      let t;
      rq.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { s.q = rq.value; s.offset = 0; this.loadRecipes(); }, 250); });
      this.body.querySelector('.rside').onchange = e => { s.side = e.target.value; s.offset = 0; this.loadRecipes(); };
      this.body.querySelector('.rtier').onchange = e => { s.maxTier = e.target.value; s.offset = 0; this.loadRecipes(); };
      if (focused || s.view === 'machine') { rq.focus(); rq.setSelectionRange(rq.value.length, rq.value.length); }
    }
    if (s.offset + res.recipes.length < res.total) {
      this.body.querySelector('.rlist').insertAdjacentHTML('beforeend', `<button class="more">${$t("Ещё (")}${res.total - s.offset - res.recipes.length})</button>`);
    }
    this.cache = { ...(append ? this.cache : {}), ...Object.fromEntries([...(res.custom || []), ...res.recipes].map(r => [r.id, r])) };
  }

  async showCustom(q = '') {
    this.state = { view: 'custom' };
    const data = await api.custom();
    const ql = q.toLowerCase();
    const list = data.recipes.filter(r => !ql || (r.machine.name + ' ' + mname(r.machine)).toLowerCase().includes(ql) || [...r.inputs, ...r.outputs].some(e => ((e.name || '') + ' ' + nm(e)).toLowerCase().includes(ql)));
    this.body.innerHTML = `<div class="gactions"><button data-act="newcustom">${$t("+ Новый рецепт")}</button><button data-act="importcustom">${$t("Импорт файла")}</button><button data-act="exportcustom">${$t("Экспорт")}</button></div>
      <div class="note">${$t("Своя база рецептов (например, для правок 2.8.4). Каждый рецепт хранит источник: копия из каталога (набор + ID) или ручной ввод.")}</div>
      <div class="rlist">${list.map(r => recipeCardHtml(r, this.app.iconDataset())).join('') || `<div class="note">${$t("Пока пусто. Нажмите «В свои» на любом рецепте каталога или создайте новый.")}</div>`}</div>`;
    this.cache = Object.fromEntries(data.recipes.map(r => [r.id, r]));
  }

  async onClick(e) {
    const t = e.target;
    const goods = t.closest('[data-goods]');
    if (goods) return this.openGoods(goods.dataset.goods, this.pending?.dir === 'in' ? 'production' : this.pending ? 'consumption' : 'production');
    const mach = t.closest('[data-machine]');
    if (mach) return this.openMachine(mach.dataset.machine);
    if (t.dataset.gmode) { this.state.mode = t.dataset.gmode; this.state.machine = null; this.state.offset = 0; return this.loadRecipes(); }
    if (t.classList.contains('more')) { this.state.offset += 30; return this.loadRecipes(true); }
    const act = t.dataset.act;
    if (!act) return;
    const card = t.closest('.rcard');
    const rid = card?.dataset.recipe;
    try {
      if (act === 'add') return this.app.addRecipeNode(rid);
      if (act === 'copy') return this.app.editCustom(await api.recipe(rid), true);
      if (act === 'edit') return this.app.editCustom(this.cache[rid], false);
      if (act === 'del') {
        if (!confirm($t('Удалить рецепт из своей базы? Узлы на холсте сохранят свой снимок.'))) return;
        await api.deleteCustom(rid); this.app.refreshStatus(); return this.showCustom(this.input.value);
      }
      if (act === 'back') { this.state = null; return this.search(); }
      if (act === 'source') return this.app.addSource(this.state.goods);
      if (act === 'fav') { prefs.toggleFav(this.state.goods); t.textContent = prefs.isFav(this.state.goods.id) ? '★' : '☆'; return; }
      if (act === 'newcustom') return this.app.editCustom(null, false);
      if (act === 'importcustom') return this.app.importCustomFile();
      if (act === 'exportcustom') return this.app.exportCustom();
    } catch (err) { this.app.toast(err.message, 'error'); }
  }
}
