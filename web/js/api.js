// Thin wrapper around the local planner HTTP API.
import { $t, $tm } from './i18n.js';
import { learnFrom } from './fmt.js';
async function req(method, path, body, raw = false) {
  const opt = { method, headers: {} };
  if (body !== undefined) {
    if (raw) { opt.body = body; opt.headers['Content-Type'] = 'application/octet-stream'; }
    else { opt.body = JSON.stringify(body); opt.headers['Content-Type'] = 'application/json'; }
  }
  const r = await fetch('/api/' + path, opt);
  let data;
  try { data = await r.json(); } catch { data = { error: $t('Некорректный ответ сервера (') + r.status + ')' }; }
  if (!r.ok) throw new Error($tm(data.error) || ('HTTP ' + r.status));
  return learnFrom(data);
}
/** Must match APP_VERSION in server/app.py (checked by the tests). */
export const CLIENT_VERSION = '1.1.1';
const qs = o => Object.entries(o).filter(([, v]) => v != null && v !== '').map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');

export const api = {
  status: () => req('GET', 'status'),
  search: (q, type) => req('GET', 'search?' + qs({ q, type })),
  goods: id => req('GET', 'goods?' + qs({ id })),
  recipes: (id, mode, machine, offset = 0, q, side, maxTier) => req('GET', 'recipes?' + qs({ id, mode, machine, offset, q, side, maxTier })),
  machine: (name, q, offset = 0, side, maxTier) => req('GET', 'machine?' + qs({ name, q, offset, side, maxTier })),
  recipe: id => req('GET', 'recipe?' + qs({ id })),
  custom: () => req('GET', 'custom'),
  saveCustom: r => req('POST', 'custom', r),
  deleteCustom: id => req('DELETE', 'custom?' + qs({ id })),
  importCustom: obj => req('POST', 'custom/import', obj),
  importDataset: (bytes, label, packVersion) => req('POST', 'datasets/import?' + qs({ label, packVersion }), bytes, true),
  importAtlas: (id, bytes) => req('POST', 'datasets/atlas?' + qs({ id }), bytes, true),
  activate: id => req('POST', 'datasets/activate?' + qs({ id })),
  projects: () => req('GET', 'projects'),
  project: file => req('GET', 'project?' + qs({ file })),
  saveProject: p => req('POST', 'project', p),
  deleteProject: file => req('DELETE', 'project?' + qs({ file })),
  names: ids => req('POST', 'names', { ids }),
  fetchLang: () => req('POST', 'lang/fetch', {}),
  energy: () => req('GET', 'energy'),
  fuels: map => req('GET', 'energy/fuels?' + qs({ map })),
  setupDownload: () => req('POST', 'setup/download', {}),
  setupProgress: () => req('GET', 'setup/progress'),
  setupInstalls: () => req('GET', 'setup/installs'),
  setupMcDir: path => req('POST', 'setup/mcdir', { path }),
  setupSettings: values => req('POST', 'setup/settings', values),
  machineSlots: () => req('GET', 'machineslots'),
};
