/**
 * FORONE.KZ — STOCK SYNC v2 (двусторонний канал: приложение → Google Таблица)
 * =============================================================================
 *
 * Схема:
 *   FORONE Stock (телефон)
 *        │ POST JSON
 *        ▼
 *   Apps Script Web App (doPost) ──► лист FORONE_Операции (журнал, идемпотентно)
 *        │                                     │
 *        │                                     ▼
 *        └────────────────────────────► лист FORONE_Остатки (рабочий остаток)
 *                                              ▲
 *   Исходные листы (номенклатура) ─────────────┘ слияние дельтами, без затирки
 *
 * Что делает этот файл:
 *   1. doGet(e)   — проверка связи (?action=ping) и выдача рабочих остатков (?action=stock)
 *   2. doPost(e)  — приём операций (одна или пакет), проверка, журнал, обновление остатка
 *   3. syncForoneStock() — безопасное слияние исходных листов с FORONE_Остатки (без затирки ручных движений)
 *   4. FORONE_setup()    — подготовка листов, заголовков и триггера (запустить один раз)
 *   5. FORONE_selfTest() — автотесты чистой логики прямо в редакторе скриптов
 *
 * УСТАНОВКА (кратко, подробно в README_СИНХРОНИЗАЦИЯ.md):
 *   1. Откройте таблицу → Расширения → Google Apps Script (или script.google.com → новый проект
 *      и скопируйте ID таблицы в FORONE_SPREADSHEET_ID).
 *   2. Вставьте весь этот файл, сохраните.
 *   3. Запустите функцию FORONE_setup один раз и подтвердите права Редактора.
 *   4. Deploy → New deployment → Web app:
 *        Execute as: Me (владелец скрипта)
 *        Who has access: Anyone with the link
 *   5. Скопируйте URL вида https://script.google.com/macros/s/.../exec в приложение.
 *   6. В свойствах скрипта (Project settings → Script properties) задайте
 *      FORONE_SHARED_SECRET — этот же ключ введите в настройках приложения.
 *
 * ВАЖНО: этот файл НЕ изменяет исходные листы. Он читает их и пишет только в
 * FORONE_Остатки, FORONE_Операции и FORONE_Ошибки.
 */

// ---------------------------------------------------------------------------
// НАСТРОЙКИ
// ---------------------------------------------------------------------------

var FORONE_SPREADSHEET_ID = '1fanDUGGwc8rioi5cnkE1Xydpv3r1pq9L755YztUmLCQ';

var FORONE_CONFIG = {
  version: '2.0.0',
  // Листы-справочники (только чтение). Добавляйте новые месяцы сюда.
  sourceSheets: ['Октябрь-Ноябрь'],
  // Операционный лист склада (читаемо-записываемый для скрипта).
  targetSheet: 'FORONE_Остатки',
  // Журнал движений товара.
  operationsSheet: 'FORONE_Операции',
  // Журнал системных ошибок и конфликтов.
  errorsSheet: 'FORONE_Ошибки',
  triggerFunction: 'syncForoneStock',
  triggerMinutes: 15,
  timeZone: 'Asia/Almaty',
  // Максимальный пакет операций за один запрос.
  maxBatch: 100,
  // Ограничение на количество в одной операции.
  maxQty: 100000
};

// Целевой лист «FORONE_Остатки»: A–K совместимы со старой версией, L–O новые.
var STOCK_HEADERS = [
  'Артикул',                 // A
  'Название',                // B
  'Категория',               // C
  'Длина',                   // D
  'Остаток на складе',       // E — РАБОЧИЙ остаток, меняется операциями
  'Резерв',                  // F
  'Склад',                   // G
  'Зона',                    // H
  'Стеллаж',                 // I
  'Ячейка',                  // J
  'Доступно к продаже',      // K — формула =E-F
  'Остаток по источнику',    // L — снимок исходного листа (база для слияния)
  'Последняя операция',      // M — ID последней применённой операции
  'Обновлено',               // N — время последнего изменения
  'Расхождение'              // O — пометка о конфликте
];

var OP_HEADERS = [
  'ID операции', 'Дата и время', 'Артикул', 'Название', 'Тип операции',
  'Количество', 'Изменение остатка', 'Пользователь', 'Устройство', 'Комментарий',
  'Статус', 'Ошибка', 'Остаток после', 'Источник'
];

var ERR_HEADERS = [
  'Время', 'Тип', 'ID операции', 'Артикул', 'Пользователь', 'Устройство',
  'Код', 'Сообщение', 'Детали'
];

var COL = {
  sku: 1, name: 2, category: 3, length: 4, stock: 5, reserve: 6, warehouse: 7,
  zone: 8, rack: 9, bin: 10, available: 11, sourceStock: 12, lastOp: 13,
  updated: 14, conflict: 15
};

var OP_TYPE_LABELS = { in: 'Приход', out: 'Расход', writeoff: 'Списание на замер' };
var OP_STATUS = { ACCEPTED: 'Принято', PROCESSED: 'Обработано', REJECTED: 'Отклонено', ERROR: 'Ошибка' };

// ---------------------------------------------------------------------------
// ПУБЛИЧНЫЕ ТОЧКИ ВХОДА (Web App)
// ---------------------------------------------------------------------------

/**
 * Проверка связи и выдача данных.
 *   ?action=ping                       — жив ли скрипт, какие листы найдены
 *   ?action=stock&key=SECRET           — рабочие остатки для приложения
 *   ?action=operations&sku=Н234-YP     — последние операции по артикулу
 */
function doGet(e) {
  var params = (e && e.parameter) || {};
  var action = String(params.action || 'ping').toLowerCase();
  try {
    var auth = checkAccess_(params, null);

    // Без ключа разрешён только минимальный ping: факт, что скрипт жив.
    // Состав книги, количество строк и остатки доступны только с ключом.
    if (!auth.ok && action === 'ping') {
      return json_({
        ok: true,
        app: 'FORONE-SYNC',
        version: FORONE_CONFIG.version,
        serverTime: nowIso_(),
        restricted: true,
        auth: { required: auth.code === 'AUTH', message: auth.message }
      });
    }
    if (!auth.ok) return json_({ ok: false, code: auth.code, message: auth.message });

    if (action === 'stock') return json_(buildStockPayload_());
    if (action === 'operations') return json_(buildOperationsPayload_(params));

    return json_({
      ok: true,
      app: 'FORONE-SYNC',
      version: FORONE_CONFIG.version,
      serverTime: nowIso_(),
      timeZone: FORONE_CONFIG.timeZone,
      spreadsheet: {
        id: getSpreadsheetId_(),
        name: safeName_(),
        url: safeUrl_()
      },
      sheets: describeSheets_(),
      lastSync: readProperty_('FORONE_LAST_SYNC', ''),
      lastSyncCount: readProperty_('FORONE_LAST_COUNT', ''),
      operationsTotal: countRows_(getOrCreateSheet_(getForoneSpreadsheet_(), FORONE_CONFIG.operationsSheet)) - 1,
      openConflicts: countConflicts_(getOrCreateSheet_(getForoneSpreadsheet_(), FORONE_CONFIG.targetSheet)),
      auth: { secretRequired: !!readProperty_('FORONE_SHARED_SECRET', ''), allowedUsers: (readProperty_('FORONE_ALLOWED_USERS', '') || '').split(',').filter(Boolean) }
    });
  } catch (error) {
    logError_('ping', null, null, null, null, 'DOGET_FAILED', error);
    return json_({ ok: false, code: 'DOGET_FAILED', message: String(error && error.message || error) });
  }
}

/**
 * Приём операций. Ожидается JSON-тело:
 * {
 *   "action": "operations",
 *   "key": "SECRET",
 *   "user": "Сотрудник 1",
 *   "device": "Телефон A",
 *   "operations": [ { operationId, sku, type, qty, name, comment, createdAt } ]
 * }
 *
 * Одна операция тоже принимается: {"action":"operation","operation":{...}}.
 * Ответ всегда JSON: { ok, results: [ { operationId, ok, status, stockAfter, message } ] }.
 */
function doPost(e) {
  var lock = LockService.getScriptLock();
  var locked = false;
  var payload = null;
  try {
    payload = parseRequest_(e);
  } catch (error) {
    return json_({ ok: false, code: 'BAD_JSON', message: 'Тело запроса не является корректным JSON' });
  }

  var params = (e && e.parameter) || {};
  var auth = checkAccess_(params, payload);
  if (!auth.ok) return json_({ ok: false, code: auth.code, message: auth.message });

  try {
    locked = lock.tryLock(30000);
  } catch (error) {
    locked = false;
  }
  if (!locked) {
    return json_({ ok: false, code: 'BUSY', message: 'Сервер занят другой записью, повторите отправку через несколько секунд', retry: true });
  }

  try {
    var action = String(payload.action || 'operations').toLowerCase();
    var ops = collectOperations_(payload);
    if (!ops.length) {
      return json_({ ok: false, code: 'EMPTY_BATCH', message: 'В запросе нет операций' });
    }
    if (ops.length > FORONE_CONFIG.maxBatch) {
      return json_({ ok: false, code: 'BATCH_TOO_LARGE', message: 'Слишком большой пакет: максимум ' + FORONE_CONFIG.maxBatch + ' операций' });
    }

    var ss = getForoneSpreadsheet_();
    var stock = getOrCreateSheet_(ss, FORONE_CONFIG.targetSheet);
    var journal = getOrCreateSheet_(ss, FORONE_CONFIG.operationsSheet);
    var index = buildStockIndex_(stock);
    var seen = buildOperationLedger_(journal);
    var results = [];
    var i;

    // Предуведомление о отсутствующих позициях один раз, а не на каждую строку.
    for (i = 0; i < ops.length; i += 1) {
      results.push(processOperation_(ops[i], {
        ss: ss,
        stockSheet: stock,
        journal: journal,
        index: index,
        seen: seen,
        user: text_(payload.user),
        device: text_(payload.device),
        source: text_(payload.app) || 'FORONE Stock'
      }));
    }

    return json_({
      ok: results.every(function (r) { return r.ok; }),
      serverTime: nowIso_(),
      received: ops.length,
      applied: results.filter(function (r) { return r.status === 'processed'; }).length,
      duplicates: results.filter(function (r) { return r.status === 'duplicate'; }).length,
      rejected: results.filter(function (r) { return !r.ok; }).length,
      results: results
    });
  } catch (error) {
    logError_('doPost', payload && payload.operationId, payload && payload.sku, null, null, 'POST_FAILED', error);
    return json_({ ok: false, code: 'POST_FAILED', message: String(error && error.message || error), retry: true });
  } finally {
    try { lock.releaseLock(); } catch (ignored) {}
  }
}

// ---------------------------------------------------------------------------
// ОБРАБОТКА ОДНОЙ ОПЕРАЦИИ
// ---------------------------------------------------------------------------

function processOperation_(raw, ctx) {
  var op = normalizeOperation_(raw, ctx);
  // Отклонённую операцию склад готов принять позже — но только в том же виде.
  // Если под тем же ID пришли другие данные, это повтор уже записанной строки.
  var rejectedBefore = ctx.seen.wasRejected(op.operationId);
  var samePayload = rejectedBefore && ctx.seen.rejectedSignature(op.operationId) === operationSignature_(op);
  if (rejectedBefore && !samePayload) ctx.seen.add(op.operationId);
  var check = validateOperation_(op, ctx.seen);

  // Защита от двойного списания: ID уже есть в журнале — повтор не применяется.
  if (check.status === 'duplicate') return check.result;

  if (!check.ok) {
    if (check.record) appendOperationRow_(ctx.journal, check.record);
    logOperationRejection_(ctx.ss, check, op);
    return check.result;
  }

  var candidates = ctx.index.bySku[op.skuKey] || [];
  var row = pickStockRow_(candidates, op);
  if (!row) {
    ctx.seen.reject(op.operationId, operationSignature_(op));
    var missing = makeRejection_(op, OP_STATUS.REJECTED, 'SKU_NOT_FOUND',
      'Артикул «' + op.sku + '» не найден в листе ' + FORONE_CONFIG.targetSheet);
    appendOperationRow_(ctx.journal, missing.record);
    logError_('operation', op.operationId, op.sku, op.user, op.device, 'SKU_NOT_FOUND', 'Позиция отсутствует в операционном листе');
    return missing.result;
  }

  var before = toNumber_(row.values[COL.stock - 1]);
  var reserve = Math.max(0, toNumber_(row.values[COL.reserve - 1]));
  var available = Math.max(0, before - reserve);
  var delta = op.type === 'in' ? op.qty : -op.qty;

  if (op.type !== 'in' && op.qty > available) {
    ctx.seen.reject(op.operationId, operationSignature_(op));
    var short = makeRejection_(op, OP_STATUS.REJECTED, 'INSUFFICIENT_STOCK',
      'Недостаточно доступного остатка: доступно ' + available + ' шт. (остаток ' + before + ', резерв ' + reserve + ')');
    appendOperationRow_(ctx.journal, short.record);
    return short.result;
  }

  var after = Math.max(0, before + delta);

  // Фаза 1: фиксируем операцию в журнале со статусом «Принято».
  var journalRow = appendOperationRow_(ctx.journal, {
    operationId: op.operationId,
    timestamp: formatNow_(),
    sku: op.sku,
    name: op.name || row.values[COL.name - 1],
    type: OP_TYPE_LABELS[op.type],
    qty: op.qty,
    delta: delta,
    user: op.user,
    device: op.device,
    comment: op.comment,
    status: OP_STATUS.ACCEPTED,
    error: '',
    stockAfter: null,
    source: op.source
  });

  // Фаза 2: применяем изменение рабочего остатка.
  var now = nowIso_();
  ctx.stockSheet.getRange(row.rowIndex, COL.stock).setValue(after);
  ctx.stockSheet.getRange(row.rowIndex, COL.available).setValue('=E' + row.rowIndex + '-F' + row.rowIndex);
  ctx.stockSheet.getRange(row.rowIndex, COL.lastOp).setValue(op.operationId);
  ctx.stockSheet.getRange(row.rowIndex, COL.updated).setValue(now);

  // Фаза 3: помечаем операцию обработанной и запоминаем результат.
  ctx.journal.getRange(journalRow, OP_HEADERS.indexOf('Статус') + 1)
    .setValue(OP_STATUS.PROCESSED);
  ctx.journal.getRange(journalRow, OP_HEADERS.indexOf('Остаток после') + 1)
    .setValue(after);

  row.values[COL.stock - 1] = after;
  row.values[COL.updated - 1] = now;
  ctx.seen.add(op.operationId);

  return {
    operationId: op.operationId,
    ok: true,
    status: 'processed',
    // 1 — если эту же операцию склад сначала отклонил, а принял теперь.
    retriedAfterRejection: samePayload ? ctx.seen.rejectedTimes(op.operationId) : undefined,
    sku: op.sku,
    ambiguous: candidates.length > 1,
    matchedName: text_(row.values[COL.name - 1]),
    name: row.values[COL.name - 1],
    qty: op.qty,
    delta: delta,
    stockBefore: before,
    stockAfter: after,
    reserve: reserve,
    availableAfter: Math.max(0, after - reserve),
    updatedAt: now,
    message: 'Операция записана'
  };
}

/**
 * Проверка обязательных полей и идемпотентности. Чистая функция — тестируется
 * без таблицы (см. FORONE_selfTest).
 */
function validateOperation_(op, existingIds) {
  var result = function (ok, status, code, message, extra) {
    var out = {
      operationId: op.operationId || null,
      ok: ok,
      status: status,
      code: code || null,
      message: message || '',
      sku: op.sku || ''
    };
    if (extra) for (var k in extra) out[k] = extra[k];
    return out;
  };

  if (!op.operationId) return { ok: false, status: 'error', result: result(false, 'error', 'NO_OPERATION_ID', 'Нет ID операции — операция не принята'), record: null };
  if (existingIds && existingIds.has(op.operationId)) {
    return {
      ok: false,
      status: 'duplicate',
      result: result(true, 'duplicate', 'DUPLICATE', 'Такая операция уже записана — повторное изменение не применено', {
        duplicate: true
      })
    };
  }
  if (!op.sku) return { ok: false, status: 'rejected', code: 'NO_SKU', result: result(false, 'rejected', 'NO_SKU', 'Не указан артикул'), record: buildRejectedRecord_(op, 'Не указан артикул') };
  if (['in', 'out', 'writeoff'].indexOf(op.type) < 0) return { ok: false, status: 'rejected', code: 'BAD_TYPE', result: result(false, 'rejected', 'BAD_TYPE', 'Неизвестный тип операции: ' + op.type), record: buildRejectedRecord_(op, 'Неизвестный тип операции') };
  if (!op.qty || op.qty <= 0 || op.qty % 1 !== 0) return { ok: false, status: 'rejected', code: 'BAD_QTY', result: result(false, 'rejected', 'BAD_QTY', 'Количество должно быть целым и больше нуля'), record: buildRejectedRecord_(op, 'Некорректное количество') };
  if (op.qty > FORONE_CONFIG.maxQty) return { ok: false, status: 'rejected', code: 'QTY_TOO_BIG', result: result(false, 'rejected', 'QTY_TOO_BIG', 'Слишком большое количество (максимум ' + FORONE_CONFIG.maxQty + ')'), record: buildRejectedRecord_(op, 'Слишком большое количество') };

  return { ok: true, result: result(true, 'accepted', null, '') };
}

function normalizeOperation_(raw, ctx) {
  var src = raw || {};
  var sku = text_(src.sku || src.article || src.Артикул);
  return {
    operationId: text_(src.operationId || src.operation_id || src.id),
    sku: sku,
    skuKey: normalizeKey_(sku),
    name: text_(src.name || src.Название),
    category: text_(src.category || src.Категория),
    type: text_(src.type || src.operationType || 'out').toLowerCase(),
    qty: Math.round(toNumber_(src.qty !== undefined ? src.qty : src.quantity)),
    comment: text_(src.comment || src.Комментарий),
    user: text_(src.user) || text_(ctx && ctx.user) || 'Без имени',
    device: text_(src.device) || text_(ctx && ctx.device) || 'Неизвестное устройство',
    createdAt: text_(src.createdAt),
    source: text_(src.source) || text_(ctx && ctx.source) || 'FORONE Stock'
  };
}

function buildRejectedRecord_(op, reason) {
  return {
    operationId: op.operationId || 'без-id-' + nowIso_(),
    timestamp: formatNow_(),
    sku: op.sku || '—',
    name: op.name || '',
    type: OP_TYPE_LABELS[op.type] || text_(op.type) || '—',
    qty: op.qty || 0,
    delta: 0,
    user: op.user,
    device: op.device,
    comment: op.comment,
    status: OP_STATUS.REJECTED,
    error: reason,
    stockAfter: null,
    source: op.source
  };
}

function makeRejection_(op, status, code, message) {
  return {
    record: buildRejectedRecord_(op, message),
    result: {
      operationId: op.operationId,
      ok: false,
      status: status === OP_STATUS.REJECTED ? 'rejected' : 'error',
      code: code,
      message: message,
      sku: op.sku,
      retry: false
    }
  };
}

function appendOperationRow_(sheet, record) {
  var row = [];
  for (var i = 0; i < OP_HEADERS.length; i += 1) row.push(record[OP_FIELD_KEYS_[i]]);
  sheet.appendRow(row);
  return sheet.getLastRow();
}

var OP_FIELD_KEYS_ = ['operationId', 'timestamp', 'sku', 'name', 'type', 'qty', 'delta', 'user', 'device', 'comment', 'status', 'error', 'stockAfter', 'source'];

function collectOperations_(payload) {
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload.operations) && payload.operations.length) return payload.operations;
  if (Array.isArray(payload.queue) && payload.queue.length) return payload.queue;
  if (payload.operation) return [payload.operation];
  // Одиночная операция «плоским» телом: {operationId, sku, type, qty}
  if (payload.operationId || payload.sku) return [payload];
  return [];
}

function parseRequest_(e) {
  if (!e || !e.postData || !e.postData.contents) {
    if (e && e.parameter && e.parameter.payload) return JSON.parse(e.parameter.payload);
    throw new Error('empty body');
  }
  var raw = e.postData.contents;
  if (e.postData.type && String(e.postData.type).indexOf('application/x-www-form-urlencoded') >= 0) {
    var decoded = decodeURIComponent(raw.replace(/^payload=/, ''));
    return JSON.parse(decoded);
  }
  return JSON.parse(raw);
}

// ---------------------------------------------------------------------------
// ДОСТУПНЫЕ ОСТАТКИ ИЗ СЕРВЕРА (для приложения)
// ---------------------------------------------------------------------------

function buildStockPayload_() {
  var sheet = getOrCreateSheet_(getForoneSpreadsheet_(), FORONE_CONFIG.targetSheet);
  var rows = readSheetRows_(sheet, STOCK_HEADERS.length);
  var products = [];
  var conflicts = [];
  for (var i = 1; i < rows.length; i += 1) {
    var v = rows[i];
    var sku = text_(v[COL.sku - 1]);
    if (!sku || isHeaderish_(v)) continue;
    var stock = Math.max(0, Math.round(toNumber_(v[COL.stock - 1])));
    var reserve = Math.max(0, Math.round(toNumber_(v[COL.reserve - 1])));
    var conflict = text_(v[COL.conflict - 1]);
    products.push({
      sku: sku,
      name: text_(v[COL.name - 1]) || sku,
      category: text_(v[COL.category - 1]) || inferCategory_(text_(v[COL.name - 1]) || sku),
      length: parseLength_(v[COL.length - 1] || v[COL.name - 1]),
      stock: stock,
      reserve: reserve,
      available: Math.max(0, stock - reserve),
      warehouse: text_(v[COL.warehouse - 1]) || 'Алматы',
      zone: text_(v[COL.zone - 1]),
      rack: text_(v[COL.rack - 1]),
      bin: text_(v[COL.bin - 1]),
      lastOp: text_(v[COL.lastOp - 1]),
      updatedAt: text_(v[COL.updated - 1]),
      conflict: conflict
    });
    if (conflict) conflicts.push({ sku: sku, note: conflict });
  }
  return {
    ok: true,
    serverTime: nowIso_(),
    lastSync: readProperty_('FORONE_LAST_SYNC', ''),
    count: products.length,
    products: products,
    conflicts: conflicts
  };
}

function buildOperationsPayload_(params) {
  var sheet = getOrCreateSheet_(getForoneSpreadsheet_(), FORONE_CONFIG.operationsSheet);
  var limit = Math.min(200, Math.max(1, parseInt(params.limit, 10) || 50));
  var skuFilter = normalizeKey_(params.sku || '');
  var rows = readSheetRows_(sheet, OP_HEADERS.length);
  var out = [];
  for (var i = rows.length - 1; i >= 1 && out.length < limit; i -= 1) {
    var v = rows[i];
    if (skuFilter && normalizeKey_(v[OP_HEADERS.indexOf('Артикул')]) !== skuFilter) continue;
    out.push({
      operationId: text_(v[0]),
      timestamp: text_(v[1]),
      sku: text_(v[2]),
      name: text_(v[3]),
      type: text_(v[4]),
      qty: toNumber_(v[5]),
      delta: toNumber_(v[6]),
      user: text_(v[7]),
      device: text_(v[8]),
      comment: text_(v[9]),
      status: text_(v[10]),
      error: text_(v[11]),
      stockAfter: v[12] === '' ? null : toNumber_(v[12])
    });
  }
  return { ok: true, serverTime: nowIso_(), count: out.length, operations: out };
}

function checkAccess_(params, payload) {
  var secret = readProperty_('FORONE_SHARED_SECRET', '');
  if (secret) {
    var given = text_((payload && (payload.key || payload.secret)) || params.key || params.secret || '');
    if (given !== secret) return { ok: false, code: 'AUTH', message: 'Неверный или отсутствует ключ доступа' };
  }
  var allowed = (readProperty_('FORONE_ALLOWED_USERS', '') || '')
    .split(',').map(function (item) { return item.trim().toLowerCase(); })
    .filter(Boolean);
  if (allowed.length) {
    var user = text_((payload && payload.user) || params.user).toLowerCase();
    var device = text_((payload && payload.device) || params.device).toLowerCase();
    if (allowed.indexOf(user) < 0 && allowed.indexOf(device) < 0) {
      return { ok: false, code: 'FORBIDDEN_USER', message: 'Пользователь не в списке разрешённых' };
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// СЛИЯНИЕ ИСХОДНИКОВ С ОПЕРАЦИОННЫМ ЛИСТОМ (односторонний импорт, версия 2)
// ---------------------------------------------------------------------------

/**
 * Ключевое правило: колонка E («Остаток на складе») — рабочий остаток.
 * Импорт НЕ затирает её значением из источника. Вместо этого считается дельта
 * между новым значением источника и предыдущим снимком (колонка L) и
 * применяется к рабочему остатку. Ручные операции при этом сохраняются.
 */
function syncForoneStock(options) {
  var opts = options || {};
  var lock = LockService.getScriptLock();
  var locked = false;
  try {
    locked = lock.tryLock(30000);
  } catch (error) {
    locked = false;
  }
  if (!locked) return { ok: false, code: 'BUSY', message: 'Синхронизация уже выполняется' };

  try {
    var ss = getForoneSpreadsheet_();
    var target = getOrCreateSheet_(ss, FORONE_CONFIG.targetSheet);
    var existing = readTargetRows_(target);
    var source = readSourceIndex_(ss);
    var plan = mergeStockPlan_(existing, source, nowIso_());

    if (!opts.dryRun) writeStockRows_(target, plan.rows);
    if (!opts.dryRun) recordConflicts_(ss, plan.conflicts);

    var props = PropertiesService.getScriptProperties();
    props.setProperties({
      FORONE_LAST_SYNC: opts.dryRun ? (props.getProperty('FORONE_LAST_SYNC') || '') : nowIso_(),
      FORONE_LAST_COUNT: String(plan.rows.length),
      FORONE_LAST_CONFLICTS: String(plan.conflicts.length),
      FORONE_LAST_ADDITIONS: String(plan.added),
      FORONE_LAST_APPLIED_OPS: String(plan.appliedSourceChanges),
      FORONE_LAST_RENAMED: String(plan.renamed)
    });

    return {
      ok: true,
      dryRun: !!opts.dryRun,
      rows: plan.rows.length,
      added: plan.added,
      renamed: plan.renamed,
      sourceChanges: plan.appliedSourceChanges,
      conflicts: plan.conflicts,
      serverTime: nowIso_()
    };
  } catch (error) {
    logError_('sync', null, null, null, null, 'SYNC_FAILED', error);
    throw error;
  } finally {
    try { lock.releaseLock(); } catch (ignored) {}
  }
}

/**
 * Чистая функция слияния. existing: [{rowIndex, values}], source: [{...item}].
 * Возвращает готовые строки для записи и список конфликтов.
 */
function mergeStockPlan_(existing, source, timestamp) {
  var existingByKey = Object.create(null);
  var existingBySku = Object.create(null);
  var i, key;
  for (i = 0; i < existing.length; i += 1) {
    key = rowFullKey_(existing[i].values);
    if (key) {
      if (existingByKey[key]) existing[i].duplicate = true;
      existingByKey[key] = existing[i];
    }
    var skuKeyOnly = normalizeKey_(existing[i].values[COL.sku - 1]);
    if (skuKeyOnly) {
      if (!existingBySku[skuKeyOnly]) existingBySku[skuKeyOnly] = [];
      existingBySku[skuKeyOnly].push(existing[i]);
    }
  }

  var rows = [];
  var conflicts = [];
  var added = 0;
  var renamed = 0;
  var appliedSourceChanges = 0;
  var used = Object.create(null);

  for (i = 0; i < source.length; i += 1) {
    var item = source[i];
    key = makeKey_(item.sku, item.category, item.name);
    if (!normalizeKey_(item.sku) || used[key]) continue;
    used[key] = true;
    var old = existingByKey[key];
    if (!old) {
      // Переименование в источнике: тот же артикул и одна свободная строка —
      // сохраняем рабочий остаток и журнал позиции, а не заводим дубль.
      var free = (existingBySku[normalizeKey_(item.sku)] || []).filter(function (candidate) {
        return !candidate.claimed && !candidate.duplicate;
      });
      if (free.length === 1) { old = free[0]; renamed += 1; }
    }
    if (old) old.claimed = true;
    var row;
    if (!old) {
      row = {
        sku: item.sku, name: item.name, category: item.category, length: item.length,
        stock: item.stock, reserve: 0, warehouse: 'Алматы', zone: '', rack: '', bin: '',
        sourceStock: item.stock, lastOp: '', updated: timestamp, conflict: ''
      };
      added += 1;
    } else {
      var v = old.values;
      var working = Math.max(0, Math.round(toNumber_(v[COL.stock - 1])));
      var baseRaw = v[COL.sourceStock - 1];
      var hasBase = baseRaw !== '' && baseRaw !== null && baseRaw !== undefined;
      var base = hasBase ? Math.round(toNumber_(baseRaw)) : working;
      var delta = item.stock - base;
      var lastOp = text_(v[COL.lastOp - 1]);
      var nextStock = working + delta;
      var conflict = '';

      if (delta !== 0) appliedSourceChanges += 1;

      if (nextStock < 0) {
        conflict = '⚠ РАСХОЖДЕНИЕ: источник ' + item.stock + ', операции ' + (working - base) +
          ', рабочий остаток опущен до 0';
        nextStock = 0;
      } else if (delta !== 0 && lastOp) {
        conflict = 'Источник: ' + base + ' → ' + item.stock + '; операции: ' + (working - base) +
          '; рабочий остаток: ' + nextStock;
      } else if (!hasBase && working !== item.stock) {
        conflict = 'Базовый снимок не задан — рабочий остаток ' + working + ' сохранён, источник ' + item.stock;
      }

      row = {
        sku: item.sku,
        name: item.name || text_(v[COL.name - 1]),
        category: item.category || text_(v[COL.category - 1]),
        length: item.length,
        stock: nextStock,
        reserve: Math.min(Math.max(0, Math.round(toNumber_(v[COL.reserve - 1]))), Math.max(0, nextStock)),
        warehouse: text_(v[COL.warehouse - 1]) || 'Алматы',
        zone: text_(v[COL.zone - 1]),
        rack: text_(v[COL.rack - 1]),
        bin: text_(v[COL.bin - 1]),
        sourceStock: item.stock,
        lastOp: lastOp,
        updated: lastOp ? text_(v[COL.updated - 1]) || timestamp : timestamp,
        conflict: conflict
      };
    }
    rows.push(toStockRow_(row));
    if (row.conflict) conflicts.push({ sku: row.sku, note: row.conflict });
  }

  // Позиции, которые есть в складе, но пропали из источника, НЕ удаляем:
  // в них могут быть неприменённые операции.
  for (i = 0; i < existing.length; i += 1) {
    var exKey = rowFullKey_(existing[i].values);
    // Строку уже забрала позиция из источника (в том числе при переименовании) — не дублируем.
    if (!exKey || used[exKey] || existing[i].claimed) continue;
    var ev = existing[i].values;
    var workingOnly = Math.max(0, Math.round(toNumber_(ev[COL.stock - 1])));
    rows.push(toStockRow_({
      sku: text_(ev[COL.sku - 1]),
      name: text_(ev[COL.name - 1]),
      category: text_(ev[COL.category - 1]),
      length: ev[COL.length - 1] || 3000,
      stock: workingOnly,
      reserve: Math.min(Math.max(0, toNumber_(ev[COL.reserve - 1])), workingOnly),
      warehouse: text_(ev[COL.warehouse - 1]) || 'Алматы',
      zone: text_(ev[COL.zone - 1]),
      rack: text_(ev[COL.rack - 1]),
      bin: text_(ev[COL.bin - 1]),
      sourceStock: ev[COL.sourceStock - 1],
      lastOp: text_(ev[COL.lastOp - 1]),
      updated: text_(ev[COL.updated - 1]),
      conflict: 'Нет в источнике — рабочий остаток ' + workingOnly + ' сохранён'
    }));
    conflicts.push({ sku: text_(ev[COL.sku - 1]), note: 'Позиция пропала из исходного листа' });
  }

  rows.sort(function (a, b) {
    var cat = String(a[2]).localeCompare(String(b[2]), 'ru');
    return cat || String(a[0]).localeCompare(String(b[0]), 'ru');
  });

  return {
    rows: rows,
    conflicts: conflicts,
    added: added,
    renamed: renamed,
    appliedSourceChanges: appliedSourceChanges
  };
}

function toStockRow_(row) {
  return [
    row.sku, row.name, row.category, row.length, row.stock, row.reserve,
    row.warehouse, row.zone, row.rack, row.bin, null, row.sourceStock,
    row.lastOp, row.updated, row.conflict
  ];
}

function writeStockRows_(sheet, rows) {
  sheet.clearContents();
  ensureHeader_(sheet, STOCK_HEADERS);
  if (!rows.length) {
    formatStockSheet_(sheet, 1);
    return;
  }
  for (var i = 0; i < rows.length; i += 1) {
    if (rows[i][COL.updated - 1] instanceof Date) rows[i][COL.updated - 1] = text_(rows[i][COL.updated - 1]);
  }
  sheet.getRange(2, 1, rows.length, STOCK_HEADERS.length).setValues(rows);
  var formulas = rows.map(function (_, index) { return ['=E' + (index + 2) + '-F' + (index + 2)]; });
  sheet.getRange(2, COL.available, rows.length, 1).setFormulas(formulas);
  formatStockSheet_(sheet, rows.length + 1);
}

function recordConflicts_(ss, conflicts) {
  var signature = conflicts.map(function (c) { return c.sku + '=' + c.note; }).sort().join(';;');
  var previous = readProperty_('FORONE_CONFLICT_SIG', '');
  writeProperty_('FORONE_CONFLICT_SIG', signature);
  writeProperty_('FORONE_CONFLICT_LIST', signature ? signature : '');
  if (!conflicts.length || signature === previous) return;

  var sheet = getOrCreateSheet_(ss, FORONE_CONFIG.errorsSheet);
  var open = readProperty_('FORONE_OPEN_CONFLICT_SKUS', '');
  for (var i = 0; i < conflicts.length; i += 1) {
    if (open.indexOf(normalizeKey_(conflicts[i].sku)) >= 0) continue;
    appendErrorRow_(sheet, {
      kind: 'Конфликт остатков',
      operationId: '',
      sku: conflicts[i].sku,
      user: 'Автоматическая синхронизация',
      device: 'Apps Script',
      code: 'STOCK_CONFLICT',
      message: conflicts[i].note,
      details: ''
    });
  }
  writeProperty_('FORONE_OPEN_CONFLICT_SKUS', conflicts.map(function (c) {
    return normalizeKey_(c.sku);
  }).join(','));
}

// ---------------------------------------------------------------------------
// ИМПОРТ ИЗ ИСХОДНЫХ ЛИСТОВ
// ---------------------------------------------------------------------------

function readSourceIndex_(ss) {
  var items = [];
  for (var s = 0; s < FORONE_CONFIG.sourceSheets.length; s += 1) {
    var sheet = ss.getSheetByName(FORONE_CONFIG.sourceSheets[s]);
    if (!sheet) continue;
    var values = sheet.getDataRange().getValues();
    var headerRow = findHeaderRow_(values);
    if (headerRow < 0) continue;
    var columns = mapColumns_(values[headerRow]);
    for (var r = headerRow + 1; r < values.length; r += 1) {
      var item = readSourceItem_(values[r], columns);
      if (item && !isSummaryItem_(item)) items.push(item);
    }
  }
  return items;
}

function readTargetRows_(sheet) {
  var rows = readSheetRows_(sheet, STOCK_HEADERS.length);
  var out = [];
  for (var i = 1; i < rows.length; i += 1) {
    if (!text_(rows[i][COL.sku - 1])) continue;
    out.push({ rowIndex: i + 1, values: rows[i] });
  }
  return out;
}

function buildStockIndex_(sheet) {
  var rows = readTargetRows_(sheet);
  var bySku = Object.create(null);
  var byFullKey = Object.create(null);
  for (var i = 0; i < rows.length; i += 1) {
    var values = rows[i].values;
    var skuKey = normalizeKey_(values[COL.sku - 1]);
    var fullKey = rowFullKey_(values);
    if (fullKey) byFullKey[fullKey] = rows[i];
    if (skuKey) {
      if (!bySku[skuKey]) bySku[skuKey] = [];
      bySku[skuKey].push(rows[i]);
    }
  }
  return { rows: rows, bySku: bySku, byFullKey: byFullKey };
}

/**
 * Идентичность строки склада: артикул + категория + название.
 * В реальной книге FORONE один артикул встречается в нескольких позициях
 * (например, H234-YP — и лувер, и панель), поэтому одного артикула мало.
 */
function rowFullKey_(values) {
  return makeKey_(valueAt_(values, COL.sku - 1), valueAt_(values, COL.category - 1), valueAt_(values, COL.name - 1));
}

/**
 * Выбор строки для операции: точное совпадение по названию, затем по категории,
 * затем позиция с достаточным остатком, затем первая по списку.
 */
function pickStockRow_(candidates, op) {
  if (!candidates || !candidates.length) return null;
  if (candidates.length === 1) return candidates[0];
  var i, candidate;
  var wantedCategory = normalizeKey_(op.category);
  var wantedName = normalizeKey_(op.name);
  if (wantedName) {
    for (i = 0; i < candidates.length; i += 1) {
      if (normalizeKey_(candidates[i].values[COL.name - 1]) === wantedName) return candidates[i];
    }
  }
  if (wantedCategory) {
    var sameCategory = candidates.filter(function (item) {
      return normalizeKey_(item.values[COL.category - 1]) === wantedCategory;
    });
    if (sameCategory.length === 1) return sameCategory[0];
    if (sameCategory.length) candidates = sameCategory;
  }
  if (op.type !== 'in') {
    for (i = 0; i < candidates.length; i += 1) {
      candidate = candidates[i];
      var available = Math.max(0, toNumber_(candidate.values[COL.stock - 1]) - toNumber_(candidate.values[COL.reserve - 1]));
      if (available >= op.qty) return candidate;
    }
  }
  return candidates[0];
}

/**
 * Учёт ID операций по журналу.
 * Применённую операцию нельзя провести второй раз — это защита от двойного
 * списания при повторной отправке. Отклонённую (не хватило товара, нет артикула)
 * наоборот: можно прислать снова, когда склад устранит причину. Раньше обе
 * попадали в один набор, и повтор после отклонения молча терялся.
 */
function buildOperationLedger_(sheet) {
  var applied = newSet_();
  var rejectedCount = Object.create(null);
  var rejectedSig = Object.create(null);
  var statusIndex = OP_HEADERS.indexOf('Статус');
  var lastRow = sheet.getLastRow();
  if (lastRow >= 2 && statusIndex >= 0) {
    var values = sheet.getRange(2, 1, lastRow - 1, statusIndex + 1).getValues();
    for (var i = 0; i < values.length; i += 1) {
      var id = text_(values[i][0]);
      if (!id) continue;
      var status = text_(values[i][statusIndex]);
      if (status === OP_STATUS.REJECTED || status === OP_STATUS.ERROR) {
        rejectedCount[id] = (rejectedCount[id] || 0) + 1;
        if (rejectedSig[id] === undefined) rejectedSig[id] = journalSignature_(values[i]);
      } else {
        // Пустой статус — строка из старого журнала, считаем проведённой.
        applied.add(id);
      }
    }
  }
  return {
    has: function (id) { return applied.has(id); },
    add: function (id) { if (id) applied.add(id); },
    reject: function (id, signature) {
      if (!id) return;
      rejectedCount[id] = (rejectedCount[id] || 0) + 1;
      if (rejectedSig[id] === undefined) rejectedSig[id] = signature || '';
    },
    wasRejected: function (id) { return Boolean(id && rejectedCount[id]); },
    rejectedTimes: function (id) { return rejectedCount[id] || 0; },
    rejectedSignature: function (id) { return rejectedSig[id] || ''; }
  };
}

/** Подпись данных операции: артикул + тип + количество. */
function operationSignature_(op) {
  return [op.skuKey || normalizeKey_(op.sku || ''), String(op.type || '').toLowerCase(), Math.round(toNumber_(op.qty))].join('|');
}

/** Буква типа по русской подписи из журнала. */
function opTypeFromLabel_(label) {
  var key = normalizeKey_(label);
  for (var code in OP_TYPE_LABELS) {
    if (normalizeKey_(OP_TYPE_LABELS[code]) === key) return code;
  }
  return key;
}

/** Подпись строки журнала (колонки: артикул, тип, количество). */
function journalSignature_(row) {
  return [normalizeKey_(text_(row[2])), opTypeFromLabel_(row[4]), Math.round(toNumber_(row[5]))].join('|');
}

function newSet_() {
  if (typeof Set === 'function') return new Set();
  return new SimpleSet_();
}

/** Минимальный набор для среды без нативного Set. */
function SimpleSet_() {
  var items = {};
  var size = 0;
  this.add = function (value) { if (!items[value]) { items[value] = true; size += 1; } return this; };
  this.has = function (value) { return Boolean(items[value]); };
  Object.defineProperty(this, 'size', { get: function () { return size; } });
}

function readSheetRows_(sheet, width) {
  var lastRow = sheet.getLastRow();
  if (!lastRow) return [];
  var values = sheet.getRange(1, 1, lastRow, Math.max(width, 1)).getValues();
  // Нормализуем ширину строк до нужного количества колонок.
  for (var r = 0; r < values.length; r += 1) {
    while (values[r].length < width) values[r].push('');
    values[r].length = width;
  }
  return values;
}

// ---------------------------------------------------------------------------
// ОШИБКИ И ЖУРНАЛ
// ---------------------------------------------------------------------------

function logOperationRejection_(ss, check, op) {
  if (!check || !check.result || check.result.code === 'DUPLICATE') return;
  logError_('operation', op.operationId, op.sku, op.user, op.device, check.result.code || 'REJECTED', check.result.message);
}

function logError_(kind, operationId, sku, user, device, code, error) {
  var message = String((error && error.message) || error || 'Неизвестная ошибка');
  var stack = (error && error.stack) ? String(error.stack).split('\n').slice(0, 4).join(' | ') : '';
  try {
    var sheet = getOrCreateSheet_(getForoneSpreadsheet_(), FORONE_CONFIG.errorsSheet);
    appendErrorRow_(sheet, {
      kind: kind === 'operation' ? 'Отклонено приложением' : 'Сбой скрипта',
      operationId: text_(operationId),
      sku: text_(sku),
      user: text_(user) || 'Apps Script',
      device: text_(device) || 'Apps Script',
      code: code,
      message: message,
      details: stack
    });
  } catch (ignored) {
    // Журнал ошибок не должен ломать основной ответ.
  }
  try { console.error('[FORONE] ' + code + ': ' + message); } catch (alsoIgnored) {}
}

function appendErrorRow_(sheet, record) {
  sheet.appendRow([
    formatNow_(), record.kind || 'Ошибка', record.operationId || '', record.sku || '',
    record.user || '', record.device || '', record.code || '', record.message || '', record.details || ''
  ]);
}

// ---------------------------------------------------------------------------
// УСТАНОВКА И ОБСЛУЖИВАНИЕ
// ---------------------------------------------------------------------------

/** Запустить один раз после вставки кода: создаёт листы, заголовки и триггер. */
function FORONE_setup() {
  var ss = getForoneSpreadsheet_();
  var target = getOrCreateSheet_(ss, FORONE_CONFIG.targetSheet);
  var journal = getOrCreateSheet_(ss, FORONE_CONFIG.operationsSheet);
  var errors = getOrCreateSheet_(ss, FORONE_CONFIG.errorsSheet);

  ensureHeader_(target, STOCK_HEADERS);
  ensureHeader_(journal, OP_HEADERS);
  ensureHeader_(errors, ERR_HEADERS);
  formatStockSheet_(target, Math.max(target.getLastRow(), 1));
  formatJournalSheet_(journal);
  formatErrorSheet_(errors);

  var name = FORONE_CONFIG.triggerFunction;
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === name) ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger(name).timeBased().everyMinutes(FORONE_CONFIG.triggerMinutes).create();

  var result = syncForoneStock();
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('FORONE_SHARED_SECRET')) {
    props.setProperty('FORONE_SHARED_SECRET_HINT',
      'Project settings → Script properties → добавьте FORONE_SHARED_SECRET и введите тот же ключ в приложении');
  }

  Logger.log(JSON.stringify({
    ok: true,
    version: FORONE_CONFIG.version,
    spreadsheet: safeUrl_(),
    sheets: describeSheets_(),
    sync: result,
    nextStep: 'Deploy → New deployment → Web app → Execute as: Me → Access: Anyone with the link'
  }, null, 2));
  return result;
}

/** Быстрая проверка связи прямо в редакторе: вывести ответ doGet. */
function FORONE_ping() {
  Logger.log(JSON.stringify({
    sheets: describeSheets_(),
    lastSync: readProperty_('FORONE_LAST_SYNC', ''),
    conflicts: readProperty_('FORONE_CONFLICT_LIST', ''),
    secretConfigured: !!readProperty_('FORONE_SHARED_SECRET', '')
  }, null, 2));
}

/** Прогнать слияние без записи в таблицу. */
function FORONE_dryRun() {
  Logger.log(JSON.stringify(syncForoneStock({ dryRun: true }), null, 2));
}

/** Автотесты чистой логики (без обращения к таблице). */
function FORONE_selfTest() {
  var failures = [];
  var assert = function (name, condition) {
    if (!condition) failures.push(name);
  };

  var seen = newSet_();
  seen.add('op-1');

  var dup = validateOperation_(normalizeOperation_({ operationId: 'op-1', sku: 'A', type: 'out', qty: 1 }, {}), seen);
  assert('идемпотентность: повтор не применяется', dup.status === 'duplicate' && dup.ok === false && dup.result.ok === true && dup.result.duplicate === true);

  var noId = validateOperation_(normalizeOperation_({ sku: 'A', type: 'out', qty: 1 }, {}), seen);
  assert('без ID операция отклоняется', noId.ok === false && noId.result.code === 'NO_OPERATION_ID');

  var badQty = validateOperation_(normalizeOperation_({ operationId: 'op-2', sku: 'A', type: 'out', qty: 0 }, {}), seen);
  assert('нулевое количество отклоняется', badQty.ok === false && badQty.result.code === 'BAD_QTY');

  var badType = validateOperation_(normalizeOperation_({ operationId: 'op-3', sku: 'A', type: 'magic', qty: 2 }, {}), seen);
  assert('неизвестный тип отклоняется', badType.ok === false && badType.result.code === 'BAD_TYPE');

  var existing = [{
    rowIndex: 2,
    values: ['Н234-YP', 'Панель', 'Панель', 3000, 32, 0, 'Алматы', '', '', '', '', 36, 'op-9', '', '']
  }];
  var source = [{ sku: 'Н234-YP', name: 'Панель', category: 'Панель', length: 3000, stock: 40 }];
  var plan = mergeStockPlan_(existing, source, 'now');
  assert('дельта источника применяется к рабочему остатку', plan.rows[0][4] === 36);
  assert('снимок источника обновлён', plan.rows[0][11] === 40);
  assert('конфликт зафиксирован', /рабочий остаток: 36/.test(plan.rows[0][14]));

  var gone = mergeStockPlan_([
    { rowIndex: 2, values: ['XX', 'нет в источнике', 'Панель', 3000, 5, 1, 'Алматы', '', '', '', '', '', '', '', ''] }
  ], [], 'now');
  assert('позиция без источника не удаляется', gone.rows.length === 1 && gone.rows[0][4] === 5);

  var negative = mergeStockPlan_([
    { rowIndex: 2, values: ['YY', 'тест', 'Панель', 3000, 2, 0, 'Алматы', '', '', '', '', 10, 'op-1', '', ''] }
  ], [{ sku: 'YY', name: 'тест', category: 'Панель', length: 3000, stock: 3 }], 'now');
  assert('уход в минус не допускается', negative.rows[0][4] === 0 && /РАСХОЖДЕНИЕ/.test(negative.rows[0][14]));

  Logger.log(failures.length ? 'ПРОВАЛ: ' + failures.join('; ') : 'Все проверки (' + 9 + ') пройдены');
  return failures;
}

function describeSheets_() {
  var ss = getForoneSpreadsheet_();
  var out = {};
  var names = [FORONE_CONFIG.targetSheet, FORONE_CONFIG.operationsSheet, FORONE_CONFIG.errorsSheet];
  for (var i = 0; i < names.length; i += 1) {
    var sheet = ss.getSheetByName(names[i]);
    out[names[i]] = sheet ? Math.max(0, sheet.getLastRow() - 1) : null;
  }
  return out;
}

function countRows_(sheet) {
  return sheet.getLastRow();
}

function countConflicts_(sheet) {
  var rows = readSheetRows_(sheet, STOCK_HEADERS.length);
  var count = 0;
  for (var i = 1; i < rows.length; i += 1) if (text_(rows[i][COL.conflict - 1])) count += 1;
  return count;
}

function ensureHeader_(sheet, headers) {
  // Старый лист может быть создан только до колонки K. Расширяем сетку заранее,
  // чтобы добавление служебных столбцов не завершилось ошибкой диапазона.
  if (typeof sheet.getMaxColumns === 'function' && typeof sheet.insertColumnsAfter === 'function') {
    var maxColumns = sheet.getMaxColumns();
    if (maxColumns < headers.length) sheet.insertColumnsAfter(maxColumns, headers.length - maxColumns);
  }
  var first = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  var same = headers.every(function (value, index) { return text_(first[index]) === value; });
  if (!same) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers])
      .setFontWeight('bold').setFontColor('#ffffff').setBackground('#173b43');
  }
  sheet.setFrozenRows(1);
}

/** Меню в таблице для ручного запуска безопасной сверки и диагностики. */
function onOpen() {
  try {
    SpreadsheetApp.getUi().createMenu('FORONE склад')
      .addItem('Настроить Web App и сверить остатки', 'FORONE_setup')
      .addItem('Сверить остатки', 'syncForoneStock')
      .addItem('Проверить состояние', 'FORONE_ping')
      .addItem('Самотест', 'FORONE_selfTest')
      .addToUi();
  } catch (ignored) {}
}

function formatStockSheet_(sheet, rowCount) {
  try {
    var oldFilter = sheet.getFilter();
    if (oldFilter) oldFilter.remove();
  } catch (ignored) {}
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, STOCK_HEADERS.length).setFontWeight('bold').setFontColor('#ffffff').setBackground('#173b43');
  if (rowCount > 1) sheet.getRange(1, 1, rowCount, STOCK_HEADERS.length).createFilter();
  sheet.autoResizeColumns(1, STOCK_HEADERS.length);
  sheet.setColumnWidth(COL.name, 260);
  sheet.setColumnWidth(COL.conflict, 320);
}

function formatJournalSheet_(sheet) {
  try {
    var oldFilter = sheet.getFilter();
    if (oldFilter) oldFilter.remove();
  } catch (ignored) {}
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, OP_HEADERS.length).setFontWeight('bold').setFontColor('#ffffff').setBackground('#1d3f2f');
  if (sheet.getLastRow() > 1) sheet.getRange(1, 1, sheet.getLastRow(), OP_HEADERS.length).createFilter();
  sheet.autoResizeColumns(1, OP_HEADERS.length);
}

function formatErrorSheet_(sheet) {
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, ERR_HEADERS.length).setFontWeight('bold').setFontColor('#ffffff').setBackground('#5a2421');
  sheet.autoResizeColumns(1, ERR_HEADERS.length);
}

// ---------------------------------------------------------------------------
// Мелкие утилиты (совместимы со старой версией скрипта)
// ---------------------------------------------------------------------------

function getForoneSpreadsheet_() {
  var id = getSpreadsheetId_();
  if (id) return SpreadsheetApp.openById(id);
  var active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) return active;
  throw new Error('Не задан FORONE_SPREADSHEET_ID и нет активной таблицы');
}

function getSpreadsheetId_() {
  return text_(readProperty_('FORONE_SPREADSHEET_ID', '')) || text_(FORONE_SPREADSHEET_ID);
}

function safeName_() {
  try { return getForoneSpreadsheet_().getName(); } catch (ignored) { return ''; }
}

function safeUrl_() {
  try { return getForoneSpreadsheet_().getUrl(); } catch (ignored) { return ''; }
}

function getOrCreateSheet_(spreadsheet, name) {
  return spreadsheet.getSheetByName(name) || spreadsheet.insertSheet(name);
}

function readProperty_(key, fallback) {
  try {
    var value = PropertiesService.getScriptProperties().getProperty(key);
    return value === null || value === undefined ? fallback : value;
  } catch (ignored) {
    return fallback;
  }
}

function writeProperty_(key, value) {
  try { PropertiesService.getScriptProperties().setProperty(key, String(value)); } catch (ignored) {}
}

function json_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function nowIso_() {
  return new Date().toISOString();
}

function formatNow_() {
  var tz = FORONE_CONFIG.timeZone;
  try { tz = Session.getScriptTimeZone() || tz; } catch (ignored) {}
  try {
    return Utilities.formatDate(new Date(), tz, 'dd.MM.yyyy HH:mm:ss');
  } catch (fallback) {
    return new Date().toLocaleString('ru-RU');
  }
}

function findHeaderRow_(values) {
  for (var r = 0; r < Math.min(values.length, 40); r += 1) {
    var row = values[r].map(normalize_);
    var hasSku = row.some(function (value) { return ['артикул', 'sku', 'код', 'article', 'номенклатура', 'colorno'].indexOf(value) >= 0; });
    var hasStock = row.some(function (value) { return ['остаток', 'остатокнаскладе', 'остатокпослепоступлениятовара', 'количество', 'колво', 'qty', 'stock', 'алматыналичии'].indexOf(value) >= 0; });
    if (hasSku && hasStock) return r;
  }
  return -1;
}

function mapColumns_(header) {
  var names = header.map(normalize_);
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
  for (var i = 0; i < headers.length; i += 1) if (aliases.indexOf(headers[i]) >= 0) return i;
  return -1;
}

function readSourceItem_(row, columns) {
  var sku = text_(valueAt_(row, columns.sku));
  if (!sku) return null;
  var name = text_(valueAt_(row, columns.name)) || sku;
  var categoryValue = text_(valueAt_(row, columns.category));
  var rawLength = valueAt_(row, columns.length);
  return {
    sku: sku,
    name: name,
    category: categoryValue || inferCategory_(name),
    length: rawLength ? parseLength_(rawLength) : parseLength_(name),
    stock: Math.max(0, Math.round(toNumber_(valueAt_(row, columns.stock))))
  };
}

function isSummaryItem_(item) {
  return /^(итого|всего|total)(\b|\s)/i.test(item.sku) || !item.name || item.name === item.sku;
}

function isHeaderish_(row) {
  return /^(артикул|sku)$/i.test(text_(row[COL.sku - 1]));
}

function inferCategory_(name) {
  var value = String(name || '').toLowerCase();
  if (value.indexOf('лувер') >= 0 || value.indexOf('louver') >= 0) return 'Лувер';
  if (value.indexOf('проф') >= 0) return 'Профиль';
  return 'Панель';
}

function parseLength_(value) {
  var txt = String(value || '').toLowerCase().replace(/\s+/g, ' ');
  return /4000|(?:^|[^0-9])4\s*м(?:\b|$)|4\s*метр/.test(txt) ? 4000 : 3000;
}

function makeKey_(sku, category, name) {
  return [sku, category, name].map(normalize_).join('|');
}

function normalizeKey_(value) {
  return String(value == null ? '' : value).trim().toLowerCase().replace(/\s+/g, '');
}

function normalize_(value) {
  return String(value == null ? '' : value).toLowerCase().replace(/[\s_\-./№:()]/g, '');
}

function text_(value) {
  return String(value == null ? '' : value).trim();
}

function valueAt_(row, index) {
  return index >= 0 ? row[index] : '';
}

function toNumber_(value) {
  if (typeof value === 'number' && isFinite(value)) return value;
  var cleaned = text_(value).replace(/\s/g, '').replace(',', '.').replace(/[^\d.-]/g, '');
  var parsed = Number(cleaned);
  return isFinite(parsed) ? parsed : 0;
}

function json_stringify_(value) { return JSON.stringify(value); }
