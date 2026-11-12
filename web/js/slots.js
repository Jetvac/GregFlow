// Robot arm slot numbers for GT single-block machines.
//
// Facts used (GT5-Unofficial 5.09.51.482, the version in GTNH 2.8.x):
// - CoverArm: a configured slot N > 0 means inventory slot N - 1; 0 means any slot.
// - MTEBasicMachine: inventory slots 0-4 are service slots (4 = programmed circuit, which
//   automation cannot insert into), item inputs start at 5, item outputs at 5 + input slot count.
// - Recipe item output i is put into output slot i; when that slot is full it goes to the next one.
// - Any input slot accepts any recipe input, so input numbers are a suggested layout.
// The input slot count of each machine block comes from data/gt-machine-slots.json.
import { TIERS } from './fmt.js';
import { recipeTier } from './solver.js';

const OTHER = 5; // MTEBasicMachine.OTHER_SLOT_COUNT
let table = null;

export function setSlotTable(t) { table = t?.machines || {}; }
export const slotTableLoaded = () => table != null;

const isCircuit = e => /^i:gregtech:gt\.integrated_circuit:/.test(e?.id || '');
const metaOf = b => { const m = /^i:gregtech:gt\.blockmachines:(\d+)$/.exec(b?.id || ''); return m ? m[1] : null; };

/**
 * Arm slot numbers for a machine node.
 * @returns null when the recipe has no GT single-block machine, else
 *  { inputs: [n|null per recipe input], outputs: [n|null per recipe output], block, reason }
 *  where block is the machine block at the node's tier (or null when it is unknown or ambiguous).
 */
export function armSlots(recipe, node, params) {
  if (!table || !recipe || node?.multi) return null; // multiblocks: arms go on buses
  const blocks = (recipe.machine?.singleblocks || []).map(b => ({ b, d: table[metaOf(b)] })).filter(x => x.d);
  if (!blocks.length) return null;
  const tierIdx = params?.tier ?? node?.tier ?? recipeTier(recipe);
  const gtTier = tierIdx + 1; // TIERS[0] is LV, GT tier 1
  const here = blocks.filter(x => x.d.tier === gtTier);
  const counts = new Set(here.map(x => x.d.inputs));
  const block = here.length && counts.size === 1 ? { ...here[0].d, item: here[0].b } : null;
  const reason = !here.length ? 'notier' : counts.size > 1 ? 'ambiguous' : null;

  let k = 0;
  const inputs = recipe.inputs.map(e => {
    if (e.kind === 'fluid' || isCircuit(e)) return null;
    const n = k++;
    if (block && n >= block.inputs) return null;
    return OTHER + n + 1;
  });
  let j = 0;
  const outputs = recipe.outputs.map(e => {
    if (e.kind === 'fluid') return null;
    const n = j++;
    if (!block || n >= block.outputs) return null;
    return OTHER + block.inputs + n + 1;
  });
  return { inputs, outputs, block, reason, tier: TIERS[tierIdx], circuit: recipe.inputs.findIndex(isCircuit) };
}

/** The single-block machine item of this recipe at planner tier `tierIdx`, or null when unknown / ambiguous. */
export function singleBlockAt(recipe, tierIdx) {
  if (!table || !recipe) return null;
  const here = (recipe.machine?.singleblocks || []).map(b => ({ b, d: table[metaOf(b)] })).filter(x => x.d && x.d.tier === tierIdx + 1);
  return here.length === 1 ? here[0].b : null;
}
