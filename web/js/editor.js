// Modal editor for user recipes (custom database). Copies keep their source.
import { $t } from './i18n.js';
import { api } from './api.js';
import { esc, iconHtml, TIERS, nm } from './fmt.js';

export function openModal(html, cls = '') {
  const wrap = document.createElement('div');
  wrap.className = 'modal-wrap';
  wrap.innerHTML = `<div class="modal ${cls}"><button class="mclose" title="${$t("Закрыть")}">✕</button>${html}</div>`;
  document.body.appendChild(wrap);
  const close = () => wrap.remove();
  wrap.querySelector('.mclose').onclick = close;
  wrap.addEventListener('pointerdown', e => { if (e.target === wrap) close(); });
  return { el: wrap.querySelector('.modal'), close };
}

export function editRecipe(app, recipe, asCopy) {
  const st = recipe ? JSON.parse(JSON.stringify(recipe)) : {
    machine: { name: '' }, inputs: [], outputs: [], gt: { durationTicks: null, eut: null }, targetPackVersion: '2.8.4', source: { type: 'manual' },
  };
  if (asCopy) {
    st.source = { type: 'copy', dataset: recipe.dataset, recipeId: recipe.id, datasetSha256: recipe.snapshot?.datasetSha256 ?? app.status?.active?.sha256 ?? null, copiedAt: new Date().toISOString() };
    delete st.id; st.targetPackVersion = app.status?.install?.packVersion || '2.8.4';
    st.machine = { name: recipe.machine?.name };
  }
  st.gt = st.gt || { durationTicks: null, eut: null };
  const ds = app.iconDataset();
  const m = openModal('<div class="ed"></div>', 'wide');
  const root = m.el.querySelector('.ed');

  const ioRows = key => st[key].map((e, i) => `<tr data-key="${key}" data-i="${i}">
      <td>${iconHtml(e.kind === 'oredict' ? (e.variants?.[0] || e) : e, ds, 'small')} ${esc(nm(e))}<br><small>${esc(e.id)}${e.kind === 'oredict' ? $t(' · словарь руд') : ''}</small></td>
      <td><input type="number" min="0" step="any" data-k="amount" value="${e.amount}"> ${e.kind === 'fluid' ? 'L' : ''}</td>
      <td>${key === 'outputs' ? `<input type="number" min="0.01" max="100" step="any" data-k="prob" value="${+(e.probability * 100).toFixed(4)}">%` : `<label class="chk"><input type="checkbox" data-k="consumed" ${e.consumed !== false ? 'checked' : ''}> ${$t("расх.")}</label>`}</td>
      <td><button data-rm>✕</button></td></tr>`).join('');

  const draw = () => {
    root.innerHTML = `<h3>${st.id ? $t('Свой рецепт') : asCopy ? $t('Копия рецепта в свою базу') : $t('Новый рецепт')}</h3>
      <div class="note small">${$t("Источник:")} ${st.source.type === 'copy' ? `${$t("копия")} <code>${esc(st.source.recipeId)}</code> ${$t("из набора")} <b>${esc(st.source.dataset)}</b>` : esc(st.source.type === 'manual' ? $t('ручной ввод') : st.source.type)}${$t(". Исходный рецепт каталога не изменяется.")}</div>
      <div class="grid2">
        <label>${$t("Машина / карта рецептов")} <input data-g="machine" value="${esc(st.machine.name || '')}" list="machlist"></label>
        <label>${$t("Для версии сборки")} <input data-g="target" value="${esc(st.targetPackVersion || '')}"></label>
        <label>${$t("Длительность, тиков")} <input type="number" min="1" step="1" data-g="ticks" value="${st.gt.durationTicks ?? ''}" placeholder="${$t("нет данных")}"></label>
        <label>EU/t <input type="number" min="0" step="any" data-g="eut" value="${st.gt.eut ?? ''}" placeholder="${$t("нет данных")}"></label>
        <label>${$t("Уровень")} <select data-g="tier"><option value="">—</option>${TIERS.map((t, i) => `<option value="${i}" ${st.gt.tier === i ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        <label>${$t("Примечание")} <input data-g="note" value="${esc(st.note || '')}"></label>
      </div>
      <h4>${$t("Входы")}</h4><table class="io ed">${ioRows('inputs')}</table>
      <div class="adder" data-key="inputs"><input placeholder="${$t("+ добавить вход: поиск предмета/жидкости…")}"><div class="hits"></div></div>
      <h4>${$t("Выходы")}</h4><table class="io ed">${ioRows('outputs')}</table>
      <div class="adder" data-key="outputs"><input placeholder="${$t("+ добавить выход: поиск…")}"><div class="hits"></div></div>
      ${(st.warnings || []).length ? `<div class="note warn">${st.warnings.map(esc).join('<br>')}</div>` : ''}
      <div class="note small">${$t("Пустые поля сохраняются как «нет данных» — планировщик не подставляет значения.")}</div>
      <div class="btnrow"><button class="primary" data-save>${$t("Сохранить в свою базу")}</button><button data-cancel>${$t("Отмена")}</button></div>`;
  };
  draw();

  root.addEventListener('change', e => {
    const t = e.target;
    const g = t.dataset.g;
    const v = t.value === '' ? null : +t.value;
    if (g === 'machine') st.machine = { ...st.machine, name: t.value };
    if (g === 'target') st.targetPackVersion = t.value;
    if (g === 'note') st.note = t.value;
    if (g === 'ticks') st.gt.durationTicks = v;
    if (g === 'eut') { st.gt.eut = v; st.gt.voltage = null; st.gt.amperage = null; }
    if (g === 'tier') { st.gt.tier = v; st.gt.tierName = v == null ? null : TIERS[v]; }
    const row = t.closest('tr[data-key]');
    if (row) {
      const e2 = st[row.dataset.key][+row.dataset.i];
      if (t.dataset.k === 'amount') e2.amount = +t.value;
      if (t.dataset.k === 'prob') e2.probability = Math.min(1, Math.max(0.0001, +t.value / 100));
      if (t.dataset.k === 'consumed') e2.consumed = t.checked;
    }
  });
  root.addEventListener('click', async e => {
    const t = e.target;
    if (t.dataset.rm != null) { const row = t.closest('tr'); st[row.dataset.key].splice(+row.dataset.i, 1); draw(); }
    if (t.dataset.cancel != null) m.close();
    const hit = t.closest('[data-hit]');
    if (hit) {
      const key = hit.closest('.adder').dataset.key;
      const g = JSON.parse(hit.dataset.hit);
      st[key].push({ kind: g.kind, id: g.id, name: g.name, icon: g.icon, amount: g.kind === 'fluid' ? 1000 : 1, probability: 1, ...(key === 'inputs' ? { consumed: true } : {}) });
      draw();
    }
    if (t.dataset.save != null) {
      try {
        const saved = await api.saveCustom(st);
        m.close();
        app.toast($t('Рецепт сохранён: ') + saved.id + (saved.warnings?.length ? $t(' (есть предупреждения)') : ''));
        app.refreshStatus();
        app.catalog.setMode('custom');
      } catch (err) { app.toast(err.message, 'error'); }
    }
  });
  let timer;
  root.addEventListener('input', e => {
    const ad = e.target.closest('.adder');
    if (!ad) return;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = e.target.value.trim();
      const hits = ad.querySelector('.hits');
      if (!q) { hits.innerHTML = ''; return; }
      try {
        const r = await api.search(q);
        hits.innerHTML = r.goods.slice(0, 12).map(g => `<div class="li" data-hit='${esc(JSON.stringify({ kind: g.kind, id: g.id, name: g.name, nameRu: g.nameRu, icon: g.icon }))}'>${iconHtml(g, ds, 'small')} ${esc(nm(g))} <small>${esc(g.id)}</small></div>`).join('') || `<small>${$t("нет совпадений")}</small>`;
      } catch (err) { hits.innerHTML = `<small>${esc(err.message)}</small>`; }
    }, 200);
  });
}
