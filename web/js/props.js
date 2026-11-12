// Right panel: properties of the selected node / edge, or project summary.
import { $t, lbl } from './i18n.js';
import { esc, num, rate, rateVal, fromUnit, unitLabel, iconHtml, seconds, TIERS, TIER_V, nm, mname } from './fmt.js';
import { node as findNode, edge as findEdge, recipeOf, ports, resolveInput, NODE_TYPES, energyOn, isFuelRecipe, fuelFromOption, resolvePath, isEnergyRes } from './model.js';
import { api } from './api.js';

const GT_V = [8, 32, 128, 512, 2048, 8192, 32768, 131072, 524288, 2097152, 8388608, 33554432, 134217728, 536870912];
const GT_T = ['ULV', 'LV', 'MV', 'HV', 'EV', 'IV', 'LuV', 'ZPM', 'UV', 'UHV', 'UEV', 'UIV', 'UMV', 'UXV'];
const vName = v => { const i = GT_V.indexOf(+v); return i >= 0 ? GT_T[i] : ''; };
const brief = g => ({ kind: g.kind || 'item', id: g.id, name: g.name, nameRu: g.nameRu, icon: g.icon });
import { machineParams, recipeTier, recipeHeat, EBF_ID } from './solver.js';
import { COILS } from './overclock.js';
import { summarize } from './summary.js';
import { fixesFor, applyFix, whyLimited, machinesForDemand, machinesForSupply } from './fixes.js';
import { tabsHtml, cardify } from './ui.js';
import { armSlots } from './slots.js';

/** Small "?" with an explanation of a GregTech term. */
const help = t => `<span class="qhelp" title="${esc(t)}">?</span>`;
const H = {
  util: () => $t('Загрузка — доля времени, когда машины действительно работают. Меньше 100%, если не хватает какого-то входа или энергии.'),
  oc: () => $t('Разгон (overclock): машина уровнем выше рецепта за каждый лишний уровень работает в 2 раза быстрее и берёт в 4 раза больше EU/t. Идеальный разгон — в 4 раза быстрее.'),
  eut: () => $t('EU/t — энергия за тик. В секунде 20 тиков.'),
  amps: () => $t('Ампер — сколько пакетов энергии за тик идёт по кабелю. Кабель держит ограниченное число ампер, при большем токе он сгорит.'),
  loss: () => $t('Потери: каждый блок кабеля съедает несколько EU с каждого ампера. Длинный и тонкий кабель теряет больше, сверхпроводники не теряют ничего.'),
  hatches: () => $t('Сколько обычных энергоразъёмов (Energy Hatch) стоит на мультиблоке. Их уровень — поле «Уровень разъёмов».'),
  parallel: () => $t('Сколько рецептов машина выполняет за раз — из подсказки мультиблока. Ограничивается и энергией разъёмов.'),
  heat: () => $t('Нагрев этого мультиблока в кельвинах: его показывает подсказка структуры или сканер. Без него бонусы нагрева не считаются.'),
  target: () => $t('Укажите, сколько этого продукта нужно, — планировщик посчитает, сколько машин нужно на каждом шаге линии и сколько должен давать каждый источник. Перед применением покажет план; применённое отменяется Ctrl+Z.'),
  arm: () => $t('Номер — значение слота на роборуке (Robot Arm): слот N машины. 0 на роборуке — любой слот. Данные: GregTech 5.09.51.482 (GTNH 2.8.x), только одноблочные машины GT.'),
  eff: () => $t('КПД — какая доля энергии топлива становится EU. Берётся из описания генератора.'),
  totals: () => $t('Всё посчитано решателем для текущего состояния линии. «Сейчас» — фактический режим, «на полной» — если бы машины работали на 100%.'),
};

export class PropsPanel {
  constructor(el, app) {
    this.el = el; this.app = app;
    let timer;
    el.addEventListener('input', e => {
      if (!e.target.matches('[data-gsearch]')) return;
      clearTimeout(timer);
      const q = e.target.value, box = el.querySelector('.ghits');
      timer = setTimeout(async () => {
        if (!q.trim()) { box.innerHTML = ''; return; }
        const r = await api.search(q);
        box.innerHTML = r.goods.slice(0, 10).map(g => `<div class="li" data-fuelres='${esc(JSON.stringify(brief(g)))}'>${iconHtml(g, app.iconDataset(), 'small')}<span>${esc(nm(g))}</span><small>${g.kind === 'fluid' ? $t('жидк.') : ''}</small></div>`).join('') || `<small>${$t("нет совпадений")}</small>`;
      }, 250);
    });
    el.addEventListener('change', e => this.onChange(e));
    el.addEventListener('click', e => this.onClick(e));
  }

  render() {
    const top = this.el.scrollTop;
    this.view();
    cardify(this.el);
    this.el.scrollTop = top;
  }

  view() {
    this.fixes = [];
    const { selection: sel, project: p } = this.app;
    if (sel?.type === 'nodes') return this.multiView(sel.ids);
    if (sel?.type === 'node' && findNode(p, sel.id)) return this.nodeView(findNode(p, sel.id));
    if (this.app.path.length) return this.blockSummary();
    if (sel?.type === 'edge' && findEdge(p, sel.id)) return findEdge(p, sel.id).energy ? this.energyEdgeView(findEdge(p, sel.id)) : this.edgeView(findEdge(p, sel.id));
    return this.summary();
  }

  /** A row of big numbers at the top of a summary. */
  statsHtml(T, probs) {
    const tile = (v, k, cls = '', act = '') => `<div class="stat ${cls}" ${act}><div class="v">${v}</div><div class="k">${k}</div></div>`;
    const loose = T.outputs.filter(x => x.loose > 0).length;
    return `<div class="stats">
      ${tile(T.machines, $t('Машин'))}
      ${tile(num(T.powerAvg), 'EU/t ' + $t('сейчас'), 'energy')}
      ${tile(probs.length, $t('Проблем'), probs.length ? 'bad' : 'ok', 'data-tb="probs" title="' + esc($t('нажмите, чтобы открыть список с исправлениями')) + '"')}
      ${tile(T.outputs.length - loose, $t('Продуктов'), '', 'title="' + esc($t('Ресурсы, которые уходят на склады или дальше по линии')) + '"')}
    </div>`;
  }

  /** Totals of a schematic / block / selection (see summary.js). */
  totalsHtml(T, title, { flows = true } = {}) {
    const ds = this.app.iconDataset();
    const hl = this.app.resHighlight;
    const list = arr => arr.length ? `<table class="io bal">${arr.slice(0, 12).map(x => `<tr data-hlres="${esc(x.res.id)}" class="${hl === x.res.id ? 'hl' : ''}"><td>${iconHtml(x.res, ds, 'small')}</td><td class="bname">${esc(nm(x.res))}${x.loose > 0 ? `<br><small class="warnc">${$t('никуда не идёт:')} ${rate(x.loose, x.res.kind)}</small>` : ''}</td><td class="num">${rate(x.rate, x.res.kind)}</td></tr>`).join('')}</table>${arr.length > 12 ? `<small>${$t('и ещё')} ${arr.length - 12}</small>` : ''}`
      : `<div class="note small">${$t('нет')}</div>`;
    const kinds = T.machineTypes.slice(0, 6).map(([n, c]) => `${esc(n)} ×${c}`).join(', ') + (T.machineTypes.length > 6 ? ', …' : '');
    return `<h4>${title} ${help(H.totals())}</h4>
      <table class="kv">
        <tr><th>${$t('Машин')}</th><td><b>${T.machines}</b>${T.machineTypes.length ? `<br><small>${kinds}</small>` : ''}</td></tr>
        <tr><th>${$t('Энергия машин')} ${help(H.eut())}</th><td><b>${num(T.powerAvg)}</b> EU/t ${$t('сейчас')}<br><small>${num(T.powerFull)} EU/t ${$t('на полной')}</small></td></tr>
        ${T.generators ? `<tr><th>${$t('Генераторы')}</th><td>${T.generators} ${$t('шт.')} · ${$t('выдают')} <b>${num(T.generated)}</b> ${$t('из')} ${num(T.capacity)} EU/t</td></tr>` : ''}
        ${T.losses > 0 ? `<tr><th>${$t('Потери в кабелях')}</th><td class="warnc">${num(T.losses)} EU/t</td></tr>` : ''}
        ${T.powerIn > 0 ? `<tr><th>${$t('Энергия приходит')}</th><td>${num(T.powerIn)} EU/t</td></tr>` : ''}
        ${T.powerOut > 0 ? `<tr><th>${$t('Энергия уходит')}</th><td>${num(T.powerOut)} EU/t</td></tr>` : ''}
      </table>
      ${T.fuel.length ? `<h5>${$t('Топливо генераторов')}</h5><table class="io bal">${T.fuel.map(f => `<tr data-hlres="${esc(f.res.id)}"><td>${iconHtml(f.res, ds, 'small')}</td><td class="bname">${esc(nm(f.res))}</td><td class="num">${rate(f.rate, f.res.kind)}<br><small>${$t('на полной')} ${rate(f.full, f.res.kind)}</small></td></tr>`).join('')}</table>` : ''}
      ${flows ? `<h5>${$t('Приходит')}</h5>${list(T.inputs)}<h5>${$t('Выходит')}</h5>${list(T.outputs)}` : ''}`;
  }

  /** Problem list; each problem links to its place and offers fixes when one is known. */
  problemsHtml(probs, okText) {
    if (!probs.length) return `<div class="note ok">${okText}</div>`;
    return `<ul class="problems">${probs.map(x => {
      const fs = fixesFor(this.app, x).filter(f => f.edit || f.run || f.enter || (f.select && f.select !== x.node));
      const btns = fs.map(f => { this.fixes.push(f); return `<button class="fix" data-fix="${this.fixes.length - 1}" title="${esc(f.edit ? $t('Изменить схему (можно отменить: Ctrl+Z)') : '')}">${esc(f.label)}</button>`; }).join('');
      return `<li class="${x.kind}"><a href="#" ${x.edge ? `data-sel-edge="${x.edge}"` : x.node ? `data-sel-node="${x.node}"` : ''}>${esc(x.text)}</a>${btns ? `<div class="fixes">${btns}</div>` : ''}</li>`;
    }).join('')}</ul>`;
  }

  nodeName(id) {
    const p = this.app.project, n = findNode(p, id);
    if (!n) return id;
    if (n.type === 'machine') return `${lbl(n.label) || mname(recipeOf(p, n)?.machine)} ×${n.count}`;
    if (n.type === 'generator') return `${n.label && n.label !== 'Генератор' ? lbl(n.label) : nm(n.gen) || $t('Генератор')} ×${n.count ?? 1}`;
    return lbl(n.label) || NODE_TYPES[n.type];
  }
  link(id) { return `<a href="#" data-sel-node="${id}">${esc(this.nodeName(id))}</a>`; }

  multiView(ids) {
    const p = this.app.project;
    const list = ids.map(id => findNode(p, id)).filter(Boolean);
    const groupable = list.filter(n => n.type !== 'gin' && n.type !== 'gout');
    this.el.innerHTML = `<h3><span class="hico">⬚</span>${$t("Выделено узлов:")} ${list.length}</h3>
      <div class="note small">${list.map(n => this.link(n.id)).join('<br>')}</div>
      <div class="btnrow"><button data-act="group" ${groupable.length ? '' : 'disabled'}>${$t("▦ Объединить в блок (Ctrl+G)")}</button><button data-act="arrange" title="${$t("Расставить выделенные узлы по потоку (L)")}">${$t("⇶ Упорядочить")}</button></div>
      <div class="note small"><b>${$t("Блок")}</b> ${$t("— узел из узлов. Связи, которые пересекают границу выделения, станут входами и выходами блока; неподключённые входы машин — тоже входами, неподключённые выходы — выходами. Блок считается точно: его внутренняя схема решается с тем, что реально приходит на входы. Открыть блок — двойной щелчок, вернуться — «⤴ Выйти из блока» или Esc.")}</div>
      <div class="btnrow"><button data-act="delsel" class="danger">${$t("Удалить выделенные")}</button></div>
      <div class="hint">${$t("Выделение: Ctrl/Shift + щелчок по узлу, Shift + рамка по пустому месту, Ctrl+A — все.")}</div>
      ${this.totalsHtml(summarize(p, this.app.results, list.map(n => n.id)), $t('Итоги выделенного'))}`;
  }

  /** Summary shown while a block is open for editing. */
  blockSummary() {
    const app = this.app, R = app.results;
    const parent = resolvePath(app.root, app.path.slice(0, -1));
    const b = findNode(parent, app.path[app.path.length - 1]);
    const q = app.project;
    const gins = q.nodes.filter(n => n.type === 'gin'), gouts = q.nodes.filter(n => n.type === 'gout');
    const ds = app.iconDataset();
    const io = (list, dir) => list.map(n => {
      const s = R?.nodes[n.id];
      const v = n.type === 'gin' ? s?.outputs.out?.actual : isEnergyRes(n.resource) ? s?.powerAvg : s?.inputs.in?.used;
      return `<tr><td>${n.resource && !isEnergyRes(n.resource) ? iconHtml(n.resource, ds, 'small') : isEnergyRes(n.resource) ? '⚡' : ''}</td><td><a href="#" data-sel-node="${n.id}">${esc(lbl(n.label) || (dir === 'in' ? $t('Вход') : $t('Выход')))}</a><br><small>${esc(n.resource ? nm(n.resource) : $t('не подключён — тип по первой связи'))}</small></td><td class="num">${n.resource ? (isEnergyRes(n.resource) ? num(v || 0) + ' EU/t' : rate(v || 0, n.resource.kind)) : '—'}</td></tr>`;
    }).join('') || `<tr><td colspan="3"><small>${$t("нет — добавьте «+")} ${dir === 'in' ? $t('Вход') : $t('Выход')} ${$t("блока»")}</small></td></tr>`;
    const probs = R?.problems || [];
    const T = summarize(q, R);
    this.el.innerHTML = `<h3><span class="hico">▦</span>${$t("Блок")}</h3>${tabsHtml('block', [
      { id: 'main', label: $t('Блок'), html: `${this.statsHtml(T, probs)}<label>${$t("Название блока")} <input data-f="blockname" value="${esc(lbl(b?.label) || $t('Блок'))}"></label>
      <div class="note small">${$t("Вы внутри блока.")} ${app.blockFull ? `${$t("Показана")} <b>${$t("полная мощность")}</b>${$t(": входы без ограничения.")}` : `${$t("Показан")} <b>${$t("фактический режим")}</b>${$t(": входы получают то, что приходит на блок снаружи.")}`} ${$t("Входы и выходы блока — узлы «Вход блока» и «Выход блока»; каждый становится портом блока снаружи. Машины без своего генератора питаются от ⚡ входа блока.")}</div>
      <div class="btnrow"><button data-act="exitblk">${$t("⤴ Выйти из блока")}</button><button data-act="addgin">${$t("+ Вход блока")}</button><button data-act="addgout">${$t("+ Выход блока")}</button></div>
      <h4>${$t("Входы")}</h4><table class="io bal">${io(gins, 'in')}</table>
      <h4>${$t("Выходы")}</h4><table class="io bal">${io(gouts, 'out')}</table>` },
      { id: 'problems', label: $t('Проблемы'), badge: probs.length, badgeKind: probs.length ? 'bad' : 'ok', html: `<h4 id="problems">${$t("Проблемы внутри (")}${probs.length})</h4>${this.problemsHtml(probs, $t("Проблем нет."))}` },
      { id: 'totals', label: $t('Итоги'), html: this.totalsHtml(T, $t('Итоги блока'), { flows: false }) },
      { id: 'balance', label: $t('Баланс'), html: (this.balanceHtml(14, R) + this.loopsHtml()) || `<div class="note">${$t('нет')}</div>` },
    ])}`;
  }

  groupView(n, s) {
    const p = this.app.project;
    const ds = this.app.iconDataset();
    const ps = ports(p, n);
    const rows = ps.map(pt => {
      const x = pt.dir === 'in' ? s?.inputs[pt.id] : s?.outputs[pt.id];
      const k = pt.res?.kind;
      if (pt.energy) return pt.dir === 'in'
        ? `<tr><td>⚡</td><td>${$t("Вход энергии")}</td><td class="num">${num(x?.need || 0)} EU/t</td><td class="num">${num(x?.used || 0)} EU/t</td></tr>`
        : `<tr><td>⚡</td><td>${$t("Выход энергии")}</td><td class="num">${num(s?.capacity || 0)} EU/t</td><td class="num">${num(s?.output || 0)} EU/t</td></tr>`;
      return `<tr class="${pt.dir === 'in' && x && x.need > 0 && x.supplied < x.need * (1 - 1e-7) ? 'warn' : ''}"><td>${iconHtml(pt.res, ds, 'small')}</td><td>${pt.dir === 'in' ? '→ ' : '← '}${esc(nm(pt.res))}</td>
        <td class="num">${pt.dir === 'in' ? rate(x?.need || 0, k) : rate(x?.max || 0, k)}</td><td class="num">${pt.dir === 'in' ? rate(x?.used || 0, k) + `<br><small>${$t("есть")} ${rate(x?.supplied || 0, k)}</small>` : rate(x?.actual || 0, k)}</td></tr>`;
    }).join('');
    const inner = n.inner.nodes.filter(x => x.type !== 'gin' && x.type !== 'gout');
    return `<table class="kv"><tr><th>${$t("Загрузка")}</th><td>${s?.util != null ? num(s.util * 100, 1) + '%' : '—'}</td></tr>
      <tr><th>${$t("Внутри")}</th><td>${inner.length} ${$t("узл. (")}${inner.filter(x => x.type === 'machine').length} ${$t("машин)")}${s?.innerProblems ? `<br><span class="warnc">${$t("проблем внутри:")} ${s.innerProblems}</span>` : ''}</td></tr>
      <tr><th>${$t("Мощность")}</th><td>${num(s?.powerFull || 0)} ${$t("EU/t полная /")} ${num(s?.powerAvg || 0)} ${$t("факт.")}</td></tr></table>
      <h4 data-k="g-ports">${$t("Порты")}</h4>
      <table class="io"><tr><th></th><th>${$t("Порт")}</th><th>${$t("Полная мощн.")}</th><th>${$t("Сейчас")}</th></tr>${rows}</table>
      <div class="note small">${$t("«Полная мощность» — сколько блок возьмёт и даст, если входы не ограничены. «Сейчас» — внутренняя схема, решённая с тем, что реально приходит на входы.")}</div>
      ${s?.innerR ? this.totalsHtml(summarize(n.inner, s.innerR), $t('Внутри блока'), { flows: false }) : ''}
      <div class="btnrow foot"><button data-act="enter">${$t("⤵ Открыть блок")}</button><button data-act="ungroup">${$t("Разгруппировать")}</button></div>`;
  }

  summary() {
    const { project: p, results: R, status } = this.app;
    const act = status?.active;
    const inst = status?.install;
    const probs = R?.problems || [];
    const T = summarize(p, R);
    const vs = this.app.root.versions || [];
    const overview = `<label>${$t("Название")} <input data-f="name" value="${esc(p.name)}"></label>
      ${p.demo ? `<div class="note demo"><b>${$t("ДЕМО-СХЕМА.")}</b> ${esc(p.demoNote)}</div>` : ''}
      ${this.statsHtml(T, probs)}
      ${this.targetSummary()}
      <div class="btnrow"><button data-act="arrange" title="${$t("Расставить узлы по потоку слева направо (L). Отменить: Ctrl+Z")}">${$t("⇶ Упорядочить схему")}</button><button data-act="png" title="${$t("Сохранить картинку схемы")}">${$t("🖼 PNG")}</button><button data-act="machines">${$t("☰ Отчёт")}</button></div>
      ${this.totalsHtml(T, $t('Итоги линии'))}
      <h4>${$t("Уровень машин")}</h4>
      <div class="grid2"><label>${$t("По умолчанию для новых")} <select data-f="defaultTier"><option value="">${$t("уровень рецепта")}</option>${TIERS.map((t, i) => `<option value="${i}" ${p.defaultTier === i ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        <label>&nbsp;<button data-act="applytier" ${p.defaultTier == null ? 'disabled' : ''}>${$t("Применить ко всем машинам")}</button></label></div>
      <h4>${$t("Данные")}</h4>
      <table class="kv">
        <tr><th>${$t("Узлов / связей")}</th><td>${p.nodes.length} / ${p.edges.length}</td></tr>
        <tr><th>${$t("Рецепты схемы")}</th><td>${Object.keys(p.recipes).length} ${$t("снимков")}${p.dataset ? `<br><small>${$t("создана на")} ${esc(p.dataset.label)}</small>` : ''}</td></tr>
        <tr><th>${$t("Рецепты")}</th><td>${esc(act?.label || '—')} ${act?.verified ? `<span class="badge ok">${$t("проверено")}</span>` : `<span class="badge warn">${$t("не проверено")}</span>`}<br><small>${$t("формат")} ${act?.format ?? '—'} · ${esc(act?.sourceBranch || act?.origin || '')}</small></td></tr>
        <tr><th>${$t("Сборка")}</th><td>${inst?.found ? `${esc(inst.packVersion || '?')} <small>(${esc(inst.packVersionSource || '')})</small>` : `<small>${$t("не найдена")}</small>`}</td></tr>
      </table>
      ${inst?.found && act && inst.packVersion !== act.packVersion ? `<div class="note warn">${$t("Рецепты")} ${esc(act.packVersion)} ${$t("≠ сборка")} ${esc(inst.packVersion)}${$t(". Значения могут отличаться; правки вносите в «Свои рецепты».")}</div>` : ''}
      <h4 data-k="hints">${$t("Подсказки")}</h4>
      <ul class="hints"><li>${$t("Подсказки: колесо — масштаб, перетаскивание фона — панорама, перетащите от порта к порту — связь, Delete — удалить, Ctrl+Z / Ctrl+Y — отмена/повтор, F — вписать.")}</li><li>${$t("От порта в пустое место — найти рецепт. R / U над иконкой — рецепты / применение. Ctrl+C / Ctrl+V — копировать узлы (и в другую схему), Ctrl+D — дублировать, L — упорядочить.")}</li></ul>`;
    this.el.innerHTML = `<h3><span class="hico">⚙</span>${$t("Схема")}</h3>${tabsHtml('summary', [
      { id: 'overview', label: $t('Обзор'), html: overview },
      { id: 'problems', label: $t('Проблемы'), badge: probs.length, badgeKind: probs.length ? 'bad' : 'ok', html: `<h4 id="problems">${$t("Проблемы (")}${probs.length})</h4>${this.problemsHtml(probs, $t("Дефицитов и неподключённых портов нет."))}` },
      { id: 'balance', label: $t('Баланс'), html: (this.balanceHtml() + this.loopsHtml()) || `<div class="note">${$t('Схема пуста — добавьте рецепт из каталога слева.')}</div>` },
      { id: 'energy', label: '⚡', title: $t('Энергия'), html: this.energySummary() },
      { id: 'versions', label: $t('Версии'), badge: vs.length || '', html: this.versionsHtml() },
    ])}`;
  }

  targetSummary() {
    const T = this.app.root.target;
    if (!T || this.app.path.length) return '';
    const p = this.app.root, R = this.app.rootResults;
    const n = findNode(p, T.node);
    const r = n && recipeOf(p, n);
    const e = r?.outputs?.[+T.port.slice(1)];
    if (!e) return '';
    const cur = R?.nodes[n.id]?.outputs?.[T.port]?.actual || 0;
    const ok = cur >= T.rate * (1 - 1e-6);
    return `<div class="target ${ok ? 'ok' : 'short'}"><span>🎯 ${iconHtml(e, this.app.iconDataset(r), 'small')} <b>${esc(nm(e))}</b>: ${rate(cur, e.kind)} ${$t('из')} ${rate(T.rate, e.kind)}</span>
      <span><a href="#" data-sel-node="${n.id}">${$t('к машине')}</a> <button data-act="plan-saved">${$t('План')}</button></span></div>`;
  }

  versionsHtml() {
    const vs = this.app.root.versions || [];
    return `<h4>${$t("Версии (")}${vs.length})</h4>
      <div class="inl vrow"><input data-vname placeholder="${$t("например: до EBF")}"><button data-act="vsave">${$t("Сохранить версию")}</button></div>
      ${vs.length ? `<ul class="versions">${vs.map(v => `<li><span><b>${esc(v.name)}</b><br><small>${esc(new Date(v.at).toLocaleString())}</small></span><button data-vrestore="${esc(v.id)}">${$t("Вернуть")}</button><button data-vdel="${esc(v.id)}" title="${$t("Удалить версию")}">✕</button></li>`).join('')}</ul>` : ''}
      <div class="note small">${$t("Версия — копия схемы внутри её файла. «Вернуть» заменяет схему этой копией; отменить можно через Ctrl+Z.")}</div>`;
  }

  nodeView(n) {
    const { project: p, results: R } = this.app;
    const s = R?.nodes[n.id];
    const ico = { machine: '⚒', generator: '⚡', source: '⭲', sink: '▣', splitter: '⑂', merger: '⋈', group: '▦', gin: '⇥', gout: '⇤' }[n.type] || '•';
    let h = `<h3 class="t-${n.type}"><span class="hico">${ico}</span>${esc(NODE_TYPES[n.type])}</h3>`;
    h += `<label>${$t("Подпись")} <input data-f="label" value="${esc(lbl(n.label) || '')}" placeholder="${n.type === 'machine' ? esc(mname(recipeOf(p, n)?.machine)) : ''}"></label>`;
    if (n.type === 'machine') h += this.machineView(n, s);
    if (n.type === 'generator') h += this.generatorView(n, s);
    if (n.type === 'group') h += this.groupView(n, s);
    if (n.type === 'gin' || n.type === 'gout') {
      const res = n.resource;
      const v = n.type === 'gin' ? s?.outputs.out?.actual : isEnergyRes(res) ? s?.powerAvg : s?.inputs.in?.used;
      h += `<div class="resline">${res && !isEnergyRes(res) ? iconHtml(res, this.app.iconDataset(), 'small') + ' ' : ''}<b>${esc(res ? nm(res) : $t('тип не задан'))}</b>${res?.id ? `<br><small>${esc(res.id)}</small>` : ''}</div>
        <table class="kv"><tr><th>${n.type === 'gin' ? $t('Приходит в блок') : $t('Уходит из блока')}</th><td>${res ? (isEnergyRes(res) ? num(v || 0) + ' EU/t' : rate(v || 0, res.kind)) : '—'}</td></tr></table>
        <div class="note small">${n.type === 'gin' ? $t('Снаружи у блока появится вход с этим ресурсом. Тип задаётся первой связью от этого узла к машине.') : $t('Снаружи у блока появится выход. Тип задаётся первой связью к этому узлу; связь от ⚡ генератора делает его выходом энергии.')}</div>`;
    }
    if (n.type === 'source') {
      h += `<div class="resline">${iconHtml(n.resource, this.app.iconDataset(), 'small')} <b>${esc(nm(n.resource))}</b><br><small>${esc(n.resource?.id)}</small></div>
        <label>${$t("Пропускная способность")} <span class="inl"><input type="number" min="0" step="any" data-f="rate" value="${+rateVal(n.rate).toFixed(6)}"> ${n.resource?.kind === 'fluid' ? 'L' : $t('шт')}${unitLabel()}</span></label>
        ${p.demo ? `<div class="note demo">${$t("Значение источника задано для демонстрации, это не данные каталога.")}</div>` : ''}
        ${this.outputsTable(n, s)}`;
    }
    if (n.type === 'splitter' || n.type === 'merger') {
      const sIn = s?.inputs.in, sOut = s?.outputs.out;
      h += `<div class="resline">${n.resource ? iconHtml(n.resource, this.app.iconDataset(), 'small') + ' <b>' + esc(nm(n.resource)) + '</b><br><small>' + esc(n.resource.id) + '</small>' : `<i>${$t("тип определяется первой связью")}</i>`}</div>
        <table class="kv"><tr><th>${$t("Вход")}</th><td>${rate(sIn?.supplied || 0, n.resource?.kind)}</td></tr>
        <tr><th>${$t("Потребность ниже")}</th><td>${rate(this.downDemand(n), n.resource?.kind)}</td></tr></table>
        ${this.outputsTable(n, s)}
        <div class="note">${n.type === 'splitter' ? $t('Распределение по выходам задаётся на каждой исходящей связи: «авто» (по потребности) или фиксированная доля %.') : $t('Слияние суммирует все входящие потоки одного ресурса.')}</div>`;
    }
    if (n.type === 'sink') {
      const list = this.app.sinkContents(n.id);
      h += `<table class="kv">${list.map(x => `<tr><th>${iconHtml(x.res, this.app.iconDataset(), 'small')} ${esc(nm(x.res))}</th><td>${rate(x.rate, x.res?.kind)}</td></tr>`).join('') || `<tr><td>${$t("пусто")}</td></tr>`}</table>
        <div class="note">${$t("Склад принимает любые ресурсы без ограничения (бесконечная потребность), поэтому в «авто»-распределении получает излишек.")}</div>`;
    }
    h += `<div class="btnrow foot"><button data-act="dup">${$t("Дублировать")}</button><button data-act="delnode" class="danger">${$t("Удалить узел")}</button></div>`;
    this.el.innerHTML = h;
  }

  tierOptions(n, r, mp) {
    const rt = recipeTier(r);
    const cur = mp?.tier ?? rt;
    let o = '';
    for (let t = n.multi ? 0 : rt; t < TIERS.length; t++) {
      const x = machineParams({ ...n, tier: t, cycleOverride: undefined }, r);
      const info = x.multi?.blocked ? ' — ' + $t({ heat: 'мало нагрева', power: 'не хватает EU', voltage: 'низкое напряжение' }[x.multi.blocked])
        : x.ticks != null ? ` — ${num(x.ticks / 20, 2)} ${$t("с,")} ${x.eut != null ? num(x.eut) + ' EU/t' : '— EU/t'}${x.parallel > 1 ? ' ×' + x.parallel : ''}` : '';
      o += `<option value="${t}" ${t === cur ? 'selected' : ''}>${TIERS[t]}${info}${!n.multi && t > rt && x.ticks === 1 && (r.gt?.durationTicks || 0) / 2 ** x.ocs < 1 ? $t(' (упор в 1 тик)') : ''}</option>`;
    }
    return o;
  }

  /** Single block or multiblock, energy hatches, parallels, bonuses and coil heat (overclock.js). */
  multiHtml(n, r, mp) {
    const mbs = r.machine?.multiblocks || [];
    if (!mbs.length || !r.gt) return '';
    const sbs = r.machine?.singleblocks || [];
    const ebf = n.multi === EBF_ID;
    const rh = recipeHeat(r);
    const M = mp?.multi;
    let h = `<label>${$t('Машина')} <select data-f="multi">
      ${sbs.length || !n.multi ? `<option value="">${$t('одноблочная')}</option>` : ''}
      ${mbs.map(c => `<option value="${esc(c.id)}" ${n.multi === c.id ? 'selected' : ''}>${esc(nm(c))}</option>`).join('')}</select></label>`;
    if (!n.multi) return h;
    h += `<div class="grid2">
      <label title="${esc(H.hatches())}">${$t('Энергоразъёмов')} <input type="number" min="1" step="1" data-f="hatches" value="${n.hatches || 1}"></label>
      <label title="${esc(H.parallel())}">${$t('Параллелей')} <input type="number" min="1" step="1" data-f="parallel" value="${ebf ? 1 : n.parallel || 1}" ${ebf ? 'disabled' : ''}></label>
      <label>${$t('Быстрее на, %')} <input type="number" min="0" step="any" data-f="speedPct" value="${ebf ? 0 : n.speedPct || 0}" ${ebf ? 'disabled' : ''}></label>
      <label>${$t('EU/t от обычного, %')} <input type="number" min="1" step="any" data-f="euPct" value="${ebf ? 100 : n.euPct || 100}" ${ebf ? 'disabled' : ''}></label>
    </div>`;
    if (rh != null) {
      h += ebf
        ? `<label>${$t('Катушки')} <select data-f="coil"><option value="">—</option>${COILS.map(c => `<option value="${c.i}" ${+n.coil === c.i && n.coil != null ? 'selected' : ''}>${esc(nm(c.item))} — ${c.heat} K</option>`).join('')}</select></label>`
        : `<label title="${esc(H.heat())}">${$t('Нагрев машины, K')} <input type="number" min="0" step="1" data-f="heat" value="${n.heat || ''}" placeholder="${$t('из подсказки или сканера')}"></label>`;
    }
    h += `<div class="note small">${ebf ? $t('Электрическая доменная печь: параллелей 1, без бонусов скорости и EU (так в исходниках GT). Нагрев = катушки + 100 K за каждый уровень напряжения выше MV (сумма напряжений разъёмов).') + ' '
      : $t('Параллели и бонусы возьмите из подсказки этого мультиблока в игре — у каждого они свои, планировщик их не угадывает.') + ' '}${$t('Разъёмы — обычные энергоразъёмы (2 A); один разъём даёт разгон как 1 A, два и больше — сумму ампер. Многоамперные и лазерные разъёмы не учитываются.')}</div>`;
    if (M) {
      const rows = [];
      if (M.recipeHeat != null) rows.push([$t('Нагрев'), M.machineHeat != null ? `${num(M.machineHeat)} K ${$t('из нужных')} ${num(M.recipeHeat)} K${M.heatOcs ? ` · ${$t('идеальных разгонов от нагрева')}: ${M.heatOcs}` : ''}${M.discount < 1 ? ` · EU ×${num(M.discount, 3)}` : ''}` : `<span class="warnc">${$t('не задан')}</span>`]);
      rows.push([$t('Энергия разъёмов'), `${num(M.avail)} EU/t (${M.A} A × ${num(TIER_V[mp.tier])} V)`]);
      if (!M.blocked) rows.push([$t('Параллелей в работе'), `${M.parallel}${M.parallel > (ebf ? 1 : n.parallel || 1) ? ' ' + $t('(сверх 1 тика разгон даёт параллели)') : ''}`]);
      else rows.push([$t('Состояние'), `<b class="bad">${$t({ heat: 'не хватает нагрева', power: 'не хватает энергии разъёмов', voltage: 'напряжение разъёмов слишком низкое' }[M.blocked])}</b>`]);
      h += `<table class="kv">${rows.map(([a, b]) => `<tr><th>${a}</th><td>${b}</td></tr>`).join('')}</table>`;
    }
    return h;
  }

  /** Whole-line balance per resource (total demand at full capacity vs. what is made / brought in). */
  balanceHtml(limit = 14, R = this.app.results) {
    const p = this.app.project;
    const list = (R?.balance || []).filter(b => b.needFull > 0 || b.made > 0 || b.external > 0);
    if (!list.length) return '';
    const ds = this.app.iconDataset();
    const k = b => b.res?.kind;
    const rows = list.slice(0, limit).map(b => {
      const can = b.makeMax + b.external, now = b.made + b.external;
      const short = b.needFull - can;
      const st = b.needFull > 0 && short > 1e-9 * Math.max(1, b.needFull) ? 'bad' : 'good';
      return `<tr data-hlres="${esc(b.res?.id || '')}" class="${this.app.resHighlight && this.app.resHighlight === b.res?.id ? 'hl' : ''}"><td>${iconHtml(b.res, ds, 'small')}</td><td class="bname" title="${esc(nm(b.res) + '\n' + (b.res?.id || ''))}">${esc(nm(b.res))}</td>
        <td class="num">${b.needFull > 0 ? rate(b.needFull, k(b)) : '—'}</td>
        <td class="num">${can > 0 ? rate(can, k(b)) : '—'}${b.external > 0 ? `<br><small>${b.makeMax > 0 ? rate(b.external, k(b)) + ' ' : ''}${$t("из источника")}</small>` : ''}</td>
        <td class="num">${rate(now, k(b))}<br><small>${rate(b.used, k(b))} ${$t("расход")}</small></td>
        <td class="num ${st}">${b.needFull > 0 ? (short > 1e-9 * Math.max(1, b.needFull) ? '−' + rate(short, k(b)) : $t('хватает')) : $t('выход')}</td></tr>`;
    }).join('');
    const offNote = !energyOn(p) && p.nodes.some(n => n.type === 'generator') ? `<div class="note small">${$t("Учёт энергии выключен — топливо генераторов в балансе не учитывается.")}</div>` : '';
    return `<h4>${$t("Баланс линии")}</h4>
      <div class="note small"><b>${$t("Нужно всего")}</b> ${$t("— сколько ресурса заберут все машины и генераторы линии на полной мощности.")} <b>${$t("Макс.")}</b> ${$t("— сколько линия может дать: производство всех машин на полной мощности + источники.")} <b>${$t("Сейчас")}</b> ${$t("— фактически производится и расходуется.")} <b>${$t("Итог")}</b> ${$t("— хватит ли ресурса на полной мощности.")}</div>
      <div class="note small">${$t("Щелчок по строке — обвести на схеме узлы с этим ресурсом.")}</div>
      <table class="io bal"><tr><th></th><th>${$t("Ресурс")}</th><th>${$t("Нужно всего")}</th><th>${$t("Макс.")}</th><th>${$t("Сейчас")}</th><th>${$t("Итог")}</th></tr>${rows}</table>
      ${list.length > limit ? `<div class="btnrow"><button data-act="machines">${$t("Весь баланс (")}${list.length}) ☰</button></div>` : ''}${offNote}`;
  }

  energySummary() {
    const { project: p, results: R } = this.app;
    const on = energyOn(p), E = R?.energy;
    let h = `<h4>${$t("Энергия")}</h4>
      <label class="chk"><input type="checkbox" data-f="energyOn" ${on ? 'checked' : ''}> ${$t("учитывать энергию (генераторы, кабели, потери)")}</label>`;
    const EN = R?.energyNeed;
    const needRow = `<tr><th>${$t("Нужно машинам (полная)")}</th><td><b>${num(EN?.full || 0)} EU/t</b></td></tr><tr><th>${$t("Потребляют сейчас")}</th><td>${num(EN?.actual || 0)} EU/t</td></tr>`;
    if (!on) return h + `<table class="kv">${needRow}${EN?.capacity ? `<tr><th>${$t("Генераторы, максимум")}</th><td>${num(EN.capacity)} EU/t</td></tr>` : ''}</table><div class="note small">${$t("Выключено: машины работают без учёта питания, генераторы и связи ⚡ не влияют на расчёт (но сохраняются в схеме).")}</div>`;
    h += `<table class="kv">${needRow}
      <tr><th>${$t("Генераторы, максимум")}</th><td>${num(E?.capacity || 0)} EU/t</td></tr>
      <tr><th>${$t("Генераторы выдают")}</th><td>${num(E?.generated || 0)} EU/t</td></tr>
      <tr><th>${$t("Получают машины")}</th><td>${num(E?.delivered || 0)} EU/t</td></tr>
      <tr><th>${$t("Потери в кабелях")}</th><td class="${E?.losses > 0 ? 'warnc' : ''}">${num(E?.losses || 0)} EU/t</td></tr>
      ${E?.unpowered ? `<tr><th>${$t("Без питания")}</th><td class="warnc">${num(E.unpowered)} ${$t("EU/t не учтены")}</td></tr>` : ''}
    </table><div class="btnrow"><button data-act="machines">${$t("☰ Список машин")}</button><button data-act="addgen">${$t("+ Генератор")}</button></div>`;
    return h;
  }

  needEnergy() {
    if (this.app.energyData) return this.app.energyData;
    this.app.loadEnergy().then(() => this.render()).catch(e => this.app.toast(e.message, 'error'));
    return null;
  }

  fuels(map) {
    this.fuelCache ??= {};
    if (!map) return [];
    if (this.fuelCache[map]) return this.fuelCache[map];
    this.fuelCache[map] = null;
    api.fuels(map).then(r => { this.fuelCache[map] = r.fuels; this.render(); }).catch(e => this.app.toast(e.message, 'error'));
    return null;
  }

  generatorView(n, s) {
    const p = this.app.project, E = this.needEnergy();
    if (!E) return `<div class="note">${$t("Загрузка списка генераторов и кабелей…")}</div>`;
    const on = energyOn(p), ds = this.app.iconDataset();
    const gen = n.gen ? E.generators.find(g => g.id === n.gen.id) : null;
    const byTier = new Map();
    for (const g of E.generators) { const t = g.tier || g.voltage + $t(' В'); if (!byTier.has(t)) byTier.set(t, []); byTier.get(t).push(g); }
    let h = on ? '' : `<div class="note warn">${$t("Учёт энергии выключен — генератор не влияет на расчёт. Включите «⚡ Энергия» на панели.")}</div>`;
    h += `<label>${$t("Генератор")} <select data-f="genpick"><option value="">${$t("свой (параметры вручную)")}</option>${[...byTier].map(([t, list]) => `<optgroup label="${esc(t)}">${list.map(g => `<option value="${esc(g.id)}" ${g.id === n.gen?.id ? 'selected' : ''}>${esc(nm(g))}${g.efficiency != null ? ` ${$t("· КПД")} ${g.efficiency}%` : ''}</option>`).join('')}</optgroup>`).join('')}</select></label>
      ${gen ? `<details><summary>${$t("Описание предмета (из экспорта)")}</summary><pre class="tt">${esc(gen.tooltip)}</pre></details>` : ''}
      <div class="grid2">
        <label>${$t("Напряжение")} <select data-f="voltage">${GT_V.map(v => `<option value="${v}" ${+n.voltage === v ? 'selected' : ''}>${GT_T[GT_V.indexOf(v)]} — ${num(v)} ${$t("В")}</option>`).join('')}</select></label>
        <label>${$t("Ампер на выходе")} <input type="number" min="0" step="1" data-f="amps" value="${n.amps ?? 1}"></label>
        <label>${$t("Генераторов")} <input type="number" min="0" step="1" data-f="count" value="${n.count ?? 1}"></label>
        <label>${$t("КПД, %")} ${help(H.eff())} <input type="number" min="0" step="any" data-f="efficiency" value="${n.efficiency ?? ''}" placeholder="${$t("не указан — 100")}"></label>
      </div>
      <div class="note small">${$t("Мощность = напряжение × ампер × число генераторов. Одноблочные генераторы GT выдают 1 А. КПД берётся из описания предмета («Fuel Efficiency»), если он там есть.")}</div>`;
    // fuel
    const f = n.fuel;
    const mode = !f ? 'none' : f.source?.rule === 'steam' ? 'steam' : f.source?.recipeId ? 'map' : n.fuelMode === 'map' && !f.res ? 'map' : 'manual';
    const curMode = n.fuelMode || mode;
    h += `<h4>${$t("Топливо")}</h4><label>${$t("Источник топлива")} <select data-f="fuelmode">
        <option value="none" ${curMode === 'none' ? 'selected' : ''}>${$t("без топлива (энергия из внешней сети)")}</option>
        <option value="map" ${curMode === 'map' ? 'selected' : ''}>${$t("рецепт топлива из каталога")}</option>
        ${gen?.steam ? `<option value="steam" ${curMode === 'steam' ? 'selected' : ''}>${$t("пар (по описанию турбины)")}</option>` : ''}
        <option value="manual" ${curMode === 'manual' ? 'selected' : ''}>${$t("вручную")}</option></select></label>`;
    if (curMode === 'map') {
      const maps = gen?.fuelMaps?.length ? E.fuelMaps.filter(m => gen.fuelMaps.includes(m.name)) : E.fuelMaps;
      const map = n.fuelMapSel || f?.source?.map || maps[0]?.name;
      const list = this.fuels(map);
      h += `<label>${$t("Карта топлива")} <select data-f="fuelmap">${maps.map(m => `<option value="${esc(m.name)}" ${m.name === map ? 'selected' : ''}>${esc(mname(m))} (${m.recipes})</option>`).join('')}</select></label>
        <label>${$t("Топливо")} ${list == null ? `<small>${$t("загрузка…")}</small>` : `<select data-f="fuelpick"><option value="">${$t("— выберите —")}</option>${list.map(o => `<option value="${esc(o.recipeId)}" ${o.recipeId === f?.source?.recipeId ? 'selected' : ''}>${esc(nm(o.res))} — ${num(o.fuelValue)}${o.rule === 'item' ? ' (fuel_value)' : ' EU/L'}</option>`).join('')}</select>`}</label>`;
    }
    if (curMode === 'manual') {
      h += `<label>${$t("Ресурс-топливо")} <input data-gsearch placeholder="${$t("поиск предмета или жидкости…")}" autocomplete="off"></label><div class="ghits list"></div>`;
    }
    if (f?.res) {
      const unit = f.res.kind === 'fluid' ? 'L' : $t('шт');
      const rule = { fluid: $t('fuel_value из рецепта = EU за 1 L (правило GT для жидкого топлива); итог умножается на КПД генератора.'),
        cell: `${$t("В рецепте — капсула (")}${num(f.source?.cellAmount || 1000)} ${$t("L); генератор расходует жидкость, fuel_value = EU за 1 L, итог × КПД.")}`,
        item: $t('Для твёрдого топлива смысл fuel_value зависит от генератора — укажите EU за 1 шт. вручную (видно в NEI / описании).'),
        steam: `${$t("Из описания турбины: до")} ${num(f.source?.perSecond)} ${$t("L/с пара при")} ${num(f.source?.voltage)} ${$t("В →")} ${num(f.euPerUnit, 4)} ${$t("EU за 1 L (КПД уже учтён).")}`,
        manual: $t('Задано вручную.') }[f.source?.rule || 'manual'];
      h += `<div class="resline">${iconHtml(f.res, ds, 'small')} <b>${esc(nm(f.res))}</b><br><small>${esc(f.res.id)}</small></div>
        <label>${$t("EU за 1")} ${unit} <input type="number" min="0" step="any" data-f="euPerUnit" value="${f.euPerUnit ?? ''}" placeholder="${$t("не задано")}"></label>
        <div class="note small">${esc(rule)}${f.source?.override ? $t(' Значение изменено вручную.') : ''}</div>`;
    }
    if (s && on) {
      const fx = s.inputs.f, k = f?.res?.kind;
      h += `<h4>${$t("Работа")}</h4><table class="kv">
        <tr><th>${$t("Максимум")}</th><td>${num(s.capacity)} EU/t</td></tr>
        <tr><th>${$t("Запрошено машинами")}</th><td class="${s.request > s.capacity * (1 + 1e-9) ? 'bad' : ''}">${num(s.request)} EU/t <small>${$t("(с учётом потерь)")}</small></td></tr>
        <tr><th>${$t("Выдаёт")}</th><td><b>${num(s.output)} EU/t</b>${s.util != null ? ` ${$t("· нагрузка")} ${num(s.util * 100, 1)}%` : ''}</td></tr>
        ${f?.res ? `<tr><th>${$t("Топливо нужно")}</th><td>${s.params.euEff ? rate(s.fuelFull, k) : $t('— (нет EU за единицу)')}</td></tr>
        <tr><th>${$t("Подаётся")}</th><td class="${fx && fx.supplied < fx.need * (1 - 1e-7) ? 'bad' : ''}">${fx ? (fx.connected ? rate(fx.supplied, k) : $t('не подключено')) : '—'}</td></tr>
        <tr><th>${$t("Расходуется")}</th><td>${rate(s.fuelUsed, k)}</td></tr>` : ''}
      </table>`;
    }
    h += this.outputsTable(n, s);
    return h;
  }

  energyEdgeView(e) {
    const { project: p, results: R } = this.app;
    const E = this.needEnergy();
    const s = R?.edges[e.id];
    const g = findNode(p, e.from.node);
    let h = `<h3 class="t-energy"><span class="hico">⚡</span>${$t("Связь питания ⚡")}</h3><div class="route">${this.link(e.from.node)} → ${this.link(e.to.node)}</div>`;
    if (!energyOn(p)) h += `<div class="note warn">${$t("Учёт энергии выключен — связь не участвует в расчёте.")}</div>`;
    if (!E) return this.el.innerHTML = h + `<div class="note">${$t("Загрузка списка кабелей…")}</div>`;
    const V = +g?.voltage || 0;
    const byTier = new Map();
    for (const c of E.cables) { if (!byTier.has(c.tier)) byTier.set(c.tier, []); byTier.get(c.tier).push(c); }
    h += `<label>${$t("Кабель")} <select data-f="cable"><option value="">${$t("без кабеля / вплотную (без потерь)")}</option>${[...byTier].map(([t, list]) => `<optgroup label="${esc(t)} ${$t("— до")} ${num(list[0].voltage)} ${$t("В")}">${list.map(c => `<option value="${esc(c.id)}" ${c.id === e.cable?.id ? 'selected' : ''}>${esc(nm(c))} — ${num(c.amps)} ${$t("А, потери")} ${num(c.loss)} ${$t("EU/блок")}${c.voltage < V ? $t(' ⚠ мало для ') + num(V) + $t(' В') : ''}</option>`).join('')}</optgroup>`).join('')}</select></label>
      <label>${$t("Длина: блоков кабеля между генератором и машиной")} <input type="number" min="0" step="1" data-f="length" value="${e.length ?? 0}" ${e.cable ? '' : 'disabled'}></label>
      <div class="note small">${$t("0 — генератор стоит вплотную к машине. Каждый ампер теряет «потери на блок» × длину EU; голый провод теряет больше изолированного кабеля, сверхпроводники — 0. Данные кабелей прочитаны из")} ${esc(E.cableSource?.jar || 'gregtech jar')} (SHA-256 ${esc((E.cableSource?.jarSha256 || '').slice(0, 12))}…).</div>`;
    if (s && s.V != null) {
      const pct = s.draw > 0 ? ` (${num(s.loss / s.draw * 100, 1)}%)` : '';
      h += `<table class="kv big">
        <tr><th>${$t("Напряжение генератора")}</th><td>${num(s.V)} ${$t("В")} ${vName(s.V)}</td></tr>
        <tr><th>${$t("Напряжение у машины")}</th><td class="${s.drop > 0 ? 'warnc' : ''}">${num(s.Vd)} ${$t("В")}${s.drop > 0 ? ` (−${num(s.drop)})` : ''}</td></tr>
        <tr><th>${$t("Нужно машине")} <small>${$t("(полная мощность)")}</small></th><td>${num(s.demand)} EU/t</td></tr>
        <tr><th>${$t("Доставляется")}</th><td class="${s.deficit ? 'bad' : 'good'}">${num(s.offered)} EU/t${s.deficit ? ` (−${num(s.deficit)})` : ''}</td></tr>
        <tr><th>${$t("Фактически потребляет")}</th><td>${num(s.flow)} EU/t</td></tr>
        <tr><th>${$t("Генератор отправляет")}</th><td>${num(s.draw)} EU/t</td></tr>
        <tr><th>${$t("Потери в кабеле")} ${help(H.loss())}</th><td class="${s.loss > 0 ? 'warnc' : 'good'}">${num(s.loss)} EU/t${pct}</td></tr>
        <tr><th>${$t("Ток (полная / факт.)")} ${help(H.amps())}</th><td>${num(s.ampsPeak, 3)} / ${num(s.ampsActual, 3)} ${$t("А")}${e.cable ? ` ${$t("· кабель держит")} ${num(e.cable.amps)} ${$t("А")}` : ''}</td></tr>
      </table>
      ${s.warnings?.length ? `<ul class="problems">${s.warnings.map(w => `<li class="energy">${esc(w.text)}</li>`).join('')}</ul>` : ''}`;
      if (s.status === 'deficit' && s.affected?.length) h += `<h4 class="bad">${$t("Не хватает энергии")}</h4><ul class="affected">${s.affected.map(a => `<li>${this.link(a.node)} ${a.util != null ? `${$t("— загрузка")} ${num(a.util * 100, 1)}%` : ''}</li>`).join('')}</ul>`;
    }
    h += `<div class="btnrow"><button data-act="deledge" class="danger">${$t("Удалить связь")}</button></div>`;
    this.el.innerHTML = h;
  }

  loopsHtml() {
    const { project: p, results: R } = this.app;
    const loops = R?.loops || [];
    const mode = p.loopMode || 'primed';
    let h = `<h4>${$t("Циклы (")}${loops.length})</h4>
      <label>${$t("Расчёт циклов")} <select data-f="loopMode">
        <option value="primed" ${mode === 'primed' ? 'selected' : ''}>${$t("установившийся режим (цикл заполнен)")}</option>
        <option value="cold" ${mode === 'cold' ? 'selected' : ''}>${$t("пуск с нуля (без начального запаса)")}</option></select></label>`;
    if (!loops.length) return h + `<div class="note small">${$t("Замкнутых контуров нет.")}</div>`;
    for (const L of loops) {
      const list = arr => arr.map(x => `${iconHtml(x.res, this.app.iconDataset(), 'small')} ${esc(nm(x.res))} <b>${rate(x.rate, x.res?.kind)}</b>${x.connected === false ? ` <small class="warnc">${$t("не подключён")}</small>` : ''}`).join('<br>') || '—';
      h += `<div class="loopbox"><div><span class="badge loop">↻ ${L.index}</span> ${L.nodes.map(id => this.link(id)).join(' → ')}</div>
        <table class="kv">
          ${L.leaks?.length ? `<tr><th>${$t("Почему стоит")}</th><td>${L.leaks.slice(0, 3).map(c => `<span class="bad">${$t("возвращается")} ${num(c.gain * 100, 1)}%</span>: ${c.path.map(r => esc(nm(r))).join(' → ')}`).join('<br>')}<br><small>${$t("Каждый проход по такому контуру возвращает меньше, чем забирает, поэтому цикл угасает до нуля. Подайте один из этих ресурсов извне (источник + слияние).")}</small></td></tr>` : ''}
          <tr><th>${$t("Циркулирует")}</th><td>${L.leaks?.length ? L.circulating.map(c => `${iconHtml(c.res, this.app.iconDataset(), 'small')} ${esc(nm(c.res))}`).join('<br>') : L.circulating.map(c => `${iconHtml(c.res, this.app.iconDataset(), 'small')} ${esc(nm(c.res))} ${rate(c.consumed, c.res?.kind)} — ${c.makeup > 0 ? `<span class="bad">${$t("не хватает")} ${rate(c.makeup, c.res?.kind)}</span>` : c.coveredByInput ? `<span class="warnc">${$t("возврат неполный, покрыт подачей")}</span>` : `<span class="good">${$t("возвращается полностью")}</span>`}`).join('<br>')}</td></tr>
          <tr><th>${$t("Входит в цикл")}</th><td>${list(L.inputs)}</td></tr>
          <tr><th>${$t("Выходит из цикла")}</th><td>${list(L.outputs)}</td></tr>
          <tr><th>${$t("Запуск")}</th><td>${L.needsPriming ? `<span class="warnc">${$t("нужен начальный запас")}</span><br><small>${$t("загрузите вручную любой из циркулирующих ресурсов, минимум ≈ на один цикл машины:")} ${L.circulating.map(c => num(c.perCycleStock) + (c.res?.kind === 'fluid' ? ' L ' : ' ') + esc(nm(c.res))).join($t(' или '))}</small>` : L.running ? `<span class="good">${$t("запускается сам")}</span>` : L.leaks?.length ? `<span class="bad">${$t("угасает до нуля")}</span>` : $t('не работает')}</td></tr>
        </table></div>`;
    }
    return h + `<div class="note small">${$t("«Установившийся режим» считает цикл уже заполненным: так он работает в игре после первой загрузки. «Пуск с нуля» показывает, что будет без начального запаса.")}</div>`;
  }

  downDemand(n) {
    const { project: p, results: R } = this.app;
    return p.edges.filter(e => e.from.node === n.id).reduce((s, e) => s + (R?.edges[e.id]?.demand || 0), 0);
  }

  machineView(n, s) {
    const p = this.app.project, r = recipeOf(p, n);
    const ds = this.app.iconDataset(r);
    if (!r) return `<div class="note warn">${$t("Снимок рецепта отсутствует.")}</div>`;
    if (isFuelRecipe(r)) return `<div class="note warn"><b>${$t("Это рецепт топлива")}</b> («${esc(mname(r.machine))}${$t("»), а не машина: у него нет длительности и EU/t, поэтому как машина он ничего не делает. Топливо сжигает генератор.")}</div>
      <div class="btnrow"><button data-act="togen">${$t("Превратить в генератор с этим топливом")}</button></div>`;
    const mp = s?.params;
    const gt = r.gt;
    const snap = r.snapshot || {};
    const crafters = [...(r.machine?.singleblocks || []), ...(r.machine?.multiblocks || [])];
    let h = `<div class="resline"><b>${esc(mname(r.machine))}</b> ${r.dataset === 'custom' ? `<span class="badge custom">${$t("свой рецепт")}</span>` : ''}<br>
      <small title="${$t("Стабильный ID")}">${esc(r.id)}</small><br>
      <small>${$t("снимок:")} ${esc(snap.datasetLabel || snap.dataset || r.dataset)}, ${esc((snap.takenAt || '').slice(0, 10))}</small>
      ${r.source ? `<br><small>${$t("источник:")} ${esc(r.source.type === 'copy' ? `${$t("копия")} ${r.source.recipeId} ${$t("из")} ${r.source.dataset}` : r.source.type)}${r.targetPackVersion ? $t(' · для ') + esc(r.targetPackVersion) : ''}</small>` : ''}</div>
      <h4 data-k="m-setup">${$t("Настройка")}</h4>
      <div class="grid2">
        <label>${$t("Машин")} <input type="number" min="0" step="1" data-f="count" value="${n.count}"></label>
        <label>${n.multi ? $t('Уровень разъёмов') : $t("Уровень машины")} <select data-f="tier">${this.tierOptions(n, r, mp)}</select></label>
      </div>
      ${this.multiHtml(n, r, mp)}
      <label class="chk"><input type="checkbox" data-f="perfectOc" ${n.perfectOc ? 'checked' : ''} ${n.multi === EBF_ID ? 'disabled' : ''}> ${$t("идеальный разгон (÷4 длительность за уровень)")}</label>
      <div class="note small">${n.multi ? $t('Разгон мультиблока по правилам GT 5.09.51: по мощности разъёмов (EU/t × параллели), длительность ÷2 (÷4 идеальный), EU/t ×4; разгон сверх 1 тика превращается в параллели.') : $t("Разгон GT: каждый уровень выше уровня рецепта (") + esc(TIERS[recipeTier(r)]) + $t(") — длительность ÷2, EU/t ×4, не короче 1 тика. Идеальный разгон есть только у некоторых мультиблоков. Для мультиблоков выберите его в поле «Машина».")}</div>
      <label>${$t("Циклов/мин на машину (вручную)")} <input type="number" min="0" step="any" data-f="cycleOverride" value="${n.cycleOverride || ''}" placeholder="${mp?.ticks ? num(1200 / mp.ticks) + $t(' (из рецепта)') : $t('нет длительности в рецепте')}"></label>
      <h4 data-k="m-work">${$t("Работа")}</h4>
      <table class="kv">
        <tr><th>${$t("Длительность")}</th><td>${gt?.durationTicks != null ? `${gt.durationTicks} t (${seconds(gt.durationTicks)})${mp?.ocs ? ` → ${mp.ticks} t (${seconds(mp.ticks)})` : ''}` : '—'}</td></tr>
        <tr><th>EU/t ${help(H.eut() + ' ' + H.oc())}</th><td>${gt?.eut != null ? num(gt.eut) + (mp?.ocs ? ` → ${num(mp.eut)}` : '') + (gt.voltage != null ? ` <small>(${num(gt.voltage)} V × ${gt.amperage} A)</small>` : '') : '—'}</td></tr>
        <tr><th>${$t("Уровень")}</th><td>${$t("рецепт")} ${esc(gt?.tierName || TIERS[recipeTier(r)])} ${n.multi ? $t('· разъёмы') : $t("· машина")} <b>${esc(TIERS[mp?.tier ?? recipeTier(r)])}</b>${mp?.ocs ? ` ${$t("(разгонов:")} ${mp.ocs})` : ''}${mp?.parallel > 1 ? ` · ${$t('параллелей')} ${mp.parallel}` : ''}</td></tr>
        ${s?.loop ? `<tr><th>${$t("Цикл")}</th><td><span class="badge loop">${$t("↻ цикл")} ${s.loop}</span></td></tr>` : ''}
        ${gt?.specialValue ? `<tr><th>specialValue</th><td>${num(gt.specialValue)}</td></tr>` : ''}
        ${(gt?.metadata || []).map(m => `<tr><th>${esc(m.key)}</th><td>${num(m.value)}</td></tr>`).join('')}
        <tr><th>${$t("Циклов")}</th><td>${mp?.cycles != null ? `${num(rateVal(mp.cycles))}${unitLabel()} ${$t("(все машины)")}` : '—'}</td></tr>
        <tr><th>${$t("Загрузка")} ${help(H.util())}</th><td>${s?.util != null ? `<b class="${s.util < 1 - 1e-7 ? 'bad' : 'good'}">${num(s.util * 100, 1)}%</b>${s.limitedBy ? $t(' — ограничивает «') + esc(s.limitedBy === 'ep' ? $t('энергия (EU)') : nm(ports(p, n).find(x => x.id === s.limitedBy)?.res)) + '»' : ''}` : '—'}</td></tr>
        <tr><th>${$t("Энергия")}</th><td>${s?.powerFull != null ? `${num(s.powerFull)} ${$t("EU/t полная ·")} ${num(s.powerAvg)} ${$t("EU/t факт.")}` : '—'}${s?.inputs?.ep ? `<br><small>${s.inputs.ep.connected ? `${$t("доставляется")} ${num(s.inputs.ep.supplied)} EU/t` : `<span class="warnc">${$t("питание не подключено")}</span>`}</small>` : ''}</td></tr>
        ${s?.limitedBy ? `<tr><th>${$t("Почему")}</th><td><small>${esc(whyLimited(p, this.app.results, n.id) || '')}</small></td></tr>` : ''}
      </table>${this.countHints(n)}`;
    // ore dictionary choices
    r.inputs.forEach((e, i) => {
      if (e.kind !== 'oredict') return;
      const cur = resolveInput(n, e, i).id;
      h += `<label>${$t("Словарь руд")} <code>${esc(e.id)}</code> ${$t("— вариант")}
        <select data-ore="${i}">${(e.variants || []).map(v => `<option value="${esc(v.id)}" ${v.id === cur ? 'selected' : ''}>${esc(nm(v))} — ${esc(v.id)}</option>`).join('')}</select></label>`;
    });
    h += this.targetHtml(n, r, s, ds);
    h += `<h4>${$t("Входы")}</h4><table class="io"><tr><th></th><th>${$t("за цикл")}</th><th>${$t("нужно")}</th><th>${$t("подано")}</th></tr>`;
    r.inputs.forEach((e, i) => {
      const x = s?.inputs['i' + i];
      const disp = resolveInput(n, e, i);
      const bad = x && x.need > 0 && x.supplied < x.need * (1 - 1e-7);
      h += `<tr class="${bad ? 'bad' : ''}"><td>${iconHtml(disp, ds, 'small')} ${esc(nm(disp))}</td><td>${num(e.amount)}${e.kind === 'fluid' ? ' L' : ''}</td>
        <td>${e.consumed === false ? $t('не расх.') : x ? rate(x.need, e.kind) : '—'}</td><td>${e.consumed === false ? '' : x ? (x.connected ? rate(x.supplied, e.kind) : $t('не подкл.')) : '—'}</td></tr>`;
    });
    h += `</table><h4>${$t("Выходы")}</h4><table class="io"><tr><th></th><th>${$t("за цикл")}</th><th>${$t("макс")}</th><th>${$t("факт.")}</th></tr>`;
    r.outputs.forEach((e, i) => {
      const x = s?.outputs['o' + i];
      h += `<tr class="${x && !x.connected ? 'warn' : ''}"><td>${iconHtml(e, ds, 'small')} ${esc(nm(e))}${e.probability < 1 ? ` <small>${num(e.probability * 100, 2)}%</small>` : ''}</td><td>${num(e.amount)}${e.kind === 'fluid' ? ' L' : ''}</td>
        <td>${x ? rate(x.max, e.kind) : '—'}</td><td>${x ? rate(x.actual, e.kind) + (!x.connected ? `<br><small>${$t("не подключён")}</small>` : x.unrouted > 0 ? `<br><small>${$t("не распр.")} ${rate(x.unrouted, e.kind)}</small>` : '') : '—'}</td></tr>`;
    });
    h += `</table>${r.outputs.some(e => e.probability < 1) ? `<div class="note small">${$t("Для выходов с шансом показано ожидаемое среднее.")}</div>` : ''}
      ${this.armHtml(r, n, s, ds)}
      <h4 data-k="m-recipe">${$t("Рецепт")}</h4>
      ${crafters.length ? `<details><summary>${$t("Машины для этой карты (")}${crafters.length})</summary><div class="crafters">${crafters.map(c => `<div>${iconHtml(c, ds, 'small')} ${esc(nm(c))}</div>`).join('')}</div></details>` : ''}
      <div class="btnrow"><button data-act="compare">${$t("Сравнить с каталогом")}</button><button data-act="tocustom">${$t("Копировать в свои")}</button></div>
      <div class="cmp"></div>`;
    return h;
  }

  /** "Make X per minute here" → plan the whole line (target.js). Top level only. */
  targetHtml(n, r, s, ds) {
    if (this.app.path.length || !r.outputs.length || !s?.params?.perMachine) return '';
    const T = this.app.root.target?.node === n.id ? this.app.root.target : null;
    const port = T?.port || 'o0';
    const i = +port.slice(1);
    const cur = s?.outputs?.[port]?.actual || 0;
    const v = T ? T.rate : cur;
    return `<h4 data-k="m-target">🎯 ${$t('Цель выпуска')} ${help(H.target())}</h4>
      <div class="grid2">
        <label>${$t('Продукт')} <select data-tg="port">${r.outputs.map((e, k) => `<option value="o${k}" ${port === 'o' + k ? 'selected' : ''}>${esc(nm(e))}</option>`).join('')}</select></label>
        <label>${$t('Нужно')} <span class="inl"><input type="number" min="0" step="any" data-tg="rate" value="${+rateVal(v).toFixed(4)}"> ${r.outputs[i]?.kind === 'fluid' ? 'L' : $t('шт')}${unitLabel()}</span></label>
      </div>
      <div class="btnrow"><button data-act="plan" class="primary">${$t('Рассчитать линию под цель')}</button>${T ? `<button data-act="untarget">${$t('Снять цель')}</button>` : ''}</div>
      ${T ? `<div class="note small">${$t('Сейчас')}: <b>${rate(cur, r.outputs[i]?.kind)}</b> ${$t('из')} ${rate(T.rate, r.outputs[i]?.kind)}</div>` : ''}`;
  }

  /** Robot arm slot numbers of the machine block at this node's tier (see slots.js). */
  armHtml(r, n, s, ds) {
    const A = armSlots(r, n, s?.params);
    if (!A) return '';
    const head = A.block
      ? `<div class="resline">${A.block.item ? iconHtml(A.block.item, ds, 'small') + ' ' : ''}<b>${esc(nm(A.block.item) || A.block.name)}</b> · ${esc(A.tier)}<br><small>${$t('входных слотов')}: ${A.block.inputs} · ${$t('выходных')}: ${A.block.outputs}</small></div>`
      : `<div class="note small warn">${A.reason === 'notier' ? $t('Для уровня') + ' ' + esc(A.tier) + ' ' + $t('нет одноблочной машины с этим рецептом — номера выходов неизвестны.') : $t('На этом уровне несколько машин с разным числом слотов — номера выходов неизвестны.')}</div>`;
    const row = (e, v, dir, note) => `<tr><td>${iconHtml(e, ds, 'small')}</td><td class="bname">${esc(nm(e))}${note ? `<br><small>${note}</small>` : ''}</td><td>${dir}</td><td class="num">${v != null ? `<span class="aslot">${v}</span>` : '—'}</td></tr>`;
    const rows = [
      ...r.inputs.map((e, i) => e.kind === 'fluid' ? '' : i === A.circuit ? row(e, null, $t('схема'), $t('ставится в окне машины, роборука её не вставляет')) : row(e, A.inputs[i], $t('вход'))),
      ...r.outputs.map((e, i) => e.kind === 'fluid' ? '' : row(e, A.outputs[i], $t('выход'))),
    ].join('');
    return `<h4 data-k="m-arm">${$t('Роборука: номера слотов')} ${help(H.arm())}</h4>${head}<table class="io bal">${rows}</table>
      <div class="note small">${$t('Входы GT принимают предмет в любой входной слот, номера входов — раскладка по порядку рецепта. Выход рецепта попадает в свой слот, а если он занят — в следующий. Жидкости роборука не переносит.')}</div>`;
  }

  /** "Set to N machines" suggestions: to cover the demand downstream, or to match the supply. */
  countHints(n) {
    const p = this.app.project, R = this.app.results;
    const up = machinesForDemand(p, R, n), down = machinesForSupply(R, n);
    const b = (count, text) => { this.fixes.push({ label: text, edit: q => { const x = q.nodes.find(y => y.id === n.id); x.count = count; } }); return `<button class="fix" data-fix="${this.fixes.length - 1}">${esc(text)}</button>`; };
    let h = '';
    if (up) h += `<div class="note small">${$t("Дальше по линии просят больше, чем дают эти машины.")} ${b(up.count, `${$t('Машин')}: ${n.count} → ${up.count}`)}</div>`;
    if (down) h += `<div class="note small">${$t("Подачи хватает только на")} ${down} ${$t("из")} ${n.count}${$t(" — остальные простаивают.")} ${b(down, `${$t('Машин')}: ${n.count} → ${down}`)}</div>`;
    return h;
  }

  outputsTable(n, s) {
    const p = this.app.project;
    const outs = p.edges.filter(e => e.from.node === n.id);
    if (!outs.length) return '';
    return `<h4>${$t("Исходящие связи")}</h4><table class="io"><tr><th>${$t("куда")}</th><th>${$t("правило")}</th><th>${$t("поток")}</th></tr>${outs.map(e => {
      const x = this.app.results?.edges[e.id];
      return `<tr><td><a href="#" data-sel-edge="${e.id}">${esc(this.nodeName(e.to.node))}</a></td><td>${e.share != null && e.share !== '' ? num(+e.share) + '%' : $t('авто')}</td><td>${x ? rate(x.offered, x.resource?.kind) : '—'}</td></tr>`;
    }).join('')}</table>`;
  }

  edgeView(e) {
    const { project: p, results: R } = this.app;
    const s = R?.edges[e.id];
    const res = s?.resource;
    const k = res?.kind;
    const siblings = p.edges.filter(x => x.from.node === e.from.node && x.from.port === e.from.port);
    const fixedSum = siblings.reduce((a, x) => a + (x.share != null && x.share !== '' ? +x.share : 0), 0);
    let h = `<h3><span class="hico">⟶</span>${$t("Связь")}</h3>
      <div class="resline">${iconHtml(res, this.app.iconDataset(), 'small')} <b>${esc(nm(res))}</b><br><small>${esc(res?.id)}</small></div>
      <div class="route">${this.link(e.from.node)} → ${this.link(e.to.node)}</div>
      <table class="kv big">
        <tr><th>${$t("Потребность (полная мощность)")}</th><td>${s ? (s.demand === Infinity ? $t('∞ (склад)') : rate(s.demand, k)) : '—'}</td></tr>
        <tr><th>${$t("Поступает")}</th><td>${s ? rate(s.offered, k) : '—'}</td></tr>
        <tr><th>${$t("Фактический поток")}</th><td>${s ? rate(s.flow, k) : '—'}</td></tr>
        <tr><th>${$t("Дефицит")} <small>${$t("(до полной мощности)")}</small></th><td class="${s?.deficit ? 'bad' : 'good'}">${s ? (s.deficit ? '−' + rate(s.deficit, k) : $t('нет')) : '—'}</td></tr>
        <tr><th>${$t("Избыток")} <small>${$t("(не потребляется)")}</small></th><td class="${s?.surplus ? 'warnc' : 'good'}">${s ? (s.surplus ? '+' + rate(s.surplus, k) : $t('нет')) : '—'}</td></tr>
      </table>
      ${s?.deficit && s?.surplus ? `<div class="note small">${$t("Потребитель ограничен другим входом, поэтому часть поступающего не используется, хотя для полной мощности ресурса всё ещё мало.")}</div>` : ''}
      ${s?.status === 'limited' ? `<div class="note small">${$t("До полной мощности этого ресурса не хватает, но узкое место — другой вход потребителя. Добавлять подачу сюда бессмысленно, пока не решён тот дефицит.")}</div>` : ''}
      ${s?.status === 'loop' ? `<div class="note small">${$t("Связь внутри цикла")} ${s.loop}${$t(": ресурс возвращается полностью, поток повторяет пропускную способность цикла. Ограничение задаёт вход извне цикла.")}</div>` : ''}
      <h4>${$t("Распределение с выхода")}</h4>
      <label>${$t("Правило для этой связи")}
        <select data-f="sharemode"><option value="auto" ${e.share == null || e.share === '' ? 'selected' : ''}>${$t("Авто — по потребности")}</option><option value="fixed" ${e.share != null && e.share !== '' ? 'selected' : ''}>${$t("Фиксированная доля, %")}</option></select></label>
      ${e.share != null && e.share !== '' ? `<label>${$t("Доля, %")} <input type="number" min="0" max="100" step="any" data-f="share" value="${e.share}"></label>` : ''}
      ${siblings.length > 1 ? `<table class="io"><tr><th>${$t("связь с того же выхода")}</th><th>${$t("правило")}</th><th>${$t("поток")}</th></tr>${siblings.map(x => {
        const sx = R?.edges[x.id];
        return `<tr class="${x.id === e.id ? 'cur' : ''}"><td><a href="#" data-sel-edge="${x.id}">${esc(this.nodeName(x.to.node))}</a></td><td>${x.share != null && x.share !== '' ? num(+x.share) + '%' : $t('авто')}</td><td>${sx ? rate(sx.offered, k) : ''}</td></tr>`;
      }).join('')}</table>
      <div class="note small">${$t("Сначала выдаются фиксированные доли (сумма")} ${num(fixedSum)}%${fixedSum > 100 ? $t(' — больше 100%, доли нормируются') : ''}${$t("), остаток делится между «авто»-связями пропорционально потребности; излишек уходит на склад, если он подключён в режиме «авто». Если «авто»-связей нет, остаток выхода остаётся нераспределённым.")}</div>` : `<div class="note small">${$t("Чтобы разделить выход (например 70% дальше, остальное на склад), протяните с того же выхода ещё одну связь и задайте долю.")}</div>`}`;
    if (s?.status === 'deficit') {
      const aff = s.affected || [];
      h += `<h4 class="bad">${$t("Затронуто дефицитом (узкое место)")}</h4>${aff.length ? `<ul class="affected">${aff.map(a => `<li>${this.link(a.node)} ${a.util != null ? `${$t("— загрузка")} ${num(a.util * 100, 1)}%` : $t('— получает меньше')}</li>`).join('')}</ul>` : `<div class="note">${$t("Потребитель не замедлен (дефицит перекрыт другими источниками).")}</div>`}
        <div class="note small">${$t("Для полной мощности нужно ещё")} ${rate(s.deficit, k)} «${esc(nm(res))}».</div>`;
    }
    h += `<div class="btnrow"><button data-act="deledge" class="danger">${$t("Удалить связь")}</button></div>`;
    this.el.innerHTML = h;
  }

  // ---------- events ----------
  onChange(ev) {
    const t = ev.target;
    if (t.dataset.tg != null) return; // target fields are read when the plan is asked for
    const app = this.app, p = app.project, sel = app.selection;
    const f = t.dataset.f;
    if (!sel && f === 'blockname') {
      app.history.push(app.root);
      const parent = resolvePath(app.root, app.path.slice(0, -1));
      const b = findNode(parent, app.path[app.path.length - 1]);
      if (b) b.label = t.value || 'Блок';
      app.changed();
      return;
    }
    if (!sel && f === 'name') { app.mutate(q => { q.name = t.value; }); return; }
    if (!sel && f === 'defaultTier') { app.mutate(q => { q.defaultTier = t.value === '' ? null : +t.value; }); return; }
    if (!sel && f === 'loopMode') { app.mutate(q => { q.loopMode = t.value; }); return; }
    if (!sel && f === 'energyOn') { app.setEnergy(t.checked); return; }
    if (sel?.type === 'node' && findNode(p, sel.id)?.type === 'generator' && this.generatorChange(t, f, sel.id)) return;
    if (sel?.type === 'node') {
      if (t.dataset.ore != null) {
        const i = +t.dataset.ore, id = sel.id;
        const conn = p.edges.some(e => e.to.node === id && e.to.port === 'i' + i);
        if (conn && !confirm($t('К этому входу уже подключены связи с другим вариантом. Удалить их и сменить вариант?'))) { this.render(); return; }
        app.mutate(q => {
          if (conn) q.edges = q.edges.filter(e => !(e.to.node === id && e.to.port === 'i' + i));
          const n = findNode(q, id); n.oreChoice = { ...(n.oreChoice || {}), [i]: t.value };
        });
        return;
      }
      app.mutate(q => {
        const n = findNode(q, sel.id);
        if (f === 'label') n.label = t.value || undefined;
        if (f === 'count') n.count = Math.max(0, Math.floor(+t.value || 0));
        if (f === 'tier') { n.tier = +t.value; delete n.oc; }
        if (f === 'perfectOc') n.perfectOc = t.checked || undefined;
        if (f === 'multi') {
          n.multi = t.value || undefined;
          if (!n.multi) for (const k of ['hatches', 'parallel', 'speedPct', 'euPct', 'coil', 'heat']) delete n[k];
          else if (n.multi === EBF_ID) delete n.perfectOc;
        }
        const posInt = v => Math.max(1, Math.floor(+v || 1));
        if (f === 'hatches') n.hatches = posInt(t.value);
        if (f === 'parallel') n.parallel = posInt(t.value);
        if (f === 'speedPct') n.speedPct = Math.max(0, +t.value || 0) || undefined;
        if (f === 'euPct') n.euPct = +t.value > 0 ? +t.value : undefined;
        if (f === 'coil') n.coil = t.value === '' ? undefined : +t.value;
        if (f === 'heat') n.heat = +t.value > 0 ? Math.floor(+t.value) : undefined;
        if (f === 'cycleOverride') n.cycleOverride = t.value === '' ? undefined : Math.max(0, +t.value);
        if (f === 'rate') n.rate = Math.max(0, fromUnit(+t.value || 0));
      });
    }
    if (sel?.type === 'edge') {
      if (f === 'cable' || f === 'length') {
        const E = app.energyData;
        app.mutate(q => {
          const e = findEdge(q, sel.id);
          if (f === 'length') e.length = Math.max(0, Math.floor(+t.value || 0));
          if (f === 'cable') {
            const c = E?.cables.find(x => x.id === t.value);
            e.cable = c ? { ...brief(c), loss: c.loss, amps: c.amps, voltage: c.voltage, tier: c.tier, insulated: c.insulated, size: c.size } : null;
            if (!c) e.length = 0;
          }
        });
        return;
      }
      app.mutate(q => {
        const e = findEdge(q, sel.id);
        if (f === 'sharemode') e.share = t.value === 'fixed' ? (e.share ?? 70) : null;
        if (f === 'share') e.share = Math.max(0, Math.min(100, +t.value || 0));
      });
    }
  }

  /** Generator-specific fields. Returns true when handled. */
  generatorChange(t, f, id) {
    const app = this.app, E = app.energyData;
    const dropFuelEdges = q => { q.edges = q.edges.filter(e => e.energy || (e.to.node !== id && e.from.node !== id)); };
    const steamFuel = g => ({ res: g.steam.res, euPerUnit: g.steam.res ? g.voltage * 20 / g.steam.perSecond : null, efficiencyIncluded: true, outputs: [],
      source: { rule: 'steam', perSecond: g.steam.perSecond, voltage: g.voltage, item: g.id } });
    const fields = ['genpick', 'voltage', 'amps', 'efficiency', 'fuelmode', 'fuelmap', 'fuelpick', 'euPerUnit'];
    if (!fields.includes(f)) return false;
    app.mutate(q => {
      const n = findNode(q, id);
      if (f === 'voltage') n.voltage = +t.value;
      if (f === 'amps') n.amps = Math.max(0, Math.floor(+t.value || 0));
      if (f === 'efficiency') n.efficiency = t.value === '' ? null : Math.max(0, +t.value);
      if (f === 'genpick') {
        const g = E?.generators.find(x => x.id === t.value);
        if (!g) { n.gen = null; return; }
        n.gen = brief(g); n.voltage = g.voltage; n.efficiency = g.efficiency;
        if (g.steam) { n.fuel = steamFuel(g); n.fuelMode = 'steam'; dropFuelEdges(q); }
        else if (n.fuel && (n.fuel.source?.rule === 'steam' || (n.fuel.source?.map && !g.fuelMaps.includes(n.fuel.source.map)))) { n.fuel = null; n.fuelMode = g.fuelMaps.length ? 'map' : undefined; dropFuelEdges(q); }
        else if (!n.fuel && g.fuelMaps.length) { n.fuelMode = 'map'; n.fuelMapSel = g.fuelMaps[0]; }
      }
      if (f === 'fuelmode') {
        n.fuelMode = t.value;
        const g = E?.generators.find(x => x.id === n.gen?.id);
        if (t.value === 'none') { n.fuel = null; dropFuelEdges(q); }
        if (t.value === 'steam' && g?.steam) { n.fuel = steamFuel(g); dropFuelEdges(q); }
        if (t.value === 'map' && n.fuel && !n.fuel.source?.recipeId) { n.fuel = null; dropFuelEdges(q); }
        if (t.value === 'manual') { n.fuel = { res: n.fuel?.res || null, euPerUnit: n.fuel?.euPerUnit ?? null, outputs: [], source: { rule: 'manual' } }; }
      }
      if (f === 'fuelmap') n.fuelMapSel = t.value;
      if (f === 'fuelpick') {
        const o = (this.fuelCache?.[n.fuelMapSel || n.fuel?.source?.map] || Object.values(this.fuelCache || {}).flat().filter(Boolean)).find(x => x?.recipeId === t.value);
        if (!o) return;
        n.fuel = fuelFromOption(o);
        dropFuelEdges(q);
      }
      if (f === 'euPerUnit' && n.fuel) { n.fuel.euPerUnit = +t.value > 0 ? +t.value : null; n.fuel.source = { ...(n.fuel.source || {}), override: true }; }
    });
    return true;
  }

  async onClick(ev) {
    const t = ev.target;
    const app = this.app;
    const hit = t.closest('[data-fuelres]');
    if (hit) {
      const res = JSON.parse(hit.dataset.fuelres), id = app.selection.id;
      app.mutate(q => {
        const n = findNode(q, id);
        n.fuel = { res, euPerUnit: null, outputs: [], source: { rule: 'manual' } }; n.fuelMode = 'manual';
        q.edges = q.edges.filter(e => e.energy || (e.to.node !== id && e.from.node !== id));
      });
      return;
    }
    if (t.dataset.fix != null) { const f = this.fixes?.[+t.dataset.fix]; if (f) applyFix(app, f); return; }
    if (t.dataset.vrestore) { if (confirm($t('Заменить схему сохранённой версией? Отменить можно через Ctrl+Z.'))) app.restoreVersion(t.dataset.vrestore); return; }
    if (t.dataset.vdel) { app.deleteVersion(t.dataset.vdel); return; }
    if (t.dataset.act === 'vsave') { app.saveVersion(this.el.querySelector('[data-vname]')?.value.trim()); return; }
    const hr = t.closest('[data-hlres]');
    if (hr && hr.dataset.hlres && !t.closest('a,button,input')) { app.toggleResHighlight(hr.dataset.hlres); return; }
    if (t.dataset.selNode) { ev.preventDefault(); app.select({ type: 'node', id: t.dataset.selNode }); return; }
    if (t.dataset.selEdge) { ev.preventDefault(); app.select({ type: 'edge', id: t.dataset.selEdge }); return; }
    const act = t.dataset.act;
    if (!act) return;
    if (act === 'delnode' || act === 'deledge') app.deleteSelection();
    if (act === 'dup') app.duplicateSelection();
    if (act === 'group') app.groupSelection();
    if (act === 'delsel') app.deleteSelection();
    if (act === 'ungroup') app.ungroup(app.selection.id);
    if (act === 'enter') app.enterBlock(app.selection.id);
    if (act === 'exitblk') app.exitBlock();
    if (act === 'addgin') app.addSimple('gin');
    if (act === 'addgout') app.addSimple('gout');
    if (act === 'applytier') app.applyDefaultTier();
    if (act === 'machines') app.machineListDialog();
    if (act === 'plan') {
      const port = this.el.querySelector('[data-tg=port]')?.value || 'o0';
      const v = fromUnit(+this.el.querySelector('[data-tg=rate]')?.value || 0);
      if (!(v > 0)) { app.toast($t('Укажите, сколько нужно (больше нуля)'), 'warn'); return; }
      app.planDialog({ node: app.selection.id, port, rate: v });
    }
    if (act === 'plan-saved' && app.root.target) app.planDialog(app.root.target);
    if (act === 'untarget') app.mutate(() => { delete app.root.target; });
    if (act === 'arrange') app.arrangeNodes();
    if (act === 'png') app.exportPng();
    if (act === 'addgen') app.addSimple('generator');
    if (act === 'togen') app.convertToGenerator(app.selection.id);
    if (act === 'tocustom') {
      const n = findNode(app.project, app.selection.id);
      app.editCustom(recipeOf(app.project, n), recipeOf(app.project, n).dataset !== 'custom');
    }
    if (act === 'compare') {
      const n = findNode(app.project, app.selection.id);
      const snap = recipeOf(app.project, n);
      const box = this.el.querySelector('.cmp');
      box.innerHTML = await app.compareSnapshot(snap);
    }
  }
}
