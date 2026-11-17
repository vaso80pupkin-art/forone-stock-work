/**
 * Тестовый стенд: HTTP-сервер, выполняющий НАСТОЯЩИЙ код FORONE_Sync_v2.gs
 * поверх эмулятора Apps Script. Нужен только для сквозной проверки приложения:
 * в боевой среде эту роль играет Google Apps Script Web App.
 *
 * Запуск: node /home/ubuntu/work/tests/mock-webapp.js [порт]
 */
'use strict';
const http = require('http');
const path = require('path');
const { createEnvironment, loadScript } = require('./gs-harness');

const PORT = Number(process.argv[2] || 8099);
const SHEET_ID = 'MOCK_WORKING_COPY';
const SOURCE_ID = 'MOCK_OFFICE_SOURCE';
const SECRET = 'dev-secret-2026';

const SOURCE = [
  ['Артикул', 'Название', 'Категория', 'Длина', 'Остаток на складе'],
  ['H234-YP', 'Лувер 226YHB', 'Лувер', '3000', 15],
  ['H234-YP', 'БП Однотонная глянец', 'Панель', '3000', 45],
  ['K01-135X', 'Лувер 128CHBSIZE', 'Лувер', '3000', 24],
  ['H093-F', 'БП Серия Ткань', 'Панель', '3000', 44],
  ['ПР-40-WH', 'Профиль завершающий White', 'Профиль', '3000', 0]
];

const env = createEnvironment({ spreadsheetId: SHEET_ID, sourceSpreadsheetId: SOURCE_ID, sourceSeed: { 'Октябрь-Ноябрь': SOURCE } });
env.properties.set('FORONE_SPREADSHEET_ID', SHEET_ID);
env.properties.set('FORONE_SHARED_SECRET', SECRET);
const api = loadScript(env, path.join(__dirname, '..', 'FORONE_Sync_v2.gs'));
api.FORONE_setup();

const chaos = { failNext: 0, failMode: 'html' };

function sheetRows(name, width, spreadsheet = env.main) {
  const sheet = spreadsheet.getSheetByName(name);
  if (!sheet) return [];
  return sheet.getDataRange().getValues().map((row) => row.slice(0, width));
}

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600',
    'Content-Type': type + '; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  console.log('[mock] ' + req.method + ' ' + url.pathname + url.search);

  if (req.method === 'OPTIONS') return send(res, 204, '');

  // Служебные ручки теста (не часть Apps Script API).
  if (url.pathname === '/__journal') return send(res, 200, JSON.stringify(sheetRows('FORONE_Операции', 14), null, 1));
  if (url.pathname === '/__stock') return send(res, 200, JSON.stringify(sheetRows('FORONE_Остатки', 15), null, 1));
  if (url.pathname === '/__errors') return send(res, 200, JSON.stringify(sheetRows('FORONE_Ошибки', 9), null, 1));
  if (url.pathname === '/__source') return send(res, 200, JSON.stringify(sheetRows('Октябрь-Ноябрь', 5, env.source), null, 1));
  if (url.pathname === '/__chaos') {
    if (url.searchParams.get('fail')) chaos.failNext = Number(url.searchParams.get('fail'));
    if (url.searchParams.get('mode')) chaos.failMode = url.searchParams.get('mode');
    if (url.searchParams.get('lock') !== null) env.sandbox.__lockBusy = url.searchParams.get('lock') === '1';
    if (url.searchParams.get('sync') === '1') return send(res, 200, JSON.stringify(api.syncForoneStock(), null, 1));
    if (url.searchParams.get('addSku')) {
      const parts = url.searchParams.get('addSku').split('|');
      env.source.getSheetByName('Октябрь-Ноябрь').appendRow(parts);
      return send(res, 200, JSON.stringify({ ok: true, row: parts }));
    }
    if (url.searchParams.get('setSource')) {
      const pair = url.searchParams.get('setSource').split('=');
      const sheet = env.source.getSheetByName('Октябрь-Ноябрь');
      const rows = sheet.getDataRange().getValues();
      const index = rows.findIndex((row) => String(row[0]).trim() === pair[0]);
      if (index >= 0) sheet.getRange(index + 1, 5).setValue(Number(pair[1]));
      return send(res, 200, JSON.stringify({ ok: true, sku: pair[0], value: pair[1] }));
    }
    return send(res, 200, JSON.stringify(Object.assign({ lockBusy: Boolean(env.sandbox.__lockBusy) }, chaos)));
  }
  if (url.pathname === '/__reset') {
    chaos.failNext = 0;
    env.sandbox.__lockBusy = false;
    return send(res, 200, JSON.stringify({ ok: true }));
  }

  // Симуляция сбоев канала связи.
  if (chaos.failNext > 0) {
    chaos.failNext -= 1;
    if (chaos.failMode === 'html') return send(res, 200, '<!doctype html><html><body>Google</body></html>', 'text/html');
    if (chaos.failMode === 'login') return send(res, 200, '<html><body>To view or access this project you need to sign in</body></html>', 'text/html');
    if (chaos.failMode === 'e500') return send(res, 500, 'Server error', 'text/plain');
    if (chaos.failMode === 'busy') return send(res, 503, JSON.stringify({ ok: false, code: 'BUSY', message: 'Сервер занят', retry: true }));
    if (chaos.failMode === 'timeout') return;
  }

  try {
    if (req.method === 'GET') {
      const parameter = {};
      url.searchParams.forEach((value, key) => { parameter[key] = value; });
      return send(res, 200, api.doGet({ parameter }).getContent());
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; if (body.length > 2e6) req.destroy(); });
      req.on('end', () => {
        send(res, 200, api.doPost({ parameter: {}, postData: { type: 'application/json', contents: body } }).getContent());
      });
      return;
    }
  } catch (error) {
    console.error('[mock] ошибка обработчика:', error);
    return send(res, 500, JSON.stringify({ ok: false, code: 'MOCK_CRASH', message: String(error.message || error) }));
  }
  return send(res, 404, JSON.stringify({ ok: false, code: 'NOT_FOUND' }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('[mock] стенд Web App: http://0.0.0.0:' + PORT + '/exec?action=ping&key=' + SECRET);
});
