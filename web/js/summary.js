// Totals for a schematic, a block or a set of selected nodes: machines, power, generation,
// fuel burned, and what enters and leaves the set. Everything is read from solver results;
// nothing is estimated here.
import { energyOn, isEnergyRes, recipeOf } from './model.js';
import { mname } from './fmt.js';

/**
 * @param p   schematic (root or a block's inner)
 * @param R   solver results for `p`
 * @param ids node ids to total, or null for the whole schematic
 */
export function summarize(p, R, ids = null) {
  const S = ids ? new Set(ids) : new Set(p.nodes.map(n => n.id));
  const out = {
    nodes: 0, machines: 0, machineTypes: new Map(), generators: 0,
    powerFull: 0, powerAvg: 0, generated: 0, capacity: 0, losses: 0, powerIn: 0, powerOut: 0,
    fuel: new Map(), inputs: new Map(), outputs: new Map(), energy: energyOn(p),
  };
  const add = (map, res, v, extra) => {
    if (!res?.id || !(v > 0)) return;
    const k = res.id;
    if (!map.has(k)) map.set(k, { res, rate: 0, loose: 0 });
    const x = map.get(k);
    x.rate += v;
    if (extra?.to === 'unconnected' || extra?.to === 'unrouted') x.loose += v; // produced but goes nowhere
  };
  // machines, generators and fuel, recursing into blocks
  const deep = (q, Rq, top) => {
    for (const n of q.nodes) {
      if (top && !S.has(n.id)) continue;
      const s = Rq?.nodes[n.id];
      if (n.type === 'group') { deep(n.inner, s?.innerR, false); continue; }
      if (n.type === 'machine') {
        const c = n.count ?? 1;
        out.machines += c;
        const name = mname(recipeOf(q, n)?.machine) || '?';
        out.machineTypes.set(name, (out.machineTypes.get(name) || 0) + c);
      }
      if (n.type === 'generator' && energyOn(q)) {
        out.generators += n.count ?? 1;
        out.generated += s?.output || 0;
        out.capacity += s?.capacity || 0;
        if (n.fuel?.res && s) {
          const k = n.fuel.res.id;
          if (!out.fuel.has(k)) out.fuel.set(k, { res: n.fuel.res, rate: 0, full: 0 });
          const f = out.fuel.get(k);
          f.rate += s.fuelUsed || 0; f.full += s.fuelFull || 0;
        }
      }
    }
    if (energyOn(q)) for (const e of q.edges) {
      if (!e.energy || (top && !(S.has(e.from.node) && S.has(e.to.node)))) continue;
      out.losses += Rq?.edges[e.id]?.loss || 0;
    }
  };
  deep(p, R, true);
  // power of the top-level nodes (a block reports its own total)
  for (const id of S) {
    const s = R?.nodes[id];
    if (!s) continue;
    out.nodes++;
    out.powerFull += s.powerFull || 0;
    out.powerAvg += s.powerAvg || 0;
  }
  // what enters and leaves the set
  for (const n of p.nodes) {
    if (!S.has(n.id)) continue;
    const s = R?.nodes[n.id];
    if (!s) continue;
    // what actually flows out of a source or a block input (not its nominal rate)
    if (n.type === 'source' || n.type === 'gin') for (const e of p.edges) if (e.from.node === n.id) add(out.inputs, R.edges[e.id]?.resource, R.edges[e.id]?.flow, { from: 'source' });
    if (n.type === 'sink') for (const e of p.edges) if (e.to.node === n.id) add(out.outputs, R.edges[e.id]?.resource, R.edges[e.id]?.flow, { to: 'sink' });
    if (n.type === 'gout' && !isEnergyRes(n.resource)) add(out.outputs, n.resource, s.inputs.in?.used, { to: 'block' });
    if (n.type === 'gout' && isEnergyRes(n.resource)) out.powerOut += s.powerAvg || 0;
    if (n.type === 'machine' || n.type === 'group' || n.type === 'generator') {
      for (const x of Object.values(s.outputs || {})) {
        if (x.energy) continue;
        if (!x.connected) add(out.outputs, x.res, x.actual, { to: 'unconnected' });
        else add(out.outputs, x.res, x.unrouted, { to: 'unrouted' });
      }
    }
  }
  for (const e of p.edges) {
    const a = S.has(e.from.node), b = S.has(e.to.node);
    if (a === b) continue;
    const s = R?.edges[e.id];
    if (!s) continue;
    if (e.energy) { if (b) out.powerIn += s.flow || 0; else out.powerOut += s.flow || 0; continue; }
    if (b) add(out.inputs, s.resource, s.flow, { from: 'link' });
    else add(out.outputs, s.resource, s.flow, { to: 'link' });
  }
  const sorted = m => [...m.values()].sort((x, y) => y.rate - x.rate);
  return { ...out, fuel: sorted(out.fuel), inputs: sorted(out.inputs), outputs: sorted(out.outputs),
    machineTypes: [...out.machineTypes].sort((a, b) => b[1] - a[1]) };
}
