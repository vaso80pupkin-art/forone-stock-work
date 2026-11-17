/**
 * Мини-эмулятор среды Google Apps Script для офлайн-тестов FORONE_Sync_v2.gs.
 * Реализует ровно те API, которые использует скрипт: SpreadsheetApp, Sheet/Range,
 * LockService, PropertiesService, ContentService, Utilities, Session, Logger.
 */
'use strict';
const fs = require('fs');
const vm = require('vm');

class FakeRange {
  constructor(sheet, row, col, numRows = 1, numCols = 1) {
    this.sheet = sheet;
    this.row = row;
    this.col = col;
    this.numRows = numRows;
    this.numCols = numCols;
  }
  getValues() {
    const out = [];
    for (let r = 0; r < this.numRows; r += 1) {
      const row = [];
      for (let c = 0; c < this.numCols; c += 1) row.push(this.sheet.read(this.row + r, this.col + c));
      out.push(row);
    }
    return out;
  }
  getValue() { return this.sheet.read(this.row, this.col); }
  setValues(matrix) {
    matrix.forEach((rowValues, r) => rowValues.forEach((value, c) => this.sheet.write(this.row + r, this.col + c, value)));
    return this;
  }
  setValue(value) { this.sheet.write(this.row, this.col, value); return this; }
  setFormulas(matrix) { return this.setValues(matrix); }
  setFormula(f) { return this.setValue(f); }
  clearContents() {
    for (let r = 0; r < this.numRows; r += 1) for (let c = 0; c < this.numCols; c += 1) this.sheet.write(this.row + r, this.col + c, '');
    return this;
  }
  // Форматирование — no-op, но цепочки должны работать.
  setFontWeight() { return this; }
  setFontColor() { return this; }
  setBackground() { return this; }
  createFilter() { this.sheet.filter = { range: this }; return { remove: () => { this.sheet.filter = null; } }; }
  autoResizeColumns() { return this; }
}

class FakeSheet {
  constructor(name) {
    this.name = name;
    this.cells = new Map(); // "r,c" -> value
    this.maxRow = 1;
    this.maxCol = 1;
    this.maxGridColumns = 26;
    this.filter = null;
  }
  key(r, c) { return r + ',' + c; }
  read(r, c) { const v = this.cells.get(this.key(r, c)); return v === undefined ? '' : v; }
  write(r, c, value) {
    this.cells.set(this.key(r, c), value);
    if (r > this.maxRow) this.maxRow = r;
    if (c > this.maxCol) this.maxCol = c;
  }
  getName() { return this.name; }
  getLastRow() {
    let last = 0;
    for (const key of this.cells.keys()) {
      const row = Number(key.split(',')[0]);
      if (row > last) last = row;
    }
    return Math.max(last, 0);
  }
  getLastColumn() {
    let last = 0;
    for (const key of this.cells.keys()) {
      const parts = key.split(',');
      const col = Number(parts[1]);
      if (col > last) last = col;
    }
    return Math.max(last, 0);
  }
  getMaxColumns() { return this.maxGridColumns; }
  insertColumnsAfter(afterPosition, howMany) {
    if (afterPosition < 0 || afterPosition > this.maxGridColumns || howMany < 1) throw new Error('Invalid column insertion');
    this.maxGridColumns += howMany;
    return this;
  }
  getRange(row, col, numRows = 1, numCols = 1) { return new FakeRange(this, row, col, numRows, numCols); }
  getDataRange() { return this.getRange(1, 1, Math.max(this.getLastRow(), 1), Math.max(this.getLastColumn(), 1)); }
  getRowData(row) {
    const out = [];
    for (let c = 1; c <= this.getLastColumn(); c += 1) out.push(this.read(row, c));
    return out;
  }
  appendRow(values) {
    const target = Math.max(this.getLastRow(), 0) + 1;
    values.forEach((value, index) => this.write(target, index + 1, value === null ? '' : value));
    return target;
  }
  clearContents() {
    this.cells.clear();
    this.maxRow = 0;
    this.maxCol = 0;
    return this;
  }
  setFrozenRows() { return this; }
  autoResizeColumns() { return this; }
  setColumnWidth() { return this; }
  getFilter() { return this.filter; }
  remove() { this.filter = null; }
  insertSheet() { throw new Error('insertSheet on sheet'); }
}

class FakeSpreadsheet {
  constructor(id, name) {
    this.id = id;
    this.name = name || 'FORONE Тест';
    this.sheets = new Map();
  }
  getName() { return this.name; }
  getUrl() { return 'https://docs.google.com/spreadsheets/d/' + this.id; }
  getSheetByName(name) { return this.sheets.get(name) || null; }
  insertSheet(name) {
    const sheet = new FakeSheet(name);
    this.sheets.set(name, sheet);
    return sheet;
  }
  getSheets() { return Array.from(this.sheets.values()); }
}

function createEnvironment({ spreadsheetId = 'TEST_SHEET_ID', seed = {} } = {}) {
  const registry = new Map();
  const main = new FakeSpreadsheet(spreadsheetId);
  registry.set(spreadsheetId, main);
  Object.keys(seed).forEach((name) => {
    const sheet = main.insertSheet(name);
    (seed[name] || []).forEach((row, index) => row.forEach((value, col) => sheet.write(index + 1, col + 1, value)));
  });

  const properties = new Map();
  const scriptProperties = {
    getProperty: (key) => (properties.has(key) ? properties.get(key) : null),
    setProperty: (key, value) => { properties.set(key, String(value)); return scriptProperties; },
    deleteProperty: (key) => { properties.delete(key); },
    setProperties: (obj) => { Object.keys(obj).forEach((k) => properties.set(k, String(obj[k]))); return scriptProperties; },
    getProperties: () => Object.fromEntries(properties)
  };

  const logs = [];
  const sandbox = {
    JSON, Math, Date, Number, String, Array, Object, Boolean, Set, Map, RegExp, Error, parseInt, parseFloat, isNaN, isFinite, decodeURIComponent, encodeURIComponent,
    console: { log: (...a) => logs.push(['log', a.join(' ')]), error: (...a) => logs.push(['error', a.join(' ')]) },
    SpreadsheetApp: {
      openById: (id) => {
        if (!registry.has(id)) throw new Error('Нет таблицы с ID ' + id);
        return registry.get(id);
      },
      getActiveSpreadsheet: () => null
    },
    LockService: {
      getScriptLock: () => ({
        tryLock: () => true,
        hasLock: () => true,
        releaseLock: () => {}
      })
    },
    // Позволяет в тестах смоделировать занятый лок.
    __lockBusy: false,
    PropertiesService: { getScriptProperties: () => scriptProperties },
    ContentService: {
      MimeType: { JSON: 'JSON' },
      createTextOutput: (content) => ({
        content,
        getContent() { return this.content; },
        setMimeType() { return this; }
      })
    },
    Utilities: {
      formatDate: (date, tz, pattern) => {
        const d = new Date(date);
        const pad = (n) => String(n).padStart(2, '0');
        return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
      },
      getUuid: () => 'uuid-' + Math.random().toString(36).slice(2, 10)
    },
    Session: { getScriptTimeZone: () => 'Asia/Almaty', getActiveUser: () => ({ getEmail: () => 'owner@forone.kz' }) },
    Logger: { log: (msg) => logs.push(['logger', String(msg)]) },
    ScriptApp: {
      getProjectTriggers: () => [],
      deleteTrigger: () => {},
      newTrigger: () => ({ timeBased: () => ({ everyMinutes: () => ({ create: () => {} }) }) })
    }
  };
  sandbox.global = sandbox;

  // Лок можно «занять» из теста: sandbox.__lockBusy = true
  sandbox.LockService.getScriptLock = () => ({
    tryLock: () => !sandbox.__lockBusy,
    hasLock: () => true,
    releaseLock: () => {}
  });

  const context = vm.createContext(sandbox);
  return { sandbox, context, registry, main, properties, logs };
}

function loadScript(env, path) {
  const source = fs.readFileSync(path, 'utf8');
  vm.runInContext(source + '\n;this.__script = { doGet, doPost, syncForoneStock, FORONE_setup, FORONE_selfTest, FORONE_dryRun, FORONE_ping, buildStockPayload_, mergeStockPlan_, validateOperation_, normalizeOperation_, collectOperations_, readTargetRows_, readSheetRows_, STOCK_HEADERS, OP_HEADERS, ERR_HEADERS, COL, newSet_, getForoneSpreadsheet_ };', env.context, { filename: path });
  return env.context.__script;
}

/** Сформировать объект события Web App для POST. */
function postEvent(payload, parameter = {}) {
  return {
    parameter,
    postData: { type: 'application/json', contents: JSON.stringify(payload) }
  };
}

/** Сформировать объект события для GET. */
function getEvent(parameter = {}) {
  return { parameter };
}

/** Разобрать ответ ContentService в JSON. */
function parseOutput(output) {
  return JSON.parse(output.getContent());
}

module.exports = { createEnvironment, loadScript, postEvent, getEvent, parseOutput, FakeSheet, FakeSpreadsheet };
