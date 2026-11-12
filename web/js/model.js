// Project model: nodes, ports, edges, recipe snapshots, undo/redo.
import { $t } from './i18n.js';
import { nm } from './fmt.js';
export const NODE_TYPES = {
  source: $t('Источник'),
  machine: $t('Машина'),
  splitter: $t('Разветвитель'),
  merger: $t('Слияние'),
  sink: $t('Склад'),
  generator: $t('Генератор'),
  group: $t('Блок'),
  gin: $t('Вход блока'),
  gout: $t('Выход блока'),
};

/** Pseudo-resource carried by energy links. */
export const ENERGY = { kind: 'energy', id: 'eu', name: 'EU', nameRu: $t('Энергия (EU)') };
export const energyOn = p => !!p.energy?.enabled;
/** Energy ports are shown when accounting is on or the schematic has a generator. */
export const energyPorts = p => energyOn(p) || p.nodes.some(n => n.type === 'generator');

export function newProject(name = $t('Новая линия'), dataset = null) {
  return {
    format: 'gtnh-planner-project', version: 1, name,
    demo: false, demoNote: '',
    dataset, // {id,label,packVersion,sha256} active when created
    units: 'min',
    energy: { enabled: false }, // energy accounting switch (generators, cables)
    recipes: {}, // snapshots keyed by recipe id
    nodes: [], edges: [], nextId: 1,
  };
}

/** Fuel recipes (generator fuel maps): no duration, fuel_value in metadata. */
export const isFuelRecipe = r => !!r?.gt && !r.gt.durationTicks && (r.gt.metadata || []).some(m => m.key === 'fuel_value');

/** Generator fuel object from a server fuel option (see server/energy.py fuels()). */
export function fuelFromOption(o) {
  return { res: o.res, euPerUnit: o.euPerUnit, efficiencyIncluded: false, outputs: o.outputs || [],
    source: { recipeId: o.recipeId, map: o.map, fuelValue: o.fuelValue, rule: o.rule, cellAmount: o.cellAmount } };
}

export function nid(p, prefix) { return prefix + (p.nextId++); }
export const node = (p, id) => p.nodes.find(n => n.id === id);
export const edge = (p, id) => p.edges.find(e => e.id === id);

/** Store an immutable snapshot of a recipe inside the project. */
export function snapshotRecipe(p, recipe, datasetInfo) {
  if (!p.recipes[recipe.id]) {
    const snap = JSON.parse(JSON.stringify(recipe));
    snap.snapshot = {
      takenAt: new Date().toISOString(),
      dataset: recipe.dataset,
      datasetLabel: datasetInfo?.label ?? null,
      datasetSha256: recipe.dataset === 'custom' ? null : (datasetInfo?.sha256 ?? null),
    };
    p.recipes[recipe.id] = snap;
  }
  return p.recipes[recipe.id];
}

export function recipeOf(p, n) { return n.type === 'machine' ? p.recipes[n.recipeId] : null; }

// ---------- blocks (groups of nodes) ----------
// A block node keeps a whole sub-schematic in `n.inner` (same shape as a project). Inside it,
// "gin" nodes are the block's inputs and "gout" nodes its outputs; each typed gin/gout becomes
// a port of the block (port id = the gin/gout node id). Machines inside that have no energy
// link are powered through the block's ⚡ input; energy gouts form the block's ⚡ output.
export const isEnergyRes = r => r?.kind === 'energy';

/** Does a (sub)project need power from outside: a machine with EU/t and no energy link, or such a block. */
export function needsOuterPower(q) {
  if (!q) return false;
  const linked = new Set(q.edges.filter(e => e.energy).map(e => e.to.node));
  return q.nodes.some(n => !linked.has(n.id) && (
    (n.type === 'machine' && q.recipes[n.recipeId]?.gt?.eut > 0) || (n.type === 'group' && needsOuterPower(n.inner))));
}
export const blockGins = n => (n.inner?.nodes || []).filter(x => x.type === 'gin' && x.resource);
export const blockGouts = n => (n.inner?.nodes || []).filter(x => x.type === 'gout' && x.resource);

/** Ports of a node: [{id, dir:'in'|'out', res, label, consumed}] — res null = accepts any. */
export function ports(p, n) {
  switch (n.type) {
    case 'source': return [{ id: 'out', dir: 'out', res: n.resource }];
    case 'sink': return [{ id: 'in', dir: 'in', res: null, any: true }];
    case 'splitter':
    case 'merger': return [{ id: 'in', dir: 'in', res: n.resource || null, bus: true }, { id: 'out', dir: 'out', res: n.resource || null, bus: true }];
    case 'machine': {
      const r = recipeOf(p, n);
      if (!r) return [];
      const out = [];
      r.inputs.forEach((e, i) => {
        if (e.consumed === false) return; // non-consumed: shown in card, no flow port
        out.push({ id: 'i' + i, dir: 'in', res: resolveInput(n, e, i), entry: e, index: i });
      });
      r.outputs.forEach((e, i) => out.push({ id: 'o' + i, dir: 'out', res: e, entry: e, index: i }));
      if (energyPorts(p) && r.gt?.eut > 0) out.push({ id: 'ep', dir: 'in', res: ENERGY, energy: true });
      return out;
    }
    case 'gin': return [{ id: 'out', dir: 'out', res: n.resource || null, bus: true, gin: true }];
    case 'gout': return isEnergyRes(n.resource)
      ? [{ id: 'in', dir: 'in', res: n.resource, energy: true, gout: true }]
      : [{ id: 'in', dir: 'in', res: n.resource || null, bus: true, gout: true }];
    case 'group': {
      const out = [];
      for (const g of blockGins(n)) out.push({ id: g.id, dir: 'in', res: g.resource, label: g.label });
      for (const g of blockGouts(n)) if (!isEnergyRes(g.resource)) out.push({ id: g.id, dir: 'out', res: g.resource, label: g.label });
      if (energyPorts(p) && needsOuterPower(n.inner)) out.push({ id: 'ep', dir: 'in', res: ENERGY, energy: true });
      if (blockGouts(n).some(g => isEnergyRes(g.resource))) out.push({ id: 'eo', dir: 'out', res: ENERGY, energy: true });
      return out;
    }
    case 'generator': {
      const out = [];
      if (n.fuel?.res) out.push({ id: 'f', dir: 'in', res: n.fuel.res, entry: { ...n.fuel.res, amount: 1 } });
      (n.fuel?.outputs || []).forEach((o, i) => out.push({ id: 'o' + i, dir: 'out', res: o.res, entry: { ...o.res, amount: o.perUnit, probability: 1 } }));
      out.push({ id: 'eo', dir: 'out', res: ENERGY, energy: true }); // always: a generator without output is useless
      return out;
    }
  }
  return [];
}

/** For ore-dictionary inputs returns the selected concrete variant (stable item id). */
export function resolveInput(n, e, i) {
  if (e.kind !== 'oredict') return e;
  const chosen = n.oreChoice?.[i];
  const v = (e.variants || []).find(v => v.id === chosen) || (e.variants || [])[0];
  return v ? { ...v, kind: 'item', oredict: e.id } : { kind: 'oredict', id: e.id, name: e.name };
}

export function port(p, n, pid) { return ports(p, n).find(x => x.id === pid); }

/** Resource actually flowing out of a port (bus nodes inherit from their lock). */
export function portResource(p, n, pid) { return port(p, n, pid)?.res || null; }

/**
 * Validate a connection. Returns {ok, reason, apply} where apply(p) performs
 * side effects (lock bus resource, choose ore-dict variant).
 */
export function checkConnect(p, from, to) {
  const a = node(p, from.node), b = node(p, to.node);
  if (!a || !b) return { ok: false, reason: $t('Узел не найден') };
  if (a.id === b.id) return { ok: false, reason: $t('Нельзя соединить узел сам с собой') };
  const pa = port(p, a, from.port), pb = port(p, b, to.port);
  if (!pa || pa.dir !== 'out') return { ok: false, reason: $t('Начало должно быть выходом') };
  if (!pb || pb.dir !== 'in') return { ok: false, reason: $t('Конец должен быть входом') };
  if (pa.energy && pb.gout && !pb.res) {
    return { ok: true, apply: q => { node(q, b.id).resource = { ...ENERGY }; } };
  }
  if (!!pa.energy !== !!pb.energy)
    return { ok: false, reason: pa.energy ? $t('Энергию (⚡) можно подключить только к ⚡ входу машины') : $t('К ⚡ входу машины подключается только генератор') };
  if (pa.energy) {
    if (p.edges.some(e => e.from.node === a.id && e.to.node === b.id && e.energy)) return { ok: false, reason: $t('Этот генератор уже подключён к этому узлу') };
    return { ok: true, apply: () => {} };
  }
  if (p.edges.some(e => e.from.node === a.id && e.from.port === from.port && e.to.node === b.id && e.to.port === to.port))
    return { ok: false, reason: $t('Такая связь уже есть') };
  const ra = pa.res;
  const effects = [];
  if (!ra) {
    // untyped bus output: take type from target
    if (!pb.res) return { ok: false, reason: $t('Сначала подключите вход разветвителя/слияния — тип ресурса не определён') };
    effects.push(q => { node(q, a.id).resource = strip(pb.res); });
    return { ok: true, apply: q => effects.forEach(f => f(q)) };
  }
  if (pb.any) return { ok: true, apply: () => {} };
  if (pb.bus && !pb.res) {
    effects.push(q => { node(q, b.id).resource = strip(ra); });
    return { ok: true, apply: q => effects.forEach(f => f(q)) };
  }
  // machine input with ore dictionary: accept any listed variant, select it
  if (pb.entry && pb.entry.kind === 'oredict') {
    const v = (pb.entry.variants || []).find(v => v.id === ra.id);
    if (!v) return { ok: false, reason: `${nm(ra)} ${$t("не входит в словарь руд")} ${pb.entry.id}` };
    const idx = pb.index;
    const others = p.edges.filter(e => e.to.node === b.id && e.to.port === to.port);
    if (others.length && resolveInput(b, pb.entry, idx).id !== ra.id)
      return { ok: false, reason: $t('К этому входу уже подключён другой вариант словаря руд') };
    effects.push(q => { const nb = node(q, b.id); nb.oreChoice = { ...(nb.oreChoice || {}), [idx]: ra.id }; });
    return { ok: true, apply: q => effects.forEach(f => f(q)) };
  }
  if (ra.kind !== pb.res.kind || ra.id !== pb.res.id)
    return { ok: false, reason: `${$t("Несовместимо:")} ${nm(ra)} (${ra.id}) → ${nm(pb.res)} (${pb.res.id}${$t("). Связь только по одинаковому ID.")}` };
  return { ok: true, apply: () => {} };
}

const strip = r => ({ kind: r.kind, id: r.id, name: r.name, nameRu: r.nameRu, icon: r.icon });

export function connect(p, from, to) {
  const c = checkConnect(p, from, to);
  if (!c.ok) return c;
  c.apply(p);
  const e = { id: nid(p, 'e'), from: { ...from }, to: { ...to }, share: null };
  if (port(p, node(p, from.node), from.port)?.energy) Object.assign(e, { energy: true, cable: null, length: 0 });
  p.edges.push(e);
  return { ok: true, edge: e };
}

export function removeEdge(p, id) {
  p.edges = p.edges.filter(e => e.id !== id);
  releaseBuses(p);
}
export function removeNode(p, id) {
  p.nodes = p.nodes.filter(n => n.id !== id);
  p.edges = p.edges.filter(e => e.from.node !== id && e.to.node !== id);
  releaseBuses(p);
  gcRecipes(p);
}
function releaseBuses(p) {
  for (const n of p.nodes) {
    if ((n.type === 'splitter' || n.type === 'merger' || n.type === 'gin' || n.type === 'gout') && n.resource &&
      !p.edges.some(e => e.from.node === n.id || e.to.node === n.id)) n.resource = null;
  }
}
function gcRecipes(p) {
  const used = new Set(p.nodes.filter(n => n.type === 'machine').map(n => n.recipeId));
  for (const k of Object.keys(p.recipes)) if (!used.has(k)) delete p.recipes[k];
}

export function addNode(p, props) {
  const n = { id: nid(p, 'n'), x: 0, y: 0, ...props };
  if (n.type === 'machine') { n.count ??= 1; n.oreChoice ??= {}; }
  if (n.type === 'source') { n.rate ??= 1; n.label ??= 'Источник'; }
  if (n.type === 'sink') { n.label ??= 'Склад'; }
  if (n.type === 'gin') { n.label ??= 'Вход'; n.resource ??= null; }
  if (n.type === 'gout') { n.label ??= 'Выход'; n.resource ??= null; }
  if (n.type === 'group') { n.label ??= 'Блок'; n.inner ??= emptyInner(p); }
  if (n.type === 'generator') {
    n.label ??= 'Генератор'; n.count ??= 1; n.amps ??= 1; n.voltage ??= 32;
    n.efficiency ??= null; n.gen ??= null; n.fuel ??= null;
  }
  p.nodes.push(n);
  return n;
}

function emptyInner(p) {
  return { format: 'gtnh-planner-block', version: 1, name: 'Блок', energy: { enabled: energyOn(p) }, recipes: {}, nodes: [], edges: [], nextId: 1 };
}

/** Bounding box of nodes (sizes are approximate when the DOM is not available). */
function bbox(nodes, size) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of nodes) {
    const s = size?.(n) || { w: 300, h: 150 };
    x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x + s.w); y1 = Math.max(y1, n.y + s.h);
  }
  return { x0, y0, x1, y1 };
}

/**
 * Move the nodes `ids` into a new block node. Links that cross the boundary become block
 * inputs/outputs (one input per resource, one output per producing port); machine inputs that
 * were not connected become inputs, unconnected outputs become outputs, so the block shows
 * everything it needs and makes. Returns the new block node.
 */
export function groupNodes(p, ids, size) {
  const sel = new Set(ids);
  const moving = p.nodes.filter(n => sel.has(n.id));
  if (!moving.length) return null;
  const blockId = nid(p, 'n');
  const inner = emptyInner(p);
  inner.nextId = p.nextId; // ids stay distinct from the parent's (readable; dissolving remaps anyway)
  const box = bbox(moving, size);
  for (const n of moving) {
    const c = JSON.parse(JSON.stringify(n));
    c.x -= box.x0; c.y -= box.y0;
    inner.nodes.push(c);
    if (n.type === 'machine' && p.recipes[n.recipeId]) inner.recipes[n.recipeId] = JSON.parse(JSON.stringify(p.recipes[n.recipeId]));
  }
  const crossingIn = [], crossingOut = [], outer = [];
  for (const e of p.edges) {
    const a = sel.has(e.from.node), b = sel.has(e.to.node);
    if (a && b) inner.edges.push(JSON.parse(JSON.stringify(e)));
    else if (!a && b) crossingIn.push(e);
    else if (a && !b) crossingOut.push(e);
    else outer.push(e);
  }
  const W = box.x1 - box.x0;
  let gy = 0, oy = 0;
  const gin = new Map(), gout = new Map();
  const addGin = res => {
    const k = res.id;
    if (!gin.has(k)) gin.set(k, addNode(inner, { type: 'gin', label: nm(res), resource: strip(res), x: -380, y: (gy++) * 120 }));
    return gin.get(k);
  };
  const addGout = (key, res) => {
    if (!gout.has(key)) gout.set(key, addNode(inner, { type: 'gout', label: nm(res), resource: isEnergyRes(res) ? { ...ENERGY } : strip(res), x: W + 120, y: (oy++) * 120 }));
    return gout.get(key);
  };
  const newOuter = [];
  const block = { id: blockId, type: 'group', label: 'Блок', x: box.x0, y: box.y0, inner };
  for (const e of crossingIn) {
    if (e.energy) { // outside generator powers a machine inside: the block's ⚡ input takes over
      if (!newOuter.some(x => x.energy && x.from.node === e.from.node)) newOuter.push({ ...e, to: { node: block.id, port: 'ep' } });
      continue;
    }
    const tgt = node(inner, e.to.node);
    const res = port(inner, tgt, e.to.port)?.res || port(p, node(p, e.from.node), e.from.port)?.res;
    if (!res) continue;
    const g = addGin(res);
    if (!inner.edges.some(x => x.from.node === g.id && x.to.node === e.to.node && x.to.port === e.to.port))
      inner.edges.push({ id: nid(inner, 'e'), from: { node: g.id, port: 'out' }, to: { ...e.to }, share: null });
    newOuter.push({ ...e, to: { node: block.id, port: g.id } });
  }
  for (const e of crossingOut) {
    const src = node(inner, e.from.node);
    const res = port(inner, src, e.from.port)?.res;
    if (!res) continue;
    const g = addGout(e.from.node + '|' + e.from.port, res);
    if (!inner.edges.some(x => x.to.node === g.id && x.from.node === e.from.node && x.from.port === e.from.port))
      inner.edges.push({ id: nid(inner, 'e'), from: { ...e.from }, to: { node: g.id, port: 'in' }, share: e.share ?? null, ...(e.view ? { view: e.view } : {}), ...(e.energy ? { energy: true, cable: e.cable ?? null, length: e.length ?? 0 } : {}) });
    newOuter.push({ ...e, from: { node: block.id, port: e.energy ? 'eo' : g.id } });
  }
  // unconnected machine inputs/outputs inside become block inputs/outputs
  for (const n of inner.nodes.filter(x => x.type === 'machine' || x.type === 'generator')) {
    for (const pt of ports(inner, n)) {
      if (pt.energy || !pt.res?.id || pt.res.kind === 'oredict') continue;
      if (pt.dir === 'in' && !inner.edges.some(e => e.to.node === n.id && e.to.port === pt.id)) {
        const g = addGin(pt.res);
        inner.edges.push({ id: nid(inner, 'e'), from: { node: g.id, port: 'out' }, to: { node: n.id, port: pt.id }, share: null });
      }
      if (pt.dir === 'out' && !inner.edges.some(e => e.from.node === n.id && e.from.port === pt.id)) {
        const g = addGout(n.id + '|' + pt.id, pt.res);
        inner.edges.push({ id: nid(inner, 'e'), from: { node: n.id, port: pt.id }, to: { node: g.id, port: 'in' }, share: null });
      }
    }
  }
  // drop duplicate energy links from one generator to the block's input
  const seen = new Set();
  p.nodes = p.nodes.filter(n => !sel.has(n.id));
  p.nodes.push(block);
  p.edges = [...outer, ...newOuter.filter(e => { const k = e.from.node + '|' + e.from.port + '>' + e.to.node + '|' + e.to.port; if (seen.has(k)) return false; seen.add(k); return true; })];
  gcRecipes(p);
  return block;
}

/** Dissolve a block: its inner nodes return to the parent, block ports are reconnected. */
export function ungroupNode(p, id) {
  const b = node(p, id);
  if (b?.type !== 'group') return null;
  const inner = b.inner;
  const map = new Map();
  for (const n of inner.nodes) if (n.type !== 'gin' && n.type !== 'gout') map.set(n.id, nid(p, 'n'));
  const added = [];
  for (const n of inner.nodes) {
    if (!map.has(n.id)) continue;
    const c = JSON.parse(JSON.stringify(n));
    c.id = map.get(n.id); c.x += b.x; c.y += b.y;
    p.nodes.push(c); added.push(c.id);
  }
  for (const [k, r] of Object.entries(inner.recipes)) if (!p.recipes[k]) p.recipes[k] = JSON.parse(JSON.stringify(r));
  const ginOut = id2 => inner.edges.filter(e => e.from.node === id2); // gin -> inner targets
  const goutIn = id2 => inner.edges.filter(e => e.to.node === id2);   // inner sources -> gout
  const newEdges = [];
  const mk = (from, to, extra = {}) => newEdges.push({ id: nid(p, 'e'), from, to, share: null, ...extra });
  for (const e of inner.edges) {
    if (map.has(e.from.node) && map.has(e.to.node)) mk({ node: map.get(e.from.node), port: e.from.port }, { node: map.get(e.to.node), port: e.to.port }, { share: e.share ?? null, ...(e.view ? { view: e.view } : {}), ...(e.energy ? { energy: true, cable: e.cable ?? null, length: e.length ?? 0 } : {}) });
  }
  const keep = [];
  for (const e of p.edges) {
    if (e.to.node === id) {
      if (e.to.port === 'ep') { // outer generator powers every machine that used the block's ⚡ input
        const linked = new Set(inner.edges.filter(x => x.energy).map(x => x.to.node));
        for (const n of inner.nodes) if (map.has(n.id) && n.type === 'machine' && inner.recipes[n.recipeId]?.gt?.eut > 0 && !linked.has(n.id))
          mk({ ...e.from }, { node: map.get(n.id), port: 'ep' }, { energy: true, cable: e.cable ?? null, length: e.length ?? 0 });
      } else for (const x of ginOut(e.to.port)) if (map.has(x.to.node)) mk({ ...e.from }, { node: map.get(x.to.node), port: x.to.port });
      continue;
    }
    if (e.from.node === id) {
      if (e.from.port === 'eo') {
        for (const g of inner.nodes.filter(x => x.type === 'gout' && isEnergyRes(x.resource)))
          for (const x of goutIn(g.id)) if (map.has(x.from.node)) mk({ node: map.get(x.from.node), port: x.from.port }, { ...e.to }, { energy: true, cable: e.cable ?? null, length: e.length ?? 0 });
      } else for (const x of goutIn(e.from.port)) if (map.has(x.from.node)) mk({ node: map.get(x.from.node), port: x.from.port }, { ...e.to }, { share: e.share ?? null });
      continue;
    }
    keep.push(e);
  }
  p.nodes = p.nodes.filter(n => n.id !== id);
  const seen = new Set();
  p.edges = [...keep, ...newEdges.filter(e => { const k = e.from.node + '|' + e.from.port + '>' + e.to.node + '|' + e.to.port; if (seen.has(k)) return false; seen.add(k); return true; })];
  return added;
}

/** Remove links to block ports that no longer exist (an input/output was deleted inside). */
export function pruneBlockEdges(p) {
  for (const n of p.nodes) if (n.type === 'group') pruneBlockEdges(n.inner);
  const blocks = new Map(p.nodes.filter(n => n.type === 'group').map(n => [n.id, new Set(ports(p, n).map(x => x.id))]));
  if (!blocks.size) return;
  p.edges = p.edges.filter(e => !(blocks.has(e.from.node) && !blocks.get(e.from.node).has(e.from.port)) && !(blocks.has(e.to.node) && !blocks.get(e.to.node).has(e.to.port)));
}

/** Follow a path of block ids from the root project to the edited sub-schematic. */
export function resolvePath(root, path) {
  let q = root;
  for (const id of path) {
    const n = q?.nodes.find(x => x.id === id);
    if (n?.type !== 'group') return null;
    q = n.inner;
  }
  return q;
}

// ---------- undo / redo ----------
export class History {
  constructor(limit = 200) { this.undo = []; this.redo = []; this.limit = limit; }
  push(p) {
    this.undo.push(JSON.stringify(p));
    if (this.undo.length > this.limit) this.undo.shift();
    this.redo = [];
  }
  back(p) {
    if (!this.undo.length) return null;
    this.redo.push(JSON.stringify(p));
    return JSON.parse(this.undo.pop());
  }
  forward(p) {
    if (!this.redo.length) return null;
    this.undo.push(JSON.stringify(p));
    return JSON.parse(this.redo.pop());
  }
  clear() { this.undo = []; this.redo = []; }
}
