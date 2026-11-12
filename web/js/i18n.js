// Interface language (Russian / English). Keys are the Russian source strings, so the
// Russian UI needs no table. Item and machine names have their own switch (fmt.js).
// The language is read once at start; switching reloads the page.
const KEY = 'gtnh-planner-ui-lang';
function initial() {
  try {
    if (globalThis.__forceUiLang) return globalThis.__forceUiLang;
    const v = localStorage.getItem(KEY);
    if (v === 'en' || v === 'ru') return v;
    if (localStorage.getItem('gtnh-planner-autosave-v1')) return 'ru'; // used the planner before it had English
    return (navigator.language || '').toLowerCase().startsWith('ru') ? 'ru' : 'en';
  } catch { return 'ru'; }
}
let ui = initial();
export const uiLang = () => ui;
export function setUiLang(l) {
  try { localStorage.setItem(KEY, l === 'en' ? 'en' : 'ru'); } catch { /* storage unavailable */ }
}

const missing = new Set();
/** Translate a Russian UI string. */
export function $t(s) {
  if (ui === 'ru' || s == null) return s;
  const v = EN[s];
  if (v !== undefined) return v;
  const k = s.trim();
  if (k !== s && EN[k] !== undefined) return s.replace(k, EN[k]);
  if (!missing.has(s)) { missing.add(s); if (globalThis.__i18nDebug) console.warn('i18n missing:', s); }
  return s;
}
export const i18nMissing = () => [...missing];

/** Messages from the local server (Russian, may carry a variable tail): exact, then by prefix. */
export function $tm(s) {
  if (ui === 'ru' || !s) return s;
  if (EN[s] !== undefined) return EN[s];
  for (const [ru, en] of SERVER_SUFFIX) if (s.endsWith(ru)) s = s.slice(0, -ru.length) + en;
  for (const [ru, en] of SERVER_PREFIX) if (s.startsWith(ru)) return en + s.slice(ru.length);
  return s;
}
const SERVER_PREFIX = [
  ['Набор данных недоступен: ', 'Dataset not available: '],
  ['Файл не распознан как data.bin GTNH Calculator: ', 'The file is not a GTNH Calculator data.bin: '],
  ['Неизвестный запрос: ', 'Unknown request: '],
  ['Внутренняя ошибка: ', 'Internal error: '],
  ['Неподдерживаемый формат data.bin: ', 'Unsupported data.bin format: '],
  ['Неверный тип ресурса: ', 'Invalid resource type: '],
  ['Неверное количество у ', 'Invalid amount for '],
  ['Неверное значение ', 'Invalid value '],
  ['Контрольная сумма ', 'Checksum of '],
  ['Файл ', 'File '],
  ['Число записей ', 'Record count '],
];
const SERVER_SUFFIX = [[' не найден — скачайте данные рецептов в окне «Настройка».', ' not found — download the recipe data in the «Setup» window.']];

/** Default node labels are stored in Russian (stable); show them in the interface language. */
const DEFAULT_LABELS = new Set(['Источник', 'Склад', 'Генератор', 'Блок', 'Вход', 'Выход', 'Разветвитель', 'Слияние']);
export const lbl = s => (s && DEFAULT_LABELS.has(s) ? $t(s) : s);

/** Translate static text and titles of the page (index.html). */
export function translateStatic(root = document.body) {
  if (ui === 'ru') return;
  document.documentElement.lang = 'en';
  document.title = $t(document.title);
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (w.nextNode()) nodes.push(w.currentNode);
  for (const n of nodes) {
    const k = n.nodeValue.trim();
    if (k && EN[k] !== undefined) n.nodeValue = n.nodeValue.replace(k, EN[k]);
  }
  for (const el of root.querySelectorAll('[title],[placeholder]')) {
    for (const a of ['title', 'placeholder']) {
      const v = el.getAttribute(a);
      if (v && EN[v] !== undefined) el.setAttribute(a, EN[v]);
    }
  }
}

const EN = {
  // ---- page / toolbar
  'GregFlow — планировщик линий GTNH': 'GregFlow — GTNH line planner',
  'Новая': 'New', 'Открыть': 'Open', 'Сохранить': 'Save', 'Экспорт': 'Export', 'Импорт': 'Import', 'Демо': 'Demo',
  'Новая схема': 'New schematic',
  'Открыть из папки projects/': 'Open from the projects/ folder',
  'Сохранить в projects/ (Ctrl+S)': 'Save to projects/ (Ctrl+S)',
  'Скачать файл схемы': 'Download the schematic file',
  'Загрузить файл схемы': 'Load a schematic file',
  'Пример с условными значениями источников': 'Example with made-up source rates',
  'Отменить (Ctrl+Z)': 'Undo (Ctrl+Z)', 'Повторить (Ctrl+Y)': 'Redo (Ctrl+Y)',
  '⤢ Вписать': '⤢ Fit', 'Вписать схему (F)': 'Fit the schematic (F)',
  '+ Разветвитель': '+ Splitter', '+ Слияние': '+ Merger', '+ Склад': '+ Storage', '+ Генератор': '+ Generator',
  'Добавить разветвитель': 'Add a splitter', 'Добавить слияние': 'Add a merger', 'Добавить склад': 'Add a storage',
  'Добавить генератор (включает учёт энергии)': 'Add a generator (turns energy accounting on)',
  '▦ В блок': '▦ Make block', '+ Вход блока': '+ Block input', '+ Выход блока': '+ Block output',
  'Добавить вход блока': 'Add a block input', 'Добавить выход блока': 'Add a block output',
  'Объединить выделенные узлы в блок (Ctrl+G). Выделение: Ctrl/Shift + щелчок или Shift + рамка': 'Combine the selected nodes into a block (Ctrl+G). Select with Ctrl/Shift + click or Shift + drag a frame',
  '⚡ Энергия': '⚡ Energy',
  'Учитывать энергию: генераторы, кабели, потери. Выключено — схема считается без энергии': 'Account for energy: generators, cables, losses. Off — the schematic is calculated without energy',
  '☰ Список машин': '☰ Machine list',
  'Сводный список всех машин, генераторов и кабелей схемы': 'Summary of all machines, generators and cables in the schematic',
  'Названия': 'Item names', 'Язык названий предметов и машин': 'Language of item and machine names',
  'русские': 'Russian', 'английские': 'English',
  'Единицы': 'Units', 'в секунду': 'per second', 'в минуту': 'per minute', 'в час': 'per hour',
  'Интерфейс': 'Interface', 'Язык интерфейса': 'Interface language',
  // ---- app.js
  'Некорректный ответ сервера (': 'Invalid server response (',
  'Выделите узлы: Ctrl/Shift + щелчок или Shift + рамка': 'Select nodes: Ctrl/Shift + click or Shift + drag a frame',
  'Блок создан: узлов': 'Block created: nodes', ', входов': ', inputs', ', выходов': ', outputs',
  '. Двойной щелчок — открыть.': '. Double-click to open.',
  'Блок разгруппирован': 'Block dissolved',
  'Новая линия': 'New line',
  'Источник рецептов — нажмите для подробностей': 'Recipe source — click for details',
  'Рецепты:': 'Recipes:', 'нет': 'none', '✓ проверено': '✓ verified', '⚠ не проверено': '⚠ not verified',
  '(только чтение)': '(read-only)', 'Сборка:': 'Modpack:', ' ⚠ не совпадает': ' ⚠ mismatch',
  'Учёт энергии включён: у машин появился вход ⚡': 'Energy accounting on: machines now have a ⚡ input',
  'Учёт энергии выключен: схема считается без энергии (связи питания сохранены)': 'Energy accounting off: the schematic is calculated without energy (power links are kept)',
  'Список машин схемы': 'Machines of the schematic',
  'Сгруппировано по карте рецептов и уровню машины. Загрузка — средняя по числу машин. EU/t: полная мощность / фактически.': 'Grouped by recipe map and machine tier. Load is averaged over the machine count. EU/t: full capacity / actual.',
  'Машина': 'Machine', 'Уровень': 'Tier', 'Шт.': 'Qty', 'Загрузка': 'Load', 'Узлы': 'Nodes',
  'Машин нет.': 'No machines.', 'Всего машин:': 'Machines total:', 'видов) · EU/t:': 'kinds) · EU/t:',
  'полная /': 'full /', 'факт.': 'actual',
  'Генераторы': 'Generators', 'Генератор': 'Generator', 'EU/t (выдаёт / макс.)': 'EU/t (gives / max)',
  'Топливо': 'Fuel', 'Генераторов нет.': 'No generators.', 'Кабели': 'Cables', 'Кабель': 'Cable',
  'Блоков': 'Blocks', 'Связей': 'Links', 'Потери EU/t': 'Loss EU/t',
  'Кабелей нет (генераторы вплотную или связи без кабеля).': 'No cables (generators adjacent or links without a cable).',
  'Генерация:': 'Generation:', 'EU/t из': 'EU/t of', '· потери в кабелях:': '· cable losses:', 'без питания:': 'unpowered:',
  'Учёт энергии выключен — генераторы и кабели не показаны.': 'Energy accounting is off — generators and cables are not shown.',
  'Копировать как текст': 'Copy as text', 'Список скопирован в буфер обмена': 'List copied to the clipboard',
  '-машины.txt': '-machines.txt',
  'Блок': 'Block', 'ДЕМО — условные значения источников': 'DEMO — made-up source rates',
  'Вернуться на уровень выше': 'Go up one level', '⤴ Выйти из блока': '⤴ Leave block',
  'Показать блок на полной мощности (входы без ограничения) вместо фактической подачи': 'Show the block at full capacity (unlimited inputs) instead of the actual supply',
  'полная мощность': 'full capacity',
  'Учёт энергии включён': 'Energy accounting on',
  'Узел превращён в генератор; учёт энергии включён': 'Node turned into a generator; energy accounting on',
  '. Связей удалено:': '. Links removed:',
  '— генератор потребляет жидкость, а не капсулы; подключите источник жидкости': '— the generator burns the fluid, not cells; connect a fluid source',
  'Рецепт топлива добавлен как генератор (учёт энергии включён)': 'Fuel recipe added as a generator (energy accounting on)',
  'Уровень машин обновлён (не ниже уровня рецепта)': 'Machine tiers updated (not below the recipe tier)',
  'Не удалось автоматически подключить: нет порта с тем же ID': 'Could not connect automatically: no port with the same ID',
  '+ Источник': '+ Source', 'Источник': 'Source',
  'своей базой': 'your recipe base', 'Рецепт удалён из своей базы; узел использует сохранённый снимок.': 'The recipe was removed from your base; the node uses its saved snapshot.',
  'Снимок из набора': 'Snapshot from dataset', '; активен': '; active is', '. Сравнение возможно только с тем же набором.': '. Comparison works only with the same dataset.',
  'каталогом': 'the catalog', 'Рецепт с этим ID в активном каталоге не найден; используется снимок.': 'No recipe with this ID in the active catalog; the snapshot is used.',
  'Импортировано рецептов:': 'Recipes imported:', '; ошибки: ': '; errors: ',
  'Сохранено в projects/': 'Saved to projects/', 'Проекты': 'Projects', 'Файлы в папке': 'Files in the', 'планировщика.': 'folder of the planner.',
  'демо': 'demo', 'узл. ·': 'nodes ·', 'Сохранённых проектов нет.': 'No saved projects.', 'Удалить файл проекта ': 'Delete project file ',
  'Демо: песок → электролиз → кремний': 'Demo: sand → electrolysis → silicon',
  'Рецепты взяты из каталога (ID в свойствах узлов), но скорости источников (40 песка/мин, 10 угольной пыли/мин), число машин и доли 70/30 придуманы для примера.': 'Recipes come from the catalog (IDs in node properties), but the source rates (40 sand/min, 10 carbon dust/min), machine counts and the 70/30 split are made up for the example.',
  'Сундук (песок)': 'Chest (sand)', 'Сундук (уголь)': 'Chest (carbon)', 'Склад SiO₂': 'SiO₂ storage', 'Склад кремния': 'Silicon storage',
  'Загружена демо-схема. Значения источников условные.': 'Demo schematic loaded. Source rates are made up.',
  'Демо недоступно: ': 'Demo unavailable: ',
  'Данные рецептов': 'Recipe data', 'проверено': 'verified', 'не проверено': 'not verified', 'нет данных': 'no data',
  'формат ': 'format ', 'предм.,': 'items,', 'жидк.,': 'fluids,', 'рец.': 'recipes', 'источник:': 'source:',
  'иконок нет (атлас не загружен)': 'no icons (atlas not loaded)', 'Сделать активным': 'Make active', 'активен': 'active', '+ атлас': '+ atlas',
  'Установка Minecraft (только чтение)': 'Minecraft installation (read-only)', 'Версия сборки:': 'Modpack version:', 'не определена': 'not detected',
  ', модов:': ', mods:', 'Экспорт NESQL в установке:': 'NESQL export in the installation:', 'найден (папка nesql/)': 'found (nesql/ folder)',
  'Русские названия': 'Russian names', 'Найдено:': 'Found:', 'ресурсов,': 'resources,', 'машин.': 'machines.',
  'Русских названий нет.': 'No Russian names.', '— файлов:': '— files:', 'Перевод:': 'Translation:', ', скачан': ', downloaded',
  'SHA-256 файлов совпадают': 'file SHA-256 match', 'файлы изменены — перевод не используется': 'files changed — translation not used',
  'Названия материалов GregTech собираются так же, как в игре: шаблон «[Пыль] %s» + перевод материала. Ванильные предметы Minecraft переводятся только клиентом игры, поэтому остаются на английском. Поиск работает на обоих языках.': 'GregTech material names are built the way the game does it: the template «[Dust] %s» + the material translation. Vanilla Minecraft items are translated only by the game client, so they stay in English. Search works in both languages.',
  'Обновить перевод': 'Update translation', 'Скачать перевод': 'Download translation', '(GitHub, ≈9 МБ)': '(GitHub, ≈9 MB)',
  'Импорт своего экспорта (например, 2.8.4)': 'Import your own export (e.g. 2.8.4)', 'Поддерживается': 'Supported:',
  'форматов 5 и 7 из конвейера': 'formats 5 and 7 from the pipeline',
  '(NESQL → dotnet). Импортированный набор помечается «не проверено». Иконки — отдельным файлом atlas.webp.': '(NESQL → dotnet). An imported dataset is marked «not verified». Icons come as a separate atlas.webp file.',
  'Название': 'Name', 'GTNH 2.8.4 (мой экспорт)': 'GTNH 2.8.4 (my export)', 'Версия сборки': 'Modpack version', 'Выбрать data.bin…': 'Choose data.bin…',
  'Источники и лицензии': 'Sources and licenses', 'Рецепты, названия и иконки — экспорт': 'Recipes, names and icons — export',
  '(без лицензии; содержимое принадлежит Mojang, команде GTNH и авторам модов; используется локально в некоммерческих целях). Формат разбора перенесён из': '(no license; the content belongs to Mojang, the GTNH team and mod authors; used locally for non-commercial purposes). The format parser is ported from',
  '(MIT, © 2025 ShadowTheAge). Подробно —': '(MIT, © 2025 ShadowTheAge). Details —',
  'загрузка…': 'loading…', 'Активный набор: ': 'Active dataset: ', 'проверка…': 'checking…', 'Импортирован': 'Imported', ': формат': ': format',
  'рецептов': 'recipes', 'скачивание…': 'downloading…', 'Перевод загружен:': 'Translation loaded:', 'ресурсов': 'resources',
  'Начать новую схему? Несохранённые изменения останутся только в отмене.': 'Start a new schematic? Unsaved changes will only be reachable with Undo.',
  'Это не файл проекта планировщика': 'This is not a planner project file',
  '(нр)': '(nc)', 'Входы': 'Inputs', 'Выходы': 'Outputs', 'Тиков': 'Ticks', 'Снимок совпадает с': 'The snapshot matches',
  'Отличается от рецепта в': 'Differs from the recipe in', 'каталоге': 'the catalog', 'своей базе': 'your recipe base',
  '. Схема продолжает использовать снимок.': '. The schematic keeps using the snapshot.', 'снимок:': 'snapshot:', 'сейчас:': 'now:',
  'Ошибка запуска:': 'Startup error:',
  // ---- canvas.js
  'Рецепт отсутствует': 'Recipe missing', 'не расходуется': 'not consumed', 'есть ': 'have ', 'берёт ': 'draws ', 'нет подачи': 'no supply',
  'Вход энергии: подключите генератор': 'Energy input: connect a generator', 'Вход энергии, EU/t': 'Energy input, EU/t',
  'питание не подключено': 'no power connected', 'не подключён': 'not connected', 'не распр. ': 'unrouted ', 'макс ': 'max ',
  '— с': '— s', '· рецепт': '· recipe', '· разгон ×': '· overclock ×', ' (идеальный)': ' (perfect)', 'цикл/мин (вручную)': 'cycles/min (manual)',
  'нет данных о длительности': 'no duration data', 'загрузка': 'load', ' · ограничено входом': ' · limited by input',
  'Пользовательский рецепт': 'Custom recipe', 'свой': 'custom', 'Узел входит в цикл': 'Node is part of loop', 'Уровень машины': 'Machine tier',
  'нет входов': 'no inputs', 'Значение задано для демонстрации': 'Value made up for the demo', ' · не подключён': ' · not connected',
  'Разветвитель': 'Splitter', 'Слияние': 'Merger', 'любой': 'any', 'тип по первой связи': 'type set by the first link',
  'топливо не выбрано': 'no fuel selected', 'без топлива (внешняя сеть)': 'no fuel (external grid)', 'макс': 'max',
  'Выход энергии, EU/t': 'Energy output, EU/t', 'Выход энергии: протяните к ⚡ входу машины': 'Energy output: drag to a machine ⚡ input',
  'В ×': 'V ×', 'А': 'A', '· КПД': '· efficiency', 'нагрузка': 'load', ' · мало топлива': ' · low on fuel',
  'Вход': 'Input', 'вход блока': 'block input', 'без ограничения (полная мощность)': 'unlimited (full capacity)', 'подаётся снаружи': 'supplied from outside',
  'тип — по первой связи': 'type set by the first link', 'Выход': 'Output', 'выход блока': 'block output', 'Выход энергии блока': 'Block energy output',
  'уходит наружу': 'leaves the block', 'пусто': 'empty', 'Вход энергии блока': 'Block energy input', 'Вход энергии блока, EU/t': 'Block energy input, EU/t',
  'Двойной щелчок — открыть блок': 'Double-click to open the block', 'блок': 'block', 'нет выходов': 'no outputs', 'внутри узлов:': 'nodes inside:',
  'проблем:': 'problems:', 'открыть ⤵': 'open ⤵', 'бл.': 'bl.', 'потери': 'loss', 'Связь внутри цикла': 'Link inside loop',
  // ---- catalog.js / editor.js
  'без данных GT (длительность/EU не экспортированы)': 'no GT data (duration/EU not exported)', 'копия': 'copy',
  'Стабильный ID рецепта': 'Stable recipe ID', 'Добавить на холст': 'Add to canvas', 'На холст': 'To canvas', 'Изменить': 'Edit',
  'Удалить из своей базы': 'Delete from your base', 'Скопировать в свою базу (с сохранением источника)': 'Copy to your base (keeping the source)',
  'В свои': 'To mine', 'Ресурсы': 'Resources', 'Машины': 'Machines', 'Свои рецепты': 'My recipes',
  'Поиск: предмет, жидкость или ID (рус./англ.)…': 'Search: item, fluid or ID (Eng./Rus.)…', 'Поиск машины / карты рецептов…': 'Search machine / recipe map…',
  'Фильтр своих рецептов…': 'Filter my recipes…', 'Связь ждёт рецепт:': 'Link waits for a recipe:', 'потребитель': 'consumer', 'производитель': 'producer',
  'отмена': 'cancel', 'Каталог не загружен': 'Catalog not loaded',
  'Введите название предмета или жидкости по-русски или по-английски, например': 'Type the name of an item or fluid in English or Russian, for example',
  'пыль магния': 'magnesium dust', 'кислород': 'кислород', ', или ID вида': ', or an ID like', '. Слова можно писать в любом порядке и форме.': '. Words can be in any order and form.',
  'жидк.': 'fluid', 'производится / потребляется': 'produced / consumed', 'Ничего не найдено.': 'Nothing found.', 'до': 'up to',
  'фильтр рецептов: magnesium, out:oxygen': 'recipe filter: magnesium, out:oxygen',
  'Несколько условий через запятую — должны выполняться все. Префиксы in: / out: (вх: / вых:) задают сторону для отдельного условия. Ищет по названию и ID.': 'Several conditions separated by commas — all must match. Prefixes in: / out: set the side for one condition. Searches names and IDs.',
  'во входах и выходах': 'in inputs and outputs', 'только во входах': 'inputs only', 'только в выходах': 'outputs only', 'любой уровень': 'any tier',
  'найдено:': 'found:', ' · жидкость': ' · fluid', ' (газ)': ' (gas)', '← к поиску': '← back to search', 'Производится (': 'Produced by (', 'Потребляется (': 'Consumed by (',
  'Все машины (': 'All machines (', 'карта рецептов': 'recipe map', '← к списку': '← back to list', 'Рецептов нет.': 'No recipes.', 'Ещё (': 'More (',
  '+ Новый рецепт': '+ New recipe', 'Импорт файла': 'Import file',
  'Своя база рецептов (например, для правок 2.8.4). Каждый рецепт хранит источник: копия из каталога (набор + ID) или ручной ввод.': 'Your own recipe base (e.g. for 2.8.4 corrections). Each recipe keeps its source: a copy from the catalog (dataset + ID) or manual entry.',
  'Пока пусто. Нажмите «В свои» на любом рецепте каталога или создайте новый.': 'Empty for now. Click «To mine» on any catalog recipe or create a new one.',
  'Удалить рецепт из своей базы? Узлы на холсте сохранят свой снимок.': 'Delete the recipe from your base? Nodes on the canvas keep their snapshot.',
  'Закрыть': 'Close', ' · словарь руд': ' · ore dictionary', 'расх.': 'cons.', 'Свой рецепт': 'Custom recipe', 'Копия рецепта в свою базу': 'Copy of a recipe into your base',
  'Новый рецепт': 'New recipe', 'Источник:': 'Source:', 'из набора': 'from dataset', 'ручной ввод': 'manual entry', '. Исходный рецепт каталога не изменяется.': '. The original catalog recipe is not changed.',
  'Машина / карта рецептов': 'Machine / recipe map', 'Для версии сборки': 'For modpack version', 'Длительность, тиков': 'Duration, ticks', 'Примечание': 'Note',
  '+ добавить вход: поиск предмета/жидкости…': '+ add input: search item/fluid…', '+ добавить выход: поиск…': '+ add output: search…',
  'Пустые поля сохраняются как «нет данных» — планировщик не подставляет значения.': 'Empty fields are saved as «no data» — the planner does not invent values.',
  'Сохранить в свою базу': 'Save to your base', 'Отмена': 'Cancel', 'Рецепт сохранён: ': 'Recipe saved: ', ' (есть предупреждения)': ' (with warnings)', 'нет совпадений': 'no matches',
  // ---- fmt.js / machines.js
  '/с': '/s', '/мин': '/min', '/ч': '/h', ' с': ' s', 'Не расходуется': 'Not consumed', 'НР': 'NC', 'Словарь руд: можно выбрать вариант': 'Ore dictionary: a variant can be chosen',
  'Энергия (EU)': 'Energy (EU)', ' В': ' V',
  'Машина\tУровень\tШт.\tЗагрузка %\tEU/t полная\tEU/t факт.': 'Machine\tTier\tQty\tLoad %\tEU/t full\tEU/t actual',
  'Итого': 'Total', 'Генератор\tУровень\tШт.\tEU/t выдаёт\tEU/t макс.\tТопливо': 'Generator\tTier\tQty\tEU/t gives\tEU/t max\tFuel',
  'Кабель\tУровень\tБлоков\tСвязей\tПотери EU/t': 'Cable\tTier\tBlocks\tLinks\tLoss EU/t',
  'Ресурс\tНужно всего /мин\tМакс. производство /мин\tИз источников /мин\tСейчас производится /мин\tСейчас расход /мин\tНехватка на полной мощности /мин': 'Resource\tTotal need /min\tMax production /min\tFrom sources /min\tProduced now /min\tConsumed now /min\tShortage at full capacity /min',
  // ---- model.js
  'Склад': 'Storage', 'Вход блока': 'Block input', 'Выход блока': 'Block output', 'Узел не найден': 'Node not found',
  'Нельзя соединить узел сам с собой': 'A node cannot be linked to itself', 'Начало должно быть выходом': 'The start must be an output', 'Конец должен быть входом': 'The end must be an input',
  'Энергию (⚡) можно подключить только к ⚡ входу машины': 'Energy (⚡) can only go to a machine ⚡ input', 'К ⚡ входу машины подключается только генератор': 'Only a generator connects to a machine ⚡ input',
  'Этот генератор уже подключён к этому узлу': 'This generator is already linked to this node', 'Такая связь уже есть': 'This link already exists',
  'Сначала подключите вход разветвителя/слияния — тип ресурса не определён': 'Connect the splitter/merger input first — the resource type is not set yet',
  'не входит в словарь руд': 'is not in the ore dictionary', 'К этому входу уже подключён другой вариант словаря руд': 'Another ore dictionary variant is already linked to this input',
  'Несовместимо:': 'Incompatible:', '). Связь только по одинаковому ID.': '). Links require the same ID.',
  // ---- props.js
  'Выделено узлов:': 'Nodes selected:', '▦ Объединить в блок (Ctrl+G)': '▦ Combine into a block (Ctrl+G)',
  '— узел из узлов. Связи, которые пересекают границу выделения, станут входами и выходами блока; неподключённые входы машин — тоже входами, неподключённые выходы — выходами. Блок считается точно: его внутренняя схема решается с тем, что реально приходит на входы. Открыть блок — двойной щелчок, вернуться — «⤴ Выйти из блока» или Esc.': '— a node made of nodes. Links that cross the selection border become block inputs and outputs; unconnected machine inputs become inputs too, unconnected outputs become outputs. A block is calculated exactly: its inner schematic is solved with what really arrives at its inputs. Open a block with a double-click, go back with «⤴ Leave block» or Esc.',
  'Удалить выделенные': 'Delete selected', 'Выделение: Ctrl/Shift + щелчок по узлу, Shift + рамка по пустому месту, Ctrl+A — все.': 'Selection: Ctrl/Shift + click a node, Shift + drag a frame on empty space, Ctrl+A — all.',
  'не подключён — тип по первой связи': 'not connected — type set by the first link', 'нет — добавьте «+': 'none — add «+', 'блока»': '»',
  '▦ Блок': '▦ Block', 'Название блока': 'Block name', 'Вы внутри блока.': 'You are inside a block.', 'Показана': 'Showing', ': входы без ограничения.': ': inputs unlimited.',
  'Показан': 'Showing', 'фактический режим': 'actual operation', ': входы получают то, что приходит на блок снаружи.': ': inputs get what reaches the block from outside.',
  'Входы и выходы блока — узлы «Вход блока» и «Выход блока»; каждый становится портом блока снаружи. Машины без своего генератора питаются от ⚡ входа блока.': 'Block inputs and outputs are the «Block input» and «Block output» nodes; each one becomes a port of the block outside. Machines without their own generator are powered from the block ⚡ input.',
  'Мощность (полная)': 'Power (full)', 'Мощность (факт.)': 'Power (actual)', 'Проблемы внутри (': 'Problems inside (', 'Проблем нет.': 'No problems.',
  'Вход энергии': 'Energy input', 'Выход энергии': 'Energy output', 'есть': 'have', 'Внутри': 'Inside', 'узл. (': 'nodes (', 'машин)': 'machines)',
  'проблем внутри:': 'problems inside:', 'Мощность': 'Power', 'EU/t полная /': 'EU/t full /', 'Порт': 'Port', 'Полная мощн.': 'Full capacity', 'Сейчас': 'Now',
  '«Полная мощность» — сколько блок возьмёт и даст, если входы не ограничены. «Сейчас» — внутренняя схема, решённая с тем, что реально приходит на входы.': '«Full capacity» — what the block takes and gives when inputs are unlimited. «Now» — the inner schematic solved with what really arrives at the inputs.',
  '⤵ Открыть блок': '⤵ Open block', 'Разгруппировать': 'Dissolve block', 'Схема': 'Schematic', 'ДЕМО-СХЕМА.': 'DEMO SCHEMATIC.',
  'Узлов / связей': 'Nodes / links', 'Рецепты схемы': 'Schematic recipes', 'снимков': 'snapshots', 'создана на': 'created on',
  'Уровень машин': 'Machine tier', 'По умолчанию для новых': 'Default for new machines', 'уровень рецепта': 'recipe tier', 'Применить ко всем машинам': 'Apply to all machines',
  'Проблемы (': 'Problems (', 'Дефицитов и неподключённых портов нет.': 'No shortages or unconnected ports.', 'Данные': 'Data', 'Рецепты': 'Recipes', 'формат': 'format',
  'Сборка': 'Modpack', 'не найдена': 'not found', '≠ сборка': '≠ modpack', '. Значения могут отличаться; правки вносите в «Свои рецепты».': '. Values may differ; put corrections into «My recipes».',
  'Подсказки: колесо — масштаб, перетаскивание фона — панорама, перетащите от порта к порту — связь, Delete — удалить, Ctrl+Z / Ctrl+Y — отмена/повтор, F — вписать.': 'Tips: wheel — zoom, drag the background — pan, drag from port to port — link, Delete — delete, Ctrl+Z / Ctrl+Y — undo/redo, F — fit.',
  'Подпись': 'Label', 'тип не задан': 'type not set', 'Приходит в блок': 'Enters the block', 'Уходит из блока': 'Leaves the block',
  'Снаружи у блока появится вход с этим ресурсом. Тип задаётся первой связью от этого узла к машине.': 'The block gets an input with this resource outside. The type is set by the first link from this node to a machine.',
  'Снаружи у блока появится выход. Тип задаётся первой связью к этому узлу; связь от ⚡ генератора делает его выходом энергии.': 'The block gets an output outside. The type is set by the first link into this node; a link from a generator ⚡ makes it an energy output.',
  'Пропускная способность': 'Rate', 'шт': 'pcs', 'Значение источника задано для демонстрации, это не данные каталога.': 'The source rate is made up for the demo; it is not catalog data.',
  'тип определяется первой связью': 'the type is set by the first link', 'Потребность ниже': 'Demand downstream',
  'Распределение по выходам задаётся на каждой исходящей связи: «авто» (по потребности) или фиксированная доля %.': 'Distribution is set on each outgoing link: «auto» (by demand) or a fixed share %.',
  'Слияние суммирует все входящие потоки одного ресурса.': 'A merger adds up all incoming flows of one resource.',
  'Склад принимает любые ресурсы без ограничения (бесконечная потребность), поэтому в «авто»-распределении получает излишек.': 'A storage accepts any resource without limit (infinite demand), so in «auto» distribution it receives the excess.',
  'Дублировать': 'Duplicate', 'Удалить узел': 'Delete node', 'с,': 's,', ' (упор в 1 тик)': ' (capped at 1 tick)',
  'из источника': 'from source', 'расход': 'used', 'хватает': 'enough', 'выход': 'output',
  'Учёт энергии выключен — топливо генераторов в балансе не учитывается.': 'Energy accounting is off — generator fuel is not in the balance.',
  'Баланс линии': 'Line balance', 'Нужно всего': 'Total need', '— сколько ресурса заберут все машины и генераторы линии на полной мощности.': '— how much all machines and generators of the line take at full capacity.',
  'Макс.': 'Max', '— сколько линия может дать: производство всех машин на полной мощности + источники.': '— how much the line can supply: production of all machines at full capacity + sources.',
  '— фактически производится и расходуется.': '— actually produced and consumed.', 'Итог': 'Result', '— хватит ли ресурса на полной мощности.': '— whether there is enough at full capacity.',
  'Ресурс': 'Resource', 'Весь баланс (': 'Whole balance (', 'Энергия': 'Energy', 'учитывать энергию (генераторы, кабели, потери)': 'account for energy (generators, cables, losses)',
  'Нужно машинам (полная)': 'Machines need (full)', 'Потребляют сейчас': 'Consumed now', 'Генераторы, максимум': 'Generators, max',
  'Выключено: машины работают без учёта питания, генераторы и связи ⚡ не влияют на расчёт (но сохраняются в схеме).': 'Off: machines run without power accounting; generators and ⚡ links do not affect the calculation (but stay in the schematic).',
  'Генераторы выдают': 'Generators give', 'Получают машины': 'Machines receive', 'Потери в кабелях': 'Cable losses', 'Без питания': 'Unpowered', 'EU/t не учтены': 'EU/t not covered',
  'Загрузка списка генераторов и кабелей…': 'Loading generators and cables…',
  'Учёт энергии выключен — генератор не влияет на расчёт. Включите «⚡ Энергия» на панели.': 'Energy accounting is off — the generator does not affect the calculation. Turn on «⚡ Energy» in the toolbar.',
  'свой (параметры вручную)': 'custom (manual parameters)', 'Описание предмета (из экспорта)': 'Item tooltip (from the export)', 'Напряжение': 'Voltage', 'В': 'V',
  'Ампер на выходе': 'Output amps', 'Генераторов': 'Generators', 'КПД, %': 'Efficiency, %', 'не указан — 100': 'not set — 100',
  'Мощность = напряжение × ампер × число генераторов. Одноблочные генераторы GT выдают 1 А. КПД берётся из описания предмета («Fuel Efficiency»), если он там есть.': 'Power = voltage × amps × number of generators. Single-block GT generators output 1 A. Efficiency comes from the item tooltip («Fuel Efficiency») when present.',
  'Источник топлива': 'Fuel source', 'без топлива (энергия из внешней сети)': 'no fuel (energy from an external grid)', 'рецепт топлива из каталога': 'fuel recipe from the catalog',
  'пар (по описанию турбины)': 'steam (from the turbine tooltip)', 'вручную': 'manual', 'Карта топлива': 'Fuel map', '— выберите —': '— choose —', 'Ресурс-топливо': 'Fuel resource',
  'поиск предмета или жидкости…': 'search item or fluid…',
  'fuel_value из рецепта = EU за 1 L (правило GT для жидкого топлива); итог умножается на КПД генератора.': 'fuel_value of the recipe = EU per 1 L (the GT rule for liquid fuel); the result is multiplied by the generator efficiency.',
  'В рецепте — капсула (': 'The recipe uses a cell (', 'L); генератор расходует жидкость, fuel_value = EU за 1 L, итог × КПД.': 'L); the generator burns the fluid, fuel_value = EU per 1 L, result × efficiency.',
  'Для твёрдого топлива смысл fuel_value зависит от генератора — укажите EU за 1 шт. вручную (видно в NEI / описании).': 'For solid fuel the meaning of fuel_value depends on the generator — enter EU per 1 item manually (see NEI / tooltip).',
  'Из описания турбины: до': 'From the turbine tooltip: up to', 'L/с пара при': 'L/s of steam at', 'В →': 'V →', 'EU за 1 L (КПД уже учтён).': 'EU per 1 L (efficiency included).',
  'Задано вручную.': 'Set manually.', 'EU за 1': 'EU per 1', 'не задано': 'not set', ' Значение изменено вручную.': ' Value changed manually.',
  'Работа': 'Operation', 'Максимум': 'Maximum', 'Запрошено машинами': 'Requested by machines', '(с учётом потерь)': '(including losses)', 'Выдаёт': 'Gives',
  '· нагрузка': '· load', 'Топливо нужно': 'Fuel needed', '— (нет EU за единицу)': '— (no EU per unit)', 'Подаётся': 'Supplied', 'не подключено': 'not connected', 'Расходуется': 'Burned',
  'Связь питания ⚡': 'Power link ⚡', 'Учёт энергии выключен — связь не участвует в расчёте.': 'Energy accounting is off — the link is not calculated.',
  'Загрузка списка кабелей…': 'Loading cables…', 'без кабеля / вплотную (без потерь)': 'no cable / adjacent (no loss)', '— до': '— up to', 'А, потери': 'A, loss', 'EU/блок': 'EU/block',
  ' ⚠ мало для ': ' ⚠ too low for ', 'Длина: блоков кабеля между генератором и машиной': 'Length: cable blocks between the generator and the machine',
  '0 — генератор стоит вплотную к машине. Каждый ампер теряет «потери на блок» × длину EU; голый провод теряет больше изолированного кабеля, сверхпроводники — 0. Данные кабелей прочитаны из': '0 — the generator is adjacent to the machine. Every amp loses «loss per block» × length EU; bare wire loses more than insulated cable, superconductors lose 0. Cable data was read from',
  'Напряжение генератора': 'Generator voltage', 'Напряжение у машины': 'Voltage at the machine', 'Нужно машине': 'Machine needs', '(полная мощность)': '(full capacity)',
  'Доставляется': 'Delivered', 'Фактически потребляет': 'Actually uses', 'Генератор отправляет': 'Generator sends', 'Потери в кабеле': 'Cable loss',
  'Ток (полная / факт.)': 'Current (full / actual)', '· кабель держит': '· cable carries', 'Не хватает энергии': 'Not enough energy', '— загрузка': '— load', 'Удалить связь': 'Delete link',
  'Циклы (': 'Loops (', 'Расчёт циклов': 'Loop calculation', 'установившийся режим (цикл заполнен)': 'steady state (loop already filled)', 'пуск с нуля (без начального запаса)': 'cold start (no initial stock)',
  'Замкнутых контуров нет.': 'No closed loops.', 'Почему стоит': 'Why it stops', 'возвращается': 'returns',
  'Каждый проход по такому контуру возвращает меньше, чем забирает, поэтому цикл угасает до нуля. Подайте один из этих ресурсов извне (источник + слияние).': 'Every pass through such a path returns less than it takes, so the loop drains to zero. Feed one of these resources from outside (source + merger).',
  'Циркулирует': 'Circulates', 'не хватает': 'short by', 'возврат неполный, покрыт подачей': 'partial return, covered by supply', 'возвращается полностью': 'returns fully',
  'Входит в цикл': 'Enters the loop', 'Выходит из цикла': 'Leaves the loop', 'Запуск': 'Start-up', 'нужен начальный запас': 'needs an initial stock',
  'загрузите вручную любой из циркулирующих ресурсов, минимум ≈ на один цикл машины:': 'load any circulating resource by hand, at least ≈ one machine cycle:', ' или ': ' or ',
  'запускается сам': 'starts by itself', 'угасает до нуля': 'drains to zero', 'не работает': 'not running',
  '«Установившийся режим» считает цикл уже заполненным: так он работает в игре после первой загрузки. «Пуск с нуля» показывает, что будет без начального запаса.': '«Steady state» treats the loop as already filled: that is how it runs in the game after the first load. «Cold start» shows what happens without an initial stock.',
  'Снимок рецепта отсутствует.': 'The recipe snapshot is missing.', 'Это рецепт топлива': 'This is a fuel recipe',
  '»), а не машина: у него нет длительности и EU/t, поэтому как машина он ничего не делает. Топливо сжигает генератор.': '»), not a machine: it has no duration and EU/t, so as a machine it does nothing. Fuel is burned by a generator.',
  'Превратить в генератор с этим топливом': 'Turn into a generator with this fuel', 'свой рецепт': 'custom recipe', 'Стабильный ID': 'Stable ID', 'из': 'of', ' · для ': ' · for ',
  'Машин': 'Machines', 'идеальный разгон (÷4 длительность за уровень)': 'perfect overclock (duration ÷4 per tier)', 'Разгон GT: каждый уровень выше уровня рецепта (': 'GT overclock: every tier above the recipe tier (',
  ') — длительность ÷2, EU/t ×4, не короче 1 тика. Идеальный разгон есть только у некоторых мультиблоков. Для бонусов катушек, параллелей и т.п. задайте циклы/мин вручную.': ') — duration ÷2, EU/t ×4, not below 1 tick. Only some multiblocks have perfect overclock. For coil bonuses, parallels etc. set cycles/min manually.',
  'Циклов/мин на машину (вручную)': 'Cycles/min per machine (manual)', ' (из рецепта)': ' (from the recipe)', 'нет длительности в рецепте': 'no duration in the recipe', 'Длительность': 'Duration',
  'рецепт': 'recipe', '· машина': '· machine', '(разгонов:': '(overclocks:', 'Цикл': 'Loop', '↻ цикл': '↻ loop', 'Циклов': 'Cycles', '(все машины)': '(all machines)',
  ' — ограничивает «': ' — limited by «', 'энергия (EU)': 'energy (EU)', 'EU/t полная ·': 'EU/t full ·', 'EU/t факт.': 'EU/t actual', 'доставляется': 'delivered',
  'Словарь руд': 'Ore dictionary', '— вариант': '— variant', 'за цикл': 'per cycle', 'нужно': 'need', 'подано': 'supplied', 'не расх.': 'not cons.', 'не подкл.': 'not conn.', 'не распр.': 'unrouted',
  'Для выходов с шансом показано ожидаемое среднее.': 'Chanced outputs show the expected average.', 'Машины для этой карты (': 'Machines for this map (',
  'Сравнить с каталогом': 'Compare with catalog', 'Копировать в свои': 'Copy to mine', 'Исходящие связи': 'Outgoing links', 'куда': 'to', 'правило': 'rule', 'поток': 'flow', 'авто': 'auto',
  'Связь': 'Link', 'Потребность (полная мощность)': 'Demand (full capacity)', '∞ (склад)': '∞ (storage)', 'Поступает': 'Arrives', 'Фактический поток': 'Actual flow',
  'Дефицит': 'Shortage', '(до полной мощности)': '(to full capacity)', 'Избыток': 'Surplus', '(не потребляется)': '(not consumed)',
  'Потребитель ограничен другим входом, поэтому часть поступающего не используется, хотя для полной мощности ресурса всё ещё мало.': 'The consumer is limited by another input, so part of what arrives is not used, although it is still not enough for full capacity.',
  'До полной мощности этого ресурса не хватает, но узкое место — другой вход потребителя. Добавлять подачу сюда бессмысленно, пока не решён тот дефицит.': 'There is not enough of this resource for full capacity, but the bottleneck is another input of the consumer. Adding supply here is pointless until that shortage is solved.',
  ': ресурс возвращается полностью, поток повторяет пропускную способность цикла. Ограничение задаёт вход извне цикла.': ': the resource returns fully; the flow follows the loop throughput. The limit comes from an input outside the loop.',
  'Распределение с выхода': 'Distribution from the output', 'Правило для этой связи': 'Rule for this link', 'Авто — по потребности': 'Auto — by demand', 'Фиксированная доля, %': 'Fixed share, %',
  'Доля, %': 'Share, %', 'связь с того же выхода': 'link from the same output', 'Сначала выдаются фиксированные доли (сумма': 'Fixed shares are served first (sum',
  ' — больше 100%, доли нормируются': ' — over 100%, shares are normalised',
  '), остаток делится между «авто»-связями пропорционально потребности; излишек уходит на склад, если он подключён в режиме «авто». Если «авто»-связей нет, остаток выхода остаётся нераспределённым.': '), the rest is split between «auto» links in proportion to demand; the excess goes to a storage if one is linked as «auto». Without «auto» links the rest of the output stays unrouted.',
  'Чтобы разделить выход (например 70% дальше, остальное на склад), протяните с того же выхода ещё одну связь и задайте долю.': 'To split an output (e.g. 70% onward, the rest to storage), drag another link from the same output and set a share.',
  'Затронуто дефицитом (узкое место)': 'Affected by the shortage (bottleneck)', '— получает меньше': '— gets less', 'Потребитель не замедлен (дефицит перекрыт другими источниками).': 'The consumer is not slowed down (the shortage is covered by other sources).',
  'Для полной мощности нужно ещё': 'For full capacity it needs another',
  'К этому входу уже подключены связи с другим вариантом. Удалить их и сменить вариант?': 'Links with another variant are already connected to this input. Delete them and change the variant?',
  // ---- solver.js (problem texts)
  ': в кабеле теряется всё напряжение (': ': the cable loses all the voltage (', 'EU на': 'EU over', 'блоков при': 'blocks at', 'В)': 'V)',
  ': напряжение': ': voltage', 'В выше допустимого для кабеля (': 'V is above the cable limit (', 'В) — кабель сгорит': 'V) — the cable burns',
  ': на полной мощности нужно': ': at full capacity it needs', 'А, кабель держит': 'A, the cable carries', 'А — кабель перегорит': 'A — the cable burns out',
  'В выше уровня машины (': 'V is above the machine tier (', 'В) — машина взорвётся': 'V) — the machine explodes',
  ': питание не подключено —': ': no power connected —', ': выход ⚡ ни к чему не подключён — протяните связь к ⚡ входу машины': ': ⚡ output is not connected — drag a link to a machine ⚡ input',
  ': вход «': ': input «', '» не подключён': '» is not connected', ': выход «': ': output «', '» распределено не полностью (доли': '» is not fully distributed (shares',
  ': в рецепте нет длительности — задайте циклы/мин вручную': ': the recipe has no duration — set cycles/min manually',
  ': вход блока «': ': block input «', '» уходит прямо на выход — потребность не ограничена': '» goes straight to an output — demand is unlimited',
  'учёт энергии выключен (переключатель «⚡ Энергия»)': 'energy accounting is off (the «⚡ Energy» switch)', 'мощность 0: проверьте напряжение, ампер и число генераторов': 'power 0: check voltage, amps and generator count',
  'выход ⚡ не подключён к машинам': '⚡ output is not connected to machines', 'машинам ничего не доставляется: всё напряжение теряется в кабеле': 'nothing reaches the machines: all voltage is lost in the cable',
  'нет подачи топлива «': 'no fuel supply «', 'топливо «': 'fuel «', '» не поступает': '» is not arriving', 'подключённые машины стоят (их ограничивает другой вход)': 'the connected machines are idle (limited by another input)',
  'не выдаёт энергию:': 'gives no energy:', ': нужно': ': needs', 'EU/t, генератор даёт максимум': 'EU/t, the generator gives at most',
  ': не указано, сколько EU даёт единица топлива — расход топлива не считается': ': EU per unit of fuel is not set — fuel use is not calculated',
  'Расчёт не сошёлся за': 'The calculation did not converge in', 'итераций — вероятно, цикл с потерями без подпитки. Добавьте подачу недостающего ресурса.': 'iterations — probably a lossy loop without make-up. Add a supply of the missing resource.',
  'останавливается: по контуру': 'stops: along the path', 'возвращается только': 'only', '% — подайте извне': '% comes back — feed from outside',
  ': нужен начальный запас (': ': needs an initial stock (', ') — без него цикл не запустится': ') — without it the loop will not start',
  'стоит: в нём ничего не циркулирует (режим «пуск с нуля» или нет подачи)': 'is idle: nothing circulates (cold start mode or no supply)',
  '» расходуется быстрее, чем возвращается — нужна подпитка': '» is used faster than it returns — needs make-up', 'Дефицит «': 'Shortage of «', 'Блок «': 'Block «',
  // misc
  'Тесты планировщика': 'Planner tests',
  // ---- setup window
  '⚙ Настройка': '⚙ Setup', 'Данные рецептов, язык, папка Минecraft': 'Recipe data, language, Minecraft folder',
  'Данные рецептов, язык, папка Minecraft': 'Recipe data, language, Minecraft folder',
  'Настройка планировщика': 'Planner setup',
  'Нужны для работы. Снимок рецептов GTNH 2.8.0 (≈30 МБ) скачивается с GitHub и проверяется по SHA-256.': 'Required. The GTNH 2.8.0 recipe snapshot (≈30 MB) is downloaded from GitHub and checked by SHA-256.',
  'Скачать данные рецептов': 'Download recipe data', 'Язык': 'Language',
  'Русские названия не скачаны — названия будут на английском.': 'Russian names are not downloaded — names will be in English.',
  'Папка Minecraft (необязательно)': 'Minecraft folder (optional)',
  'Планировщик только читает её, ничего не меняя: версию сборки, таблицу кабелей GregTech и переводы модов. Без неё всё работает.': 'The planner only reads it and never changes anything: modpack version, the GregTech cable table and mod translations. Everything works without it.',
  'сборка': 'pack', 'Найти автоматически': 'Find automatically', 'Забыть': 'Forget',
  'Или укажите путь вручную (папка, где лежат mods и config)': 'Or enter the path (the folder that contains mods and config)',
  'Проверить': 'Check', 'Готово': 'Done', 'Использовать': 'Use',
  'Установки GTNH не найдены в обычных папках лаунчеров (Prism, MultiMC, CurseForge, ATLauncher…). Укажите путь вручную.': 'No GTNH installation found in the usual launcher folders (Prism, MultiMC, CurseForge, ATLauncher…). Enter the path manually.',
  'Папка Minecraft сохранена (только чтение)': 'Minecraft folder saved (read-only)', 'Данные рецептов загружены и проверены': 'Recipe data downloaded and verified',
  // ---- server messages
  'Атлас должен быть файлом WebP (atlas.webp).': 'The atlas must be a WebP file (atlas.webp).',
  'Атлас можно добавить только к импортированному набору.': 'An atlas can only be added to an imported dataset.',
  'Атлас не найден': 'Atlas not found', 'Запрещено': 'Forbidden', 'Запрос с чужого источника отклонён': 'Cross-origin request refused',
  'Метод не поддерживается': 'Method not supported', 'Не найдено': 'Not found', 'Не указана машина / карта рецептов': 'Machine / recipe map is not set',
  'Выход не может быть словарём руд': 'An output cannot be an ore dictionary entry', 'Длительность должна быть > 0 тиков': 'Duration must be > 0 ticks',
  'Неверный формат проекта': 'Invalid project format', 'Ожидается файл формата gtnh-planner-recipes': 'A gtnh-planner-recipes file is expected',
  'Проект не найден': 'Project not found', 'Ресурс не найден в активном наборе': 'Resource not found in the active dataset',
  'Рецепт должен быть объектом': 'A recipe must be an object', 'Рецепт не найден': 'Recipe not found', 'У ресурса нет ID': 'The resource has no ID',
  'Файл слишком большой': 'File too large', 'Каталог не загружен': 'Catalog not loaded',
  'Активный набор данных не выбран или недоступен.': 'No active dataset selected, or it is unavailable.',
  'В папке нет mods/ и config/.': 'The folder has no mods/ and config/.',
  'Папка установки Minecraft не найдена (запустите с --mc-dir).': 'Minecraft installation folder not found (it is optional).',
  'Импортирован пользователем; происхождение не проверено планировщиком.': 'Imported by the user; origin not verified by the planner.',
};
