// Planning by target: "this output must make X per second" → how many machines every
// machine node needs and how much each source must supply.
//
// Method (all numbers come from the solver, nothing is estimated):
//  1. Machine counts are treated as continuous and sources as unlimited. Each round the line
//     is solved and every machine gets the count that covers what its consumers ask for at
//     their current size (fixes.requiredRate, which respects fixed % shares); the target
//     output asks for at least the target rate. Demand flows upstream one step per round, so
//     a chain of N machines settles in about N rounds. Recycled streams are not "asked for"
//     (an unlimited source covers them), so loops do not inflate the counts.
//  2. Counts are rounded up to whole machines.
//  3. With the exact counts, each source rate is set to what the line actually takes from it and
//     the line is solved again until the rates settle (recycled material then covers its part).
//  4. The rounded counts with those source rates are solved once more: that is the plan's result.
//  Generators (energy on): each gets enough units to cover the full-load request of the rounded
//  machines it powers, cable losses included, so the line never browns out.
// Machines that feed nothing with a finite demand (only storage) keep their counts. Blocks
// are not resized.
import { solve } from './solver.js';
import { requiredRate } from './fixes.js';
import { ports, energyOn } from './model.js';

const BIG = 1e12;
const clone = p => JSON.parse(JSON.stringify(p));

/** Rate one machine of node n makes on output port pid (per second), or 0. */
function perMachineRate(p, R, n, pid) {
  const mp = R.nodes[n.id]?.params;
  const pt = ports(p, n).find(x => x.id === pid);
  if (!mp?.perMachine || !pt?.entry) return 0;
  return pt.entry.amount * (pt.entry.probability ?? 1) * mp.perMachine;
}

/**
 * @param p      schematic (top level)
 * @param target { node, port, rate } — rate per second
 * @returns { rows, sources, achieved, before, euBefore, euAfter, converged, blocks, error }
 */
export function planForTarget(p, target, { maxRounds = 200 } = {}) {
  const t = p.nodes.find(n => n.id === target?.node);
  if (!t || t.type !== 'machine') return { error: 'notarget' };
  const q = clone(p);
  const before = solve(p);
  const tPer = perMachineRate(p, before, t, target.port);
  if (!(tPer > 0)) return { error: 'norate' };
  for (const n of q.nodes) if (n.type === 'source') n.rate = BIG;
  const machines = q.nodes.filter(n => n.type === 'machine');
  const exact = new Map(machines.map(n => [n.id, n.count ?? 1]));
  const fixed = new Set();
  let converged = false, R = null;
  for (let k = 0; k < maxRounds; k++) {
    for (const n of machines) n.count = exact.get(n.id);
    R = solve(q);
    let delta = 0;
    for (const n of machines) {
      const s = R.nodes[n.id];
      if (!s?.params?.perMachine) { fixed.add(n.id); continue; }
      let need = 0, any = false;
      for (const pid of Object.keys(s.outputs || {})) {
        if (s.outputs[pid].energy) continue;
        const per = perMachineRate(q, R, n, pid);
        if (!(per > 0)) continue;
        let T = requiredRate(q, R, n.id, pid);
        if (n.id === target.node && pid === target.port) T = Math.max(T === Infinity ? 0 : T, target.rate);
        if (!(T > 0) || T === Infinity) continue;
        any = true;
        need = Math.max(need, T / per);
      }
      if (!any) { fixed.add(n.id); continue; }
      fixed.delete(n.id);
      const old = exact.get(n.id);
      delta = Math.max(delta, Math.abs(need - old) / Math.max(1e-9, need, old));
      exact.set(n.id, need);
    }
    if (delta < 1e-9) { converged = true; break; }
  }
  // 2. whole machines
  const rows = [];
  for (const n of p.nodes.filter(x => x.type === 'machine')) {
    const x = exact.get(n.id);
    const keep = fixed.has(n.id);
    const count = keep ? (n.count ?? 1) : x > 1e-9 ? Math.max(1, Math.ceil(x - 1e-7)) : 0;
    rows.push({ id: n.id, old: n.count ?? 1, exact: keep ? null : x, count, keep, blocked: !R?.nodes[n.id]?.params?.perMachine });
  }
  const sized = clone(p);
  for (const r of rows) sized.nodes.find(n => n.id === r.id).count = r.count;
  // generators: full-load request of the rounded machines (sources unlimited)
  const gens = [];
  if (energyOn(p)) {
    const big = clone(sized);
    for (const n of big.nodes) if (n.type === 'source') n.rate = BIG;
    const G = solve(big);
    for (const n of p.nodes.filter(x => x.type === 'generator')) {
      const s = G.nodes[n.id], c = n.count ?? 1;
      const N = s?.capacity > 0 && s.request > 0 ? Math.max(1, Math.ceil(c * s.request / s.capacity - 1e-7)) : c;
      gens.push({ id: n.id, old: c, count: N, request: s?.request || 0, capacity: (s?.capacity || 0) / Math.max(1, c) * N });
      sized.nodes.find(x => x.id === n.id).count = N;
    }
  }
  // 3. source rates, from the exact (unrounded) counts: rounded-up machines would otherwise
  //    run flat out and over-produce. Start unlimited, then set each source to what it
  //    delivers until stable (recycled material takes over its share).
  const exactP = clone(p);
  for (const n of exactP.nodes) if (n.type === 'machine' && !fixed.has(n.id)) n.count = exact.get(n.id);
  for (const g of gens) exactP.nodes.find(x => x.id === g.id).count = g.count;
  const srcs = exactP.nodes.filter(n => n.type === 'source');
  for (const s of srcs) s.rate = BIG;
  const outOf = new Map(srcs.map(s => [s.id, exactP.edges.filter(e => e.from.node === s.id && !e.energy).map(e => e.id)]));
  for (let k = 0; k < 400; k++) {
    const S = solve(exactP);
    let delta = 0;
    for (const s of srcs) {
      const used = outOf.get(s.id).reduce((a, id) => a + (S.edges[id]?.flow || 0), 0);
      delta = Math.max(delta, Math.abs(used - s.rate) / Math.max(1e-12, used, s.rate === BIG ? used : s.rate));
      s.rate = used;
    }
    if (delta < 1e-9) break;
  }
  // a source that only feeds storage has no finite need (null)
  const sources = p.nodes.filter(n => n.type === 'source').map(n => {
    const v = exactP.nodes.find(x => x.id === n.id).rate;
    return { id: n.id, res: n.resource, old: n.rate, need: v >= BIG * 1e-3 ? null : v };
  });
  for (const s of sources) sized.nodes.find(x => x.id === s.id).rate = s.need ?? s.old;
  // achieved with the rounded counts and the required source rates
  const A = solve(sized);
  const out = A.nodes[target.node]?.outputs?.[target.port];
  // and with the sources left as they are
  const keepSrc = clone(p);
  for (const r of rows) keepSrc.nodes.find(n => n.id === r.id).count = r.count;
  for (const g of gens) keepSrc.nodes.find(x => x.id === g.id).count = g.count;
  const K = solve(keepSrc);
  const eu = Rx => Object.values(Rx.nodes).reduce((a, s) => a + (s.type === 'machine' ? s.powerFull || 0 : 0), 0);
  return {
    rows, sources, gens, converged, achieved: out?.actual ?? 0, max: out?.max ?? 0,
    achievedKeep: K.nodes[target.node]?.outputs?.[target.port]?.actual ?? 0,
    before: before.nodes[target.node]?.outputs?.[target.port]?.actual ?? 0,
    euBefore: eu(before), euAfter: eu(A),
    blocks: p.nodes.filter(n => n.type === 'group').map(n => n.id),
  };
}
