/**
 * Тесты серверной части (FORONE_Sync_v2.gs) против эмулятора Apps Script.
 * Покрывают сценарии плана внедрения: приход, расход, списание, нехватка
 * остатка, повторная отправка, два устройства, слияние с источником, конфликты.
 *
 * Запуск: node /home/ubuntu/work/tests/gs-tests.js
 */
'use strict';
const path = require('path');
const { createEnvironment, loadScript, postEvent, getEvent, parseOutput } = require('./gs-harness');

const GS = path.join(__dirname, '..', 'FORONE_Sync_v2.gs');
const SHEET_ID = 'TEST_SHEET_ID';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log('  \u001b[32m+\u001b[0m ' + name);
  } else {
    failed += 1;
    failures.push(name + (detail ? ' -> ' + JSON.stringify(detail) : ''));
    console.log('  \u001b[31mx\u001b[0m ' + name + (detail ? '\n      ' + JSON.stringify(detail) : ''));
  }
}

function group(title) { console.log('\n\u001b[1m' + title + '\u001b[0m'); }

function defaultSource() {
  return [
    ['Артикул', 'Название', 'Категория', 'Длина', 'Остаток на складе'],
    ['Н234-YP', 'Бамбуковая панель Natural Oak', 'Панель', '3000', 36],
    ['К01-206N', 'Лувер Vertical Graphite', 'Лувер', '3000', 8],
    ['ПР-40-WH', 'Профиль завершающий White', 'Профиль', '3000', 0]
  ];
}

function makeApp(options) {
  const opts = options || {};
  const seed = { 'Октябрь-Ноябрь': opts.sourceRows || defaultSource() };
  if (opts.presetTarget) seed['FORONE_Остатки'] = opts.presetTarget;
  const env = createEnvironment({ spreadsheetId: SHEET_ID, seed });
  env.properties.set('FORONE_SPREADSHEET_ID', SHEET_ID);
  if (opts.sharedSecret) env.properties.set('FORONE_SHARED_SECRET', opts.sharedSecret);
  if (opts.allowedUsers) env.properties.set('FORONE_ALLOWED_USERS', opts.allowedUsers);
  const api = loadScript(env, GS);
  if (!opts.presetTarget) api.FORONE_setup();
  return {
    env,
    api,
    target: () => env.main.getSheetByName('FORONE_Остатки'),
    journal: () => env.main.getSheetByName('FORONE_Операции'),
    errors: () => env.main.getSheetByName('FORONE_Ошибки')
  };
}

function post(api, operations, extra) {
  const payload = Object.assign({
    action: 'operations',
    app: 'FORONE Stock',
    user: 'Сотрудник 1',
    device: 'Телефон A',
    operations
  }, extra || {});
  return parseOutput(api.doPost(postEvent(payload)));
}

function op(fields) {
  return Object.assign({
    operationId: 'op-' + Math.random().toString(36).slice(2, 10),
    sku: 'Н234-YP',
    type: 'out',
    qty: 1,
    name: 'Бамбуковая панель Natural Oak',
    comment: ''
  }, fields);
}

function values(sheet) { return sheet.getDataRange().getValues(); }

function rowOf(target, sku) {
  return values(target).find((row) => String(row[0]).trim() === sku) || null;
}

function journalRows(journal) {
  return values(journal).slice(1).filter((row) => String(row[0]).trim());
}

function rowIndexFor(sheet, sku) {
  return values(sheet).findIndex((row) => String(row[0]).trim() === sku) + 1;
}

function errorRows(sheet) {
  return values(sheet).slice(1).filter((row) => String(row[0]).trim());
}

// ===========================================================================
group('1. Установка и первичное наполнение листа FORONE_Остатки');
{
  const app = makeApp();
  const target = app.target();
  const header = target.getRange(1, 1, 1, 15).getValues()[0];
  check('создан заголовок из 15 колонок', header.length === 15 && header[0] === 'Артикул' && header[14] === 'Расхождение', header);
  check('журнал операций создан', !!app.journal() && String(app.journal().getRange(1, 1).getValue()) === 'ID операции');
  check('лист ошибок создан', !!app.errors());
  const row = rowOf(target, 'Н234-YP');
  check('рабочий остаток взят из источника (36)', row && Number(row[4]) === 36, row && row[4]);
  check('снимок источника записан в колонку L', row && Number(row[11]) === 36, row && row[11]);
  check('нулевой остаток импортируется корректно', Number(rowOf(target, 'ПР-40-WH')[4]) === 0);
  check('время последней синхронизации сохранено', !!app.env.properties.get('FORONE_LAST_SYNC'));
}

group('1b. Безопасное обновление существующего листа с 11 колонками');
{
  const app = makeApp({ presetTarget: [
    ['Артикул', 'Название', 'Категория', 'Длина', 'Остаток на складе', 'Резерв', 'Склад', 'Зона', 'Стеллаж', 'Ячейка', 'Доступно к продаже'],
    ['Н234-YP', 'Бамбуковая панель Natural Oak', 'Панель', 3000, 36, 2, 'Алматы', 'A', 'R1', 'B2', 34]
  ] });
  const target = app.target();
  target.maxGridColumns = 11;
  app.api.FORONE_setup();
  const row = rowOf(target, 'Н234-YP');
  check('старый лист расширен ровно до 15 колонок', target.maxGridColumns === 15, target.maxGridColumns);
  check('заголовки новых служебных колонок установлены', target.getRange(1, 12, 1, 4).getValues()[0].join('|') === 'Остаток по источнику|Последняя операция|Обновлено|Расхождение');
  check('рабочий остаток старой строки сохранён', row && Number(row[4]) === 36, row && row[4]);
  check('резерв старой строки сохранён', row && Number(row[5]) === 2, row && row[5]);
  check('местоположение старой строки сохранено', row && row[7] === 'A' && row[8] === 'R1' && row[9] === 'B2', row && row.slice(7, 10));
  check('снимок исходного остатка установлен', row && Number(row[11]) === 36, row && row[11]);
}

group('2. Приход, расход, списание (сценарии 1-3 плана)');
{
  const app = makeApp();
  const first = post(app.api, [op({ operationId: 'op-in-1', type: 'in', qty: 5, comment: 'Поставка' })]);
  check('приход принят', first.ok === true && first.results[0].status === 'processed', first.results);
  check('приход: 36 + 5 = 41', Number(rowOf(app.target(), 'Н234-YP')[4]) === 41, rowOf(app.target(), 'Н234-YP')[4]);
  check('приход: изменение остатка положительное', first.results[0].delta === 5);

  const second = post(app.api, [op({ operationId: 'op-out-1', type: 'out', qty: 2, comment: 'Клиент А' })]);
  check('расход принят', second.results[0].status === 'processed');
  check('расход: 41 - 2 = 39', Number(rowOf(app.target(), 'Н234-YP')[4]) === 39);
  check('расход: изменение остатка отрицательное', second.results[0].delta === -2);

  const third = post(app.api, [op({ operationId: 'op-wo-1', type: 'writeoff', qty: 1, comment: 'Замер, ул. Розыбакиева' })]);
  check('списание на замер принято', third.results[0].status === 'processed');
  check('списание: 39 - 1 = 38', Number(rowOf(app.target(), 'Н234-YP')[4]) === 38);

  const rows = journalRows(app.journal());
  check('в журнале 3 записи (сценарий 12)', rows.length === 3, rows.length);
  check('все записи помечены «Обработано»', rows.every((r) => r[10] === 'Обработано'), rows.map((r) => r[10]));
  check('тип операции подписан по-русски', rows.some((r) => r[4] === 'Списание на замер'));
  check('в журнале записан остаток после операции', Number(rows[2][12]) === 38, rows[2][12]);
  check('в карточке позиции запомнен ID последней операции', String(rowOf(app.target(), 'Н234-YP')[12]) === 'op-wo-1');
  check('в карточке проставлено время обновления', String(rowOf(app.target(), 'Н234-YP')[13]).length > 8);
}

group('3. Недостаточный остаток и резерв (сценарий 4)');
{
  const app = makeApp();
  const bad = post(app.api, [op({ operationId: 'op-big', qty: 1000 })]);
  check('сверхлимитный расход отклонён', bad.ok === false && bad.results[0].code === 'INSUFFICIENT_STOCK', bad.results);
  check('остаток не изменился', Number(rowOf(app.target(), 'Н234-YP')[4]) === 36);
  check('в ответе понятное сообщение', /Недостаточно доступного остатка/.test(bad.results[0].message), bad.results[0].message);
  const rows = journalRows(app.journal());
  check('отклонение зафиксировано в журнале', rows.length === 1 && rows[0][10] === 'Отклонено' && /Недостаточно/.test(String(rows[0][11])), rows[0] && [rows[0][10], rows[0][11]]);

  app.target().getRange(rowIndexFor(app.target(), 'Н234-YP'), 6).setValue(30);
  const edge = post(app.api, [op({ operationId: 'op-7', qty: 7 })]);
  check('с резервом 30 расход 7 отклонён', edge.results[0].ok === false && /доступно 6/.test(edge.results[0].message), edge.results[0].message);
  const okSmall = post(app.api, [op({ operationId: 'op-6', qty: 6 })]);
  check('расход ровно доступного количества разрешён', okSmall.results[0].status === 'processed' && okSmall.results[0].stockAfter === 30, okSmall.results[0]);
  check('после отгрузки доступно 0', okSmall.results[0].availableAfter === 0);
  const incoming = post(app.api, [op({ operationId: 'op-in-2', type: 'in', qty: 4 })]);
  check('приход доступен даже при большом резерве', incoming.results[0].status === 'processed' && Number(rowOf(app.target(), 'Н234-YP')[4]) === 34);
}

group('4. Идемпотентность: повторная отправка той же операции (сценарий 5)');
{
  const app = makeApp();
  const a = post(app.api, [op({ operationId: 'op-dup', qty: 3 })]);
  const stockAfterFirst = Number(rowOf(app.target(), 'Н234-YP')[4]);
  const b = post(app.api, [op({ operationId: 'op-dup', qty: 3 })]);
  const c = post(app.api, [op({ operationId: 'op-dup', qty: 3 })]);
  check('первый запрос применён', a.results[0].status === 'processed');
  check('повтор возвращает ok и статус duplicate', b.ok === true && b.results[0].status === 'duplicate' && b.results[0].duplicate === true, b.results);
  check('при повторе остаток не изменился', Number(rowOf(app.target(), 'Н234-YP')[4]) === stockAfterFirst);
  check('в журнале одна строка на этот ID', journalRows(app.journal()).filter((r) => r[0] === 'op-dup').length === 1);
  check('третья отправка тоже безопасна', c.results[0].status === 'duplicate');
  const noId = post(app.api, [{ sku: 'Н234-YP', type: 'out', qty: 1 }]);
  check('операция без ID отклоняется', noId.ok === false && noId.results[0].code === 'NO_OPERATION_ID');
  const dupOtherQty = post(app.api, [op({ operationId: 'op-dup', qty: 99 })]);
  check('дубликат не применяется даже с другим количеством', dupOtherQty.results[0].status === 'duplicate' && Number(rowOf(app.target(), 'Н234-YP')[4]) === stockAfterFirst);
}

group('5. Пакетная отправка очереди и частичные ошибки');
{
  const app = makeApp();
  const batch = post(app.api, [
    op({ operationId: 'b1', type: 'in', qty: 10 }),
    op({ operationId: 'b2', sku: 'НЕТ-ТАКОГО', qty: 1 }),
    op({ operationId: 'b3', qty: 4, comment: 'Клиент Б' }),
    op({ operationId: 'b2', qty: 1 })
  ]);
  check('пакет обработан целиком (4 результата)', batch.results.length === 4, batch.results.length);
  check('счётчик применённых = 2', batch.applied === 2, batch.applied);
  check('артикул не найден -> SKU_NOT_FOUND', batch.results[1].code === 'SKU_NOT_FOUND');
  check('дубликат внутри пакета учтён', batch.results[3].status === 'duplicate');
  check('итоговый остаток: 36 + 10 - 4 = 42', Number(rowOf(app.target(), 'Н234-YP')[4]) === 42, rowOf(app.target(), 'Н234-YP')[4]);
  check('общий ok=false из-за отклонённой позиции', batch.ok === false);
  check('журнал: 3 строки (дубликат не записан повторно)', journalRows(app.journal()).length === 3, journalRows(app.journal()).length);
  const flat = post(app.api, [], { action: 'operation', operation: op({ operationId: 'single-1', type: 'in', qty: 1 }) });
  check('одиночная операция через operation:{} принимается', flat.results[0].status === 'processed');
  const empty = post(app.api, []);
  check('пустой пакет отклоняется', empty.ok === false && empty.code === 'EMPTY_BATCH');
  const broken = parseOutput(app.api.doPost({ parameter: {}, postData: { type: 'application/json', contents: '{' } }));
  check('битый JSON не роняет скрипт', broken.ok === false && broken.code === 'BAD_JSON', broken);
  const unknownSkuCase = post(app.api, [op({ operationId: 'u1', sku: 'н234-yp', qty: 1 })]);
  check('артикул ищется без учёта регистра', unknownSkuCase.results[0].status === 'processed', unknownSkuCase.results[0]);
}

group('6. Два устройства: нет двойного списания (сценарий 8)');
{
  const app = makeApp();
  const devA = post(app.api, [op({ operationId: 'dev-a-1', sku: 'К01-206N', qty: 5 })], { device: 'Телефон A', user: 'Сотрудник 1' });
  const devB = post(app.api, [op({ operationId: 'dev-b-1', sku: 'К01-206N', qty: 5 })], { device: 'Планшет B', user: 'Сотрудник 2' });
  check('первое устройство получило товар', devA.results[0].status === 'processed');
  check('второму не хватило (остаток 3)', devB.results[0].code === 'INSUFFICIENT_STOCK', devB.results[0]);
  check('итоговый остаток неотрицателен', Number(rowOf(app.target(), 'К01-206N')[4]) === 3);
  const rows = journalRows(app.journal());
  check('пользователь и устройство записаны', rows[0][7] === 'Сотрудник 1' && rows[0][8] === 'Телефон A', rows[0] && [rows[0][7], rows[0][8]]);
  check('отклонение второго устройства видно в журнале', rows.some((r) => r[10] === 'Отклонено'));
}

group('7. Слияние с исходным листом: ручные движения не затираются');
{
  const app = makeApp();
  post(app.api, [op({ operationId: 'op-m1', type: 'out', qty: 4 })]);
  check('до импорта рабочий остаток 32', Number(rowOf(app.target(), 'Н234-YP')[4]) === 32);

  app.api.syncForoneStock();
  check('импорт без изменений источника сохранил 32', Number(rowOf(app.target(), 'Н234-YP')[4]) === 32, rowOf(app.target(), 'Н234-YP')[4]);
  check('ложное расхождение не появилось', String(rowOf(app.target(), 'Н234-YP')[14] || '') === '', rowOf(app.target(), 'Н234-YP')[14]);

  const source = app.env.main.getSheetByName('Октябрь-Ноябрь');
  source.getRange(rowIndexFor(source, 'Н234-YP'), 5).setValue(40);
  const merged = app.api.syncForoneStock();
  const row = rowOf(app.target(), 'Н234-YP');
  check('дельта источника применена: 32 + 4 = 36', Number(row[4]) === 36, row[4]);
  check('новый снимок источника = 40', Number(row[11]) === 40);
  check('расхождение зафиксировано текстом', /Источник: 36 -> 40/.test(String(row[14]).replace(/→/g, '->')), row[14]);
  check('ID последней операции сохранён', String(row[12]) === 'op-m1');
  check('слияние вернуло список конфликтов', merged.conflicts.length === 1 && merged.conflicts[0].sku === 'Н234-YP', merged.conflicts);

  app.api.syncForoneStock();
  check('повторный импорт не накапливает дельту', Number(rowOf(app.target(), 'Н234-YP')[4]) === 36);

  source.getRange(rowIndexFor(source, 'Н234-YP'), 5).setValue(3);
  app.api.syncForoneStock();
  const negRow = rowOf(app.target(), 'Н234-YP');
  check('уход в минус клампится в 0', Number(negRow[4]) === 0, negRow[4]);
  check('конфликт помечен как РАСХОЖДЕНИЕ', /РАСХОЖДЕНИЕ/.test(String(negRow[14])), negRow[14]);
  const before = errorRows(app.errors()).length;
  check('конфликт попал в FORONE_Ошибки', errorRows(app.errors()).some((r) => r[6] === 'STOCK_CONFLICT' && r[3] === 'Н234-YP'), errorRows(app.errors()));
  app.api.syncForoneStock();
  check('тот же конфликт не дублируется в журнале ошибок', errorRows(app.errors()).length === before, [before, errorRows(app.errors()).length]);

  app.target().getRange(rowIndexFor(app.target(), 'Н234-YP'), 6).setValue(5);
  source.getRange(rowIndexFor(source, 'Н234-YP'), 2).setValue('Панель Natural Oak (новая редакция)');
  app.api.syncForoneStock();
  check('название обновлено из источника', String(rowOf(app.target(), 'Н234-YP')[1]).includes('новая редакция'));
  check('резерв не превышает остаток после слияния', Number(rowOf(app.target(), 'Н234-YP')[5]) === Math.min(5, Number(rowOf(app.target(), 'Н234-YP')[4])), rowOf(app.target(), 'Н234-YP').slice(4, 6));

  const keep = makeApp();
  keep.target().getRange(rowIndexFor(keep.target(), 'Н234-YP'), 6).setValue(8);
  keep.target().getRange(rowIndexFor(keep.target(), 'Н234-YP'), 7).setValue('Алматы');
  keep.target().getRange(rowIndexFor(keep.target(), 'Н234-YP'), 8).setValue('A-03');
  post(keep.api, [op({ operationId: 'keep-1', type: 'out', qty: 2 })]);
  keep.api.syncForoneStock();
  const keptRow = rowOf(keep.target(), 'Н234-YP');
  check('резерв сохранён при слиянии', Number(keptRow[5]) === 8, keptRow[5]);
  check('место хранения сохранено при слиянии', String(keptRow[7]) === 'A-03', keptRow[7]);
  check('операционный остаток учтён (36 - 2)', Number(keptRow[4]) === 34, keptRow[4]);

  const gone = makeApp();
  gone.post_out = post(gone.api, [op({ operationId: 'gone-1', sku: 'К01-206N', qty: 3 })]);
  const goneSource = gone.env.main.getSheetByName('Октябрь-Ноябрь');
  goneSource.getRange(rowIndexFor(goneSource, 'К01-206N'), 1).setValue('');
  gone.api.syncForoneStock();
  const orphan = rowOf(gone.target(), 'К01-206N');
  check('позиция, исчезнувшая из источника, сохранена', orphan && Number(orphan[4]) === 5, orphan);
  check('на неё поставлена пометка', /Нет в источнике/.test(String(orphan[14])), orphan && orphan[14]);
  check('расход по исчезнувшей позиции не потерялся', String(orphan[12]) === 'gone-1', orphan && orphan[12]);
}

group('7b. Дубли одного артикула и переименования (данные FORONE)');
{
  // Реальная ситуация: H234-YP встречается и как лувер, и как панель.
  const dupSource = [
    ['Артикул', 'Название', 'Категория', 'Длина', 'Остаток на складе'],
    ['H234-YP', 'Лувер 226YHB', 'Лувер', '3000', 15],
    ['H234-YP', 'БП Однотонная глянец', 'Панель', '3000', 45]
  ];
  const dup = makeApp({ sourceRows: dupSource });
  check('обе позиции с одним артикулом импортированы', rowOf(dup.target(), 'H234-YP') && dup.target().getDataRange().getValues().slice(1).filter((r) => String(r[0]).trim() === 'H234-YP').length === 2, dup.target().getDataRange().getValues());

  const byCategory = post(dup.api, [Object.assign(op({ operationId: 'dup-1', sku: 'H234-YP', type: 'out', qty: 5 }), { category: 'Панель', name: 'БП Однотонная глянец' })]);
  check('операция с названием уходит в нужную позицию', byCategory.results[0].matchedName === 'БП Однотонная глянец', byCategory.results[0]);
  check('вторая позиция с тем же артикулом не тронута', Number(rowOf(dup.target(), 'H234-YP')[4]) === 15);

  const auto = post(dup.api, [{ operationId: 'dup-2', sku: 'H234-YP', type: 'out', qty: 20 }]);
  check('без названия выбирается позиция с достаточным остатком', auto.results[0].matchedName === 'БП Однотонная глянец', auto.results[0]);
  check('ответ помечает неоднозначный артикул', auto.results[0].ambiguous === true);
  const exactName = post(dup.api, [{ operationId: 'dup-3', sku: 'H234-YP', type: 'out', qty: 1, name: 'Лувер 226YHB' }]);
  check('точное название бьёт по другой позиции', exactName.results[0].matchedName === 'Лувер 226YHB' && exactName.results[0].stockAfter === 14, exactName.results[0]);

  // Повторный импорт не должен схлопывать строки и терять рабочий остаток.
  dup.api.syncForoneStock();
  const stillTwo = dup.target().getDataRange().getValues().slice(1).filter((r) => String(r[0]).trim() === 'H234-YP');
  check('повторный импорт сохранил обе строки', stillTwo.length === 2, stillTwo.length);
  check('рабочие остатки после операций сохранены', stillTwo.map((r) => Number(r[4])).sort((x, y) => x - y).join() === '14,20', stillTwo.map((r) => r[4]));

  // Переименование в источнике: строка сохраняется, остаток и журнал не теряются.
  const renameSource = [
    ['Артикул', 'Название', 'Категория', 'Длина', 'Остаток на складе'],
    ['Н318-SM', 'Бамбуковая панель Smoky Grey', 'Панель', '3000', 14]
  ];
  const ren = makeApp({ sourceRows: renameSource });
  post(ren.api, [op({ operationId: 'ren-1', sku: 'Н318-SM', type: 'out', qty: 4 })]);
  const rsource = ren.env.main.getSheetByName('Октябрь-Ноябрь');
  rsource.getRange(rowIndexFor(rsource, 'Н318-SM'), 2).setValue('Панель Smoky Grey 2.0');
  const renameResult = ren.api.syncForoneStock();
  const renamedRow = rowOf(ren.target(), 'Н318-SM');
  check('переименованная позиция не задублирована', ren.target().getDataRange().getValues().slice(1).filter((r) => String(r[0]).trim() === 'Н318-SM').length === 1);
  check('новый название подтянуто из источника', String(renamedRow[1]) === 'Панель Smoky Grey 2.0', renamedRow[1]);
  check('рабочий остаток сохранён при переименовании', Number(renamedRow[4]) === 10, renamedRow[4]);
  check('журнал операции сохранён при переименовании', String(renamedRow[12]) === 'ren-1', renamedRow[12]);
  check('переименование учтено в отчёте слияния', renameResult.renamed === 1, renameResult.renamed);
}

group('7c. Повтор операции, ранее отклонённой складом');
{
  const app = makeApp();
  const target = app.target();
  const tooMuch = post(app.api, [op({ operationId: 'retry-1', qty: 500 })]);
  check('расход больше остатка отклонён', tooMuch.results[0].ok === false && tooMuch.results[0].code === 'INSUFFICIENT_STOCK', tooMuch.results[0].code);
  check('отклонение не тронуло остаток', Number(rowOf(target, 'Н234-YP')[4]) === 36, rowOf(target, 'Н234-YP')[4]);
  check('в журнале есть строка «Отклонено»', journalRows(app.journal()).slice(-1)[0][10] === 'Отклонено', journalRows(app.journal()).slice(-1)[0][10]);

  // Кладовщик довёз товар на складе — на телефоне жмут «Отправить снова».
  target.getRange(rowIndexFor(target, 'Н234-YP'), 5).setValue(520);
  const second = post(app.api, [op({ operationId: 'retry-1', qty: 500 })]);
  check('тот же ID принят после устранения причины', second.results[0].ok === true && second.results[0].status === 'processed', second.results[0]);
  check('сервер пометил ответ как повтор после отклонения', second.results[0].retriedAfterRejection === 1, second.results[0].retriedAfterRejection);
  check('остаток изменён ровно один раз', Number(rowOf(target, 'Н234-YP')[4]) === 20, rowOf(target, 'Н234-YP')[4]);
  const statuses = journalRows(app.journal()).slice(-2).map((r) => r[10]);
  check('в журнале обе попытки', statuses.join() === 'Отклонено,Обработано', statuses);

  // Применённый ID защищён от случайного повтора.
  const third = post(app.api, [op({ operationId: 'retry-1', qty: 20 })]);
  check('повтор применённой операции — дубликат', third.results[0].duplicate === true, third.results[0].code);
  check('дубликат не изменил остаток', Number(rowOf(target, 'Н234-YP')[4]) === 20, rowOf(target, 'Н234-YP')[4]);

  // Тот же ID, но другие данные — это не повтор, а подмена: не применяем.
  const swapped = post(app.api, [op({ operationId: 'retry-1', qty: 7 })]);
  check('повтор ID с другим количеством не применяется', swapped.results[0].status === 'duplicate' && Number(rowOf(target, 'Н234-YP')[4]) === 20, swapped.results[0]);
}

group('8. Доступ: секретный ключ и список пользователей');
{
  const app = makeApp({ sharedSecret: 'secret-123' });
  const wrong = post(app.api, [op({ operationId: 'x1', qty: 1 })], { key: 'nope' });
  check('без ключа запрос отклонён', wrong.ok === false && wrong.code === 'AUTH', wrong);
  const missing = post(app.api, [op({ operationId: 'x2', qty: 1 })]);
  check('пустой ключ отклонён', missing.code === 'AUTH');
  const right = post(app.api, [op({ operationId: 'x3', qty: 1, type: 'in' })], { key: 'secret-123' });
  check('с верным ключом операция проходит', right.results[0].status === 'processed', right);
  const ping = parseOutput(app.api.doGet(getEvent({})));
  check('ping без ключа подтверждает связь, но скрывает данные', ping.ok === true && ping.restricted === true && !ping.sheets, ping);
  const pingKey = parseOutput(app.api.doGet(getEvent({ key: 'secret-123' })));
  check('ping с ключом отдаёт полную диагностику', pingKey.ok === true && !pingKey.restricted && pingKey.auth.secretRequired === true && pingKey.sheets['FORONE_Остатки'] === 3, pingKey.sheets);
  const stockNoKey = parseOutput(app.api.doGet(getEvent({ action: 'stock' })));
  check('выдача остатков без ключа закрыта', stockNoKey.ok === false && stockNoKey.code === 'AUTH');
  const stockKey = parseOutput(app.api.doGet(getEvent({ action: 'stock', key: 'secret-123' })));
  check('выдача остатков с ключом работает', stockKey.ok === true && stockKey.count === 3, stockKey.count);
  check('в выдаче доступно = остаток - резерв', stockKey.products[0].available === stockKey.products[0].stock - stockKey.products[0].reserve);

  const acl = makeApp({ allowedUsers: 'сотрудник 1,кладовщик' });
  check('разрешённый пользователь проходит', post(acl.api, [op({ operationId: 'a1', qty: 1 })], { user: 'Сотрудник 1' }).results[0].status === 'processed');
  const denied = post(acl.api, [op({ operationId: 'a2', qty: 1 })], { user: 'Гость' });
  check('чужой пользователь отклонён', denied.ok === false && denied.code === 'FORBIDDEN_USER', denied);
}

group('9. Занятость сервера и отложенная повторная отправка');
{
  const app = makeApp();
  app.env.sandbox.__lockBusy = true;
  const busy = post(app.api, [op({ operationId: 'busy-1', qty: 1 })]);
  check('при занятом локе ответ BUSY + retry', busy.ok === false && busy.code === 'BUSY' && busy.retry === true, busy);
  app.env.sandbox.__lockBusy = false;
  const after = post(app.api, [op({ operationId: 'busy-1', qty: 1 })]);
  check('после освобождения та же операция применяется', after.results[0].status === 'processed');
  check('после BUSY остаток изменился один раз', Number(rowOf(app.target(), 'Н234-YP')[4]) === 35, rowOf(app.target(), 'Н234-YP')[4]);
}

group('10. Проверка соединения (doGet ping)');
{
  const app = makeApp();
  post(app.api, [op({ operationId: 'p1', qty: 1, type: 'in' })]);
  const ping = parseOutput(app.api.doGet(getEvent({ action: 'ping' })));
  check('ping отвечает ok и версией', ping.ok === true && ping.version === '2.0.0', ping.version);
  check('ping показывает количество строк листов', ping.sheets['FORONE_Остатки'] === 3 && ping.sheets['FORONE_Операции'] === 1, ping.sheets);
  check('ping отдаёт время последней синхронизации', !!ping.lastSync);
  check('ping сообщает ID и URL таблицы', ping.spreadsheet.id === SHEET_ID && /docs\.google\.com/.test(ping.spreadsheet.url), ping.spreadsheet);
  check('ping считает незакрытые расхождения', ping.openConflicts === 0, ping.openConflicts);
  const ops = parseOutput(app.api.doGet(getEvent({ action: 'operations', sku: 'Н234-YP' })));
  check('история операций по артикулу доступна', ops.ok === true && ops.operations[0].operationId === 'p1', ops.operations);
  const unknown = parseOutput(app.api.doGet(getEvent({ action: 'нет-такого' })));
  check('неизвестное действие не роняет doGet', unknown.ok === true || unknown.ok === false);
}

group('11. Внутренние автотесты самого скрипта');
{
  const app = makeApp();
  const result = app.api.FORONE_selfTest();
  check('FORONE_selfTest: ни одного провала', Array.isArray(result) && result.length === 0, result);
}

console.log('\n' + '-'.repeat(64));
console.log('Итог: ' + passed + ' пройдено, ' + failed + ' провалено');
if (failed) {
  console.log('\nПроваленные проверки:');
  failures.forEach((f) => console.log('  - ' + f));
  process.exitCode = 1;
}
