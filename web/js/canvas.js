// Canvas: renders nodes (NEI-style cards) and edges; pan, zoom, drag, connect.
import { $t, lbl } from './i18n.js';
import { esc, num, rate, slotHtml, iconHtml, seconds, TIERS, nm, mname, energySlotHtml } from './fmt.js';
import { ports, recipeOf, checkConnect, node as findNode, resolveInput, energyOn, energyPorts, isEnergyRes } from './model.js';

// energy is delivered on demand: a ⚡ input is short only when it got less than it asked for
const eShort = x => x.short != null ? x.short > 1e-9 * Math.max(1, x.need) : x.supplied < x.need * (1 - 1e-7);
const eText = x => eShort(x) ? $t('есть ') + num(x.supplied) : $t('берёт ') + num(x.used ?? x.supplied);

const isSelected = (sel, id) => (sel?.type === 'node' && sel.id === id) || (sel?.type === 'nodes' && sel.ids.includes(id));

const GRID = 20;

export class Canvas {
  constructor(el, app) {
    this.el = el; this.app = app;
    this.view = { x: 40, y: 40, z: 1 };
    el.innerHTML = `<div class="world"><svg class="edges"><g class="elayer"></g><path class="temp" d=""/></svg><div class="elabels"></div><div class="nlayer"></div></div>
      <div class="zoomhud"></div><div class="band"></div>`;
    this.world = el.querySelector('.world');
    this.svg = el.querySelector('svg.edges');
    this.elayer = el.querySelector('.elayer');
    this.temp = el.querySelector('path.temp');
    this.labels = el.querySelector('.elabels');
    this.nlayer = el.querySelector('.nlayer');
    this.hud = el.querySelector('.zoomhud');
    this.band = el.querySelector('.band');
    this.portPos = new Map();
    this.bind();
    this.applyView();
  }

  // ---------- coordinates ----------
  toWorld(cx, cy) {
    const r = this.el.getBoundingClientRect();
    return { x: (cx - r.left - this.view.x) / this.view.z, y: (cy - r.top - this.view.y) / this.view.z };
  }
  centerWorld() {
    const r = this.el.getBoundingClientRect();
    return this.toWorld(r.left + r.width / 2, r.top + r.height / 2);
  }
  applyView() {
    const { x, y, z } = this.view;
    this.world.style.transform = `translate(${x}px,${y}px) scale(${z})`;
    const g = GRID * z;
    this.el.style.backgroundSize = `${g * 5}px ${g * 5}px, ${g * 5}px ${g * 5}px, ${g}px ${g}px, ${g}px ${g}px`;
    this.el.style.backgroundPosition = `${x}px ${y}px`;
    this.el.classList.toggle('lod', z < 0.45);
    this.hud.textContent = Math.round(z * 100) + '%';
  }

  // ---------- rendering ----------
  render() {
    const { project: p, results: R, selection: sel, highlight } = this.app;
    const html = [];
    for (const n of p.nodes) html.push(this.nodeHtml(p, n, R?.nodes[n.id], sel, highlight));
    this.nlayer.innerHTML = html.join('');
    this.measurePorts();
    this.renderEdges();
  }

  nodeHtml(p, n, s, sel, highlight) {
    const cls = ['node', n.type];
    if (isSelected(sel, n.id)) cls.push('selected');
    if (highlight?.has(n.id)) cls.push('affected');
    const st = `left:${n.x}px;top:${n.y}px`;
    const ds = this.app.iconDataset();
    if (n.type === 'machine') {
      const r = recipeOf(p, n);
      if (!r) return `<div class="${cls.join(' ')}" data-id="${n.id}" style="${st}"><div class="nhead">${$t("Рецепт отсутствует")}</div></div>`;
      const rds = this.app.iconDataset(r);
      if (s && s.util != null && s.util < 1 - 1e-7) cls.push('throttled');
      const crafter = r.machine?.defaultCrafter || r.machine?.singleblocks?.[0];
      const ins = r.inputs.map((e, i) => {
        if (e.consumed === false) {
          return `<div class="prow in nc"><div class="pspace"></div>${slotHtml(e, rds)}<div class="ptext"><small>${$t("не расходуется")}</small></div></div>`;
        }
        const pid = 'i' + i, x = s?.inputs[pid];
        const disp = resolveInput(n, e, i);
        let txt = '', rc = '';
        if (x) {
          const ok = x.need <= 0 || x.supplied >= x.need * (1 - 1e-7);
          rc = !x.connected ? 'unfed' : ok ? 'ok' : 'short';
          txt = `<b>${rate(x.need, e.kind)}</b><small>${x.connected ? $t('есть ') + rate(x.supplied, e.kind) : $t('нет подачи')}</small>`;
        }
        return `<div class="prow in ${rc}"><div class="port in" data-node="${n.id}" data-port="${pid}"></div>${slotHtml(e, rds, { display: e.kind === 'oredict' ? { ...disp, kind: 'item' } : null })}<div class="ptext">${txt}</div></div>`;
      }).join('');
      let eRow = '';
      if (energyPorts(p) && r.gt?.eut > 0) {
        const x = s?.inputs.ep;
        const rc = !x ? '' : !x.connected ? 'unfed' : eShort(x) ? 'short' : 'ok';
        eRow = `<div class="prow in energy ${rc}"><div class="port in energy" data-node="${n.id}" data-port="ep" title="${$t("Вход энергии: подключите генератор")}"></div>${energySlotHtml(TIERS[s?.params?.tier ?? 0], $t('Вход энергии, EU/t'))}<div class="ptext">${x ? `<b>${num(x.need)} EU/t</b><small>${x.connected ? eText(x) + ' EU/t' : $t('питание не подключено')}</small>` : ''}</div></div>`;
      }
      const outs = r.outputs.map((e, i) => {
        const pid = 'o' + i, x = s?.outputs[pid];
        let txt = '', rc = '';
        if (x) {
          rc = !x.connected ? 'unconn' : x.unrouted > 0 ? 'partial' : '';
          txt = `<b>${rate(x.actual, e.kind)}</b><small>${!x.connected ? $t('не подключён') : x.unrouted > 0 ? $t('не распр. ') + rate(x.unrouted, e.kind) : $t('макс ') + rate(x.max, e.kind)}</small>`;
        }
        return `<div class="prow out ${rc}"><div class="ptext">${txt}</div>${slotHtml(e, rds)}<div class="port out" data-node="${n.id}" data-port="${pid}"></div></div>`;
      }).join('');
      const gt = r.gt;
      const mp = s?.params;
      const foot = gt ? `${mp?.ticks != null ? seconds(mp.ticks) : $t('— с')} · ${mp?.eut != null ? num(mp.eut) + ' EU/t' : '— EU/t'} ${$t("· рецепт")} ${TIERS[mp?.recipeTier ?? 0]}${mp?.ocs ? ` ${$t("· разгон ×")}${mp.ocs}${n.perfectOc ? $t(' (идеальный)') : ''}` : ''}`
        : (n.cycleOverride ? `${num(n.cycleOverride)} ${$t("цикл/мин (вручную)")}` : $t('нет данных о длительности'));
      const u = s?.util;
      const utilBar = u == null ? '' : `<div class="util ${u < 1 - 1e-7 ? 'low' : ''}"><div style="width:${Math.min(100, u * 100)}%"></div><span>${$t("загрузка")} ${num(u * 100, 1)}%${s.limitedBy ? $t(' · ограничено входом') : ''}</span></div>`;
      const badge = r.dataset === 'custom' ? `<span class="badge custom" title="${$t("Пользовательский рецепт")}">${$t("свой")}</span>` : '';
      return `<div class="${cls.join(' ')}" data-id="${n.id}" style="${st}">
        <div class="nhead">${crafter ? iconHtml(crafter, rds, 'small') : ''}<span class="ntitle">${esc(lbl(n.label) || mname(r.machine))}</span>${s?.loop ? `<span class="nloop" title="${$t("Узел входит в цикл")} ${s.loop}">↻${s.loop}</span>` : ''}<span class="ntier" title="${$t("Уровень машины")}">${TIERS[mp?.tier ?? 0]}</span><span class="ncount">×${n.count}</span>${badge}</div>
        <div class="nbody"><div class="ncol">${eRow}${ins || (eRow ? '' : `<div class="empty">${$t("нет входов")}</div>`)}</div><div class="narrow">➜</div><div class="ncol">${outs}</div></div>
        <div class="nfoot">${foot}</div>${utilBar}</div>`;
    }
    if (n.type === 'source') {
      const res = n.resource;
      const x = s?.outputs.out;
      const demo = this.app.project.demo ? `<span class="badge demo" title="${$t("Значение задано для демонстрации")}">${$t("демо")}</span>` : '';
      return `<div class="${cls.join(' ')}" data-id="${n.id}" style="${st}">
        <div class="nhead"><span class="ntitle">⇥ ${esc(lbl(n.label))}</span>${demo}</div>
        <div class="prow out ${x && !x.connected ? 'unconn' : x?.unrouted > 0 ? 'partial' : ''}"><div class="ptext"><b>${rate(n.rate, res?.kind)}</b><small>${esc(nm(res) || '—')}${x && !x.connected ? $t(' · не подключён') : ''}</small></div>${slotHtml({ ...res, amount: null }, ds)}<div class="port out" data-node="${n.id}" data-port="out"></div></div></div>`;
    }
    if (n.type === 'splitter' || n.type === 'merger') {
      const res = n.resource;
      const tin = s?.inputs.in?.supplied ?? 0;
      const title = lbl(n.label) || (n.type === 'splitter' ? $t('Разветвитель') : $t('Слияние'));
      return `<div class="${cls.join(' ')}" data-id="${n.id}" style="${st}">
        <div class="nhead"><span class="ntitle">${n.type === 'splitter' ? '⑂' : '⑃'} ${esc(title)}</span></div>
        <div class="prow bus"><div class="port in" data-node="${n.id}" data-port="in"></div>${res ? slotHtml({ ...res, amount: null }, ds) : '<div class="slot"></div>'}<div class="ptext"><b>${res ? rate(tin, res.kind) : $t('любой')}</b><small>${esc(nm(res) || $t('тип по первой связи'))}</small></div><div class="port out" data-node="${n.id}" data-port="out"></div></div></div>`;
    }
    if (n.type === 'generator') {
      const on = energyOn(p);
      const fuel = n.fuel;
      const fx = s?.inputs.f;
      const fin = fuel?.res ? `<div class="prow in ${fx ? (!fx.connected ? 'unfed' : fx.supplied >= fx.need * (1 - 1e-7) ? 'ok' : 'short') : ''}"><div class="port in" data-node="${n.id}" data-port="f"></div>${slotHtml({ ...fuel.res, amount: null }, ds)}<div class="ptext">${fx && on ? `<b>${rate(fx.need, fuel.res.kind)}</b><small>${fx.connected ? $t('есть ') + rate(fx.supplied, fuel.res.kind) : $t('нет подачи')}</small>` : `<small>${esc(nm(fuel.res))}</small>`}</div></div>`
        : `<div class="prow in"><div class="ptext"><small>${fuel ? $t('топливо не выбрано') : $t('без топлива (внешняя сеть)')}</small></div></div>`;
      const outs = (fuel?.outputs || []).map((o, i) => {
        const x = s?.outputs['o' + i];
        return `<div class="prow out ${x && !x.connected ? 'unconn' : ''}"><div class="ptext">${x ? `<b>${rate(x.actual, o.res.kind)}</b>` : ''}</div>${slotHtml({ ...o.res, amount: null }, ds)}<div class="port out" data-node="${n.id}" data-port="o${i}"></div></div>`;
      }).join('');
      const eo = s?.outputs.eo;
      const tierName = { 8: 'ULV', 32: 'LV', 128: 'MV', 512: 'HV', 2048: 'EV', 8192: 'IV', 32768: 'LuV', 131072: 'ZPM', 524288: 'UV', 2097152: 'UHV' }[n.voltage] || '';
      const eRow = true ? `<div class="prow out energy ${eo && !eo.connected ? 'unconn' : ''}"><div class="ptext"><b>${num(s?.output || 0)} EU/t</b><small>${eo && !eo.connected ? $t('не подключён') : `${$t("макс")} ${num(s?.capacity || 0)} EU/t`}</small></div>${energySlotHtml(tierName, $t('Выход энергии, EU/t'))}<div class="port out energy" data-node="${n.id}" data-port="eo" title="${$t("Выход энергии: протяните к ⚡ входу машины")}"></div></div>` : '';
      const title = n.label && n.label !== 'Генератор' ? lbl(n.label) : (nm(n.gen) || $t('Генератор'));
      const u = s?.util;
      if (!on) cls.push('off');
      return `<div class="${cls.join(' ')}" data-id="${n.id}" style="${st}">
        <div class="nhead">${n.gen ? iconHtml(n.gen, ds, 'small') : `<span class="gicon">${energySlotHtml('').replace(/^<div[^>]*>|<\/div>$/g, '')}</span>`}<span class="ntitle">${esc(title)}</span>${tierName ? `<span class="ntier">${tierName}</span>` : ''}<span class="ncount">×${n.count ?? 1}</span></div>
        <div class="nbody"><div class="ncol">${fin}</div><div class="narrow">➜</div><div class="ncol">${eRow}${outs}</div></div>
        <div class="nfoot">${num(n.voltage)} ${$t("В ×")} ${num(n.amps ?? 1)} ${$t("А")}${n.efficiency != null && n.efficiency !== '' ? ` ${$t("· КПД")} ${num(+n.efficiency)}%` : ''}</div>
        ${s?.idle ? `<div class="gidle">0 EU/t: ${esc(s.idle)}</div>` : ''}
        ${u != null ? `<div class="util ${s.fuelLimits ? 'low' : ''}"><div style="width:${Math.min(100, u * 100)}%"></div><span>${$t("нагрузка")} ${num(u * 100, 1)}%${s.fuelLimits ? $t(' · мало топлива') : ''}</span></div>` : ''}</div>`;
    }
    if (n.type === 'group') return this.groupHtml(p, n, s, cls, st, ds);
    if (n.type === 'gin') {
      const res = n.resource, x = s?.outputs.out;
      const ctx = this.app.blockCtx();
      return `<div class="${cls.join(' ')}" data-id="${n.id}" style="${st}">
        <div class="nhead"><span class="ntitle">⇥ ${esc(lbl(n.label) || $t('Вход'))}</span><span class="badge blk">${$t("вход блока")}</span></div>
        <div class="prow out ${x && !x.connected ? 'unconn' : ''}"><div class="ptext"><b>${res ? rate(x?.actual ?? n.rate ?? 0, res.kind) : '—'}</b><small>${res ? (ctx?.full ? $t('без ограничения (полная мощность)') : $t('подаётся снаружи')) : $t('тип — по первой связи')}</small></div>${res ? slotHtml({ ...res, amount: null }, ds) : '<div class="slot"></div>'}<div class="port out" data-node="${n.id}" data-port="out"></div></div></div>`;
    }
    if (n.type === 'gout') {
      const res = n.resource;
      if (isEnergyRes(res)) {
        return `<div class="${cls.join(' ')}" data-id="${n.id}" style="${st}">
          <div class="nhead"><span class="ntitle">⇤ ${esc(lbl(n.label) || $t('Выход'))}</span><span class="badge blk">${$t("выход блока")}</span></div>
          <div class="prow in energy"><div class="port in energy" data-node="${n.id}" data-port="in"></div>${energySlotHtml('', $t('Выход энергии блока'))}<div class="ptext"><b>${num(s?.powerAvg || 0)} EU/t</b><small>${$t("уходит наружу")}</small></div></div></div>`;
      }
      const x = s?.inputs.in;
      return `<div class="${cls.join(' ')}" data-id="${n.id}" style="${st}">
        <div class="nhead"><span class="ntitle">⇤ ${esc(lbl(n.label) || $t('Выход'))}</span><span class="badge blk">${$t("выход блока")}</span></div>
        <div class="prow in"><div class="port in" data-node="${n.id}" data-port="in"></div>${res ? slotHtml({ ...res, amount: null }, ds) : '<div class="slot"></div>'}<div class="ptext"><b>${res ? rate(x?.used || 0, res.kind) : '—'}</b><small>${res ? $t('уходит наружу') : $t('тип — по первой связи')}</small></div></div></div>`;
    }
    if (n.type === 'sink') {
      const list = this.app.sinkContents(n.id);
      const rows = list.length ? list.map(x => `<div class="sinkrow">${iconHtml(x.res, ds, 'small')}<span>${esc(nm(x.res))}</span><b>${rate(x.rate, x.res?.kind)}</b></div>`).join('') : `<div class="empty">${$t("пусто")}</div>`;
      return `<div class="${cls.join(' ')}" data-id="${n.id}" style="${st}">
        <div class="nhead"><span class="ntitle">▣ ${esc(lbl(n.label))}</span></div>
        <div class="prow in"><div class="port in" data-node="${n.id}" data-port="in"></div><div class="sinklist">${rows}</div></div></div>`;
    }
    return '';
  }

  groupHtml(p, n, s, cls, st, ds) {
    if (s && s.util != null && s.util < 1 - 1e-7) cls.push('throttled');
    const ps = ports(p, n);
    const row = (pt) => {
      const x = pt.dir === 'in' ? s?.inputs[pt.id] : s?.outputs[pt.id];
      if (pt.energy) {
        if (pt.dir === 'in') {
          const rc = !x ? '' : !x.connected ? 'unfed' : eShort(x) ? 'short' : 'ok';
          return `<div class="prow in energy ${rc}"><div class="port in energy" data-node="${n.id}" data-port="ep" title="${$t("Вход энергии блока")}"></div>${energySlotHtml(TIERS[s?.params?.tier ?? 0], $t('Вход энергии блока, EU/t'))}<div class="ptext">${x ? `<b>${num(x.need)} EU/t</b><small>${x.connected ? eText(x) : $t('питание не подключено')}</small>` : ''}</div></div>`;
        }
        return `<div class="prow out energy ${x && !x.connected ? 'unconn' : ''}"><div class="ptext"><b>${num(s?.output || 0)} EU/t</b><small>${$t("макс")} ${num(s?.capacity || 0)} EU/t</small></div>${energySlotHtml('', $t('Выход энергии блока'))}<div class="port out energy" data-node="${n.id}" data-port="eo"></div></div>`;
      }
      const k = pt.res?.kind;
      if (pt.dir === 'in') {
        const rc = !x ? '' : !x.connected ? 'unfed' : x.supplied >= x.need * (1 - 1e-7) ? 'ok' : 'short';
        return `<div class="prow in ${rc}"><div class="port in" data-node="${n.id}" data-port="${pt.id}"></div>${slotHtml({ ...pt.res, amount: null }, ds)}<div class="ptext">${x ? `<b>${rate(x.need, k)}</b><small>${x.connected ? $t('есть ') + rate(x.supplied, k) : $t('нет подачи')}</small>` : ''}</div></div>`;
      }
      const rc = !x ? '' : !x.connected ? 'unconn' : x.unrouted > 0 ? 'partial' : '';
      return `<div class="prow out ${rc}"><div class="ptext">${x ? `<b>${rate(x.actual, k)}</b><small>${!x.connected ? $t('не подключён') : $t('макс ') + rate(x.max, k)}</small>` : ''}</div>${slotHtml({ ...pt.res, amount: null }, ds)}<div class="port out" data-node="${n.id}" data-port="${pt.id}"></div></div>`;
    };
    const ins = ps.filter(x => x.dir === 'in').sort((a, b) => (b.energy ? 1 : 0) - (a.energy ? 1 : 0)).map(row).join('');
    const outs = ps.filter(x => x.dir === 'out').sort((a, b) => (b.energy ? 1 : 0) - (a.energy ? 1 : 0)).map(row).join('');
    const inner = n.inner?.nodes.filter(x => x.type !== 'gin' && x.type !== 'gout').length || 0;
    const u = s?.util;
    return `<div class="${cls.join(' ')}" data-id="${n.id}" style="${st}" title="${$t("Двойной щелчок — открыть блок")}">
      <div class="nhead"><span class="gico">▦</span><span class="ntitle">${esc(lbl(n.label) || $t('Блок'))}</span>${s?.loop ? `<span class="nloop">↻${s.loop}</span>` : ''}<span class="badge blk">${$t("блок")}</span></div>
      <div class="nbody"><div class="ncol">${ins || `<div class="empty">${$t("нет входов")}</div>`}</div><div class="narrow">➜</div><div class="ncol">${outs || `<div class="empty">${$t("нет выходов")}</div>`}</div></div>
      <div class="nfoot">${$t("внутри узлов:")} ${inner}${s?.innerProblems ? ` · <b class="warnc">${$t("проблем:")} ${s.innerProblems}</b>` : ''} · <a href="#" data-enter="${n.id}">${$t("открыть ⤵")}</a></div>
      ${u == null ? '' : `<div class="util ${u < 1 - 1e-7 ? 'low' : ''}"><div style="width:${Math.min(100, u * 100)}%"></div><span>${$t("загрузка")} ${num(u * 100, 1)}%${s.limitedBy ? $t(' · ограничено входом') : ''}</span></div>`}</div>`;
  }

  measurePorts() {
    this.portPos.clear();
    const r0 = this.world.getBoundingClientRect();
    const z = this.view.z;
    for (const el of this.nlayer.querySelectorAll('.port')) {
      const r = el.getBoundingClientRect();
      this.portPos.set(el.dataset.node + '|' + el.dataset.port, { x: (r.left + r.width / 2 - r0.left) / z, y: (r.top + r.height / 2 - r0.top) / z });
    }
  }

  renderEdges() {
    const { project: p, results: R, selection: sel } = this.app;
    const paths = [], labels = [];
    // node boxes in world coordinates (for routing backward links around them)
    const boxes = new Map();
    for (const el of this.nlayer.querySelectorAll('.node')) {
      const n = p.nodes.find(x => x.id === el.dataset.id);
      if (n) boxes.set(n.id, { x: n.x, y: n.y, w: el.offsetWidth, h: el.offsetHeight });
    }
    let back = 0, lane = 0;
    for (const e of p.edges) {
      const a = this.portPos.get(e.from.node + '|' + e.from.port);
      const b = this.portPos.get(e.to.node + '|' + e.to.port);
      if (!a || !b) continue;
      const s = R?.edges[e.id];
      let d, m;
      if (e.energy) ({ d, m } = pipe(a, b, boxes.get(e.from.node), boxes.get(e.to.node), lane++));
      else if (b.x < a.x + 40) {
        // backward link (typical for loops): go out right, run below both nodes, come in from the left
        const ba = boxes.get(e.from.node), bb = boxes.get(e.to.node);
        const yb = Math.max(ba ? ba.y + ba.h : a.y, bb ? bb.y + bb.h : b.y) + 28 + 16 * (back++ % 4);
        d = `M${a.x},${a.y} C${a.x + 60},${a.y} ${a.x + 60},${yb} ${a.x},${yb} L${b.x},${yb} C${b.x - 60},${yb} ${b.x - 60},${b.y} ${b.x},${b.y}`;
        m = { x: (a.x + b.x) / 2, y: yb };
      } else { d = curve(a, b); m = mid(a, b); }
      const selected = sel?.type === 'edge' && sel.id === e.id;
      const cls = `edge ${s?.status || ''} ${s?.resource?.kind === 'fluid' ? 'fluid' : ''} ${e.energy ? 'energy' : ''} ${selected ? 'selected' : ''}`;
      paths.push(`<path class="hit" data-edge="${e.id}" d="${d}"/>${e.energy ? `<path class="ecase ${selected ? 'selected' : ''}" d="${d}"/>` : ''}<path class="${cls}" d="${d}"/>`);
      if (s && e.energy) {
        let t = `⚡ ${num(s.offered)} / ${num(s.demand)} EU/t`;
        if (s.status === 'deficit') t += ` <em>−${num(s.deficit)}</em>`;
        const cab = e.cable ? ` · ${num(s.length)} ${$t("бл.")}` + (s.loss > 0 ? ` <i>${$t("потери")} ${num(s.loss)}</i>` : '') : '';
        const warn = s.warnings?.length ? ' <b class="ew" title="' + esc(s.warnings.map(w => w.text).join('\n')) + '">⚠</b>' : '';
        labels.push({ x: m.x, y: m.y, w: 0, html: `<div class="elabel energy ${s.status} ${selected ? 'selected' : ''}" data-edge="${e.id}" style="left:{X}px;top:{Y}px">${t}${cab}${warn}</div>` });
      } else if (s) {
        const share = e.share != null && e.share !== '' ? `<i>${num(+e.share)}%</i>` : '';
        let t = s.demand === Infinity ? `${rate(s.flow, s.resource?.kind)}` : `${rate(s.offered, s.resource?.kind)} / ${rate(s.demand, s.resource?.kind)}`;
        if (s.status === 'deficit') t += ` <em>−${rate(s.deficit, s.resource?.kind)}</em>`;
        else if (s.status === 'surplus') t += ` <em>+${rate(s.surplus, s.resource?.kind)}</em>`;
        const loop = s.loop ? `<b class="lp" title="${$t("Связь внутри цикла")} ${s.loop}">↻</b>` : '';
        labels.push({ x: m.x, y: m.y, w: 0, html: `<div class="elabel ${s.status} ${s.loop ? 'loop' : ''} ${selected ? 'selected' : ''}" data-edge="${e.id}" style="left:{X}px;top:{Y}px">${loop}${share}${t}</div>` });
      }
    }
    this.elayer.innerHTML = paths.join('');
    // render once to measure widths, then push overlapping labels apart vertically
    this.labels.innerHTML = labels.map(l => l.html.replace('{X}', l.x).replace('{Y}', l.y)).join('');
    const els = [...this.labels.children];
    els.forEach((el, i) => { labels[i].w = el.offsetWidth; labels[i].h = el.offsetHeight || 18; labels[i].el = el; });
    const placed = [];
    for (const l of [...labels].sort((a, b) => a.y - b.y || a.x - b.x)) {
      let moved = true, guard = 0;
      while (moved && guard++ < 40) {
        moved = false;
        for (const o of placed) {
          if (Math.abs(l.x - o.x) < (l.w + o.w) / 2 + 4 && Math.abs(l.y - o.y) < (l.h + o.h) / 2 + 2) {
            l.y = o.y + (o.h + l.h) / 2 + 2; moved = true;
          }
        }
      }
      placed.push(l);
      l.el.style.top = l.y + 'px';
    }
  }

  fit() {
    const nodes = [...this.nlayer.querySelectorAll('.node')];
    if (!nodes.length) { this.view = { x: 40, y: 40, z: 1 }; this.applyView(); return; }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const el of nodes) {
      const n = findNode(this.app.project, el.dataset.id);
      x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y);
      x1 = Math.max(x1, n.x + el.offsetWidth); y1 = Math.max(y1, n.y + el.offsetHeight);
    }
    const W = this.el.clientWidth, H = this.el.clientHeight, pad = 60;
    const z = Math.min(1.2, Math.max(0.1, Math.min((W - pad * 2) / (x1 - x0), (H - pad * 2) / (y1 - y0))));
    this.view = { z, x: (W - (x1 - x0) * z) / 2 - x0 * z, y: (H - (y1 - y0) * z) / 2 - y0 * z };
    this.applyView();
    this.measurePorts(); this.renderEdges();
  }

  // ---------- interaction ----------
  bind() {
    const el = this.el;
    el.addEventListener('wheel', ev => {
      ev.preventDefault();
      const r = el.getBoundingClientRect();
      const cx = ev.clientX - r.left, cy = ev.clientY - r.top;
      const z0 = this.view.z;
      const z = Math.min(2.5, Math.max(0.1, z0 * Math.exp(-ev.deltaY * 0.0015)));
      this.view.x = cx - (cx - this.view.x) * z / z0;
      this.view.y = cy - (cy - this.view.y) * z / z0;
      this.view.z = z;
      this.applyView();
    }, { passive: false });

    el.addEventListener('pointerdown', ev => {
      if (ev.button !== 0 && ev.button !== 1) return;
      const t = ev.target;
      if (t.closest('input,select,button,textarea')) return;
      const portEl = t.closest('.port');
      const nodeEl = t.closest('.node');
      const edgeId = t.dataset?.edge || t.closest('.elabel')?.dataset.edge;
      if (t.closest('[data-enter]')) { ev.preventDefault(); this.app.enterBlock(t.closest('[data-enter]').dataset.enter); return; }
      if (ev.button === 0 && portEl) return this.startConnect(ev, portEl);
      if (ev.button === 0 && nodeEl && (ev.ctrlKey || ev.metaKey || ev.shiftKey)) { this.app.toggleSelect(nodeEl.dataset.id); return; }
      if (ev.button === 0 && nodeEl) return this.startDrag(ev, nodeEl);
      if (ev.button === 0 && edgeId) { this.app.select({ type: 'edge', id: edgeId }); return; }
      if (ev.button === 0 && (ev.shiftKey || ev.ctrlKey)) return this.startBand(ev);
      this.startPan(ev);
    });
    el.addEventListener('dblclick', ev => {
      const nodeEl = ev.target.closest('.node.group');
      if (nodeEl && !ev.target.closest('.port')) this.app.enterBlock(nodeEl.dataset.id);
    });

    el.addEventListener('dragover', ev => { if (ev.dataTransfer.types.includes('text/gtnh-recipe')) ev.preventDefault(); });
    el.addEventListener('drop', ev => {
      const id = ev.dataTransfer.getData('text/gtnh-recipe');
      if (!id) return;
      ev.preventDefault();
      const w = this.toWorld(ev.clientX, ev.clientY);
      this.app.addRecipeNode(id, w);
    });
    new ResizeObserver(() => this.applyView()).observe(el);
  }

  startPan(ev) {
    const sx = ev.clientX, sy = ev.clientY, vx = this.view.x, vy = this.view.y;
    let moved = false;
    this.el.classList.add('panning');
    const mv = e => {
      if (Math.abs(e.clientX - sx) + Math.abs(e.clientY - sy) > 3) moved = true;
      this.view.x = vx + e.clientX - sx; this.view.y = vy + e.clientY - sy; this.applyView();
    };
    const up = () => {
      window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up);
      this.el.classList.remove('panning');
      if (!moved) this.app.select(null);
    };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  }

  /** Shift/Ctrl + drag on the background: select every node inside the rectangle. */
  startBand(ev) {
    const r = this.el.getBoundingClientRect();
    const sx = ev.clientX, sy = ev.clientY;
    const b = this.band;
    const add = ev.ctrlKey || ev.metaKey;
    const box = e => ({ x: Math.min(sx, e.clientX), y: Math.min(sy, e.clientY), w: Math.abs(e.clientX - sx), h: Math.abs(e.clientY - sy) });
    const mv = e => {
      const q = box(e);
      Object.assign(b.style, { display: 'block', left: q.x - r.left + 'px', top: q.y - r.top + 'px', width: q.w + 'px', height: q.h + 'px' });
    };
    const up = e => {
      window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up);
      b.style.display = 'none';
      const q = box(e);
      if (q.w + q.h < 6) return;
      const ids = [...this.nlayer.querySelectorAll('.node')].filter(el => {
        const n = el.getBoundingClientRect();
        return n.left >= q.x && n.right <= q.x + q.w && n.top >= q.y && n.bottom <= q.y + q.h;
      }).map(el => el.dataset.id);
      const sel = this.app.selection;
      const prev = !add ? [] : sel?.type === 'nodes' ? sel.ids : sel?.type === 'node' ? [sel.id] : [];
      this.app.selectNodes([...new Set([...prev, ...ids])]);
    };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  }

  startDrag(ev, nodeEl) {
    const id = nodeEl.dataset.id;
    const p = this.app.project;
    const sel = this.app.selection;
    const group = sel?.type === 'nodes' && sel.ids.includes(id) ? sel.ids : [id];
    const items = group.map(x => findNode(p, x)).filter(Boolean).map(n => ({ n, ox: n.x, oy: n.y }));
    const start = this.toWorld(ev.clientX, ev.clientY);
    let moved = false;
    if (group.length === 1 && !(sel?.type === 'node' && sel.id === id)) this.app.select({ type: 'node', id });
    const mv = e => {
      const w = this.toWorld(e.clientX, e.clientY);
      const dx = Math.round((w.x - start.x) / 10) * 10, dy = Math.round((w.y - start.y) / 10) * 10;
      if (!moved && (Math.abs(dx) + Math.abs(dy) < 5)) return;
      if (!moved) { this.app.history.push(this.app.root); moved = true; }
      for (const it of items) {
        it.n.x = it.ox + dx; it.n.y = it.oy + dy;
        const ne = this.nlayer.querySelector(`.node[data-id="${it.n.id}"]`);
        if (ne) { ne.style.left = it.n.x + 'px'; ne.style.top = it.n.y + 'px'; }
      }
      this.measurePorts(); this.renderEdges();
    };
    const up = () => {
      window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up);
      if (moved) this.app.changed({ solve: false });
    };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  }

  startConnect(ev, portEl) {
    ev.stopPropagation();
    const src = { node: portEl.dataset.node, port: portEl.dataset.port, dir: portEl.classList.contains('out') ? 'out' : 'in' };
    const a = this.portPos.get(src.node + '|' + src.port);
    const p = this.app.project;
    // highlight compatible ports
    for (const pe of this.nlayer.querySelectorAll('.port')) {
      const other = { node: pe.dataset.node, port: pe.dataset.port };
      const isOut = pe.classList.contains('out');
      if ((src.dir === 'out') === isOut) { pe.classList.add('dim'); continue; }
      const c = src.dir === 'out' ? checkConnect(p, src, other) : checkConnect(p, other, src);
      pe.classList.add(c.ok ? 'compatible' : 'dim');
    }
    this.el.classList.add('connecting');
    const mv = e => {
      const w = this.toWorld(e.clientX, e.clientY);
      this.temp.setAttribute('d', src.dir === 'out' ? curve(a, w) : curve(w, a));
    };
    const up = e => {
      window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up);
      this.temp.setAttribute('d', '');
      this.el.classList.remove('connecting');
      for (const pe of this.nlayer.querySelectorAll('.port')) pe.classList.remove('compatible', 'dim');
      const target = document.elementFromPoint(e.clientX, e.clientY)?.closest('.port');
      if (target) {
        const other = { node: target.dataset.node, port: target.dataset.port };
        if (other.node === src.node && other.port === src.port) return;
        if (src.dir === 'out') this.app.connect(src, other); else this.app.connect(other, src);
      } else if (this.el.contains(document.elementFromPoint(e.clientX, e.clientY))) {
        this.app.portDroppedOnEmpty(src, this.toWorld(e.clientX, e.clientY));
      }
    };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  }
}

/** Energy cable: orthogonal "pipe" route (right angles). Forward: out -> vertical riser -> in.
 *  Backward: out -> down below both nodes -> back left -> up into the input. */
function pipe(a, b, ba, bb, lane) {
  const off = (lane % 5) * 6;
  if (b.x >= a.x + 30) {
    const xm = Math.round(a.x + Math.max(15, (b.x - a.x) / 2) + off - 12);
    const x = Math.min(Math.max(xm, a.x + 12), b.x - 12);
    return { d: `M${a.x},${a.y} H${x} V${b.y} H${b.x}`, m: { x, y: (a.y + b.y) / 2 } };
  }
  const x1 = a.x + 18 + off, x2 = b.x - 18 - off;
  const yb = Math.max(ba ? ba.y + ba.h : a.y, bb ? bb.y + bb.h : b.y) + 24 + off;
  return { d: `M${a.x},${a.y} H${x1} V${yb} H${x2} V${b.y} H${b.x}`, m: { x: (x1 + x2) / 2, y: yb } };
}

function curve(a, b) {
  const dx = Math.max(40, Math.abs(b.x - a.x) * 0.5);
  return `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`;
}
function mid(a, b) {
  const dx = Math.max(40, Math.abs(b.x - a.x) * 0.5);
  // cubic bezier at t=0.5
  const p1 = { x: a.x + dx, y: a.y }, p2 = { x: b.x - dx, y: b.y };
  return { x: 0.125 * a.x + 0.375 * p1.x + 0.375 * p2.x + 0.125 * b.x, y: 0.125 * a.y + 0.375 * p1.y + 0.375 * p2.y + 0.125 * b.y };
}
