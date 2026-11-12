// Suggested fixes for problems, and "why is this limited" explanations. Every suggestion is
// computed from the solver results of the current schematic (counts are rounded up to whole
// machines); applying one is an ordinary undoable edit, and the line is solved again after it.
import { $t, lbl } from './i18n.js';
import { num, rate, nm, mname, TIERS, TIER_V } from './fmt.js';
import { node as findNode, edge as findEdge, recipeOf, ports, NODE_TYPES } from './model.js';

const EPS = 1e-9;
const hasShare = e => e.share != null && e.share !== '';

export function nodeLabel(p, id) {
  const n = findNode(p, id);
  if (!n) return id;
  if (n.type === 'machine') return lbl(n.label) || mname(recipeOf(p, n)?.machine) || $t('Машина');
  if (n.type === 'generator') return n.label && n.label !== 'Генератор' ? lbl(n.label) : nm(n.gen) || $t('Генератор');
  return lbl(n.label) || NODE_TYPES[n.type];
}

/**
 * Rate a port must give so that every link from it gets its full demand, taking fixed
 * shares into account (a 70% link needs 1/0.7 of its demand at the port). Infinity when
 * the shares cannot satisfy it (fixed shares sum to 100% and an "auto" link wants more).
 */
export function requiredRate(p, R, nodeId, portId) {
  const es = p.edges.filter(e => e.from.node === nodeId && e.from.port === portId && !e.energy);
  let fixedSum = 0;
  for (const e of es) if (hasShare(e)) fixedSum += Math.max(0, +e.share) / 100;
  const norm = fixedSum > 1 ? fixedSum : 1;
  let fixedNeed = 0, autoD = 0;
  for (const e of es) {
    const d = R?.edges[e.id]?.demand;
    if (!(d > 0) || d === Infinity) continue;
    if (hasShare(e)) { const f = Math.max(0, +e.share) / 100 / norm; fixedNeed = Math.max(fixedNeed, f > 0 ? d / f : Infinity); }
    else autoD += d;
  }
  const rest = 1 - Math.min(1, fixedSum);
  return Math.max(fixedNeed, autoD > 0 ? (rest > EPS ? autoD / rest : Infinity) : 0);
}

/** Machines needed so that every output port of `n` covers what its links ask for. */
export function machinesForDemand(p, R, n) {
  const s = R?.nodes[n.id];
  if (!s || n.type !== 'machine' || !(n.count > 0)) return null;
  let N = 0, port = null;
  for (const [pid, x] of Object.entries(s.outputs || {})) {
    if (x.energy || !(x.max > 0)) continue;
    const T = requiredRate(p, R, n.id, pid);
    if (!(T > x.max * (1 + 1e-7)) || T === Infinity) continue;
    const need = Math.ceil(T / (x.max / n.count) - 1e-7);
    if (need > N) { N = need; port = pid; }
  }
  return N > n.count ? { count: N, port } : null;
}

/** Fewest machines that still use everything that arrives (the rest would stand idle). */
export function machinesForSupply(R, n) {
  const s = R?.nodes[n.id];
  if (!s || n.type !== 'machine' || s.util == null || !s.limitedBy || s.limitedBy === 'ep') return null;
  const N = Math.max(1, Math.ceil(n.count * s.util - 1e-7));
  return N < n.count ? N : null;
}

/** One line: what limits node `id`, followed up the chain (at most 3 steps). */
export function whyLimited(p, R, id, depth = 0) {
  const n = findNode(p, id), s = R?.nodes[id];
  if (!n || !s?.limitedBy) return null;
  if (s.limitedBy === 'ep') {
    const x = s.inputs.ep;
    return `${$t('энергия: доставляется')} ${num(x?.supplied || 0)} ${$t('из')} ${num(x?.need || 0)} EU/t`;
  }
  const x = s.inputs[s.limitedBy];
  const res = x?.res || ports(p, n).find(q => q.id === s.limitedBy)?.res;
  let t = `«${nm(res)}»: ${$t('приходит')} ${rate(x?.supplied || 0, res?.kind)} ${$t('из')} ${rate(x?.need || 0, res?.kind)}`;
  if (x && !x.connected) return `«${nm(res)}» ${$t('не подключён')}`;
  if (depth >= 3) return t;
  const ins = p.edges.filter(e => e.to.node === id && e.to.port === s.limitedBy);
  if (ins.length === 1) {
    const from = findNode(p, ins[0].from.node);
    if (from?.type === 'source') t += ` ← ${$t('источник')} «${nodeLabel(p, from.id)}» ${$t('даёт')} ${rate(from.rate, res?.kind)}`;
    else if (from && R.nodes[from.id]?.limitedBy) t += ` ← ${nodeLabel(p, from.id)}: ${whyLimited(p, R, from.id, depth + 1)}`;
    else if (from?.type === 'machine') t += ` ← ${nodeLabel(p, from.id)} ×${from.count} ${$t('на полной мощности')}`;
  }
  return t;
}

/** Fixes for a deficit on link `edgeId`: raise the source or add machines at the producer. */
function supplyFixes(p, R, edgeId, depth = 0) {
  const e = findEdge(p, edgeId);
  if (!e || depth > 4) return [];
  const from = findNode(p, e.from.node);
  const s = R?.nodes[from?.id];
  if (!from || !s) return [];
  const name = nodeLabel(p, from.id);
  if (from.type === 'source') {
    const T = requiredRate(p, R, from.id, 'out');
    if (T > from.rate * (1 + 1e-7) && T < Infinity) return [{ label: `${$t('Источник')} «${name}»: ${rate(from.rate, from.resource?.kind)} → ${rate(T, from.resource?.kind)}`, edit: q => { findNode(q, from.id).rate = T; } }];
    return [];
  }
  if (from.type === 'machine') {
    if (s.util != null && s.util < 1 - 1e-7) return [{ label: `«${name}» ${$t('сам ограничен — показать')}`, select: from.id }];
    const fix = machinesForDemand(p, R, from);
    if (fix) return [{ label: `«${name}»: ${$t('машин')} ${from.count} → ${fix.count}`, edit: q => { findNode(q, from.id).count = fix.count; } }];
    return [];
  }
  if (from.type === 'splitter') {
    const inE = p.edges.find(x => x.to.node === from.id);
    return inE ? supplyFixes(p, R, inE.id, depth + 1) : [];
  }
  if (from.type === 'group') return [{ label: `${$t('Открыть блок')} «${name}»`, enter: from.id }];
  return [{ label: `${$t('Показать')} «${name}»`, select: from.id }];
}

/** Cheapest cable (least loss) of at least voltage V and amperage A. */
function cableFor(E, V, A) {
  return (E?.cables || []).filter(c => c.voltage >= V && c.amps >= A - EPS)
    .sort((a, b) => a.loss - b.loss || a.voltage - b.voltage || a.amps - b.amps)[0] || null;
}

/**
 * Suggested fixes for one problem. Each fix is {label, edit?(q), select?, enter?, run?(app)}:
 * `edit` changes the schematic being viewed, `select`/`enter` only navigate.
 */
export function fixesFor(app, prob) {
  const p = app.project, R = app.results;
  const n = prob.node ? findNode(p, prob.node) : null;
  const out = [];
  if (prob.kind === 'deficit' && prob.edge) out.push(...supplyFixes(p, R, prob.edge));
  if (prob.kind === 'unfed' && n && prob.port) {
    out.push({ label: $t('Найти рецепт'), run: a => a.portDroppedOnEmpty({ node: n.id, port: prob.port, dir: 'in' }, { x: n.x - 420, y: n.y }) });
    out.push({ label: $t('+ Источник'), run: a => a.quickAttach({ node: n.id, port: prob.port, dir: 'in' }, 'source') });
  }
  if (prob.kind === 'unconnected' && n && prob.port) out.push({ label: $t('+ Склад'), run: a => a.quickAttach({ node: n.id, port: prob.port, dir: 'out' }, 'sink') });
  if (prob.kind === 'unpowered' && n) out.push({ label: $t('+ Генератор'), run: a => a.quickAttach({ node: n.id, port: 'ep', dir: 'in' }, 'generator') });
  if (prob.kind === 'energy' && n?.type === 'generator') {
    const s = R?.nodes[n.id];
    if (s?.capacity > 0 && s.request > s.capacity * (1 + 1e-7)) {
      const N = Math.ceil((n.count ?? 1) * s.request / s.capacity - 1e-7);
      out.push({ label: `${$t('Генераторов')} ${n.count ?? 1} → ${N}`, edit: q => { findNode(q, n.id).count = N; } });
    }
  }
  if (prob.kind === 'energy' && prob.edge) {
    const e = findEdge(p, prob.edge), s = R?.edges[prob.edge];
    const E = app.energyData;
    if (!E) app.loadEnergy().then(() => app.props.render()).catch(() => {});
    const kinds = new Set((s?.warnings || []).map(w => w.kind));
    if (E && e && s && (kinds.has('overvolt') || kinds.has('overamp') || kinds.has('drop'))) {
      const c = cableFor(E, s.V, s.ampsPeak || 0);
      if (c && c.id !== e.cable?.id) out.push({ label: `${$t('Кабель →')} ${nm(c)} (${num(c.voltage)} ${$t('В')}, ${num(c.amps)} ${$t('А')})`, edit: q => {
        const x = findEdge(q, e.id);
        x.cable = { kind: c.kind || 'item', id: c.id, name: c.name, nameRu: c.nameRu, icon: c.icon, loss: c.loss, amps: c.amps, voltage: c.voltage, tier: c.tier, insulated: c.insulated, size: c.size };
      } });
    }
    if (kinds.has('explode') && e) {
      const m = findNode(p, e.to.node);
      const t = TIER_V.findIndex(v => v >= s.Vd);
      if (m?.type === 'machine' && t >= 0) out.push({ label: `«${nodeLabel(p, m.id)}»: ${$t('уровень →')} ${TIERS[t]}`, edit: q => { const x = findNode(q, m.id); x.tier = t; delete x.oc; } });
    }
  }
  if (!out.length && (prob.node || prob.edge)) out.push(prob.edge ? { label: $t('Показать'), selectEdge: prob.edge } : { label: $t('Показать'), select: prob.node });
  return out;
}

/** Apply a fix produced by fixesFor (or machine-view suggestions). */
export function applyFix(app, f) {
  if (f.edit) { app.mutate(f.edit); app.toast($t('Исправлено — схема пересчитана. Отменить: Ctrl+Z')); return; }
  if (f.run) return f.run(app);
  if (f.enter) return app.enterBlock(f.enter);
  if (f.selectEdge) return app.select({ type: 'edge', id: f.selectEdge });
  if (f.select) return app.select({ type: 'node', id: f.select });
}

