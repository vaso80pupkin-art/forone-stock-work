/**
 * FORONE.KZ — автоматическое объединение складских листов.
 *
 * Запуск:
 * 1. Откройте https://script.google.com/home/projects/create
 * 2. Вставьте этот код в новый отдельный проект.
 * 3. Сохраните проект и запустите setupForoneAutomation.
 * 4. Подтвердите доступ к Google Sheets и Google Drive.
 */

const FORONE_SPREADSHEET_ID = '1fanDUGGwc8rioi5cnkE1Xydpv3r1pq9L755YztUmLCQ';

const FORONE_CONFIG = {
  // Добавляйте сюда только листы с актуальными остатками.
  // Не добавляйте листы заказов, статистики, цен и историю.
  sourceSheets: ['Октябрь-Ноябрь'],
  targetSheet: 'FORONE_Остатки',
  triggerFunction: 'syncForoneStock',
  triggerMinutes: 15
};

const FORONE_HEADERS = [
  'Артикул',
  'Название',
  'Категория',
  'Длина',
  'Остаток на складе',
  'Резерв',
  'Склад',
  'Зона',
  'Стеллаж',
  'Ячейка',
  'Доступно к продаже'
];

function onOpen() {
  // Автономный проект не привязан к таблице, поэтому SpreadsheetApp.getUi()
  // здесь недоступен. Меню не требуется: запуск выполняется через триггер.
  Logger.log('Автономный проект FORONE активен. Используйте setupForoneAutomation.');
}

function setupForoneAutomation() {
  const functionName = FORONE_CONFIG.triggerFunction;
  ScriptApp.getProjectTriggers().forEach((trigger) => {
    if (trigger.getHandlerFunction() === functionName) {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  ScriptApp.newTrigger(functionName)
    .timeBased()
    .everyMinutes(FORONE_CONFIG.triggerMinutes)
    .create();

  syncForoneStock();
  Logger.log('Готово. Лист FORONE_Остатки будет обновляться каждые ' + FORONE_CONFIG.triggerMinutes + ' минут.');
}

function syncForoneStock() {
  const spreadsheet = SpreadsheetApp.openById(FORONE_SPREADSHEET_ID);
  const target = getOrCreateSheet_(spreadsheet, FORONE_CONFIG.targetSheet);
  const preserved = readExistingTarget_(target);
  const merged = new Map();

  FORONE_CONFIG.sourceSheets.forEach((sheetName) => {
    const source = spreadsheet.getSheetByName(sheetName);
    if (!source) throw new Error('Не найден исходный лист: ' + sheetName);

    const values = source.getDataRange().getValues();
    const headerRow = findHeaderRow_(values);
    if (headerRow < 0) {
      throw new Error(
        'На листе «' + sheetName + '» не найдены колонки «Артикул» и «Остаток на складе».'
      );
    }

    const columns = mapColumns_(values[headerRow]);
    for (let r = headerRow + 1; r < values.length; r += 1) {
      const row = values[r];
      const item = readSourceItem_(row, columns);
      if (!item || isSummaryItem_(item)) continue;

      // Если одна и та же позиция повторяется в листе, последняя строка считается актуальной.
      merged.set(makeKey_(item.sku, item.category, item.name), item);
    }
  });

  const output = Array.from(merged.values())
    .sort((a, b) => {
      const category = a.category.localeCompare(b.category, 'ru');
      if (category !== 0) return category;
      return a.sku.localeCompare(b.sku, 'ru');
    })
    .map((item) => {
      const old = preserved.get(makeKey_(item.sku, item.category, item.name)) || {};
      const reserve = Math.min(
        Math.max(0, toNumber_(old.reserve)),
        Math.max(0, item.stock)
      );
      return [
        item.sku,
        item.name,
        item.category,
        item.length,
        item.stock,
        reserve,
        old.warehouse || 'Алматы',
        old.zone || '',
        old.rack || '',
        old.bin || '',
        null
      ];
    });

  target.clearContents();
  target.getRange(1, 1, 1, FORONE_HEADERS.length).setValues([FORONE_HEADERS]);
  if (output.length) {
    target.getRange(2, 1, output.length, FORONE_HEADERS.length).setValues(output);
    const formulas = output.map((_, index) => [`=E${index + 2}-F${index + 2}`]);
    target.getRange(2, 11, output.length, 1).setFormulas(formulas);
  }

  formatTarget_(target, output.length + 1);
  PropertiesService.getScriptProperties().setProperties({
    FORONE_LAST_SYNC: new Date().toISOString(),
    FORONE_LAST_COUNT: String(output.length)
  });
}

function getForoneSpreadsheet_() {
  return SpreadsheetApp.openById(FORONE_SPREADSHEET_ID);
}

function getOrCreateSheet_(spreadsheet, name) {
  return spreadsheet.getSheetByName(name) || spreadsheet.insertSheet(name);
}

function readExistingTarget_(sheet) {
  const result = new Map();
  if (sheet.getLastRow() < 2) return result;

  const values = sheet.getRange(1, 1, sheet.getLastRow(), FORONE_HEADERS.length).getValues();
  const header = values[0].map(normalize_);
  const columns = mapColumns_(header);

  for (let r = 1; r < values.length; r += 1) {
    const row = values[r];
    const sku = text_(row[columns.sku]);
    const name = text_(row[columns.name]);
    const category = text_(row[columns.category]);
    if (!sku || !name) continue;
    result.set(makeKey_(sku, category, name), {
      reserve: row[columns.reserve],
      warehouse: text_(row[columns.warehouse]),
      zone: text_(row[columns.zone]),
      rack: text_(row[columns.rack]),
      bin: text_(row[columns.bin])
    });
  }
  return result;
}

function findHeaderRow_(values) {
  for (let r = 0; r < Math.min(values.length, 40); r += 1) {
    const row = values[r].map(normalize_);
    const hasSku = row.some((value) => ['артикул', 'sku', 'код', 'article', 'номенклатура', 'colorno'].includes(value));
    const hasStock = row.some((value) => ['остаток', 'остатокнаскладе', 'остатокпослепоступлениятовара', 'количество', 'колво', 'qty', 'stock', 'алматыналичии'].includes(value));
    if (hasSku && hasStock) return r;
  }
  return -1;
}

function mapColumns_(header) {
  const names = header.map(normalize_);
  return {
    sku: findColumn_(names, ['артикул', 'sku', 'код', 'article', 'номенклатура', 'colorno']),
    name: findColumn_(names, ['название', 'наименование', 'товар', 'name', 'productname', 'описание']),
    category: findColumn_(names, ['категория', 'тип', 'category']),
    length: findColumn_(names, ['длина', 'размер', 'length']),
    stock: findColumn_(names, ['остаток', 'остатокнаскладе', 'остатокпослепоступлениятовара', 'количество', 'колво', 'stock', 'qty', 'алматыналичии']),
    reserve: findColumn_(names, ['резерв', 'зарезервировано', 'reserved']),
    warehouse: findColumn_(names, ['склад', 'warehouse']),
    zone: findColumn_(names, ['зона', 'zone']),
    rack: findColumn_(names, ['стеллаж', 'rack']),
    bin: findColumn_(names, ['ячейка', 'bin', 'cell'])
  };
}

function findColumn_(headers, aliases) {
  for (let i = 0; i < headers.length; i += 1) {
    if (aliases.includes(headers[i])) return i;
  }
  return -1;
}

function readSourceItem_(row, columns) {
  const sku = text_(valueAt_(row, columns.sku));
  const name = text_(valueAt_(row, columns.name)) || sku;
  if (!sku) return null;

  const categoryValue = text_(valueAt_(row, columns.category));
  const category = categoryValue || inferCategory_(name);
  const rawLength = valueAt_(row, columns.length);
  const length = rawLength ? parseLength_(rawLength) : parseLength_(name);

  return {
    sku,
    name,
    category,
    length,
    stock: Math.max(0, Math.round(toNumber_(valueAt_(row, columns.stock))))
  };
}

function isSummaryItem_(item) {
  return /^(итого|всего|total)(\b|\s)/i.test(item.sku) || !item.name || item.name === item.sku;
}

function inferCategory_(name) {
  const value = name.toLowerCase();
  if (value.includes('лувер') || value.includes('louver')) return 'Лувер';
  if (value.includes('проф')) return 'Профиль';
  return 'Панель';
}

function parseLength_(value) {
  const text = String(value || '').toLowerCase().replace(/\s+/g, ' ');
  return /4000|(?:^|[^0-9])4\s*м(?:\b|$)|4\s*метр/.test(text) ? 4000 : 3000;
}

function makeKey_(sku, category, name) {
  return [sku, category, name].map(normalize_).join('|');
}

function normalize_(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .replace(/[\s_\-./№:()]/g, '');
}

function text_(value) {
  return String(value == null ? '' : value).trim();
}

function valueAt_(row, index) {
  return index >= 0 ? row[index] : '';
}

function toNumber_(value) {
  if (typeof value === 'number' && isFinite(value)) return value;
  const cleaned = text_(value).replace(/\s/g, '').replace(',', '.').replace(/[^\d.-]/g, '');
  const parsed = Number(cleaned);
  return isFinite(parsed) ? parsed : 0;
}

function formatTarget_(sheet, rowCount) {
  const oldFilter = sheet.getFilter();
  if (oldFilter) oldFilter.remove();
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, FORONE_HEADERS.length)
    .setFontWeight('bold')
    .setFontColor('#ffffff')
    .setBackground('#173b43');
  sheet.getRange(1, 1, rowCount, FORONE_HEADERS.length).createFilter();
  sheet.autoResizeColumns(1, FORONE_HEADERS.length);
  sheet.setColumnWidth(2, 260);
  sheet.setColumnWidth(7, 120);
  sheet.setColumnWidth(8, 100);
  sheet.setColumnWidth(9, 120);
  sheet.setColumnWidth(10, 120);
}
