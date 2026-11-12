// Formatting, units and icon helpers.
import { $t } from './i18n.js';
export const UNITS = {
  s: { label: $t('/с'), mul: 1 },
  min: { label: $t('/мин'), mul: 60 },
  h: { label: $t('/ч'), mul: 3600 },
};
export const TIERS = ['LV', 'MV', 'HV', 'EV', 'IV', 'LuV', 'ZPM', 'UV', 'UHV', 'UEV', 'UIV', 'UMV', 'UXV', 'MAX'];
export const TIER_V = [32, 128, 512, 2048, 8192, 32768, 131072, 524288, 2097152, 8388608, 33554432, 134217728, 536870912, 2147483640];

let unit = 'min';

// --- display names: Russian when known (from the server's name index), else English ---
let lang = 'ru';
const ruGoods = new Map();   // goods id -> Russian name
const ruMachines = new Map(); // recipe map English name -> Russian name
export function setLang(l) { lang = l === 'en' ? 'en' : 'ru'; }
export function getLang() { return lang; }
export function learnNames(goods = {}, machines = {}) {
  for (const [k, v] of Object.entries(goods)) ruGoods.set(k, v);
  for (const [k, v] of Object.entries(machines)) ruMachines.set(k, v);
}
/** Walk any API object and remember nameRu fields. */
export function learnFrom(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 6) return obj;
  if (Array.isArray(obj)) { for (const x of obj) learnFrom(x, depth + 1); return obj; }
  if (obj.nameRu && obj.id) ruGoods.set(obj.id, obj.nameRu);
  if (obj.nameRu && obj.name && !obj.id) ruMachines.set(obj.name, obj.nameRu);
  for (const v of Object.values(obj)) if (v && typeof v === 'object') learnFrom(v, depth + 1);
  return obj;
}
export function nm(e) {
  if (!e) return '';
  if (lang === 'ru') { const r = e.nameRu || ruGoods.get(e.id); if (r) return r; }
  return e.name ?? e.id ?? '';
}
export function mname(m) {
  if (!m) return '';
  if (lang === 'ru') { const r = m.nameRu || ruMachines.get(m.name); if (r) return r; }
  return m.name ?? '';
}
export function setUnit(u) { unit = u; }
export function getUnit() { return unit; }

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function num(v, digits = 2) {
  if (v === Infinity) return '∞';
  if (v == null || Number.isNaN(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(2).replace(/\.?0+$/, '') + 'G';
  if (a >= 1e6) return (v / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M';
  if (a >= 1e4) return (v / 1e3).toFixed(1).replace(/\.?0+$/, '') + 'k';
  if (a >= 100) return v.toFixed(0);
  if (a === 0) return '0';
  if (a < 0.01) return v.toExponential(1);
  return v.toFixed(digits).replace(/\.?0+$/, '');
}

// rate is stored per second
export function rate(v, kind) {
  if (v === Infinity) return '∞';
  const u = UNITS[unit];
  return num(v * u.mul) + (kind === 'fluid' ? ' L' : '') + u.label;
}
export function rateVal(v) { return v * UNITS[unit].mul; }
export function fromUnit(v) { return v / UNITS[unit].mul; }
export function unitLabel() { return UNITS[unit].label; }

export function amount(a, kind) {
  if (kind === 'fluid') return a >= 1000 && a % 1000 === 0 ? (a / 1000) + 'kL' : a + 'L';
  return String(a);
}

export function seconds(ticks) { return num(ticks / 20, 2) + $t(' с'); }

// --- icons: atlas is 256 columns of 32px sprites ---
let atlasFor = () => null;
export function setAtlasResolver(fn) { atlasFor = fn; }

export function iconHtml(g, dataset, extra = '') {
  const url = atlasFor(dataset);
  const id = g?.icon;
  const title = esc((nm(g) || g?.id || '') + (g?.name && nm(g) !== g.name ? '\n' + g.name : ''));
  if (url && id != null && id >= 0) {
    const x = (id % 256) * -32, y = Math.floor(id / 256) * -32;
    return `<div class="icon ${extra}" title="${title}" style="background-image:url('${url}');background-position:${x}px ${y}px"></div>`;
  }
  const letters = esc((g?.name || '?').replace(/[^A-Za-zА-Яа-я0-9]/g, '').slice(0, 2));
  return `<div class="icon noicon ${extra}" title="${title}">${letters}</div>`;
}

export function slotHtml(e, dataset, opts = {}) {
  const fluid = e.kind === 'fluid';
  const prob = e.probability != null && e.probability < 1 ? `<span class="prob">${num(e.probability * 100, 1)}%</span>` : '';
  const nc = e.consumed === false ? `<span class="nc" title="${$t("Не расходуется")}">${$t("НР")}</span>` : '';
  const od = e.kind === 'oredict' ? `<span class="od" title="${$t("Словарь руд: можно выбрать вариант")}">OD</span>` : '';
  const amt = e.amount != null && (fluid || e.amount !== 1) ? `<span class="amt">${esc(amount(e.amount, e.kind))}</span>` : '';
  const g = opts.display || e;
  return `<div class="slot ${fluid ? 'fluid' : ''} ${opts.cls || ''}" title="${esc(nm(g) + (g.name && nm(g) !== g.name ? '\n' + g.name : '') + '\n' + (g.id || ''))}">${iconHtml(g, dataset)}${amt}${prob}${nc}${od}</div>`;
}

// --- energy slot: NEI-style slot with a pixel lightning bolt and the voltage tier ---
const BOLT = '<svg class="bolt" viewBox="0 0 16 16" width="26" height="26" shape-rendering="crispEdges">'
  + '<polygon points="10,0 2,9 7,9 5,16 14,6 9,6 12,0" fill="#5a3a00"/>'
  + '<polygon points="10,1 4,8 8,8 6,14 12,7 8,7 11,1" fill="#ffd21f"/>'
  + '<polygon points="10,1 5,7 7,7" fill="#fff4a8"/></svg>';
export function energySlotHtml(tier, title = $t('Энергия (EU)')) {
  return `<div class="slot eslot" title="${esc(title)}">${BOLT}${tier ? `<span class="amt">${esc(tier)}</span>` : ''}</div>`;
}
