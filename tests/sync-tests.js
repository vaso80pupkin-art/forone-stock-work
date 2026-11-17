/**
 * Тесты клиентского модуля очереди операций (sync-queue.js).
 * Эмулируют телефон: офлайн, обрыв связи посередине отправки, ответы сервера.
 *
 * Запуск: node /home/ubuntu/work/tests/sync-tests.js
 */
'use strict';

const path = require('path');
const vm = require('vm');

const MODULE = path.join(__dirname, '..', 'sync-queue.js');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) { passed += 1; console.log('  \u001b[32m+\u001b[0m ' + name); }
  else {
    failed += 1;
    failures.push(name + (detail !== undefined ? ' -> ' + JSON.stringify(detail) : ''));
    console.log('  \u001b[31mx\u001b[0m ' + name + (detail !== undefined ? '\n      ' + JSON.stringify(detail) : ''));
  }
}
function group(title) { console.log('\n\u001b[1m' + title + '\u001b[0m'); }

function makeHost(initialState) {
  const host = {
    state: () => host._state,
    _state: initialState || { products: [], operations: [], queue: [], sync: {} },
    save() { host.saved = (host.saved || 0) + 1; },
    render() {},
    element() { return null; },
    notify() {},
    updateConnectionLabel() {},
    onStockUpdated() { host.stockUpdateEvents = (host.stockUpdateEvents || 0) + 1; },
    onSynced(item, result) { (host.syncedEvents = host.syncedEvents || []).push([item.operationId, result.stockAfter]); },
    onFlushed(info) { (host.flushEvents = host.flushEvents || []).push(info); }
  };
  return host;
}

function loadSync(options) {
  const opts = options || {};
  const sandbox = {
    console,
    setTimeout: opts.setTimeout || setTimeout,
    clearTimeout: opts.clearTimeout || clearTimeout,
    setInterval: opts.setInterval || setInterval,
    clearInterval: opts.clearInterval || clearInterval,
    Date, Math, JSON, Number, String, Array, Object, Boolean, RegExp, Error, isNaN, isFinite, parseInt, parseFloat, Uint8Array, Promise,
    fetch: opts.fetch,
    localStorage: {
      data: {},
      getItem(key) { return this.data[key] === undefined ? null : this.data[key]; },
      setItem(key, value) { this.data[key] = String(value); },
      removeItem(key) { delete this.data[key]; }
    },
    document: undefined,
    navigator: { onLine: opts.online === undefined ? true : opts.online }
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  const source = require('fs').readFileSync(MODULE, 'utf8');
  vm.runInContext(source, context, { filename: MODULE });
  return { sync: sandbox.FORONESync, sandbox };
}

const baseConfig = {
  enabled: true,
  url: 'https://script.google.com/macros/s/AKfycb-test/exec',
  key: 'test-key',
  user: 'Сотрудник 1',
  deviceLabel: 'Телефон склада',
  autoSend: false,
  pullAfterSend: false
};

function operation(fields) {
  return Object.assign({
    id: 'op-20261117-120000-007-abc1',
    productId: 'p-001',
    sku: 'Н234-YP',
    name: 'Бамбуковая панель Natural Oak',
    category: 'Панель',
    type: 'out',
    qty: 2,
    comment: 'Клиент А',
    createdAt: new Date().toISOString(),
    stockAfter: 34
  }, fields || {});
}

function jsonResponse(body, status = 200) {
  return Promise.resolve({ ok: status < 400, status, text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)) });
}

// ===========================================================================
group('1. Идентификатор операции и метка устройства');
{
  const { sync } = loadSync();
  const ids = new Set();
  for (let i = 0; i < 20000; i += 1) ids.add(sync.makeOperationId());
  check('20 000 ID за одну секунду уникальны', ids.size === 20000, ids.size);
  const sample = sync.makeOperationId(new Date('2026-11-17T14:42:10'));
  check('формат op-ГГГГММДД-ЧЧММСС-СЕЕЕЕ-хххх', /^op-\d{8}-\d{6}-\d{4}-[0-9a-z]{4}$/.test(sample), sample);
  check('ID помещается в 64 символа', sample.length <= 64);
  const { sync: sync2 } = loadSync();
  const device = sync2.makeDeviceId();
  const again = sync2.makeDeviceId();
  check('метка устройства постоянна для телефона', device === again, device);
  check('метка начинается с dev-', /^dev-/.test(device));
}

group('2. Очередь: постановка и учёт статусов');
{
  const { sync } = loadSync();
  const host = makeHost({ products: [{ id: 'p-001', sku: 'Н234-YP', stock: 36, reserved: 0 }], operations: [], queue: [], sync: Object.assign({}, baseConfig, { enabled: false }) });
  sync.attach(host);
  const op = operation();
  host._state.operations.push(op);
  sync.enqueue(op);
  check('операция попала в очередь', sync.queue().length === 1);
  check('очередь хранит дельту −2', sync.queue()[0].delta === -2, sync.queue()[0].delta);
  check('при выключенной синхронизации статус «локально»', host._state.operations[0].syncStatus === 'local');
  check('признак незакрытой позиции работает', sync.hasPendingFor('н234-yp') === true && sync.hasPendingFor('ДРУГОЙ') === false);
  const summary = sync.summary();
  check('сводка: 1 в ожидании', summary.waiting === 1 && summary.enabled === false, summary);

  sync.updateSettings({ enabled: true, autoSend: false });
  const second = operation({ id: 'op-2', type: 'in', qty: 5 });
  host._state.operations.push(second);
  sync.enqueue(second);
  check('после включения статус «в очереди»', host._state.operations[1].syncStatus === 'queued');
  check('приход даёт положительную дельту', sync.queue()[1].delta === 5);
  check('несинхронизированные операции смены: 0 (обе в очереди)', sync.unsyncedShiftOperations().length === 0);

  host._state.operations.push(operation({ id: 'op-old', type: 'writeoff', qty: 1 }));
  check('старая операция смены найдена для доотправки', sync.unsyncedShiftOperations().map((o) => o.id).join() === 'op-old');
  check('enqueueAllUnsynced ставит её в очередь', sync.enqueueAllUnsynced() === 1 && sync.queue().length === 3);
}

group('3. Формирование пакета для Apps Script');
{
  const { sync } = loadSync();
  const host = makeHost({ products: [], operations: [], queue: [], sync: Object.assign({}, baseConfig, { autoSend: false }) });
  sync.attach(host);
  host._state.operations.push(operation({ id: 'op-a' }));
  host._state.operations.push(operation({ id: 'op-b', type: 'in', qty: 3, sku: 'К01-206N' }));
  sync.enqueue(host._state.operations[0]);
  sync.enqueue(host._state.operations[1]);
  const payload = sync.buildBatchPayload(sync.queue());
  check('action = operations', payload.action === 'operations');
  check('ключ доступа передаётся', payload.key === 'test-key');
  check('пользователь и устройство подписаны', payload.user === 'Сотрудник 1' && payload.device === 'Телефон склада');
  check('в пакете 2 операции', payload.operations.length === 2);
  check('серверу не шлются локальные поля', !('productId' in payload.operations[0]) && !('stockAfter' in payload.operations[0]), payload.operations[0]);
  check('у каждой операции есть operationId', payload.operations.every((item) => /^op-/.test(item.operationId)));
  check('URL нормализуется', sync.normalizeUrl('script.google.com/x//') === 'https://script.google.com/x');
}

group('4. Успешная отправка и разбор ответа');
(async () => {
  const calls = [];
  const { sync } = loadSync({
    fetch: (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) });
      return jsonResponse({
        ok: true,
        results: calls[0].body.operations.map((item, index) => ({
          operationId: item.operationId, ok: true, status: 'processed', sku: item.sku,
          stockBefore: 36, stockAfter: 34 - index, availableAfter: 34 - index, message: 'Операция записана'
        }))
      });
    }
  });
  const host = makeHost({ products: [{ id: 'p-001', sku: 'Н234-YP', stock: 34, reserved: 0 }], operations: [], queue: [], sync: Object.assign({}, baseConfig, { autoSend: false }) });
  sync.attach(host);
  host._state.operations.push(operation({ id: 'op-ok-1' }));
  sync.enqueue(host._state.operations[0]);
  const result = await sync.flush('test');
  check('отправка прошла', result.ok === true && result.applied === 1, result);
  check('очистка очереди после успеха', sync.queue().length === 0, sync.queue().length);
  check('статус операции — синхронизировано', host._state.operations[0].syncStatus === 'synced');
  check('время последней успешной отправки записано', sync.config().lastSuccess > 0);
  check('запрос POST, текст в теле', calls[0].options.method === 'POST' && /Content-Type/.test(JSON.stringify(calls[0].options.headers)));
  check('без credentials (куки Google не нужны)', calls[0].options.credentials === 'omit');
  check('хост уведомлён о синхронизации', (host.syncedEvents || []).length === 1 && host.syncedEvents[0][1] === 34);

  const repeated = await sync.flush('test-repeat');
  check('повторный flush на пустой очереди ничего не шлёт', repeated.skipped === true && calls.length === 1);
})();

group('5. Идемпотентность на клиенте: сервер ответил duplicate');
(async () => {
  const { sync } = loadSync({
    fetch: (url, options) => {
      const body = JSON.parse(options.body);
      return jsonResponse({ ok: true, results: body.operations.map((item) => ({ operationId: item.operationId, ok: true, status: 'duplicate', duplicate: true, message: 'Уже записана' })) });
    }
  });
  const host = makeHost({ products: [], operations: [], queue: [], sync: Object.assign({}, baseConfig, { autoSend: false }) });
  sync.attach(host);
  host._state.operations.push(operation({ id: 'op-dup-client' }));
  sync.enqueue(host._state.operations[0]);
  const result = await sync.flush('dup');
  check('duplicate считается успехом', result.ok === true && sync.queue().length === 0, result);
  check('операция помечена синхронизированной', host._state.operations[0].syncStatus === 'synced');
})();

group('6. Отклонение сервером (недостаточно остатка, нет артикула)');
(async () => {
  const { sync } = loadSync({
    fetch: (url, options) => {
      const body = JSON.parse(options.body);
      return jsonResponse({
        ok: false,
        results: [
          { operationId: body.operations[0].operationId, ok: false, status: 'rejected', code: 'INSUFFICIENT_STOCK', message: 'Недостаточно доступного остатка: доступно 1 шт.' },
          body.operations[1] ? { operationId: body.operations[1].operationId, ok: false, status: 'rejected', code: 'SKU_NOT_FOUND', message: 'Артикул «НЕТ» не найден' } : null
        ].filter(Boolean)
      });
    }
  });
  const host = makeHost({ products: [], operations: [], queue: [], sync: Object.assign({}, baseConfig, { autoSend: false }) });
  sync.attach(host);
  host._state.operations.push(operation({ id: 'op-no-stock' }));
  host._state.operations.push(operation({ id: 'op-no-sku', sku: 'НЕТ' }));
  sync.enqueue(host._state.operations[0]);
  sync.enqueue(host._state.operations[1]);
  const result = await sync.flush('reject');
  check('отклонённые не считаются доставкой', result.ok === false && result.problems.length === 2, result);
  const item = sync.findItem('op-no-stock');
  check('статус «отклонено» (не бесконечный повтор)', item.status === 'rejected', item);
  check('сохранено сообщение склада', /Недостаточно доступного/.test(item.lastError), item.lastError);
  check('операция помечена отклонённой', host._state.operations[0].syncStatus === 'rejected');
  check('отклонённое не уходит в автоматический повтор', sync.eligibleItems().length === 0, sync.eligibleItems());
  check('отклонённые видны в пилюле', sync.summary().pendingTotal === 2, sync.summary().pendingTotal);
  check('сводка считает отклонённые', sync.summary().counts.rejected === 2, sync.summary().counts);
  check('после отклонения позиция всё ещё «занята»', sync.hasPendingFor('Н234-YP') === false || sync.hasPendingFor('Н234-YP') === true);

  const discarded = sync.discard('op-no-stock');
  check('отклонённую операцию можно убрать из очереди', discarded && sync.queue().length === 1);
})();

group('7. Офлайн и обрыв связи (сценарии 6-7 плана)');
(async () => {
  // 7.1 Нет интернета: flush не стреляет запросами, статусы остаются «в очереди»
  let requests = 0;
  const offline = loadSync({ online: false, fetch: () => { requests += 1; return jsonResponse({ ok: true, results: [] }); } });
  const offlineHost = makeHost({ products: [], operations: [], queue: [], sync: Object.assign({}, baseConfig, { autoSend: false }) });
  offline.sync.attach(offlineHost);
  offlineHost.operations_push = operation({ id: 'op-offline' });
  offlineHost._state.operations.push(offlineHost.operations_push);
  offline.sync.enqueue(offlineHost.operations_push);
  const offlineResult = await offline.sync.flush('offline');
  check('без интернета отправка пропущена', offlineResult.skipped === true && offlineResult.reason === 'offline', offlineResult);
  check('запросов не было', requests === 0);
  check('операция осталась в очереди', offline.sync.queue().length === 1 && offline.sync.queue()[0].status === 'queued');
  check('сводка показывает ожидание', offline.sync.summary().waiting === 1);

  // 7.2 Запрос «ушёл, но ответа нет» (обрыв после записи на сервере)
  const lost = loadSync({ fetch: () => Promise.reject(new Error('network failure')) });
  const lostHost = makeHost({ products: [], operations: [], queue: [], sync: Object.assign({}, baseConfig, { autoSend: false }) });
  lost.sync.attach(lostHost);
  lostHost._state.operations.push(operation({ id: 'op-lost' }));
  lost.sync.enqueue(lostHost._state.operations[0]);
  const lostResult = await lost.sync.flush('lost');
  check('сетевая ошибка обработана', lostResult.ok === false, lostResult);
  check('операция НЕ удалена из очереди', lost.sync.queue().length === 1);
  check('увеличен счётчик попыток', lost.sync.findItem('op-lost').attempts === 1);
  check('назначена пауза перед повтором', lost.sync.findItem('op-lost').nextTryAt > Date.now());
  check('записана причина ошибки', /Не удалось связаться|Нет интернета/.test(lost.sync.config().lastErrorText), lost.sync.config().lastErrorText);
  check('локальный статус — ошибка отправки', lostHost._state.operations[0].syncStatus === 'error');
  const failEvent = (lostHost.flushEvents || []).slice(-1)[0];
  check('приложение извещено о сбое и перерисует журнал', failEvent && failEvent.failed === 1 && /связ|интернет/i.test(failEvent.message), failEvent);
  check('пилюля учитывает сетевую ошибку', lost.sync.summary().pendingTotal === 1, lost.sync.summary().pendingTotal);

  // 7.3 Интернет появился — resend с тем же ID, сервер ответил duplicate
  const back = loadSync({
    fetch: (url, options) => {
      const body = JSON.parse(options.body);
      return jsonResponse({ ok: true, results: body.operations.map((item) => ({ operationId: item.operationId, ok: true, status: 'duplicate', duplicate: true })) });
    }
  });
  const backHost = makeHost({ products: [], operations: [], queue: [], sync: Object.assign({}, baseConfig, { autoSend: false }) });
  back.sync.attach(backHost);
  backHost._state.operations.push(operation({ id: 'op-lost' }));
  back.sync.enqueue(backHost._state.operations[0]);
  back.sync.findItem('op-lost').status = 'error';
  back.sync.findItem('op-lost').nextTryAt = 0;
  const backResult = await back.sync.retryNow();
  check('после восстановления связи очередь ушла', backResult.ok === true && back.sync.queue().length === 0, backResult);
  check('дубль на сервере не привёл к повторному расходу', backHost._state.operations[0].syncStatus === 'synced');

  // 7.4 Сервер занят (BUSY) — остаёмся в очереди и повторим
  const busy = loadSync({ fetch: () => jsonResponse({ ok: false, code: 'BUSY', message: 'Сервер занят', retry: true }) });
  const busyHost = makeHost({ products: [], operations: [], queue: [], sync: Object.assign({}, baseConfig, { autoSend: false }) });
  busy.sync.attach(busyHost);
  busyHost._state.operations.push(operation({ id: 'op-busy' }));
  busy.sync.enqueue(busyHost._state.operations[0]);
  await busy.sync.flush('busy');
  check('BUSY не теряет операцию', busy.sync.queue().length === 1 && busy.sync.findItem('op-busy').status === 'queued', busy.sync.queue());
})();

group('8. Ответ не-JSON: типичные ошибки публикации');
(async () => {
  const html = loadSync({ fetch: () => jsonResponse('<html><head><title>Google Sheets</title></head><body>ok</body></html>', 200) });
  const htmlHost = makeHost({ products: [], operations: [], queue: [], sync: Object.assign({}, baseConfig, { autoSend: false }) });
  html.sync.attach(htmlHost);
  htmlHost._state.operations.push(operation({ id: 'op-html' }));
  html.sync.enqueue(htmlHost._state.operations[0]);
  const result = await html.sync.flush('html');
  check('HTML-ответ не ломает приложение', result.ok === false, result);
  check('подсказка про /exec', /exec/.test(html.sync.config().lastErrorText), html.sync.config().lastErrorText);
  check('операция осталась в очереди', html.sync.queue().length === 1);
  check('страница входа опознаётся', /«Все, у кого есть ссылка»/.test(html.sync.describeTransportFailure('<html>To view or access this project, you need to sign in</html>', 200)), html.sync.describeTransportFailure('<html>To view or access this project, you need to sign in</html>', 200));
  check('404 опознан', /404/.test(html.sync.describeTransportFailure('nope', 404)));

  const auth = loadSync({ fetch: () => jsonResponse({ ok: false, code: 'AUTH', message: 'Неверный или отсутствует ключ доступа' }) });
  const authHost = makeHost({ products: [], operations: [], queue: [], sync: Object.assign({}, baseConfig, { autoSend: false, key: 'wrong' }) });
  auth.sync.attach(authHost);
  authHost._state.operations.push(operation({ id: 'op-auth' }));
  auth.sync.enqueue(authHost._state.operations[0]);
  const authResult = await auth.sync.flush('auth');
  check('ошибку ключа видно пользователю', authResult.ok === false && /ключ/i.test(authResult.message), authResult);
  check('при ошибке ключа очередь сохранена', auth.sync.queue().length === 1);
})();

group('9. Частичный ответ сервера и защита от «потери» операции');
{
  const { sync } = loadSync();
  const host = makeHost({ products: [], operations: [], queue: [], sync: Object.assign({}, baseConfig, { autoSend: false }) });
  sync.attach(host);
  host._state.operations.push(operation({ id: 'op-missing-result' }));
  sync.enqueue(host._state.operations[0]);
  const applied = sync.findItem('op-missing-result');
  const ok = (function () {
    // воспроизводим внутреннюю логику: сервер вернул пустой results
    return sync.interpretResponse(JSON.stringify({ ok: true, results: [] }));
  }());
  check('пустой results распознаётся как ответ', ok !== null && ok.results.length === 0);
  check('заготовленная операция имеет id для повтора', applied.operationId === 'op-missing-result');
  check('лабa повторов растёт и ограничена', sync.retryDelay(0) === 10000 && sync.retryDelay(3) === 600000 && sync.retryDelay(99) === 1800000);
}

group('10. Отмена операции до и после отправки (сценарии 9-10 плана)');
{
  const { sync } = loadSync();
  const host = makeHost({ products: [], operations: [], queue: [], sync: Object.assign({}, baseConfig, { autoSend: false }) });
  sync.attach(host);
  host._state.operations.push(operation({ id: 'op-cancel' }));
  sync.enqueue(host._state.operations[0]);
  const removed = sync.cancelQueued('op-cancel');
  check('несохранённую операцию можно отменить', removed && sync.queue().length === 0);
  check('локальная запись помечена отменённой', host._state.operations[0].syncStatus === 'cancelled');

  const reverse = sync.reversePayload({ operationId: 'op-sent', sku: 'Н234-YP', name: 'Панель', category: 'Панель', type: 'out', qty: 4, comment: 'Клиент А' });
  check('для расхода генерируется приход-компенсация', reverse.type === 'in' && reverse.qty === 4);
  check('в комментарии видна отменяемая операция', reverse.comment.indexOf('Отмена op-sent') === 0, reverse.comment);
  check('у компенсации новый уникальный ID', /^op-/.test(reverse.operationId) && reverse.operationId !== 'op-sent');
  const reverseIn = sync.reversePayload({ operationId: 'op-2', sku: 'X', type: 'in', qty: 7 });
  check('для прихода генерируется возврат', reverseIn.type === 'out' && reverseIn.qty === 7);
  const reverseWriteoff = sync.reversePayload({ operationId: 'op-3', sku: 'X', type: 'writeoff', qty: 2 });
  check('для списания — возврат на склад', reverseWriteoff.type === 'in');
}

group('10b. Дубль артикула в каталоге (реальные данные FORONE)');
{
  const { sync } = loadSync();
  const duplicateProducts = [
    { id: 'p-louver', sku: 'H234-YP', name: 'Лувер 226YHB', category: 'Лувер', stock: 15, reserved: 0 },
    { id: 'p-panel', sku: 'H234-YP', name: 'БП Однотонная глянец', category: 'Панель', stock: 45, reserved: 0 },
    { id: 'p-other', sku: 'K01-135X', name: 'Лувер 128CHBSIZE', category: 'Лувер', stock: 24, reserved: 0 }
  ];
  const host = makeHost({ products: JSON.parse(JSON.stringify(duplicateProducts)), operations: [], queue: [], sync: Object.assign({}, baseConfig, { autoSend: false }) });
  sync.attach(host);

  const panelOperation = operation({ id: 'op-dup-panel', sku: 'H234-YP', name: 'БП Однотонная глянец', category: 'Панель', productId: 'p-panel', qty: 7 });
  host._state.operations.push(panelOperation);
  sync.enqueue(panelOperation);
  const item = sync.findItem('op-dup-panel');
  check('очередь помнит локальный id позиции', item.productId === 'p-panel', item.productId);
  check('позиция определяется по артикулу и названию', sync.resolveProduct(item).id === 'p-panel', sync.resolveProduct(item));

  const ambiguous = sync.resolveProduct({ sku: 'H234-YP', name: 'Позиция которой нет', category: '' });
  check('при неизвестном названии дубля позиция не угадывается (защита от порчи остатков)', ambiguous === null, ambiguous);
  check('уникальный артикул находится без названия', sync.resolveProduct({ sku: 'k01-135x', name: '', category: '' }).id === 'p-other');

  check('защита распространяется только на свою позицию', sync.hasPendingFor(host._state.products[1]) === true && sync.hasPendingFor(host._state.products[0]) === false);
  check('старый вызов по строке артикула продолжает работать', sync.hasPendingFor('H234-YP') === true && sync.hasPendingFor('K01-135X') === false);

  const merged = sync.mergeServerStock(host._state, [
    { sku: 'H234-YP', name: 'Лувер 226YHB', category: 'Лувер', stock: 11, reserve: 0 },
    { sku: 'H234-YP', name: 'БП Однотонная глянец', category: 'Панель', stock: 45, reserve: 0 }
  ], sync.pendingProjections());
  const louver = host._state.products.find((p) => p.id === 'p-louver');
  const panel = host._state.products.find((p) => p.id === 'p-panel');
  check('серверная строка попала в нужную позицию дубля', louver.stock === 11, louver.stock);
  check('позиция с неотправленной операцией не перезаписана', panel.stock === 45 && merged.skipped === 1, [panel.stock, merged.skipped]);

  const after = sync.mergeServerStock(host._state, [
    { sku: 'H234-YP', name: 'БП Однотонная глянец', category: 'Панель', stock: 38, reserve: 0 },
    { sku: 'H234-YP', name: 'Лувер 226YHB', category: 'Лувер', stock: 11, reserve: 0 }
  ], {});
  check('без защиты обновляются обе строки дубля', host._state.products.find((p) => p.id === 'p-panel').stock === 38 && host._state.products.find((p) => p.id === 'p-louver').stock === 11, after.changed);
  check('дубли не схлопываются в одну позицию', host._state.products.length === 3, host._state.products.length);

  const newIdentity = sync.mergeServerStock(host._state, [{ sku: 'H234-YP', name: 'БП Новая фактура', category: 'Панель', stock: 4, reserve: 0 }], {});
  check('неизвестная позиция с дублем артикула добавляется отдельной строкой', newIdentity.added === 1 && host._state.products.length === 4, host._state.products.map((p) => p.name));
  check('идентичность не зависит от регистра и пробелов', sync.identityKey(' H234-yp ', 'БП Однотонная Глянец', 'панель') === sync.identityKey('h234-YP', 'бп однотонная глянец', 'Панель'));
}

group('10c. Ручная отправка во время паузы автоматического повтора');
(async () => {
  let calls = 0;
  let fail = true;
  const net = loadSync({
    fetch: (url, options) => {
      calls += 1;
      if (fail) return Promise.reject(new Error('нет связи'));
      const body = JSON.parse(options.body);
      return jsonResponse({
        ok: true,
        results: body.operations.map((item) => ({ operationId: item.operationId, ok: true, status: 'processed', stockAfter: 15, availableAfter: 15 }))
      });
    }
  });
  const netHost = makeHost({
    products: [{ id: 'p1', sku: 'K01-206N', name: 'Лувер Graphite', category: 'Лувер', stock: 20, reserved: 0 }],
    operations: [],
    queue: [],
    sync: Object.assign({}, baseConfig, { autoSend: false })
  });
  net.sync.attach(netHost);
  const first = operation({ id: 'op-force', sku: 'K01-206N', name: 'Лувер Graphite', category: 'Лувер', qty: 2 });
  netHost._state.operations.push(first);
  net.sync.enqueue(first);
  await net.sync.flush('test');
  const stuck = net.sync.findItem('op-force');
  check('после обрыва — статус ошибки и пауза повтора', stuck.status === 'error' && stuck.nextTryAt > Date.now(), [stuck.status, stuck.nextTryAt - Date.now()]);
  check('автоматический выбор во время паузы ничего не берёт', net.sync.eligibleItems(false).length === 0 && net.sync.eligibleItems(true).length === 1);
  fail = false;
  const sent = await net.sync.retryNow();
  check('кнопка «Отправить сейчас» не ждёт паузы', sent.ok === true && net.sync.findItem('op-force') === null, sent);
  check('операция помечена отправленной', netHost._state.operations[0].syncStatus === 'synced', netHost._state.operations[0].syncStatus);
  fail = true;
  const second = operation({ id: 'op-force-2', sku: 'K01-206N', name: 'Лувер Graphite', category: 'Лувер', qty: 3 });
  netHost._state.operations.push(second);
  net.sync.enqueue(second);
  await net.sync.flush('test');
  net.sync.findItem('op-force-2').nextTryAt = Date.now() + 600000;
  const before = calls;
  fail = false;
  await net.sync.retryItem('op-force-2');
  check('кнопка «Повторить» на одной операции тоже снимает паузу', calls === before + 1 && net.sync.findItem('op-force-2') === null, [before, calls]);
  net.sync.updateSettings({ enabled: false });
})();

group('11. Слияние серверных остатков с локальной базой');
{
  const { sync } = loadSync();
  const host = makeHost({
    products: [
      { id: 'p1', sku: 'Н234-YP', name: 'Панель', category: 'Панель', length: 3000, stock: 30, reserved: 2, retired: false },
      { id: 'p2', sku: 'К01-206N', name: 'Лувер', category: 'Лувер', length: 3000, stock: 8, reserved: 0, retired: false },
      { id: 'p3', sku: 'ПР-99', name: 'Архив', category: 'Профиль', length: 3000, stock: 0, reserved: 0, retired: true }
    ],
    operations: [], queue: [], sync: Object.assign({}, baseConfig, { autoSend: false })
  });
  sync.attach(host);
  host._state.operations.push(operation({ id: 'op-keep', sku: 'Н234-YP' }));
  sync.enqueue(host._state.operations[0]);

  const incoming = [
    { sku: 'Н234-YP', name: 'Панель Natural Oak', category: 'Панель', length: 3000, stock: 99, reserve: 0, available: 99 },
    { sku: 'К01-206N', name: 'Лувер Graphite', category: 'Лувер', length: 3000, stock: 5, reserve: 1, available: 4 },
    { sku: 'ПР-99', name: 'Профиль', category: 'Профиль', length: 3000, stock: 12, reserve: 0, available: 12 },
    { sku: 'Н999-NEW', name: 'Панель Novel', category: 'Панель', length: 4000, stock: 7, reserve: 0, available: 7 }
  ];
  const result = sync.mergeServerStock(host._state, incoming, sync.pendingSkus());
  const p1 = host._state.products.find((p) => p.sku === 'Н234-YP');
  check('позиция с незакрытой операцией не перезаписана', p1.stock === 30, p1.stock);
  check('такая позиция помечена как пропущенная', result.skipped === 1, result);
  const p2 = host._state.products.find((p) => p.sku === 'К01-206N');
  check('свободная позиция обновлена с сервера', p2.stock === 5 && p2.reserved === 1, [p2.stock, p2.reserved]);
  const p3 = host._state.products.find((p) => p.sku === 'ПР-99');
  check('архивная позиция возвращается в работу, если есть на сервере', p3.retired === false && p3.stock === 12);
  const added = host._state.products.find((p) => p.sku === 'Н999-NEW');
  check('новая позиция добавлена', added && added.length === 4000 && added.stock === 7, added);
  check('резерв не может превышать остаток', sync.mergeServerStock(host._state, [{ sku: 'К01-206N', stock: 2, reserve: 9 }], {}).changed === 1 && host._state.products.find((p) => p.sku === 'К01-206N').reserved === 2);
  const conflicts = sync.mergeServerStock(host._state, [{ sku: 'К01-206N', name: 'Лувер Graphite', stock: 2, reserve: 0, conflict: '⚠ РАСХОЖДЕНИЕ' }], {});
  check('конфликт с сервера передан в приложение', conflicts.conflicts.length === 1 && /РАСХОЖДЕНИЕ/.test(conflicts.conflicts[0].note), conflicts.conflicts);
}

group('12. Проверка соединения и ручная загрузка остатков');
(async () => {
  const seen = [];
  const { sync } = loadSync({
    fetch: (url, options) => {
      seen.push(url);
      if (/action=ping/.test(url)) return jsonResponse({ ok: true, app: 'FORONE-SYNC', version: '2.1.0', sheets: { 'FORONE_Остатки': 3 }, serverTime: 'now' });
      return jsonResponse({ ok: true, count: 1, products: [{ sku: 'Н234-YP', name: 'Панель', category: 'Панель', length: 3000, stock: 28, reserve: 0, available: 28 }], conflicts: [{ sku: 'Н234-YP', note: 'Источник: 36 → 40' }] });
    }
  });
  const host = makeHost({ products: [{ id: 'p1', sku: 'Н234-YP', name: 'Панель', category: 'Панель', length: 3000, stock: 30, reserved: 0, retired: false }], operations: [], queue: [], sync: Object.assign({}, baseConfig, { autoSend: false }) });
  sync.attach(host);
  const ping = await sync.ping();
  check('ping вернул версию сервера', ping.ok === true && ping.version === '2.1.0', ping);
  check('ключ добавлен в запрос', /key=test-key/.test(seen[0]), seen[0]);
  check('версия сервера сохранена в настройках', sync.config().serverVersion === '2.1.0');

  const pull = await sync.pullStock({ silent: true });
  check('остатки загружены с сервера', pull.ok === true && host._state.products[0].stock === 28, pull);
  check('конфликты сохранены для показа', sync.config().lastConflicts.length === 1, sync.config().lastConflicts);
  check('время последней загрузки отмечено', sync.config().lastPull > 0);

  const disabled = loadSync({ fetch: () => jsonResponse({ ok: true, version: 'x' }) });
  const disabledHost = makeHost({ products: [], operations: [], queue: [], sync: { enabled: true, url: '', key: '' } });
  disabled.sync.attach(disabledHost);
  const noUrl = await disabled.sync.ping();
  check('без URL ping даёт понятную подсказку', noUrl.ok === false && /URL/.test(noUrl.message), noUrl);
})();

group('13. Состояние приложения после миграции старой базы');
{
  const { sync } = loadSync();
  const legacy = { products: [{ sku: 'X', stock: 1 }], operations: [{ id: 'op-1', type: 'out', qty: 1 }] };
  const host = makeHost(legacy);
  sync.attach(host);
  check('миграция добавила очередью массив', Array.isArray(host._state.queue));
  check('миграция добавила настройки', host._state.sync.enabled === false && typeof host._state.sync.url === 'string');
  check('метка устройства сгенерирована', /^dev-/.test(host._state.sync.device));
  check('старые операции не улетели в очередь сами', host._state.queue.length === 0);
  const summary = sync.summary();
  check('сводка доступна для интерфейса', summary.enabled === false && summary.total === 0 && summary.unsynced === 1, summary);
}

// Планировщик повторов ставит длинные setTimeout — завершаем процесс вручную.
setTimeout(() => {
  console.log('\n' + '-'.repeat(64));
  console.log('Итог: ' + passed + ' пройдено, ' + failed + ' провалено');
  if (failed) {
    console.log('\nПроваленные проверки:');
    failures.forEach((f) => console.log('  - ' + f));
  }
  process.exit(failed ? 1 : 0);
}, 600);
group('12б. Автообновление остатков при запуске приложения');
(async () => {
  const requests = [];
  let heartbeat = null;
  const { sync } = loadSync({
    setInterval: (callback) => { heartbeat = callback; return 1; },
    clearInterval: () => {},
    fetch: (url) => {
      requests.push(url);
      return jsonResponse({ ok: true, sourceSheet: 'Октябрь-Ноябрь', products: [{ sku: 'Н234-YP', name: 'Панель', category: 'Панель', length: 3000, stock: 25, reserve: 0, available: 25 }], conflicts: [] });
    }
  });
  const host = makeHost({ products: [{ id: 'p1', sku: 'Н234-YP', name: 'Панель', category: 'Панель', length: 3000, stock: 20, reserved: 0, retired: false }], operations: [], queue: [], sync: Object.assign({}, baseConfig, { enabled: true }) });
  sync.attach(host);
  const initialPull = await sync.startTimers();
  check('при запуске включённого приложения выполнен GET action=stock', requests.length === 1 && /action=stock/.test(requests[0]), requests);
  check('стартовый pull обновил локальный остаток', initialPull.ok && host._state.products[0].stock === 25, initialPull);
  check('после изменения каталога вызван callback перерисовки', host.stockUpdateEvents === 1, host.stockUpdateEvents);
  heartbeat();
  check('минутный heartbeat не повторяет GET до истечения 15 минут', requests.length === 1, requests.length);
})();
