// Auto-arrange: columns left to right following the material flow (layered layout).
// Loops are broken at their back links; energy links do not set columns, generators sit at
// the bottom of their column.

/**
 * New positions for `ids` (all nodes of `p` when null). `size(n)` gives {w,h} of a card.
 * Returns Map id -> {x,y}; the arranged group keeps its top-left corner.
 */
export function arrange(p, ids, size) {
  const S = new Set(ids || p.nodes.map(n => n.id));
  const nodes = p.nodes.filter(n => S.has(n.id));
  if (nodes.length < 2) return new Map();
  const byId = new Map(nodes.map(n => [n.id, n]));
  const links = p.edges.filter(e => !e.energy && S.has(e.from.node) && S.has(e.to.node) && e.from.node !== e.to.node);
  const elinks = p.edges.filter(e => e.energy && S.has(e.from.node) && S.has(e.to.node));
  const outs = new Map(nodes.map(n => [n.id, []]));
  for (const e of links) outs.get(e.from.node).push(e.to.node);

  // drop back links (DFS from the left-most nodes, as the user placed them)
  const order = [...nodes].sort((a, b) => a.x - b.x || a.y - b.y);
  const state = new Map(), back = new Set();
  const visit = id => {
    state.set(id, 1);
    for (const t of outs.get(id)) {
      if (state.get(t) === 1) back.add(id + '>' + t);
      else if (!state.get(t)) visit(t);
    }
    state.set(id, 2);
  };
  for (const n of order) if (!state.get(n.id)) visit(n.id);
  const fwd = links.filter(e => !back.has(e.from.node + '>' + e.to.node));

  // column = longest path from a node without inputs
  const preds = new Map(nodes.map(n => [n.id, []]));
  for (const e of fwd) preds.get(e.to.node).push(e.from.node);
  const col = new Map();
  const colOf = (id, guard = 0) => {
    if (col.has(id)) return col.get(id);
    if (guard > nodes.length) return 0;
    const ps = preds.get(id);
    const c = ps.length ? Math.max(...ps.map(x => colOf(x, guard + 1))) + 1 : 0;
    col.set(id, c);
    return c;
  };
  for (const n of nodes) colOf(n.id);
  // a generator without fuel links sits one column left of the first machine it powers
  for (const e of elinks) {
    const g = byId.get(e.from.node);
    if (g?.type === 'generator' && !preds.get(g.id).length) col.set(g.id, Math.min(col.get(g.id) || 0, Math.max(0, (col.get(e.to.node) || 0) - 1)));
  }
  // sinks and block outputs go one column right of everything that feeds them
  for (const n of nodes) {
    if (n.type !== 'sink' && n.type !== 'gout') continue;
    const ps = p.edges.filter(e => e.to.node === n.id && S.has(e.from.node)).map(e => col.get(e.from.node) || 0);
    if (ps.length) col.set(n.id, Math.max(...ps) + 1);
  }

  const cols = [];
  for (const n of nodes) (cols[col.get(n.id)] ??= []).push(n);
  const layers = cols.filter(Boolean);
  // order inside a column: start from the current vertical order, then barycentres
  layers.forEach(l => l.sort((a, b) => a.y - b.y));
  const pos = new Map();
  const index = () => layers.forEach(l => l.forEach((n, i) => pos.set(n.id, i / Math.max(1, l.length - 1))));
  const nb = new Map(nodes.map(n => [n.id, []]));
  for (const e of [...links, ...elinks]) { nb.get(e.from.node).push(e.to.node); nb.get(e.to.node).push(e.from.node); }
  const rank = n => n.type === 'generator' ? 1 : 0;
  for (let it = 0; it < 6; it++) {
    index();
    const ls = it % 2 ? [...layers].reverse() : layers;
    for (const l of ls) {
      const bc = new Map(l.map(n => {
        const xs = nb.get(n.id).map(id => pos.get(id)).filter(v => v != null);
        return [n.id, xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : pos.get(n.id)];
      }));
      l.sort((a, b) => rank(a) - rank(b) || bc.get(a.id) - bc.get(b.id));
    }
  }

  // coordinates
  const GX = 110, GY = 40;
  const x0 = Math.min(...nodes.map(n => n.x)), y0 = Math.min(...nodes.map(n => n.y));
  const heights = layers.map(l => l.reduce((h, n) => h + size(n).h, 0) + GY * (l.length - 1));
  const H = Math.max(...heights);
  const res = new Map();
  let x = x0;
  layers.forEach((l, i) => {
    let y = y0 + (H - heights[i]) / 2;
    for (const n of l) {
      res.set(n.id, { x: Math.round(x / 10) * 10, y: Math.round(y / 10) * 10 });
      y += size(n).h + GY;
    }
    x += Math.max(...l.map(n => size(n).w)) + GX;
  });
  return res;
}
