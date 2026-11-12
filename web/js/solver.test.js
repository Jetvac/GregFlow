// Solver/model unit tests. Run by opening /tests.html (results also in window.testResults).
// Fixtures are SYNTHETIC test recipes (ids start with "test:"), not catalog data.
import * as M from './model.js';
import { solve, EBF_ID } from './solver.js';
import { planForTarget } from './target.js';
import { billOfMaterials } from './machines.js';
import { multiOc, ebfHeat, gtTierOf } from './overclock.js';

const R = (id, inputs, outputs, ticks, eut = 30) => ({
  id, dataset: 'test', machine: { name: 'Test ' + id }, inputs, outputs,
  gt: ticks == null ? null : { durationTicks: ticks, eut, tier: 0, tierName: 'LV', metadata: [] },
});
const it = (id, amount, extra = {}) => ({ kind: 'item', id, name: id, icon: -1, amount, probability: 1, consumed: amount > 0, ...extra });
const fl = (id, amount, extra = {}) => ({ kind: 'fluid', id, name: id, icon: -1, amount, probability: 1, consumed: amount > 0, ...extra });
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
function assert(c, msg) { if (!c) throw new Error(msg); }
function eq(a, b, msg) { assert(near(a, b), `${msg}: ${a} ≠ ${b}`); }

function build(recipes) {
  const p = M.newProject('t');
  for (const r of recipes) M.snapshotRecipe(p, r, null);
  return p;
}
const per = v => v / 60; // per-minute helper -> per second

const ELEC = R('test:elec', [it('i:sand', 8)], [it('i:sio2', 3)], 500, 25);

test('3 машины, источник 40/мин: потребность 57.6, дефицит 17.6, загрузка 69.4%', () => {
  const p = build([ELEC]);
  const s = M.addNode(p, { type: 'source', resource: it('i:sand', 1), rate: per(40) });
  const m = M.addNode(p, { type: 'machine', recipeId: 'test:elec', count: 3 });
  const e = M.connect(p, { node: s.id, port: 'out' }, { node: m.id, port: 'i0' }).edge;
  const r = solve(p);
  eq(r.edges[e.id].demand * 60, 57.6, 'demand');
  eq(r.edges[e.id].offered * 60, 40, 'offered');
  eq(r.edges[e.id].deficit * 60, 17.6, 'deficit');
  eq(r.nodes[m.id].util, 40 / 57.6, 'util');
  assert(r.edges[e.id].affected.some(a => a.node === m.id), 'consumer listed as affected');
  assert(r.problems.some(x => x.kind === 'unconnected'), 'unconnected output reported');
});

test('избыток: источник 100/мин на одну машину', () => {
  const p = build([ELEC]);
  const s = M.addNode(p, { type: 'source', resource: it('i:sand', 1), rate: per(100) });
  const m = M.addNode(p, { type: 'machine', recipeId: 'test:elec', count: 1 });
  const e = M.connect(p, { node: s.id, port: 'out' }, { node: m.id, port: 'i0' }).edge;
  const r = solve(p);
  eq(r.edges[e.id].flow * 60, 19.2, 'flow');
  eq(r.edges[e.id].surplus * 60, 80.8, 'surplus');
  eq(r.nodes[m.id].util, 1, 'util');
  assert(r.edges[e.id].status === 'surplus', 'status');
});

test('дефицит только у узкого места; второй вход — «ограничен»', () => {
  const B = R('test:two', [it('i:a', 1), it('i:b', 1)], [it('i:c', 1)], 20); // needs 1/s of each
  const p = build([B]);
  const a = M.addNode(p, { type: 'source', resource: it('i:a', 1), rate: 0.25 });
  const b = M.addNode(p, { type: 'source', resource: it('i:b', 1), rate: 0.5 });
  const m = M.addNode(p, { type: 'machine', recipeId: 'test:two' });
  const ea = M.connect(p, { node: a.id, port: 'out' }, { node: m.id, port: 'i0' }).edge;
  const eb = M.connect(p, { node: b.id, port: 'out' }, { node: m.id, port: 'i1' }).edge;
  const r = solve(p);
  assert(r.edges[ea.id].status === 'deficit', 'a is the bottleneck');
  assert(r.edges[eb.id].status === 'surplus', 'b: surplus at actual rate, not a deficit');
  eq(r.edges[eb.id].deficit, 0.5, 'shortfall to full capacity still reported');
});

test('70% дальше, остаток на склад', () => {
  const B = R('test:b', [it('i:sio2', 1)], [it('i:si', 1)], 20);
  const p = build([ELEC, B]);
  const s = M.addNode(p, { type: 'source', resource: it('i:sand', 1), rate: per(19.2) });
  const m = M.addNode(p, { type: 'machine', recipeId: 'test:elec', count: 1 });
  const b = M.addNode(p, { type: 'machine', recipeId: 'test:b', count: 1 });
  const k = M.addNode(p, { type: 'sink' });
  M.connect(p, { node: s.id, port: 'out' }, { node: m.id, port: 'i0' });
  const e1 = M.connect(p, { node: m.id, port: 'o0' }, { node: b.id, port: 'i0' }).edge; e1.share = 70;
  const e2 = M.connect(p, { node: m.id, port: 'o0' }, { node: k.id, port: 'in' }).edge;
  const r = solve(p);
  eq(r.edges[e1.id].offered * 60, 7.2 * 0.7, '70%');
  eq(r.edges[e2.id].offered * 60, 7.2 * 0.3, 'rest');
  eq(r.nodes[m.id].outputs.o0.unrouted, 0, 'nothing unrouted');
});

test('доли < 100% без авто-связи: остаток не распределён', () => {
  const p = build([ELEC]);
  const s = M.addNode(p, { type: 'source', resource: it('i:sand', 1), rate: per(19.2) });
  const m = M.addNode(p, { type: 'machine', recipeId: 'test:elec' });
  const k = M.addNode(p, { type: 'sink' });
  M.connect(p, { node: s.id, port: 'out' }, { node: m.id, port: 'i0' });
  const e = M.connect(p, { node: m.id, port: 'o0' }, { node: k.id, port: 'in' }).edge; e.share = 50;
  const r = solve(p);
  eq(r.nodes[m.id].outputs.o0.unrouted * 60, 3.6, 'unrouted');
  assert(r.problems.some(x => x.kind === 'unrouted'), 'problem');
});

test('побочный продукт со своим портом и шансом (ожидаемое значение)', () => {
  const C = R('test:c', [it('i:resin', 1)], [it('i:rubber', 3), it('i:ball', 1, { probability: 0.1 }), fl('f:glue', 100)], 300, 5);
  const p = build([C]);
  const s = M.addNode(p, { type: 'source', resource: it('i:resin', 1), rate: per(4) });
  const m = M.addNode(p, { type: 'machine', recipeId: 'test:c' });
  M.connect(p, { node: s.id, port: 'out' }, { node: m.id, port: 'i0' });
  const ps = M.ports(p, m).filter(x => x.dir === 'out');
  assert(ps.length === 3, 'three output ports');
  const r = solve(p);
  eq(r.nodes[m.id].outputs.o1.actual * 60, 0.4, 'expected chance output');
  eq(r.nodes[m.id].outputs.o2.actual * 60, 400, 'fluid L/min');
  assert(r.problems.filter(x => x.kind === 'unconnected').length === 3, 'all outputs unconnected');
});

test('несовместимые ID не соединяются, даже при одинаковом имени', () => {
  const X = R('test:x', [it('i:modA:sand', 1, { name: 'Sand' })], [it('i:y', 1)], 20);
  const p = build([X]);
  const s = M.addNode(p, { type: 'source', resource: it('i:minecraft:sand', 1, { name: 'Sand' }), rate: 1 });
  const m = M.addNode(p, { type: 'machine', recipeId: 'test:x' });
  const c = M.checkConnect(p, { node: s.id, port: 'out' }, { node: m.id, port: 'i0' });
  assert(!c.ok, 'must be rejected');
});

test('словарь руд: подключение варианта выбирает его', () => {
  const OD = { kind: 'oredict', id: 'o:dustSulfur', name: 'Sulfur', amount: 2, probability: 1, consumed: true, variants: [{ kind: 'item', id: 'i:gt:s', name: 'Sulfur Dust', icon: -1 }, { kind: 'item', id: 'i:other:s', name: 'Sulfur', icon: -1 }] };
  const X = R('test:od', [OD], [it('i:out', 1)], 20);
  const p = build([X]);
  const s = M.addNode(p, { type: 'source', resource: { kind: 'item', id: 'i:other:s', name: 'Sulfur', icon: -1 }, rate: 1 });
  const bad = M.addNode(p, { type: 'source', resource: it('i:sand', 1), rate: 1 });
  const m = M.addNode(p, { type: 'machine', recipeId: 'test:od' });
  assert(!M.checkConnect(p, { node: bad.id, port: 'out' }, { node: m.id, port: 'i0' }).ok, 'non-variant rejected');
  assert(M.connect(p, { node: s.id, port: 'out' }, { node: m.id, port: 'i0' }).ok, 'variant accepted');
  assert(m.oreChoice[0] === 'i:other:s', 'variant chosen');
  const r = solve(p);
  eq(r.nodes[m.id].util, 0.5, 'util: 1/s supply for 2/s need (20 t, 2 per cycle)');
});

test('разветвитель передаёт потребность и делит по потребности', () => {
  const p = build([ELEC]);
  const s = M.addNode(p, { type: 'source', resource: it('i:sand', 1), rate: per(40) });
  const sp = M.addNode(p, { type: 'splitter' });
  const ms = [1, 2, 3].map(() => M.addNode(p, { type: 'machine', recipeId: 'test:elec', count: 1 }));
  const ein = M.connect(p, { node: s.id, port: 'out' }, { node: sp.id, port: 'in' }).edge;
  const outs = ms.map(m => M.connect(p, { node: sp.id, port: 'out' }, { node: m.id, port: 'i0' }).edge);
  assert(sp.resource?.id === 'i:sand', 'bus typed by first link');
  const r = solve(p);
  eq(r.edges[ein.id].demand * 60, 57.6, 'demand passes through');
  for (const e of outs) eq(r.edges[e.id].offered * 60, 40 / 3, 'equal share');
  eq(r.nodes[ms[0].id].util, 40 / 57.6, 'same util as ×3 node');
  assert(r.edges[ein.id].affected.length === 3, 'three machines affected');
});

test('слияние двух источников', () => {
  const p = build([ELEC]);
  const a = M.addNode(p, { type: 'source', resource: it('i:sand', 1), rate: per(10) });
  const b = M.addNode(p, { type: 'source', resource: it('i:sand', 1), rate: per(30) });
  const mg = M.addNode(p, { type: 'merger' });
  const m = M.addNode(p, { type: 'machine', recipeId: 'test:elec', count: 3 });
  M.connect(p, { node: a.id, port: 'out' }, { node: mg.id, port: 'in' });
  M.connect(p, { node: b.id, port: 'out' }, { node: mg.id, port: 'in' });
  const e = M.connect(p, { node: mg.id, port: 'out' }, { node: m.id, port: 'i0' }).edge;
  const r = solve(p);
  eq(r.edges[e.id].offered * 60, 40, 'sum');
  eq(r.edges[e.id].deficit * 60, 17.6, 'deficit');
});

test('цикл (рецикл) сходится', () => {
  // A: 2 x -> 1 y + 1 x(back) ; source 1 x/s
  const A = R('test:loop', [it('i:x', 2)], [it('i:y', 1), it('i:x', 1)], 20);
  const p = build([A]);
  const s = M.addNode(p, { type: 'source', resource: it('i:x', 1), rate: 1 });
  const mg = M.addNode(p, { type: 'merger' });
  const m = M.addNode(p, { type: 'machine', recipeId: 'test:loop', count: 10 });
  M.connect(p, { node: s.id, port: 'out' }, { node: mg.id, port: 'in' });
  M.connect(p, { node: mg.id, port: 'out' }, { node: m.id, port: 'i0' });
  M.connect(p, { node: m.id, port: 'o1' }, { node: mg.id, port: 'in' });
  const r = solve(p);
  assert(r.converged, 'converged');
  eq(r.nodes[m.id].outputs.o0.actual, 1, 'all x turned into y at steady state');
});

test('разгон GT: длительность ÷2, EU/t ×4 за уровень', () => {
  const p = build([ELEC]);
  const m = M.addNode(p, { type: 'machine', recipeId: 'test:elec', oc: 2 });
  const r = solve(p);
  eq(r.nodes[m.id].params.ticks, 125, 'ticks');
  eq(r.nodes[m.id].params.eut, 400, 'eut');
});

// Same shape as GTNH 2.8.0 r~KNFUVhzfOwq6mFtHoi7cjg== (Chemical Reactor, 100 t, 8 EU/t)
// and r~Zx5M8dmoMYOCvjAvTfJKmw== (Electrolyzer, 40 t, 30 EU/t) — numbers copied, ids synthetic.
const CR = R('test:cr', [it('i:sio2', 3), it('i:mg', 2)], [it('i:rawsi', 1), it('i:mgo', 4)], 100, 8);
const EL = R('test:el', [it('i:mgo', 2)], [it('i:mg', 1), fl('f:o2', 1000)], 40, 30);
function mgLoop(mode, sio2PerMin = 14.4) {
  const p = build([CR, EL]);
  p.loopMode = mode;
  const s = M.addNode(p, { type: 'source', resource: it('i:sio2', 1), rate: per(sio2PerMin) });
  const cr = M.addNode(p, { type: 'machine', recipeId: 'test:cr' });
  const el = M.addNode(p, { type: 'machine', recipeId: 'test:el' });
  M.connect(p, { node: s.id, port: 'out' }, { node: cr.id, port: 'i0' });
  const back = M.connect(p, { node: el.id, port: 'o0' }, { node: cr.id, port: 'i1' }).edge;
  const fwd = M.connect(p, { node: cr.id, port: 'o1' }, { node: el.id, port: 'i0' }).edge;
  return { p, cr, el, back, fwd, r: solve(p) };
}

test('цикл Mg ↔ MgO: установившийся режим, O₂ — единственный выход', () => {
  const { cr, el, back, fwd, r } = mgLoop('primed');
  assert(r.converged, 'converged');
  eq(r.nodes[cr.id].util, 14.4 / 36, 'CR limited by SiO2 (40%)');
  eq(r.edges[fwd.id].flow * 60, 19.2, 'MgO 19.2/min');
  eq(r.edges[back.id].flow * 60, 9.6, 'Mg returns 9.6/min');
  eq(r.nodes[el.id].outputs.o1.actual * 60, 9600, 'O2 9600 L/min');
  assert(r.loops.length === 1, 'one loop');
  const L = r.loops[0];
  assert(L.needsPriming, 'needs initial stock');
  const mg = L.circulating.find(c => c.res.id === 'i:mg');
  assert(mg && mg.makeup === 0, 'Mg returns fully');
  eq(mg.perCycleStock, 2, 'seed ≈ 2 Mg');
  assert(L.outputs.some(o => o.res.id === 'f:o2' && !o.connected), 'O2 leaves loop (unconnected)');
  assert(L.outputs.some(o => o.res.id === 'i:rawsi'), 'raw Si leaves loop');
  assert(!L.outputs.some(o => o.res.id === 'i:mg' || o.res.id === 'i:mgo'), 'nothing circulating leaks');
  assert(r.edges[back.id].status === 'loop' && r.edges[fwd.id].status === 'loop', 'loop links are not deficits');
  assert(!r.problems.some(x => x.kind === 'deficit' && /i:mg/.test(r.edges[x.edge]?.resource?.id)), 'no Mg/MgO deficit problems');
});

test('цикл с нуля: без начального запаса стоит', () => {
  const { cr, r } = mgLoop('cold');
  eq(r.nodes[cr.id].util, 0, 'cold = 0');
  assert(r.loops[0].needsPriming === false && !r.loops[0].running, 'reported as not running');
});

test('цикл с потерями: нужна подпитка, с подпиткой — работает', () => {
  // A: 2 x -> 1 y + 1 x (returns half): needs 1 x per cycle from outside
  const A = R('test:lossy', [it('i:x', 2)], [it('i:y', 1), it('i:x', 1)], 20);
  const p = build([A]);
  const mg = M.addNode(p, { type: 'merger' });
  const m = M.addNode(p, { type: 'machine', recipeId: 'test:lossy' });
  M.connect(p, { node: mg.id, port: 'out' }, { node: m.id, port: 'i0' });
  M.connect(p, { node: m.id, port: 'o1' }, { node: mg.id, port: 'in' });
  let r = solve(p);
  eq(r.nodes[m.id].util, 0, 'decays to zero without makeup');
  assert(r.converged, 'converges to zero');
  assert(r.loops[0].circulating[0].makeup === 0 || r.nodes[m.id].util === 0, 'idle');
  const s = M.addNode(p, { type: 'source', resource: it('i:x', 1), rate: 0.5 });
  M.connect(p, { node: s.id, port: 'out' }, { node: mg.id, port: 'in' });
  r = solve(p);
  eq(r.nodes[m.id].util, 0.5, '0.5 x/s makeup -> 0.5 cycles/s');
  assert(r.loops[0].circulating[0].coveredByInput, 'loss covered by input');
});

test('уровень машины: разгон GT и упор в 1 тик', () => {
  const p = build([CR]);
  const lv = M.addNode(p, { type: 'machine', recipeId: 'test:cr', tier: 0 });
  const hv = M.addNode(p, { type: 'machine', recipeId: 'test:cr', tier: 2 });
  const zpm = M.addNode(p, { type: 'machine', recipeId: 'test:cr', tier: 6 });
  const perfect = M.addNode(p, { type: 'machine', recipeId: 'test:cr', tier: 1, perfectOc: true });
  const r = solve(p);
  eq(r.nodes[lv.id].params.ticks, 100, 'LV 100 t');
  eq(r.nodes[hv.id].params.ticks, 25, 'HV 25 t'); eq(r.nodes[hv.id].params.eut, 128, 'HV 128 EU/t');
  eq(r.nodes[zpm.id].params.ticks, 1, 'ZPM capped at 1 t'); eq(r.nodes[zpm.id].params.ocs, 6, '6 OCs (100→1)');
  eq(r.nodes[perfect.id].params.ticks, 25, 'perfect OC ÷4');
  const low = M.addNode(p, { type: 'machine', recipeId: 'test:cr', tier: -3 });
  assert(solve(p).nodes[low.id].params.tier === 0, 'never below recipe tier');
});

test('нет длительности → без догадок, проблема в списке', () => {
  const X = R('test:nogt', [it('i:a', 1)], [it('i:b', 1)], null);
  const p = build([X]);
  const m = M.addNode(p, { type: 'machine', recipeId: 'test:nogt' });
  const r = solve(p);
  assert(r.nodes[m.id].util === null, 'util unknown');
  assert(r.problems.some(x => x.kind === 'noduration'), 'reported');
  m.cycleOverride = 60;
  const r2 = solve(p);
  eq(r2.nodes[m.id].outputs.o0.max, 1, 'manual 60 cycles/min');
});

test('не расходуемый вход (схема/цепь) не создаёт порта', () => {
  const X = R('test:nc', [it('i:circuit', 0), fl('f:water', 1000)], [fl('f:h2', 2000)], 2000);
  const p = build([X]);
  const m = M.addNode(p, { type: 'machine', recipeId: 'test:nc' });
  const ins = M.ports(p, m).filter(x => x.dir === 'in');
  assert(ins.length === 1 && ins[0].id === 'i1', 'only fluid port');
});

test('снимок рецепта не меняется при изменении исходного объекта', () => {
  const r = JSON.parse(JSON.stringify(ELEC));
  const p = build([r]);
  r.gt.durationTicks = 1;
  assert(p.recipes['test:elec'].gt.durationTicks === 500, 'snapshot is a copy');
});

test('отмена/повтор', () => {
  const h = new M.History();
  const p = build([ELEC]);
  h.push(p);
  M.addNode(p, { type: 'sink' });
  const back = h.back(p);
  assert(back.nodes.length === 0, 'undo');
  const fwd = h.forward(back);
  assert(fwd.nodes.length === 1, 'redo');
});

// ---------------- energy ----------------
const TIN1 = { id: 'test:cable', name: 'test cable', loss: 1, amps: 1, voltage: 32, insulated: true, size: 1 };
function powered(genProps, cable, length) {
  const p = build([ELEC]);
  p.energy = { enabled: true };
  const s = M.addNode(p, { type: 'source', resource: it('i:sand', 1), rate: per(100) });
  const m = M.addNode(p, { type: 'machine', recipeId: 'test:elec', count: 3 }); // 3 × 25 = 75 EU/t
  M.connect(p, { node: s.id, port: 'out' }, { node: m.id, port: 'i0' });
  const g = M.addNode(p, { type: 'generator', ...genProps });
  const c = M.connect(p, { node: g.id, port: 'eo' }, { node: m.id, port: 'ep' });
  assert(c.ok, 'energy link: ' + c.reason);
  c.edge.cable = cable; c.edge.length = length;
  return { p, m, g, e: c.edge };
}

test('энергия: генератор 2×32 EU/t на 75 EU/t → загрузка 85.3%, перегрузка кабеля', () => {
  const { p, m, g, e } = powered({ voltage: 32, amps: 1, count: 2 }, TIN1, 0);
  const r = solve(p);
  eq(r.nodes[m.id].util, 64 / 75, 'util limited by energy');
  assert(r.nodes[m.id].limitedBy === 'ep', 'limited by energy');
  eq(r.edges[e.id].demand, 75, 'EU/t need');
  eq(r.edges[e.id].offered, 64, 'EU/t delivered');
  assert(r.edges[e.id].status === 'deficit', 'energy edge is the bottleneck');
  assert(r.problems.some(x => x.kind === 'energy' && /перегорит/.test(x.text)), 'over-amperage reported (2.34 A > 1 A)');
  assert(r.problems.some(x => x.kind === 'energy' && /максимум/.test(x.text)), 'generator capacity reported');
  eq(r.nodes[g.id].output, 64, 'generator output');
});

test('энергия: потери в кабеле 4 блока × 1 EU/А и расход топлива', () => {
  const fuel = { res: fl('f:fuel', 1), euPerUnit: 100, outputs: [] };
  const { p, m, g, e } = powered({ voltage: 32, amps: 4, count: 1, efficiency: 50, fuel }, { ...TIN1, amps: 4 }, 4);
  const src = M.addNode(p, { type: 'source', resource: fl('f:fuel', 1), rate: 1000 });
  const fe = M.connect(p, { node: src.id, port: 'out' }, { node: g.id, port: 'f' }).edge;
  let r = solve(p);
  const draw = 75 * 32 / 28; // 85.71 EU/t sent, 75 EU/t received
  eq(r.nodes[m.id].util, 1, 'enough energy');
  eq(r.edges[e.id].Vd, 28, 'voltage at machine');
  eq(r.edges[e.id].loss, draw - 75, 'cable loss EU/t');
  eq(r.nodes[g.id].fuelUsed, draw * 20 / 50, 'fuel L/s = EU/t × 20 / (100 EU/L × 50%)');
  eq(r.edges[fe.id].flow, draw * 20 / 50, 'fuel flow');
  assert(!r.problems.some(x => x.kind === 'energy'), 'no warnings: ' + r.problems.map(x => x.text).join('; '));
  src.rate = draw * 20 / 50 / 2; // half the fuel
  r = solve(p);
  eq(r.nodes[m.id].util, 0.5, 'half fuel → half load');
  assert(r.edges[fe.id].status === 'deficit', 'fuel link is the deficit');
  assert(r.edges[fe.id].affected.some(a => a.node === m.id), 'machine listed as affected by fuel deficit');
});

test('энергия по запросу: мощность, которую не берёт простаивающая машина, достаётся другой', () => {
  const p = build([ELEC]);
  p.energy = { enabled: true };
  const g = M.addNode(p, { type: 'generator', voltage: 32, amps: 1, count: 1 }); // 32 EU/t for 2 × 25 EU/t
  const mk = rate => {
    const s = M.addNode(p, { type: 'source', resource: it('i:sand', 1), rate: per(rate) });
    const m = M.addNode(p, { type: 'machine', recipeId: 'test:elec', count: 1 }); // 19.2 sand/min at full load
    M.connect(p, { node: s.id, port: 'out' }, { node: m.id, port: 'i0' });
    M.connect(p, { node: g.id, port: 'eo' }, { node: m.id, port: 'ep' });
    m.src = s;
    return m;
  };
  const full = mk(100), starved = mk(1.92); // the second one has sand for 10% load
  let r = solve(p);
  eq(r.nodes[starved.id].util, 0.1, 'starved machine: limited by sand');
  eq(r.nodes[full.id].util, 1, 'the other machine gets the power the starved one does not draw');
  eq(r.nodes[g.id].output, 27.5, 'generator gives 25 + 2.5 EU/t');
  assert(r.nodes[starved.id].limitedBy === 'i0', 'starved machine is limited by sand, not by power');
  assert(!Object.values(r.edges).some(e => e.energy && e.status === 'deficit'), 'no energy link is short');
  // both fully fed: 50 EU/t asked, 32 available → both at 64%
  starved.src.rate = per(100);
  r = solve(p);
  eq(r.nodes[full.id].util, 32 / 50, 'shortage shared in proportion to requests');
  eq(r.nodes[starved.id].util, 32 / 50, 'shortage shared in proportion to requests');
});

test('энергия выключена: генераторы не влияют, порта ⚡ нет', () => {
  const { p, m, g } = powered({ voltage: 32, amps: 1, count: 1 }, null, 0);
  p.energy.enabled = false;
  const r = solve(p);
  eq(r.nodes[m.id].util, 1, 'util');
  assert(M.ports(p, g).some(x => x.id === 'eo'), 'generator keeps its energy output while off');
  assert(!r.problems.some(x => x.kind === 'energy' || x.kind === 'unpowered'), 'no energy problems');
  eq(r.nodes[g.id].output, 0, 'generator idle');
});

test('энергия: машина без питания — предупреждение, линия не останавливается', () => {
  const p = build([ELEC]);
  p.energy = { enabled: true };
  const s = M.addNode(p, { type: 'source', resource: it('i:sand', 1), rate: per(100) });
  const m = M.addNode(p, { type: 'machine', recipeId: 'test:elec', count: 1 });
  M.connect(p, { node: s.id, port: 'out' }, { node: m.id, port: 'i0' });
  const r = solve(p);
  eq(r.nodes[m.id].util, 1, 'util');
  assert(r.problems.some(x => x.kind === 'unpowered'), 'unpowered reported');
  eq(r.energy.unpowered, 25, 'unaccounted EU/t');
  const bad = M.checkConnect(p, { node: s.id, port: 'out' }, { node: m.id, port: 'ep' });
  assert(!bad.ok, 'material cannot go into energy port');
});

test('энергия: напряжение выше уровня машины и кабеля', () => {
  const { p } = powered({ voltage: 128, amps: 1, count: 1 }, TIN1, 0);
  const r = solve(p);
  assert(r.problems.some(x => /взорвётся/.test(x.text)), 'machine explodes (128 V > LV)');
  assert(r.problems.some(x => /сгорит/.test(x.text)), 'cable burns (128 V > 32 V)');
});

test('энергия: генератор объясняет, почему выдаёт 0 EU/t', () => {
  const fuel = { res: fl('f:fuel', 1), euPerUnit: 100, outputs: [] };
  const { p, m, g } = powered({ voltage: 32, amps: 4, count: 1, fuel }, null, 0);
  let r = solve(p);
  assert(/нет подачи топлива/.test(r.nodes[g.id].idle), 'no fuel: ' + r.nodes[g.id].idle);
  eq(r.nodes[m.id].util, 0, 'machine stops without fuel');
  assert(r.problems.some(x => /не выдаёт энергию/.test(x.text)), 'reported in problems');
  p.edges = p.edges.filter(e => !e.energy);
  r = solve(p);
  assert(/не подключён/.test(r.nodes[g.id].idle), 'not linked: ' + r.nodes[g.id].idle);
  assert(M.ports(p, m).some(x => x.id === 'ep'), 'machines get ⚡ input when a generator exists');
  p.energy.enabled = false;
  r = solve(p);
  assert(/выключен/.test(r.nodes[g.id].idle), 'switch off: ' + r.nodes[g.id].idle);
  assert(M.ports(p, g).some(x => x.id === 'eo'), 'output port still shown');
});

// --- precision: loops that drain must reach exact zero and say why -------------------
function cellLoop(bigStream) {
  // reactor: 2 H-cell -> 1 empty cell + 1 H2S cell; electrolyzer: 2 empty -> 2 H-cell
  const RX = R('test:rx', [it('i:hcell', 2)], [it('i:empty', 1), it('i:h2s', 1)], 160);
  const EL = R('test:el', [it('i:empty', 2)], [it('i:hcell', 2)], 2000);
  const p = build([RX, EL]);
  const rx = M.addNode(p, { type: 'machine', recipeId: 'test:rx' });
  const el = M.addNode(p, { type: 'machine', recipeId: 'test:el' });
  M.connect(p, { node: el.id, port: 'o0' }, { node: rx.id, port: 'i0' });
  M.connect(p, { node: rx.id, port: 'o0' }, { node: el.id, port: 'i0' });
  if (bigStream) { // an unrelated 90 000 L/min stream must not hide the small loop's decay
    const s = M.addNode(p, { type: 'source', resource: fl('f:oil', 1), rate: 1500 });
    const k = M.addNode(p, { type: 'sink' });
    M.connect(p, { node: s.id, port: 'out' }, { node: k.id, port: 'in' });
  }
  return { p, rx, el };
}

test('точность: цикл капсул с потерями (2 → 1) — ровно 0 и объяснение', () => {
  for (const big of [false, true]) {
    const { p, rx, el } = cellLoop(big);
    const r = solve(p);
    assert(r.converged, 'converged');
    assert(r.nodes[rx.id].util === 0 && r.nodes[el.id].util === 0, `exact zero, got ${r.nodes[rx.id].util} / ${r.nodes[el.id].util}`);
    const L = r.loops[0];
    assert(L.leaks.length && near(L.leaks[0].gain, 0.5), 'returned share 50%: ' + JSON.stringify(L.leaks.map(x => x.gain)));
    assert(r.problems.some(x => x.kind === 'loopleak' && /50%/.test(x.text)), 'problem explains the 50% return');
    assert(r.iterations < 500, 'fast: ' + r.iterations);
  }
});

test('точность: подпитка цикла даёт точный установившийся режим', () => {
  const { p, rx, el } = cellLoop(true);
  // feed 0.01 empty cells/s from outside: el needs 2 per 100 s at full = 0.02/s
  const s = M.addNode(p, { type: 'source', resource: it('i:empty', 1), rate: 0.01 });
  const mg = M.addNode(p, { type: 'merger' });
  p.edges = p.edges.filter(e => !(e.to.node === el.id));
  M.connect(p, { node: rx.id, port: 'o0' }, { node: mg.id, port: 'in' });
  M.connect(p, { node: s.id, port: 'out' }, { node: mg.id, port: 'in' });
  M.connect(p, { node: mg.id, port: 'out' }, { node: el.id, port: 'i0' });
  const r = solve(p);
  // steady state: empty in = 0.01 + rxCycles; el cycles = empty/2; H cells = 2·el; rx cycles = H/2 = el
  // → el = (0.01 + el)/2 → el = 0.01 cycles/s = util 0.01 / 0.01 (full = 1/100 s) = 100%? full el = 0.01/s → util 1
  eq(r.nodes[el.id].util, 1, 'electrolyzer full');
  eq(r.nodes[rx.id].util, 0.01 / 0.125, 'reactor at exactly 8%', 1e-9);
});

test('точность: цикл «топливо → генератор → ⚡ → машина» с отрицательным балансом гаснет', () => {
  // machine: 10 L fuel per 20-tick cycle at 30 EU/t = 600 EU/cycle; fuel gives 50 EU/L → 500 EU < 600
  const F = R('test:fuelmaker', [it('i:wood', 1)], [fl('f:fuel', 10)], 20, 30);
  const p = build([F]);
  p.energy = { enabled: true };
  const w = M.addNode(p, { type: 'source', resource: it('i:wood', 1), rate: 100 });
  const m = M.addNode(p, { type: 'machine', recipeId: 'test:fuelmaker' });
  const g = M.addNode(p, { type: 'generator', voltage: 32, amps: 1, count: 1, efficiency: 100, fuel: { res: fl('f:fuel', 1), euPerUnit: 50, outputs: [] } });
  M.connect(p, { node: w.id, port: 'out' }, { node: m.id, port: 'i0' });
  M.connect(p, { node: m.id, port: 'o0' }, { node: g.id, port: 'f' });
  M.connect(p, { node: g.id, port: 'eo' }, { node: m.id, port: 'ep' });
  let r = solve(p);
  assert(r.nodes[m.id].util === 0, 'energy-negative loop stops: ' + r.nodes[m.id].util);
  assert(r.loops.length === 1 && r.loops[0].nodes.includes(g.id), 'generator is part of the loop');
  assert(r.problems.some(x => x.kind === 'loopleak' && /83,33%/.test(x.text)), 'returns 500/600: ' + r.problems.map(x => x.text).join(' | '));
  p.nodes.find(n => n.id === g.id).fuel.euPerUnit = 120; // 1200 EU per cycle > 600: self-sustaining
  r = solve(p);
  eq(r.nodes[m.id].util, 1, 'energy-positive loop runs');
  eq(r.nodes[g.id].output, 30, 'generator gives what the machine takes');
});

test('баланс линии: общая потребность на полной мощности и максимум производства', () => {
  // 3 electrolyzers need 57.6 sand/min in total; source gives 40; they could make 21.6 SiO2/min
  const B2 = R('test:b2', [it('i:sio2', 1)], [it('i:si', 1)], 20); // wants 60 SiO2/min
  const p = build([ELEC, B2]);
  const s = M.addNode(p, { type: 'source', resource: it('i:sand', 1), rate: per(40) });
  const m = M.addNode(p, { type: 'machine', recipeId: 'test:elec', count: 3 });
  const b = M.addNode(p, { type: 'machine', recipeId: 'test:b2' });
  M.connect(p, { node: s.id, port: 'out' }, { node: m.id, port: 'i0' });
  M.connect(p, { node: m.id, port: 'o0' }, { node: b.id, port: 'i0' });
  const r = solve(p);
  const sand = r.balance.find(x => x.res.id === 'i:sand'), sio2 = r.balance.find(x => x.res.id === 'i:sio2');
  eq(sand.needFull * 60, 57.6, 'sand needed by the whole line');
  eq(sand.external * 60, 40, 'sand from source');
  eq(sio2.needFull * 60, 60, 'SiO2 needed downstream');
  eq(sio2.makeMax * 60, 21.6, 'SiO2 the line can make at most');
  eq(sio2.made * 60, 15, 'SiO2 made now (69.4%)');
  eq(r.energyNeed.full, 3 * 25 + 30, 'EU/t of all machines at full load');
});

// --- blocks (groups of nodes) ---------------------------------------------------------
const SI = R('test:si', [it('i:sio2', 1)], [it('i:si', 1)], 20, 30); // wants 60 SiO2/min
function line(energy) {
  const p = build([ELEC, SI]);
  if (energy) p.energy = { enabled: true };
  const s = M.addNode(p, { type: 'source', resource: it('i:sand', 1), rate: per(40) });
  const a = M.addNode(p, { type: 'machine', recipeId: 'test:elec', count: 3 });
  const b = M.addNode(p, { type: 'machine', recipeId: 'test:si' });
  const k = M.addNode(p, { type: 'sink' });
  M.connect(p, { node: s.id, port: 'out' }, { node: a.id, port: 'i0' });
  M.connect(p, { node: a.id, port: 'o0' }, { node: b.id, port: 'i0' });
  M.connect(p, { node: b.id, port: 'o0' }, { node: k.id, port: 'in' });
  let g = null;
  if (energy) {
    g = M.addNode(p, { type: 'generator', voltage: 32, amps: 2, count: 1 });
    M.connect(p, { node: g.id, port: 'eo' }, { node: a.id, port: 'ep' });
    M.connect(p, { node: g.id, port: 'eo' }, { node: b.id, port: 'ep' });
  }
  return { p, s, a, b, k, g };
}
const siOut = (r, p, id) => { const n = M.node(p, id); return n.type === 'group' ? Object.values(r.nodes[id].outputs).find(x => x.res.id === 'i:si').actual : r.nodes[id].outputs.o0.actual; };

test('блок: те же цифры, что и без группировки (с энергией)', () => {
  for (const energy of [false, true]) {
    const { p, a, b, g } = line(energy);
    const r0 = solve(p);
    const si0 = r0.nodes[b.id].outputs.o0.actual;
    const blk = M.groupNodes(p, [a.id, b.id]);
    const r1 = solve(p);
    eq(siOut(r1, p, blk.id), si0, 'Si out identical' + (energy ? ' (energy)' : ''));
    const inp = Object.values(r1.nodes[blk.id].inputs).find(x => x.res.id === 'i:sand');
    eq(inp.need * 60, 57.6, 'block needs 57.6 sand/min at full');
    eq(inp.used * 60, r0.edges[Object.keys(r0.edges)[0]].flow * 60, 'sand used identical');
    eq(r1.powerAvg, r0.powerAvg, 'EU/t of the line identical');
    if (energy) eq(r1.nodes[g.id].output, r0.nodes[g.id].output, 'generator output identical');
    assert(M.ports(p, blk).filter(x => x.dir === 'in' && !x.energy).length === 1 && M.ports(p, blk).some(x => x.dir === 'out'), 'one input, one output');
    M.ungroupNode(p, blk.id);
    const r2 = solve(p);
    eq(r2.powerAvg, r0.powerAvg, 'ungroup restores the line');
    assert(p.nodes.filter(n => n.type === 'machine').length === 2 && !p.nodes.some(n => n.type === 'group'), 'machines back');
  }
});

test('блок: нехватка энергии делится так же, как без группировки', () => {
  const { p, a, b, g } = line(true);
  M.node(p, g.id).amps = 1; // 32 EU/t for 52 + 7.5 EU/t requested
  const r0 = solve(p);
  assert(r0.nodes[a.id].util < 0.694 - 1e-3, 'power is really short');
  const si0 = r0.nodes[b.id].outputs.o0.actual;
  const blk = M.groupNodes(p, [a.id, b.id]);
  const r1 = solve(p);
  eq(siOut(r1, p, blk.id), si0, 'Si out identical under a power shortage');
  eq(r1.nodes[g.id].output, r0.nodes[g.id].output, 'generator output identical');
});

test('блок: выход по фактическому входу и вложенные блоки', () => {
  const { p, s, a, b } = line(false);
  const blk = M.groupNodes(p, [a.id, b.id]);
  const outer = M.groupNodes(p, [blk.id]); // block inside a block
  s.rate = per(20);
  let r = solve(p);
  eq(siOut(r, p, outer.id) * 60, 20 * 3 / 8, 'half the sand → 7.5 Si/min through two levels');
  s.rate = per(1000);
  r = solve(p);
  eq(siOut(r, p, outer.id) * 60, 21.6, 'capped by the inner electrolyzers (21.6/min)');
  const inp = Object.values(r.nodes[outer.id].inputs)[0];
  eq(inp.used * 60, 57.6, 'takes only what it can use');
  assert(r.edges[p.edges[0].id].status === 'surplus', 'surplus on the feeding link');
});

test('блок с генератором внутри отдаёт энергию наружу', () => {
  const fuel = { res: fl('f:fuel', 1), euPerUnit: 100, outputs: [] };
  const p = build([ELEC]);
  p.energy = { enabled: true };
  const f = M.addNode(p, { type: 'source', resource: fl('f:fuel', 1), rate: 1 }); // 1 L/s → 100 EU/s = 5 EU/t
  const g = M.addNode(p, { type: 'generator', voltage: 32, amps: 1, count: 1, efficiency: 100, fuel });
  M.connect(p, { node: f.id, port: 'out' }, { node: g.id, port: 'f' });
  const sand = M.addNode(p, { type: 'source', resource: it('i:sand', 1), rate: 10 });
  const m = M.addNode(p, { type: 'machine', recipeId: 'test:elec' }); // 25 EU/t
  M.connect(p, { node: sand.id, port: 'out' }, { node: m.id, port: 'i0' });
  M.connect(p, { node: g.id, port: 'eo' }, { node: m.id, port: 'ep' });
  const r0 = solve(p);
  const blk = M.groupNodes(p, [g.id]);
  assert(M.ports(p, blk).some(x => x.id === 'eo'), 'block has ⚡ output');
  const r1 = solve(p);
  eq(r0.nodes[m.id].util, 5 * 20 / 25 / 20, 'fuel-limited before (20%)');
  eq(r1.nodes[m.id].util, r0.nodes[m.id].util, 'same load through the block');
  eq(r1.nodes[blk.id].output, 5, 'block gives 5 EU/t');
  const fin = Object.values(r1.nodes[blk.id].inputs).find(x => x.res.id === 'f:fuel');
  eq(fin.used, 1, 'burns 1 L/s');
});

// ---- GT 5.09.51 overclock rules (overclock.js); expected values worked out by hand from the GT source
test('разгон одноблочной машины по GT: на 1 тике EU/t продолжает расти', () => {
  const X = R('test:oc30', [it('i:a', 1)], [it('i:b', 1)], 100, 30);
  const p = build([X]);
  const uv = M.addNode(p, { type: 'machine', recipeId: 'test:oc30', tier: 7 });
  const lv = M.addNode(p, { type: 'machine', recipeId: 'test:oc30', tier: 0 });
  const r = solve(p);
  eq(r.nodes[uv.id].params.ocs, 7, 'UV: 7 overclocks');
  eq(r.nodes[uv.id].params.ticks, 1, '100 / 128 → 1 tick');
  eq(r.nodes[uv.id].params.eut, 30 * 4 ** 7, 'EU/t ×4 per overclock');
  eq(r.nodes[lv.id].params.ocs, 0, 'LV: none');
});

const alRecipe = id => {
  const x = R(id, [it('i:al', 1)], [it('i:ingot', 1)], 1500, 480);
  x.gt = { durationTicks: 1500, eut: 480, tier: 2, tierName: 'HV', metadata: [{ key: 'coil_heat', value: 2054 }] };
  x.machine = { name: 'Blast Furnace', multiblocks: [{ id: EBF_ID, name: 'Electric Blast Furnace', kind: 'item' }], singleblocks: [] };
  return x;
};

test('ЭДП: нагрев катушек, скидка EU и идеальный разгон от нагрева', () => {
  eq(gtTierOf(512), 3, 'getTier(512) = HV'); eq(gtTierOf(256), 3, 'getTier(256) = HV'); eq(gtTierOf(128), 2, 'MV');
  eq(ebfHeat(1, 2, 1), 2801, 'Kanthal at HV: 2701 + 100');
  const p = build([alRecipe('test:al')]);
  const hv = M.addNode(p, { type: 'machine', recipeId: 'test:al', multi: EBF_ID, tier: 2, coil: 1 });
  const ev = M.addNode(p, { type: 'machine', recipeId: 'test:al', multi: EBF_ID, tier: 3, coil: 1 });
  const hssg = M.addNode(p, { type: 'machine', recipeId: 'test:al', multi: EBF_ID, tier: 3, coil: 4 });
  const mv2 = M.addNode(p, { type: 'machine', recipeId: 'test:al', multi: EBF_ID, tier: 1, hatches: 2, coil: 1 });
  const cold = M.addNode(p, { type: 'machine', recipeId: 'test:al', multi: EBF_ID, tier: 2, coil: 0 });
  const r = solve(p);
  const P = id => r.nodes[id].params;
  eq(P(hv.id).ticks, 1500, 'HV, 1 hatch: no overclock'); eq(P(hv.id).eut, 480, 'HV 480 EU/t');
  eq(P(ev.id).ticks, 750, 'EV: 1 overclock'); eq(P(ev.id).eut, 1920, 'EV 1920 EU/t');
  eq(P(hssg.id).multi.machineHeat, 5601, 'HSS-G at EV: 5401 + 200');
  eq(P(hssg.id).multi.discount, 0.95 ** 3, '3 × 900 K above → EU ×0.95³');
  eq(P(hssg.id).ticks, 375, 'heat overclock ÷4'); eq(P(hssg.id).eut, 1647, 'ceil(480 × 0.857375 × 4)');
  eq(P(mv2.id).ticks, 1500, '2 MV hatches = 512 EU/t: runs, no overclock'); eq(P(mv2.id).multi.machineHeat, 2801, 'sum of hatch voltages = HV');
  assert(P(cold.id).multi.blocked === 'heat' && P(cold.id).cycles === 0, 'Cupronickel too cold: does not run');
  assert(r.problems.some(x => x.kind === 'multiblock' && x.node === cold.id), 'reported');
});

test('мультиблок: параллели и разгон сверх 1 тика', () => {
  const a = multiOc(30, 100, { tier: 4, hatches: 2, parallel: 8 });
  eq(a.parallel, 8, '8 parallels'); eq(a.ocs, 3, '240 EU/t on 32768: 3 OCs'); eq(a.ticks, 12, '100 / 8'); eq(a.eut, 15360, '240 × 64');
  const b = multiOc(30, 2, { tier: 4, hatches: 2, parallel: 1 });
  eq(b.ticks, 1, '1 tick'); eq(b.parallel, 16, 'overclocks past 1 tick become 16 parallels'); eq(b.eut, 30720, '30 × 4⁵');
  const c = multiOc(30, 100, { tier: 0, hatches: 1, parallel: 4 });
  eq(c.parallel, 1, 'one LV hatch (32 EU/t) fits only one 30 EU/t parallel');
  assert(multiOc(600, 100, { tier: 0, hatches: 8 }).blocked === 'power', '16 A × 32 V < 600');
  assert(multiOc(600, 100, { tier: 0, hatches: 16 }).blocked === 'voltage', 'recipe > 4 × hatch voltage');
});

test('план под цель: цепочка и источник', () => {
  const GLASS = R('test:glass', [it('i:sio2', 3)], [it('i:glass', 1)], 100);
  const p = build([ELEC, GLASS]);
  const s = M.addNode(p, { type: 'source', resource: it('i:sand', 1), rate: per(10) });
  const e = M.addNode(p, { type: 'machine', recipeId: 'test:elec', count: 1 });
  const g = M.addNode(p, { type: 'machine', recipeId: 'test:glass', count: 1 });
  const k = M.addNode(p, { type: 'sink' });
  M.connect(p, { node: s.id, port: 'out' }, { node: e.id, port: 'i0' });
  M.connect(p, { node: e.id, port: 'o0' }, { node: g.id, port: 'i0' });
  M.connect(p, { node: g.id, port: 'o0' }, { node: k.id, port: 'in' });
  const P = planForTarget(p, { node: g.id, port: 'o0', rate: 0.1 });
  assert(P.converged, 'converged');
  const row = id => P.rows.find(x => x.id === id);
  eq(row(g.id).exact, 0.5, 'glass: 0.5 machines'); eq(row(g.id).count, 1, '→ 1');
  eq(row(e.id).exact, 2.5, 'electrolyzer: 2.5'); eq(row(e.id).count, 3, '→ 3');
  eq(P.sources[0].need, 0.8, 'sand 0.8/s');
  eq(P.achieved, 0.1, 'target reached exactly');
});

test('план под цель: цикл с возвратом не раздувает машины', () => {
  const X = R('test:mgloop', [it('i:a', 1), it('i:mg', 2)], [it('i:p', 1), it('i:mg', 1)], 20);
  const p = build([X]);
  const a = M.addNode(p, { type: 'source', resource: it('i:a', 1), rate: 0.1 });
  const mg = M.addNode(p, { type: 'source', resource: it('i:mg', 1), rate: 0.1 });
  const x = M.addNode(p, { type: 'machine', recipeId: 'test:mgloop', count: 1 });
  M.connect(p, { node: a.id, port: 'out' }, { node: x.id, port: 'i0' });
  const mix = M.addNode(p, { type: 'merger' });
  M.connect(p, { node: mg.id, port: 'out' }, { node: mix.id, port: 'in' });
  M.connect(p, { node: x.id, port: 'o1' }, { node: mix.id, port: 'in' });
  assert(M.connect(p, { node: mix.id, port: 'out' }, { node: x.id, port: 'i1' }).ok, 'loop closed');
  const P = planForTarget(p, { node: x.id, port: 'o0', rate: 2 });
  eq(P.rows[0].exact, 2, '2 machines (1 cycle/s each)');
  eq(P.sources.find(s => s.id === a.id).need, 2, 'A 2/s');
  eq(P.sources.find(s => s.id === mg.id).need, 2, 'Mg makeup 2/s (4 used − 2 returned)');
  eq(P.achieved, 2, 'reached');
});

test('список постройки: контроллер, разъёмы, катушки и отметки', () => {
  const p = build([alRecipe('test:al2')]);
  M.addNode(p, { type: 'machine', recipeId: 'test:al2', multi: EBF_ID, tier: 2, hatches: 2, coil: 1, count: 2 });
  const B = billOfMaterials(p, solve(p), { ['mb|' + EBF_ID]: 1 });
  const row = pre => B.rows.find(x => x.key.startsWith(pre));
  eq(row('mb|').need, 2, '2 controllers'); eq(row('mb|').left, 1, '1 built, 1 left');
  eq(row('eh|').need, 4, '2 hatches each');
  eq(row('coil|').need, 32, '16 coils each');
});

export function run() {
  const out = [];
  for (const t of tests) {
    try { t.fn(); out.push({ name: t.name, ok: true }); }
    catch (e) { out.push({ name: t.name, ok: false, error: e.message }); }
  }
  return out;
}
