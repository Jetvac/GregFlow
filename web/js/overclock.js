// GregTech overclock, parallel and heat rules, ported from GT5-Unofficial 5.09.51.482
// (the version in GTNH 2.8.x), so that the planner gives the same numbers as the game:
//   gregtech/api/util/OverclockCalculator.java  calculateOverclock, calculateMultiplierUnderOneTick
//   gregtech/api/util/ParallelHelper.java       build (power / parallel limits)
//   gregtech/api/logic/ProcessingLogic.java     defaults: amperage OC on, 1 tier skip
//   gregtech/api/metatileentity/implementations/MTEMultiBlockBase.java  setProcessingLogicPower
//   gregtech/common/tileentities/machines/multi/MTEElectricBlastFurnace.java  heat
//   gregtech/api/enums/HeatingCoilLevel.java   coil heat = 1 + 900 × level
// Tiers here are planner indices: 0 = LV (GT tier 1).
import { TIER_V } from './fmt.js';

// GTUtility.log4 / log4ceil on positive integers
const log4 = a => (a <= 1 ? 0 : Math.floor(Math.log2(Math.floor(a)) / 2));
const log4ceil = a => (a <= 1 ? 0 : Math.ceil(Math.log2(Math.floor(a)) / 2 - 1e-12));
/** GTUtility.getTier: voltage → GT tier (1 = LV). */
export function gtTierOf(v) {
  if (v <= 8) return 0;
  const log2 = Math.ceil(Math.log2(v) - 1e-12);
  return Math.floor((log2 - 2) / 2);
}

/**
 * Heating coils by level (HeatingCoilLevel LV..MAX); heat = 1 + 900 × ordinal. The block is
 * gregtech:gt.blockcasings5 with the meta from BlockCasings5.getCoilHeatFromDamage; its English
 * name is the item name in the recipe data (other languages come from the names file).
 */
export const COILS = [
  ['Cupronickel', 0], ['Kanthal', 1], ['Nichrome', 2], ['TPV-Alloy', 3], ['HSS-G', 4], ['HSS-S', 9],
  ['Naquadah', 5], ['Naquadah Alloy', 6], ['Trinium', 10], ['Electrum Flux', 7], ['Awakened Draconium', 8],
  ['Infinity', 11], ['Hypogen', 12], ['Eternal', 13],
].map(([en, meta], i) => ({ i, heat: 1 + 900 * (i + 2), item: { kind: 'item', id: 'i:gregtech:gt.blockcasings5:' + meta, name: en + ' Coil Block', icon: -1 } }));

/** Electric Blast Furnace heat: coil heat + 100 K per tier of the summed hatch voltage above MV. */
export function ebfHeat(coil, tier, hatches = 1) {
  const c = COILS[coil];
  if (!c) return null;
  return c.heat + 100 * (gtTierOf(TIER_V[tier] * Math.max(1, hatches)) - 2);
}

/**
 * Single-block machine (MTEBasicMachine.calculateOverclockedNess): voltage V[tier], 1 A,
 * no amperage overclock. Duration is divided per overclock and floored once, never below
 * 1 tick; EU/t keeps rising ×4 per overclock even at 1 tick (as in this GT version).
 */
export function singleOc(eut, ticks, tier, perfect = false) {
  const V = TIER_V[tier];
  const E = Math.max(0, eut || 0);
  const tiersAbove = log4(Math.floor(V / Math.max(Math.floor(E), 32)));
  const vt = Math.max(log4ceil(Math.floor(V / 8)), 1) - Math.max(log4ceil(Math.floor(E / 8)), 1); // long division in GT
  const ocs = Math.max(0, Math.min(tiersAbove, vt));
  const div = perfect ? 4 : 2;
  return {
    ocs,
    eut: Math.ceil(E * 4 ** ocs),
    ticks: ticks == null ? null : Math.max(1, Math.floor(ticks / div ** ocs)),
    parallel: 1,
  };
}

/**
 * Multiblock with ordinary energy hatches (ProcessingLogic + ParallelHelper with unlimited inputs,
 * no batch mode). One hatch counts as 1 A for overclocking; two or more give 2 A each.
 * o: { tier, hatches, parallel, speedPct (x% faster), euPct (% of normal EU/t), perfect,
 *      heat: null | { machine, recipe } }
 * Returns { ocs, eut, ticks, parallel, heatOcs, discount, A, blocked } — blocked is
 * 'heat' | 'power' | 'voltage' when the machine cannot run the recipe at all.
 */
export function multiOc(eut, ticks, o) {
  const V = TIER_V[o.tier];
  const hatches = Math.max(1, Math.floor(o.hatches || 1));
  const A = hatches === 1 ? 1 : 2 * hatches;
  const avail = V * A;
  const E = Math.max(0, eut || 0);
  const P = Math.max(1, Math.floor(o.parallel || 1));
  const euMod = o.euPct > 0 ? o.euPct / 100 : 1;
  const speed = o.speedPct > 0 ? 1 / (1 + o.speedPct / 100) : 1;
  const div = o.perfect ? 4 : 2;
  const heat = o.heat;
  const base = { A, avail, ocs: 0, heatOcs: 0, discount: 1, eut: 0, ticks: null, parallel: 0 };
  if (heat && !(heat.machine >= heat.recipe)) return { ...base, blocked: 'heat' };
  const discount = heat ? 0.95 ** Math.floor((heat.machine - heat.recipe) / 900) : 1;
  const heatOcMax = heat ? Math.floor((heat.machine - heat.recipe) / 1800) : 0;
  const tRecipe = Math.ceil(E * euMod * discount);
  if (avail < tRecipe) return { ...base, discount, blocked: 'power' };
  if (E > V * 4) return { ...base, discount, blocked: 'voltage' };
  const dur0 = ticks == null ? null : ticks * speed;

  // overclocks for a given parallel (amperage OC: limited by power only)
  const ocFor = p => {
    const rp = E * p * euMod * discount;
    const oc = Math.max(0, log4(Math.floor(Math.floor(avail) / Math.max(Math.floor(rp), 32))));
    const h = Math.min(heatOcMax, oc);
    return { rp, oc, h, reg: oc - h };
  };
  // extra parallels from overclocks past 1 tick (calculateMultiplierUnderOneTick)
  let mult = 1;
  if (dur0 != null && dur0 > 0) {
    const { h, reg } = ocFor(P);
    const needH = Math.ceil(Math.log(dur0) / Math.log(4));
    const afterH = dur0 / 4 ** h;
    const needR = Math.ceil(Math.log(afterH) / Math.log(div));
    const hm = 4 ** Math.max(h - needH, 0), rm = div ** Math.max(reg - needR, 0);
    let corr = null;
    if (h >= needH) corr = 4 ** needH / dur0;
    else if (reg >= needR) corr = div ** needR / afterH;
    if (corr != null) mult = Math.ceil(hm * rm * corr);
  }
  const maxPar = Math.floor(P * mult);
  const par = tRecipe > 0 ? Math.min(maxPar, Math.floor(avail / tRecipe)) : maxPar;
  const { rp, oc, h, reg } = ocFor(Math.min(P, par));
  return {
    ...base, discount, ocs: oc, heatOcs: h, parallel: par,
    eut: Math.ceil(rp * 4 ** oc),
    ticks: dur0 == null ? null : Math.max(1, Math.floor(dur0 / 4 ** h / div ** reg)),
  };
}
