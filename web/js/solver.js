// Throughput solver. Pure function of the project; all rates are per second.
//
// Model
//  * machine: capacity = count × parallel × 20 / durationTicks cycles/s. Overclocks follow
//    GT 5.09.51 exactly (overclock.js): a single block overclocks once per voltage tier above
//    the recipe (duration ÷2, or ÷4 "perfect"; EU/t ×4; not below 1 tick). A multiblock
//    (n.multi) overclocks by the power of its energy hatches, runs parallels, applies its
//    speed / EU bonuses and, for heat recipes, coil heat (EU discount and ÷4 heat overclocks).
//    Utilisation u = min(1, supplied/need) over consumed inputs. Outputs =
//    amount × probability × cycles × u (expected value).
//  * edge demand  = what the consumer would take at full capacity (sink = ∞;
//    splitter/merger pass downstream demand through).
//  * edge offered = what the producer port sends by its allocation rule: fixed % first,
//    the rest to "auto" edges proportionally to demand, excess to sinks, otherwise pushed
//    to auto edges as surplus.
//  * edge flow    = what the consumer actually uses; surplus = offered − flow,
//    deficit = demand − offered.
//
// Loops (recycling): the equations of a closed loop have a trivial solution "nothing
// circulates" (no Mg → no reaction → no Mg). In the game a loop runs once it has been
// seeded, so by default ("primed") the iteration starts from full capacity and converges
// down to the largest self-consistent steady state. "cold" starts from zero and shows what
// happens without an initial stock. Acyclic lines give the same result in both modes.
//
// Energy (optional, p.energy.enabled): a generator node outputs up to V × A × count EU/t
// and burns fuel only for the EU actually drawn. An energy link carries EU from a
// generator to a machine through `length` blocks of a cable; every amp packet loses
// cable.loss EU per block, so the machine receives Vd = V − loss·length per amp and the
// generator must send need × V / Vd. Power is delivered on demand, as in a GT network:
// each machine asks for what it would draw at its current material-limited load, and only
// when the generator cannot cover all requests are they scaled down proportionally. A
// machine's load is then also limited by delivered / needed EU. Machines without an energy
// link are reported, not stopped.
//
// Blocks (node type "group"): a block is solved by running its inner schematic, with the
// block's inputs ("gin") turned into sources that deliver exactly what the outer line
// supplies, and its outputs ("gout") turned into sinks. So a block is not a linear
// approximation: whatever the inner line makes from the given inputs is what comes out.
// Its demand ("needs at full capacity") is the inner line run with unlimited inputs.
// Inner machines without an energy link are powered through the block's ⚡ input; when that
// input is short they slow down by the delivered/needed ratio. Energy outputs of a block are
// inner generators linked to an energy "gout"; the block then acts as a generator outside.
import { $t, lbl, uiLang } from './i18n.js';
import { ports, recipeOf, ENERGY, energyOn, isEnergyRes } from './model.js';
import { TIER_V, nm, mname } from './fmt.js';
import { singleOc, multiOc, ebfHeat } from './overclock.js';

const ITER = 3000;
const BIG = 1e12;          // "unlimited" supply of a block input (per second)
const EOUT = '__block_energy_out';

/** Inner schematic of a block prepared for solving (gin → source, gout → sink / energy consumer). */
function blockProject(inner, supply, EON, eReq) {
  const q = { ...inner, energy: { enabled: EON }, recipes: { ...inner.recipes }, nodes: [], edges: [] };
  const eGouts = new Set();
  for (const n of inner.nodes) {
    if (n.type === 'gin') q.nodes.push({ id: n.id, type: 'source', label: n.label, resource: n.resource, x: n.x, y: n.y, rate: !n.resource ? 0 : supply == null ? BIG : Math.max(0, supply[n.id] || 0), gin: true });
    else if (n.type === 'gout' && isEnergyRes(n.resource)) {
      eGouts.add(n.id);
      q.nodes.push({ id: n.id, type: 'machine', recipeId: EOUT, count: 1, tier: 13, x: n.x, y: n.y, label: n.label, synthetic: true });
    } else if (n.type === 'gout') q.nodes.push({ id: n.id, type: 'sink', label: n.label, x: n.x, y: n.y, gout: true });
    else q.nodes.push(n);
  }
  const want = !Number.isFinite(eReq) ? 1e15 : Math.max(0, eReq || 0);
  q.recipes[EOUT] = { id: EOUT, dataset: 'block', machine: { name: 'Block energy output' }, inputs: [], outputs: [], gt: { durationTicks: 20, eut: want, tier: 13, metadata: [] } };
  for (const e of inner.edges) q.edges.push(eGouts.has(e.to.node) ? { ...e, to: { node: e.to.node, port: 'ep' } } : e);
  return { q, eGouts };
}

/**
 * Run a block's inner line for given input supplies (null = unlimited), the EU/t its ⚡ input
 * delivers (Infinity = unlimited; inner machines share it on demand) and the energy request
 * on its ⚡ output.
 */
function runBlock(n, supply, eBudget, eReq, EON, mode, analyze = false) {
  const { q, eGouts } = blockProject(n.inner, supply, EON, eReq);
  const R = solve(q, { mode, analyzeLoops: analyze, blockBudget: EON ? eBudget : null });
  const used = {}, out = {};
  let G = 0, eNeed = 0, eNeedFull = 0, eReqNow = 0, tier = 0, eV = 0, uSum = 0, uN = 0, powerFull = 0, powerAvg = 0;
  const linked = new Set(q.edges.filter(e => e.energy).map(e => e.to.node));
  for (const x of q.nodes) {
    const s = R.nodes[x.id];
    if (!s) continue;
    if (x.gin) used[x.id] = q.edges.filter(e => e.from.node === x.id).reduce((a, e) => a + (R.edges[e.id]?.flow || 0), 0);
    else if (x.gout) out[x.id] = s.inputs.in?.used || 0;
    else if (eGouts.has(x.id)) {
      G += s.powerAvg || 0;
      for (const e of q.edges) if (e.energy && e.to.node === x.id) eV = Math.max(eV, R.edges[e.id]?.V || 0);
    } else {
      if (x.type === 'machine' || x.type === 'group') {
        powerFull += s.powerFull || 0; powerAvg += s.powerAvg || 0;
        if (s.util != null) { uSum += s.util * (x.count ?? 1); uN += x.count ?? 1; }
        if (!linked.has(x.id) && s.energyNeed > 0) {
          eNeedFull += s.energyNeed; eNeed += s.energyNeed * (s.util || 0); eReqNow += s.energyRequest ?? s.energyNeed;
          tier = Math.max(tier, s.params?.tier ?? 0);
        }
      }
    }
  }
  return { R, q, used, out, G, eV, eNeed, eNeedFull, eReqNow, tier, util: uN ? uSum / uN : null, powerFull, powerAvg };
}

/** Results of a block's inner schematic as seen from inside (for the editor). ctx comes from the parent results. */
export function solveBlock(n, ctx, EON, mode = 'primed') {
  const run = runBlock(n, ctx?.full ? null : (ctx?.supply || {}), ctx?.full ? Infinity : (ctx?.eBudget ?? Infinity), ctx?.full ? Infinity : (ctx?.eReq ?? 0), EON, mode, true);
  return run.R;
}
const tol = (...v) => 1e-7 * Math.max(1, ...v.filter(Number.isFinite).map(Math.abs));

/** Recipe tier index (LV = 0) from the export, or derived from EU/t for user recipes. */
export function recipeTier(r) {
  const gt = r?.gt;
  if (gt?.tier != null) return gt.tier;
  if (gt?.eut != null) { const i = TIER_V.findIndex(v => v >= gt.eut); return i < 0 ? TIER_V.length - 1 : i; }
  return 0;
}

/** Machine tier of a node (migrates old `oc` field). A multiblock's tier is its energy hatch tier,
 * which may be below the recipe tier (several hatches add up). */
export function machineTier(n, r) {
  const rt = recipeTier(r);
  const t = n.tier != null ? n.tier : rt + (n.oc || 0);
  return Math.max(n.multi ? 0 : rt, Math.min(TIER_V.length - 1, t));
}

export const EBF_ID = 'i:gregtech:gt.blockmachines:1000';
/** Heat a recipe needs (GT coil_heat metadata = the recipe's special value), or null. */
export function recipeHeat(r) {
  const m = (r?.gt?.metadata || []).find(x => x.key === 'coil_heat');
  return m ? m.value : null;
}
/** Heat of the multiblock of node n: the EBF formula, or what the user entered; null when unknown. */
export function machineHeat(n, r) {
  if (!n.multi || recipeHeat(r) == null) return null;
  if (n.multi === EBF_ID) return n.coil != null ? ebfHeat(n.coil, machineTier(n, r), n.hatches) : null;
  return n.heat > 0 ? +n.heat : null;
}

export function machineParams(n, r) {
  const gt = r?.gt || null;
  const rt = recipeTier(r);
  const tier = machineTier(n, r);
  let ticks = gt?.durationTicks ?? null;
  let eut = gt?.eut ?? null;
  let ocs = 0, parallel = 1, multi = null;
  if (gt && n.multi) {
    const rh = recipeHeat(r), mh = machineHeat(n, r);
    const ebf = n.multi === EBF_ID;
    multi = multiOc(eut, ticks, {
      tier, hatches: n.hatches, perfect: !!n.perfectOc,
      parallel: ebf ? 1 : n.parallel, speedPct: ebf ? 0 : n.speedPct, euPct: ebf ? 100 : n.euPct,
      heat: rh != null && mh != null ? { recipe: rh, machine: mh } : null,
    });
    multi.recipeHeat = rh; multi.machineHeat = mh; multi.heatUnknown = rh != null && mh == null;
    ({ ticks, eut, ocs, parallel } = multi);
  } else if (gt && ticks != null) {
    ({ ticks, eut, ocs } = singleOc(eut, ticks, tier, !!n.perfectOc));
  } else if (gt && eut != null) {
    eut = singleOc(eut, null, tier, !!n.perfectOc).eut;
  }
  let perMachine = null; // cycles per second for one machine (one cycle = one recipe run)
  let override = false;
  if (n.cycleOverride > 0) { perMachine = n.cycleOverride / 60; override = true; }
  else if (multi?.blocked) perMachine = 0;
  else if (ticks) perMachine = 20 / ticks * parallel;
  const count = Math.max(0, n.count ?? 1);
  return { ticks, eut, tier, recipeTier: rt, ocs, parallel, multi, perMachine, override, count, cycles: perMachine == null ? null : perMachine * count };
}

/** Generator parameters: capacity EU/t and effective EU per unit of fuel. */
export function genParams(n) {
  const V = Math.max(0, +n.voltage || 0), A = Math.max(0, +n.amps || 0), count = Math.max(0, n.count ?? 1);
  const eff = n.efficiency != null && n.efficiency !== '' ? Math.max(0, +n.efficiency) / 100 : 1;
  const fuel = n.fuel?.res ? n.fuel : null;
  const eu = fuel && +fuel.euPerUnit > 0 ? +fuel.euPerUnit : null;
  const euEff = eu == null ? null : eu * (fuel.efficiencyIncluded ? 1 : eff);
  return { V, A, count, eff, cap: V * A * count, fuel, euEff };
}

/** Voltage drop of an energy link. */
export function linkParams(e, V) {
  const len = Math.max(0, +e.length || 0);
  const loss = e.cable ? Math.max(0, +e.cable.loss || 0) : 0;
  const drop = loss * len;
  return { len, loss, drop, Vd: Math.max(0, V - drop) };
}

export function solve(p, opts = {}) {
  const mode = opts.mode || p.loopMode || 'primed';
  const key = (n, pt) => n + '|' + pt;
  const inE = new Map(), outE = new Map();
  const EON = energyOn(p);
  const byId = new Map(p.nodes.map(n => [n.id, n]));
  const medges = p.edges.filter(e => !e.energy);
  for (const e of medges) {
    const a = key(e.to.node, e.to.port), b = key(e.from.node, e.from.port);
    if (!inE.has(a)) inE.set(a, []);
    if (!outE.has(b)) outE.set(b, []);
    inE.get(a).push(e); outE.get(b).push(e);
  }
  const nodeInfo = new Map();
  const blockCache = new Map();
  const evalBlock = (n, supply, eBudget, eReq) => {
    const k = n.id + JSON.stringify([supply, Number.isFinite(eBudget) ? eBudget : 'inf', eReq]);
    if (!blockCache.has(k)) {
      if (blockCache.size > 4000) blockCache.clear();
      blockCache.set(k, runBlock(n, supply, eBudget, eReq, EON, mode));
    }
    return blockCache.get(k);
  };
  for (const n of p.nodes) {
    const r = recipeOf(p, n);
    let ps = ports(p, n);
    let mp = n.type === 'machine' ? machineParams(n, r) : null;
    let gp = n.type === 'generator' ? genParams(n) : null;
    let profile = null;
    if (n.type === 'group') {
      // full capacity: unlimited inputs, full power, unlimited energy request
      profile = evalBlock(n, null, Infinity, Infinity);
      ps = ps.map(pt => pt.energy ? pt : { ...pt, entry: { ...pt.res, amount: (pt.dir === 'in' ? profile.used[pt.id] : profile.out[pt.id]) || 0, probability: 1 } });
      mp = { cycles: 1, count: 1, perMachine: 1, eut: profile.eNeedFull, ticks: 20, tier: profile.tier, recipeTier: profile.tier, ocs: 0, override: false, block: true };
      if (ps.some(pt => pt.id === 'eo')) gp = { V: profile.eV, A: 1, count: 1, eff: 1, cap: profile.G, fuel: null, euEff: null, block: true };
    }
    nodeInfo.set(n.id, { n, r, ps, mp, gp, profile });
  }
  const eedges = EON ? p.edges.filter(e => e.energy && nodeInfo.get(e.from.node)?.gp && ['machine', 'group'].includes(byId.get(e.to.node)?.type)) : [];
  // ---- energy: static requests (what each link must carry at full machine load)
  const eLink = new Map();      // edge id -> {V, Vd, drop, req (EU/t at machine), reqSrc (EU/t at generator)}
  const eIn = new Map(), eOut = new Map(); // machine id / generator id -> energy edges
  for (const e of eedges) {
    if (!eIn.has(e.to.node)) eIn.set(e.to.node, []);
    if (!eOut.has(e.from.node)) eOut.set(e.from.node, []);
    eIn.get(e.to.node).push(e); eOut.get(e.from.node).push(e);
  }
  const eNeed = id => { const mp = nodeInfo.get(id).mp; return mp?.eut > 0 ? mp.eut * mp.count : 0; };
  for (const [mid, list] of eIn) {
    const caps = list.map(e => nodeInfo.get(e.from.node).gp.cap);
    const tot = caps.reduce((a, b) => a + b, 0);
    list.forEach((e, i) => {
      const g = nodeInfo.get(e.from.node).gp;
      const lp = linkParams(e, g.V);
      const req = eNeed(mid) * (tot > 0 ? caps[i] / tot : 1 / list.length);
      eLink.set(e.id, { ...lp, V: g.V, req, reqSrc: lp.Vd > 0 ? req * g.V / lp.Vd : 0 });
    });
  }
  for (const info of nodeInfo.values()) {
    if (!info.gp) continue;
    const g = info.gp;
    const reqSrc = (eOut.get(info.n.id) || []).reduce((s, e) => s + eLink.get(e.id).reqSrc, 0);
    g.reqSrc = reqSrc;
    g.fullOut = Math.min(g.cap, reqSrc);
    g.fuelFull = g.euEff ? g.fullOut * 20 / g.euEff : 0; // fuel units per second at full draw
    if (info.n.type === 'generator') info.mp = { cycles: EON ? g.fuelFull : 0, count: g.count };
  }
  const eState = { deliv: new Map(), use: new Map(), draw: new Map(), gen: new Map(), ratio: new Map(), cut: new Map() };
  const need = (info, pt) => (!info.mp || info.mp.cycles == null) ? 0 : pt.entry.amount * info.mp.cycles;
  const sumOf = (list, m) => list.reduce((s, e) => s + m.get(e.id), 0);
  const consumer = t => t === 'machine' || t === 'generator' || t === 'group';
  // EU/t actually drawn: a machine at its load; a block draws what its inner machines take
  const actualEU = id => nodeInfo.get(id).n.type === 'group' ? (blockEval.get(id)?.eNeed ?? 0) : eNeed(id) * (util.get(id) || 0);
  const blockEval = new Map(), blockAvail = new Map(), blockCtx = new Map();
  // what a consumer would draw if energy were unlimited (its load from materials alone);
  // generators serve these requests, so power a starved machine does not take goes to the others
  const matU = new Map(), blockReq = new Map();
  const eRequest = id => {
    const N = eNeed(id);
    if (!(N > 0)) return 0;
    const r = nodeInfo.get(id).n.type === 'group' ? blockReq.get(id) : (matU.has(id) ? N * matU.get(id) : undefined);
    return r == null ? N : Math.max(0, Math.min(N, r));
  };

  // ---- demand pass (uses current offered for splitting between parallel feeders)
  function demandPass(offered, demand) {
    const nd = new Map();
    for (const info of nodeInfo.values()) {
      const { n, ps } = info;
      for (const pt of ps) {
        if (pt.dir !== 'in') continue;
        const list = inE.get(key(n.id, pt.id)) || [];
        if (!list.length) continue;
        let D;
        if (consumer(n.type)) D = need(info, pt);
        else if (n.type === 'sink') D = Infinity;
        else D = sumOf(outE.get(key(n.id, 'out')) || [], demand);
        const sumOff = sumOf(list, offered);
        for (const e of list) {
          const share = sumOff > 1e-12 ? offered.get(e.id) / sumOff : 1 / list.length;
          nd.set(e.id, D === Infinity ? Infinity : D * share);
        }
      }
    }
    return new Map(medges.map(e => [e.id, nd.get(e.id) ?? 0]));
  }

  const util = new Map();
  const portSupply = new Map();
  // ---- supply pass
  // energy available per generator (limited by capacity and fuel supplied), delivered per link
  function energyPass(offered) {
    eState.deliv.clear(); eState.ratio.clear();
    for (const info of nodeInfo.values()) {
      const g = info.gp;
      if (!g) continue;
      let fr = 1;
      if (g.fuel && g.euEff && g.fuelFull > 0) fr = Math.min(1, sumOf(inE.get(key(info.n.id, 'f')) || [], offered) / g.fuelFull);
      const avail = g.block ? Math.min(g.fullOut, blockAvail.get(info.n.id) ?? g.fullOut) : g.fullOut * fr;
      // current requests at the generator side (full-load request scaled to what the machine would draw now)
      const links = eOut.get(info.n.id) || [];
      const reqNow = links.map(e => { const L = eLink.get(e.id), N = eNeed(e.to.node); return N > 0 ? L.reqSrc * eRequest(e.to.node) / N : 0; });
      const tot = reqNow.reduce((a, b) => a + b, 0);
      const k = tot > avail ? avail / tot : 1;
      eState.cut.set(info.n.id, { fr, k });
      links.forEach((e, i) => {
        const L = eLink.get(e.id);
        eState.deliv.set(e.id, L.V > 0 ? reqNow[i] * k * L.Vd / L.V : 0);
      });
    }
    // a machine's ratio is delivered / full need (it caps the load directly); a block's ratio is
    // delivered / requested — the share of its current request it gets, passed to its inside
    for (const [mid, list] of eIn) {
      const D = list.reduce((s, e) => s + eState.deliv.get(e.id), 0);
      const grp = nodeInfo.get(mid).n.type === 'group';
      const N = grp ? eRequest(mid) : eNeed(mid);
      eState.ratio.set(mid, N > 1e-12 ? Math.min(1, D / N) : 1);
    }
    // inside a block: machines without their own energy link run on the block's ⚡ input, which
    // covers this share of what they ask for (on demand, like a generator)
    eState.blockK = 1;
    if (opts.blockBudget != null) {
      const list = [...nodeInfo.values()].filter(i => (i.n.type === 'machine' || i.n.type === 'group') && !eIn.has(i.n.id) && eNeed(i.n.id) > 0);
      const tot = list.reduce((a, i) => a + eRequest(i.n.id), 0);
      const kb = eState.blockK = tot > opts.blockBudget ? opts.blockBudget / tot : 1;
      for (const { n } of list) eState.ratio.set(n.id, n.type === 'group' ? kb : Math.min(1, eRequest(n.id) * kb / eNeed(n.id)));
    }
  }
  // actual EU use per link and generator output / fuel use, after machine loads are known
  function energyUse() {
    eState.use.clear(); eState.draw.clear(); eState.gen.clear();
    for (const [mid, list] of eIn) {
      const used = actualEU(mid);
      const tot = list.reduce((s, e) => s + eState.deliv.get(e.id), 0);
      for (const e of list) {
        const L = eLink.get(e.id);
        const u = tot > 0 ? used * eState.deliv.get(e.id) / tot : 0;
        eState.use.set(e.id, u);
        eState.draw.set(e.id, L.Vd > 0 ? u * L.V / L.Vd : 0);
      }
    }
    for (const info of nodeInfo.values()) {
      if (!info.gp) continue;
      const out = (eOut.get(info.n.id) || []).reduce((s, e) => s + eState.draw.get(e.id), 0);
      eState.gen.set(info.n.id, { out, fuel: info.gp.euEff ? out * 20 / info.gp.euEff : 0 });
    }
  }
  const order = [...nodeInfo.values()].sort((a, b) => (a.gp ? 1 : 0) - (b.gp ? 1 : 0)); // generators last
  // material-limited load of every machine for the current link values (its power request)
  function materialLoads(offered) {
    for (const info of nodeInfo.values()) {
      const { n, ps, mp } = info;
      if (n.type !== 'machine' || !mp || mp.cycles == null) continue;
      let u = 1;
      for (const pt of ps) {
        if (pt.dir !== 'in' || pt.energy) continue;
        const nv = need(info, pt);
        if (nv > 0) u = Math.min(u, sumOf(inE.get(key(n.id, pt.id)) || [], offered) / nv);
      }
      matU.set(n.id, u);
    }
  }
  function supplyPass(offered, demand) {
    const no = new Map(medges.map(e => [e.id, 0]));
    materialLoads(offered);
    energyPass(offered);
    let usedDone = false;
    for (const info of order) {
      const { n, ps, mp } = info;
      const sup = {};
      if (info.gp && !usedDone) { energyUse(); usedDone = true; }
      if (n.type === 'source') sup.out = Math.max(0, n.rate || 0);
      else if (n.type === 'splitter' || n.type === 'merger') sup.out = sumOf(inE.get(key(n.id, 'in')) || [], offered);
      else if (n.type === 'machine') {
        let u = mp && mp.cycles != null ? 1 : 0;
        if (mp && mp.cycles != null) {
          for (const pt of ps) {
            if (pt.dir !== 'in' || pt.energy) continue;
            const nv = need(info, pt);
            if (nv <= 0) continue;
            u = Math.min(u, sumOf(inE.get(key(n.id, pt.id)) || [], offered) / nv);
          }
          if (eState.ratio.has(n.id)) u = Math.min(u, eState.ratio.get(n.id));
        }
        util.set(n.id, u);
        for (const pt of ps) {
          if (pt.dir !== 'out' || pt.energy) continue;
          sup[pt.id] = mp && mp.cycles != null ? pt.entry.amount * (pt.entry.probability ?? 1) * mp.cycles * u : 0;
        }
      } else if (n.type === 'group') {
        const supply = {};
        let u = 1, any = false;
        for (const pt of ps) {
          if (pt.dir !== 'in' || pt.energy) continue;
          supply[pt.id] = sumOf(inE.get(key(n.id, pt.id)) || [], offered);
          const nv = need(info, pt);
          if (nv > 0) { any = true; u = Math.min(u, supply[pt.id] / nv); }
        }
        const er = eState.ratio.get(n.id) ?? 1;
        const eReq = info.gp ? (eOut.get(n.id) || []).reduce((s, e) => s + (eState.draw.get(e.id) || 0), 0) : 0;
        // EU/t the block's ⚡ input delivers: its links, its share of an outer block's input, or unlimited
        const eBudget = !EON ? Infinity : eIn.has(n.id) ? eIn.get(n.id).reduce((a, e) => a + eState.deliv.get(e.id), 0)
          : opts.blockBudget != null && eState.ratio.has(n.id) ? eRequest(n.id) * er : Infinity;
        const ev = evalBlock(n, supply, eBudget, eReq);
        blockReq.set(n.id, ev.eReqNow);
        if (info.gp) blockAvail.set(n.id, evalBlock(n, supply, eBudget, info.gp.fullOut).G);
        blockEval.set(n.id, ev);
        blockCtx.set(n.id, { supply, eBudget, eRatio: er, eReq });
        util.set(n.id, any ? Math.max(0, Math.min(1, u * er)) : (ev.util ?? 1));
        for (const pt of ps) if (pt.dir === 'out' && !pt.energy) sup[pt.id] = ev.out[pt.id] || 0;
      } else if (n.type === 'generator') {
        const fuelUsed = EON ? (eState.gen.get(n.id)?.fuel || 0) : 0;
        for (const pt of ps) if (pt.dir === 'out' && !pt.energy) sup[pt.id] = pt.entry.amount * fuelUsed;
      }
      portSupply.set(n.id, sup);
      for (const [pid, S] of Object.entries(sup)) allocate(S, outE.get(key(n.id, pid)) || [], demand, no);
    }
    if (!usedDone) energyUse();
    return no;
  }

  let offered = new Map(medges.map(e => [e.id, 0]));
  let demand = demandPass(offered, new Map(medges.map(e => [e.id, 0])));
  for (let k = 0; k < 50; k++) demand = demandPass(offered, demand); // settle bus pass-through
  if (mode === 'primed') {
    // start from the top: every connection carries what its consumer can take
    const fin = [...demand.values()].filter(Number.isFinite);
    const cap = (fin.length ? Math.max(...fin) : 1) * 10 + 1;
    offered = new Map(medges.map(e => [e.id, Number.isFinite(demand.get(e.id)) ? demand.get(e.id) : cap]));
  }
  // Fixed-point iteration. Convergence is judged per link, relative to that link's own
  // value: a loop that is draining towards zero (e.g. cells that are not fully returned)
  // changes by the same fraction every step and must not be reported as "converged" just
  // because its numbers became small next to a 90 000 L/min stream elsewhere.
  // Such geometric decay/approach x(k+1) − x* = ρ·(x(k) − x*) is finished with an Aitken
  // extrapolation (exact for the linear regime). If the extrapolated point is not a fixed
  // point the iteration simply moves back towards one, so the result stays a true solution.
  const relDelta = (a, b) => {
    if (a === b) return 0;
    if (!Number.isFinite(a) || !Number.isFinite(b)) return a === b ? 0 : Infinity;
    return Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1e-300);
  };
  let iterations = 0, converged = false, prevStep = null, extrapolations = 0, ePrev = new Map();
  const absTiny = 1e-15 * Math.max(1, ...[...demand.values()].filter(Number.isFinite).map(Math.abs));
  for (; iterations < ITER; iterations++) {
    const nd = demandPass(offered, demand);
    const no = supplyPass(offered, nd);
    let delta = 0;
    for (const e of medges) {
      const v = no.get(e.id), o = offered.get(e.id);
      if (Math.max(Math.abs(v), Math.abs(o)) > absTiny) delta = Math.max(delta, relDelta(v, o));
      const a = nd.get(e.id), b = demand.get(e.id);
      if (Number.isFinite(a) && Number.isFinite(b) && Math.max(Math.abs(a), Math.abs(b)) > absTiny) delta = Math.max(delta, relDelta(a, b));
      else if (Number.isFinite(a) !== Number.isFinite(b)) delta = Infinity;
    }
    // power shares and block requests trail the link values; they must have settled too
    let eMove = 0;
    const eNow = new Map([...eState.ratio].concat([...blockReq].map(([k, v]) => ['req:' + k, v])));
    for (const [k, v] of eNow) eMove = Math.max(eMove, relDelta(v, ePrev.get(k) ?? NaN));
    ePrev = eNow;
    delta = Math.max(delta, eMove);
    const step = new Map(medges.map(e => [e.id, no.get(e.id) - offered.get(e.id)]));
    offered = no; demand = nd;
    if (delta <= 1e-12 && iterations > 0) { converged = true; break; }
    // Aitken: every link that still moves must shrink its step by the same steady ratio ρ
    if (prevStep && iterations > 8 && extrapolations < 50) {
      let rho = null, ok = true, moving = 0;
      for (const e of medges) {
        const d2 = step.get(e.id), d1 = prevStep.get(e.id);
        if (Math.abs(d2) <= absTiny && Math.abs(d1) <= absTiny) continue;
        if (Math.abs(d1) <= absTiny || d1 * d2 < 0) { ok = false; break; }
        const r = d2 / d1;
        if (r >= 0.999999 || (rho != null && Math.abs(r - rho) > 1e-6 * Math.max(1, rho))) { ok = false; break; }
        rho = r; moving++;
      }
      if (ok && moving && rho != null && eMove <= 1e-9) {
        const k = rho / (1 - rho);
        offered = new Map(medges.map(e => [e.id, Math.max(0, offered.get(e.id) + step.get(e.id) * k)]));
        extrapolations++;
        prevStep = null;
        continue;
      }
    }
    prevStep = step;
  }
  // clean numerical dust: anything 1e-12 below the largest stream of the line is zero
  // (scale = largest finite demand: what consumers really take, not an "unlimited" block input)
  const scaleAll = Math.max(1e-300, ...[...demand.values()].filter(Number.isFinite).map(Math.abs));
  for (const e of medges) if (Math.abs(offered.get(e.id)) < 1e-12 * scaleAll) offered.set(e.id, 0);
  // make node loads / port supplies consistent with the final link values
  demand = demandPass(offered, demand);
  supplyPass(offered, demand);
  if (!medges.length) converged = true;

  // ---- actual flow (what consumers use), backward fixed point
  let flow = new Map(medges.map(e => [e.id, offered.get(e.id)]));
  for (let k = 0; k < ITER; k++) {
    let delta = 0;
    const nf = new Map();
    for (const info of nodeInfo.values()) {
      const { n, ps } = info;
      for (const pt of ps) {
        if (pt.dir !== 'in') continue;
        const list = inE.get(key(n.id, pt.id)) || [];
        if (!list.length) continue;
        const sumOff = sumOf(list, offered);
        let used;
        if (n.type === 'machine') used = need(info, pt) * (util.get(n.id) || 0);
        else if (n.type === 'group') used = blockEval.get(n.id)?.used[pt.id] || 0;
        else if (n.type === 'generator') used = EON ? (eState.gen.get(n.id)?.fuel || 0) : 0;
        else if (n.type === 'sink') used = sumOff;
        else used = sumOf(outE.get(key(n.id, 'out')) || [], flow);
        used = Math.min(used, sumOff);
        for (const e of list) nf.set(e.id, sumOff > 1e-12 ? used * offered.get(e.id) / sumOff : 0);
      }
    }
    for (const e of medges) delta = Math.max(delta, Math.abs((nf.get(e.id) ?? 0) - flow.get(e.id)));
    flow = new Map(medges.map(e => [e.id, nf.get(e.id) ?? 0]));
    if (delta < 1e-12) break;
  }

  // ---- results
  const edges = {};
  for (const e of medges) {
    const d = demand.get(e.id), o = offered.get(e.id), f = flow.get(e.id);
    const deficit = d === Infinity ? 0 : Math.max(0, d - o);
    const surplus = Math.max(0, o - f);
    const t = tol(d, o);
    const fromInfo = nodeInfo.get(e.from.node);
    const res = fromInfo?.ps.find(x => x.id === e.from.port)?.res || null;
    edges[e.id] = {
      resource: res, demand: d, offered: o, flow: f,
      deficit: deficit > t ? deficit : 0, surplus: surplus > t ? surplus : 0,
      status: deficit > t ? 'deficit' : surplus > t ? 'surplus' : (o > t || d > t ? 'ok' : 'idle'),
    };
  }

  const problems = [];
  for (const e of p.edges) {
    if (!e.energy) continue;
    const L = eLink.get(e.id);
    if (!L) { edges[e.id] = { energy: true, resource: ENERGY, demand: 0, offered: 0, flow: 0, deficit: 0, surplus: 0, status: EON ? 'idle' : 'off', warnings: [] }; continue; }
    // d: what the link carries at full machine load; q: what the machine asks for now (its
    // material-limited load). A shortage is delivered < asked, not delivered < full need.
    const d = L.req, o = eState.deliv.get(e.id) || 0, f = eState.use.get(e.id) || 0, draw = eState.draw.get(e.id) || 0;
    const Nm = eNeed(e.to.node), q = Nm > 0 ? d * eRequest(e.to.node) / Nm : 0;
    const t = tol(d, o);
    const g = byId.get(e.from.node), m = byId.get(e.to.node);
    const s = edges[e.id] = {
      energy: true, resource: ENERGY, demand: d, request: q, offered: o, flow: f, deficit: q - o > t ? q - o : 0, surplus: 0,
      status: q - o > t ? 'deficit' : (o > t || d > t ? 'ok' : 'idle'),
      V: L.V, Vd: L.Vd, drop: L.drop, length: L.len, lossPerBlock: L.loss,
      draw, loss: Math.max(0, draw - f), lossFull: Math.max(0, L.reqSrc - L.req),
      ampsPeak: L.V > 0 ? L.reqSrc / L.V : 0, ampsActual: L.V > 0 ? draw / L.V : 0, warnings: [],
    };
    const mInfo = nodeInfo.get(m.id);
    const mV = TIER_V[mInfo.mp?.tier ?? 0];
    const gl = label(g), ml = label(m, mInfo.r);
    if (L.V > 0 && L.Vd <= 0) s.warnings.push({ kind: 'drop', text: `${gl} → ${ml}${$t(": в кабеле теряется всё напряжение (")}${num0(L.drop)} ${$t("EU на")} ${num0(L.len)} ${$t("блоков при")} ${num0(L.V)} ${$t("В)")}` });
    if (e.cable && L.V > e.cable.voltage) s.warnings.push({ kind: 'overvolt', text: `${gl} → ${ml}${$t(": напряжение")} ${num0(L.V)} ${$t("В выше допустимого для кабеля (")}${num0(e.cable.voltage)} ${$t("В) — кабель сгорит")}` });
    if (e.cable && s.ampsPeak > e.cable.amps + 1e-9) s.warnings.push({ kind: 'overamp', text: `${gl} → ${ml}${$t(": на полной мощности нужно")} ${num0(Math.ceil(s.ampsPeak * 100) / 100)} ${$t("А, кабель держит")} ${num0(e.cable.amps)} ${$t("А — кабель перегорит")}` });
    if (L.Vd > mV) s.warnings.push({ kind: 'explode', text: `${gl} → ${ml}${$t(": напряжение")} ${num0(L.Vd)} ${$t("В выше уровня машины (")}${num0(mV)} ${$t("В) — машина взорвётся")}` });
    for (const w of s.warnings) problems.push({ kind: 'energy', edge: e.id, text: w.text });
  }

  const nodes = {};
  for (const info of nodeInfo.values()) {
    const { n, r, ps, mp } = info;
    const res = { type: n.type, inputs: {}, outputs: {} };
    const sup = portSupply.get(n.id) || {};
    for (const pt of ps) {
      if (pt.energy) {
        if (pt.dir === 'in') {
          const list = eIn.get(n.id) || [];
          const N = eNeed(n.id);
          const supplied = list.reduce((a, e) => a + (eState.deliv.get(e.id) || 0), 0);
          const viaBlock = !list.length && opts.blockBudget != null;
          const request = list.length || viaBlock ? eRequest(n.id) : N;
          const got = list.length ? supplied : viaBlock ? request * eState.blockK : N;
          res.inputs[pt.id] = { need: N, request, supplied: got, short: Math.max(0, request - got), used: actualEU(n.id), connected: list.length > 0 || viaBlock, viaBlock, res: ENERGY, energy: true };
          if (EON && !list.length && !viaBlock && N > 0) problems.push({ kind: 'unpowered', node: n.id, port: pt.id, text: `${label(n, r)}${$t(": питание не подключено —")} ${num0(N)} ${$t("EU/t не учтены")}` });
        } else {
          const list = eOut.get(n.id) || [];
          res.outputs[pt.id] = { max: info.gp.cap, actual: eState.gen.get(n.id)?.out || 0, routed: 0, unrouted: 0, connected: list.length > 0, res: ENERGY, energy: true };
          if (EON && !list.length) problems.push({ kind: 'energy', node: n.id, port: pt.id, text: `${label(n, r)}${$t(": выход ⚡ ни к чему не подключён — протяните связь к ⚡ входу машины")}` });
        }
        continue;
      }
      const list = (pt.dir === 'in' ? inE : outE).get(key(n.id, pt.id)) || [];
      if (pt.dir === 'in') {
        const supplied = sumOf(list, offered);
        const used = sumOf(list, flow);
        const nv = consumer(n.type) ? need(info, pt) : null;
        res.inputs[pt.id] = { need: nv, supplied, used, connected: list.length > 0, res: pt.res };
        if ((n.type === 'machine' || n.type === 'group' || (n.type === 'generator' && EON)) && !list.length && nv > 0)
          problems.push({ kind: 'unfed', node: n.id, port: pt.id, text: `${label(n, r)}${$t(": вход «")}${nm(pt.res)}${$t("» не подключён")}` });
      } else {
        const actual = sup[pt.id] ?? 0;
        const routed = sumOf(list, offered);
        const unrouted = Math.max(0, actual - routed);
        const max = (n.type === 'machine' || n.type === 'group') && mp?.cycles != null ? pt.entry.amount * (pt.entry.probability ?? 1) * mp.cycles : actual;
        res.outputs[pt.id] = { max, actual, routed, unrouted: unrouted > tol(actual) ? unrouted : 0, connected: list.length > 0, res: pt.res };
        if (!list.length && (actual > 0 || n.type === 'machine' || n.type === 'group') && !n.synthetic)
          problems.push({ kind: 'unconnected', node: n.id, port: pt.id, text: `${label(n, r)}${$t(": выход «")}${nm(pt.res) || '—'}${$t("» не подключён")}` });
        else if (list.length && unrouted > tol(actual))
          problems.push({ kind: 'unrouted', node: n.id, port: pt.id, text: `${label(n, r)}: «${nm(pt.res)}${$t("» распределено не полностью (доли")} < 100%)` });
      }
    }
    if (n.type === 'machine') {
      const u = util.get(n.id) ?? 0;
      res.util = mp?.cycles == null ? null : u;
      res.params = mp;
      res.powerFull = mp?.eut != null ? mp.eut * mp.count : null;
      res.powerAvg = mp?.eut != null && mp.cycles != null ? mp.eut * mp.count * u : null;
      let worst = null, wr = Infinity;
      for (const [pid, s] of Object.entries(res.inputs)) {
        if (s.energy && !(s.short > 1e-9 * Math.max(1, s.need))) continue; // power covers what it asks for
        if (s.need > 0) { const ratio = s.supplied / s.need; if (ratio < wr) { wr = ratio; worst = pid; } }
      }
      res.limitedBy = u < 1 - 1e-7 ? worst : null;
      res.energyNeed = eNeed(n.id); res.energyRequest = eRequest(n.id);
      if (mp?.cycles == null) problems.push({ kind: 'noduration', node: n.id, text: `${label(n, r)}${$t(": в рецепте нет длительности — задайте циклы/мин вручную")}` });
      const mb = mp?.multi;
      if (mb?.blocked && !mp.override) problems.push({ kind: 'multiblock', node: n.id, text: `${label(n, r)}: ${({
        heat: `${$t('не хватает нагрева —')} ${num0(mb.machineHeat)} K ${$t('из')} ${num0(mb.recipeHeat)} K`,
        power: `${$t('энергоразъёмы дают')} ${num0(mb.avail)} EU/t, ${$t('рецепту нужно больше')}`,
        voltage: `${$t('напряжение разъёмов слишком низкое для рецепта (не больше чем на 1 уровень ниже)')}`,
      })[mb.blocked]}` });
      else if (mb?.heatUnknown && !mp.override) problems.push({ kind: 'multiblock', node: n.id, text: `${label(n, r)}${$t(': не задан нагрев машины — бонусы нагрева не учтены, проверьте, хватает ли его рецепту')}` });
    }
    if (n.type === 'group') {
      const ev = blockEval.get(n.id), pf = info.profile;
      res.util = util.get(n.id) ?? 0;
      res.params = mp;
      res.powerFull = pf.powerFull; res.powerAvg = ev?.powerAvg ?? 0;
      res.energyNeed = eNeed(n.id); res.energyRequest = eRequest(n.id);
      res.blockUtil = ev?.util ?? null;
      res.innerR = ev?.R || null;
      res.ctx = blockCtx.get(n.id) || { supply: {}, eBudget: Infinity, eRatio: 1, eReq: 0 };
      res.innerProblems = (ev?.R.problems || []).filter(x => x.kind !== 'unconnected').length;
      res.machines = pf.R ? Object.values(pf.R.nodes).filter(x => x.type === 'machine').length : 0;
      if (info.gp) Object.assign(res, { capacity: info.gp.cap, output: EON ? (eState.gen.get(n.id)?.out || 0) : 0 });
      let worst = null, wr = Infinity;
      for (const [pid, s] of Object.entries(res.inputs)) {
        if (s.energy && !(s.short > 1e-9 * Math.max(1, s.need))) continue;
        if (s.need > 0) { const ratio = s.supplied / s.need; if (ratio < wr) { wr = ratio; worst = pid; } }
      }
      res.limitedBy = res.util < 1 - 1e-7 ? worst : null;
      for (const [gid, v] of Object.entries(pf.used)) if (v >= BIG * 0.5) problems.push({ kind: 'unrouted', node: n.id, text: `${label(n)}${$t(": вход блока «")}${nm(info.ps.find(x => x.id === gid)?.res)}${$t("» уходит прямо на выход — потребность не ограничена")}` });
    }
    if (n.type === 'generator') {
      const g = info.gp, st = eState.gen.get(n.id) || { out: 0, fuel: 0 };
      const fin = res.inputs.f;
      Object.assign(res, {
        params: g, capacity: g.cap, request: g.reqSrc || 0, fullOut: g.fullOut || 0, output: EON ? st.out : 0,
        fuelFull: EON ? g.fuelFull : 0, fuelUsed: EON ? st.fuel : 0,
        fuelRatio: fin && fin.need > 0 ? Math.min(1, fin.supplied / fin.need) : 1,
        // the machines asked for more than it could give, and fuel (not capacity) was the limit
        fuelLimits: EON && (eState.cut.get(n.id)?.k ?? 1) < 1 - 1e-9 && (eState.cut.get(n.id)?.fr ?? 1) < 1 - 1e-9,
        util: g.cap > 0 && EON ? st.out / g.cap : null,
      });
      // why does it give nothing? (shown on the card)
      const links = eOut.get(n.id) || [];
      res.idle = !EON ? $t('учёт энергии выключен (переключатель «⚡ Энергия»)')
        : g.cap <= 0 ? $t('мощность 0: проверьте напряжение, ампер и число генераторов')
        : !links.length ? $t('выход ⚡ не подключён к машинам')
        : g.reqSrc <= 0 ? $t('машинам ничего не доставляется: всё напряжение теряется в кабеле')
        : g.fuel && g.euEff && fin && !fin.connected ? `${$t("нет подачи топлива «")}${nm(g.fuel.res)}»`
        : g.fuel && g.euEff && fin && fin.supplied <= 0 ? `${$t("топливо «")}${nm(g.fuel.res)}${$t("» не поступает")}`
        : st.out <= 0 ? $t('подключённые машины стоят (их ограничивает другой вход)')
        : null;
      if (EON && res.idle && links.length) problems.push({ kind: 'energy', node: n.id, text: `${label(n)} ${$t("не выдаёт энергию:")} ${res.idle}` });
      if (EON) {
        if (g.reqSrc > g.cap * (1 + 1e-9)) problems.push({ kind: 'energy', node: n.id, text: `${label(n)}${$t(": нужно")} ${num0(g.reqSrc)} ${$t("EU/t, генератор даёт максимум")} ${num0(g.cap)} EU/t` });
        if (g.fuel && !g.euEff) problems.push({ kind: 'energy', node: n.id, text: `${label(n)}${$t(": не указано, сколько EU даёт единица топлива — расход топлива не считается")}` });
      }
    }
    nodes[n.id] = res;
  }
  if (!converged) problems.push({ kind: 'noconverge', text: `${$t("Расчёт не сошёлся за")} ${ITER} ${$t("итераций — вероятно, цикл с потерями без подпитки. Добавьте подачу недостающего ресурса.")}` });
  let powerFull = 0, powerAvg = 0;
  for (const s of Object.values(nodes)) { powerFull += s.powerFull || 0; powerAvg += s.powerAvg || 0; }
  const energy = { enabled: EON, capacity: 0, generated: 0, delivered: 0, losses: 0, unpowered: 0 };
  if (EON) {
    for (const s of Object.values(nodes)) {
      if (s.type === 'generator') { energy.capacity += s.capacity || 0; energy.generated += s.output || 0; }
      if (s.type === 'machine' && s.inputs.ep && !s.inputs.ep.connected) energy.unpowered += s.powerAvg || 0;
    }
    for (const s of Object.values(edges)) if (s.energy) { energy.delivered += s.flow || 0; energy.losses += s.loss || 0; }
  }
  // ---- line balance per resource: what the whole line needs at full capacity, what it
  // actually consumes and produces, what comes in from sources and what leaves it.
  const bal = new Map();
  const B = r => {
    if (!r?.id) return null;
    if (!bal.has(r.id)) bal.set(r.id, { res: r, needFull: 0, used: 0, made: 0, makeMax: 0, external: 0, leaving: 0, consumers: 0, producers: 0 });
    return bal.get(r.id);
  };
  for (const info of nodeInfo.values()) {
    const s = nodes[info.n.id], t = info.n.type;
    for (const x of Object.values(s.inputs)) {
      if (x.energy) continue;
      const b = B(x.res);
      if (!b) continue;
      if (t === 'machine' || t === 'generator' || t === 'group') {
        // generator fuel at full: what it would burn to cover the full demand of its machines
        const full = t === 'generator' ? (info.gp.euEff ? info.gp.fullOut * 20 / info.gp.euEff : 0) : (x.need || 0);
        b.needFull += full; b.used += x.used || 0; b.consumers++;
      } else if (t === 'sink') b.leaving += x.used || 0;
    }
    for (const x of Object.values(s.outputs)) {
      if (x.energy) continue;
      const b = B(x.res);
      if (!b) continue;
      if (t === 'source') { b.external += x.routed || 0; continue; }
      if ((t === 'machine' || t === 'generator' || t === 'group') && !info.n.synthetic) {
        b.made += x.actual || 0; b.makeMax += x.max || 0; b.producers++;
        if (!x.connected) b.leaving += x.actual || 0; else b.leaving += x.unrouted || 0;
      }
    }
  }
  const balance = [...bal.values()].map(b => ({ ...b, net: b.made + b.external - b.used }))
    .sort((a, b) => (b.needFull - a.needFull) || (b.made - a.made));
  // energy demand of the whole line, independent of the energy switch
  const energyNeed = { full: powerFull, actual: powerAvg, capacity: 0 };
  for (const info of nodeInfo.values()) if (info.gp) energyNeed.capacity += info.gp.cap;
  const result = { edges, nodes, problems, powerFull, powerAvg, energy, energyNeed, balance, iterations, converged, mode, loops: [] };
  if (opts.analyzeLoops !== false) {
    result.loops = analyzeLoops(p, result, nodeInfo, mode === 'primed' ? () => solve(p, { mode: 'cold', analyzeLoops: false }) : null, medges, eedges);
    for (const L of result.loops) {
      for (const id of L.nodes) if (nodes[id]) nodes[id].loop = L.index;
      for (const id of L.edges) edges[id].loop = L.index;
      for (const c of (L.leaks || []).slice(0, 2)) problems.push({ kind: 'loopleak', node: L.nodes[0], text: `${$t("Цикл")} ${L.index} ${$t("останавливается: по контуру")} ${c.path.map(r => '«' + nm(r) + '»').join(' → ')} ${$t("возвращается только")} ${num0(c.gain * 100)}${$t("% — подайте извне")} ${c.path.filter(r => r.kind !== 'energy').map(r => '«' + nm(r) + '»').slice(0, 3).join($t(' или '))}` });
      if (L.needsPriming) problems.push({ kind: 'loop', node: L.nodes[0], text: `${$t("Цикл")} ${L.index}${$t(": нужен начальный запас (")}${L.circulating.map(c => nm(c.res)).join($t(' или '))}${$t(") — без него цикл не запустится")}` });
      else if (!L.running && !(L.leaks || []).length) problems.push({ kind: 'loop', node: L.nodes[0], text: `${$t("Цикл")} ${L.index} ${$t("стоит: в нём ничего не циркулирует (режим «пуск с нуля» или нет подачи)")}` });
      for (const c of L.circulating) if (c.makeup > 0) problems.push({ kind: 'loop', node: L.nodes[0], text: `${$t("Цикл")} ${L.index}: «${nm(c.res)}${$t("» расходуется быстрее, чем возвращается — нужна подпитка")}` });
    }
  }
  // Classify shortfalls: only the input that actually limits a machine is a "deficit".
  // Other inputs below full capacity are "limited" (bottleneck is elsewhere); links that
  // carry a fully-returned loop resource are "loop" (they mirror the loop's throughput).
  const balanced = new Map();
  for (const L of result.loops) for (const c of L.circulating) if (c.makeup === 0 && !c.coveredByInput) balanced.set(L.index + '|' + c.res.id, true);
  for (const e of p.edges) {
    const s = edges[e.id];
    if (!s?.deficit) continue;
    const cons = nodes[e.to.node];
    let root = true;
    if ((cons?.type === 'machine' || cons?.type === 'group') && cons.util != null) {
      const x = cons.inputs[e.to.port];
      const ratio = x && x.need > 0 ? x.supplied / x.need : Infinity;
      root = ratio <= cons.util * (1 + 1e-6) + 1e-12;
    }
    if (s.loop && s.resource && balanced.has(s.loop + '|' + s.resource.id)) s.status = 'loop';
    else if (!root) s.status = s.surplus ? 'surplus' : 'limited';
    else s.status = 'deficit';
  }
  for (const e of p.edges) {
    if (edges[e.id]?.status === 'deficit') {
      edges[e.id].affected = affected(p, e, nodes, outE, key, eOut);
      const a = nodeInfo.get(e.to.node);
      problems.push({ kind: 'deficit', edge: e.id, text: `${$t("Дефицит «")}${nm(edges[e.id].resource)}» → ${label(a.n, a.r)}` });
    }
  }
  const prio = { loopleak: -1, deficit: 0, noconverge: 0, energy: 1, unfed: 1, unpowered: 2, loop: 2, noduration: 3, unrouted: 4, unconnected: 5 };
  problems.sort((a, b) => (prio[a.kind] ?? 9) - (prio[b.kind] ?? 9));
  return result;
}

const num0 = v => (Math.round(v * 100) / 100).toLocaleString(uiLang() === 'en' ? 'en-US' : 'ru-RU');

function label(n, r) {
  if (n.type === 'machine') return (lbl(n.label) || mname(r?.machine) || $t('Машина')) + ' ×' + (n.count ?? 1);
  if (n.type === 'generator') return (n.label && n.label !== 'Генератор' ? lbl(n.label) : nm(n.gen) || $t('Генератор')) + ' ×' + (n.count ?? 1);
  if (n.type === 'group') return $t('Блок «') + (lbl(n.label) || $t('Блок')) + '»';
  return lbl(n.label) || ({ source: $t('Источник'), sink: $t('Склад'), splitter: $t('Разветвитель'), merger: $t('Слияние') })[n.type];
}

function allocate(S, list, demand, out) {
  if (!list.length || S <= 0) return;
  const fixed = list.filter(e => e.share != null && e.share !== '');
  const auto = list.filter(e => e.share == null || e.share === '');
  const pct = fixed.reduce((s, e) => s + Math.max(0, +e.share), 0);
  const scale = pct > 100 ? 100 / pct : 1;
  let R = S;
  for (const e of fixed) { const a = S * Math.max(0, +e.share) / 100 * scale; out.set(e.id, out.get(e.id) + a); R -= a; }
  if (!auto.length || R <= 0) return; // remainder stays unrouted at the port
  const fin = auto.filter(e => (demand.get(e.id) ?? 0) !== Infinity);
  const inf = auto.filter(e => (demand.get(e.id) ?? 0) === Infinity);
  const D = fin.reduce((s, e) => s + (demand.get(e.id) ?? 0), 0);
  const give = Math.min(R, D);
  if (D > 0) for (const e of fin) out.set(e.id, out.get(e.id) + give * demand.get(e.id) / D);
  let L = R - give;
  if (L <= 0) return;
  if (inf.length) { for (const e of inf) out.set(e.id, out.get(e.id) + L / inf.length); return; }
  // no overflow storage: excess is pushed into the connections (backs up = surplus)
  if (D > 0) for (const e of fin) out.set(e.id, out.get(e.id) + L * demand.get(e.id) / D);
  else for (const e of fin) out.set(e.id, out.get(e.id) + L / fin.length);
}

/** Nodes affected by a deficit on edge e: the consumer and everything downstream that runs below capacity. */
function affected(p, e, nodes, outE, key, eOut) {
  const res = [], seen = new Set();
  const q = [e.to.node];
  while (q.length) {
    const id = q.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    const s = nodes[id];
    if (!s) continue;
    let reduced = false;
    if (s.type === 'machine' || s.type === 'group') {
      if (s.util != null && s.util < 1 - 1e-7) { res.push({ node: id, util: s.util, limitedBy: s.limitedBy }); reduced = true; }
    } else if (s.type === 'generator') {
      if (s.fuelLimits) { res.push({ node: id, util: s.fuelRatio, limitedBy: 'f' }); for (const x of eOut?.get(id) || []) q.push(x.to.node); }
      reduced = true;
    } else if (s.type === 'sink') {
      res.push({ node: id, util: null });
    } else reduced = true; // pass-through nodes forward the shortage
    if (!reduced) continue;
    for (const pid of Object.keys(s.outputs)) {
      for (const x of outE.get(key(id, pid)) || []) q.push(x.to.node);
    }
  }
  return res;
}

/** Strongly connected components of the node graph (Tarjan). */
export function findLoops(p, edgeList = p.edges.filter(e => !e.energy)) {
  const adj = new Map(p.nodes.map(n => [n.id, []]));
  const self = new Set();
  for (const e of edgeList) {
    adj.get(e.from.node)?.push(e.to.node);
    if (e.from.node === e.to.node) self.add(e.from.node);
  }
  let idx = 0;
  const index = new Map(), low = new Map(), on = new Set(), stack = [], comps = [];
  const strong = v => {
    index.set(v, idx); low.set(v, idx); idx++; stack.push(v); on.add(v);
    for (const w of adj.get(v) || []) {
      if (!index.has(w)) { strong(w); low.set(v, Math.min(low.get(v), low.get(w))); }
      else if (on.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
    }
    if (low.get(v) === index.get(v)) {
      const c = [];
      let w;
      do { w = stack.pop(); on.delete(w); c.push(w); } while (w !== v);
      if (c.length > 1 || self.has(v)) comps.push(c);
    }
  };
  for (const n of p.nodes) if (!index.has(n.id)) strong(n.id);
  return comps;
}

function analyzeLoops(p, R, nodeInfo, coldSolve, medges, eedges = []) {
  // energy links close loops too (fuel → generator → ⚡ → machine → fuel)
  const comps = findLoops(p, [...medges, ...eedges]);
  if (!comps.length) return [];
  const cold = coldSolve ? coldSolve() : null;
  return comps.map((ids, i) => {
    const set = new Set(ids);
    const internal = medges.filter(e => set.has(e.from.node) && set.has(e.to.node));
    const entering = medges.filter(e => !set.has(e.from.node) && set.has(e.to.node));
    const leaving = medges.filter(e => set.has(e.from.node) && !set.has(e.to.node));
    const group = (list, val) => {
      const m = new Map();
      for (const x of list) {
        const k = x.res?.id ?? '?';
        if (!m.has(k)) m.set(k, { res: x.res, rate: 0, connected: x.connected });
        const g = m.get(k); g.rate += val(x); g.connected = g.connected && x.connected;
      }
      return [...m.values()].filter(g => g.rate > 1e-12);
    };
    // circulating resources: produced and consumed inside the loop
    const circ = new Map();
    for (const e of internal) {
      const r = R.edges[e.id].resource;
      if (r && !circ.has(r.id)) circ.set(r.id, { res: r, produced: 0, consumed: 0, externalIn: 0, perCycleStock: 0 });
    }
    for (const id of ids) {
      const s = R.nodes[id], info = nodeInfo.get(id);
      if (s?.type !== 'machine' && s?.type !== 'group') continue;
      for (const x of Object.values(s.outputs)) if (x.res && circ.has(x.res.id)) circ.get(x.res.id).produced += x.actual;
      for (const [pid, x] of Object.entries(s.inputs)) {
        if (x.energy || !x.res || !circ.has(x.res.id)) continue;
        const c = circ.get(x.res.id);
        c.consumed += x.used;
        const pt = info.ps.find(q => q.id === pid);
        c.perCycleStock += (pt?.entry?.amount || 0) * (info.mp?.count ?? 1);
      }
    }
    for (const e of entering) {
      const r = R.edges[e.id].resource;
      if (r && circ.has(r.id)) circ.get(r.id).externalIn += R.edges[e.id].flow;
    }
    const circulating = [...circ.values()].map(c => {
      const t = 1e-7 * Math.max(1, c.consumed);
      const lack = c.consumed - c.produced;
      return { ...c, balance: c.produced - c.consumed, makeup: lack > t && c.externalIn < lack - t ? lack - c.externalIn : 0, coveredByInput: lack > t && c.externalIn >= lack - t };
    });
    // what leaves the loop: edges going out + outputs that are not connected / not fully routed
    const outs = leaving.map(e => ({ res: R.edges[e.id].resource, rate: R.edges[e.id].offered, connected: true }));
    for (const id of ids) {
      const s = R.nodes[id];
      for (const x of Object.values(s?.outputs || {})) {
        if (x.energy) continue;
        if (!x.connected) outs.push({ res: x.res, rate: x.actual, connected: false });
        else if (x.unrouted > 0) outs.push({ res: x.res, rate: x.unrouted, connected: false });
      }
    }
    const ins = entering.map(e => ({ res: R.edges[e.id].resource, rate: R.edges[e.id].flow, connected: true }));
    const utilSum = ids.reduce((s, id) => s + (R.nodes[id]?.util || 0), 0);
    const coldSum = cold ? ids.reduce((s, id) => s + (cold.nodes[id]?.util || 0), 0) : utilSum;
    // A loop that stopped: find closed paths whose recipe ratios multiply to less than 1
    // (e.g. 2 Hydrogen Cells in, 1 Empty Cell back → each pass returns 50%).
    const leaks = utilSum <= 1e-9 ? lossyPaths(ids, [...internal, ...eedges.filter(e => set.has(e.from.node) && set.has(e.to.node))], nodeInfo, R) : [];
    return {
      index: i + 1, nodes: ids, edges: internal.map(e => e.id), circulating,
      inputs: group(ins, x => x.rate), outputs: group(outs, x => x.rate),
      needsPriming: !!cold && utilSum > coldSum + 1e-6, leaks,
      running: utilSum > 1e-9,
    };
  });
}

/** Per-node conversion factor when a stream enters at port `pin` and leaves at port `pout`
 *  (amount out per amount in, from the recipe; null when the data does not say). */
function passFactor(info, pin, pout) {
  const { n, ps, mp, gp } = info;
  if (n.type === 'splitter' || n.type === 'merger') return 1;
  const pi = ps.find(x => x.id === pin), po = ps.find(x => x.id === pout);
  if (!pi || !po) return null;
  if (n.type === 'group') {
    if (pi.energy || po.energy) return null;
    return pi.entry?.amount > 0 && po.entry ? po.entry.amount / pi.entry.amount : null;
  }
  if (n.type === 'machine') {
    const inAmt = pi.energy ? (mp?.eut != null && mp?.ticks ? mp.eut * mp.ticks : null) : pi.entry?.amount;
    const outAmt = po.energy ? null : po.entry ? po.entry.amount * (po.entry.probability ?? 1) : null;
    return inAmt > 0 && outAmt != null ? outAmt / inAmt : null;
  }
  if (n.type === 'generator') {
    if (pin !== 'f') return null;
    if (po.energy) return gp?.euEff || null; // EU per unit of fuel
    return po.entry?.amount ?? null;           // by-product per unit of fuel
  }
  return null;
}

/** Simple cycles of a strongly connected component with their gain (product of recipe
 *  ratios and cable losses); returns the lossy ones (gain < 1), worst first. */
function lossyPaths(ids, edges, nodeInfo, R) {
  const order = new Map(ids.map((id, i) => [id, i]));
  const out = new Map(ids.map(id => [id, []]));
  for (const e of edges) out.get(e.from.node)?.push(e);
  const found = [];
  let budget = 20000;
  const edgeGain = e => {
    if (!e.energy) return 1;
    const s = R.edges[e.id];
    return s?.V > 0 ? s.Vd / s.V : 0;
  };
  const resOf = e => e.energy ? ENERGY : R.edges[e.id]?.resource;
  for (const start of ids) {
    const s0 = order.get(start);
    const path = [];
    const onPath = new Set([start]);
    const dfs = node => {
      if (budget-- <= 0 || found.length > 200) return;
      for (const e of out.get(node) || []) {
        const nxt = e.to.node;
        if (order.get(nxt) < s0) continue;
        path.push(e);
        if (nxt === start) {
          let g = 1;
          for (let i = 0; i < path.length && g != null; i++) {
            const cur = path[i], next = path[(i + 1) % path.length];
            const f = passFactor(nodeInfo.get(cur.to.node), cur.to.port, next.from.port);
            g = f == null ? null : g * f * edgeGain(cur);
          }
          if (g != null) found.push({ gain: g, path: path.map(resOf).filter(Boolean) });
        } else if (!onPath.has(nxt)) {
          onPath.add(nxt); dfs(nxt); onPath.delete(nxt);
        }
        path.pop();
      }
    };
    dfs(start);
  }
  return found.filter(c => c.gain < 1 - 1e-9).sort((a, b) => a.gain - b.gain);
}
