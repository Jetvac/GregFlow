// Bill of machines: all machines, generators and cables of a project, grouped.
import { $t, lbl } from './i18n.js';
import { TIERS, nm, mname } from './fmt.js';
import { recipeOf, energyOn } from './model.js';

const GT_TIERS = ['ULV', ...TIERS];
const voltTier = v => { const i = [8, 32, 128, 512, 2048, 8192, 32768, 131072, 524288, 2097152, 8388608, 33554432, 134217728, 536870912].indexOf(+v); return i >= 0 ? GT_TIERS[i] : (v ? v + $t(' В') : '—'); };

export function machineList(root, rootR) {
  const mach = new Map(), gens = new Map(), cables = new Map();
  const totals = { machines: 0, euFull: 0, euAvg: 0, generators: 0, capacity: 0, generated: 0, losses: 0, unpowered: 0 };
  // blocks are walked recursively; `path` (block ids) lets the list open the right block
  const walk = (p, R, path) => {
  for (const n of p.nodes) {
    const s = R?.nodes[n.id];
    if (n.synthetic) continue;
    if (n.type === 'group') { walk(n.inner, s?.innerR, [...path, n.id]); continue; }
    if (n.type === 'machine') {
      const r = recipeOf(p, n);
      const mp = s?.params;
      const tier = TIERS[mp?.tier ?? 0] || '?';
      const nameEn = r?.machine?.name || $t('Машина');
      const k = nameEn + '|' + tier;
      if (!mach.has(k)) mach.set(k, { name: mname(r?.machine) || nameEn, nameEn, tier, tierIdx: mp?.tier ?? 0, count: 0, utilSum: 0, utilN: 0, euFull: 0, euAvg: 0, nodes: [] });
      const g = mach.get(k);
      const c = n.count ?? 1;
      g.count += c;
      if (s?.util != null) { g.utilSum += s.util * c; g.utilN += c; }
      g.euFull += s?.powerFull || 0; g.euAvg += s?.powerAvg || 0;
      const out = r?.outputs?.[0];
      g.nodes.push({ id: n.id, count: c, label: lbl(n.label) || (out ? nm(out) : g.name), path });
      totals.machines += c; totals.euFull += s?.powerFull || 0; totals.euAvg += s?.powerAvg || 0;
    }
    if (n.type === 'generator' && energyOn(root)) {
      const name = nm(n.gen) || lbl(n.label) || $t('Генератор');
      const tier = voltTier(n.voltage);
      const k = name + '|' + tier + '|' + (n.amps ?? 1);
      if (!gens.has(k)) gens.set(k, { name, tier, count: 0, output: 0, capacity: 0, fuel: new Set(), nodes: [] });
      const g = gens.get(k);
      g.count += n.count ?? 1;
      g.output += s?.output || 0; g.capacity += s?.capacity || 0;
      if (n.fuel?.res) g.fuel.add(nm(n.fuel.res));
      g.nodes.push({ id: n.id, label: n.label && n.label !== 'Генератор' ? lbl(n.label) : name, path });
      totals.generators += n.count ?? 1; totals.capacity += s?.capacity || 0; totals.generated += s?.output || 0;
    }
  }
  if (energyOn(root)) {
    for (const e of p.edges) {
      if (!e.energy || !e.cable) continue;
      const s = R?.edges[e.id];
      const k = e.cable.id;
      if (!cables.has(k)) cables.set(k, { name: nm(e.cable), tier: e.cable.tier || voltTier(e.cable.voltage), blocks: 0, links: 0, loss: 0 });
      const c = cables.get(k);
      c.blocks += Math.max(0, +e.length || 0); c.links += 1; c.loss += s?.loss || 0;
      totals.losses += s?.loss || 0;
    }
  }
  };
  walk(root, rootR, []);
  totals.unpowered = rootR?.energy?.unpowered || 0;
  const machines = [...mach.values()].map(g => ({ ...g, util: g.utilN ? g.utilSum / g.utilN : null }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru') || a.tierIdx - b.tierIdx);
  const generators = [...gens.values()].map(g => ({ ...g, fuel: [...g.fuel].join(', ') })).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  return { machines, generators, cables: [...cables.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru')), totals };
}

/** Plain-text table (tab separated) for copying into notes / spreadsheets. */
export function machineListText(L, withEnergy, balance = []) {
  const r1 = v => Math.round(v * 10) / 10;
  const lines = [$t('Машина\tУровень\tШт.\tЗагрузка %\tEU/t полная\tEU/t факт.')];
  for (const g of L.machines) lines.push([g.name, g.tier, g.count, g.util == null ? '' : r1(g.util * 100), r1(g.euFull), r1(g.euAvg)].join('\t'));
  lines.push([$t('Итого'), '', L.totals.machines, '', r1(L.totals.euFull), r1(L.totals.euAvg)].join('\t'));
  if (withEnergy) {
    lines.push('', $t('Генератор\tУровень\tШт.\tEU/t выдаёт\tEU/t макс.\tТопливо'));
    for (const g of L.generators) lines.push([g.name, g.tier, g.count, r1(g.output), r1(g.capacity), g.fuel].join('\t'));
    lines.push('', $t('Кабель\tУровень\tБлоков\tСвязей\tПотери EU/t'));
    for (const c of L.cables) lines.push([c.name, c.tier, c.blocks, c.links, r1(c.loss)].join('\t'));
  }
  const r3 = v => Math.round(v * 60 * 1000) / 1000; // per minute
  const bal = balance.filter(b => b.needFull > 0 || b.made > 0 || b.external > 0);
  if (bal.length) {
    lines.push('', $t('Ресурс\tНужно всего /мин\tМакс. производство /мин\tИз источников /мин\tСейчас производится /мин\tСейчас расход /мин\tНехватка на полной мощности /мин'));
    for (const b of bal) lines.push([nm(b.res), r3(b.needFull), r3(b.makeMax), r3(b.external), r3(b.made), r3(b.used), r3(Math.max(0, b.needFull - b.makeMax - b.external))].join('\t'));
  }
  return lines.join('\n');
}
