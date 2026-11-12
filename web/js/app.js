// Application bootstrap and glue.
import { $t, $tm, lbl, translateStatic, uiLang, setUiLang } from './i18n.js';
import { api, CLIENT_VERSION } from './api.js';
import { esc, num, rate, iconHtml, nm, TIERS, setUnit, getUnit, setAtlasResolver, fromUnit, setLang, getLang, learnNames } from './fmt.js';
import { machineList, machineListText, billOfMaterials, bomText } from './machines.js';
import { planForTarget } from './target.js';
import { COILS } from './overclock.js';
import { nodeLabel } from './fixes.js';
import * as M from './model.js';
import { solve, solveBlock, recipeTier } from './solver.js';
import { Canvas } from './canvas.js';
import { CatalogPanel } from './catalog.js';
import { PropsPanel } from './props.js';
import { editRecipe, openModal } from './editor.js';
import { bindUi, setTab, tabsHtml } from './ui.js';
import { prefs } from './prefs.js';
import { setSlotTable } from './slots.js';
import { arrange } from './layout.js';
import { exportPng } from './snapshot.js';

const AUTOSAVE = 'gtnh-planner-autosave-v1';
const SAVED = 'gregflow-saved-hash';
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
    this.resHighlight = null; // resource id picked in the line balance: its nodes are outlined
    this.savedHash = null;    // hash of the schematic as last saved / opened (unsaved-changes marker)
    this.hover = null;        // element under the mouse (R / U keys)
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
    this.savedHash = store.get(SAVED);
    this.showArmSlots = prefs.armSlots();
    this.canvas = new Canvas(document.getElementById('canvas'), this);
    this.catalog = new CatalogPanel(document.getElementById('catalog'), this);
    this.props = new PropsPanel(document.getElementById('props'), this);
    bindUi();
    this.bindToolbar();
    this.bindKeys();
    this.changed({ history: false });
    this.loadProjectNames();
    api.machineSlots().then(t => { setSlotTable(t); this.canvas.render(); this.props.render(); }).catch(() => setSlotTable(null));
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
    this.renderStale();
  }

  /** The page comes from the files on disk, the API from the code the server started with: warn when they differ. */
  renderStale() {
    const s = this.status;
    const old = s && (s.stale || s.app !== CLIENT_VERSION);
    let el = document.getElementById('stale');
    if (!old) { el?.remove(); return; }
    if (!el) { el = document.createElement('div'); el.id = 'stale'; document.body.appendChild(el); }
    el.innerHTML = `<b>${$t('Перезапустите планировщик.')}</b> ${$t('Файлы программы обновлены, а сервер ещё работает со старой версией')} (${esc(s.app || '?')} ≠ ${esc(CLIENT_VERSION)}${s.stale ? ', ' + $t('код изменён') : ''}). ${$t('Закройте окно сервера и запустите start.bat (или start.sh) снова, затем обновите страницу. Пока часть функций может не работать.')}`;
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
    this.renderProblemsBadge();
  }

  /** Toolbar badge with the number of problems of the level being viewed. */
  renderProblemsBadge() {
    const el = document.getElementById('probs');
    if (!el) return;
    const n = this.results?.problems?.length || 0;
    el.hidden = !n;
    el.textContent = `⚠ ${n}`;
    el.title = n ? $t('Проблем:') + ' ' + n + ' — ' + $t('нажмите, чтобы открыть список с исправлениями') : '';
  }

  showProblems() {
    setTab('summary', 'problems'); setTab('block', 'problems');
    this.select(null);
    requestAnimationFrame(() => document.getElementById('props').scrollTop = 0);
  }

  /** Short hash of the saved form of the schematic (to tell whether it changed since saving). */
  hashOf(p = this.root) {
    const t = JSON.stringify({ ...p, versions: undefined });
    let h = 2166136261;
    for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(36) + ':' + t.length;
  }
  markSaved() { this.savedHash = this.hashOf(); store.set(SAVED, this.savedHash); this.renderTitle(); }
  isDirty() { return this.root.nodes.length > 0 && this.hashOf() !== this.savedHash; }

  /** Nodes that take or give resource `id` (outlined when a line-balance row is picked). */
  nodesWithRes(id) {
    const p = this.project, set = new Set();
    for (const n of p.nodes) {
      if (M.ports(p, n).some(pt => pt.res?.id === id) || n.fuel?.res?.id === id) set.add(n.id);
      if (n.type === 'sink' && this.sinkContents(n.id).some(x => x.res?.id === id)) set.add(n.id);
    }
    return set;
  }
  toggleResHighlight(id) {
    this.resHighlight = this.resHighlight === id ? null : id;
    this.canvas.render(); this.props.render();
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
      for (const c of COILS) add(c.item); // coil names for the multiblock fields
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
    const bomHtml = () => {
      const B = billOfMaterials(this.root, this.rootResults, this.root.built || {});
      const head = { machines: $t('Машины'), parts: $t('Детали мультиблоков'), energy: $t('Энергия') };
      let g = null;
      const rows = B.rows.map(x => {
        const sep = x.group !== g ? `<tr class="grp"><td colspan="5">${head[x.group]}</td></tr>` : '';
        g = x.group;
        return `${sep}<tr class="${x.left === 0 ? 'done' : ''}"><td>${x.item ? iconHtml(x.item, this.iconDataset(), 'small') : ''}</td>
          <td class="bname"><b>${esc(x.name)}</b>${x.tier ? ` <small>${esc(x.tier)}</small>` : ''}${x.approx ? `<br><small class="warnc">${$t('точный блок для этого уровня неизвестен')}</small>` : ''}</td>
          <td class="num"><b>${x.need}</b>${x.unit ? ` <small>${esc(x.unit)}</small>` : ''}</td>
          <td class="num"><input type="number" min="0" step="1" data-built="${esc(x.key)}" value="${x.built || ''}" placeholder="0"></td>
          <td class="num">${x.left === 0 ? '✓' : x.left}</td></tr>`;
      }).join('');
      return `<div class="note small">${$t('Что нужно поставить для этой схемы (с блоками). Мультиблок — контроллер, его энергоразъёмы и катушки; корпус, шины и прочие части по подсказке структуры в игре здесь не считаются. Отмечайте, сколько уже построено — это сохраняется в схеме.')}</div>
        ${B.rows.length ? `<table class="io bom"><tr><th></th><th>${$t('Что')}</th><th>${$t('Нужно')}</th><th>${$t('Построено')}</th><th>${$t('Осталось')}</th></tr>${rows}</table>
        <div class="mtotal">${$t('Готово позиций:')} <b>${B.done}</b> ${$t('из')} <b>${B.total}</b></div>` : `<div class="note">${$t('Строить нечего — в схеме нет машин.')}</div>`}`;
    };
    const m = openModal(`<h3>${$t("Отчёт по схеме")}</h3>${tabsHtml('report', [
      { id: 'machines', label: $t('Машины'), badge: L.totals.machines, html: `<div class="note small">${$t("Сгруппировано по карте рецептов и уровню машины. Загрузка — средняя по числу машин. EU/t: полная мощность / фактически.")}</div>
      ${L.machines.length ? t(mrows, [$t('Машина'), $t('Уровень'), $t('Шт.'), $t('Загрузка'), 'EU/t', $t('Узлы')]) : `<div class="note">${$t("Машин нет.")}</div>`}
      <div class="mtotal">${$t("Всего машин:")} <b>${L.totals.machines}</b> (${L.machines.length} ${$t("видов) · EU/t:")} <b>${num(L.totals.euFull)}</b> ${$t("полная /")} <b>${num(L.totals.euAvg)}</b> ${$t("факт.")}</div>` },
      { id: 'bom', label: '🔨 ' + $t('Постройка'), html: `<div class="bomwrap">${bomHtml()}</div>` },
      { id: 'energy', label: '⚡ ' + $t('Энергия'), html: `${eon ? `<h4>${$t("Генераторы")}</h4>${L.generators.length ? t(grows, [$t('Генератор'), $t('Уровень'), $t('Шт.'), $t('EU/t (выдаёт / макс.)'), $t('Топливо'), $t('Узлы')]) : `<div class="note">${$t("Генераторов нет.")}</div>`}
      <h4>${$t("Кабели")}</h4>${L.cables.length ? t(crows, [$t('Кабель'), $t('Уровень'), $t('Блоков'), $t('Связей'), $t('Потери EU/t')]) : `<div class="note">${$t("Кабелей нет (генераторы вплотную или связи без кабеля).")}</div>`}
      <div class="mtotal">${$t("Генерация:")} <b>${num(L.totals.generated)}</b> ${$t("EU/t из")} <b>${num(L.totals.capacity)}</b> ${$t("· потери в кабелях:")} <b>${num(L.totals.losses)}</b> EU/t${L.totals.unpowered ? ` · <span class="warnc">${$t("без питания:")} ${num(L.totals.unpowered)} EU/t</span>` : ''}</div>` : `<div class="note small">${$t("Учёт энергии выключен — генераторы и кабели не показаны.")}</div>`}` },
      { id: 'balance', label: $t('Баланс'), html: this.props.balanceHtml(1e9, this.rootResults).replace(/<div class="btnrow">.*?<\/div>/s, '') || `<div class="note">${$t('нет')}</div>` },
    ])}
      <div class="btnrow"><button data-copy>${$t("Копировать как текст")}</button></div>`, 'wide report');
    m.el.addEventListener('change', e => {
      const k = e.target.dataset.built;
      if (k == null) return;
      const v = Math.max(0, Math.floor(+e.target.value || 0));
      this.root.built = { ...(this.root.built || {}) };
      if (v) this.root.built[k] = v; else delete this.root.built[k];
      this.changed({ solve: false });
      const w = m.el.querySelector('.bomwrap');
      if (w) { w.innerHTML = bomHtml(); w.querySelector(`[data-built="${CSS.escape(k)}"]`)?.focus(); }
    });
    m.el.addEventListener('click', async e => {
      const sel = e.target.dataset.selNode;
      if (sel) { e.preventDefault(); m.close(); this.path = (e.target.dataset.path || '').split(',').filter(Boolean); this.changed({ history: false }); this.select({ type: 'node', id: sel }); return; }
      if (e.target.dataset.copy != null) {
        const text = machineListText(L, eon, this.rootResults?.balance) + '\n\n' + bomText(billOfMaterials(this.root, this.rootResults, this.root.built || {}));
        try { await navigator.clipboard.writeText(text); this.toast($t('Список скопирован в буфер обмена')); }
        catch { download(safeName(this.project.name) + $t('-машины.txt'), text); }
      }
    });
  }

  /** Plan the line for a target output (target.js) and offer to apply it. */
  planDialog(target) {
    const p = this.root;
    const n = M.node(p, target.node);
    const r = n && M.recipeOf(p, n);
    const e = r?.outputs?.[+target.port.slice(1)];
    if (!e) return;
    const P = planForTarget(p, target);
    if (P.error) { this.toast($t('Для этой машины нельзя посчитать план: нет длительности рецепта или машина не запускается.'), 'warn'); return; }
    const ds = this.iconDataset(r);
    const k = e.kind;
    const changed = [...P.rows, ...P.gens].filter(x => x.count !== x.old);
    const mrow = x => {
      const m = M.node(p, x.id), mr = M.recipeOf(p, m), mp = this.rootResults?.nodes[x.id]?.params;
      const tier = mp ? (m.multi ? '▦ ' : '') + TIERS[mp.tier] : '';
      const note = x.blocked ? $t('не запускается — не пересчитана') : x.keep ? $t('не ведёт к цели — без изменений') : `${$t('точно')} ${num(x.exact, 2)}`;
      return `<tr class="${x.count !== x.old ? 'chg' : 'same'}"><td>${mr?.outputs?.[0] ? iconHtml(mr.outputs[0], this.iconDataset(mr), 'small') : ''}</td><td class="bname"><a href="#" data-sel-node="${x.id}">${esc(nodeLabel(p, x.id))}</a><br><small>${esc(tier)} · ${note}</small></td>
        <td class="num">${x.old}</td><td class="num">→</td><td class="num"><b>${x.count}</b></td></tr>`;
    };
    const srow = s => `<tr class="${s.need != null && s.old < s.need * (1 - 1e-6) ? 'short' : ''}"><td>${iconHtml(s.res, ds, 'small')}</td><td class="bname"><a href="#" data-sel-node="${s.id}">${esc(nodeLabel(p, s.id))}</a><br><small>${esc(nm(s.res))}</small></td>
      <td class="num">${rate(s.old, s.res?.kind)}</td><td class="num">→</td><td class="num"><b>${s.need == null ? '—' : rate(s.need, s.res?.kind)}</b></td></tr>`;
    const short = P.sources.filter(s => s.need != null && s.old < s.need * (1 - 1e-6));
    const reached = v => v >= target.rate * (1 - 1e-6);
    const m = openModal(`<h3>🎯 ${$t('План под цель')}</h3>
      <div class="resline">${iconHtml(e, ds, 'small')} <b>${esc(nm(e))}</b> — ${$t('нужно')} <b>${rate(target.rate, k)}</b> ${$t('на выходе')} «${esc(nodeLabel(p, n.id))}»</div>
      <div class="stats">
        <div class="stat"><div class="v">${rate(P.before, k)}</div><div class="k">${$t('Сейчас')}</div></div>
        <div class="stat ${reached(P.achieved) ? 'ok' : 'bad'}"><div class="v">${rate(P.achieved, k)}</div><div class="k">${$t('По плану')}</div></div>
        <div class="stat"><div class="v">${changed.length}</div><div class="k">${$t('Машин меняется')}</div></div>
        <div class="stat energy" title="${$t('было')} ${num(P.euBefore)}"><div class="v">${num(P.euAfter)}</div><div class="k">EU/t ${$t('на полной')}</div></div>
      </div>
      ${P.converged ? '' : `<div class="note warn">${$t('Расчёт не сошёлся полностью — проверьте результат после применения.')}</div>`}
      <h4>${$t('Машины')}</h4><table class="io plan">${P.rows.map(mrow).join('') || `<tr><td>${$t('нет')}</td></tr>`}</table>
      ${P.gens.length ? `<h4>${$t('Генераторы')}</h4><table class="io plan">${P.gens.map(g => `<tr class="${g.count !== g.old ? 'chg' : 'same'}"><td></td><td class="bname"><a href="#" data-sel-node="${g.id}">${esc(nodeLabel(p, g.id))}</a><br><small>${$t('нужно на полной')} ${num(g.request)} EU/t · ${$t('дадут')} ${num(g.capacity)} EU/t</small></td>
        <td class="num">${g.old}</td><td class="num">→</td><td class="num"><b>${g.count}</b></td></tr>`).join('')}</table>` : ''}
      ${P.sources.length ? `<h4>${$t('Источники')}</h4><table class="io plan">${P.sources.map(srow).join('')}</table>
        <label class="chk"><input type="checkbox" data-setsrc ${short.length ? 'checked' : ''}> ${$t('Поставить источникам нужную подачу')}</label>
        ${short.length ? `<div class="note small warn">${$t('Источников с нехваткой')}: ${short.length}. ${$t('Если их оставить как есть, линия даст')} <b>${rate(P.achievedKeep, k)}</b>.</div>` : ''}` : ''}
      ${P.blocks.length ? `<div class="note small">${$t('Блоки (▦) не пересчитываются — откройте блок и задайте цель внутри.')}</div>` : ''}
      <div class="note small">${$t('Число машин округлено вверх до целых; источникам ставится ровно то, что нужно для цели, поэтому лишние машины немного простаивают. Генераторов — столько, чтобы хватило всем машинам на полной мощности (с потерями в кабелях). Кабели не меняются — после применения проверьте вкладку «Проблемы».')}</div>
      <div class="btnrow"><button data-apply class="primary">${$t('Применить')}</button><button data-cancel>${$t('Отмена')}</button></div>`, 'wide plan');
    m.el.addEventListener('click', ev => {
      const t = ev.target;
      if (t.dataset.selNode) { ev.preventDefault(); m.close(); this.select({ type: 'node', id: t.dataset.selNode }); return; }
      if (t.dataset.cancel != null) m.close();
      if (t.dataset.apply != null) {
        const setSrc = !!m.el.querySelector('[data-setsrc]')?.checked;
        m.close();
        this.mutate(() => {
          for (const x of [...P.rows, ...P.gens]) { const q = M.node(this.root, x.id); if (q) q.count = x.count; }
          if (setSrc) for (const s of P.sources) { const q = M.node(this.root, s.id); if (q && s.need != null) q.rate = s.need; }
          this.root.target = { node: target.node, port: target.port, rate: target.rate };
        });
        this.toast($t('План применён — отменить: Ctrl+Z'));
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
    const dirty = this.isDirty() ? `<span class="dirty" title="${$t("Есть изменения после последнего сохранения в projects/ (автосохранение в браузере работает всегда)")}">●</span> ` : '';
    el.innerHTML = `${p.demo ? `<span class="badge demo">${$t("ДЕМО — условные значения источников")}</span> ` : ''}${dirty}${this.path.length ? `<a href="#" data-crumb="0">${esc(p.name)}</a>` : esc(p.name)}${crumbs.join('')}
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
        for (const k of ['recipeId', 'tier', 'oc', 'perfectOc', 'cycleOverride', 'oreChoice', 'multi', 'hatches', 'parallel', 'speedPct', 'euPct', 'coil', 'heat']) delete n[k];
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

  /** Selected nodes with the links between them and their recipe snapshots (for copy / duplicate). */
  clipOf(ids) {
    const p = this.project, set = new Set(ids);
    const nodes = p.nodes.filter(n => set.has(n.id));
    if (!nodes.length) return null;
    const recipes = {};
    for (const n of nodes) if (n.type === 'machine' && p.recipes[n.recipeId]) recipes[n.recipeId] = p.recipes[n.recipeId];
    return JSON.parse(JSON.stringify({
      format: 'gregflow-clip', version: 1, nodes, recipes, energy: M.energyOn(p),
      edges: p.edges.filter(e => set.has(e.from.node) && set.has(e.to.node)),
    }));
  }

  /** Insert a clip with new ids; `at` is the world point for its top-left corner. */
  pasteClip(c, at) {
    if (c?.format !== 'gregflow-clip' || !c.nodes?.length) return;
    const x0 = Math.min(...c.nodes.map(n => n.x)), y0 = Math.min(...c.nodes.map(n => n.y));
    const map = new Map();
    this.mutate(p => {
      for (const [k, r] of Object.entries(c.recipes || {})) p.recipes[k] ??= r;
      for (const n of c.nodes) {
        const id = M.nid(p, 'n');
        map.set(n.id, id);
        p.nodes.push({ ...n, id, x: Math.round((at.x + n.x - x0) / 10) * 10, y: Math.round((at.y + n.y - y0) / 10) * 10 });
      }
      for (const e of c.edges) p.edges.push({ ...e, id: M.nid(p, 'e'), from: { ...e.from, node: map.get(e.from.node) }, to: { ...e.to, node: map.get(e.to.node) } });
      if (c.energy && !M.energyOn(p)) p.energy = { ...(p.energy || {}), enabled: true };
    });
    this.selectNodes([...map.values()]);
    this.loadProjectNames();
  }

  copySelection(cut = false) {
    const ids = this.selectedIds();
    const c = this.clipOf(ids);
    if (!c) return;
    prefs.setClipboard(c);
    if (cut) this.deleteSelection();
    this.toast(`${cut ? $t('Вырезано узлов:') : $t('Скопировано узлов:')} ${c.nodes.length}${$t(' — Ctrl+V вставит их (в том числе в другую схему)')}`);
  }

  paste() {
    const c = prefs.clipboard();
    if (!c) { this.toast($t('Буфер пуст: выделите узлы и нажмите Ctrl+C'), 'error'); return; }
    this.pasteClip(c, this.mouseWorld() || this.placeAt());
  }

  duplicateSelection() {
    const c = this.clipOf(this.selectedIds());
    if (!c) return;
    const x0 = Math.min(...c.nodes.map(n => n.x)), y0 = Math.min(...c.nodes.map(n => n.y));
    this.pasteClip(c, { x: x0 + 40, y: y0 + 40 });
  }

  /** World point under the mouse, when the mouse is over the canvas. */
  mouseWorld() {
    const h = this.lastMouse;
    if (!h || !this.canvas.el.contains(document.elementFromPoint(h.x, h.y))) return null;
    return this.canvas.toWorld(h.x, h.y);
  }

  /** Add a source / storage / generator next to a port and link it (problem fixes). */
  quickAttach(src, kind) {
    const p = this.project;
    const n = M.node(p, src.node);
    if (!n) return;
    const el = this.canvas.nlayer.querySelector(`.node[data-id="${n.id}"]`);
    const w = el?.offsetWidth || 300;
    const pos = kind === 'sink' ? { x: n.x + w + 140, y: n.y } : kind === 'generator' ? { x: n.x - 380, y: n.y + (el?.offsetHeight || 150) + 40 } : { x: n.x - 340, y: n.y };
    const at = this.placeAt(pos);
    const res = M.portResource(p, n, src.port);
    let m;
    this.mutate(q => {
      if (kind === 'source') m = M.addNode(q, { type: 'source', resource: strip(res), rate: fromUnit(res?.kind === 'fluid' ? 1000 : 10), ...at });
      else if (kind === 'sink') m = M.addNode(q, { type: 'sink', ...at });
      else { m = M.addNode(q, { type: 'generator', ...at }); if (!M.energyOn(q)) q.energy = { ...(q.energy || {}), enabled: true }; }
    });
    if (kind === 'source') this.connect({ node: m.id, port: 'out' }, { node: n.id, port: src.port });
    else if (kind === 'sink') this.connect({ node: n.id, port: src.port }, { node: m.id, port: 'in' });
    else this.connect({ node: m.id, port: 'eo' }, { node: n.id, port: 'ep' });
    if (kind !== 'sink') this.select({ type: 'node', id: m.id });
    this.toast(kind === 'source' ? $t('Источник добавлен — задайте его скорость') : kind === 'generator' ? $t('Генератор добавлен — выберите модель и топливо') : $t('Склад добавлен'));
  }

  /** Auto-arrange the selected nodes (or all) in columns following the flow. */
  arrangeNodes() {
    const sel = this.selectedIds();
    const ids = sel.length > 1 ? sel : null;
    const size = n => {
      const el = this.canvas.nlayer.querySelector(`.node[data-id="${n.id}"]`);
      return { w: el?.offsetWidth || 300, h: el?.offsetHeight || 150 };
    };
    const pos = arrange(this.project, ids, size);
    if (!pos.size) { this.toast($t('Нечего упорядочивать'), 'error'); return; }
    this.mutate(p => { for (const n of p.nodes) { const q = pos.get(n.id); if (q) { n.x = q.x; n.y = q.y; } } });
    if (!ids) requestAnimationFrame(() => this.canvas.fit());
    this.toast(ids ? $t('Выделенные узлы упорядочены') : $t('Схема упорядочена по потоку. Отменить: Ctrl+Z'));
  }

  /** R / U over any icon: recipes that make it / use it (as in NEI). */
  lookupHovered(mode) {
    const el = this.hover?.closest?.('[data-gid]');
    if (!el) return false;
    this.catalog.showGoods(el.dataset.gid, mode);
    return true;
  }

  exportPng() { exportPng(this).catch(err => this.toast(err.message, 'error')); }

  // ---------- named versions (stored inside the schematic) ----------
  saveVersion(name) {
    const data = JSON.stringify({ ...this.root, versions: undefined });
    this.history.push(this.root);
    this.root.versions = [{ id: Date.now().toString(36), name: name || new Date().toLocaleString(), at: new Date().toISOString(), data }, ...(this.root.versions || [])].slice(0, 30);
    this.changed({ solve: false });
    this.toast($t('Версия сохранена в схеме'));
  }
  restoreVersion(id) {
    const v = (this.root.versions || []).find(x => x.id === id);
    if (!v) return;
    this.history.push(this.root);
    const versions = this.root.versions;
    this.root = { ...JSON.parse(v.data), versions };
    this.path = []; this.selection = null;
    this.changed();
    requestAnimationFrame(() => this.canvas.fit());
    this.toast(`${$t('Восстановлена версия')} «${v.name}». ${$t('Отменить: Ctrl+Z')}`);
  }
  deleteVersion(id) {
    this.history.push(this.root);
    this.root.versions = (this.root.versions || []).filter(x => x.id !== id);
    this.changed({ solve: false });
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
  setProject(p, { saved = true } = {}) {
    this.project = p;
    this.blockFull = false;
    this.resHighlight = null;
    if (saved) this.savedHash = this.hashOf(p); store.set(SAVED, this.savedHash);
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
      this.markSaved();
      this.toast($t('Сохранено в projects/') + r.file + '.json');
    } catch (e) { this.toast(e.message, 'error'); }
  }

  async openProjectDialog() {
    const list = (await api.projects()).projects.sort((a, b) => String(b.modified).localeCompare(String(a.modified)));
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
      this.setProject(p, { saved: false });
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
    const arm = document.getElementById('armslots');
    arm.checked = this.showArmSlots;
    arm.onchange = () => { this.showArmSlots = arm.checked; prefs.setArmSlots(arm.checked); this.canvas.render(); };
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
      if (a === 'arrange') this.arrangeNodes();
      if (a === 'probs') this.showProblems();
      if (a === 'png') this.exportPng();
    });
    void tb;
  }

  undo() { const p = this.history.back(this.root); if (p) { const path = this.path; this.root = p; this.path = path; this.selection = null; this.changed({ history: false }); } }
  redo() { const p = this.history.forward(this.root); if (p) { const path = this.path; this.root = p; this.path = path; this.selection = null; this.changed({ history: false }); } }

  bindKeys() {
    window.addEventListener('focus', () => this.refreshStatus().catch(() => {}));
    window.addEventListener('pointermove', e => { this.hover = e.target; this.lastMouse = { x: e.clientX, y: e.clientY }; }, { passive: true });
    window.addEventListener('keydown', e => {
      if (e.target.closest('input,textarea,select')) return;
      if (document.querySelector('.modal-wrap')) { if (e.key === 'Escape') document.querySelector('.modal-wrap').remove(); return; }
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && k === 'z' && !e.shiftKey) { e.preventDefault(); this.undo(); }
      else if ((e.ctrlKey || e.metaKey) && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); this.redo(); }
      else if ((e.ctrlKey || e.metaKey) && k === 's') { e.preventDefault(); this.saveProject(); }
      else if ((e.ctrlKey || e.metaKey) && k === 'd') { e.preventDefault(); this.duplicateSelection(); }
      else if ((e.ctrlKey || e.metaKey) && k === 'c' && !String(window.getSelection())) { e.preventDefault(); this.copySelection(); }
      else if ((e.ctrlKey || e.metaKey) && k === 'x' && !String(window.getSelection())) { e.preventDefault(); this.copySelection(true); }
      else if ((e.ctrlKey || e.metaKey) && k === 'v') { e.preventDefault(); this.paste(); }
      else if ((e.ctrlKey || e.metaKey) && k === 'o') { e.preventDefault(); this.openProjectDialog(); }
      else if ((k === 'r' || k === 'u') && !e.ctrlKey && !e.metaKey && !e.altKey) { if (this.lookupHovered(k === 'r' ? 'production' : 'consumption')) e.preventDefault(); }
      else if (k === 'l' && !e.ctrlKey && !e.metaKey) this.arrangeNodes();
      else if ((e.ctrlKey || e.metaKey) && k === 'g' && e.shiftKey) { e.preventDefault(); const s = this.selection; if (s?.type === 'node' && M.node(this.project, s.id)?.type === 'group') this.ungroup(s.id); }
      else if ((e.ctrlKey || e.metaKey) && k === 'g') { e.preventDefault(); this.groupSelection(); }
      else if ((e.ctrlKey || e.metaKey) && k === 'a') { e.preventDefault(); this.selectNodes(this.project.nodes.map(n => n.id)); }
      else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); this.deleteSelection(); }
      else if (k === 'f' && !e.ctrlKey) this.canvas.fit();
      else if (e.key === 'Escape') { this.catalog.setPending(null); if (this.resHighlight) { this.toggleResHighlight(this.resHighlight); return; } if (!this.selection && this.path.length) this.exitBlock(); else this.select(null); }
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
