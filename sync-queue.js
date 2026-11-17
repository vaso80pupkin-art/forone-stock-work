/**
 * FORONE.KZ — Очередь отправки операций в Google Таблицу (двусторонний канал).
 *
 * Канал односторонний импорт (XLSX из Google Таблиц) остаётся как есть.
 * Этот модуль отвечает только за обратную сторону:
 *
 *   операция в приложении → локальная очередь → POST в Apps Script Web App
 *                                                → FORONE_Операции → FORONE_Остатки
 *
 * Принципы:
 *   1. Операция всегда сначала сохраняется локально и применяется к остатку.
 *   2. У каждой операции есть глобально уникальный Operation ID — повторная
 *      отправка не приводит к двойному списанию (идемпотентность на сервере).
 *   3. Без интернета операции копятся в очереди и уходят автоматически.
 *   4. Никаких паролей: только короткий ключ Web App из настроек.
 */
(function (root) {
  'use strict';

  var SYNC_STATE_VERSION = 3;
  var OP_KEY_PREFIX = 'op-';
  var DEVICE_KEY = 'forone-stock-work-device-v2';
  var MAX_QUEUE_BATCH = 50;
  var REQUEST_TIMEOUT = 20000;

  var DEFAULTS = {
    enabled: false,
    url: '',
    key: '',
    user: '',
    device: '',
    autoSend: true,
    pullAfterSend: true,
    lastSuccess: 0,
    lastError: 0,
    lastErrorText: '',
    lastPing: 0,
    lastPull: 0,
    serverVersion: '',
    lastConflicts: []
  };

  var STATUS = {
    local: { label: 'Операция сохранена локально', tone: 'muted', short: 'Локально' },
    queued: { label: 'Ожидает отправки', tone: 'yellow', short: 'В очереди' },
    sending: { label: 'Отправка…', tone: 'blue', short: 'Отправка' },
    synced: { label: 'Синхронизировано', tone: 'green', short: 'Синхронизировано' },
    error: { label: 'Ошибка отправки', tone: 'red', short: 'Ошибка' },
    rejected: { label: 'Отклонено складом', tone: 'red', short: 'Отклонено' },
    cancelled: { label: 'Отменено', tone: 'muted', short: 'Отменено' }
  };

  var TYPE_TO_SERVER = { in: 'in', out: 'out', writeoff: 'writeoff' };
  var REVERSE_TYPE = { in: 'out', out: 'in', writeoff: 'in' };
  var RETRY_LADDER = [10000, 30000, 120000, 600000, 1800000];

  var host = null;
  var sending = false;
  var flushTimer = null;
  var heartbeatTimer = null;

  // ------------------------------------------------------------------ utils

  function now() { return Date.now(); }

  function pad(value) { return String(value).padStart(2, '0'); }

  function timestampParts(date) {
    var d = new Date(date || now());
    return {
      date: '' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()),
      time: pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()),
      display: pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + '.' + d.getFullYear() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
    };
  }

  function randomSuffix(size) {
    var length = size || 4;
    var cryptoObj = root.crypto || root.msCrypto;
    var out = '';
    if (cryptoObj && cryptoObj.getRandomValues) {
      var bytes = new Uint8Array(length);
      cryptoObj.getRandomValues(bytes);
      out = Array.prototype.map.call(bytes, function (b) { return (b % 36).toString(36); }).join('');
    } else {
      while (out.length < length) out += Math.random().toString(36).slice(2);
      out = out.slice(0, length);
    }
    return out;
  }

  // Счётчик внутри сессии: две операции в одну секунду не получат одинаковый ID.
  var idSequence = Math.floor(Math.random() * 1000);

  /**
   * op-20261117-144210-007-k3dz
   *   дата + время + счётчик сессии + 4 случайных символа.
   * Счётчик снимает коллизии внутри одного телефона, случайный хвост —
   * между разными телефонами, работающими в одну секунду.
   */
  var idSecondKey = '';
  function makeOperationId(date) {
    var parts = timestampParts(date);
    var second = parts.date + parts.time;
    // Счётчик сбрасывается каждую секунду: за одну секунду он не успевает
    // обернуться, а случайный хвост страхует два телефона на одном складе.
    idSequence = second === idSecondKey ? idSequence + 1 : 0;
    idSecondKey = second;
    if (idSequence > 9999) idSequence = 0;
    return OP_KEY_PREFIX + second.slice(0, 8) + '-' + second.slice(8) + '-' + String(idSequence).padStart(4, '0') + '-' + randomSuffix(4);
  }

  function makeDeviceId() {
    try {
      var stored = root.localStorage.getItem(DEVICE_KEY);
      if (stored) return stored;
      var created = 'dev-' + now().toString(36) + '-' + randomSuffix(4);
      root.localStorage.setItem(DEVICE_KEY, created);
      return created;
    } catch (error) {
      return 'dev-' + now().toString(36);
    }
  }

  function config() {
    var state = host && host.state();
    if (!state) return Object.assign({}, DEFAULTS);
    state.sync = Object.assign({}, DEFAULTS, state.sync || {});
    if (!state.sync.device) state.sync.device = makeDeviceId();
    return state.sync;
  }

  function save() { if (host) host.save(); }

  function normalizeText(value) {
    return String(value === undefined || value === null ? '' : value)
      .toLowerCase()
      .replace(/[\s_.,\-/:«»"()'\[\]№]+/g, '');
  }

  /**
   * Идентичность позиции. В реальной базе FORONE один артикул встречается
   * в нескольких позициях (H234-YP — и лувер, и панель), поэтому одного
   * артикула для сопоставления недостаточно.
   */
  function identityKey(sku, name, category) {
    return normalizeText(sku) + '|' + normalizeText(name) + '|' + normalizeText(category);
  }

  function itemIdentity(item) { return identityKey(item.sku, item.name, item.category); }

  function productIdentity(product) { return identityKey(product.sku, product.name, product.category); }

  /** Сколько позиций каталога делят один артикул. */
  function skuCounts(state) {
    var counts = {};
    ((state && state.products) || []).forEach(function (product) {
      var key = normalizeText(product.sku);
      counts[key] = (counts[key] || 0) + 1;
    });
    return counts;
  }

  /**
   * Подбор позиции каталога под строку сервера или элемент очереди.
   * Порядок точный: id → артикул+название+категория → артикул+название.
   * Угадывать по одному артикулу здесь нельзя: в базе FORONE он повторяется.
   */
  function matchProduct(products, reference, used) {
    var pool = (products || []).filter(function (product) { return !used || !used[product.id]; });
    var key = normalizeText(reference.sku);
    var bySku = pool.filter(function (product) { return normalizeText(product.sku) === key; });
    if (!bySku.length) return null;
    if (reference.productId) {
      var exactId = bySku.filter(function (product) { return product.id === reference.productId; })[0];
      if (exactId) return exactId;
    }
    var identity = identityKey(reference.sku, reference.name, reference.category);
    var exactIdentity = bySku.filter(function (product) { return productIdentity(product) === identity; });
    if (exactIdentity.length) return exactIdentity[0];
    if (normalizeText(reference.name)) {
      var byName = bySku.filter(function (product) { return normalizeText(product.name) === normalizeText(reference.name); });
      if (byName.length) return byName[0];
    }
    if (bySku.length === 1 && !normalizeText(reference.name) && !normalizeText(reference.category)) return bySku[0];
    return null;
  }

  /** Строки каталога с тем же артикулом (для шага, где допускаем переименование). */
  function sameSkuProducts(products, sku, used) {
    var key = normalizeText(sku);
    return (products || []).filter(function (product) {
      return normalizeText(product.sku) === key && (!used || !used[product.id]);
    });
  }

  function queue() {
    var state = host && host.state();
    if (!state) return [];
    if (!Array.isArray(state.queue)) state.queue = [];
    return state.queue;
  }

  function isOnline() {
    return typeof navigator === 'undefined' ? true : navigator.onLine !== false;
  }

  function normalizeUrl(value) {
    var url = String(value || '').trim();
    if (!url) return '';
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    return url.replace(/\/+$/, '');
  }

  function isConfigured() {
    var cfg = config();
    return Boolean(cfg.enabled && normalizeUrl(cfg.url));
  }

  // -------------------------------------------------- очередь: добавление

  function enqueue(operation) {
    if (!operation || !operation.id) return null;
    var cfg = config();
    var item = {
      operationId: operation.id,
      productId: operation.productId || '',
      sku: operation.sku,
      name: operation.name || operation.sku,
      category: operation.category || '',
      type: TYPE_TO_SERVER[operation.type] || operation.type,
      qty: Math.abs(Number(operation.qty) || 0),
      delta: operation.type === 'in' ? Math.abs(Number(operation.qty) || 0) : -Math.abs(Number(operation.qty) || 0),
      comment: operation.comment || '',
      createdAt: operation.createdAt || new Date().toISOString(),
      status: 'queued',
      attempts: 0,
      nextTryAt: 0,
      lastAttemptAt: 0,
      lastError: '',
      addedAt: now(),
      serverStockAfter: null,
      sentAt: 0
    };
    queue().push(item);
    markOperationStatus(operation.id, cfg.enabled ? 'queued' : 'local');
    save();
    render();
    if (cfg.enabled && cfg.autoSend) schedule(0);
    return item;
  }

  function findItem(operationId) {
    return queue().filter(function (item) { return item.operationId === operationId; })[0] || null;
  }

  function removeItem(operationId) {
    var list = queue();
    var index = -1;
    for (var i = 0; i < list.length; i += 1) if (list[i].operationId === operationId) index = i;
    if (index < 0) return null;
    return list.splice(index, 1)[0];
  }

  function markOperationStatus(operationId, status) {
    var state = host && host.state();
    if (!state || !Array.isArray(state.operations)) return;
    for (var i = 0; i < state.operations.length; i += 1) {
      if (state.operations[i].id === operationId) {
        state.operations[i].syncStatus = status;
        if (status === 'synced') state.operations[i].syncedAt = now();
        return;
      }
    }
  }

  /** Неотправленные операции: и по артикулу, и по полной идентичности позиции. */
  function pendingProjections() {
    var keys = {};
    var skus = {};
    queue().forEach(function (item) {
      if (item.status !== 'queued' && item.status !== 'sending' && item.status !== 'error') return;
      keys[itemIdentity(item)] = true;
      skus[normalizeText(item.sku)] = true;
    });
    return { keys: keys, skus: skus };
  }

  function pendingSkus() { return pendingProjections().skus; }

  /**
   * Есть ли по позиции незакрытая операция.
   * Аргумент — строка артикула (старые вызовы) или объект позиции/операции.
   */
  function hasPendingFor(reference) {
    var pending = pendingProjections();
    if (!reference) return false;
    if (typeof reference === 'string') return Boolean(pending.skus[normalizeText(reference)]);
    var identity = identityKey(reference.sku, reference.name, reference.category);
    if (pending.keys[identity]) return true;
    var counts = skuCounts(host && host.state());
    return Boolean(pending.skus[normalizeText(reference.sku)]) && (counts[normalizeText(reference.sku)] || 1) === 1;
  }

  /** Позиция каталога, на которую ссылается элемент очереди (или null). */
  function resolveProduct(item, stateOverride) {
    var state = stateOverride || (host && host.state());
    if (!state || !Array.isArray(state.products)) return null;
    var found = matchProduct(state.products, item, null);
    if (found) return found;
    // Имени нет (старая запись в очереди) — рискнём, только если артикул в каталоге уникален.
    var bySku = sameSkuProducts(state.products, item.sku, null);
    return bySku.length === 1 ? bySku[0] : null;
  }

  // -------------------------------------------------- сборка запроса

  function buildBatchPayload(items) {
    var cfg = config();
    return {
      action: 'operations',
      app: 'FORONE Stock',
      appVersion: SYNC_STATE_VERSION,
      key: cfg.key || '',
      user: cfg.user || 'Сотрудник',
      device: cfg.deviceLabel || cfg.device || makeDeviceId(),
      sentAt: new Date().toISOString(),
      operations: items.map(function (item) {
        return {
          operationId: item.operationId,
          sku: item.sku,
          name: item.name,
          type: item.type,
          qty: item.qty,
          comment: item.comment,
          createdAt: item.createdAt,
          unit: 'шт'
        };
      })
    };
  }

  function eligibleItems(force) {
    var time = now();
    return queue().filter(function (item) {
      if (item.status === 'sending') return false;
      // Отклонённые складом операции сами по себе не повторяем: нужен человек.
      if (item.status === 'rejected') return false;
      if (item.status !== 'queued' && item.status !== 'error') return false;
      if (force) return true;
      return !item.nextTryAt || item.nextTryAt <= time;
    }).slice(0, MAX_QUEUE_BATCH);
  }

  function retryDelay(attempts) {
    var index = Math.min(Math.max(0, attempts), RETRY_LADDER.length - 1);
    return RETRY_LADDER[index];
  }

  /** Разбор ответа сервера в единый вид. Возвращает null, если это не ответ FORONE. */
  function interpretResponse(text) {
    var body = null;
    try { body = JSON.parse(text); } catch (error) { return null; }
    if (!body || typeof body !== 'object') return null;
    if (body.results && Array.isArray(body.results)) return body;
    if (body.ok === false && body.code) return body;
    return null;
  }

  function describeTransportFailure(text, status) {
    var head = String(text || '').trim().slice(0, 200);
    if (/<html|<!doctype/i.test(head)) {
      if (/To view or access this project|Sign in/i.test(head)) {
        return 'Google просит вход в аккаунт. В публикации Web App выберите доступ «Все, у кого есть ссылка».';
      }
      return 'Сервер вернул страницу сайта вместо данных. Проверьте, что URL заканчивается на /exec.';
    }
    if (!status) return 'Нет связи с сервером Google. Операции останутся в очереди.';
    if (status === 404) return 'Web App не найден (404). Опубликуйте скрипт заново и обновите URL.';
    if (status === 403) return 'Доступ запрещён (403). Проверьте ключ Web App и права публикации.';
    return 'Сервер ответил ошибкой HTTP ' + status + '.';
  }

  // -------------------------------------------------- отправка

  function request(url, options) {
    var controller = typeof root.AbortController === 'function' ? new root.AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, REQUEST_TIMEOUT) : null;
    var settings = Object.assign({}, options);
    if (controller) settings.signal = controller.signal;
    return fetch(url, settings).then(function (response) {
      return response.text().then(function (text) {
        if (timer) clearTimeout(timer);
        return { response: response, text: text };
      });
    }, function (error) {
      if (timer) clearTimeout(timer);
      throw error;
    });
  }

  function applyResult(item, result) {
    if (!result) {
      // Сервер не сказал про эту операцию: считаем доставку недоказанной,
      // отправим повторно — дубль отсеется по Operation ID.
      item.status = 'queued';
      item.lastError = 'Сервер не вернул статус этой операции';
      item.nextTryAt = now() + retryDelay(item.attempts);
      markOperationStatus(item.operationId, 'queued');
      return false;
    }
    if (result.status === 'duplicate' || (result.ok && result.status === 'processed')) {
      item.status = 'synced';
      item.sentAt = now();
      item.lastError = '';
      item.serverStockAfter = result.stockAfter === undefined || result.stockAfter === null ? item.serverStockAfter : result.stockAfter;
      item.availableAfter = result.availableAfter;
      markOperationStatus(item.operationId, 'synced');
      if (host && host.onSynced) host.onSynced(item, result);
      return true;
    }
    if (!result.ok) {
      var terminal = ['SKU_NOT_FOUND', 'INSUFFICIENT_STOCK', 'BAD_QTY', 'BAD_TYPE', 'NO_SKU', 'NO_OPERATION_ID', 'FORBIDDEN_USER'].indexOf(result.code) >= 0;
      item.status = terminal ? 'rejected' : 'error';
      item.lastError = result.message || 'Операция отклонена';
      item.errorCode = result.code || '';
      item.nextTryAt = terminal ? 0 : now() + retryDelay(item.attempts);
      markOperationStatus(item.operationId, terminal ? 'rejected' : 'error');
      return false;
    }
    item.status = 'synced';
    markOperationStatus(item.operationId, 'synced');
    return true;
  }

  function flush(reason, options) {
    var opts = options || {};
    var force = Boolean(opts.force);
    var cfg = config();
    if (!cfg.enabled || !normalizeUrl(cfg.url) || sending) {
      render();
      return Promise.resolve({ skipped: true, reason: !cfg.enabled ? 'disabled' : sending ? 'sending' : 'no-url' });
    }
    var items = eligibleItems(force);
    if (!items.length) { render(); return Promise.resolve({ skipped: true, reason: 'empty' }); }
    if (!isOnline()) {
      items.forEach(function (item) { if (item.status !== 'error') { item.status = 'queued'; markOperationStatus(item.operationId, 'queued'); } });
      save(); render();
      return Promise.resolve({ skipped: true, reason: 'offline' });
    }

    sending = true;
    items.forEach(function (item) { item.status = 'sending'; item.lastAttemptAt = now(); markOperationStatus(item.operationId, 'sending'); });
    save(); render();

    var payload = buildBatchPayload(items);
    var url = normalizeUrl(cfg.url);

    return request(url, {
      method: 'POST',
      mode: 'cors',
      credentials: 'omit',
      redirect: 'follow',
      cache: 'no-store',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    }).then(function (outcome) {
      var parsed = interpretResponse(outcome.text);
      if (!parsed) {
        var message = describeTransportFailure(outcome.text, outcome.response && outcome.response.status);
        failAll(items, message, outcome.response && outcome.response.status);
        return { ok: false, message: message, results: [] };
      }
      if (parsed.code === 'AUTH' || parsed.code === 'FORBIDDEN_USER') {
        failAll(items, parsed.message || 'Сервер отклонил ключ доступа', 'auth');
        return { ok: false, message: parsed.message, results: [] };
      }
      if (parsed.code === 'BUSY') {
        items.forEach(function (item) {
          item.status = 'queued';
          item.attempts += 1;
          item.nextTryAt = now() + retryDelay(item.attempts);
          markOperationStatus(item.operationId, 'queued');
        });
        save(); schedule(3000); render();
        return { ok: false, busy: true, message: parsed.message, results: [] };
      }

      var byId = {};
      (parsed.results || []).forEach(function (result) { byId[result.operationId] = result; });
      var applied = 0;
      var problems = [];
      items.forEach(function (item) {
        var result = byId[item.operationId];
        if (applyResult(item, result)) applied += 1;
        else if (result) problems.push({ sku: item.sku, message: result.message, code: result.code });
      });

      var cfgAfter = config();
      var hadErrors = items.some(function (item) { return item.status === 'error' || item.status === 'rejected'; });
      if (!hadErrors) {
        cfgAfter.lastSuccess = now();
        cfgAfter.lastErrorText = '';
      }
      if (applied) {
        var state = host.state();
        state.queue = queue().filter(function (entry) { return entry.status !== 'synced'; });
      }
      save();
      render();
      if (host && host.onFlushed) host.onFlushed({ applied: applied, problems: problems, reason: reason });
      if (cfgAfter.pullAfterSend && applied && isOnline()) pullStock({ silent: true });
      sending = false;
      render();

      var remaining = eligibleItems();
      if (remaining.length) schedule(retryDelay(1));
      return { ok: !hadErrors, applied: applied, problems: problems };
    }, function (error) {
      var aborted = error && (error.name === 'AbortError');
      failAll(items, aborted ? 'Превышено время ожидания ответа Google' : (isOnline() ? 'Не удалось связаться с сервером' : 'Нет интернета'), 'network');
      return { ok: false, message: 'Сеть недоступна', results: [] };
    });
  }

  function failAll(items, message, kind) {
    var cfg = config();
    items.forEach(function (item) {
      item.status = 'error';
      item.attempts += 1;
      item.lastError = message;
      item.nextTryAt = now() + retryDelay(item.attempts);
      markOperationStatus(item.operationId, 'error');
    });
    cfg.lastError = now();
    cfg.lastErrorText = message;
    save();
    sending = false;
    render();
    // Приложение должно перерисовать журнал: у операций теперь статус «ошибка».
    if (host && host.onFlushed) {
      host.onFlushed({ applied: 0, problems: [], failed: items.length, message: message, kind: kind, reason: 'failure' });
    }
    if (kind !== 'auth') schedule(retryDelay(items.length ? items[0].attempts : 1));
  }

  function schedule(delay) {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(function () {
      flushTimer = null;
      flush('timer');
    }, Math.max(0, delay === undefined ? 1500 : delay));
  }

  /** Кнопка «Отправить сейчас»: пауза повтора не мешает человеку. */
  function retryNow() {
    queue().forEach(function (item) {
      if (item.status === 'error') { item.status = 'queued'; item.nextTryAt = 0; markOperationStatus(item.operationId, 'queued'); }
      if (item.status === 'sending') { item.status = 'queued'; markOperationStatus(item.operationId, 'queued'); }
    });
    save();
    render();
    return flush('manual', { force: true });
  }

  function retryItem(operationId) {
    var item = findItem(operationId);
    if (!item) return Promise.resolve({ skipped: true });
    if (item.status === 'rejected') item.attempts = 0;
    if (item.status !== 'sending') {
      item.status = 'queued';
      item.nextTryAt = 0;
      markOperationStatus(operationId, 'queued');
      save();
      render();
    }
    return flush('manual-item', { force: true });
  }

  /** Отмена операции ДО отправки: удаляем из очереди, хост откатывает остаток. */
  function cancelQueued(operationId) {
    var item = removeItem(operationId);
    if (item) markOperationStatus(operationId, 'cancelled');
    save();
    render();
    return item;
  }

  /** Для операции ПОСЛЕ отправки — обратная операция (компенсирующая запись). */
  function reversePayload(item) {
    var type = REVERSE_TYPE[item.type] || 'in';
    return {
      operationId: makeOperationId(),
      sku: item.sku,
      name: item.name,
      category: item.category,
      type: type,
      qty: item.qty,
      comment: ('Отмена ' + item.operationId + (item.comment ? ' · ' + item.comment : '')).slice(0, 180),
      createdAt: new Date().toISOString()
    };
  }

  function discard(operationId) {
    var item = removeItem(operationId);
    if (item) markOperationStatus(item.operationId, item.status === 'rejected' ? 'rejected' : 'cancelled');
    save();
    render();
    return item;
  }

  /** Все операции смены, которые ещё не в очереди и не отправлены. */
  function unsyncedShiftOperations() {
    var state = host && host.state();
    if (!state || !Array.isArray(state.operations)) return [];
    var inQueue = {};
    queue().forEach(function (item) { inQueue[item.operationId] = true; });
    // Досылаем только то, что никогда не уходило на сервер: операции, проведённые
    // до включения синхронизации (или с выключенным Web App). Отклонённые и отменённые
    // возвращаются в очередь только по воле человека — кнопкой в журнале.
    return state.operations.filter(function (operation) {
      var status = operation.syncStatus || 'local';
      return (status === 'local') && !inQueue[operation.id] && Boolean(TYPE_TO_SERVER[operation.type]);
    });
  }

  function enqueueAllUnsynced() {
    var list = unsyncedShiftOperations();
    list.forEach(function (operation) { enqueue(operation); });
    save();
    render();
    return list.length;
  }

  // -------------------------------------------------- серверные запросы

  function ping() {
    var cfg = config();
    var url = normalizeUrl(cfg.url);
    if (!url) return Promise.resolve({ ok: false, message: 'Сначала вставьте URL Web App' });
    var query = '?action=ping' + (cfg.key ? '&key=' + encodeURIComponent(cfg.key) : '');
    return request(url + query, { method: 'GET', mode: 'cors', credentials: 'omit', redirect: 'follow', cache: 'no-store' })
      .then(function (outcome) {
        var parsed = interpretResponse(outcome.text) || (function () {
          try { return JSON.parse(outcome.text); } catch (error) { return null; }
        })();
        if (!parsed) return { ok: false, message: describeTransportFailure(outcome.text, outcome.response && outcome.response.status) };
        if (parsed.ok === false) return { ok: false, message: parsed.message || 'Сервер ответил ошибкой', code: parsed.code };
        var cfgAfter = config();
        cfgAfter.lastPing = now();
        cfgAfter.lastError = 0;
        cfgAfter.lastErrorText = '';
        cfgAfter.serverVersion = parsed.version || '';
        if (parsed.message && parsed.auth && parsed.auth.required) cfgAfter.lastErrorText = 'Ключ не совпадает';
        save();
        render();
        return parsed;
      }, function () {
        var cfgAfter = config();
        cfgAfter.lastError = now();
        cfgAfter.lastErrorText = 'Сервер не отвечает';
        save(); render();
        return { ok: false, message: 'Сервер не отвечает. Проверьте интернет и URL.' };
      });
  }

  function pullStock(options) {
    var opts = options || {};
    var cfg = config();
    var url = normalizeUrl(cfg.url);
    if (!url || !cfg.key) return Promise.resolve({ ok: false, message: 'Не задан URL или ключ' });
    if (!isOnline()) return Promise.resolve({ ok: false, message: 'Нет интернета' });
    var query = '?action=stock&key=' + encodeURIComponent(cfg.key);
    return request(url + query, { method: 'GET', mode: 'cors', credentials: 'omit', redirect: 'follow', cache: 'no-store' })
      .then(function (outcome) {
        var parsed = null;
        try { parsed = JSON.parse(outcome.text); } catch (error) { parsed = null; }
        if (!parsed || !parsed.ok) {
          return { ok: false, message: parsed && parsed.message ? parsed.message : describeTransportFailure(outcome.text, outcome.response && outcome.response.status) };
        }
        var cfgAfter = config();
        cfgAfter.lastPull = now();
        cfgAfter.lastConflicts = Array.isArray(parsed.conflicts) ? parsed.conflicts : [];
        save();
        var merged = mergeServerStock(host.state(), parsed.products || [], pendingProjections());
        if (!opts.silent || merged.changed) save();
        render();
        return Object.assign({ ok: true }, merged, { conflicts: cfgAfter.lastConflicts });
      }, function () {
        return { ok: false, message: 'Не удалось получить остатки с сервера' };
      });
  }

  /**
   * Слияние серверных остатков с локальной базой.
   * Позиции с неотправленными операциями не трогаем — иначе потеряем свой расход.
   */
  /**
   * Слияние серверных остатков с локальной базой.
   * Server rows are matched to catalog rows in three passes:
   *  1) точное совпадение артикул+название+категория;
   *  2) тот же артикул и одна свободная строка — считаем переименованием;
   *  3) иначе добавляем новую позицию (дубль артикула остаётся дублем).
   * Позиции с нашей неотправленной операцией не перезаписываем.
   */
  function mergeServerStock(state, products, pending) {
    var result = { changed: 0, added: 0, skipped: 0, renamed: 0, conflicts: [] };
    if (!state || !Array.isArray(state.products)) return result;
    var skus = pending && pending.skus ? pending.skus : (pending || {});
    var keys = pending && pending.keys ? pending.keys : {};
    var catalog = state.products.slice();
    var counts = skuCounts(state);
    var used = {};
    var incoming = (products || []).filter(function (item) { return normalizeText(item.sku); });

    function isProtected(item) {
      var key = normalizeText(item.sku);
      return Boolean(keys[identityKey(item.sku, item.name, item.category)]) || Boolean(skus[key] && (counts[key] || 1) === 1);
    }

    function applyIncoming(existing, item) {
      var nextStock = Math.max(0, Number(item.stock) || 0);
      var nextReserve = Math.min(Math.max(0, Number(item.reserve) || 0), nextStock);
      var touched = false;
      if (Number(existing.stock) !== nextStock) { existing.stock = nextStock; touched = true; }
      if (Number(existing.reserved || 0) !== nextReserve) { existing.reserved = nextReserve; touched = true; }
      if (item.name && existing.name !== item.name) { existing.name = item.name; touched = true; }
      if (item.category && existing.category !== item.category) { existing.category = item.category; touched = true; }
      if (item.length && Number(existing.length) !== Number(item.length)) { existing.length = Number(item.length); touched = true; }
      if (existing.retired) { existing.retired = false; touched = true; }
      if (touched) { existing.updatedAt = now(); result.changed += 1; }
    }

    var resolved = incoming.map(function () { return false; });
    var countedSkip = incoming.map(function () { return false; });

    // Шаг 1 — точные совпадения по идентичности позиции.
    incoming.forEach(function (item, index) {
      if (isProtected(item)) { if (!countedSkip[index]) { countedSkip[index] = true; result.skipped += 1; } return; }
      var existing = matchProduct(catalog, item, used);
      if (existing) { used[existing.id] = true; resolved[index] = true; applyIncoming(existing, item); }
    });

    // Шаг 2 — переименования: тот же артикул, свободная строка ровно одна.
    incoming.forEach(function (item, index) {
      if (resolved[index] || isProtected(item)) return;
      var free = sameSkuProducts(catalog, item.sku, used);
      if (free.length === 1) {
        used[free[0].id] = true;
        resolved[index] = true;
        result.renamed += 1;
        applyIncoming(free[0], item);
      }
    });

    // Шаг 3 — новые позиции. Вторая строка с тем же артикулом остаётся отдельной.
    incoming.forEach(function (item, index) {
      if (resolved[index] || isProtected(item)) return;
      var base = 'p-srv-' + normalizeText(item.sku).replace(/[^a-z0-9]/g, '').slice(0, 14);
      var taken = {};
      state.products.forEach(function (product) { taken[product.id] = true; });
      var freshId = base;
      var step = 1;
      while (taken[freshId]) { step += 1; freshId = base + '-' + step; }
      taken[freshId] = true;
      state.products.push({
        id: freshId,
        sku: item.sku,
        name: item.name || item.sku,
        category: item.category || 'Панель',
        length: Number(item.length) || 3000,
        source: 'apps-script',
        stock: Math.max(0, Number(item.stock) || 0),
        reserved: Math.min(Math.max(0, Number(item.reserve) || 0), Math.max(0, Number(item.stock) || 0)),
        warehouse: item.warehouse || 'Алматы',
        zone: item.zone || '',
        rack: item.rack || '',
        bin: item.bin || '',
        orderOnly: Number(item.length) >= 4000,
        barcode: item.sku,
        retired: false,
        updatedAt: now()
      });
      catalog.push(state.products[state.products.length - 1]);
      used[freshId] = true;
      resolved[index] = true;
      result.added += 1;
    });

    // Расхождения, о которых предупредил сервер.
    (state.products || []).forEach(function (product) {
      var found = (products || []).filter(function (item) {
        if (normalizeText(item.sku) !== normalizeText(product.sku)) return false;
        if ((counts[normalizeText(product.sku)] || 1) === 1) return true;
        return productIdentity(product) === identityKey(item.sku, item.name, item.category);
      })[0];
      if (found && found.conflict) result.conflicts.push({ sku: product.sku, note: found.conflict });
    });

    return result;
  }

  // -------------------------------------------------- сводка и интерфейс

  function summary() {
    var cfg = config();
    var list = queue();
    var counts = { queued: 0, sending: 0, error: 0, rejected: 0, synced: 0 };
    list.forEach(function (item) { if (counts[item.status] !== undefined) counts[item.status] += 1; });
    var waiting = list.filter(function (item) { return item.status === 'queued' || item.status === 'sending'; }).length;
    var nextTry = list.filter(function (item) { return item.nextTryAt && (item.status === 'queued' || item.status === 'error'); })
      .reduce(function (min, item) { return !min || item.nextTryAt < min ? item.nextTryAt : min; }, 0);
    return {
      enabled: Boolean(cfg.enabled),
      configured: isConfigured(),
      online: isOnline(),
      total: list.length,
      waiting: waiting,
      pendingTotal: waiting + counts.error + counts.rejected,
      counts: counts,
      nextTryAt: nextTry,
      lastSuccess: cfg.lastSuccess || 0,
      lastError: cfg.lastError || 0,
      lastErrorText: cfg.lastErrorText || '',
      lastPing: cfg.lastPing || 0,
      lastPull: cfg.lastPull || 0,
      serverVersion: cfg.serverVersion || '',
      conflicts: cfg.lastConflicts || [],
      user: cfg.user || '',
      device: cfg.deviceLabel || cfg.device || '',
      unsynced: unsyncedShiftOperations().length
    };
  }

  function formatAgo(value) {
    if (!value) return '—';
    var diff = Math.max(0, now() - Number(value));
    if (diff < 60000) return 'только что';
    if (diff < 3600000) return Math.round(diff / 60000) + ' мин назад';
    if (diff < 86400000) return Math.round(diff / 3600000) + ' ч назад';
    return Math.round(diff / 86400000) + ' дн назад';
  }

  function render() {
    if (!root.document || !host) return;
    var data = summary();

    setText('#syncQueueCount', String(data.pendingTotal));
    setText('#syncQueueErrors', String(data.counts.error + data.counts.rejected));
    setText('#syncLastSuccess', data.lastSuccess ? formatAgo(data.lastSuccess) : 'ещё не отправлялось');
    setText('#syncLastError', data.lastError ? data.lastErrorText + ' · ' + formatAgo(data.lastError) : '—');
    setText('#syncServerVersion', data.serverVersion ? 'Web App v' + data.serverVersion + ' · ответ ' + formatAgo(data.lastPing) : '—');
    setText('#syncLastPull', data.lastPull ? formatAgo(data.lastPull) : '—');
    setText('#syncUnsyncedCount', String(data.unsynced));

    var stateLabel = $('#syncTwoWayState');
    if (stateLabel) {
      var label = !data.configured ? 'Двусторонняя синхронизация выключена'
        : !data.online ? 'Нет интернета · операции копятся в очереди'
        : data.counts.rejected ? 'Есть отклонённые операции — требуется внимание'
        : data.counts.error ? 'Ошибки отправки · ' + data.pendingTotal + ' ' + plural(data.pendingTotal, 'операция', 'операции', 'операций') + ' в очереди'
        : data.waiting ? 'Отправляем: ' + data.waiting + ' в очереди'
        : 'Подключено · всё синхронизировано';
      stateLabel.textContent = label;
    }
    var dot = $('#syncTwoWayDot');
    if (dot) dot.className = 'sync-status-dot ' + (!data.configured ? 'is-off' : data.counts.rejected || data.counts.error ? 'is-off' : !data.online || data.pendingTotal ? 'is-warn' : 'is-ok');

    var banner = $('#queueBanner');
    var active = data.enabled && data.pendingTotal > 0;
    if (banner) {
      banner.classList.toggle('hidden', !active);
      var text = banner.querySelector('.queue-banner-text');
      if (active && text) {
        var parts = [];
        if (data.waiting) parts.push(data.waiting + ' ' + plural(data.waiting, 'операция', 'операции', 'операций') + ' ждёт отправки');
        if (data.counts.error) parts.push(data.counts.error + ' ' + plural(data.counts.error, 'ошибка', 'ошибки', 'ошибок') + ' сети');
        if (data.counts.rejected) parts.push(data.counts.rejected + ' ' + plural(data.counts.rejected, 'операция отклонена', 'операции отклонены', 'операций отклонено') + ' складом');
        if (!data.online) parts.push('нет интернета');
        text.textContent = parts.join(' · ');
      }
    }

    var pill = $('#queuePill');
    if (pill) {
      var count = data.pendingTotal;
      pill.classList.toggle('hidden', !(data.enabled && count > 0));
      var pillCount = $('#queuePillCount');
      if (pillCount) pillCount.textContent = count > 99 ? '99+' : String(count);
      pill.classList.toggle('has-rejected', data.counts.rejected > 0);
    }

    var conflicts = $('#syncConflicts');
    if (conflicts && data.conflicts && data.conflicts.length && !conflicts.dataset.rendered) {
      conflicts.classList.remove('hidden');
    }

    if (host && host.updateConnectionLabel) host.updateConnectionLabel();
  }

  function plural(number, one, few, many) {
    var n = Math.abs(number) % 100;
    if (n >= 11 && n <= 19) return many;
    var last = n % 10;
    return last === 1 ? one : last >= 2 && last <= 4 ? few : many;
  }

  function setText(selector, value) {
    var element = host && host.element ? host.element(selector) : (root.document ? root.document.querySelector(selector) : null);
    if (element) element.textContent = value;
  }

  function $(selector) {
    var element = host && host.element ? host.element(selector) : (root.document ? root.document.querySelector(selector) : null);
    return element;
  }

  function statusInfo(status) { return STATUS[status] || STATUS.local; }

  function startTimers() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(function () {
      var cfg = config();
      if (!cfg.enabled) return;
      if (isOnline() && queue().length) flush('heartbeat');
      render();
    }, 60000);

    if (root.addEventListener) {
      root.addEventListener('online', function () { schedule(1500); render(); });
      root.addEventListener('offline', render);
      root.addEventListener('visibilitychange', function () {
        if (root.document && root.document.visibilityState === 'visible') { schedule(800); render(); }
      });
    }
  }

  function updateSettings(patch) {
    var state = host.state();
    state.sync = Object.assign({}, DEFAULTS, state.sync || {}, patch || {});
    if (state.sync.url) state.sync.url = normalizeUrl(state.sync.url);
    if (!state.sync.device) state.sync.device = makeDeviceId();
    save();
    render();
    if (state.sync.enabled && state.sync.autoSend) schedule(400);
    return state.sync;
  }

  function attach(adapter) {
    host = adapter;
    var state = host.state();
    state.sync = Object.assign({}, DEFAULTS, state.sync || {});
    if (!state.sync.device) state.sync.device = makeDeviceId();
    if (!Array.isArray(state.queue)) state.queue = [];
    return api;
  }

  var api = {
    version: SYNC_STATE_VERSION,
    STATUS: STATUS,
    DEFAULTS: DEFAULTS,
    attach: attach,
    config: config,
    updateSettings: updateSettings,
    enqueue: enqueue,
    enqueueAllUnsynced: enqueueAllUnsynced,
    unsyncedShiftOperations: unsyncedShiftOperations,
    flush: flush,
    retryNow: retryNow,
    retryItem: retryItem,
    cancelQueued: cancelQueued,
    discard: discard,
    reversePayload: reversePayload,
    summary: summary,
    render: render,
    ping: ping,
    pullStock: pullStock,
    hasPendingFor: hasPendingFor,
    pendingSkus: pendingSkus,
    pendingProjections: pendingProjections,
    resolveProduct: resolveProduct,
    identityKey: identityKey,
    matchProduct: matchProduct,
    makeOperationId: makeOperationId,
    makeDeviceId: makeDeviceId,
    buildBatchPayload: buildBatchPayload,
    interpretResponse: interpretResponse,
    describeTransportFailure: describeTransportFailure,
    mergeServerStock: mergeServerStock,
    eligibleItems: eligibleItems,
    retryDelay: retryDelay,
    statusInfo: statusInfo,
    formatAgo: formatAgo,
    normalizeUrl: normalizeUrl,
    startTimers: startTimers,
    schedule: schedule,
    queue: queue,
    findItem: findItem
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.FORONESync = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));
