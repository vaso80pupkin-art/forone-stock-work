const STORAGE_KEY = 'forone-stock-work-state-v2';
const DEFAULT_GOOGLE_SHEET_URL = 'https://docs.google.com/spreadsheets/d/1kD4H7rZ1y5AYi3eEszBZU4-j8_mrj_hcT2WtXB77PK8/edit?usp=drivesdk';
const DEFAULT_GOOGLE_SHEET_NAME = 'FORONE_Остатки';
const SHIFT_KEY = 'forone-stock-work-shift-v2';

const seedProducts = [
  { id: 'p-001', sku: 'Н234-YP', name: 'Бамбуковая панель Natural Oak', category: 'Панель', length: 3000, stock: 36, orderOnly: false, barcode: 'Н234-YP', retired: false, updatedAt: Date.now() },
  { id: 'p-002', sku: 'К01-206N', name: 'Лувер Vertical Graphite', category: 'Лувер', length: 3000, stock: 8, orderOnly: false, barcode: 'К01-206N', retired: false, updatedAt: Date.now() },
  { id: 'p-003', sku: 'ПР-40-WH', name: 'Профиль завершающий White', category: 'Профиль', length: 3000, stock: 0, orderOnly: false, barcode: 'ПР-40-WH', retired: false, updatedAt: Date.now() },
  { id: 'p-004', sku: 'Н318-SM', name: 'Бамбуковая панель Smoky Grey', category: 'Панель', length: 3000, stock: 14, orderOnly: false, barcode: 'Н318-SM', retired: false, updatedAt: Date.now() },
  { id: 'p-005', sku: 'Н401-CL', name: 'Бамбуковая панель Clay, спецзаказ', category: 'Панель', length: 4000, stock: 0, orderOnly: true, barcode: 'Н401-CL', retired: false, updatedAt: Date.now() },
  { id: 'p-006', sku: 'ПР-22-BR', name: 'Соединительный профиль Brown', category: 'Профиль', length: 3000, stock: 52, orderOnly: false, barcode: 'ПР-22-BR', retired: false, updatedAt: Date.now() },
  { id: 'p-007', sku: 'К07-311S', name: 'Лувер Slim Sand', category: 'Лувер', length: 3000, stock: 3, orderOnly: false, barcode: 'К07-311S', retired: false, updatedAt: Date.now() },
  { id: 'p-008', sku: 'Н215-MB', name: 'Бамбуковая панель Matte Black', category: 'Панель', length: 3000, stock: 21, orderOnly: false, barcode: 'Н215-MB', retired: false, updatedAt: Date.now() }
];

const operationLabels = { in: 'Приход', out: 'Расход', writeoff: 'Списание на замер' };
const operationIcons = { in: '+', out: '−', writeoff: '×' };
const monthNames = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

let state = loadState();
let activeView = state.activeView || 'scanner';
const THEME_KEY = 'forone-stock-work-theme-v2';
let activeTheme = localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark';
let selectedProductId = null;
let scannerInstance = null;
let scannerRunning = false;
let visualTimer = null;
let visualBusy = false;
let visualMatched = false;
let pendingScan = null;
let torchEnabled = false;
let torchTrack = null;
let toastTimer = null;
let undoTimer = null;
let undoSnapshot = null;
let activeScanMode = 'check';
const scanModeHelp = { check: 'Только покажет остаток. Количество на складе не изменится.', in: 'Добавит поступившее количество к фактическому остатку.', out: 'Уменьшит остаток. Нельзя списать больше, чем доступно без резерва.', writeoff: 'Уменьшит остаток и запишет списание товара на замер.' };
let catalogQuickFilter = 'all';
let catalogFilters = { length: 'all', availability: 'all', status: 'active' };
let cameraZoom = 1;
let enhanceCamera = true;
let pendingImport = null;
let operationLock = false;

function applyTheme(theme = activeTheme) {
  activeTheme = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = activeTheme;
  const themeMeta = $('meta[name="theme-color"]');
  if (themeMeta) themeMeta.setAttribute('content', activeTheme === 'light' ? '#f3f6f2' : '#0b171a');
  const button = $('#themeToggleBtn');
  const icon = $('#themeToggleIcon');
  const label = $('#themeToggleLabel');
  if (!button || !icon || !label) return;
  const light = activeTheme === 'light';
  icon.textContent = light ? '☀' : '☾';
  label.textContent = light ? 'Светлая' : 'Тёмная';
  const nextLabel = light ? 'Включить тёмную тему' : 'Включить светлую тему';
  button.title = nextLabel;
  button.setAttribute('aria-label', nextLabel);
  button.dataset.tooltip = nextLabel;
}

function toggleTheme() {
  activeTheme = activeTheme === 'light' ? 'dark' : 'light';
  localStorage.setItem(THEME_KEY, activeTheme);
  applyTheme();
}

const $ = (selector, parent = document) => parent.querySelector(selector);
const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];

function loadState() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (stored && Array.isArray(stored.products) && Array.isArray(stored.operations)) {
      stored.products = stored.products.map((product) => ({ warehouse: 'Алматы', zone: '', rack: '', bin: '', reserved: 0, ...product, reserved: Math.min(Math.max(0, Number(product.reserved) || 0), Math.max(0, Number(product.stock) || 0)) }));
      stored.operations = (stored.operations || []).map((operation) => ({ ...operation, syncStatus: operation.syncStatus || 'local' }));
      if (!Array.isArray(stored.queue)) stored.queue = [];
      stored.sync = stored.sync || {};
      stored.source = { googleUrl: DEFAULT_GOOGLE_SHEET_URL, googleEnabled: false, googleSheet: DEFAULT_GOOGLE_SHEET_NAME, googleLastSync: 0, googleLastFetch: 0, googleAutoConfigured: true, ...(stored.source || {}) };
      if (stored.source.googleUrl.includes('1AZnORUbYuI-C3Kv4f3Absh3dGRJ6XQFavi0il4_Tk-c')) stored.source.googleUrl = DEFAULT_GOOGLE_SHEET_URL;
      if (stored.source.googleSheet === 'Октябрь-Ноябрь') stored.source.googleSheet = DEFAULT_GOOGLE_SHEET_NAME;
      if (!stored.source.googleAutoConfigured) { stored.source.googleEnabled = false; stored.source.googleAutoConfigured = true; }
      return stored;
    }
  } catch (error) {
    console.warn('Не удалось прочитать локальную базу', error);
  }
  return { products: seedProducts.map((product) => ({ ...product, reserved: 0, warehouse: 'Алматы', zone: '', rack: '', bin: '' })), operations: [], queue: [], sync: {}, activeView: 'scanner', source: { googleUrl: DEFAULT_GOOGLE_SHEET_URL, googleEnabled: false, googleSheet: DEFAULT_GOOGLE_SHEET_NAME, googleLastSync: 0, googleLastFetch: 0, googleAutoConfigured: true } };
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    localStorage.setItem(SHIFT_KEY, new Date().toISOString());
    updateConnectionLabel();
  } catch (error) {
    showToast('Не удалось сохранить данные', 'error');
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;' }[char]));
}

function formatDate(dateValue, withTime = false) {
  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) return '—';
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  return withTime ? `${day}.${month} · ${time}` : `${day}.${month}.${date.getFullYear()}`;
}

function formatHumanDate(dateValue = Date.now()) {
  const date = new Date(dateValue);
  return `${date.getDate()} ${monthNames[date.getMonth()]}`;
}

function getAvailable(product) { return Math.max(0, Number(product.stock || 0) - Number(product.reserved || 0)); }

function getLocation(product) { return [product.warehouse || 'Алматы', product.zone, product.rack, product.bin].filter(Boolean).join(' · ') || 'Место не указано'; }

function getStatus(product) {
  if (product.orderOnly || Number(product.length) >= 4000) {
    return { key: 'blue', label: 'Только под заказ', short: 'Спецзаказ', note: '4 м · поставка 25–30 дней', comment: 'Спецзаказ, срок поставки 25–30 дней' };
  }
  const stock = getAvailable(product);
  if (stock > 10) return { key: 'green', label: 'В наличии', short: 'Много', note: 'Можно отгружать', comment: 'В наличии на складе' };
  if (stock > 0) return { key: 'yellow', label: 'Заканчивается', short: 'Мало', note: 'Предупредить менеджера', comment: 'Мало на складе, нужна проверка' };
  return { key: 'red', label: 'Нет в наличии', short: 'Нет', note: 'Под заказ 25–30 дней', comment: 'Под заказ, срок поставки 25–30 дней' };
}

function getProduct(id) {
  return state.products.find((product) => product.id === id);
}

function getActiveProducts() {
  return state.products.filter((product) => !product.retired);
}

function updateConnectionLabel() {
  const label = $('#connectionLabel');
  if (!label) return;
  let saved = false;
  try { saved = Boolean(localStorage.getItem(STORAGE_KEY)); } catch (error) { saved = false; }
  if (!saved) {
    label.textContent = navigator.onLine ? 'Онлайн · сохранение ещё не создано' : 'Офлайн · проверьте сохранение';
    return;
  }
  if (window.FORONESync) {
    const summary = FORONESync.summary();
    if (summary.enabled && summary.pendingTotal) { label.textContent = `Ожидает отправки: ${summary.pendingTotal}`; return; }
  }
  const googleSync = state.source?.googleEnabled;
  if (googleSync && state.source?.googleLastSync) {
    const time = new Date(state.source.googleLastSync).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    label.textContent = `${navigator.onLine ? 'Онлайн' : 'Офлайн'} · Google ${time}`;
  } else if (googleSync) {
    label.textContent = navigator.onLine ? 'Онлайн · Google включён' : 'Офлайн · Google ожидает сеть';
  } else {
    label.textContent = navigator.onLine ? 'Онлайн · локально сохранено' : 'Офлайн · локально сохранено';
  }
}

function renderHeader() {
  $('#shiftDate').textContent = formatHumanDate();
  $('#reportDate').textContent = formatDate(Date.now());
  updateConnectionLabel();
}

function renderMetrics() {
  const activeProducts = getActiveProducts();
  const alerts = activeProducts.filter((product) => ['yellow', 'red'].includes(getStatus(product).key)).length;
  $('#metricProducts').textContent = activeProducts.length;
  $('#metricAlerts').textContent = alerts;
  $('#metricOps').textContent = state.operations.length;
  $('#stockCountLabel').textContent = `${activeProducts.length} позиций`;
  $('#navOpsBadge').textContent = state.operations.length > 99 ? '99+' : state.operations.length;
  $('#navOpsBadge').classList.toggle('hidden', state.operations.length === 0);
}

function renderStatusStrip() {
  const active = getActiveProducts();
  const counts = { green: 0, yellow: 0, red: 0, blue: 0 };
  active.forEach((product) => counts[getStatus(product).key]++);
  $('#statusStrip').innerHTML = `
    <button class="status-box status-green" type="button" data-dashboard-filter="in" aria-label="Открыть товары в наличии"><div class="status-num">${counts.green}</div><div class="status-name">В наличии</div></button>
    <button class="status-box status-yellow" type="button" data-dashboard-filter="low" aria-label="Открыть товары с малым остатком"><div class="status-num">${counts.yellow}</div><div class="status-name">Мало</div></button>
    <button class="status-box status-red" type="button" data-dashboard-filter="out" aria-label="Открыть товары без остатка"><div class="status-num">${counts.red}</div><div class="status-name">Нет</div></button>
    <button class="status-box status-blue" type="button" data-dashboard-filter="order" aria-label="Открыть товары под заказ"><div class="status-num">${counts.blue}</div><div class="status-name">Спецзаказ</div></button>`;
}

function openDashboardFilter(filter) {
  setActiveView('catalog');
  catalogQuickFilter = 'all';
  catalogFilters = { length: 'all', availability: 'all', status: 'active' };
  $('#catalogSearch').value = '';
  $('#categoryFilter').value = 'all';
  if (filter === 'catalog') {
    catalogFilters.status = 'active';
  } else if (filter === 'attention') {
    catalogFilters.availability = 'attention';
  } else if (filter === 'reports') {
    setActiveView('reports');
    return;
  } else if (['in', 'low', 'out'].includes(filter)) {
    catalogFilters.availability = filter;
  } else if (filter === 'order') {
    catalogFilters.status = 'order';
  }
  $('#lengthFilter').value = catalogFilters.length;
  $('#availabilityFilter').value = catalogFilters.availability;
  $('#statusFilter').value = catalogFilters.status;
  $$('.quick-filter').forEach((item) => item.classList.toggle('active', item.dataset.filter === 'all'));
  renderCatalog();
}

function operationSyncBlock(operation) {
  const item = window.FORONESync ? FORONESync.findItem(operation.id) : null;
  const statusKey = operation.syncStatus || 'local';
  const status = window.FORONESync ? FORONESync.statusInfo(statusKey) : { short: '—', tone: 'muted', label: 'Статус неизвестен' };
  const detail = item && item.lastError ? item.lastError : status.label;
  const actions = [];
  if (item && item.status === 'error') actions.push(`<button class="op-action" type="button" data-op-action="retry" data-op-id="${escapeHtml(operation.id)}">↻ Повторить</button>`);
  if (item && item.status === 'rejected') {
    actions.push(`<button class="op-action" type="button" data-op-action="retry" data-op-id="${escapeHtml(operation.id)}">↻ Отправить снова</button>`);
    actions.push(`<button class="op-action op-action-danger" type="button" data-op-action="discard" data-op-id="${escapeHtml(operation.id)}">Убрать</button>`);
  }
  if (item && (item.status === 'queued' || item.status === 'error')) actions.push(`<button class="op-action" type="button" data-op-action="cancel" data-op-id="${escapeHtml(operation.id)}">✕ Отменить</button>`);
  if (!item && statusKey === 'synced') actions.push(`<button class="op-action" type="button" data-op-action="revert" data-op-id="${escapeHtml(operation.id)}">↩ Вернуть товар</button>`);
  const attempts = item && item.attempts ? `<small class="op-attempt">попыток: ${item.attempts}</small>` : '';
  return `<div class="operation-sync"><span class="op-status op-status-${status.tone}" title="${escapeHtml(detail)}">${escapeHtml(status.short)}</span>${actions.length ? `<div class="op-actions">${actions.join('')}</div>` : ''}${attempts}${item && item.lastError ? `<small class="op-error-text">${escapeHtml(item.lastError)}</small>` : ''}</div>`;
}

function operationRow(operation) {
  const isIncoming = operation.type === 'in';
  return `<div class="operation-row ${isIncoming ? 'op-in' : operation.type === 'out' ? 'op-out' : 'op-writeoff'}">
    <div class="operation-mark">${operationIcons[operation.type]}</div>
    <div class="operation-info"><div class="operation-code">${escapeHtml(operation.sku)}</div><div class="operation-desc">${escapeHtml(operation.name)} · ${operationLabels[operation.type]}${operation.comment ? ` · ${escapeHtml(operation.comment)}` : ''}</div>${operationSyncBlock(operation)}</div>
    <div class="operation-amount"><strong class="${isIncoming ? 'amount-plus' : 'amount-minus'}">${isIncoming ? '+' : '−'}${operation.qty}</strong><span>${formatDate(operation.createdAt, true)}</span></div>
  </div>`;
}

function renderRecent() {
  const recent = [...state.operations].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 4);
  $('#recentList').innerHTML = recent.length ? recent.map(operationRow).join('') : `<div class="empty-state"><div class="empty-icon">⌁</div><strong>Операций пока нет</strong>Отсканируйте позицию и добавьте первое движение за смену.</div>`;
}

function renderCatalog() {
  const query = ($('#catalogSearch')?.value || '').trim().toLowerCase();
  const category = $('#categoryFilter')?.value || 'all';
  const products = state.products.filter((product) => {
    const haystack = `${product.sku} ${product.name} ${product.category}`.toLowerCase();
    const status = getStatus(product).key;
    const available = getAvailable(product);
    const quick = catalogQuickFilter;
    const quickOk = quick === 'all' || (quick === 'favorites' && Boolean(product.favorite)) || (quick === 'out' && available === 0) || (quick === 'low' && available > 0 && available <= 10) || (quick === '4m' && product.category === 'Панель' && Number(product.length) >= 4000) || (quick === 'louvers' && product.category === 'Лувер') || (quick === 'recent' && Date.now() - new Date(product.updatedAt || 0).getTime() < 7 * 86400000);
    const lengthOk = catalogFilters.length === 'all' || Number(product.length) === Number(catalogFilters.length);
    const availabilityOk = catalogFilters.availability === 'all' || (catalogFilters.availability === 'in' && available > 10) || (catalogFilters.availability === 'low' && available > 0 && available <= 10) || (catalogFilters.availability === 'out' && available === 0) || (catalogFilters.availability === 'attention' && available <= 10);
    const statusOk = catalogFilters.status === 'all' || (catalogFilters.status === 'active' && !product.retired) || (catalogFilters.status === 'order' && !product.retired && (product.orderOnly || Number(product.length) >= 4000)) || (catalogFilters.status === 'reserved' && !product.retired && Number(product.reserved || 0) > 0) || (catalogFilters.status === 'archived' && Boolean(product.retired));
    return quickOk && lengthOk && availabilityOk && statusOk && (category === 'all' || product.category === category) && (!query || haystack.includes(query));
  }).sort((a, b) => a.sku.localeCompare(b.sku, 'ru'));
  $('#catalogSummary').textContent = `${products.length} ${pluralize(products.length, 'позиция', 'позиции', 'позиций')}`;
  const filterActive = catalogFilters.length !== 'all' || catalogFilters.availability !== 'all' || catalogFilters.status !== 'active' || catalogQuickFilter !== 'all' || category !== 'all' || Boolean(query);
  $('#resetFiltersBtn')?.classList.toggle('hidden', !filterActive);
  if ($('#filterSummary')) { const labels = []; if (catalogFilters.length !== 'all') labels.push(catalogFilters.length === '4000' ? '4 м' : '3 м'); if (catalogFilters.availability !== 'all') labels.push({ in: 'В наличии', low: 'Мало', out: 'Нет', attention: 'Нужен контроль' }[catalogFilters.availability]); if (catalogFilters.status !== 'active') labels.push({ all: 'Все статусы', order: 'Под заказ', reserved: 'С резервом', archived: 'Архив' }[catalogFilters.status]); $('#filterSummary').textContent = labels.length ? `Фильтры: ${labels.join(' · ')}` : ''; $('#filterSummary').classList.toggle('hidden', labels.length === 0); }
  if (!products.length) {
    $('#catalogList').innerHTML = `<div class="empty-state"><div class="empty-icon">⌕</div><strong>Ничего не найдено</strong>Измените фильтр или добавьте новую позицию.</div>`;
    return;
  }
  $('#catalogList').innerHTML = products.map((product) => {
    const status = getStatus(product);
    return `<article class="catalog-card status-${status.key} ${product.retired ? 'retired' : ''}" data-product-id="${escapeHtml(product.id)}">
      <div class="catalog-card-top"><div><div class="catalog-code">${escapeHtml(product.sku)}</div><div class="catalog-name">${escapeHtml(product.name)}</div></div><div class="catalog-card-tools"><button class="favorite-button ${product.favorite ? 'is-favorite' : ''}" type="button" data-action="favorite" aria-label="${product.favorite ? 'Убрать из избранного' : 'Добавить в избранное'}" aria-pressed="${Boolean(product.favorite)}">${product.favorite ? '★' : '☆'}</button>${product.retired ? '<span class="retired-label">СНЯТО</span>' : `<span class="status-badge status-${status.key}">${escapeHtml(status.short)}</span>`}</div></div>
      <div class="catalog-meta"><div class="catalog-tags"><span class="tag">${escapeHtml(product.category)}</span><span class="tag">${Number(product.length) >= 4000 ? '4 м' : '3 м'}</span><span class="tag">Дост. ${getAvailable(product)} · Рез. ${Number(product.reserved || 0)}</span></div>${product.retired ? '' : `<div class="stock-edit"><button data-stock-delta="-1" aria-label="Уменьшить остаток">−</button><input data-stock-input type="number" min="0" value="${Math.max(0, Number(product.stock) || 0)}" aria-label="Остаток ${escapeHtml(product.sku)}" /><button data-stock-delta="1" aria-label="Увеличить остаток">+</button></div>`}</div>
      <div class="catalog-location">${escapeHtml(getLocation(product))}</div><div class="catalog-actions">${product.retired ? `<button class="mini-button" data-action="restore">↻ Вернуть в каталог</button>` : `<button class="mini-button" data-action="edit">Редактировать</button><button class="mini-button retire" data-action="retire">Снять с производства</button>`}</div>
    </article>`;
  }).join('');
}

function pluralize(number, one, few, many) {
  const n = Math.abs(number) % 100;
  if (n >= 11 && n <= 19) return many;
  const last = n % 10;
  return last === 1 ? one : last >= 2 && last <= 4 ? few : many;
}

function renderReports() {
  const uniqueItems = new Set(state.operations.map((operation) => operation.productId));
  const units = state.operations.reduce((sum, operation) => sum + Number(operation.qty || 0), 0);
  $('#reportItemsCount').textContent = uniqueItems.size;
  $('#reportUnitsCount').textContent = units;
  const operations = [...state.operations].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  $('#operationsList').innerHTML = operations.length ? operations.map(operationRow).join('') : `<div class="empty-state"><div class="empty-icon">◒</div><strong>Журнал чист</strong>Добавленные приход, расход и списание появятся здесь.</div>`;
  if (window.FORONESync) FORONESync.render();
}

function renderAll() {
  renderHeader();
  renderMetrics();
  renderStatusStrip();
  renderRecent();
  renderCatalog();
  renderReports();
  setActiveView(activeView, false);
}

function setActiveView(viewName, save = true) {
  activeView = viewName;
  $$('.view').forEach((view) => view.classList.toggle('active', view.id === `view-${viewName}`));
  $$('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === viewName));
  if (save) { state.activeView = viewName; saveState(); }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function openBackdrop(id) {
  const backdrop = $(`#${id}`);
  if (!backdrop) return;
  backdrop.classList.remove('hidden');
  backdrop.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
}

function closeBackdrop(id) {
  const backdrop = $(`#${id}`);
  if (!backdrop) return;
  backdrop.classList.add('hidden');
  backdrop.setAttribute('aria-hidden', 'true');
  if ($$('.modal-backdrop:not(.hidden)').length === 0) document.body.style.overflow = '';
}

function captureUndo() {
  undoSnapshot = JSON.stringify(state);
  clearTimeout(undoTimer);
  undoTimer = setTimeout(() => { undoSnapshot = null; }, 5000);
}

function undoLastAction() {
  if (!undoSnapshot) return;
  try {
    state = JSON.parse(undoSnapshot);
    undoSnapshot = null;
    clearTimeout(undoTimer);
    saveState();
    renderAll();
    showToast('Последнее действие отменено');
  } catch (_) {
    showToast('Не удалось отменить действие', 'error');
  }
}

function showToast(message, tone = 'success', canUndo = false) {
  const toast = $('#toast');
  $('#toastMessage').textContent = message;
  $('.toast-icon', toast).textContent = tone === 'error' ? '!' : '✓';
  $('.toast-icon', toast).style.color = tone === 'error' ? 'var(--red)' : 'var(--green)';
  const undoButton = $('#toastUndoBtn');
  undoButton.classList.toggle('hidden', !canUndo || !undoSnapshot);
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2800);
}

function openProductModal(productId) {
  const product = getProduct(productId);
  if (!product) return;
  selectedProductId = productId;
  const status = getStatus(product);
  const initialType = activeScanMode === 'check' ? 'check' : activeScanMode;
  const primaryLabel = initialType === 'check' ? 'Проверить наличие' : 'Добавить в смену';
  $('#productModalContent').innerHTML = `<div class="product-modal-head"><p class="eyebrow">Карточка позиции · Алматы</p><div class="product-code-large" id="productModalTitle">${escapeHtml(product.sku)} <span class="tag">${escapeHtml(product.category)}</span></div><div class="product-name-large">${escapeHtml(product.name)}</div></div>
    <div class="product-status-panel status-${status.key}"><div><div class="status-title">${escapeHtml(status.label)}</div><div class="status-note">${escapeHtml(status.note)}</div></div><div class="product-status-stock"><strong>${Math.max(0, Number(product.stock) || 0)}</strong><span>факт · доступно ${getAvailable(product)}</span><small>резерв ${Number(product.reserved || 0)}</small></div></div>
    <div class="product-facts"><div class="fact"><span>Место хранения</span><strong>${escapeHtml(getLocation(product))}</strong></div><div class="fact"><span>Длина</span><strong>${Number(product.length) >= 4000 ? '4 м · 4000 мм' : '3 м · 3000 мм'}</strong></div><div class="fact"><span>Код сканера</span><strong>${escapeHtml(product.barcode || product.sku)}</strong></div><div class="fact"><span>Срок</span><strong>${status.key === 'green' ? 'Отгрузка' : '25–30 дней'}</strong></div></div>
    <label class="field-label" for="operationType">Тип операции</label><div class="operation-select-row"><select id="operationType"><option value="check" ${initialType === 'check' ? 'selected' : ''}>Проверить наличие</option><option value="in" ${initialType === 'in' ? 'selected' : ''}>Приход</option><option value="out" ${initialType === 'out' ? 'selected' : ''}>Расход</option><option value="writeoff" ${initialType === 'writeoff' ? 'selected' : ''}>Списание на замер</option></select><input class="comment-input" id="operationComment" placeholder="Комментарий, клиент или замер" /></div>
    <label class="field-label" for="operationQty">Количество, шт.</label><div class="quantity-control"><button type="button" id="qtyMinus" aria-label="Уменьшить количество">−</button><input class="quantity-input" id="operationQty" type="number" min="1" inputmode="numeric" value="1" /><button type="button" id="qtyPlus" aria-label="Увеличить количество">+</button></div>
    <div class="product-primary-row"><button class="secondary-action" type="button" data-close-modal>Отмена</button><button class="primary-action" type="button" id="addOperationBtn"><span>${initialType === 'check' ? '⌕' : '＋'}</span> ${primaryLabel}</button></div>`;
  openBackdrop('modalBackdrop');
  $('#qtyMinus').addEventListener('click', () => setQuantity(-1));
  $('#qtyPlus').addEventListener('click', () => setQuantity(1));
  $('#addOperationBtn').addEventListener('click', addOperationFromModal);
  $('.product-primary-row [data-close-modal]').addEventListener('click', () => closeBackdrop('modalBackdrop'));
}

function setQuantity(delta) {
  const input = $('#operationQty');
  const value = Math.max(1, Number(input.value || 1) + delta);
  input.value = value;
}

function addOperationFromModal() {
  const product = getProduct(selectedProductId);
  const qty = Math.max(1, Math.floor(Number($('#operationQty').value) || 0));
  const type = $('#operationType').value === 'check' ? activeScanMode : $('#operationType').value;
  const comment = $('#operationComment').value.trim();
  if (!product || !qty) return;
  if (type === 'check') { closeBackdrop('modalBackdrop'); showToast(`${product.sku}: доступно ${getAvailable(product)} шт. · резерв ${Number(product.reserved || 0)}`); return; }
  if (type !== 'in' && qty > getAvailable(product)) {
    showToast(`Недостаточно остатка: доступно ${getAvailable(product)} шт.`, 'error');
    return;
  }
  if (operationLock) { showToast('Уже обрабатывается — подождите секунду', 'error'); return; }
  operationLock = true;
  setTimeout(() => { operationLock = false; }, 600);
  const submitButton = $('#addOperationBtn');
  if (submitButton) { submitButton.disabled = true; submitButton.classList.add('is-busy'); }

  captureUndo();
  product.stock = Math.max(0, Number(product.stock || 0) + (type === 'in' ? qty : -qty));
  product.updatedAt = Date.now();
  const operation = { id: FORONESync.makeOperationId(), productId: product.id, sku: product.sku, name: product.name, category: product.category, length: product.length, qty, type, comment, createdAt: new Date().toISOString(), stockAfter: product.stock, syncStatus: 'local' };
  state.operations.push(operation);
  saveState();
  closeBackdrop('modalBackdrop');
  renderAll();
  FORONESync.enqueue(operation);
  const syncSummary = FORONESync.summary();
  const suffix = !syncSummary.enabled ? ' · сохранено локально' : syncSummary.waiting ? ` · в очереди: ${syncSummary.waiting}` : ' · отправляем…';
  showToast(`${operationLabels[type]} добавлен: ${product.sku}${suffix}`, 'success', true);
}

function handleOperationAction(event) {
  const button = event.target.closest('[data-op-action]');
  if (!button) return;
  const id = button.dataset.opId;
  const action = button.dataset.opAction;
  if (action === 'retry') {
    button.disabled = true;
    button.textContent = 'Отправляем…';
    Promise.resolve(FORONESync.retryItem(id)).then(() => renderAll());
    return;
  }
  if (action === 'discard') {
    if (!confirm('Убрать эту операцию из очереди? В Google Таблицу она не попадёт.')) return;
    FORONESync.discard(id);
    renderAll();
    showToast('Операция убрана из очереди');
    return;
  }
  if (action === 'cancel') { cancelOperation(id); return; }
  if (action === 'revert') { revertOperation(id); }
}

function cancelOperation(id) {
  const operation = state.operations.find((item) => item.id === id);
  const item = FORONESync.findItem(id);
  if (!operation || !item) return;
  if (!confirm('Отменить операцию и вернуть количество на склад? В Google Таблицу она не уйдёт.')) return;
  captureUndo();
  FORONESync.cancelQueued(id);
  const product = getProduct(operation.productId) || state.products.find((candidate) => candidate.sku === operation.sku);
  if (product) {
    product.stock = Math.max(0, Number(product.stock || 0) + (operation.type === 'in' ? -operation.qty : operation.qty));
    product.updatedAt = Date.now();
  }
  state.operations = state.operations.filter((candidate) => candidate.id !== id);
  saveState();
  renderAll();
  showToast(`Операция ${operation.sku} отменена, остаток возвращён`, 'success', true);
}

function revertOperation(id) {
  const operation = state.operations.find((item) => item.id === id);
  if (!operation) return;
  if (!confirm(`Вернуть ${operation.qty} шт. ${operation.sku} на склад? Будет создана обратная операция.`)) return;
  const product = getProduct(operation.productId) || state.products.find((candidate) => candidate.sku === operation.sku);
  if (!product) { showToast('Позиция не найдена в каталоге', 'error'); return; }
  const reverse = FORONESync.reversePayload({ operationId: operation.id, sku: product.sku, name: product.name, category: product.category, type: operation.type, qty: operation.qty, comment: operation.comment || '' });
  captureUndo();
  const incoming = reverse.type === 'in';
  if (!incoming && operation.qty > getAvailable(product)) { showToast(`Нельзя вернуть: доступно ${getAvailable(product)} шт.`, 'error'); return; }
  product.stock = Math.max(0, Number(product.stock || 0) + (incoming ? reverse.qty : -reverse.qty));
  product.updatedAt = Date.now();
  const record = { id: reverse.operationId, productId: product.id, sku: product.sku, name: product.name, category: product.category, length: product.length, qty: reverse.qty, type: reverse.type, comment: reverse.comment, createdAt: reverse.createdAt, stockAfter: product.stock, syncStatus: 'local' };
  state.operations.push(record);
  saveState();
  renderAll();
  FORONESync.enqueue(record);
  showToast(`Возврат оформлен: ${product.sku} +${reverse.qty}`, 'success', true);
}

function openEditor(productId = null) {
  $('#productForm').reset();
  $('#editProductId').value = productId || '';
  $('#editorEyebrow').textContent = productId ? 'Редактирование позиции' : 'Новая позиция';
  $('#editorTitle').textContent = productId ? 'Изменить в каталоге' : 'Добавить в каталог';
  if (productId) {
    const product = getProduct(productId);
    if (!product) return;
    $('#formSku').value = product.sku;
    $('#formName').value = product.name;
    $('#formCategory').value = product.category;
    $('#formLength').value = String(product.length);
    $('#formStock').value = product.stock;
    $('#formReserved').value = product.reserved || 0;
    $('#formWarehouse').value = product.warehouse || 'Алматы';
    $('#formZone').value = product.zone || '';
    $('#formRack').value = product.rack || '';
    $('#formBin').value = product.bin || '';
    $('#formOrderOnly').checked = Boolean(product.orderOnly);
    $('#formBarcode').value = product.barcode || '';
  } else {
    $('#formLength').value = '3000';
    $('#formStock').value = '0';
  }
  openBackdrop('editorModal');
  setTimeout(() => $('#formSku').focus(), 150);
}

function submitProductForm(event) {
  event.preventDefault();
  const id = $('#editProductId').value;
  const sku = $('#formSku').value.trim();
  const duplicate = state.products.find((product) => product.sku.toLowerCase() === sku.toLowerCase() && product.id !== id);
  if (duplicate) { showToast('Такой артикул уже есть в каталоге', 'error'); return; }
  const data = { sku, name: $('#formName').value.trim(), category: $('#formCategory').value, length: Number($('#formLength').value), stock: Math.max(0, Number($('#formStock').value) || 0), reserved: Math.min(Math.max(0, Number($('#formReserved').value) || 0), Math.max(0, Number($('#formStock').value) || 0)), warehouse: $('#formWarehouse').value.trim() || 'Алматы', zone: $('#formZone').value.trim(), rack: $('#formRack').value.trim(), bin: $('#formBin').value.trim(), orderOnly: $('#formOrderOnly').checked, barcode: $('#formBarcode').value.trim() || sku, updatedAt: Date.now() };
  if (!data.sku || !data.name) { showToast('Заполните артикул и название', 'error'); return; }
  if (id) {
    const product = getProduct(id);
    captureUndo();
    Object.assign(product, data);
    showToast('Позиция обновлена', 'success', true);
  } else {
    captureUndo();
    state.products.push({ id: `p-${Date.now()}`, ...data, retired: false });
    showToast('Новая позиция добавлена', 'success', true);
  }
  saveState();
  closeBackdrop('editorModal');
  renderAll();
}

function handleCatalogClick(event) {
  const card = event.target.closest('[data-product-id]');
  if (!card) return;
  const product = getProduct(card.dataset.productId);
  if (!product) return;
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (action === 'favorite') {
    captureUndo();
    product.favorite = !product.favorite;
    product.updatedAt = Date.now();
    saveState();
    renderCatalog();
    showToast(product.favorite ? 'Добавлено в избранное' : 'Удалено из избранного', 'success', true);
    return;
  }
  if (action === 'edit') return openEditor(product.id);
  if (action === 'retire') {
    if (confirm(`Снять «${product.sku}» с производства? Позиция останется в архиве.`)) {
      captureUndo(); product.retired = true; product.updatedAt = Date.now(); saveState(); renderAll(); showToast('Позиция перенесена в архив', 'success', true);
    }
    return;
  }
  if (action === 'restore') {
    captureUndo(); product.retired = false; product.updatedAt = Date.now(); saveState(); renderAll(); showToast('Позиция возвращена в каталог', 'success', true);
  }
  if (event.target.closest('[data-stock-delta]')) {
    const delta = Number(event.target.closest('[data-stock-delta]').dataset.stockDelta);
    captureUndo();
    product.stock = Math.max(0, Number(product.stock || 0) + delta);
    product.updatedAt = Date.now(); saveState(); renderAll(); showToast('Остаток изменён', 'success', true);
  }
}

function handleCatalogStockInput(event) {
  if (!event.target.matches('[data-stock-input]')) return;
  const card = event.target.closest('[data-product-id]');
  const product = getProduct(card?.dataset.productId);
  if (!product) return;
  captureUndo();
  product.stock = Math.max(0, Math.floor(Number(event.target.value) || 0));
  product.updatedAt = Date.now();
  saveState();
  renderMetrics(); renderStatusStrip(); renderRecent(); renderReports(); showToast('Остаток изменён', 'success', true);
}

function renderSearchResults() {
  const input = $('#searchInput');
  const query = input.value.trim().toLowerCase();
  $('#clearSearch').classList.toggle('hidden', !query);
  if (!query) { $('#searchResults').classList.add('hidden'); return; }
  const results = getActiveProducts().filter((product) => `${product.sku} ${product.name} ${product.category}`.toLowerCase().includes(query)).slice(0, 7);
  $('#searchResults').classList.remove('hidden');
  $('#searchResults').innerHTML = results.length ? results.map((product) => {
    const status = getStatus(product);
    return `<div class="search-result" data-search-product="${escapeHtml(product.id)}"><span class="status-badge status-${status.key}">${escapeHtml(status.short)}</span><div class="result-main"><div class="result-code">${escapeHtml(product.sku)}</div><div class="result-name">${escapeHtml(product.name)}</div></div><div class="result-stock"><strong>${product.stock}</strong>шт.</div></div>`;
  }).join('') : '<div class="no-results">Позиция не найдена. Проверьте артикул или добавьте ее в каталог.</div>';
}

function findProductsByCode(code) {
  const normalized = String(code || '').trim().toLowerCase();
  return getActiveProducts().filter((product) => [product.sku, product.barcode, product.name].some((value) => String(value || '').toLowerCase() === normalized));
}
function findProductByCode(code) { return findProductsByCode(code)[0]; }
function sameImportedProduct(product, sku, category, name = '') {
  return product.sku.toLowerCase() === sku.toLowerCase() && product.category === category && (!name || product.name.trim().toLowerCase() === name.trim().toLowerCase());
}

function setVisualStatus(message, visible = true) {
  const status = $('#visualStatus');
  if (!status) return;
  status.textContent = message;
  status.classList.toggle('hidden', !visible);
}

function stopVisualRecognition() {
  clearInterval(visualTimer);
  visualTimer = null;
  visualBusy = false;
  setVisualStatus('', false);
}


function createProcessedFrame(video) {
  const canvas = document.createElement('canvas'); const width = Math.min(720, video.videoWidth || 720); const height = Math.round(width * (video.videoHeight / Math.max(1, video.videoWidth)));
  canvas.width = width; canvas.height = height; const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.filter = enhanceCamera ? 'contrast(1.28) brightness(1.10) saturate(1.08)' : 'none'; ctx.drawImage(video, 0, 0, width, height); if (!enhanceCamera) return canvas;
  const image = ctx.getImageData(0, 0, width, height); const src = image.data; const out = new Uint8ClampedArray(src); const strength = 0.22;
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) { const i = (y * width + x) * 4; for (let c = 0; c < 3; c++) { const blur = (src[i - 4 + c] + src[i + 4 + c] + src[i - width * 4 + c] + src[i + width * 4 + c]) / 4; out[i + c] = Math.max(0, Math.min(255, src[i + c] + (src[i + c] - blur) * strength)); } }
  image.data.set(out); ctx.putImageData(image, 0, 0); return canvas;
}

function applyCameraEnhancement() {
  const video = $('#reader video');
  if (video) video.style.filter = enhanceCamera ? 'contrast(1.22) saturate(1.08) brightness(1.08)' : 'none';
}
async function applyCameraZoom(delta) {
  const track = torchTrack || getCameraTrack();
  const caps = track?.getCapabilities?.();
  if (!track || !caps?.zoom) { showToast('Масштаб не поддерживается этой камерой', 'error'); return; }
  cameraZoom = Math.min(Number(caps.zoom.max || 3), Math.max(Number(caps.zoom.min || 1), cameraZoom + delta));
  try { await track.applyConstraints({ advanced: [{ zoom: cameraZoom }] }); $('#zoomLabel').textContent = `Масштаб ${cameraZoom.toFixed(1)}×`; } catch (_) { showToast('Не удалось изменить масштаб камеры', 'error'); }
}
function tuneCameraLowLight() {
  const track = torchTrack || getCameraTrack(); if (!track) return;
  const caps = track.getCapabilities?.() || {}; const advanced = [];
  if (caps.focusMode?.includes('continuous')) advanced.push({ focusMode: 'continuous' });
  if (caps.exposureMode?.includes('continuous')) advanced.push({ exposureMode: 'continuous' });
  if (caps.brightness) advanced.push({ brightness: Math.min(caps.brightness.max || 1, Math.max(caps.brightness.min || 0, 0.7)) });
  if (advanced.length) track.applyConstraints({ advanced }).catch(() => {});
}

function updateTorchButton() {
  const button = $('#torchBtn');
  const label = $('#torchLabel');
  if (!button || !label) return;
  button.classList.toggle('active', torchEnabled);
  button.setAttribute('aria-pressed', String(torchEnabled));
  label.textContent = torchEnabled ? 'Подсветка включена' : 'Подсветка';
}

function getCameraTrack() {
  const video = $('#reader video');
  return video?.srcObject?.getVideoTracks?.()[0] || null;
}

async function toggleTorch() {
  const track = torchTrack || getCameraTrack();
  if (!track) {
    showToast('Сначала включите камеру', 'error');
    return;
  }
  const capabilities = track.getCapabilities?.();
  if (!capabilities?.torch) {
    showToast('Фонарик не поддерживается этой камерой', 'error');
    return;
  }
  try {
    torchTrack = track;
    torchEnabled = !torchEnabled;
    await track.applyConstraints({ advanced: [{ torch: torchEnabled }] });
    updateTorchButton();
    showToast(torchEnabled ? 'Подсветка включена' : 'Подсветка выключена');
  } catch (error) {
    torchEnabled = false;
    updateTorchButton();
    showToast('Не удалось включить подсветку камеры', 'error');
  }
}

function renderScanSuggestion(candidate) {
  const button = $('#scanSuggestion');
  if (!button) return;
  pendingScan = candidate;
  if (!candidate) {
    button.classList.add('hidden');
    return;
  }
  const code = candidate.kind === 'code' ? candidate.code : candidate.match.code;
  const info = candidate.kind === 'code'
    ? (candidate.product ? `${candidate.product.name} · найдено в каталоге` : 'Код найден, позиции пока нет в каталоге')
    : `${candidate.match.series || 'Панель'} · уверенность ${candidate.match.confidence}%${candidate.match.alternatives?.length ? ` · ещё ${candidate.match.alternatives.length} похожих` : ''}`;
  $('#suggestionCode').textContent = code || '—';
  $('#suggestionInfo').textContent = info;
  const alternatives = candidate.kind === 'visual' ? (candidate.match.alternatives || []) : [];
  const old = button.querySelector('.similar-list'); if (old) old.remove();
  if (alternatives.length) { const list = document.createElement('div'); list.className = 'similar-list'; list.innerHTML = alternatives.map((item, index) => `<span data-alt-index="${index}">${escapeHtml(item.code)} · ${item.confidence}%</span>`).join(''); button.appendChild(list); }
  button.classList.remove('hidden');
}

function handleCodeMatch(code) {
  const product = findProductByCode(code);
  closeBackdrop('scannerModal');
  if (product) {
    const matches = findProductsByCode(code);
    if (matches.length > 1) {
      setActiveView('catalog');
      const search = $('#catalogSearch');
      if (search) { search.value = code; renderCatalog(); }
      showToast(`Артикул ${code} найден в ${matches.length} позициях. Выберите категорию в каталоге.`);
      return;
    }
    openProductModal(product.id);
    showToast(`Код подтвержден: ${product.sku}`);
    return;
  }
  openEditor();
  $('#formSku').value = code || '';
  $('#formName').value = 'Позиция по коду сканера';
  $('#formCategory').value = 'Панель';
  $('#formLength').value = '3000';
  $('#formStock').value = '0';
  $('#formBarcode').value = code || '';
  showToast(`Код ${code} новый — сохраните позицию в каталоге.`);
}

async function acceptScanSuggestion() {
  if (!pendingScan) {
    showToast('Сначала наведите камеру на код или панель', 'error');
    return;
  }
  const candidate = pendingScan;
  pendingScan = null;
  visualMatched = true;
  await stopScanner();
  renderScanSuggestion(null);
  if (candidate.kind === 'code') handleCodeMatch(candidate.code);
  else handleVisualMatch(candidate.match);
}

function handleVisualMatch(match) {
  if (!match) return;
  const product = findProductByCode(match.code);
  closeBackdrop('scannerModal');
  if (product) {
    openProductModal(product.id);
    showToast(`Распознано: ${match.code} · ${match.series || 'панель'}`);
    return;
  }
  openEditor();
  $('#formSku').value = match.code || '';
  $('#formName').value = `Бамбуковая панель · ${match.series || 'визуально распознано'}`;
  $('#formCategory').value = 'Панель';
  $('#formLength').value = '3000';
  $('#formStock').value = '0';
  $('#formBarcode').value = match.code || '';
  showToast(`Распознано: ${match.code}. Сохраните новую позицию в каталоге.`);
}

function startVisualRecognition() {
  stopVisualRecognition();
  if (!window.PanelVisualMatcher) {
    setVisualStatus('Визуальное распознавание недоступно — код всё равно можно сканировать.', true);
    return;
  }
  setVisualStatus('Готовлю базу изображений панелей…', true);
  window.PanelVisualMatcher.prepare((done, total) => {
    if (scannerRunning) setVisualStatus(`База панелей: ${done} из ${total}`, true);
  }).then(() => {
    if (!scannerRunning) return;
    setVisualStatus('Наведите камеру на код или лицевую поверхность панели', true);
    visualTimer = setInterval(async () => {
      if (!scannerRunning || visualBusy || visualMatched) return;
      const video = $('#reader video');
      if (!video || video.readyState < 2) return;
      visualBusy = true;
      try {
        const match = await window.PanelVisualMatcher.match(createProcessedFrame(video));
        if (match) {
          setVisualStatus(`Уверенность: ${match.confidence}%. ${match.confidence < 60 ? 'Показаны похожие варианты.' : 'Можно подтвердить результат.'}`, true);
          renderScanSuggestion({ kind: 'visual', match });
        }
      } finally {
        visualBusy = false;
      }
    }, 900);
  }).catch(() => setVisualStatus('Не удалось подготовить базу изображений. Используйте код панели.', true));
}

async function startScanner() {
  openBackdrop('scannerModal');
  visualMatched = false;
  torchEnabled = false;
  torchTrack = null;
  updateTorchButton();
  renderScanSuggestion(null);
  $('#scannerHint').textContent = 'Запрашиваем доступ к камере…';
  if (!window.Html5Qrcode) {
    $('#scannerHint').textContent = 'Библиотека сканирования недоступна. Используйте ввод кода вручную.';
    return;
  }
  try {
    if (scannerInstance) await stopScanner();
    scannerInstance = new Html5Qrcode('reader');
    await scannerInstance.start({ facingMode: 'environment' }, { fps: 10, qrbox: { width: 220, height: 160 }, aspectRatio: 1.25 }, async (decodedText) => {
      const product = findProductByCode(decodedText);
      if (pendingScan?.kind === 'code' && pendingScan.code === decodedText) return;
      renderScanSuggestion({ kind: 'code', code: decodedText, product });
    }, () => {});
    scannerRunning = true;
    applyCameraEnhancement();
    tuneCameraLowLight();
    torchTrack = getCameraTrack();
    $('#scannerHint').textContent = 'Наведите рамку на код или лицевую поверхность панели.';
    startVisualRecognition();
  } catch (error) {
    console.warn('Camera scanner error', error);
    $('#scannerHint').textContent = 'Не удалось открыть камеру. Проверьте разрешение или введите код вручную.';
  }
}

async function stopScanner() {
  stopVisualRecognition();
  if (torchTrack && torchEnabled) {
    try { await torchTrack.applyConstraints({ advanced: [{ torch: false }] }); } catch (error) { console.warn('Torch reset error', error); }
  }
  torchEnabled = false;
  torchTrack = null;
  updateTorchButton();
  if (!scannerInstance) return;
  try { if (scannerRunning) await scannerInstance.stop(); scannerInstance.clear(); } catch (error) { console.warn('Scanner stop error', error); }
  scannerRunning = false;
  scannerInstance = null;
}

async function manualCodeLookup() {
  const code = prompt('Введите артикул или код сканирования');
  if (!code) return;
  await stopScanner();
  const product = findProductByCode(code);
  if (product) {
    handleCodeMatch(code);
  } else {
    handleCodeMatch(code);
  }
}

function normalizedKey(value) {
  return String(value ?? '').toLowerCase().replace(/[\s_\-./№:()]/g, '');
}

function readRowValue(row, aliases) {
  const entries = Object.entries(row);
  const keys = aliases.map(normalizedKey);
  const entry = entries.find(([key]) => keys.includes(normalizedKey(key)));
  return entry ? entry[1] : '';
}

function isSummaryRow(row) {
  const sku = String(readRowValue(row, ['Артикул', 'SKU', 'Код', 'Article', 'Номенклатура', 'COLOR NO.']) || '').trim().toLowerCase();
  const name = String(readRowValue(row, ['Название', 'Наименование', 'Товар', 'Name', 'PRODUCT NAME', 'Описание']) || '').trim();
  return /^(итого|всего|total)(\b|\s)/i.test(sku) || (sku && !name);
}

function parseImportedLength(value) {
  const stringValue = String(value ?? '').toLowerCase().replace(/\s+/g, ' ');
  return /4000|(?:^|[^0-9])4\s*м(?:\b|$)|4\s*метр/.test(stringValue) ? 4000 : 3000;
}

function parseImportedCategory(value) {
  const valueString = String(value ?? '').toLowerCase();
  if (valueString.includes('лувер') || valueString.includes('louver')) return 'Лувер';
  if (valueString.includes('проф')) return 'Профиль';
  return 'Панель';
}

function parseImportedStock(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.round(value));
  let text = String(value ?? '').trim().replace(/\u00a0/g, '').replace(/\s/g, '').replace(/[^\d,.-]/g, '');
  if (!text) return 0;
  const comma = text.lastIndexOf(','), dot = text.lastIndexOf('.');
  const lastSeparator = Math.max(comma, dot);
  const fractionDigits = lastSeparator >= 0 ? text.length - lastSeparator - 1 : 0;
  if (comma >= 0 && dot >= 0) {
    text = fractionDigits <= 2 ? text.replace(/[.,](?=.*[.,])/g, '').replace(',', '.') : text.replace(/[.,]/g, '');
  } else if (fractionDigits > 0 && fractionDigits <= 2) {
    text = text.replace(',', '.');
  } else {
    text = text.replace(/[.,]/g, '');
  }
  const parsed = Number(text);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 0;
}

function isArticleHeader(value) {
  const key = normalizedKey(value);
  return ['артикул', 'sku', 'код', 'article', 'номенклатура', 'colorno'].includes(key);
}

function isStockHeader(value) {
  const key = normalizedKey(value);
  return ['остаток', 'остатокнаскладе', 'остатокпослепоступлениятовара', 'количество', 'колв', 'qty', 'stock', 'алматыналичии'].includes(key);
}

function inspectInventorySheet(sheet) {
  const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', blankrows: false });
  let headerIndex = -1;
  for (let index = 0; index < Math.min(matrix.length, 40); index += 1) {
    const row = matrix[index] || [];
    if (row.some(isArticleHeader) && row.some(isStockHeader)) { headerIndex = index; break; }
  }
  if (headerIndex < 0) return { rows: [], score: 0, headerIndex: -1 };
  const rows = XLSX.utils.sheet_to_json(sheet, { range: headerIndex, defval: '' });
  const validRows = rows.filter((row) => String(readRowValue(row, ['Артикул', 'SKU', 'Код', 'Article', 'Номенклатура', 'COLOR NO.'])).trim() && !isSummaryRow(row));
  const numericStockRows = validRows.filter((row) => String(readRowValue(row, ['Остаток', 'Остаток на складе', 'Остаток на складе после поступления товара', 'Количество', 'Кол-во', 'Stock', 'Qty', 'Алматы в наличии'])).trim());
  return { rows, score: 20 + validRows.length + numericStockRows.length * 2, headerIndex };
}

function getGoogleSheetId(value) { const match = String(value || '').match(/spreadsheets\/d\/([a-zA-Z0-9-_]+)/); return match ? match[1] : ''; }
function updateSyncSettingsUI() {
  const cfg = FORONESync.config();
  const set = (id, value) => { const element = $(id); if (element) element.value = value === undefined || value === null ? '' : value; };
  const mark = (id, value) => { const element = $(id); if (element) element.checked = Boolean(value); };
  set('#syncUrl', cfg.url); set('#syncKey', cfg.key); set('#syncUser', cfg.user); set('#syncDeviceLabel', cfg.deviceLabel);
  mark('#syncEnabled', cfg.enabled); mark('#syncAutoSend', cfg.autoSend !== false); mark('#syncPullAfterSend', cfg.pullAfterSend !== false);
  FORONESync.render();
  const conflicts = $('#syncConflicts');
  if (conflicts) {
    const list = cfg.lastConflicts || [];
    conflicts.classList.toggle('hidden', !list.length);
    conflicts.innerHTML = list.length ? `<b>Расхождения с источником (${list.length})</b>` + list.slice(0, 6).map((item) => `<div class="sync-conflict-row"><span>${escapeHtml(item.sku)}</span><small>${escapeHtml(item.note)}</small></div>`).join('') + (list.length > 6 ? `<small class="sync-conflict-more">и ещё ${list.length - 6}…</small>` : '') : '';
  }
  const test = $('#syncTestStatus');
  if (test && !test.dataset.pinned) test.textContent = cfg.lastErrorText && cfg.lastError && !cfg.lastPing ? cfg.lastErrorText : (cfg.lastPing ? `Проверено ${FORONESync.formatAgo(cfg.lastPing)}` : 'Соединение не проверялось');
}

async function testSyncConnection() {
  const status = $('#syncTestStatus');
  if (status) { status.dataset.pinned = '1'; status.textContent = 'Проверяю соединение…'; }
  const result = await FORONESync.ping();
  if (status) {
    status.textContent = result.ok
      ? (result.restricted ? 'Связь есть · вставьте ключ доступа' : `Связь есть · Web App v${result.version || '?'}${result.sheets ? ' · позиций ' + (result.sheets[DEFAULT_GOOGLE_SHEET_NAME] ?? '—') : ''}`)
      : (result.message || 'Связи нет');
    setTimeout(() => { delete status.dataset.pinned; updateSyncSettingsUI(); }, 12000);
  }
  showToast(result.ok ? 'Соединение с Web App установлено' : result.message || 'Не удалось связаться с Web App', result.ok ? 'success' : 'error');
}

async function pullServerStock(manual = true) {
  const result = await FORONESync.pullStock({ silent: !manual });
  if (manual) {
    if (result.ok) showToast(`Сверка с сервером: обновлено ${result.changed}, добавлено ${result.added}, переименовано ${result.renamed || 0}, защищено ${result.skipped}`);
    else showToast(result.message || 'Сверка не удалась', 'error');
    renderAll();
  }
  updateSyncSettingsUI();
  return result;
}

async function sendQueueNow() {
  const summary = FORONESync.summary();
  if (!summary.configured) { showToast('Укажите URL Web App и включите двустороннюю синхронизацию', 'error'); return; }
  if (!summary.total && !summary.unsynced) { showToast('Очередь пуста — отправлять нечего'); return; }
  const status = $('#syncTestStatus');
  if (status) { status.dataset.pinned = '1'; status.textContent = 'Отправляем операции…'; }
  const result = await FORONESync.retryNow();
  if (result && result.ok) showToast(`Отправлено операций: ${result.applied || 0}`);
  else if (result && result.skipped) showToast('Отправлять нечего — очередь пуста');
  else if (result && result.message) showToast(result.message, 'error');
  if (status) setTimeout(() => { delete status.dataset.pinned; updateSyncSettingsUI(); }, 10000);
  renderAll();
}

function updateGoogleSyncUI() {
  const source = state.source || {};
  const url = $('#googleSheetUrl');
  const toggle = $('#googleAutoSync');
  const status = $('#googleSyncStatus');
  const stateLabel = $('#googleSyncState');
  const dot = $('#googleSyncDot');
  const lastUpdate = $('#googleSyncLastUpdate');
  const count = $('#googleSyncCount');
  const sheet = $('#googleSyncSheet');
  if (url) url.value = source.googleUrl || DEFAULT_GOOGLE_SHEET_URL;
  if (toggle) toggle.checked = Boolean(source.googleEnabled);
  const synced = Boolean(source.googleLastSync);
  const loaded = Boolean(source.googleLastFetch);
  if (stateLabel) stateLabel.textContent = !source.googleEnabled ? 'Синхронизация выключена' : synced ? 'Синхронизировано' : loaded ? 'Книга загружена · ожидает подтверждения' : 'Ожидается первая загрузка';
  if (dot) dot.className = `sync-status-dot ${!source.googleEnabled ? 'is-off' : synced ? 'is-ok' : loaded ? 'is-warn' : ''}`;
  if (lastUpdate) lastUpdate.textContent = source.googleLastSync ? formatDate(source.googleLastSync, true) : source.googleLastFetch ? `${formatDate(source.googleLastFetch, true)} · загрузка` : '—';
  if (count) count.textContent = source.googleLastCount || (synced ? state.products.filter((product) => !product.retired).length : '—');
  if (sheet) sheet.textContent = source.googleSheet || '—';
  if (status) status.textContent = synced ? `Последнее применение: ${formatDate(source.googleLastSync, true)} · лист «${source.googleSheet || 'не выбран'}»` : loaded ? `Книга загружена: ${formatDate(source.googleLastFetch, true)} · ожидает подтверждения` : source.googleEnabled ? 'Автосинхронизация включена · первая загрузка ожидается' : 'Источник не подключён';
  updateSyncSettingsUI();
}
function googleCandidateSort(a, b) { const excluded = /заказ|статист|аналит|отгруз|брак|цены|ассортимент|исток|факт|лист/i; const preferred = /остат|налич|октябрь|ноябрь|декабрь|сентябрь|август|июль|июнь|май|март|февраль|новая/i; const exact = (state.source?.googleSheet && a.name.trim() === state.source.googleSheet) ? -1000 : 0; const ax = excluded.test(a.name) ? 100 : 0, bx = excluded.test(b.name) ? 100 : 0; const ap = preferred.test(a.name) ? -20 : 0, bp = preferred.test(b.name) ? -20 : 0; return (exact + ax + ap + a.order / 10000) - (bx + bp + b.order / 10000); }
function openImportPreviewForCandidates(candidates, source = 'excel') { pendingImport = { candidates, source }; const options = candidates.slice(0, 20).map((candidate, index) => `<option value="${index}">${escapeHtml(candidate.name)} · ${candidate.rows.length} строк</option>`).join(''); $('#importPreviewContent').innerHTML = `<label class="field-label">Лист с остатками<select id="previewSheetSelect" class="preview-select">${options}</select></label><div id="importPreviewStats" class="import-preview-stats"></div><div class="import-preview-table-wrap"><table class="import-preview-table"><thead><tr><th>Артикул</th><th>Категория</th><th>Название</th><th>Остаток</th></tr></thead><tbody id="importPreviewRows"></tbody></table></div>`; $('#previewSheetSelect').addEventListener('change', renderImportPreviewDetails); const preferredIndex = Math.max(0, candidates.findIndex((candidate) => state.source?.googleSheet && candidate.name.trim() === state.source.googleSheet)); $('#previewSheetSelect').value = String(preferredIndex); renderImportPreviewDetails(); openBackdrop('importPreviewModal'); }
async function syncGoogleSheet(force = true) { const url = $('#googleSheetUrl')?.value.trim() || state.source?.googleUrl || DEFAULT_GOOGLE_SHEET_URL; const id = getGoogleSheetId(url); if (!id) { showToast('Вставьте корректную ссылку Google Sheets', 'error'); return; } const autoToggle = $('#googleAutoSync'); state.source = { googleUrl: url, googleEnabled: autoToggle ? autoToggle.checked : (state.source?.googleEnabled ?? true), googleSheet: state.source?.googleSheet || DEFAULT_GOOGLE_SHEET_NAME, googleLastSync: state.source?.googleLastSync || 0, googleLastFetch: state.source?.googleLastFetch || 0, googleApproved: Boolean(state.source?.googleApproved), googleAutoConfigured: true }; if (!force && state.source.googleLastFetch && Date.now() - state.source.googleLastFetch < 15 * 60 * 1000) return; const status = $('#googleSyncStatus'); if (status) status.textContent = 'Загружаю книгу…'; if ($('#googleSyncState')) $('#googleSyncState').textContent = 'Загрузка данных…'; if ($('#googleSyncDot')) $('#googleSyncDot').className = 'sync-status-dot is-warn'; try { const response = await fetch(`https://docs.google.com/spreadsheets/d/${id}/export?format=xlsx`, { cache: 'no-store' }); if (!response.ok) throw new Error(`HTTP ${response.status}`); const workbook = XLSX.read(await response.arrayBuffer(), { type: 'array' }); const candidates = workbook.SheetNames.map((name, order) => ({ name, order, ...inspectInventorySheet(workbook.Sheets[name]) })).filter((candidate) => candidate.rows.length).sort((a, b) => b.score - a.score || googleCandidateSort(a, b)); if (!candidates.length) throw new Error('no inventory sheets'); state.source.googleUrl = url; state.source.googleLastFetch = Date.now(); saveState(); updateGoogleSyncUI(); const preferredIndex = Math.max(0, candidates.findIndex((candidate) => candidate.name.trim() === state.source.googleSheet)); if (!force && state.source.googleApproved) { pendingImport = { candidates, source: 'google', autoRows: candidates[preferredIndex].rows }; confirmImport(); return; } openImportPreviewForCandidates(candidates, 'google'); } catch (error) { console.error(error); if (status) status.textContent = 'Не удалось загрузить таблицу'; if ($('#googleSyncState')) $('#googleSyncState').textContent = 'Ошибка синхронизации'; if ($('#googleSyncDot')) $('#googleSyncDot').className = 'sync-status-dot is-off'; showToast('Google Sheets недоступна для чтения. Проверьте общий доступ.', 'error'); } }

async function importExcel(file) {
  if (!file) return;
  if (!window.XLSX) { showToast('SheetJS не загрузился', 'error'); return; }
  try {
    const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    const candidates = workbook.SheetNames.map((name, order) => ({ name, order, ...inspectInventorySheet(workbook.Sheets[name]) })).filter((candidate) => candidate.rows.length).sort((a, b) => b.score - a.score || a.order - b.order);
    if (!candidates.length) { showToast('Не найден лист с колонками «Артикул» и «Остаток»', 'error'); return; }
    openImportPreviewForCandidates(candidates, 'excel');
  } catch (error) { console.error(error); showToast('Не удалось прочитать Excel-файл', 'error'); }
}
function getImportRows() { if (pendingImport?.autoRows) return pendingImport.autoRows; const index = Number($('#previewSheetSelect')?.value || 0); return pendingImport?.candidates[index]?.rows || []; }
function renderImportPreviewDetails() {
  const rows = getImportRows(); let valid = 0, empty = 0, duplicate = 0, updates = 0; const seen = new Set(); const preview = [];
  rows.forEach((row) => { const sku = String(readRowValue(row, ['Артикул','SKU','Код','Article','Номенклатура','COLOR NO.']) || '').trim(); if (isSummaryRow(row)) return; if (!sku) { empty++; return; } valid++; const key = sku.toLowerCase(); if (seen.has(key)) duplicate++; seen.add(key); const name = String(readRowValue(row, ['Название','Наименование','Товар','Name','PRODUCT NAME','Описание']) || sku).trim(); const category = parseImportedCategory(readRowValue(row, ['Категория','Тип','Category']) || name); const existing = state.products.find((product) => sameImportedProduct(product, sku, category, name)); if (existing) updates++; preview.push({ sku, name, category, stock: parseImportedStock(readRowValue(row, ['Остаток','Остаток на складе','Количество','Кол-во','Stock','Qty','Алматы в наличии'])) }); });
  $('#importPreviewStats').innerHTML = `<div><b>${valid}</b><span>позиций найдено</span></div><div><b>${updates}</b><span>обновится</span></div><div><b>${duplicate}</b><span>дубликатов</span></div><div><b>${empty}</b><span>пустых артикулов</span></div>${duplicate || empty ? '<p class="import-warning">Проверьте дубликаты и пустые артикулы перед импортом.</p>' : ''}`;
  $('#importPreviewRows').innerHTML = preview.slice(0, 30).map((item) => `<tr><td>${escapeHtml(item.sku)}</td><td>${escapeHtml(item.category)}</td><td>${escapeHtml(item.name)}</td><td>${item.stock}</td></tr>`).join('');
}
function confirmImport() {
  if (!pendingImport) return; const rows = getImportRows(); let imported = 0; let protectedCount = 0; const batch = Date.now();
  rows.forEach((row, index) => { if (isSummaryRow(row)) return; const sku = String(readRowValue(row, ['Артикул','SKU','Код','Article','Номенклатура','COLOR NO.']) || '').trim(); if (!sku) return; const name = String(readRowValue(row, ['Название','Наименование','Товар','Name','PRODUCT NAME','Описание']) || sku).trim(); const category = parseImportedCategory(readRowValue(row, ['Категория','Тип','Category']) || name); const length = parseImportedLength(readRowValue(row, ['Длина','Размер','Length']) || name); const stock = parseImportedStock(readRowValue(row, ['Остаток','Остаток на складе','Количество','Кол-во','Stock','Qty','Алматы в наличии'])); const reserved = Math.min(stock, parseImportedStock(readRowValue(row, ['Зарезервировано','Резерв','Reserved']))); const warehouse = String(readRowValue(row, ['Склад','Warehouse']) || 'Алматы').trim(); const zone = String(readRowValue(row, ['Зона','Zone']) || '').trim(); const rack = String(readRowValue(row, ['Стеллаж','Rack']) || '').trim(); const bin = String(readRowValue(row, ['Ячейка','Bin','Cell']) || '').trim(); const existing = state.products.find((product) => sameImportedProduct(product, sku, category, name)); const data = { name, category, length, stock, reserved, warehouse, zone, rack, bin, barcode: sku, retired: false, updatedAt: Date.now() }; const protect = existing && window.FORONESync && FORONESync.hasPendingFor(existing); if (protect) { delete data.stock; delete data.reserved; protectedCount++; } if (existing) Object.assign(existing, data); else state.products.push({ id: `p-${batch}-${index}`, sku, reserved: 0, warehouse: 'Алматы', zone: '', rack: '', bin: '', orderOnly: length >= 4000, ...data }); imported++; });
  const importSource = pendingImport.source; if (importSource === 'google') { state.source = state.source || {}; state.source.googleSheet = $('#previewSheetSelect')?.selectedOptions?.[0]?.textContent?.split(' · ')[0] || state.source.googleSheet; state.source.googleLastSync = Date.now(); state.source.googleLastCount = state.products.filter((product) => !product.retired).length; state.source.googleApproved = true; } saveState(); closeBackdrop('importPreviewModal'); pendingImport = null; renderAll(); updateGoogleSyncUI(); showToast(`${importSource === 'google' ? 'Синхронизация' : 'Импорт'} завершён: ${imported} позиций${protectedCount ? ` · ${protectedCount} с неотправленным расходом не тронуты` : ''}`);
}
function exportExcel() {
  if (!window.XLSX) { showToast('SheetJS не загрузился', 'error'); return; }
  if (!state.operations.length) { showToast('Добавьте хотя бы одну операцию', 'error'); return; }
  const rows = state.operations.map((operation) => {
    const product = getProduct(operation.productId);
    const status = product ? getStatus(product) : getStatus({ length: operation.length, stock: operation.stockAfter, orderOnly: false });
    return { 'Дата': formatDate(operation.createdAt, true), 'Артикул': operation.sku, 'Название': operation.name, 'Категория': operation.category, 'Длина': Number(operation.length) >= 4000 ? '4 м / 4000 мм' : '3 м / 3000 мм', 'Количество, шт.': operation.qty, 'Операция': operationLabels[operation.type], 'Остаток после': operation.stockAfter, 'Статус': status.label, 'Комментарий по срокам': status.comment, 'Комментарий': operation.comment || '', 'Факт': product?.stock || operation.stockAfter, 'Зарезервировано': product?.reserved || 0, 'Доступно': product ? getAvailable(product) : operation.stockAfter, 'Место хранения': product ? getLocation(product) : '' };
  });
  const worksheet = XLSX.utils.json_to_sheet(rows);
  worksheet['!cols'] = [{ wch: 17 }, { wch: 15 }, { wch: 34 }, { wch: 14 }, { wch: 17 }, { wch: 16 }, { wch: 23 }, { wch: 16 }, { wch: 22 }, { wch: 36 }, { wch: 28 }];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Отчет за смену');
  XLSX.writeFile(workbook, `FORONE_отчет_${formatDate(Date.now()).replaceAll('.', '-')}.xlsx`);
  showToast('Отчет .xlsx скачан');
}

function clearOperations() {
  if (!state.operations.length) return showToast('Журнал уже пуст');
  const unsent = state.operations.filter((operation) => operation.syncStatus && operation.syncStatus !== 'synced');
  const pendingQueue = FORONESync.queue().length;
  if (unsent.length || pendingQueue) {
    if (!confirm(`В журнале есть неотправленные операции (${Math.max(unsent.length, pendingQueue)}). Очистить журнал И отменить их отправку? Остатки каталога не изменятся.`)) return;
    state.queue = [];
  } else if (!confirm('Очистить все операции текущей смены? Остатки каталога не изменятся.')) return;
  state.operations = [];
  saveState(); renderAll(); FORONESync.render(); showToast('Журнал очищен');
}


function downloadJson(filename, payload) { const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 500); }
function saveBackup() { downloadJson(`FORONE_база_${formatDate(Date.now()).replaceAll('.', '-')}.json`, { version: 2, exportedAt: new Date().toISOString(), state }); showToast('Резервная копия сохранена'); }
function restoreBackup(file) { if (!file) return; const reader = new FileReader(); reader.onload = () => { try { const data = JSON.parse(reader.result); if (!data?.state?.products || !Array.isArray(data.state.operations)) throw new Error('invalid'); if (!confirm('Заменить локальную базу данными из файла?')) return; state = { ...data.state, products: data.state.products.map((product) => ({ warehouse: 'Алматы', zone: '', rack: '', bin: '', reserved: 0, ...product })), source: { googleUrl: DEFAULT_GOOGLE_SHEET_URL, googleEnabled: true, googleSheet: DEFAULT_GOOGLE_SHEET_NAME, googleLastSync: 0, googleLastFetch: 0, googleAutoConfigured: true, ...(data.state.source || {}) } }; saveState(); renderAll(); showToast('База восстановлена'); } catch (_) { showToast('Файл резервной копии повреждён', 'error'); } }; reader.readAsText(file); }
async function shareBackup() { const payload = JSON.stringify({ version: 2, exportedAt: new Date().toISOString(), state }, null, 2); const file = new File([payload], 'FORONE-база.json', { type: 'application/json' }); if (navigator.share && navigator.canShare?.({ files: [file] })) { await navigator.share({ title: 'FORONE база', text: 'Резервная копия складской базы', files: [file] }); } else { saveBackup(); showToast('Файл скачан — отправьте его на другой телефон'); } }

const buttonHelpById = {
  openSettingsBtn: 'Открыть информацию, Google Sheets и резервную копию',
  scanBtn: 'Открыть камеру и отсканировать артикул или QR-код',
  clearSearch: 'Очистить строку поиска',
  addProductBtn: 'Добавить новую позицию в каталог',
  resetFiltersBtn: 'Сбросить поиск, категорию и все фильтры',
  importBtn: 'Загрузить Excel-файл с остатками',
  exportBtn: 'Скачать текущий отчёт в Excel',
  clearOperationsBtn: 'Удалить журнал операций текущей смены',
  syncGoogleBtn: 'Загрузить остатки из Google Таблицы сейчас',
  openBackupBtn: 'Открыть сохранение и перенос резервной копии',
  queuePill: 'Неотправленные операции — открыть настройки синхронизации',
  syncTestBtn: 'Проверить, отвечает ли Google Apps Script Web App',
  syncSendNowBtn: 'Отправить все операции из очереди в Google Таблицу',
  syncPullBtn: 'Загрузить рабочие остатки с сервера и сверить с телефоном',
  syncBackfillBtn: 'Поставить в очередь операции смены, которые ещё не отправлены',
  queueSendNow: 'Отправить неотправленные операции сейчас',
  queueOpenSettings: 'Открыть настройки синхронизации',
  themeToggleBtn: 'Переключить светлую и тёмную тему',
  backupSaveBtn: 'Скачать полную базу на телефон',
  backupRestoreBtn: 'Восстановить базу из JSON-файла',
  backupShareBtn: 'Передать резервную копию на другой телефон',
  torchBtn: 'Включить или выключить подсветку камеры',
  manualCodeBtn: 'Найти товар по коду без камеры',
  zoomInBtn: 'Увеличить изображение камеры',
  zoomOutBtn: 'Уменьшить изображение камеры',
  enhanceBtn: 'Включить или выключить усиление контраста и резкости',
  toastUndoBtn: 'Отменить последнее изменение'
};
function initButtonHints() {
  const modeHints = { check: 'Показать остаток без изменения базы', in: 'Добавить поступление к остатку', out: 'Оформить расход и уменьшить доступный остаток', writeoff: 'Списать товар на замер и записать операцию' };
  const filterHints = { all: 'Показать все активные позиции', favorites: 'Показать избранные позиции', out: 'Показать позиции без доступного остатка', low: 'Показать позиции с малым остатком', '4m': 'Показать панели длиной 4 метра', louvers: 'Показать только луверы', recent: 'Показать изменённые за последние 7 дней' };
  const viewHints = { scanner: 'Перейти к сканеру и быстрому контролю', catalog: 'Открыть каталог товаров и фильтры', reports: 'Открыть отчёты и журнал операций' };
  $$('button').forEach((button) => {
    let hint = buttonHelpById[button.id] || button.dataset.help || '';
    if (button.matches('.scan-mode')) hint = modeHints[button.dataset.scanMode];
    if (button.matches('.quick-filter')) hint = filterHints[button.dataset.filter];
    if (button.matches('.nav-item')) hint = viewHints[button.dataset.view];
    if (!hint) hint = button.getAttribute('aria-label') || button.textContent.trim().replace(/\s+/g, ' ');
    if (!hint) return;
    button.title = hint;
    button.setAttribute('aria-label', button.getAttribute('aria-label') || hint);
    button.dataset.tooltip = hint;
    button.addEventListener('pointerenter', (event) => { if (event.pointerType === 'pen') button.classList.add('tooltip-visible'); });
    button.addEventListener('pointerleave', () => button.classList.remove('tooltip-visible'));
    button.addEventListener('pointerdown', () => button.classList.remove('tooltip-visible'));
  });
  const globalTooltip = $('#globalTooltip');
  const hidePenTooltip = () => { if (!globalTooltip) return; globalTooltip.classList.remove('visible'); globalTooltip.setAttribute('aria-hidden', 'true'); };
  const showPenTooltip = (target) => {
    if (!globalTooltip || !target) return;
    globalTooltip.textContent = target.dataset.tooltip;
    globalTooltip.classList.add('visible');
    globalTooltip.setAttribute('aria-hidden', 'false');
    const rect = target.getBoundingClientRect();
    globalTooltip.style.left = `${Math.min(Math.max(8, rect.left + rect.width / 2 - 120), window.innerWidth - 248)}px`;
    globalTooltip.style.top = `${Math.min(window.innerHeight - 58, rect.bottom + 10)}px`;
    requestAnimationFrame(() => {
      if (globalTooltip.getBoundingClientRect().bottom > window.innerHeight - 8) globalTooltip.style.top = `${Math.max(8, rect.top - globalTooltip.offsetHeight - 10)}px`;
    });
  };
  document.addEventListener('pointermove', (event) => {
    if (event.pointerType !== 'pen') return;
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest?.('button[data-tooltip]');
    $$('button.tooltip-visible').forEach((button) => { if (button !== target) button.classList.remove('tooltip-visible'); });
    if (target) { target.classList.add('tooltip-visible'); showPenTooltip(target); } else hidePenTooltip();
  });
  document.addEventListener('pointerleave', (event) => { if (event.pointerType === 'pen') { $$('button.tooltip-visible').forEach((button) => button.classList.remove('tooltip-visible')); hidePenTooltip(); } });
  document.addEventListener('pointerdown', hidePenTooltip);
  window.addEventListener('blur', hidePenTooltip);
}

function initEvents() {
  initButtonHints();
  applyTheme();
  $('#toastUndoBtn').addEventListener('click', undoLastAction);
  $$('.nav-item').filter((item) => item.dataset.view).forEach((item) => item.addEventListener('click', () => setActiveView(item.dataset.view)));
  $('#themeToggleBtn').addEventListener('click', toggleTheme);
  $('#view-scanner').addEventListener('click', (event) => {
    const action = event.target.closest('[data-dashboard-action]')?.dataset.dashboardAction;
    const filter = event.target.closest('[data-dashboard-filter]')?.dataset.dashboardFilter;
    if (action) openDashboardFilter(action);
    else if (filter) openDashboardFilter(filter);
  });
  $$('[data-view]').filter((item) => !item.classList.contains('nav-item')).forEach((item) => item.addEventListener('click', () => setActiveView(item.dataset.view)));
  $('#scanBtn').addEventListener('click', startScanner);
  $('#closeScannerBtn').addEventListener('click', async () => { await stopScanner(); closeBackdrop('scannerModal'); });
  $('#scanSuggestion').addEventListener('click', (event) => { const alt = event.target.closest('[data-alt-index]'); if (alt && pendingScan?.kind === 'visual') { const item = pendingScan.match.alternatives[Number(alt.dataset.altIndex)]; if (item) { pendingScan = { kind: 'visual', match: item }; } } acceptScanSuggestion(); });
  $('#torchBtn').addEventListener('click', toggleTorch);
  $('#zoomInBtn').addEventListener('click', () => applyCameraZoom(.25)); $('#zoomOutBtn').addEventListener('click', () => applyCameraZoom(-.25)); $('#enhanceBtn').addEventListener('click', () => { enhanceCamera = !enhanceCamera; $('#enhanceBtn').setAttribute('aria-pressed', String(enhanceCamera)); applyCameraEnhancement(); });
  $('#manualCodeBtn').addEventListener('click', manualCodeLookup);
  $('#searchInput').addEventListener('input', renderSearchResults);
  $('#clearSearch').addEventListener('click', () => { $('#searchInput').value = ''; renderSearchResults(); $('#searchInput').focus(); });
  $('#searchResults').addEventListener('click', (event) => { const result = event.target.closest('[data-search-product]'); if (result) { $('#searchResults').classList.add('hidden'); openProductModal(result.dataset.searchProduct); } });
  $('#catalogSearch').addEventListener('input', renderCatalog);
  $('#categoryFilter').addEventListener('change', () => { catalogQuickFilter = 'all'; $$('.quick-filter').forEach((item) => item.classList.toggle('active', item.dataset.filter === 'all')); renderCatalog(); });
  ['lengthFilter', 'availabilityFilter', 'statusFilter'].forEach((id) => $(`#${id}`).addEventListener('change', (event) => { catalogFilters[id.replace('Filter', '')] = event.target.value; catalogQuickFilter = 'all'; $$('.quick-filter').forEach((item) => item.classList.toggle('active', item.dataset.filter === 'all')); renderCatalog(); }));
  $('#resetFiltersBtn').addEventListener('click', () => { catalogFilters = { length: 'all', availability: 'all', status: 'active' }; catalogQuickFilter = 'all'; $('#catalogSearch').value = ''; $('#categoryFilter').value = 'all'; ['lengthFilter','availabilityFilter','statusFilter'].forEach((id) => { $(`#${id}`).value = id === 'statusFilter' ? 'active' : 'all'; }); $$('.quick-filter').forEach((item) => item.classList.toggle('active', item.dataset.filter === 'all')); renderCatalog(); });
  $('#quickFilters').addEventListener('click', (event) => { const button = event.target.closest('[data-filter]'); if (!button) return; const key = button.dataset.filter; catalogQuickFilter = key; if (key === 'all') { catalogFilters = { length: 'all', availability: 'all', status: 'active' }; $('#categoryFilter').value = 'all'; } if (key !== 'louvers' && key !== 'all') $('#categoryFilter').value = 'all'; if (key === 'out' || key === 'low') catalogFilters.availability = key; if (key === '4m') catalogFilters.length = '4000'; if (key === 'louvers') $('#categoryFilter').value = 'Лувер'; $$('.quick-filter').forEach((item) => item.classList.toggle('active', item === button)); ['lengthFilter','availabilityFilter','statusFilter'].forEach((id) => { const keyName = id.replace('Filter', ''); if ($(`#${id}`)) $(`#${id}`).value = catalogFilters[keyName]; }); renderCatalog(); });
  $$('.scan-mode').forEach((button) => button.addEventListener('click', () => { activeScanMode = button.dataset.scanMode; $$('.scan-mode').forEach((item) => item.classList.toggle('active', item === button)); $('#scanModeHelp').textContent = scanModeHelp[activeScanMode]; showToast(`Режим: ${button.textContent}`); }));
  $('#scanModeHelp').textContent = scanModeHelp[activeScanMode];
  $('#catalogList').addEventListener('click', handleCatalogClick);
  $('#catalogList').addEventListener('change', handleCatalogStockInput);
  $('#addProductBtn').addEventListener('click', () => openEditor());
  $('#productForm').addEventListener('submit', submitProductForm);
  $('#importBtn').addEventListener('click', () => $('#fileInput').click());
  $('#fileInput').addEventListener('change', (event) => { importExcel(event.target.files[0]); event.target.value = ''; });
  $('#confirmImportBtn').addEventListener('click', confirmImport); $('#closeImportPreview').addEventListener('click', () => closeBackdrop('importPreviewModal')); $('#cancelImportBtn').addEventListener('click', () => closeBackdrop('importPreviewModal'));
  $('#exportBtn').addEventListener('click', exportExcel);
  $('#clearOperationsBtn').addEventListener('click', clearOperations);
  $('#operationsList').addEventListener('click', handleOperationAction);
  $('#recentList').addEventListener('click', handleOperationAction);
  $('#queuePill')?.addEventListener('click', () => { updateGoogleSyncUI(); openBackdrop('infoModal'); });
  $('#queueSendNow')?.addEventListener('click', sendQueueNow);
  $('#queueOpenSettings')?.addEventListener('click', () => { updateGoogleSyncUI(); openBackdrop('infoModal'); });
  $('#syncEnabled')?.addEventListener('change', (event) => {
    const cfg = FORONESync.updateSettings({ enabled: event.target.checked });
    if (event.target.checked && !FORONESync.normalizeUrl(cfg.url)) showToast('Вставьте URL Web App — без него отправка невозможна', 'error');
    else if (event.target.checked) { showToast('Двусторонняя синхронизация включена'); FORONESync.retryNow(); }
    else showToast('Отправка операций выключена — они остаются на телефоне');
    updateConnectionLabel();
  });
  $('#syncAutoSend')?.addEventListener('change', (event) => { FORONESync.updateSettings({ autoSend: event.target.checked }); if (event.target.checked) FORONESync.retryNow(); });
  $('#syncPullAfterSend')?.addEventListener('change', (event) => FORONESync.updateSettings({ pullAfterSend: event.target.checked }));
  $('#syncUrl')?.addEventListener('change', (event) => FORONESync.updateSettings({ url: event.target.value }));
  $('#syncKey')?.addEventListener('change', (event) => FORONESync.updateSettings({ key: event.target.value.trim() }));
  $('#syncUser')?.addEventListener('change', (event) => FORONESync.updateSettings({ user: event.target.value.trim() }));
  $('#syncDeviceLabel')?.addEventListener('change', (event) => FORONESync.updateSettings({ deviceLabel: event.target.value.trim() }));
  $('#syncTestBtn')?.addEventListener('click', testSyncConnection);
  $('#syncSendNowBtn')?.addEventListener('click', sendQueueNow);
  $('#syncPullBtn')?.addEventListener('click', () => pullServerStock(true));
  $('#syncBackfillBtn')?.addEventListener('click', () => {
    const count = FORONESync.unsyncedShiftOperations().length;
    if (!count) return showToast('Все операции смены уже в очереди или отправлены');
    if (!confirm(`Поставить в очередь ${count} ${pluralize(count, 'операцию', 'операции', 'операций')} за смену? Если проводили что-то в таблице вручную — эти операции отправлять не нужно.`)) return;
    const added = FORONESync.enqueueAllUnsynced();
    showToast(`В очередь добавлено: ${added}`);
    FORONESync.retryNow();
    renderAll();
  });
  $('#openSettingsBtn').addEventListener('click', () => { updateGoogleSyncUI(); openBackdrop('infoModal'); }); $('#openHelpBtn').addEventListener('click', () => { closeBackdrop('infoModal'); openBackdrop('helpModal'); }); $$('[data-close-help]').forEach((button) => button.addEventListener('click', () => closeBackdrop('helpModal'))); $('#syncGoogleBtn').addEventListener('click', () => syncGoogleSheet(true)); $('#googleAutoSync').addEventListener('change', (event) => { state.source.googleEnabled = event.target.checked; state.source.googleAutoConfigured = true; state.source.googleUrl = $('#googleSheetUrl').value.trim() || DEFAULT_GOOGLE_SHEET_URL; saveState(); updateConnectionLabel(); if (event.target.checked) syncGoogleSheet(false); }); $('#googleSheetUrl').addEventListener('change', (event) => { state.source.googleUrl = event.target.value.trim() || DEFAULT_GOOGLE_SHEET_URL; saveState(); }); $('#openBackupBtn').addEventListener('click', () => { closeBackdrop('infoModal'); openBackdrop('backupModal'); }); $('[data-close-backup]').addEventListener('click', () => closeBackdrop('backupModal')); $('#backupSaveBtn').addEventListener('click', saveBackup); $('#backupRestoreBtn').addEventListener('click', () => $('#backupFileInput').click()); $('#backupShareBtn').addEventListener('click', shareBackup); $('#backupFileInput').addEventListener('change', (event) => { restoreBackup(event.target.files[0]); event.target.value = ''; });
  $$('[data-close-modal]').forEach((button) => button.addEventListener('click', () => closeBackdrop('modalBackdrop')));
  $$('[data-close-editor]').forEach((button) => button.addEventListener('click', () => closeBackdrop('editorModal')));
  $$('[data-close-info]').forEach((button) => button.addEventListener('click', () => closeBackdrop('infoModal')));
  $$('.modal-backdrop').forEach((backdrop) => backdrop.addEventListener('click', (event) => { if (event.target === backdrop && backdrop.id !== 'scannerModal') closeBackdrop(backdrop.id); }));
  document.addEventListener('keydown', async (event) => { if (event.key === 'Escape') { await stopScanner(); $$('.modal-backdrop:not(.hidden)').forEach((backdrop) => closeBackdrop(backdrop.id)); } });
  window.addEventListener('online', updateConnectionLabel);
  window.addEventListener('offline', updateConnectionLabel);
}

function initSyncModule() {
  if (!window.FORONESync) return;
  FORONESync.attach({
    state: () => state,
    save: () => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (error) { console.warn('Не удалось сохранить базу', error); } },
    element: (selector) => document.querySelector(selector),
    notify: (message, tone) => showToast(message, tone),
    updateConnectionLabel,
    onSynced(item, result) {
      // Артикул в базе FORONE повторяется, поэтому позицию ищем по артикулу + названию + категории.
      const product = FORONESync.resolveProduct(item);
      if (!product) { showToast(`Сервер принял ${item.sku}, но позицию не удалось сопоставить — сверьте остатки`, 'error'); return; }
      if (result.stockAfter !== undefined && result.stockAfter !== null) product.stock = Math.max(0, Number(result.stockAfter));
      if (result.availableAfter !== undefined && result.availableAfter !== null) product.reserved = Math.max(0, Number(product.stock) - Number(result.availableAfter));
      product.updatedAt = Date.now();
    },
    onFlushed(info) {
      if (info.problems && info.problems.length) showToast(`Склад отклонил операций: ${info.problems.length} — откройте журнал`, 'error');
      if (info.failed) showToast(`Отправка не прошла: ${info.message}. Пробуем снова, операции сохранены на телефоне.`, 'error');
      renderAll();
    }
  });
  FORONESync.startTimers();
  FORONESync.render();
  const summary = FORONESync.summary();
  if (summary.enabled && summary.autoSend && summary.waiting) FORONESync.schedule(4000);
}

function registerOfflineApp() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch((error) => console.warn('SW registration failed', error));
}

initEvents();
initSyncModule();
renderAll();
registerOfflineApp();
updateGoogleSyncUI();
if (state.source?.googleEnabled) setTimeout(() => syncGoogleSheet(false), 1200);
