// Application bootstrap and glue.
import { $t, $tm, lbl, translateStatic, uiLang, setUiLang } from './i18n.js';
import { api } from './api.js';
import { esc, num, setUnit, getUnit, setAtlasResolver, fromUnit, setLang, getLang, learnNames } from './fmt.js';
import { machineList, machineListText } from './machines.js';
import * as M from './model.js';
import { solve, solveBlock, recipeTier } from './solver.js';
import { Canvas } from './canvas.js';
import { CatalogPanel } from './catalog.js';
import { PropsPanel } from './props.js';
import { editRecipe, openModal } from './editor.js';

const AUTOSAVE = 'gtnh-planner-autosave-v1';
const LANG = 'gtnh-planner-lang';
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};

class App {
  constructor() {
    this.history = new M.History();
    this.selection = null;
    this.highlight = null;
    this.results = null;
    this.status = null;
    this.root = null;     // the whole schematic (what is saved)
    this.path = [];       // ids of blocks opened for editing, outermost first
    this.blockFull = false; // inside a block: show it at full capacity instead of the actual supply
  }

  /** The schematic being edited: the root, or the inside of the opened block. */
  get project() {
    const q = M.resolvePath(this.root, this.path);
    if (q) return q;
    this.path = [];
    return this.root;
  }
  set project(p) { this.root = p; this.path = []; }

  /** Context of the opened block for its input cards. */
  blockCtx() { return this.path.length ? { full: this.blockFull } : null; }

  enterBlock(id) {
    const n = M.node(this.project, id);
    if (n?.type !== 'group') return;
    this.path = [...this.path, id];
    this.selection = null;
    this.changed({ history: false });
    requestAnimationFrame(() => this.canvas.fit());
  }

  exitBlock(level = this.path.length - 1) {
    const left = this.path[level];
    this.path = this.path.slice(0, Math.max(0, level));
    this.selection = left ? { type: 'node', id: left } : null;
    this.changed({ history: false });
    requestAnimationFrame(() => this.canvas.fit());
  }

  toggleSelect(id) {
    const s = this.selection;
    const ids = s?.type === 'nodes' ? [...s.ids] : s?.type === 'node' ? [s.id] : [];
    const i = ids.indexOf(id);
    if (i >= 0) ids.splice(i, 1); else ids.push(id);
    this.selectNodes(ids);
  }

  selectNodes(ids) {
    if (!ids.length) return this.select(null);
    if (ids.length === 1) return this.select({ type: 'node', id: ids[0] });
    this.select({ type: 'nodes', ids });
  }

  selectedIds() {
    const s = this.selection;
    return s?.type === 'nodes' ? s.ids : s?.type === 'node' ? [s.id] : [];
  }

  groupSelection() {
    const ids = this.selectedIds().filter(id => {
      const n = M.node(this.project, id);
      return n && n.type !== 'gin' && n.type !== 'gout';
    });
    if (!ids.length) { this.toast($t('Выделите узлы: Ctrl/Shift + щелчок или Shift + рамка'), 'error'); return; }
    const size = n => {
      const el = this.canvas.nlayer.querySelector(`.node[data-id="${n.id}"]`);
      return el ? { w: el.offsetWidth, h: el.offsetHeight } : null;
    };
    let blk;
    this.mutate(p => { blk = M.groupNodes(p, ids, size); });
    this.select({ type: 'node', id: blk.id });
    const ins = M.blockGins(blk).length, outs = M.blockGouts(blk).length;
    this.toast(`${$t("Блок создан: узлов")} ${ids.length}${$t(", входов")} ${ins}${$t(", выходов")} ${outs}${$t(". Двойной щелчок — открыть.")}`);
  }

  ungroup(id) {
    let added;
    this.mutate(p => { added = M.ungroupNode(p, id); });
    if (added) this.selectNodes(added);
    this.toast($t('Блок разгруппирован'));
  }

  async init() {
    translateStatic(document.body);
    // item names follow the interface language until the user picks otherwise
    setLang(store.get(LANG) || uiLang());
    await this.refreshStatus();
    setAtlasResolver(id => {
      const ds = this.status?.datasets.find(d => d.id === id && d.atlas);
      return ds ? `/atlas/${encodeURIComponent(ds.id)}.webp` : null;
    });
    let p = null;
    const saved = store.get(AUTOSAVE);
    if (saved) { try { p = JSON.parse(saved); } catch { p = null; } }
    this.project = p && p.format === 'gtnh-planner-project' ? p : M.newProject($t('Новая линия'), this.datasetInfo());
    setUnit(this.root.units || 'min');
    this.canvas = new Canvas(document.getElementById('canvas'), this);
    this.catalog = new CatalogPanel(document.getElementById('catalog'), this);
    this.props = new PropsPanel(document.getElementById('props'), this);
    this.bindToolbar();
    this.bindKeys();
    this.changed({ history: false });
    this.loadProjectNames();
    this.catalog.search();
    if (this.project.nodes.length) requestAnimationFrame(() => this.canvas.fit());
    if (!this.status?.catalog || !this.status?.setup?.welcomed) this.setupDialog();
  }

  /** First-run / settings window: recipe data, language, Russian names, Minecraft folder. */
  async setupDialog() {
    await this.refreshStatus();
    const s = this.status, st = s.setup || {}, inst = s.install || {};
    const ok = '<span class="badge ok">✓</span>', no = '<span class="badge warn">!</span>';
    const dataOk = !!s.catalog;
    const m = openModal(`<h3>⚙ ${$t('Настройка планировщика')}</h3>
      <div class="setup">
      <section><h4>1. ${$t('Данные рецептов')} ${dataOk ? ok : no}</h4>
        ${dataOk ? `<div class="note ok">${esc(s.active?.label || '')}: ${s.catalog.recipes} ${$t('рецептов')}, ${s.catalog.items} ${$t('предм.,')} ${s.catalog.fluids} ${$t('жидк.')}</div>`
          : `<div class="note warn">${$t('Нужны для работы. Снимок рецептов GTNH 2.8.0 (≈30 МБ) скачивается с GitHub и проверяется по SHA-256.')}${s.catalogError ? `<br><small>${esc($tm(s.catalogError))}</small>` : ''}</div>
          <div class="btnrow"><button data-dl class="primary">${$t('Скачать данные рецептов')}</button></div>
          <div class="progress" hidden><div></div><span></span></div>`}
      </section>
      <section><h4>2. ${$t('Язык')}</h4>
        <div class="grid2"><label>${$t('Интерфейс')} <select data-uilang><option value="ru" ${uiLang() === 'ru' ? 'selected' : ''}>Русский</option><option value="en" ${uiLang() === 'en' ? 'selected' : ''}>English</option></select></label>
        <label>${$t('Названия')} <select data-names><option value="ru" ${getLang() === 'ru' ? 'selected' : ''}>${$t('русские')}</option><option value="en" ${getLang() === 'en' ? 'selected' : ''}>${$t('английские')}</option></select></label></div>
        <div class="note small">${s.names?.goods ? `${$t('Русские названия')}: ${s.names.goods} ${$t('ресурсов,')} ${s.names.machines} ${$t('машин.')}` : $t('Русские названия не скачаны — названия будут на английском.')}</div>
        <div class="btnrow"><button data-fetchlang ${dataOk ? '' : 'disabled'}>${s.names?.translations ? $t('Обновить перевод') : $t('Скачать перевод')} ${$t('(GitHub, ≈9 МБ)')}</button></div>
      </section>
      <section><h4>3. ${$t('Папка Minecraft (необязательно)')} ${inst.found ? ok : ''}</h4>
        <div class="note small">${$t('Планировщик только читает её, ничего не меняя: версию сборки, таблицу кабелей GregTech и переводы модов. Без неё всё работает.')}</div>
        ${inst.found ? `<div class="note ok">${esc(inst.path)} — ${$t('сборка')} ${esc(inst.packVersion || '?')}, GregTech ${esc(inst.jars?.gregtech?.version || '?')}</div>` : ''}
        <div class="btnrow"><button data-find>${$t('Найти автоматически')}</button>${inst.found ? `<button data-forget>${$t('Забыть')}</button>` : ''}</div>
        <div class="installs"></div>
        <label>${$t('Или укажите путь вручную (папка, где лежат mods и config)')} <span class="inl"><input data-mcpath placeholder="C:\\Users\\…\\PrismLauncher\\instances\\GTNH\\.minecraft" value="${esc(inst.found ? inst.path : '')}"><button data-usepath>${$t('Проверить')}</button></span></label>
      </section>
      </div>
      <div class="btnrow"><button data-done class="primary" ${dataOk ? '' : 'disabled'}>${$t('Готово')}</button></div>`, 'wide');
    const reopen = async () => { m.close(); await this.refreshStatus(); this.setupDialog(); };
    m.el.addEventListener('change', e => {
      if (e.target.dataset.uilang != null) { setUiLang(e.target.value); location.reload(); }
      if (e.target.dataset.names != null) { setLang(e.target.value); store.set(LANG, e.target.value); document.getElementById('lang').value = e.target.value; this.catalog.rerender(); this.changed(); }
    });
    m.el.addEventListener('click', async e => {
      const t = e.target;
      try {
        if (t.dataset.dl != null) {
          t.disabled = true;
          const bar = m.el.querySelector('.progress');
          bar.hidden = false;
          await api.setupDownload();
          for (;;) {
            await new Promise(r => setTimeout(r, 400));
            const p = await api.setupProgress();
            const pct = p.total ? Math.round(p.done * 100 / p.total) : 0;
            bar.querySelector('div').style.width = pct + '%';
            bar.querySelector('span').textContent = p.file ? `${p.file} (${p.index}/${p.count}) — ${pct}%` : '…';
            if (p.error) throw new Error(p.error);
            if (p.finished || !p.running) break;
          }
          await this.refreshStatus();
          this.catalog.search();
          this.changed();
          this.toast($t('Данные рецептов загружены и проверены'));
          return reopen();
        }
        if (t.dataset.fetchlang != null) {
          t.disabled = true; t.textContent = $t('скачивание…');
          const r = await api.fetchLang();
          this.toast(`${$t('Перевод загружен:')} ${r.goods} ${$t('ресурсов')}`);
          this.loadProjectNames(); this.catalog.rerender();
          return reopen();
        }
        if (t.dataset.find != null) {
          t.disabled = true;
          const r = await api.setupInstalls();
          m.el.querySelector('.installs').innerHTML = r.installs.length
            ? r.installs.map(x => `<div class="li"><span>${esc(x.path)}<br><small>${$t('сборка')} ${esc(x.packVersion || '?')} · GregTech ${esc(x.gregtech || '?')}</small></span><button data-pick="${esc(x.path)}">${$t('Использовать')}</button></div>`).join('')
            : `<div class="note small">${$t('Установки GTNH не найдены в обычных папках лаунчеров (Prism, MultiMC, CurseForge, ATLauncher…). Укажите путь вручную.')}</div>`;
          t.disabled = false;
        }
        if (t.dataset.pick || t.dataset.usepath != null) {
          const path = t.dataset.pick || m.el.querySelector('[data-mcpath]').value;
          await api.setupMcDir(path);
          this.energyData = null;
          this.toast($t('Папка Minecraft сохранена (только чтение)'));
          this.renderBadges();
          return reopen();
        }
        if (t.dataset.forget != null) { await api.setupMcDir(''); this.energyData = null; return reopen(); }
        if (t.dataset.done != null) { await api.setupSettings({ welcomed: true }); m.close(); await this.refreshStatus(); this.catalog.search(); this.changed(); }
      } catch (err) { this.toast(err.message, 'error'); t.disabled = false; }
    });
  }

  datasetInfo() {
    const a = this.status?.active;
    return a ? { id: a.id, label: a.label, packVersion: a.packVersion, sha256: a.sha256 } : null;
  }

  async refreshStatus() {
    this.status = await api.status();
    this.renderBadges();
  }

  /** Dataset whose atlas should be used to draw icons of `recipe` (or active one). */
  iconDataset(recipe) {
    const act = this.status?.active?.id;
    const d = recipe?.snapshot?.dataset || recipe?.dataset;
    if (d && d !== 'custom' && this.status?.datasets.some(x => x.id === d && x.atlas)) return d;
    return act;
  }

  renderBadges() {
    const s = this.status;
    const el = document.getElementById('badges');
    if (!s) return;
    const a = s.active, inst = s.install;
    const mismatch = inst?.found && a && inst.packVersion && inst.packVersion !== a.packVersion;
    el.innerHTML = `<button class="badge ${a?.verified ? 'ok' : 'warn'}" data-tb="data" title="${$t("Источник рецептов — нажмите для подробностей")}">${$t("Рецепты:")} ${esc(a?.label || $t('нет'))} ${a?.verified ? $t('✓ проверено') : $t('⚠ не проверено')}</button>
      ${inst?.found ? `<button class="badge ${mismatch ? 'warn' : 'ok'}" data-tb="data" title="${esc(inst.path)} ${$t("(только чтение)")}">${$t("Сборка:")} ${esc(inst.packVersion || '?')}${mismatch ? $t(' ⚠ не совпадает') : ''}</button>` : ''}
      ${s.catalogError ? `<button class="badge err" data-tb="setup">${esc($tm(s.catalogError))}</button>` : ''}`;
  }

  // ---------- state changes ----------
  changed({ solve: doSolve = true } = {}) {
    if (doSolve) this.solveAll();
    this.updateHighlight();
    this.canvas.render();
    this.props.render();
    this.renderTitle();
    store.set(AUTOSAVE, JSON.stringify(this.root));
    document.getElementById('undo').disabled = !this.history.undo.length;
    document.getElementById('redo').disabled = !this.history.redo.length;
    document.getElementById('energyOn').checked = M.energyOn(this.root);
    document.body.classList.toggle('inblock', this.path.length > 0);
  }

  /** Solve the whole schematic, then (if a block is open) its inside with what the outer line supplies. */
  solveAll() {
    this.rootResults = solve(this.root);
    let R = this.rootResults, parent = this.root;
    const EON = M.energyOn(this.root), mode = this.root.loopMode || 'primed';
    const ok = [];
    for (const id of this.path) {
      const n = M.node(parent, id);
      if (n?.type !== 'group') break;
      R = solveBlock(n, { ...(R.nodes[id]?.ctx || {}), full: this.blockFull }, EON, mode);
      parent = n.inner; ok.push(id);
    }
    this.path = ok;
    this.results = R;
  }

  /** Russian names for resources stored in the project (snapshots keep English names). */
  async loadProjectNames() {
    const ids = new Set();
    const add = e => { if (e?.id) ids.add(e.id); (e?.variants || []).forEach(add); };
    const walk = p => {
      for (const r of Object.values(p.recipes)) { r.inputs.forEach(add); r.outputs.forEach(add); }
      for (const n of p.nodes) { add(n.resource); add(n.gen); add(n.fuel?.res); (n.fuel?.outputs || []).forEach(o => add(o.res)); if (n.inner) walk(n.inner); }
      for (const e of p.edges) add(e.cable);
    };
    walk(this.root);
    try {
      const r = await api.names([...ids]);
      learnNames(r.goods, r.machines);
      if (getLang() === 'ru') { this.canvas.render(); this.props.render(); }
    } catch { /* names are optional */ }
  }

  async loadEnergy() {
    if (!this.energyData) this.energyData = await api.energy();
    return this.energyData;
  }

  setEnergy(on) {
    this.history.push(this.root);
    const walk = q => { q.energy = { ...(q.energy || {}), enabled: on }; for (const n of q.nodes) if (n.inner) walk(n.inner); };
    walk(this.root);
    this.changed();
    this.toast(on ? $t('Учёт энергии включён: у машин появился вход ⚡') : $t('Учёт энергии выключен: схема считается без энергии (связи питания сохранены)'));
  }

  machineListDialog() {
    const L = machineList(this.root, this.rootResults);
    const t = (rows, cols) => `<table class="io mlist"><tr>${cols.map(c => `<th>${c}</th>`).join('')}</tr>${rows}</table>`;
    const pct = v => v == null ? '—' : num(v * 100, 1) + '%';
    const mrows = L.machines.map(g => `<tr><td><b>${esc(g.name)}</b>${g.nameEn !== g.name ? `<br><small>${esc(g.nameEn)}</small>` : ''}</td><td>${esc(g.tier)}</td><td class="num"><b>${g.count}</b></td>
      <td class="num">${pct(g.util)}</td><td class="num">${num(g.euFull)} / ${num(g.euAvg)}</td>
      <td><small>${g.nodes.map(x => `<a href="#" data-sel-node="${x.id}" data-path="${x.path.join(',')}">${x.path.length ? '▦ ' : ''}${esc(x.label)} ×${x.count}</a>`).join(', ')}</small></td></tr>`).join('');
    const grows = L.generators.map(g => `<tr><td><b>${esc(g.name)}</b></td><td>${esc(g.tier)}</td><td class="num"><b>${g.count}</b></td>
      <td class="num">${num(g.output)} / ${num(g.capacity)}</td><td>${g.fuel ? esc(g.fuel) : '—'}</td>
      <td><small>${g.nodes.map(x => `<a href="#" data-sel-node="${x.id}" data-path="${x.path.join(',')}">${x.path.length ? '▦ ' : ''}${esc(x.label)}</a>`).join(', ')}</small></td></tr>`).join('');
    const crows = L.cables.map(c => `<tr><td><b>${esc(c.name)}</b></td><td>${esc(c.tier)}</td><td class="num"><b>${c.blocks}</b></td><td class="num">${c.links}</td><td class="num">${num(c.loss)}</td></tr>`).join('');
    const eon = M.energyOn(this.root);
    const m = openModal(`<h3>${$t("Список машин схемы")}</h3>
      <div class="note small">${$t("Сгруппировано по карте рецептов и уровню машины. Загрузка — средняя по числу машин. EU/t: полная мощность / фактически.")}</div>
      ${L.machines.length ? t(mrows, [$t('Машина'), $t('Уровень'), $t('Шт.'), $t('Загрузка'), 'EU/t', $t('Узлы')]) : `<div class="note">${$t("Машин нет.")}</div>`}
      <div class="mtotal">${$t("Всего машин:")} <b>${L.totals.machines}</b> (${L.machines.length} ${$t("видов) · EU/t:")} <b>${num(L.totals.euFull)}</b> ${$t("полная /")} <b>${num(L.totals.euAvg)}</b> ${$t("факт.")}</div>
      ${eon ? `<h4>${$t("Генераторы")}</h4>${L.generators.length ? t(grows, [$t('Генератор'), $t('Уровень'), $t('Шт.'), $t('EU/t (выдаёт / макс.)'), $t('Топливо'), $t('Узлы')]) : `<div class="note">${$t("Генераторов нет.")}</div>`}
      <h4>${$t("Кабели")}</h4>${L.cables.length ? t(crows, [$t('Кабель'), $t('Уровень'), $t('Блоков'), $t('Связей'), $t('Потери EU/t')]) : `<div class="note">${$t("Кабелей нет (генераторы вплотную или связи без кабеля).")}</div>`}
      <div class="mtotal">${$t("Генерация:")} <b>${num(L.totals.generated)}</b> ${$t("EU/t из")} <b>${num(L.totals.capacity)}</b> ${$t("· потери в кабелях:")} <b>${num(L.totals.losses)}</b> EU/t${L.totals.unpowered ? ` · <span class="warnc">${$t("без питания:")} ${num(L.totals.unpowered)} EU/t</span>` : ''}</div>` : `<div class="note small">${$t("Учёт энергии выключен — генераторы и кабели не показаны.")}</div>`}
      ${this.props.balanceHtml(1e9, this.rootResults).replace(/<div class="btnrow">.*?<\/div>/s, '')}
      <div class="btnrow"><button data-copy>${$t("Копировать как текст")}</button></div>`, 'wide');
    m.el.addEventListener('click', async e => {
      const sel = e.target.dataset.selNode;
      if (sel) { e.preventDefault(); m.close(); this.path = (e.target.dataset.path || '').split(',').filter(Boolean); this.changed({ history: false }); this.select({ type: 'node', id: sel }); return; }
      if (e.target.dataset.copy != null) {
        const text = machineListText(L, eon, this.rootResults?.balance);
        try { await navigator.clipboard.writeText(text); this.toast($t('Список скопирован в буфер обмена')); }
        catch { download(safeName(this.project.name) + $t('-машины.txt'), text); }
      }
    });
  }

  mutate(fn) {
    this.history.push(this.root);
    fn(this.project);
    M.pruneBlockEdges(this.root);
    this.changed();
  }

  select(sel) {
    this.selection = sel;
    this.updateHighlight();
    this.canvas.render();
    this.props.render();
  }

  updateHighlight() {
    const sel = this.selection;
    this.highlight = null;
    if (sel?.type === 'edge') {
      const s = this.results?.edges[sel.id];
      if (s?.affected?.length) this.highlight = new Set(s.affected.map(a => a.node));
    }
  }

  renderTitle() {
    const p = this.root;
    const crumbs = [];
    let q = p;
    this.path.forEach((id, i) => {
      const n = M.node(q, id);
      crumbs.push(`<span class="sep">›</span><a href="#" data-crumb="${i + 1}" class="${i === this.path.length - 1 ? 'cur' : ''}">▦ ${esc(lbl(n?.label) || $t('Блок'))}</a>`);
      q = n?.inner;
    });
    const el = document.getElementById('ptitle');
    el.innerHTML = `${p.demo ? `<span class="badge demo">${$t("ДЕМО — условные значения источников")}</span> ` : ''}${this.path.length ? `<a href="#" data-crumb="0">${esc(p.name)}</a>` : esc(p.name)}${crumbs.join('')}
      ${this.path.length ? `<button data-crumb="${this.path.length - 1}" class="exitblk" title="${$t("Вернуться на уровень выше")}">${$t("⤴ Выйти из блока")}</button>
        <label class="tbchk" title="${$t("Показать блок на полной мощности (входы без ограничения) вместо фактической подачи")}"><input type="checkbox" data-blockfull ${this.blockFull ? 'checked' : ''}> ${$t("полная мощность")}</label>` : ''}`;
    el.onclick = e => {
      const c = e.target.closest('[data-crumb]');
      if (c) { e.preventDefault(); this.exitBlock(+c.dataset.crumb); }
    };
    el.onchange = e => { if (e.target.dataset.blockfull != null) { this.blockFull = e.target.checked; this.changed({ history: false }); } };
  }

  toast(msg, kind = 'info') {
    const t = document.createElement('div');
    t.className = 'toast ' + kind;
    t.textContent = msg;
    document.getElementById('toasts').appendChild(t);
    setTimeout(() => t.remove(), kind === 'error' ? 6000 : 3500);
  }

  // ---------- graph operations ----------
  connect(from, to) {
    const c = M.checkConnect(this.project, from, to);
    if (!c.ok) { this.toast(c.reason, 'error'); return false; }
    let created;
    const turnOn = from.port === 'eo' && !M.energyOn(this.project);
    this.mutate(p => {
      created = M.connect(p, from, to).edge;
      if (turnOn) p.energy = { ...(p.energy || {}), enabled: true };
    });
    if (turnOn) this.toast($t('Учёт энергии включён'));
    this.select({ type: 'edge', id: created.id });
    return true;
  }

  placeAt(pos) {
    // first free spot near the drop point / view centre (avoid stacking nodes)
    const W = 330, H = 170, gap = 30;
    const c = pos ? { x: pos.x + W / 2, y: pos.y + H / 2 } : this.canvas.centerWorld();
    const rects = this.project.nodes.map(n => {
      const el = this.canvas.nlayer.querySelector(`.node[data-id="${n.id}"]`);
      return { x: n.x, y: n.y, w: el?.offsetWidth || W, h: el?.offsetHeight || H };
    });
    const free = (x, y) => rects.every(r => x + W + gap <= r.x || r.x + r.w + gap <= x || y + H + gap <= r.y || r.y + r.h + gap <= y);
    const x0 = c.x - W / 2, y0 = c.y - H / 2;
    for (let ring = 0; ring < 12; ring++) {
      for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0], [1, 1], [-1, 1], [1, -1], [-1, -1]]) {
        const x = x0 + dx * ring * (W / 2 + gap), y = y0 + dy * ring * (H / 2 + gap);
        if (free(x, y)) return { x: Math.round(x / 10) * 10, y: Math.round(y / 10) * 10 };
      }
    }
    return { x: Math.round(x0 / 10) * 10, y: Math.round(y0 / 10) * 10 };
  }

  /** Generator node properties for a fuel recipe: cheapest generator of that fuel map + the fuel. */
  async generatorFor(r) {
    const E = await this.loadEnergy();
    const map = r.machine?.name;
    const gen = E.generators.filter(g => g.fuelMaps.includes(map)).sort((a, b) => a.voltage - b.voltage)[0];
    const o = (await api.fuels(map)).fuels.find(x => x.recipeId === r.id);
    const props = { type: 'generator', fuelMode: 'map', fuelMapSel: map, fuel: o ? M.fuelFromOption(o) : null };
    if (gen) Object.assign(props, { gen: { kind: 'item', id: gen.id, name: gen.name, nameRu: gen.nameRu, icon: gen.icon }, voltage: gen.voltage, efficiency: gen.efficiency });
    return props;
  }

  async convertToGenerator(id) {
    const old = M.node(this.project, id);
    const r = M.recipeOf(this.project, old);
    try {
      const props = await this.generatorFor(r);
      const fuelIdx = r.inputs.findIndex(e => e.consumed !== false);
      let dropped = 0;
      this.mutate(p => {
        const n = M.node(p, id);
        for (const k of ['recipeId', 'tier', 'oc', 'perfectOc', 'cycleOverride', 'oreChoice']) delete n[k];
        Object.assign(n, { label: 'Генератор', amps: 1, count: n.count ?? 1, efficiency: null, gen: null }, props);
        const outs = new Set((n.fuel?.outputs || []).map((_, i) => 'o' + i));
        p.edges = p.edges.filter(e => {
          if (e.to.node === id) {
            if (e.to.port !== 'i' + fuelIdx || !n.fuel) return false;
            const from = M.node(p, e.from.node);
            if (M.portResource(p, from, e.from.port)?.id !== n.fuel.res.id) { dropped++; return false; } // e.g. cells vs. the fluid
            e.to.port = 'f';
          }
          if (e.from.node === id && !outs.has(e.from.port)) return false;
          return true;
        });
        if (!Object.values(p.nodes).some(x => x.recipeId === r.id)) delete p.recipes[r.id];
        if (!M.energyOn(p)) p.energy = { ...(p.energy || {}), enabled: true };
      });
      this.select({ type: 'node', id });
      this.toast($t('Узел превращён в генератор; учёт энергии включён') + (dropped ? `${$t(". Связей удалено:")} ${dropped} ${$t("— генератор потребляет жидкость, а не капсулы; подключите источник жидкости")}` : ''));
    } catch (e) { this.toast(e.message, 'error'); }
  }

  async addRecipeNode(rid, pos) {
    try {
      const r = this.catalog.cache?.[rid] && this.catalog.cache[rid].machine?.singleblocks ? this.catalog.cache[rid] : await api.recipe(rid);
      const pending = this.catalog.pending;
      if (M.isFuelRecipe(r)) {
        const props = await this.generatorFor(r);
        const at = this.placeAt(pos || pending?.pos);
        let n;
        this.mutate(p => {
          if (!M.energyOn(p)) p.energy = { ...(p.energy || {}), enabled: true };
          n = M.addNode(p, { ...props, ...at });
        });
        if (pending) this.completePending(n);
        this.select({ type: 'node', id: n.id });
        this.toast($t('Рецепт топлива добавлен как генератор (учёт энергии включён)'));
        return;
      }
      const at = this.placeAt(pos || pending?.pos);
      let n;
      this.mutate(p => {
        M.snapshotRecipe(p, r, this.datasetInfo());
        n = M.addNode(p, { type: 'machine', recipeId: r.id, tier: this.tierFor(r), ...at });
      });
      if (pending) this.completePending(n);
      this.select({ type: 'node', id: n.id });
    } catch (e) { this.toast(e.message, 'error'); }
  }

  tierFor(r) {
    const rt = recipeTier(r);
    return this.project.defaultTier != null ? Math.max(rt, this.project.defaultTier) : rt;
  }

  applyDefaultTier() {
    const t = this.project.defaultTier;
    if (t == null) return;
    this.mutate(p => {
      for (const n of p.nodes) if (n.type === 'machine') { n.tier = Math.max(recipeTier(p.recipes[n.recipeId]), t); delete n.oc; }
    });
    this.toast($t('Уровень машин обновлён (не ниже уровня рецепта)'));
  }

  completePending(n) {
    const pd = this.catalog.pending;
    this.catalog.setPending(null);
    const p = this.project;
    const ps = M.ports(p, n);
    if (pd.dir === 'out') {
      for (const pt of ps.filter(x => x.dir === 'in')) {
        if (M.checkConnect(p, pd, { node: n.id, port: pt.id }).ok) return this.connect(pd, { node: n.id, port: pt.id });
      }
    } else {
      for (const pt of ps.filter(x => x.dir === 'out')) {
        if (M.checkConnect(p, { node: n.id, port: pt.id }, pd).ok) return this.connect({ node: n.id, port: pt.id }, pd);
      }
    }
    this.toast($t('Не удалось автоматически подключить: нет порта с тем же ID'), 'error');
  }

  portDroppedOnEmpty(src, pos) {
    const p = this.project;
    const n = M.node(p, src.node);
    const res = M.portResource(p, n, src.port);
    if (!res || !res.id) return;
    this.catalog.setPending({ ...src, res, pos });
    this.catalog.setMode('goods');
    this.catalog.openGoods(res.oredict && src.dir === 'in' ? res.id : res.id, src.dir === 'out' ? 'consumption' : 'production');
    const pe = this.catalog.pendingEl;
    pe.insertAdjacentHTML('beforeend', src.dir === 'out'
      ? ` <button data-pq="sink">${$t("+ Склад")}</button> <button data-pq="splitter">${$t("+ Разветвитель")}</button>`
      : ` <button data-pq="source">${$t("+ Источник")}</button>`);
    pe.querySelectorAll('[data-pq]').forEach(b => b.onclick = () => this.pendingQuick(b.dataset.pq));
  }

  pendingQuick(kind) {
    const pd = this.catalog.pending;
    this.catalog.setPending(null);
    const at = this.placeAt(pd.pos);
    let n;
    this.mutate(p => {
      if (kind === 'source') n = M.addNode(p, { type: 'source', resource: strip(pd.res), rate: fromUnit(10), ...at });
      else n = M.addNode(p, { type: kind, ...at });
    });
    if (kind === 'source') this.connect({ node: n.id, port: 'out' }, pd);
    else this.connect(pd, { node: n.id, port: 'in' });
  }

  addSource(goods, pos) {
    let n;
    this.mutate(p => { n = M.addNode(p, { type: 'source', label: 'Источник', resource: strip(goods), rate: fromUnit(goods.kind === 'fluid' ? 1000 : 10), ...this.placeAt(pos) }); });
    this.select({ type: 'node', id: n.id });
  }

  addSimple(type) {
    let n;
    const wasOn = M.energyOn(this.project);
    this.mutate(p => {
      if (type === 'generator' && !wasOn) p.energy = { ...(p.energy || {}), enabled: true };
      n = M.addNode(p, { type, ...this.placeAt() });
    });
    if (type === 'generator' && !wasOn) this.toast($t('Учёт энергии включён'));
    this.select({ type: 'node', id: n.id });
  }

  deleteSelection() {
    const sel = this.selection;
    if (!sel) return;
    this.mutate(p => {
      if (sel.type === 'node') M.removeNode(p, sel.id);
      else if (sel.type === 'nodes') sel.ids.forEach(id => M.removeNode(p, id));
      else M.removeEdge(p, sel.id);
    });
    this.selection = null;
    this.changed({ solve: false });
  }

  duplicateSelection() {
    const sel = this.selection;
    if (sel?.type !== 'node') return;
    let n;
    this.mutate(p => {
      const o = M.node(p, sel.id);
      n = M.addNode(p, { ...JSON.parse(JSON.stringify(o)), id: undefined, x: o.x + 40, y: o.y + 40 });
      n.id = M.nid(p, 'n');
    });
    this.select({ type: 'node', id: n.id });
  }

  sinkContents(id) {
    const map = new Map();
    for (const e of this.project.edges) {
      if (e.to.node !== id) continue;
      const s = this.results?.edges[e.id];
      if (!s?.resource) continue;
      const k = s.resource.id;
      if (!map.has(k)) map.set(k, { res: s.resource, rate: 0 });
      map.get(k).rate += s.flow;
    }
    return [...map.values()];
  }

  async compareSnapshot(snap) {
    if (snap.dataset === 'custom') {
      try {
        const cur = await api.recipe(snap.id);
        return diffHtml(snap, cur, $t('своей базой'));
      } catch { return `<div class="note warn">${$t("Рецепт удалён из своей базы; узел использует сохранённый снимок.")}</div>`; }
    }
    if (snap.dataset !== this.status?.active?.id) return `<div class="note">${$t("Снимок из набора")} ${esc(snap.dataset)}${$t("; активен")} ${esc(this.status?.active?.id)}${$t(". Сравнение возможно только с тем же набором.")}</div>`;
    try { return diffHtml(snap, await api.recipe(snap.id), $t('каталогом')); }
    catch { return `<div class="note warn">${$t("Рецепт с этим ID в активном каталоге не найден; используется снимок.")}</div>`; }
  }

  editCustom(recipe, asCopy) { editRecipe(this, recipe, asCopy); }

  async importCustomFile() {
    const f = await pickFile('.json');
    if (!f) return;
    try {
      const r = await api.importCustom(JSON.parse(await f.text()));
      this.toast(`${$t("Импортировано рецептов:")} ${r.added}${r.errors.length ? $t('; ошибки: ') + r.errors.join('; ') : ''}`, r.errors.length ? 'error' : 'info');
      this.refreshStatus(); this.catalog.setMode('custom');
    } catch (e) { this.toast(e.message, 'error'); }
  }

  async exportCustom() { download('gtnh-custom-recipes.json', JSON.stringify(await api.custom(), null, 1)); }

  // ---------- projects ----------
  setProject(p) {
    this.project = p;
    this.blockFull = false;
    this.history.clear();
    this.selection = null;
    setUnit(p.units || 'min');
    document.getElementById('unit').value = getUnit();
    this.changed();
    this.loadProjectNames();
    requestAnimationFrame(() => this.canvas.fit());
  }

  async saveProject() {
    try {
      const r = await api.saveProject(this.root);
      this.toast($t('Сохранено в projects/') + r.file + '.json');
    } catch (e) { this.toast(e.message, 'error'); }
  }

  async openProjectDialog() {
    const list = (await api.projects()).projects;
    const m = openModal(`<h3>${$t("Проекты")}</h3><div class="note small">${$t("Файлы в папке")} <code>projects/</code> ${$t("планировщика.")}</div>
      <div class="list">${list.map(x => `<div class="li" data-open="${esc(x.file)}"><span>${esc(x.name)}${x.demo ? ` <span class="badge demo">${$t("демо")}</span>` : ''}</span><small>${x.nodes} ${$t("узл. ·")} ${esc(x.modified)}</small><button data-del="${esc(x.file)}">✕</button></div>`).join('') || `<div class="note">${$t("Сохранённых проектов нет.")}</div>`}</div>`);
    m.el.addEventListener('click', async e => {
      const del = e.target.dataset.del;
      if (del) { e.stopPropagation(); if (confirm($t('Удалить файл проекта ') + del + '.json?')) { await api.deleteProject(del); m.close(); this.openProjectDialog(); } return; }
      const o = e.target.closest('[data-open]');
      if (o) { this.setProject(await api.project(o.dataset.open)); m.close(); }
    });
  }

  async loadDemo() {
    try {
      const ids = ['r~kCJP1G_wMVa8MIQRh0s13g==', 'r~WoQfAeZjNbyiwcaH6SpRiA=='];
      const [elec, ebf] = await Promise.all(ids.map(id => api.recipe(id)));
      const ds = this.datasetInfo();
      const p = M.newProject($t('Демо: песок → электролиз → кремний'), ds);
      p.demo = true;
      p.demoNote = $t('Рецепты взяты из каталога (ID в свойствах узлов), но скорости источников (40 песка/мин, 10 угольной пыли/мин), число машин и доли 70/30 придуманы для примера.');
      M.snapshotRecipe(p, elec, ds); M.snapshotRecipe(p, ebf, ds);
      const sand = elec.inputs[0];
      const carbon = ebf.inputs.find(x => x.name === 'Carbon Dust') || ebf.inputs[1];
      const src = M.addNode(p, { type: 'source', label: $t('Сундук (песок)'), resource: strip(sand), rate: 40 / 60, x: 0, y: 40 });
      const el = M.addNode(p, { type: 'machine', recipeId: elec.id, count: 3, x: 320, y: 0 });
      const c = M.addNode(p, { type: 'source', label: $t('Сундук (уголь)'), resource: strip(carbon), rate: 10 / 60, x: 320, y: 260 });
      const bf = M.addNode(p, { type: 'machine', recipeId: ebf.id, count: 1, x: 780, y: 60 });
      const sk = M.addNode(p, { type: 'sink', label: $t('Склад SiO₂'), x: 780, y: -140 });
      const sk2 = M.addNode(p, { type: 'sink', label: $t('Склад кремния'), x: 1240, y: 40 });
      const iSand = 'i' + elec.inputs.indexOf(sand);
      const iSi = 'i' + ebf.inputs.findIndex(x => x.id === elec.outputs[0].id);
      const iC = 'i' + ebf.inputs.indexOf(carbon);
      M.connect(p, { node: src.id, port: 'out' }, { node: el.id, port: iSand });
      const e70 = M.connect(p, { node: el.id, port: 'o0' }, { node: bf.id, port: iSi }).edge; e70.share = 70;
      M.connect(p, { node: el.id, port: 'o0' }, { node: sk.id, port: 'in' });
      M.connect(p, { node: c.id, port: 'out' }, { node: bf.id, port: iC });
      M.connect(p, { node: bf.id, port: 'o0' }, { node: sk2.id, port: 'in' });
      this.setProject(p);
      this.toast($t('Загружена демо-схема. Значения источников условные.'));
    } catch (e) { this.toast($t('Демо недоступно: ') + e.message, 'error'); }
  }

  async dataDialog() {
    await this.refreshStatus();
    const s = this.status;
    const inst = s.install;
    const m = openModal(`<h3>${$t("Данные рецептов")}</h3>
      <table class="io ds">${s.datasets.map(d => `<tr class="${d.id === s.active?.id ? 'cur' : ''}"><td><b>${esc(d.label)}</b><br><small>${esc(d.id)}</small></td>
        <td>${d.available ? (d.verified ? `<span class="badge ok">${$t("проверено")}</span>` : `<span class="badge warn">${$t("не проверено")}</span>`) : `<span class="badge err">${$t("нет данных")}</span>`}<br><small>${d.format ? $t('формат ') + d.format : ''}</small></td>
        <td class="prov">${d.available ? `<small>${d.counts ? `${d.counts.items} ${$t("предм.,")} ${d.counts.fluids} ${$t("жидк.,")} ${d.counts.recipes} ${$t("рец.")}<br>` : ''}SHA-256: <code>${esc(d.sha256)}</code>${d.gitBlob ? `<br>git blob: <code>${esc(d.gitBlob)}</code>` : ''}${d.source ? `<br>${$t("источник:")} <a href="${esc(d.source)}" target="_blank" rel="noopener">${esc(d.sourceBranch || d.source)}</a> @ <code>${esc((d.sourceRevision || '').slice(0, 12))}</code>` : ''}<br>${esc(d.verification || '')}${d.atlas ? '' : `<br>${$t("иконок нет (атлас не загружен)")}`}</small>` : `<small>${esc(d.reason || '')}</small>`}</td>
        <td>${d.available && d.id !== s.active?.id ? `<button data-activate="${esc(d.id)}">${$t("Сделать активным")}</button>` : d.id === s.active?.id ? $t('активен') : ''}${d.origin === 'user-import' && !d.atlas ? `<br><button data-atlas="${esc(d.id)}">${$t("+ атлас")}</button>` : ''}</td></tr>`).join('')}</table>
      <h4>${$t("Установка Minecraft (только чтение)")}</h4>
      <div class="note small">${inst.found ? `${esc(inst.path)}<br>${$t("Версия сборки:")} <b>${esc(inst.packVersion || $t('не определена'))}</b> — ${esc(inst.packVersionSource || '')}<br>GregTech: ${esc(inst.jars.gregtech?.version || '?')}, CoreMod: ${esc(inst.jars.coremod?.version || '?')}, NEI: ${esc(inst.jars.nei?.version || '?')}${$t(", модов:")} ${inst.modCount}<br>${$t("Экспорт NESQL в установке:")} ${inst.nesqlExport ? $t('найден (папка nesql/)') : $t('нет')}` : esc(inst.reason)}</div>
      <h4>${$t("Русские названия")}</h4>
      <div class="note small">${s.names?.goods ? `${$t("Найдено:")} <b>${s.names.goods}</b> ${$t("ресурсов,")} <b>${s.names.machines}</b> ${$t("машин.")}<br>` : `${$t("Русских названий нет.")}<br>`}${(s.names?.sources || []).map(x => esc(x.name) + (x.files ? ` ${$t("— файлов:")} ${x.files}` : '')).join('<br>')}
        ${s.names?.translations ? `<br>${$t("Перевод:")} <a href="${esc(s.names.translations.source)}" target="_blank" rel="noopener">${esc(s.names.translations.repo)}</a> @ <code>${esc(s.names.translations.commit.slice(0, 12))}</code>, ${esc(s.names.translations.license)}${$t(", скачан")} ${esc(s.names.translations.fetchedAt)}, ${s.names.translations.verified ? $t('SHA-256 файлов совпадают') : `<b>${$t("файлы изменены — перевод не используется")}</b>`}` : ''}
        <br>${$t("Названия материалов GregTech собираются так же, как в игре: шаблон «[Пыль] %s» + перевод материала. Ванильные предметы Minecraft переводятся только клиентом игры, поэтому остаются на английском. Поиск работает на обоих языках.")}</div>
      <div class="btnrow"><button data-fetchlang>${s.names?.translations ? $t('Обновить перевод') : $t('Скачать перевод')} ${$t("(GitHub, ≈9 МБ)")}</button></div>
      <h4>${$t("Импорт своего экспорта (например, 2.8.4)")}</h4>
      <div class="note small">${$t("Поддерживается")} <code>data.bin</code> ${$t("форматов 5 и 7 из конвейера")} <a href="https://github.com/ShadowTheAge/gtnh/blob/main/export/README.md" target="_blank" rel="noopener">ShadowTheAge/gtnh export</a> ${$t("(NESQL → dotnet). Импортированный набор помечается «не проверено». Иконки — отдельным файлом atlas.webp.")}</div>
      <div class="grid2"><label>${$t("Название")} <input id="imp-label" value="${$t("GTNH 2.8.4 (мой экспорт)")}"></label><label>${$t("Версия сборки")} <input id="imp-ver" value="${esc(inst.packVersion || '2.8.4')}"></label></div>
      <div class="btnrow"><button data-import>${$t("Выбрать data.bin…")}</button></div>
      <h4>${$t("Источники и лицензии")}</h4>
      <div class="note small">${$t("Рецепты, названия и иконки — экспорт")} <a href="https://github.com/ShadowTheAge/gtnh-data" target="_blank" rel="noopener">ShadowTheAge/gtnh-data</a> ${$t("(без лицензии; содержимое принадлежит Mojang, команде GTNH и авторам модов; используется локально в некоммерческих целях). Формат разбора перенесён из")} <a href="https://github.com/ShadowTheAge/gtnh" target="_blank" rel="noopener">ShadowTheAge/gtnh</a> ${$t("(MIT, © 2025 ShadowTheAge). Подробно —")} <a href="/docs/${uiLang() === 'ru' ? 'DATA.ru.md' : 'DATA.md'}" target="_blank">docs/DATA</a>.</div>`, 'wide');
    m.el.addEventListener('click', async e => {
      const t = e.target;
      try {
        if (t.dataset.activate) {
          t.disabled = true; t.textContent = $t('загрузка…');
          this.status = await api.activate(t.dataset.activate);
          m.close(); this.renderBadges(); this.catalog.search(); this.changed();
          this.toast($t('Активный набор: ') + this.status.active.label);
        }
        if (t.dataset.import != null) {
          const f = await pickFile('.bin');
          if (!f) return;
          t.disabled = true; t.textContent = $t('проверка…');
          const d = await api.importDataset(await f.arrayBuffer(), m.el.querySelector('#imp-label').value, m.el.querySelector('#imp-ver').value);
          this.toast(`${$t("Импортирован")} ${d.label}${$t(": формат")} ${d.format}, ${d.counts.recipes} ${$t("рецептов")}`);
          m.close(); this.dataDialog();
        }
        if (t.dataset.fetchlang != null) {
          t.disabled = true; t.textContent = $t('скачивание…');
          const st = await api.fetchLang();
          this.toast(`${$t("Перевод загружен:")} ${st.goods} ${$t("ресурсов")}`);
          m.close(); await this.refreshStatus(); this.loadProjectNames(); this.catalog.rerender();
        }
        if (t.dataset.atlas) {
          const f = await pickFile('.webp');
          if (!f) return;
          await api.importAtlas(t.dataset.atlas, await f.arrayBuffer());
          m.close(); await this.refreshStatus(); this.dataDialog();
        }
      } catch (err) { this.toast(err.message, 'error'); t.disabled = false; }
    });
  }

  // ---------- toolbar & keys ----------
  bindToolbar() {
    const tb = document.getElementById('toolbar');
    const unit = document.getElementById('unit');
    unit.value = getUnit();
    unit.onchange = () => { setUnit(unit.value); this.root.units = unit.value; this.changed({ solve: false }); };
    const ul = document.getElementById('uilang');
    ul.value = uiLang();
    ul.onchange = () => { setUiLang(ul.value); if (!store.get(LANG)) store.set(LANG, ul.value); location.reload(); };
    const lang = document.getElementById('lang');
    lang.value = getLang();
    lang.onchange = () => { setLang(lang.value); store.set(LANG, lang.value); this.catalog.rerender(); this.changed(); };
    const en = document.getElementById('energyOn');
    en.onchange = () => this.setEnergy(en.checked);
    document.body.addEventListener('click', async e => {
      const a = e.target.closest('[data-tb]')?.dataset.tb;
      if (!a) return;
      if (a === 'new') { if (confirm($t('Начать новую схему? Несохранённые изменения останутся только в отмене.'))) { this.history.push(this.root); this.project = M.newProject($t('Новая линия'), this.datasetInfo()); this.selection = null; this.changed(); } }
      if (a === 'open') this.openProjectDialog();
      if (a === 'save') this.saveProject();
      if (a === 'export') download(safeName(this.root.name) + '.gtnh-plan.json', JSON.stringify(this.root, null, 1));
      if (a === 'import') {
        const f = await pickFile('.json');
        if (!f) return;
        try {
          const p = JSON.parse(await f.text());
          if (p.format !== 'gtnh-planner-project') throw new Error($t('Это не файл проекта планировщика'));
          this.setProject(p);
        } catch (err) { this.toast(err.message, 'error'); }
      }
      if (a === 'demo') this.loadDemo();
      if (a === 'data') this.dataDialog();
      if (a === 'setup') this.setupDialog();
      if (a === 'undo') this.undo();
      if (a === 'redo') this.redo();
      if (a === 'fit') this.canvas.fit();
      if (['splitter', 'merger', 'sink', 'generator', 'gin', 'gout'].includes(a)) this.addSimple(a);
      if (a === 'group') this.groupSelection();
      if (a === 'machines') this.machineListDialog();
    });
    void tb;
  }

  undo() { const p = this.history.back(this.root); if (p) { const path = this.path; this.root = p; this.path = path; this.selection = null; this.changed({ history: false }); } }
  redo() { const p = this.history.forward(this.root); if (p) { const path = this.path; this.root = p; this.path = path; this.selection = null; this.changed({ history: false }); } }

  bindKeys() {
    window.addEventListener('keydown', e => {
      if (e.target.closest('input,textarea,select')) return;
      if (document.querySelector('.modal-wrap')) { if (e.key === 'Escape') document.querySelector('.modal-wrap').remove(); return; }
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && k === 'z' && !e.shiftKey) { e.preventDefault(); this.undo(); }
      else if ((e.ctrlKey || e.metaKey) && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); this.redo(); }
      else if ((e.ctrlKey || e.metaKey) && k === 's') { e.preventDefault(); this.saveProject(); }
      else if ((e.ctrlKey || e.metaKey) && k === 'd') { e.preventDefault(); this.duplicateSelection(); }
      else if ((e.ctrlKey || e.metaKey) && k === 'g' && e.shiftKey) { e.preventDefault(); const s = this.selection; if (s?.type === 'node' && M.node(this.project, s.id)?.type === 'group') this.ungroup(s.id); }
      else if ((e.ctrlKey || e.metaKey) && k === 'g') { e.preventDefault(); this.groupSelection(); }
      else if ((e.ctrlKey || e.metaKey) && k === 'a') { e.preventDefault(); this.selectNodes(this.project.nodes.map(n => n.id)); }
      else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); this.deleteSelection(); }
      else if (k === 'f' && !e.ctrlKey) this.canvas.fit();
      else if (e.key === 'Escape') { this.catalog.setPending(null); if (!this.selection && this.path.length) this.exitBlock(); else this.select(null); }
    });
  }
}

const strip = r => ({ kind: r.kind, id: r.id, name: r.name, nameRu: r.nameRu, icon: r.icon });
const safeName = s => (s || 'plan').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60);

function diffHtml(snap, cur, what) {
  const io = l => l.map(e => `${e.id}×${e.amount}${e.probability < 1 ? '@' + e.probability : ''}${e.consumed === false ? $t('(нр)') : ''}`).join(', ');
  const fields = [
    [$t('Машина'), snap.machine?.name, cur.machine?.name],
    [$t('Входы'), io(snap.inputs), io(cur.inputs)],
    [$t('Выходы'), io(snap.outputs), io(cur.outputs)],
    [$t('Тиков'), snap.gt?.durationTicks, cur.gt?.durationTicks],
    ['EU/t', snap.gt?.eut, cur.gt?.eut],
  ].filter(([, a, b]) => String(a) !== String(b));
  if (!fields.length) return `<div class="note ok">${$t("Снимок совпадает с")} ${what}.</div>`;
  return `<div class="note warn">${$t("Отличается от рецепта в")} ${what === $t('каталогом') ? $t('каталоге') : $t('своей базе')}${$t(". Схема продолжает использовать снимок.")}
    <table class="io">${fields.map(([k, a, b]) => `<tr><th>${k}</th><td>${$t("снимок:")} ${esc(a)}</td><td>${$t("сейчас:")} ${esc(b)}</td></tr>`).join('')}</table></div>`;
}

function pickFile(accept) {
  return new Promise(res => {
    const i = document.createElement('input');
    i.type = 'file'; i.accept = accept;
    i.onchange = () => res(i.files[0] || null);
    i.click();
  });
}
function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const app = new App();
window.gtnhApp = app; // for debugging in devtools
app.init().catch(e => {
  document.body.insertAdjacentHTML('beforeend', `<div class="fatal">${$t("Ошибка запуска:")} ${esc(e.message)}</div>`);
  console.error(e);
});
void num;
