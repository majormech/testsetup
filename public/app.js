const page = document.body.dataset.page;
const urlParams = new URLSearchParams(window.location.search);
const currentSupplyGroup = '';
const supplyGroupLabel = 'All Supplies';
const APP_PAGE_PATHS = {
  '/index.html': 'main',
  '/restock.html': 'restock',
  '/issue.html': 'issue',
  '/inventory.html': 'inventory',
  '/search.html': 'search',
  '/request.html': 'request',
};
const AUTO_ALLOWED_PATHS = new Set(['/index.html', '/account.html', '/how-to.html']);

const state = {
  items: [],
  stations: [],
  stationRequests: [],
  mainSearchTerm: '',
  recentTransactions: [],
  analytics: {
    byItem: [],
    byStation: [],
    trend: [],
    transactions: [],
  },
  adminErrors: {
    summary: null,
    errors: [],
  },
  auth: null,
  availablePages: [],
};

const toast = document.querySelector('#toast');
let clientErrorTrackingReady = false;

function showToast(message, isError = false) {
  if (!toast) return;
  toast.textContent = message;
  toast.style.background = isError ? '#c13737' : '#142033';
  toast.classList.add('show');
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove('show'), 3000);
}

function showTimedPopup(message, durationMs = 5000) {
  const overlay = document.createElement('div');
  overlay.className = 'scanner-modal';
  overlay.innerHTML = `
    <div class="scanner-modal__card">
      <h3>Success</h3>
       <div>${message}</div>
      <div class="scanner-modal__actions">
        <button type="button" data-action="ok">OK</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.querySelector('[data-action="ok"]')?.addEventListener('click', close);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close();
  });
  window.setTimeout(close, durationMs);
}

async function fetchJson(url, options) {
  try {
    const response = await fetch(url, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || 'Request failed');
      error.statusCode = response.status;
      error.responseBody = data;
      throw error;
    }
    return data;
  } catch (error) {
    const normalizedError = error instanceof Error ? error : new Error('Request failed');
    const requestMethod = String(options?.method || 'GET').toUpperCase();
    if (!String(url).startsWith('/api/errors') && !options?.suppressErrorTracking) {
      trackClientError(normalizedError, {
        category: 'api_request_failure',
        path: String(url),
        method: requestMethod,
        statusCode: normalizedError.statusCode || null,
        context: {
          page,
        },
      });
    }
    throw normalizedError;
  }
}

function serializeClientErrorDetails(error) {
  if (error instanceof Error) {
    return {
      message: error.message || 'Unknown client error',
      stack: error.stack || '',
    };
  }
  return {
    message: String(error || 'Unknown client error'),
    stack: '',
  };
}

async function sendClientError(payload) {
  try {
    await fetch('/api/errors', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    // Avoid cascading client-side failures when logging cannot be sent.
  }
}

function trackClientError(error, meta = {}) {
  const details = serializeClientErrorDetails(error);
  void sendClientError({
    category: meta.category || 'client_runtime',
    message: details.message,
    stack: details.stack,
    path: meta.path || window.location.pathname,
    method: meta.method || '',
    page,
    statusCode: meta.statusCode || null,
    userAgent: navigator.userAgent,
    context: meta.context || {},
  });
}

function setupClientErrorTracking() {
  if (clientErrorTrackingReady) return;
  clientErrorTrackingReady = true;

  window.addEventListener('error', (event) => {
    trackClientError(event.error || event.message, {
      category: 'window_error',
      context: {
        filename: event.filename || '',
        line: event.lineno || null,
        column: event.colno || null,
      },
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    trackClientError(event.reason, {
      category: 'unhandled_rejection',
    });
  });
}

function currency(value) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(value || 0));
}

function isScopedGroup(group) {
  return !currentSupplyGroup || String(group || '').trim().toLowerCase() === currentSupplyGroup;
}

function getScopedItems() {
  return currentSupplyGroup
    ? state.items.filter((item) => String(item.supply_group || '').toLowerCase() === currentSupplyGroup)
    : state.items;
}

function getScopedTransactions() {
  return currentSupplyGroup
    ? state.recentTransactions.filter((txn) => String(txn.supply_group || '').toLowerCase() === currentSupplyGroup)
    : state.recentTransactions;
}

function getScopedStationRequests() {
  return currentSupplyGroup
    ? state.stationRequests.filter((request) => String(request.supply_group || '').toLowerCase() === currentSupplyGroup)
    : state.stationRequests;
}

function withGroupQuery(path) {
  if (!currentSupplyGroup) return path;
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}group=${encodeURIComponent(currentSupplyGroup)}`;
}

function updateScopedNavLinks() {
  document.querySelectorAll('[data-group-link]').forEach((link) => {
    const basePath = link.dataset.groupLink;
    if (!basePath) return;
    link.setAttribute('href', withGroupQuery(basePath));
  });
}

function normalizePathname(pathname = window.location.pathname) {
  return pathname === '/' ? '/index.html' : pathname;
}

function pageKeyForPath(pathname = window.location.pathname) {
  return APP_PAGE_PATHS[normalizePathname(pathname)] || '';
}

function canAccessCurrentPath() {
  if (!state.auth) return false;
  const pathname = normalizePathname();
  if (AUTO_ALLOWED_PATHS.has(pathname)) return true;
  const pageKey = pageKeyForPath(pathname);
  if (!pageKey) return true;
  return state.auth.isAdmin || (state.auth.allowedPageKeys || []).includes(pageKey);
}

function getDefaultPath() {
  return state.auth?.defaultPath || '/account.html';
}

function goToDefaultPath() {
  window.location.replace(getDefaultPath());
}

async function loadAuthSession() {
  try {
    const response = await fetchJson('/api/auth/me', { suppressErrorTracking: true });
    state.auth = response.user || null;
    state.availablePages = response.pages || [];
    return state.auth;
  } catch (error) {
    if (error.statusCode === 401) {
      state.auth = null;
      state.availablePages = [];
      return null;
    }
    throw error;
  }
}

function buildAuthLink(label, href, isButton = false) {
  return isButton
    ? `<button type="button" class="ghost auth-chip" data-auth-action="${label.toLowerCase()}">${label}</button>`
    : `<a class="auth-chip" href="${href}">${label}</a>`;
}

function renderAuthChrome() {
  if (!state.auth) return;
  const shell = document.querySelector('.shell');
  if (!shell) return;

  let authBar = document.querySelector('.auth-bar');
  if (!authBar) {
    authBar = document.createElement('div');
    authBar.className = 'auth-bar';
    shell.prepend(authBar);
  }

  const badge = state.auth.isAdmin ? 'Admin' : 'User';
  authBar.innerHTML = `
    <div>
      <strong>${escapeHtml(state.auth.displayName || state.auth.username || 'Signed in')}</strong>
      <span class="helper"> ${escapeHtml(badge)} · ${escapeHtml(state.auth.username || '')}</span>
      ${state.auth.pinResetRequired ? '<div class="helper auth-warning">PIN reset required. Update it in Account Settings.</div>' : ''}
    </div>
    <div class="auth-bar__actions">
      ${buildAuthLink('Account Settings', '/account.html')}
      <button type="button" class="ghost auth-chip" data-auth-action="logout">Log Out</button>
    </div>
  `;

  authBar.querySelector('[data-auth-action="logout"]')?.addEventListener('click', async () => {
    try {
      await fetchJson('/api/auth/logout', { method: 'POST', suppressErrorTracking: true });
    } finally {
      window.location.replace('/login.html');
    }
  });
}

function filterNavigationForUser() {
  if (!state.auth) return;
  document.querySelectorAll('a[href]').forEach((link) => {
    const href = link.getAttribute('href');
    if (!href || href.startsWith('http') || href.startsWith('#')) return;
    const url = new URL(href, window.location.origin);
    const path = normalizePathname(url.pathname);
    if (AUTO_ALLOWED_PATHS.has(path) || path === '/login.html') return;
    if (path === '/admin.html') {
      if (!state.auth.isAdmin) link.remove();
      return;
    }
    const pageKey = pageKeyForPath(path);
    if (!pageKey) return;
    if (!state.auth.isAdmin && !(state.auth.allowedPageKeys || []).includes(pageKey)) {
      if (link.closest('.supply-area-card')) {
        link.remove();
      } else {
        link.remove();
      }
    }
  });
}

function formatSupplyGroupLabel(group) {
  const normalized = String(group || '').trim().toLowerCase();
  if (!normalized) return 'Unknown';
  return `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}`;
}

function expirationStatus(expirationDate) {
  const raw = String(expirationDate || '').trim();
  if (!raw) return { className: 'expiry-badge expiry-badge--ok', label: 'No expiration' };
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const expiry = new Date(`${raw}T00:00:00`);
  const diffDays = Math.ceil((expiry.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));
  if (diffDays < 0) return { className: 'expiry-badge expiry-badge--expired', label: `Expired ${raw}` };
  if (diffDays <= 30) return { className: 'expiry-badge expiry-badge--warning', label: `Expires ${raw}` };
  return { className: 'expiry-badge expiry-badge--ok', label: `In date until ${raw}` };
}

function medicalItemSummaryHtml(item) {
  const lots = Array.isArray(item.medical_lots) ? item.medical_lots : [];
  const activeLot = lots.find((lot) => Number(lot.quantity_on_hand || 0) > 0) || lots[0];
  if (!activeLot) return '<span class="helper">No active lots</span>';
  const status = expirationStatus(activeLot.expiration_date);
  const assignments = (state.medicalAssignments || []).filter((entry) => Number(entry.item_id) === Number(item.id)).slice(0, 3);
  const assignmentText = assignments.length
    ? `<div class="helper">Assigned: ${assignments.map((entry) => [entry.station_name, entry.apparatus_name].filter(Boolean).join(' / ')).join(', ')}</div>`
    : '<div class="helper">No assignments recorded yet.</div>';
  return `<span class="${status.className}">${escapeHtml(status.label)}</span><div class="helper">Lot ${escapeHtml(activeLot.lot_number || 'N/A')}</div>${assignmentText}`;
}

function getActiveStationRequests() {
  return getScopedStationRequests().filter((request) => !request.completed_at && !request.canceled_at);
}

function normalizeRequestedItems(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => {
      const name = String(item?.name || '').trim();
      const quantity = Number.parseInt(item?.quantity || 0, 10);
      const issuedQuantity = Number.parseInt(item?.issuedQuantity || 0, 10);
      if (!name || quantity <= 0) return null;
      return {
        name,
        quantity,
        issuedQuantity: Math.max(0, Math.min(quantity, Number.isInteger(issuedQuantity) ? issuedQuantity : 0)),
      };
    })
    .filter(Boolean);
}

function normalizeOtherRequestedItems(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => {
      const name = String(item?.name || '').trim();
      const purpose = String(item?.purpose || item?.usedFor || '').trim();
      const quantity = Number.parseInt(item?.quantity || 0, 10);
      const issuedQuantity = Number.parseInt(item?.issuedQuantity || 0, 10);
      if (!name || !purpose || quantity <= 0) return null;
      return {
        name,
        purpose,
        quantity,
        issuedQuantity: Math.max(0, Math.min(quantity, Number.isInteger(issuedQuantity) ? issuedQuantity : 0)),
      };
    })
    .filter(Boolean);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function randomCodeSegment(length = 6) {
  const charset = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(length);
  window.crypto.getRandomValues(bytes);
  return [...bytes].map((value) => charset[value % charset.length]).join('');
}

function buildGeneratedQrCode() {
  const now = new Date();
  const stamp = [
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    String(now.getUTCDate()).padStart(2, '0'),
    String(now.getUTCHours()).padStart(2, '0'),
    String(now.getUTCMinutes()).padStart(2, '0'),
    String(now.getUTCSeconds()).padStart(2, '0'),
  ].join('');
  return `DFD-${stamp}-${randomCodeSegment(8)}`;
}

function buildQrImageUrl(value) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=320x320&data=${encodeURIComponent(value)}`;
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    || 'item';
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Unable to load QR image.'));
    image.src = url;
  });
}

async function buildNamedQrBlob(item, format = 'png') {
  const typeByFormat = {
    png: 'image/png',
    jpg: 'image/jpeg',
    webp: 'image/webp',
  };
  const mimeType = typeByFormat[format] || typeByFormat.png;
  const qrUrl = item.qr_image_url || buildQrImageUrl(item.qr_code || '');
  const qrImage = await loadImage(qrUrl);

  const size = 1200;
  const topPadding = 170;
  const sidePadding = 130;
  const bottomPadding = 120;
  const qrSize = size - (sidePadding * 2);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = topPadding + qrSize + bottomPadding;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Unable to prepare image download.');

  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);

  context.fillStyle = '#142033';
  context.font = '700 56px Inter, Arial, sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(String(item.name || 'Inventory Item'), canvas.width / 2, 85, canvas.width - 60);

  context.imageSmoothingEnabled = false;
  context.drawImage(qrImage, sidePadding, topPadding, qrSize, qrSize);

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('Unable to create downloadable image.'));
        return;
      }
      resolve(blob);
    }, mimeType, 0.95);
  });
}

async function downloadNamedQrCode(item, format = 'png') {
  const safeFormat = ['png', 'jpg', 'webp'].includes(format) ? format : 'png';
  const blob = await buildNamedQrBlob(item, safeFormat);
  downloadBlob(`${slugify(item.name)}-qr.${safeFormat}`, blob);
}

function openQrCodePopup(itemId) {
  const item = state.items.find((entry) => String(entry.id) === String(itemId));
  if (!item) {
    showToast('Could not find item QR code.', true);
    return;
  }
  if (!item.qr_image_url && !item.qr_code) {
    showToast('No QR code is available for this item.', true);
    return;
  }

  const overlay = document.createElement('div');
  overlay.className = 'scanner-modal';
  const qrUrl = item.qr_image_url || buildQrImageUrl(item.qr_code);
  overlay.innerHTML = `
    <div class="scanner-modal__card qr-preview-modal">
      <h3>${escapeHtml(item.name)}</h3>
      <p class="helper">Download this QR code with the item name included above the code.</p>
      <img class="qr-preview-modal__image" src="${escapeHtml(qrUrl)}" alt="QR code for ${escapeHtml(item.name)}" />
      <div class="scanner-modal__actions qr-preview-modal__actions">
        <button type="button" class="secondary" data-action="download-qr" data-format="png">Download PNG</button>
        <button type="button" class="secondary" data-action="download-qr" data-format="jpg">Download JPG</button>
        <button type="button" class="secondary" data-action="download-qr" data-format="webp">Download WEBP</button>
        <button type="button" class="ghost" data-action="close">Close</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.querySelector('[data-action="close"]')?.addEventListener('click', close);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close();
  });

  overlay.querySelectorAll('[data-action="download-qr"]').forEach((button) => {
    button.addEventListener('click', async () => {
      const format = button.dataset.format || 'png';
      button.disabled = true;
      try {
        await downloadNamedQrCode(item, format);
        showToast(`Downloaded ${item.name} QR as ${format.toUpperCase()}.`);
      } catch (error) {
        showToast(error.message || 'Failed to download QR code image.', true);
      } finally {
        button.disabled = false;
      }
    });
  });
}

function formToPayload(form) {
  return Object.fromEntries(new FormData(form).entries());
}

async function loadBootstrap() {
  const data = await fetchJson('/api/bootstrap');
  state.items = data.items;
  state.stations = data.stations;
  state.stationRequests = (data.stationRequests || []).map((request) => ({
    ...request,
    requested_items: normalizeRequestedItems(request.requested_items),
    non_inventory_items: normalizeOtherRequestedItems(request.non_inventory_items),
  }));
  state.recentTransactions = data.recentTransactions;
  return data;
}

function requestDetails(request) {
  const requestedItems = Array.isArray(request.requested_items) ? request.requested_items : [];
  const nonInventoryItems = Array.isArray(request.non_inventory_items) ? request.non_inventory_items : [];
  const requestedSummary = requestedItems.length
       ? `<ul>${requestedItems.map((item) => {
         const fulfilled = item.issuedQuantity >= item.quantity;
         const remaining = Math.max(0, item.quantity - (item.issuedQuantity || 0));
         return `<li class="${fulfilled ? 'issued-line' : ''}">${fulfilled ? '✅ ' : ''}${escapeHtml(item.name)}: <strong>${escapeHtml(item.quantity)}</strong>${fulfilled ? '' : ` <span class="helper">(remaining ${remaining})</span>`}</li>`;
       }).join('')}</ul>`
    : '<p class="helper">No inventory items listed.</p>';
 const nonInventorySummary = nonInventoryItems.length
    ? `<ul>${nonInventoryItems.map((item) => {
      const fulfilled = item.issuedQuantity >= item.quantity;
      const remaining = Math.max(0, item.quantity - (item.issuedQuantity || 0));
      return `<li class="${fulfilled ? 'issued-line' : ''}">${fulfilled ? '✅ ' : ''}${escapeHtml(item.name)}: <strong>${escapeHtml(item.quantity)}</strong> <span class="helper">(for ${escapeHtml(item.purpose)})${fulfilled ? '' : ` · remaining ${remaining}`}</span></li>`;
    }).join('')}</ul>`
    : '<p class="helper">No off-list items listed.</p>';

  return `
    ${requestedSummary}
    <p><strong>Items not on inventory list:</strong></p>
    ${nonInventorySummary}
    <p class="helper">Requested by ${escapeHtml(request.requester_name)} · ${new Date(request.created_at).toLocaleString()}</p>
    `;
}

async function scanCodeWithCamera(title = 'Scan barcode or QR code') {
  if (!window.BarcodeDetector || !navigator.mediaDevices?.getUserMedia) {
    throw new Error('Camera scanning is not supported on this device. Type the code manually instead.');
  }

  const detector = new window.BarcodeDetector({
    formats: ['qr_code', 'code_128', 'code_39', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'itf', 'codabar'],
  });

  const overlay = document.createElement('div');
  overlay.className = 'scanner-modal';
  overlay.innerHTML = `
    <div class="scanner-modal__card">
      <h3>${title}</h3>
      <p class="helper">Point your camera at a barcode or QR code.</p>
      <video autoplay playsinline muted></video>
      <div class="scanner-modal__actions">
        <button type="button" data-action="manual" class="secondary">Type code</button>
        <button type="button" data-action="cancel" class="ghost">Cancel</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  const video = overlay.querySelector('video');
  const manualButton = overlay.querySelector('[data-action="manual"]');
  const cancelButton = overlay.querySelector('[data-action="cancel"]');

  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' } },
    audio: false,
  });
  video.srcObject = stream;

  let stopped = false;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    stream.getTracks().forEach((track) => track.stop());
    overlay.remove();
  };

  return new Promise((resolve, reject) => {
    const cancel = () => {
      stop();
      reject(new Error('Scan cancelled.'));
    };

    manualButton.addEventListener('click', () => {
      const typed = window.prompt('Enter barcode or QR code');
      if (!typed) return;
      stop();
      resolve(typed.trim());
    });

    cancelButton.addEventListener('click', cancel);
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) cancel();
    });

    const tick = async () => {
      if (stopped) return;
      try {
        const barcodes = await detector.detect(video);
        const match = barcodes.find((entry) => entry.rawValue)?.rawValue?.trim();
        if (match) {
          stop();
          resolve(match);
          return;
        }
      } catch {
        // Ignore transient detector errors while camera is warming up.
      }
      window.setTimeout(tick, 220);
    };

    tick();
  });
}

function appendCodeToInput(input, code) {
  const current = input.value.split(',').map((value) => value.trim()).filter(Boolean);
  if (!current.includes(code)) current.push(code);
  input.value = current.join(', ');
}

function attachScannerButton(input, button, successMessage, append = false) {
  button.addEventListener('click', async () => {
    try {
      const code = await scanCodeWithCamera();
      if (append) {
        appendCodeToInput(input, code);
      } else {
        input.value = code;
      }
      showToast(successMessage);
    } catch (error) {
      showToast(error.message, true);
    }
  });
}

function setupInventoryCodeScanner(form, config) {
  if (!form) return;
  const codeInput = form.querySelector('input[name="code"]');
  if (!codeInput) return;

  const barcodeButton = form.querySelector(config.barcodeButtonSelector);
  const qrButton = form.querySelector(config.qrButtonSelector);
  if (!barcodeButton || !qrButton) return;

  if (barcodeButton.dataset.scanReady !== 'true') {
    attachScannerButton(codeInput, barcodeButton, config.barcodeSuccess);
    barcodeButton.dataset.scanReady = 'true';
  }

  if (qrButton.dataset.scanReady !== 'true') {
    attachScannerButton(codeInput, qrButton, config.qrSuccess);
    qrButton.dataset.scanReady = 'true';
  }
}

function setupAddItemScanFields(form) {
  if (!form) return;
  const fields = [
    { name: 'barcodes', label: 'Scan barcode', success: 'Barcode added.', append: true },
    { name: 'qrCode', label: 'Scan QR code', success: 'QR code captured.' },
  ];

  fields.forEach((entry) => {
    const input = form.querySelector(`input[name="${entry.name}"]`);
    if (!input || input.dataset.scanReady === 'true') return;

    const wrapper = document.createElement('div');
    wrapper.className = 'input-with-action';
    input.parentNode.insertBefore(wrapper, input);
    wrapper.appendChild(input);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'secondary';
    button.textContent = entry.label;
    wrapper.appendChild(button);

    attachScannerButton(input, button, entry.success, Boolean(entry.append));
    input.dataset.scanReady = 'true';
  });
}

function renderMain() {
  const searchInput = document.querySelector('#main-item-search');
  if (searchInput) {
    if (searchInput.dataset.bound !== 'true') {
      searchInput.addEventListener('input', (event) => {
        state.mainSearchTerm = event.target.value.trim().toLowerCase();
        renderMain();
      });
      searchInput.dataset.bound = 'true';
    }
    if (searchInput.value !== state.mainSearchTerm) {
      searchInput.value = state.mainSearchTerm;
    }
  }

  const filteredItems = state.mainSearchTerm
    ? getScopedItems().filter((item) => {
      const name = String(item.name || '').toLowerCase();
      const sku = String(item.sku || '').toLowerCase();
      return name.includes(state.mainSearchTerm) || sku.includes(state.mainSearchTerm);
    })
    : getScopedItems();

  const scopedItems = getScopedItems();
  document.querySelector('#total-item-count').textContent = `${scopedItems.length} items`;
  document.querySelector('#total-stock-count').textContent = `${scopedItems.reduce((sum, item) => sum + item.total_quantity, 0)} total units`;
  const table = document.querySelector('#inventory-table');
  table.innerHTML = filteredItems.length
    ? filteredItems.map((item) => `
      <tr>
        <td>${item.name}</td>
        <td>${item.sku}</td>
        <td>
           ${(item.qr_image_url || item.qr_code)
            ? `<button type="button" class="qr-thumb-button" data-action="open-qr-popup" data-item-id="${item.id}" title="Open QR code">
                <img class="qr-thumb" src="${escapeHtml(item.qr_image_url || buildQrImageUrl(item.qr_code))}" alt="QR code for ${escapeHtml(item.name)}" loading="lazy" />
              </button>`
            : '<span class="helper">No QR</span>'}
        </td>
        <td>${item.total_quantity}</td>
        <td>${currency(item.unit_cost)}</td>
        <td>
        <button
            type="button"
            class="success"
            data-action="modify-item"
            data-item-id="${item.id}"
          >Modify</button>
          <button
            type="button"
            class="danger"
            data-action="delete-item"
            data-item-id="${item.id}"
            data-item-name="${escapeHtml(item.name)}"
          >Delete</button>
        </td>
      </tr>
    `).join('')
     : `<tr><td colspan="6">${scopedItems.length ? 'No items match your search.' : 'No inventory items yet.'}</td></tr>`;

  table.querySelectorAll('[data-action="delete-item"]').forEach((button) => {
    button.addEventListener('click', () => {
      openDeletePrompt(button.dataset.itemId, button.dataset.itemName).catch((error) => showToast(error.message, true));
    });
  });

  table.querySelectorAll('[data-action="modify-item"]').forEach((button) => {
    button.addEventListener('click', () => {
      openModifyPrompt(button.dataset.itemId).catch((error) => showToast(error.message, true));
    });
  });

  table.querySelectorAll('[data-action="open-qr-popup"]').forEach((button) => {
    button.addEventListener('click', () => openQrCodePopup(button.dataset.itemId));
  });
  
  const stationList = document.querySelector('#station-status-list');
    if (!stationList) return;
    const requestsByStation = getActiveStationRequests().reduce((acc, request) => {
    if (!acc[request.station_id]) acc[request.station_id] = [];
    acc[request.station_id].push(request);
    return acc;
  }, {});

  stationList.innerHTML = state.stations.map((station) => {
    const requests = requestsByStation[station.id] || [];
    const hasOpenRequest = requests.length > 0;
    return `
     <article class="station-status ${hasOpenRequest ? 'station-status--open' : 'station-status--clear'}" data-station-id="${station.id}">
        <button type="button" class="station-status__toggle" data-action="toggle-station" aria-expanded="false">
          <div class="station-status__header">
            <strong>${escapeHtml(station.name)}</strong>
            <span>${hasOpenRequest ? `${requests.length} pending request${requests.length === 1 ? '' : 's'}` : 'No pending requests'}</span>
          </div>
        </button>
        <div class="station-status__panel hidden">
          ${hasOpenRequest
            ? `<div class="station-status__requests">${requests.map((request) => `<div class="station-status__request">${requestDetails(request)}</div>`).join('')}</div>`
            : '<p class="helper">No current pending request details for this station.</p>'}
        </div>
      </article>
    `;
  }).join('');
  
  stationList.querySelectorAll('[data-action="toggle-station"]').forEach((button) => {
    button.addEventListener('click', () => {
      const panel = button.parentElement?.querySelector('.station-status__panel');
      if (!panel) return;
      const isHidden = panel.classList.contains('hidden');
      panel.classList.toggle('hidden', !isHidden);
      button.setAttribute('aria-expanded', isHidden ? 'true' : 'false');
    });
  });
  
  const shoppingListPanel = document.querySelector('#shopping-list-panel');
  const shoppingListContent = document.querySelector('#shopping-list-content');
  if (!shoppingListPanel || !shoppingListContent) return;

  const lowStockItems = getScopedItems().filter((item) => item.total_quantity < item.low_stock_level);
  shoppingListPanel.classList.toggle('shopping-list--alert', lowStockItems.length > 0);
  shoppingListPanel.classList.toggle('shopping-list--clear', lowStockItems.length === 0);

  shoppingListContent.innerHTML = lowStockItems.length
    ? `
      <ul class="shopping-list__items">
        ${lowStockItems.map((item) => `
          <li class="shopping-list__item">
            <strong>${escapeHtml(item.name)}</strong>
            <span>Current stock: ${item.total_quantity} (minimum: ${item.low_stock_level})</span>
          </li>
        `).join('')}
      </ul>
    `
    : '<p class="helper">Nothing to purchase right now. All inventory is at or above minimum levels.</p>';
}

async function openDeletePrompt(itemId, itemName) {
  const overlay = document.createElement('div');
  overlay.className = 'scanner-modal';
  overlay.innerHTML = `
    <div class="scanner-modal__card">
      <h3>Delete Inventory Item</h3>
      <p>You are deleting: <strong>${escapeHtml(itemName)}</strong></p>
      <label>Name or department employee number
        <input type="text" name="employeeOrDepartment" placeholder="e.g. 12345 or Supply Dept" required />
      </label>
      <label class="checkbox-label">
        <input type="checkbox" name="confirmDelete" />
        I understand this item will be removed from active inventory.
      </label>
      <div class="scanner-modal__actions">
        <button type="button" class="ghost" data-action="cancel">Cancel</button>
        <button type="button" data-action="submit" disabled>Submit deletion</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  const identityInput = overlay.querySelector('input[name="employeeOrDepartment"]');
  const confirmCheckbox = overlay.querySelector('input[name="confirmDelete"]');
  const submitButton = overlay.querySelector('[data-action="submit"]');

  confirmCheckbox.addEventListener('change', () => {
    submitButton.disabled = !confirmCheckbox.checked;
  });

  overlay.querySelector('[data-action="cancel"]')?.addEventListener('click', close);
  submitButton.addEventListener('click', async () => {
    const employeeOrDepartment = identityInput.value.trim();
  if (!employeeOrDepartment) {
      showToast('Enter a name or department employee number.', true);
      return;
    }

    try {
      await fetchJson('/api/items/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          itemId,
          performedBy: employeeOrDepartment,
          employeeOrDepartment,
          confirmed: confirmCheckbox.checked,
        }),
      });
      close();
      await loadBootstrap();
      renderMain();
      showTimedPopup('Item has been deleted/removed from the inventory system.', 5000);
    } catch (error) {
      showToast(error.message, true);
    }
  });
}

function buildChangeSummary(originalItem, nextItem) {
  const changes = [];
  const pushChange = (label, from, to) => {
    if (String(from ?? '') === String(to ?? '')) return;
    changes.push({ label, from: String(from ?? '—') || '—', to: String(to ?? '—') || '—' });
  };

  pushChange('Item name', originalItem.name, nextItem.name);
  pushChange('SKU', originalItem.sku, nextItem.sku);
  pushChange('QR code', originalItem.qr_code, nextItem.qrCode);
  pushChange('Barcodes', (originalItem.barcodes || []).join(', '), nextItem.barcodes.join(', '));
  pushChange('Minimum par/restock level', originalItem.low_stock_level, nextItem.lowStockLevel);
  pushChange('Current stock level', originalItem.total_quantity, nextItem.totalQuantity);
  pushChange('Unit cost', Number(originalItem.unit_cost || 0).toFixed(2), Number(nextItem.unitCost || 0).toFixed(2));

  return changes;
}

function renderChangeSummaryHtml(changes) {
  return `
    <h4>Summary of changes</h4>
    <ul>
      ${changes.map((change) => `<li><strong>${escapeHtml(change.label)}:</strong> ${escapeHtml(change.from)} → ${escapeHtml(change.to)}</li>`).join('')}
    </ul>
  `;
}

async function openModifyPrompt(itemId) {
  const item = state.items.find((entry) => Number(entry.id) === Number(itemId));
  if (!item) {
    showToast('Unable to find the selected item.', true);
    return;
  }

  const overlay = document.createElement('div');
  overlay.className = 'scanner-modal';
  overlay.innerHTML = `
    <div class="scanner-modal__card">
      <h3>Modify Item</h3>
      <p class="helper">Review and edit item details below.</p>
      <label>Item name
        <input type="text" name="name" value="${escapeHtml(item.name)}" required />
      </label>
      <label>SKU
        <input type="text" name="sku" value="${escapeHtml(item.sku)}" required />
      </label>
      <label>Item QR code
        <div class="input-with-action">
          <input type="text" name="qrCode" value="${escapeHtml(item.qr_code || '')}" required />
          <button type="button" class="secondary" data-action="generate-qr-code">Generate new QR code</button>
          <button type="button" class="secondary" data-action="scan-qr-code">Scan new QR code</button>
        </div>
      </label>
      <label>Barcodes (comma separated list)
        <div class="input-with-action">
          <input type="text" name="barcodes" value="${escapeHtml((item.barcodes || []).join(', '))}" />
          <button type="button" class="secondary" data-action="scan-barcode">Scan new barcode</button>
        </div>
      </label>
      <label>Minimum par/restock level
        <input type="number" min="0" step="1" name="lowStockLevel" value="${item.low_stock_level}" required />
      </label>
      <label>Current stock level
        <input type="number" min="0" step="1" name="totalQuantity" value="${item.total_quantity}" required />
      </label>
      <label>Unit cost
        <input type="number" min="0" step="0.01" name="unitCost" value="${item.unit_cost}" required />
      </label>
      <label>Description
        <input type="text" name="description" value="${escapeHtml(item.description || '')}" />
      </label>
      <label>Edited by
        <input type="text" name="performedBy" value="Main Page User" required />
      </label>
      <div class="scanner-modal__actions">
        <button type="button" class="danger" data-action="cancel">Cancel edit</button>
        <button type="button" class="success" data-action="submit">Submit</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  const submitButton = overlay.querySelector('[data-action="submit"]');

  const barcodesInput = overlay.querySelector('input[name="barcodes"]');
  const scanBarcodeButton = overlay.querySelector('[data-action="scan-barcode"]');
  const qrCodeInput = overlay.querySelector('input[name="qrCode"]');
  const generateQrCodeButton = overlay.querySelector('[data-action="generate-qr-code"]');
  const scanQrCodeButton = overlay.querySelector('[data-action="scan-qr-code"]');
  generateQrCodeButton?.addEventListener('click', () => {
    if (!qrCodeInput) return;
    qrCodeInput.value = buildGeneratedQrCode();
    showToast('New QR code value generated.');
  });
  if (qrCodeInput && scanQrCodeButton) {
    attachScannerButton(qrCodeInput, scanQrCodeButton, 'QR code captured.');
  }
  if (barcodesInput && scanBarcodeButton) {
    attachScannerButton(barcodesInput, scanBarcodeButton, 'Barcode added.', true);
  }

  overlay.querySelector('[data-action="cancel"]')?.addEventListener('click', close);
  submitButton.addEventListener('click', async () => {
    const payload = Object.fromEntries(
      [...overlay.querySelectorAll('input[name]')].map((input) => [input.name, input.value])
    );
    const nextItem = {
      ...payload,
      barcodes: String(payload.barcodes || '').split(',').map((value) => value.trim()).filter(Boolean),
      lowStockLevel: Number.parseInt(payload.lowStockLevel, 10),
      totalQuantity: Number.parseInt(payload.totalQuantity, 10),
      unitCost: Number.parseFloat(payload.unitCost),
    };

    if (!nextItem.name || !nextItem.sku || !nextItem.qrCode || !nextItem.performedBy) {
      showToast('Name, SKU, QR code, and Edited by are required.', true);
      return;
    }
    if ([nextItem.lowStockLevel, nextItem.totalQuantity].some((value) => Number.isNaN(value) || value < 0)) {
      showToast('Stock levels must be 0 or greater.', true);
      return;
    }
    if (Number.isNaN(nextItem.unitCost) || nextItem.unitCost < 0) {
      showToast('Unit cost must be 0 or greater.', true);
      return;
    }

    const changes = buildChangeSummary(item, nextItem);
    if (!changes.length) {
      showToast('No changes detected for this item.', true);
      return;
    }

    try {
      await fetchJson('/api/items', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          itemId: item.id,
          name: nextItem.name,
          sku: nextItem.sku,
          supplyGroup: item.supply_group || currentSupplyGroup || 'station',
          qrCode: nextItem.qrCode,
          barcodes: nextItem.barcodes.join(', '),
          lowStockLevel: nextItem.lowStockLevel,
          totalQuantity: nextItem.totalQuantity,
          unitCost: nextItem.unitCost,
          description: nextItem.description,
          performedBy: nextItem.performedBy,
        }),
      });
      close();
      await loadBootstrap();
      renderMain();
      showTimedPopup(`
        Item changes have been saved.
        ${renderChangeSummaryHtml(changes)}
      `, 7000);
    } catch (error) {
      showToast(error.message, true);
    }
  });
}

function renderInventoryPage() {
  renderRecentTransactions();
}

function renderIssuePage() {
  const stationList = document.querySelector('#issue-station-list');
  if (!stationList) return;
  const requestsByStation = getActiveStationRequests().reduce((acc, request) => {
    if (!acc[request.station_id]) acc[request.station_id] = [];
    acc[request.station_id].push(request);
    return acc;
  }, {});

  stationList.innerHTML = state.stations.map((station) => {
    const requests = requestsByStation[station.id] || [];
    const hasOpenRequest = requests.length > 0;
     const requestItems = requests.length
      ? `<div class="issue-request-list">${requests.map((request) => {
        const items = Array.isArray(request.requested_items) ? request.requested_items : [];
        const hasIssuedItems = items.some((item) => (item.issuedQuantity || 0) > 0);
        const allIssued = items.length > 0 && items.every((item) => (item.issuedQuantity || 0) >= item.quantity);
        return `
          <article class="issue-request-card ${hasIssuedItems && !allIssued ? 'issue-request-card--partial' : ''}">
            <strong>Request #${request.id}</strong>
            <ul>
              ${items.map((item) => {
                const fulfilled = (item.issuedQuantity || 0) >= item.quantity;
                const remaining = Math.max(0, item.quantity - (item.issuedQuantity || 0));
                return `<li class="${fulfilled ? 'issued-line' : ''}">${fulfilled ? '✅ ' : '⬜ '}${escapeHtml(item.name)}: <strong>${item.quantity}</strong>${fulfilled ? '' : ` <span class="helper">(remaining ${remaining})</span>`}</li>`;
              }).join('')}
            </ul>
          </article>
        `;
      }).join('')}</div>`
      : '<p class="helper">No inventory items are currently requested.</p>';

    return `
      <article class="issue-station-listing ${hasOpenRequest ? 'issue-station-listing--open' : 'issue-station-listing--clear'}" data-station-id="${station.id}">
        <div class="issue-station-listing__header">
          <button type="button" class="issue-station-listing__toggle" data-action="toggle-station-issue" aria-expanded="false">
            <strong>${escapeHtml(station.name)}</strong> · ${hasOpenRequest ? `${requests.length} active request${requests.length === 1 ? '' : 's'}` : 'No active requests'}
          </button>
          <div class="issue-station-listing__actions">
                   <button type="button" data-action="open-issue-items" data-station-id="${station.id}">Issue items</button>
          </div>
        </div>
        <div class="issue-station-listing__panel hidden">
          ${requestItems}
        </div>
      </article>
    `;
  }).join('');
  
  renderRecentTransactions();
}

function renderRestockPage() {
  renderRecentTransactions();
}

function renderRecentTransactions() {
  const txList = document.querySelector('#transaction-list');
  const scopedTransactions = getScopedTransactions();
  txList.innerHTML = scopedTransactions.length
    ? scopedTransactions.map((txn) => `
      <article class="txn">
        <strong>${txn.item_name} (${txn.item_sku})</strong>
        <div>${txn.quantity_delta >= 0 ? '+' : ''}${txn.quantity_delta} · ${txn.action_type} · ${txn.station_name || 'Main inventory'}${txn.apparatus_name ? ` · ${escapeHtml(txn.apparatus_name)}` : ''}</div>
        <div class="helper">${new Date(txn.created_at).toLocaleString()} · Changed by: ${txn.performed_by || 'Unknown'} · Source: ${txn.source}</div>
        ${txn.note ? `<div>${txn.note}</div>` : ''}
      </article>
    `).join('')
    : '<p class="helper">No changes yet.</p>';
}

async function wireInventoryPage() {
  const addForm = document.querySelector('#add-item-form');
if (!addForm) return;

  setupAddItemScanFields(addForm);

  const qrInput = addForm.querySelector('#add-item-qr');
  const barcodeInput = addForm.querySelector('#add-item-barcodes');
  const skipBarcodeInput = addForm.querySelector('#add-item-skip-barcode');
  const dateTimeInput = addForm.querySelector('#add-item-datetime');
  const performedByInput = addForm.querySelector('#add-item-performed-by');
  const unitCostInput = addForm.querySelector('#add-item-unit-cost');
  const reviewSection = addForm.querySelector('#add-item-review');
  const reviewContent = addForm.querySelector('#add-item-review-content');
  const submitButton = addForm.querySelector('#add-item-submit');
  const reviewConfirmInput = addForm.querySelector('#add-item-review-confirm');
  const nameInput = addForm.querySelector('#add-item-name');
  const generateQrButton = addForm.querySelector('#add-item-generate-qr');
  const qrPreviewSection = addForm.querySelector('#add-item-qr-preview');
  const medicalItemFields = addForm.querySelector('#medical-item-fields');
  const qrPreviewImage = addForm.querySelector('#add-item-qr-preview-image');
  
  const qrDownloadLink = addForm.querySelector('#add-item-qr-download-link');
  const syncBarcodeState = () => {
    const disabled = skipBarcodeInput.checked;
    barcodeInput.disabled = disabled;
    const barcodeScanButton = barcodeInput.parentElement?.querySelector('button');
    if (barcodeScanButton) barcodeScanButton.disabled = disabled;
    if (disabled) barcodeInput.value = '';
  };

  const lastPerformerKey = 'add-item:lastPerformer';
  const draftKey = (qrCode) => `add-item:lastCost:${String(qrCode || '').trim().toLowerCase()}`;

  const resetReviewState = () => {
    reviewSection.classList.add('hidden');
    reviewConfirmInput.checked = false;
    submitButton.disabled = false;
  };

  const renderQrPreview = (value) => {
    const codeValue = String(value || '').trim();
    if (!codeValue) {
      qrPreviewSection?.classList.add('hidden');
      if (qrPreviewImage) qrPreviewImage.removeAttribute('src');
      if (qrDownloadLink) qrDownloadLink.setAttribute('href', '#');
      return;
    }

    const imageUrl = buildQrImageUrl(codeValue);
    if (qrPreviewImage) qrPreviewImage.src = imageUrl;
    if (qrDownloadLink) qrDownloadLink.href = imageUrl;
    qrPreviewSection?.classList.remove('hidden');
  };
  
  const buildReviewHtml = () => {
    const values = formToPayload(addForm);
    return `
      <div><strong>QR code:</strong> ${values.qrCode || '—'}</div>
      <div><strong>Barcode(s):</strong> ${skipBarcodeInput.checked ? 'Skipped' : (values.barcodes || '—')}</div>
      ${currentSupplyGroup === 'medical' ? `<div><strong>Lot number:</strong> ${values.lotNumber || '—'}</div><div><strong>Lot barcode:</strong> ${values.lotBarcode || '—'}</div><div><strong>Expiration date:</strong> ${values.expirationDate || '—'}</div>` : ''}
      <div><strong>Item name:</strong> ${values.name || '—'}</div>
      <div><strong>Quantity:</strong> ${values.totalQuantity || '—'}</div>
      <div><strong>Low stock level:</strong> ${values.lowStockLevel || '—'}</div>
      <div><strong>Unit cost:</strong> ${values.unitCost ? currency(values.unitCost) : 'Not provided'}</div>
      <div><strong>Date/time:</strong> ${values.performedAt || '—'}</div>
      <div><strong>Completed by:</strong> ${values.performedBy || '—'}</div>
      <div><strong>Notes:</strong> ${values.note || 'None'}</div>
    `;
  };

  dateTimeInput.value = formatDateTimeLocal();
  performedByInput.value = window.localStorage.getItem(lastPerformerKey) || '';
  medicalItemFields?.classList.toggle('hidden', currentSupplyGroup !== 'medical');
  syncBarcodeState();
  skipBarcodeInput.addEventListener('change', () => {
    syncBarcodeState();
    resetReviewState();
  });
  reviewConfirmInput.addEventListener('change', () => {
     if (reviewSection.classList.contains('hidden')) return;
    submitButton.disabled = !reviewConfirmInput.checked;
  });

  [qrInput, barcodeInput, unitCostInput, performedByInput, nameInput].forEach((input) => {
    input?.addEventListener('input', resetReviewState);
  });
  
  qrInput?.addEventListener('input', () => renderQrPreview(qrInput.value));

  qrInput?.addEventListener('change', () => {
    const rememberedCost = window.localStorage.getItem(draftKey(qrInput.value));
    if (rememberedCost != null) unitCostInput.value = rememberedCost;
  });

  generateQrButton?.addEventListener('click', () => {
    const generatedCode = buildGeneratedQrCode();
    qrInput.value = generatedCode;
    renderQrPreview(generatedCode);
    resetReviewState();
    showToast('QR code value generated.');
  });
  
  addForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
     if (reviewSection.classList.contains('hidden')) {
      if (!addForm.reportValidity()) return;
      reviewContent.innerHTML = buildReviewHtml();
      reviewSection.classList.remove('hidden');
      submitButton.disabled = !reviewConfirmInput.checked;
      showToast('Review and confirm the summary before submitting.');
      return;
    }

    if (!reviewConfirmInput.checked) {
      showToast('Review and confirm the summary before submitting.', true);
      return;
    }

    const payload = formToPayload(addForm);
    payload.supplyGroup = currentSupplyGroup || 'station';
    payload.skipBarcodeCapture = skipBarcodeInput.checked ? 'true' : 'false';
    try {
      await fetchJson('/api/items', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (payload.performedBy) window.localStorage.setItem(lastPerformerKey, payload.performedBy);
      if (payload.qrCode && payload.unitCost !== '') window.localStorage.setItem(draftKey(payload.qrCode), payload.unitCost);
      addForm.reset();
      dateTimeInput.value = formatDateTimeLocal();
      performedByInput.value = window.localStorage.getItem(lastPerformerKey) || '';
      skipBarcodeInput.checked = true;
      syncBarcodeState();
      renderQrPreview('');
      resetReviewState();
      await loadBootstrap();
      renderInventoryPage();
      showTimedPopup('Item has been added and saved to the inventory system.', 5000);
    } catch (error) {
      showToast(error.message, true);
    }
  });
  
  renderQrPreview(qrInput?.value || '');
}

function buildRequestedItemsForStation(stationId) {
  const requests = getActiveStationRequests().filter((request) => Number(request.station_id) === Number(stationId));
  return requests.flatMap((request) => {
    const requestedItems = Array.isArray(request.requested_items) ? request.requested_items : [];
    const nonInventoryItems = Array.isArray(request.non_inventory_items) ? request.non_inventory_items : [];
    const inventoryEntries = requestedItems.map((entry, itemIndex) => {
      const inventoryItem = state.items.find((item) => Number(item.id) === Number(entry.itemId))
        || state.items.find((item) => item.name.trim().toLowerCase() === String(entry.name || '').trim().toLowerCase());
      const issuedQuantity = Number.parseInt(entry.issuedQuantity || 0, 10);
      const quantity = Number.parseInt(entry.quantity || 0, 10);
      const remaining = Math.max(0, quantity - (Number.isInteger(issuedQuantity) ? issuedQuantity : 0));
      return {
        requestId: request.id,
        requestCreatedAt: request.created_at,
        itemIndex,
        itemId: inventoryItem?.id || null,
        itemName: inventoryItem?.name || entry.name,
        supplyGroup: request.supply_group || inventoryItem?.supply_group || '',
        requestedQuantity: quantity,
        issuedQuantity: Number.isInteger(issuedQuantity) ? issuedQuantity : 0,
        remainingQuantity: remaining,
        available: Number.parseInt(inventoryItem?.total_quantity || 0, 10),
        purpose: '',
        isNonInventory: false,
      };
    });

    const nonInventoryEntries = nonInventoryItems.map((entry, itemIndex) => {
      const issuedQuantity = Number.parseInt(entry.issuedQuantity || 0, 10);
      const quantity = Number.parseInt(entry.quantity || 0, 10);
      const remaining = Math.max(0, quantity - (Number.isInteger(issuedQuantity) ? issuedQuantity : 0));
      return {
        requestId: request.id,
        requestCreatedAt: request.created_at,
        itemIndex,
        itemId: null,
        itemName: String(entry.name || '').trim(),
        supplyGroup: request.supply_group || entry.supplyGroup || '',
        requestedQuantity: quantity,
        issuedQuantity: Number.isInteger(issuedQuantity) ? issuedQuantity : 0,
        remainingQuantity: remaining,
        available: 0,
        purpose: String(entry.purpose || '').trim(),
        isNonInventory: true,
      };
    });

    return [...inventoryEntries, ...nonInventoryEntries];
  });
}

function openIssueItemsModal(stationId) {
  const station = state.stations.find((entry) => Number(entry.id) === Number(stationId));
  if (!station) {
    showToast('Unable to find station for issuing items.', true);
    return;
  }
  
 const requestedItems = buildRequestedItemsForStation(stationId);
  const issueEntries = requestedItems
    .filter((item) => item.itemId && item.available > 0)
    .map((item) => ({
      requestId: item.requestId,
      itemId: item.itemId,
      itemName: item.itemName,
      available: item.available,
      requestedQuantity: item.requestedQuantity,
      issuedQuantity: item.issuedQuantity,
      remainingQuantity: item.remainingQuantity,
      issueQuantity: item.remainingQuantity > 0 ? Math.min(Math.max(1, item.remainingQuantity), item.available) : 0,
      isComplete: item.remainingQuantity <= 0,
      markedUnable: false,
      isPartialRequest: item.issuedQuantity > 0 && item.remainingQuantity > 0,
      code: '',
           source: 'request',
        purpose: item.purpose || '',
        isNonInventory: false,
      }));
  const unresolvedEntries = requestedItems
    .filter((item) => item.remainingQuantity > 0 && !item.itemId)
    .map((item) => ({
      requestId: item.requestId,
      itemName: item.itemName,
      requestedQuantity: item.requestedQuantity,
      issuedQuantity: item.issuedQuantity,
      remainingQuantity: item.remainingQuantity,
      purpose: item.purpose || '',
      isNonInventory: Boolean(item.isNonInventory),
    }));

  const overlay = document.createElement('div');
  overlay.className = 'scanner-modal';
  const lastIssuerKey = 'issue:lastIssuerIdentity';
  const rememberedIdentity = window.localStorage.getItem(lastIssuerKey) || '';

  overlay.innerHTML = `
    <div class="scanner-modal__card">
      <h3>Issue items · ${escapeHtml(station.name)}</h3>
      <p class="helper">Review each requested item, set quantities to issue, and submit once inventory has been pulled.</p>
      <label>Name or employee number
        <input type="text" name="issuedBy" value="${escapeHtml(rememberedIdentity)}" required />
      </label>
      ${currentSupplyGroup === 'medical' ? `
        <label>Apparatus assignment (optional)
          <input type="text" name="apparatusName" placeholder="Engine 1, Medic 2, Ladder 3..." />
        </label>
        <p class="helper">Medical issues will be recorded with the station and any apparatus you enter.</p>
      ` : ''}
       <p class="helper">If no request is active, scan an item QR code or barcode to start issuing items.</p>
      <div data-role="issueItems" class="issue-entry-list"></div>
      <div class="inline-actions">
        <button type="button" data-action="scan-item" class="secondary">Scan item QR or barcode</button>
        <button type="button" data-action="add-another-item">Add another item</button>
      </div>
          <div data-role="unresolvedItems" class="restock-followup hidden"></div>
      <label class="checkbox-label">
        <input type="checkbox" name="confirmedPulled" />
         I acknowledge these items are being pulled from inventory and the quantities are correct.
      </label>
      <div data-role="issueSummary" class="restock-followup hidden"></div>
      <div data-role="cancelConfirm" class="hidden restock-followup stack compact">
        <p>Are you sure you want to cancel issuing these items?</p>
        <div class="inline-actions">
          <button type="button" data-action="confirm-cancel" class="danger">Yes cancel issue items</button>
          <button type="button" data-action="go-back" class="request-success">Go back to continue issuing items</button>
        </div>
      </div>
      <div class="scanner-modal__actions">
        <button type="button" class="danger" data-action="cancel">Cancel</button>
        <button type="button" data-action="submit" class="request-success" disabled>Submit</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  const submitButton = overlay.querySelector('[data-action="submit"]');
  const confirmPulled = overlay.querySelector('input[name="confirmedPulled"]');
  const identityInput = overlay.querySelector('input[name="issuedBy"]');
  const issueItemsEl = overlay.querySelector('[data-role="issueItems"]');
  const apparatusNameInput = overlay.querySelector('input[name="apparatusName"]');
  const cancelConfirm = overlay.querySelector('[data-role="cancelConfirm"]');
  const issueSummary = overlay.querySelector('[data-role="issueSummary"]');
  const unresolvedItemsEl = overlay.querySelector('[data-role="unresolvedItems"]');
  const scanItemButton = overlay.querySelector('[data-action="scan-item"]');
  const addAnotherButton = overlay.querySelector('[data-action="add-another-item"]');

  const renderIssueItems = () => {
    issueItemsEl.innerHTML = issueEntries.length
      ? issueEntries.map((item, index) => `
       <article class="issue-entry ${item.isPartialRequest ? 'issue-entry--partial' : ''} ${item.markedUnable ? 'issue-entry--unable' : ''}" data-index="${index}">
          <div class="issue-entry__header">
            <strong class="${item.isComplete ? 'issued-line' : ''}">${escapeHtml(item.itemName)}</strong>
            <label class="checkbox-label issue-entry__unable-toggle">
              <input type="checkbox" data-field="unableToIssue" ${item.isComplete || item.markedUnable ? 'checked' : ''} ${item.isComplete ? 'disabled' : ''} />
              ${item.isComplete ? 'Issued' : 'Unable to issue'}
            </label>
          </div>
          <div class="issue-entry__meta helper">
            ${item.source === 'request' ? '<span>Loaded from request queue</span>' : ''}
            ${item.code ? `<span>Scanned code: ${escapeHtml(item.code)}</span>` : ''}
          </div>
          <div class="issue-entry__counts">
            <span><strong>Requested:</strong> ${item.requestedQuantity}</span>
            <span><strong>Issued:</strong> ${item.issuedQuantity}</span>
            <span><strong>Remaining:</strong> ${item.remainingQuantity}</span>
            <span><strong>In stock:</strong> ${item.available}</span>
          </div>
          ${currentSupplyGroup === 'medical'
            ? `<label class="issue-entry__qty">Medical lot
                <select data-field="medicalLotId" ${item.isComplete || item.markedUnable ? 'disabled' : ''}>
                  <option value="">Select lot</option>
                  ${(item.medicalLots || [])
                    .filter((lot) => Number(lot.quantity_on_hand || 0) > 0)
                    .map((lot) => {
                      const status = expirationStatus(lot.expiration_date);
                      return `<option value="${lot.id}" ${String(item.medicalLotId || '') === String(lot.id) ? 'selected' : ''}>${escapeHtml(lot.lot_number)} · ${escapeHtml(status.label)} · ${lot.quantity_on_hand} on hand</option>`;
                    }).join('')}
                </select>
              </label>`
            : ''}
          ${item.markedUnable ? '<div class="helper">Marked as unable to issue for this submission.</div>' : ''}
          <label class="issue-entry__qty">Quantity to issue
            <input type="number" min="1" max="${Math.max(1, Math.min(item.available, item.remainingQuantity || item.available))}" value="${item.issueQuantity}" data-field="issueQty" ${item.isComplete || item.markedUnable ? 'disabled' : ''} />
          </label>
          </article>
      `).join('')
      : '<p class="helper">No items selected yet. Scan an item QR code or barcode to begin issuing.</p>';
  };

  const renderUnresolvedItems = () => {
    if (!unresolvedEntries.length) {
      unresolvedItemsEl.classList.add('hidden');
      unresolvedItemsEl.innerHTML = '';
      return;
    }

    unresolvedItemsEl.classList.remove('hidden');
    unresolvedItemsEl.innerHTML = `
      <strong>Requested items not available in inventory list</strong>
      <ul>
        ${unresolvedEntries.map((item, index) => `
          <li>
            <strong>${escapeHtml(item.itemName)}</strong>: ${item.remainingQuantity} pending
            ${item.purpose ? `<span class="helper">(for ${escapeHtml(item.purpose)})</span>` : ''}
            <button type="button" class="secondary" data-action="add-missing-item" data-index="${index}">Add to inventory</button>
          </li>
        `).join('')}
      </ul>
    `;
  };

  const openAddMissingItemModal = async (entryIndex) => {
    const entry = unresolvedEntries[entryIndex];
    if (!entry) return;
    
    const defaultIssuedBy = identityInput.value.trim() || rememberedIdentity || 'Supply Officer';
    const quantityDefault = Math.max(1, entry.remainingQuantity || entry.requestedQuantity || 1);
    const noteDefault = `Added from request #${entry.requestId} for ${station.name}.`;
      const generatedQr = buildGeneratedQrCode();
    const modal = document.createElement('div');
    modal.className = 'scanner-modal';
    modal.innerHTML = `
      <div class="scanner-modal__card">
        <h3>Add missing item to inventory</h3>
        <p class="helper">This mirrors the Add new inventory item form and pre-fills details from the station request.</p>
        <form data-role="add-missing-item-form" class="stack compact">
          <label>
            Scan new item QR code (required)
            <div class="input-with-action">
              <input name="qrCode" data-field="qrCode" required />
              <button type="button" class="secondary" data-action="generate-qr">Generate QR</button>
            </div>
          </label>
          <section data-role="qr-preview" class="restock-followup hidden">
            <h3>Generated QR preview</h3>
            <p class="helper">Save or print this QR image for labeling this item.</p>
            <a data-role="qr-download-link" href="#" target="_blank" rel="noopener noreferrer">
              <img data-role="qr-preview-image" class="qr-thumb" alt="Generated QR code preview" />
            </a>
          </section>
          <label class="checkbox-label">
            <input type="checkbox" name="skipBarcodeCapture" data-field="skipBarcode" checked />
            Skip barcode scan (checked by default)
          </label>
          <label>Scan item barcode (optional, can add more later)<input name="barcodes" data-field="barcodes" placeholder="Scan barcode(s), separated by commas" /></label>
          <label>Item name<input name="name" data-field="name" required /></label>
          <label>Quantity being restocked<input name="totalQuantity" data-field="totalQuantity" type="number" min="1" required /></label>
          <label>Low stock / reorder level<input name="lowStockLevel" data-field="lowStockLevel" type="number" min="0" required /></label>
          <label>Cost per unit (optional)<input name="unitCost" data-field="unitCost" type="number" min="0" step="0.01" placeholder="0.00" /></label>
          <label>Date and time<input name="performedAt" data-field="performedAt" type="datetime-local" required /></label>
          <label>Completed by (name or employee number)<input name="performedBy" data-field="performedBy" required /></label>
          <label>Notes (optional)<input name="note" data-field="note" /></label>
          <label>Description (optional)<input name="description" data-field="description" /></label>
          <label>SKU (optional; auto-generated if blank)<input name="sku" data-field="sku" placeholder="Optional custom SKU" /></label>
          ${currentSupplyGroup === 'medical' ? `
            <section class="restock-followup">
              <h3>Medical item tracking</h3>
              <label>Lot number<input name="lotNumber" data-field="lotNumber" placeholder="Required for medical items" /></label>
              <label>Lot barcode (optional)<input name="lotBarcode" data-field="lotBarcode" placeholder="Scan or type lot barcode" /></label>
              <label>Expiration date<input name="expirationDate" data-field="expirationDate" type="date" /></label>
            </section>
          ` : ''}
          <div class="scanner-modal__actions">
            <button type="button" class="ghost" data-action="cancel-add-missing">Cancel</button>
            <button type="submit" class="request-success">Add item</button>
          </div>
        </form>
      </div>
    `;
    document.body.appendChild(modal);

    const closeModal = () => modal.remove();
    const addMissingForm = modal.querySelector('[data-role="add-missing-item-form"]');
    const qrCodeInput = modal.querySelector('[data-field="qrCode"]');
    const skipBarcodeInput = modal.querySelector('[data-field="skipBarcode"]');
    const barcodeInput = modal.querySelector('[data-field="barcodes"]');
    const qrPreviewSection = modal.querySelector('[data-role="qr-preview"]');
    const qrPreviewImage = modal.querySelector('[data-role="qr-preview-image"]');
    const qrDownloadLink = modal.querySelector('[data-role="qr-download-link"]');

    const syncBarcodeState = () => {
      const disabled = skipBarcodeInput.checked;
      barcodeInput.disabled = disabled;
      if (disabled) barcodeInput.value = '';
    };

    const renderQrPreview = (value) => {
      const codeValue = String(value || '').trim();
      if (!codeValue) {
        qrPreviewSection?.classList.add('hidden');
        if (qrPreviewImage) qrPreviewImage.removeAttribute('src');
        if (qrDownloadLink) qrDownloadLink.setAttribute('href', '#');
        return;
      }
      const imageUrl = buildQrImageUrl(codeValue);
      if (qrPreviewImage) qrPreviewImage.src = imageUrl;
      if (qrDownloadLink) qrDownloadLink.href = imageUrl;
      qrPreviewSection?.classList.remove('hidden');
    };

    qrCodeInput.value = generatedQr;
    modal.querySelector('[data-field="name"]').value = entry.itemName;
    modal.querySelector('[data-field="totalQuantity"]').value = String(quantityDefault);
    modal.querySelector('[data-field="lowStockLevel"]').value = String(Math.min(quantityDefault, 1));
    modal.querySelector('[data-field="unitCost"]').value = '0';
    modal.querySelector('[data-field="performedAt"]').value = formatDateTimeLocal();
    modal.querySelector('[data-field="performedBy"]').value = defaultIssuedBy;
    modal.querySelector('[data-field="note"]').value = noteDefault;
    modal.querySelector('[data-field="description"]').value = entry.purpose || 'Added from station request item not found in inventory list.';
    syncBarcodeState();
    renderQrPreview(generatedQr);

    modal.querySelector('[data-action="cancel-add-missing"]')?.addEventListener('click', closeModal);
    modal.querySelector('[data-action="generate-qr"]')?.addEventListener('click', () => {
      qrCodeInput.value = buildGeneratedQrCode();
      renderQrPreview(qrCodeInput.value);
    });
    skipBarcodeInput?.addEventListener('change', syncBarcodeState);
    qrCodeInput?.addEventListener('input', () => renderQrPreview(qrCodeInput.value));

    addMissingForm?.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!addMissingForm.reportValidity()) return;
      try {
        const payload = formToPayload(addMissingForm);
        payload.supplyGroup = currentSupplyGroup || 'station';
        payload.skipBarcodeCapture = skipBarcodeInput.checked ? 'true' : 'false';
        const response = await fetchJson('/api/items', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const createdItem = response?.item;
        if (!createdItem?.id) {
          showToast('Item was created but could not be loaded into issue list.', true);
          return;
        }

        unresolvedEntries.splice(entryIndex, 1);
        issueEntries.push({
          requestId: entry.requestId,
          itemId: createdItem.id,
          itemName: createdItem.name || entry.itemName,
          available: Number.parseInt(createdItem.total_quantity || 0, 10),
          requestedQuantity: entry.requestedQuantity,
          issuedQuantity: entry.issuedQuantity,
          remainingQuantity: entry.remainingQuantity,
          issueQuantity: Math.max(1, Math.min(entry.remainingQuantity, Number.parseInt(createdItem.total_quantity || 0, 10) || entry.remainingQuantity)),
          isComplete: entry.remainingQuantity <= 0,
          markedUnable: false,
          isPartialRequest: entry.issuedQuantity > 0 && entry.remainingQuantity > 0,
          code: createdItem.qr_code || '',
          source: 'request',
          purpose: entry.purpose || '',
          medicalLots: Array.isArray(createdItem.medical_lots) ? createdItem.medical_lots : [],
          medicalLotId: '',
          isNonInventory: false,
        });
        closeModal();
        await loadBootstrap();
        renderIssueItems();
        renderUnresolvedItems();
        refreshSubmitState();
        showToast(`${entry.itemName} was added to inventory and prefilled in the issue list.`);
      } catch (error) {
        showToast(error.message, true);
      }
    });
    };
  
  const refreshSubmitState = () => {
    const openEntries = issueEntries.filter((item) => !item.isComplete && !item.markedUnable);
    const canSubmit = Boolean(confirmPulled.checked && openEntries.length);
    submitButton.disabled = !canSubmit;
  };

  const addItemByCode = async (code, mode = 'scan') => {
    const trimmed = String(code || '').trim();
    if (!trimmed) {
      showToast('Item code is required.', true);
      return;
    }
    const localItem = findItemByCode(trimmed);
    let matchedItem = localItem;
    if (!matchedItem) {
      const data = await fetchJson(withGroupQuery(`/api/scan?code=${encodeURIComponent(trimmed)}`));
      matchedItem = data.item;
    }
    if (!matchedItem) {
      showToast('No matching inventory item for that code.', true);
      return;
    }
    const available = Number.parseInt(matchedItem.total_quantity || 0, 10);
    if (available <= 0) {
      showToast(`${matchedItem.name} is out of stock and cannot be issued.`, true);
      return;
    }
    const existing = issueEntries.find((entry) => Number(entry.itemId) === Number(matchedItem.id));
    if (existing) {
      existing.code = trimmed;
      existing.source = existing.source || mode;
      showToast(`${matchedItem.name} is already in the issue list.`);
    } else {
      issueEntries.push({
        itemId: matchedItem.id,
        itemName: matchedItem.name,
        available,
       requestedQuantity: 1,
        issuedQuantity: 0,
        remainingQuantity: 1,
        issueQuantity: 1,
        isComplete: false,
        markedUnable: false,
        isPartialRequest: false,
        code: trimmed,
        source: mode,
        medicalLots: Array.isArray(matchedItem.medical_lots) ? matchedItem.medical_lots : [],
        medicalLotId: '',
      });
      showToast(`${matchedItem.name} added to issue list.`);
    }
    renderIssueItems();
    refreshSubmitState();
  };

  const promptToAddItem = async (allowCamera = true) => {
    try {
      let code = '';
      if (allowCamera) {
        code = await scanCodeWithCamera('Scan item QR code or barcode');
      } else {
        code = window.prompt('Enter item QR code or barcode') || '';
      }
      await addItemByCode(code, allowCamera ? 'scan' : 'manual');
    } catch (error) {
      showToast(error.message, true);
    }
  };

  renderIssueItems();
  renderUnresolvedItems();
  refreshSubmitState();
  if (!issueEntries.length) {
    showToast('No active request found. Scan an item to start issuing inventory.');
  }

  overlay.querySelector('[data-action="cancel"]')?.addEventListener('click', () => {
    cancelConfirm.classList.remove('hidden');
  });
  overlay.querySelector('[data-action="go-back"]')?.addEventListener('click', () => {
    cancelConfirm.classList.add('hidden');
  });
  overlay.querySelector('[data-action="confirm-cancel"]')?.addEventListener('click', close);
  scanItemButton?.addEventListener('click', () => {
    promptToAddItem(true);
  });
  addAnotherButton?.addEventListener('click', () => {
    promptToAddItem(true);
  });

  issueItemsEl.addEventListener('input', (event) => {
    const qtyInput = event.target.closest('[data-field="issueQty"]');
    const row = event.target.closest('.issue-entry');
    const index = Number.parseInt(row?.dataset.index || '-1', 10);
    const entry = issueEntries[index];
    if (!entry) return;
    if (qtyInput) {
      const qty = Number.parseInt(qtyInput.value || '0', 10);
      entry.issueQuantity = Number.isInteger(qty) ? qty : 0;
    }
  });

  issueItemsEl.addEventListener('change', (event) => {
    const unableToggle = event.target.closest('[data-field="unableToIssue"]');
    const lotSelect = event.target.closest('[data-field="medicalLotId"]');
    if (lotSelect) {
      const row = event.target.closest('.issue-entry');
      const index = Number.parseInt(row?.dataset.index || '-1', 10);
      const entry = issueEntries[index];
      if (!entry) return;
      entry.medicalLotId = lotSelect.value;
      return;
    }
    if (!unableToggle) return;
    const row = unableToggle.closest('.issue-entry');
    const index = Number.parseInt(row?.dataset.index || '-1', 10);
    const entry = issueEntries[index];
    if (!entry || entry.isComplete) return;
    entry.markedUnable = Boolean(unableToggle.checked);
    renderIssueItems();
    refreshSubmitState();
  });

  unresolvedItemsEl.addEventListener('click', (event) => {
    const addButton = event.target.closest('[data-action="add-missing-item"]');
    if (!addButton) return;
    const entryIndex = Number.parseInt(addButton.dataset.index || '-1', 10);
    if (entryIndex < 0) return;
    openAddMissingItemModal(entryIndex);
  });

  confirmPulled?.addEventListener('change', () => {
    refreshSubmitState();
  });

  submitButton?.addEventListener('click', async () => {
    const issuedBy = identityInput.value.trim();
    if (!issuedBy) {
      showToast('Enter a name or employee number.', true);
      return;
    }

     if (!issueEntries.length) {
      showToast('Add at least one item before submitting.', true);
      return;
    }

    const pendingEntries = issueEntries.filter((item) => !item.isComplete && !item.markedUnable);
    const overLimit = pendingEntries.find((item) => item.issueQuantity <= 0 || item.issueQuantity > item.available || item.issueQuantity > item.remainingQuantity);
    if (overLimit) {
      showToast(`Issue quantity for ${overLimit.itemName} must be between 1 and ${Math.min(overLimit.available, overLimit.remainingQuantity)}.`, true);
      return;
    }
    if (currentSupplyGroup === 'medical') {
      const missingLot = pendingEntries.find((item) => !item.medicalLotId);
      if (missingLot) {
        showToast(`Select a medical lot for ${missingLot.itemName}.`, true);
        return;
      }
    }

 const summaryLines = pendingEntries.map((item) => `${item.itemName}: issue ${item.issueQuantity}, new inventory level ${item.available - item.issueQuantity}`);
    issueSummary.classList.remove('hidden');
    issueSummary.innerHTML = `<strong>Issue summary</strong><ul>${summaryLines.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>`;
    const summary = summaryLines.join('\n');
    const shouldSubmit = window.confirm(`Issue summary for ${station.name}:\n\n${summary}\n\nSubmit and save these changes?`);
    if (!shouldSubmit) return;

    try {
     for (const item of pendingEntries) {
        if (!item.itemId) continue;
        await fetchJson('/api/inventory/adjust', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            mode: 'issue',
            source: 'manual',
            stationId: station.id,
            supplyGroup: currentSupplyGroup || 'station',
            itemId: item.itemId,
            quantity: item.issueQuantity,
            medicalLotId: item.medicalLotId || '',
            apparatusName: apparatusNameInput?.value.trim() || '',
            performedBy: issuedBy,
            note: `Issued from station request queue for ${station.name}.`,
          }),
        });
      }
      const requestItemPayload = pendingEntries
        .filter((item) => item.requestId)
        .map((item) => ({
          requestId: item.requestId,
          itemId: item.itemId,
          itemName: item.itemName,
          quantity: item.issueQuantity,
        }));
      if (requestItemPayload.length) {
        await fetchJson('/api/requests/issue-items', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            issuedBy,
            items: requestItemPayload,
          }),
        });
      }
      window.localStorage.setItem(lastIssuerKey, issuedBy);
      close();
      await loadBootstrap();
      renderIssuePage();
      showTimedPopup('Station items have been submitted and saved.', 5000);
    } catch (error) {
      showToast(error.message, true);
    }
  });
}

async function wireIssueForm() {
  const stationList = document.querySelector('#issue-station-list');
  if (!stationList) return;

  stationList.addEventListener('click', (event) => {
    const toggleButton = event.target.closest('[data-action="toggle-station-issue"]');
    if (toggleButton) {
      const wrapper = toggleButton.closest('.issue-station-listing');
      const panel = wrapper?.querySelector('.issue-station-listing__panel');
      if (!panel) return;
      const isHidden = panel.classList.contains('hidden');
      panel.classList.toggle('hidden', !isHidden);
      toggleButton.setAttribute('aria-expanded', isHidden ? 'true' : 'false');
      return;
    }

    const issueButton = event.target.closest('[data-action="open-issue-items"]');
    if (issueButton?.dataset.stationId) {
      openIssueItemsModal(issueButton.dataset.stationId);
    }
  });
}

function formatDateTimeLocal(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function restockStorageKey(itemId) {
  return `restock:lastCost:${itemId}`;
}

async function wireRestockForm() {
  const restockForm = document.querySelector('#restock-form');
   if (!restockForm) return;

  const codeInput = restockForm.querySelector('#restock-code');
  const itemIdInput = restockForm.querySelector('#restock-item-id');
  const summary = restockForm.querySelector('#restock-item-summary');
  const currentStockEl = restockForm.querySelector('#restock-current-stock');
  const resultEl = document.querySelector('#restock-result');
  const performedByInput = restockForm.querySelector('#restock-performed-by');
  const dateTimeInput = restockForm.querySelector('#restock-datetime');
  const unitCostInput = restockForm.querySelector('#restock-unit-cost');
  const followup = restockForm.querySelector('#barcode-followup');
  const skipBarcode = restockForm.querySelector('#skip-barcode-capture');
  const newBarcodeInput = restockForm.querySelector('#restock-new-barcode');
  const newBarcodeButton = restockForm.querySelector('#restock-add-barcode');
  const barcodeScanButton = restockForm.querySelector('#restock-scan-barcode');
  const qrScanButton = restockForm.querySelector('#restock-scan-qr');
  const medicalFields = restockForm.querySelector('#medical-restock-fields');
  const lotNumberInput = restockForm.querySelector('input[name="lotNumber"]');
  const lotBarcodeInput = restockForm.querySelector('input[name="lotBarcode"]');
  const expirationDateInput = restockForm.querySelector('input[name="expirationDate"]');

  let activeItem = null;
  let scannedVia = '';

  const updateItemSummary = (item, sourceCode = '') => {
    if (!item) {
      activeItem = null;
      itemIdInput.value = '';
      currentStockEl.textContent = '—';
      summary.innerHTML = '<h3>Selected item</h3><p class="helper">Scan a code to load item details.</p>';
      followup.classList.add('hidden');
      return;
    }

    activeItem = item;
    itemIdInput.value = String(item.id);
    currentStockEl.textContent = `${item.total_quantity}`;
    summary.innerHTML = `
      <h3>Selected item</h3>
      <div><strong>${item.name}</strong> (${item.sku})</div>
      <div class="helper">Matched by: ${sourceCode || 'code lookup'} · ${formatSupplyGroupLabel(item.supply_group)}</div>
      ${item.supply_group === 'medical' && Array.isArray(item.medical_lots) && item.medical_lots.length
        ? `<div class="stack compact">${item.medical_lots.map((lot) => {
          const status = expirationStatus(lot.expiration_date);
          return `<div><span class="${status.className}">${escapeHtml(status.label)}</span> <span class="helper">Lot ${escapeHtml(lot.lot_number)} · ${lot.quantity_on_hand} on hand</span></div>`;
        }).join('')}</div>`
        : ''}
    `;
    medicalFields?.classList.toggle('hidden', item.supply_group !== 'medical');

    const rememberedCost = window.localStorage.getItem(restockStorageKey(item.id));
    unitCostInput.value = rememberedCost ?? String(Number(item.unit_cost || 0) || '');

    const matchedQr = String(sourceCode || '').trim().toLowerCase() === String(item.qr_code || '').trim().toLowerCase();
    if (matchedQr || scannedVia === 'qr') {
      followup.classList.remove('hidden');
    } else {
      followup.classList.add('hidden');
    }
  };

  const lookupByCode = async (code) => {
    const trimmed = (code || '').trim();
    if (!trimmed) {
      updateItemSummary(null);
      return;
    }

    const localItem = findItemByCode(trimmed);
    if (localItem) {
      updateItemSummary(localItem, trimmed);
      return;
    }

    try {
      const data = await fetchJson(withGroupQuery(`/api/scan?code=${encodeURIComponent(trimmed)}`));
      updateItemSummary(data.item, trimmed);
    } catch {
      updateItemSummary(null);
      showToast('No matching inventory item for that code.', true);
    }
  };

  const runScan = async (mode) => {
    try {
      const code = await scanCodeWithCamera(mode === 'qr' ? 'Scan item QR code' : 'Scan item barcode');
      scannedVia = mode;
      codeInput.value = code;
      await lookupByCode(code);
      showToast('Item code captured and matched.');
    } catch (error) {
      showToast(error.message, true);
    }
  };

  barcodeScanButton?.addEventListener('click', () => runScan('barcode'));
  qrScanButton?.addEventListener('click', () => runScan('qr'));

  codeInput.addEventListener('change', () => {
    scannedVia = '';
    lookupByCode(codeInput.value).catch((error) => showToast(error.message, true));
  });

  skipBarcode.addEventListener('change', () => {
    const disabled = skipBarcode.checked;
    newBarcodeInput.disabled = disabled;
    newBarcodeButton.disabled = disabled;
    if (disabled) newBarcodeInput.value = '';
  });
  skipBarcode.dispatchEvent(new Event('change'));

  newBarcodeButton?.addEventListener('click', async () => {
    if (skipBarcode.checked) return;
    try {
      const newCode = await scanCodeWithCamera('Scan new barcode for this item');
      newBarcodeInput.value = newCode;
      showToast('New barcode captured.');
    } catch (error) {
      showToast(error.message, true);
    }
  });

  dateTimeInput.value = formatDateTimeLocal();
  performedByInput.value = window.localStorage.getItem('restock:lastPerformer') || '';

  restockForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const payload = formToPayload(restockForm);
    payload.mode = 'restock';
    payload.supplyGroup = currentSupplyGroup || activeItem?.supply_group || 'station';
    payload.skipBarcodeCapture = skipBarcode.checked ? 'true' : 'false';
    payload.source = payload.code ? 'scan' : 'manual';
    if (!payload.itemId) delete payload.itemId;
    if (!payload.code) delete payload.code;
    try {
      const response = await fetchJson('/api/inventory/adjust', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      
      if (activeItem && payload.unitCost !== '') {
        window.localStorage.setItem(restockStorageKey(activeItem.id), payload.unitCost);
      }
      window.localStorage.setItem('restock:lastPerformer', payload.performedBy || '');

      const previous = response.previousTotalQuantity;
      const current = response.newTotalQuantity;
      resultEl.textContent = Number.isFinite(previous) && Number.isFinite(current)
        ? `Restock complete: ${activeItem?.name || 'Item'} moved from ${previous} to ${current} in stock.`
        : 'Restock complete.';
      
      await loadBootstrap();
      renderRestockPage();
      dateTimeInput.value = formatDateTimeLocal();
      showToast('Inventory restocked.');
      updateItemSummary(response.item || null, codeInput.value);
      currentStockEl.textContent = `${response.newTotalQuantity}`;
    } catch (error) {
      showToast(error.message, true);
    }
  });
}

function renderAnalytics(data) {
  state.analytics = {
    byItem: data.byItem || [],
    byStation: data.byStation || [],
    trend: data.trend || [],
    transactions: data.transactions || [],
  };

  const byItem = document.querySelector('#by-item');
  byItem.innerHTML = state.analytics.byItem.length
    ? state.analytics.byItem.map((row) => `<tr><td>${row.name} (${row.sku})</td><td>${row.used_qty || 0}</td><td>${currency(row.used_cost)}</td></tr>`).join('')
    : '<tr><td colspan="3">No usage in selected period.</td></tr>';

  const byStation = document.querySelector('#by-station');
  byStation.innerHTML = state.analytics.byStation.length
    ? state.analytics.byStation.map((row) => `<tr><td>${row.station_name}</td><td>${row.used_qty || 0}</td><td>${currency(row.used_cost)}</td></tr>`).join('')
    : '<tr><td colspan="3">No station usage in selected period.</td></tr>';

  const trend = document.querySelector('#trend-bars');
 const legend = document.querySelector('#analytics-chart-legend');
  const chartType = document.querySelector('#analytics-chart-type')?.value || 'bar';
  const metric = document.querySelector('#analytics-metric')?.value || 'used_qty';
  const interval = document.querySelector('#analytics-interval')?.value || 'day';
  const yLabel = metric === 'used_cost' ? 'Cost used' : 'Units used';
  const formatMetric = (value) => (metric === 'used_cost' ? currency(value) : `${Number(value || 0)}`);

  const transactions = state.analytics.transactions || [];
  const grouped = new Map();
  transactions.forEach((row) => {
    const date = new Date(row.created_at);
    if (Number.isNaN(date.getTime())) return;
    const key = interval === 'month'
      ? `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
      : interval === 'week'
        ? `${date.getUTCFullYear()}-W${String(Math.ceil((((date - new Date(Date.UTC(date.getUTCFullYear(), 0, 1))) / 86400000) + 1) / 7)).padStart(2, '0')}`
        : date.toISOString().slice(0, 10);
    const value = metric === 'used_cost' ? Number(row.used_cost || 0) : Number(row.used_qty || 0);
    grouped.set(key, (grouped.get(key) || 0) + value);
  });

  const series = [...grouped.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const maxValue = Math.max(1, ...series.map((entry) => Number(entry.value || 0)));
  const totalValue = series.reduce((sum, entry) => sum + Number(entry.value || 0), 0);

  const renderBar = () => series.map((entry) => {
    const width = Math.max(2, Math.round((Number(entry.value || 0) / maxValue) * 100));
    return `<div class="trend-row"><span>${entry.label}</span><div class="trend-bar"><i style="width:${width}%"></i></div><strong>${formatMetric(entry.value)}</strong></div>`;
  }).join('');

  const renderLineLike = (isArea = false) => {
    if (!series.length) return '<p class="helper">No trend data in selected period.</p>';
    const width = 960;
    const height = 220;
    const pad = 36;
    const step = series.length > 1 ? (width - (pad * 2)) / (series.length - 1) : 0;
    const points = series.map((entry, idx) => {
      const x = pad + (idx * step);
      const y = height - pad - ((Number(entry.value || 0) / maxValue) * (height - (pad * 2)));
      return { x, y, value: entry.value, label: entry.label };
    });
    const polyline = points.map((p) => `${p.x},${p.y}`).join(' ');
    const area = `${pad},${height - pad} ${polyline} ${pad + (step * (series.length - 1))},${height - pad}`;
    return `
      <svg viewBox="0 0 ${width} ${height}" class="trend-svg" role="img" aria-label="${yLabel} trend">
        ${isArea ? `<polygon points="${area}" fill="rgba(11, 95, 255, 0.22)" />` : ''}
        <polyline points="${polyline}" fill="none" stroke="#0b5fff" stroke-width="3" />
        ${points.map((p) => `<circle cx="${p.x}" cy="${p.y}" r="4" fill="#0b5fff"><title>${p.label}: ${formatMetric(p.value)}</title></circle>`).join('')}
      </svg>
    `;
  };

  const renderPie = () => {
    if (!series.length || totalValue <= 0) return '<p class="helper">No trend data in selected period.</p>';
    let offset = 0;
    const radius = 56;
    const circumference = 2 * Math.PI * radius;
    const colors = ['#0b5fff', '#2f7dff', '#649dff', '#90b8ff', '#b2ceff', '#d6e5ff'];
    const slices = series.map((entry, idx) => {
      const ratio = Number(entry.value || 0) / totalValue;
      const dash = `${Math.max(0.0001, ratio * circumference)} ${circumference}`;
      const node = `<circle r="${radius}" cx="80" cy="80" fill="transparent" stroke="${colors[idx % colors.length]}" stroke-width="26" stroke-dasharray="${dash}" stroke-dashoffset="${-offset}" transform="rotate(-90 80 80)"><title>${entry.label}: ${formatMetric(entry.value)}</title></circle>`;
      offset += ratio * circumference;
      return node;
    }).join('');
    return `<div class="chart-pie-wrap"><svg viewBox="0 0 160 160" class="trend-pie">${slices}</svg>${renderBar()}</div>`;
  };

  const renderScatter = () => {
    if (!series.length) return '<p class="helper">No trend data in selected period.</p>';
    const width = 960;
    const height = 220;
    const pad = 36;
    const step = series.length > 1 ? (width - (pad * 2)) / (series.length - 1) : 0;
    return `
      <svg viewBox="0 0 ${width} ${height}" class="trend-svg" role="img" aria-label="${yLabel} scatter plot">
        <line x1="${pad}" y1="${height - pad}" x2="${width - pad}" y2="${height - pad}" stroke="#d7e0ea" />
        <line x1="${pad}" y1="${pad}" x2="${pad}" y2="${height - pad}" stroke="#d7e0ea" />
        ${series.map((entry, idx) => {
          const x = pad + (idx * step);
          const y = height - pad - ((Number(entry.value || 0) / maxValue) * (height - (pad * 2)));
          return `<circle cx="${x}" cy="${y}" r="5" fill="#0b5fff"><title>${entry.label}: ${formatMetric(entry.value)}</title></circle>`;
        }).join('')}
      </svg>
    `;
  };

  const renderHistogram = () => {
    if (!series.length) return '<p class="helper">No trend data in selected period.</p>';
    const bins = [0, 0, 0, 0, 0];
    series.forEach((entry) => {
      const normalized = maxValue ? Number(entry.value || 0) / maxValue : 0;
      const bin = Math.min(4, Math.floor(normalized * 5));
      bins[bin] += 1;
    });
    const maxBin = Math.max(1, ...bins);
    return bins.map((count, idx) => {
      const width = Math.max(2, Math.round((count / maxBin) * 100));
      return `<div class="trend-row"><span>Bin ${idx + 1}</span><div class="trend-bar"><i style="width:${width}%"></i></div><strong>${count}</strong></div>`;
    }).join('');
  };

  const chartByType = {
    bar: renderBar,
    line: () => renderLineLike(false),
    area: () => renderLineLike(true),
    pie: renderPie,
    scatter: renderScatter,
    histogram: renderHistogram,
  };

  trend.innerHTML = series.length
    ? (chartByType[chartType] || renderBar)()
    : '<p class="helper">No trend data in selected period.</p>';
  if (legend) {
    legend.textContent = `Chart: ${chartType.toUpperCase()} · Metric: ${metric === 'used_cost' ? 'Cost used' : 'Units used'} · Grouped by ${interval}.`;
  }

   const txTable = document.querySelector('#usage-transactions');
  if (txTable) {
    txTable.innerHTML = state.analytics.transactions.length
      ? state.analytics.transactions.map((row) => `
        <tr>
          <td>${new Date(row.created_at).toLocaleString()}</td>
          <td>${row.station_name || 'Unassigned'}</td>
          <td>${row.item_name}</td>
          <td>${row.item_sku}</td>
          <td>${row.used_qty || 0}</td>
          <td>${currency(row.unit_cost)}</td>
          <td>${currency(row.used_cost)}</td>
          <td>${escapeHtml(row.performed_by || '')}</td>
          <td>${escapeHtml(row.source || '')}</td>
        </tr>
      `).join('')
      : '<tr><td colspan="9">No usage transactions in selected period.</td></tr>';
  }
}

function buildDelimited(rows, delimiter = ',') {
  const escapeValue = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
  return rows.map((row) => row.map((value) => (delimiter === '\t' ? String(value ?? '') : escapeValue(value))).join(delimiter)).join('\n');
}

function downloadBlob(filename, blob) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(link.href), 1500);
}

function exportAnalytics(format) {
  const headers = ['Date', 'Station', 'Item', 'SKU', 'Qty Used', 'Unit Cost', 'Cost Used', 'Performed By', 'Source'];
  const rows = state.analytics.transactions.map((row) => [
    new Date(row.created_at).toLocaleString(),
    row.station_name || 'Unassigned',
    row.item_name,
    row.item_sku,
    row.used_qty || 0,
    Number(row.unit_cost || 0).toFixed(2),
    Number(row.used_cost || 0).toFixed(2),
    row.performed_by || '',
    row.source || '',
  ]);
  const stamp = new Date().toISOString().slice(0, 19).replaceAll(':', '-');

  if (!rows.length) {
    showToast('No data to export for current filters.', true);
    return;
  }

  if (format === 'csv') {
    downloadBlob(`usage-report-${stamp}.csv`, new Blob([buildDelimited([headers, ...rows], ',')], { type: 'text/csv;charset=utf-8' }));
    return;
  }
  if (format === 'tsv') {
    downloadBlob(`usage-report-${stamp}.tsv`, new Blob([buildDelimited([headers, ...rows], '\t')], { type: 'text/tab-separated-values;charset=utf-8' }));
    return;
  }
  if (format === 'json') {
    downloadBlob(`usage-report-${stamp}.json`, new Blob([JSON.stringify(state.analytics.transactions, null, 2)], { type: 'application/json;charset=utf-8' }));
    return;
  }
  if (format === 'xlsx') {
    const tableRows = [headers, ...rows].map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('');
    const content = `<!doctype html><html><head><meta charset="utf-8" /></head><body><table>${tableRows}</table></body></html>`;
    downloadBlob(`usage-report-${stamp}.xlsx`, new Blob([content], { type: 'application/vnd.ms-excel' }));
    return;
  }
  if (format === 'pdf') {
    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      showToast('Popup blocked. Allow popups to export PDF.', true);
      return;
    }
    const tableRows = [headers, ...rows].map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('');
    printWindow.document.write(`
      <!doctype html>
      <html>
      <head>
        <title>Usage Report</title>
        <style>
          body { font-family: Arial, sans-serif; padding: 16px; }
          table { border-collapse: collapse; width: 100%; font-size: 12px; }
          th, td { border: 1px solid #d7e0ea; padding: 6px; text-align: left; }
          h1 { margin-top: 0; }
        </style>
      </head>
      <body>
        <h1>Usage Report</h1>
        <table>
          <thead><tr>${headers.map((header) => `<th>${header}</th>`).join('')}</tr></thead>
          <tbody>${tableRows}</tbody>
        </table>
      </body>
      </html>
    `);
    printWindow.document.close();
    printWindow.focus();
    printWindow.print();
  }
}

async function wireSearchPage() {
  const select = document.querySelector('#days-select');
  const searchInput = document.querySelector('#analytics-search');
  const stationSelect = document.querySelector('#analytics-station');
  const itemSelect = document.querySelector('#analytics-item');
  const startDateInput = document.querySelector('#analytics-start-date');
  const endDateInput = document.querySelector('#analytics-end-date');
  const summary = document.querySelector('#analytics-summary');
  const applyButton = document.querySelector('#analytics-apply');
  const resetButton = document.querySelector('#analytics-reset');
  const exportButton = document.querySelector('#analytics-export');
  const exportFormat = document.querySelector('#analytics-export-format');
  const chartTypeSelect = document.querySelector('#analytics-chart-type');
  const metricSelect = document.querySelector('#analytics-metric');
  const intervalSelect = document.querySelector('#analytics-interval');

  stationSelect.innerHTML = ['<option value="">All stations</option>', ...state.stations.map((station) => `<option value="${station.id}">${station.name}</option>`)].join('');
  itemSelect.innerHTML = ['<option value="">All items</option>', ...getScopedItems().map((item) => `<option value="${item.id}">${escapeHtml(item.name)} (${escapeHtml(item.sku)})</option>`)].join('');
  
  const today = new Date();
  const ytdStart = `${today.getUTCFullYear()}-01-01`;
  const todayIso = today.toISOString().slice(0, 10);
  startDateInput.value = ytdStart;
  endDateInput.value = todayIso;
  select.value = 'ytd';
  
  const load = async () => {
    const quickRange = select.value;
    const params = new URLSearchParams();
    if (quickRange !== 'ytd') {
      params.set('days', quickRange);
    }
    if (searchInput.value.trim()) params.set('search', searchInput.value.trim());
    if (stationSelect.value) params.set('stationId', stationSelect.value);
    if (itemSelect.value) params.set('itemId', itemSelect.value);
    if (quickRange === 'ytd' || startDateInput.value) params.set('startDate', startDateInput.value || ytdStart);
    if (quickRange === 'ytd' || endDateInput.value) params.set('endDate', endDateInput.value || todayIso);
    if (currentSupplyGroup) params.set('group', currentSupplyGroup);
    const data = await fetchJson(`/api/analytics?${params.toString()}`);
    renderAnalytics(data);
     if (summary) {
      const selectedItem = itemSelect.selectedOptions?.[0]?.textContent || 'All items';
      summary.textContent = `Showing ${data.transactions?.length || 0} usage transactions. Item scope: ${selectedItem}. Date range: ${params.get('startDate') || 'rolling'} to ${params.get('endDate') || 'today'}.`;
    }
  };
  
  select.addEventListener('change', () => {
    if (select.value === 'ytd') {
      startDateInput.value = ytdStart;
      endDateInput.value = todayIso;
    } else {
      startDateInput.value = '';
      endDateInput.value = '';
    }
    load().catch((error) => showToast(error.message, true));
  });
  applyButton?.addEventListener('click', () => load().catch((error) => showToast(error.message, true)));
  resetButton?.addEventListener('click', () => {
    searchInput.value = '';
    stationSelect.value = '';
    itemSelect.value = '';
    startDateInput.value = '';
    endDateInput.value = '';
    startDateInput.value = ytdStart;
    endDateInput.value = todayIso;
    select.value = 'ytd';
    load().catch((error) => showToast(error.message, true));
  });
  exportButton?.addEventListener('click', () => exportAnalytics(exportFormat.value));
  [chartTypeSelect, metricSelect, intervalSelect].forEach((control) => control?.addEventListener('change', () => {
    renderAnalytics(state.analytics);
  }));

  await load();
}

function findItemByCode(code) {
  const normalized = code.trim().toLowerCase();
  const sourceItems = currentSupplyGroup && page !== 'request' ? getScopedItems() : state.items;
  return sourceItems.find((item) => {
    const barcodes = Array.isArray(item.barcodes) ? item.barcodes : [item.barcode];
    const medicalLotBarcodes = Array.isArray(item.medical_lots) ? item.medical_lots.map((lot) => lot.lot_barcode) : [];
    return [item.sku, item.qr_code, ...barcodes, ...medicalLotBarcodes].some((value) => String(value || '').trim().toLowerCase() === normalized);
  });
}

function renderRecentStationRequests(stationCode) {
  const target = document.querySelector('#recent-requests');
  if (!target) return;
  if (!stationCode) {
    target.innerHTML = '<p class="helper">Select a station to view recent requests.</p>';
    return;
  }
  const station = state.stations.find((entry) => entry.code === stationCode);
  if (!station) {
    target.innerHTML = '<p class="helper">Select a valid station to view recent requests.</p>';
    return;
  }
  const cutoff = Date.now() - (30 * 24 * 60 * 60 * 1000);
  const requests = state.stationRequests
    .filter((request) => Number(request.station_id) === Number(station.id))
    .filter((request) => new Date(request.created_at).getTime() >= cutoff)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  if (!requests.length) {
    target.innerHTML = '<p class="helper">No requests for this station in the past 30 days.</p>';
    return;
  }
  
target.innerHTML = requests.map((request) => {
    const completed = Boolean(request.completed_at);
    const canceled = Boolean(request.canceled_at);
    const modified = Boolean(request.modified_at);
    const items = Array.isArray(request.requested_items) ? request.requested_items : [];
    const nonInventoryItems = Array.isArray(request.non_inventory_items) ? request.non_inventory_items : [];
    const hasPartiallyIssuedItems = !completed && !canceled
      && items.some((item) => {
        const quantity = Number.parseInt(item.quantity || 0, 10);
        const issuedQuantity = Number.parseInt(item.issuedQuantity || 0, 10);
        return quantity > 0 && issuedQuantity > 0 && issuedQuantity < quantity;
      });
   const hasPartiallyIssuedNonInventoryItems = !completed && !canceled
      && nonInventoryItems.some((item) => {
        const quantity = Number.parseInt(item.quantity || 0, 10);
        const issuedQuantity = Number.parseInt(item.issuedQuantity || 0, 10);
        return quantity > 0 && issuedQuantity > 0 && issuedQuantity < quantity;
      });
   const hasIssuedItems = items.some((item) => {
      const issuedQuantity = Number.parseInt(item.issuedQuantity || 0, 10);
      return issuedQuantity > 0;
    });
   const hasIssuedNonInventoryItems = nonInventoryItems.some((item) => {
      const issuedQuantity = Number.parseInt(item.issuedQuantity || 0, 10);
      return issuedQuantity > 0;
    });
    const allItemsIssued = items.length > 0 && items.every((item) => {
      const quantity = Number.parseInt(item.quantity || 0, 10);
      const issuedQuantity = Number.parseInt(item.issuedQuantity || 0, 10);
      return issuedQuantity >= quantity;
    });
    const allNonInventoryItemsIssued = nonInventoryItems.length > 0 && nonInventoryItems.every((item) => {
      const quantity = Number.parseInt(item.quantity || 0, 10);
      const issuedQuantity = Number.parseInt(item.issuedQuantity || 0, 10);
      return issuedQuantity >= quantity;
    });
    const hasPartialProgress = !completed && !canceled
      && (hasPartiallyIssuedItems || hasPartiallyIssuedNonInventoryItems || (hasIssuedItems && !allItemsIssued) || (hasIssuedNonInventoryItems && !allNonInventoryItemsIssued));
  
    const issuedItems = items
      .map((item) => {
        const quantity = Number.parseInt(item.quantity || 0, 10);
        const issuedQuantity = Number.parseInt(item.issuedQuantity || 0, 10);
        const safeIssuedQuantity = Number.isInteger(issuedQuantity) ? Math.max(0, issuedQuantity) : 0;
        const safeQuantity = Number.isInteger(quantity) ? Math.max(0, quantity) : 0;
        return {
          name: item.name,
          quantity: safeQuantity,
          issuedQuantity: safeIssuedQuantity,
          remaining: Math.max(0, safeQuantity - safeIssuedQuantity),
        };
      })
      .filter((item) => item.issuedQuantity > 0);

    const pendingItems = items
      .map((item) => {
        const quantity = Number.parseInt(item.quantity || 0, 10);
        const issuedQuantity = Number.parseInt(item.issuedQuantity || 0, 10);
        const safeIssuedQuantity = Number.isInteger(issuedQuantity) ? Math.max(0, issuedQuantity) : 0;
        const safeQuantity = Number.isInteger(quantity) ? Math.max(0, quantity) : 0;
        return {
          name: item.name,
          quantity: safeQuantity,
          issuedQuantity: safeIssuedQuantity,
          remaining: Math.max(0, safeQuantity - safeIssuedQuantity),
        };
      })
      .filter((item) => item.remaining > 0);
  
    const statusClass = canceled
      ? 'request-history-card--canceled'
      : (completed
        ? 'request-history-card--complete'
        : (hasPartialProgress ? 'request-history-card--partial' : 'request-history-card--pending'));
    return `
      <article class="request-history-card ${statusClass}">
        <div class="request-history-card__header">
           <strong>${canceled ? 'Canceled request' : (completed ? 'Completed request' : (hasPartialProgress ? 'Partially completed request' : 'Pending request'))}</strong>
          ${modified ? '<span class="request-modified-badge">Modified</span>' : ''}
        </div>
       ${hasPartialProgress
          ? `
            <p class="helper"><strong>Status:</strong> Partially completed</p>
            <div class="request-progress-grid">
              <div>
                <p class="helper"><strong>Issued items</strong></p>
                ${issuedItems.length
                  ? `<ul>${issuedItems.map((item) => `<li>${escapeHtml(item.name)}: <strong>${escapeHtml(item.issuedQuantity)}</strong> issued${item.remaining > 0 ? ` <span class="helper">(${item.remaining} pending)</span>` : ''}</li>`).join('')}</ul>`
                  : '<p class="helper">No items have been issued yet.</p>'}
              </div>
              <div>
                <p class="helper"><strong>Pending fulfillment</strong></p>
                ${pendingItems.length
                  ? `<ul>${pendingItems.map((item) => `<li>${escapeHtml(item.name)}: <strong>${escapeHtml(item.remaining)}</strong> pending <span class="helper">(${item.issuedQuantity} issued)</span></li>`).join('')}</ul>`
                  : '<p class="helper">All requested items have been fulfilled.</p>'}
              </div>
            </div>
          `
          : `
            <ul>
              ${items.map((item) => `<li>${escapeHtml(item.name)}: <strong>${escapeHtml(item.quantity)}</strong></li>`).join('')}
            </ul>
             ${nonInventoryItems.length
              ? `<p class="helper"><strong>Items not on inventory list</strong></p><ul>${nonInventoryItems.map((item) => `<li>${escapeHtml(item.name)}: <strong>${escapeHtml(item.quantity)}</strong> <span class="helper">(for ${escapeHtml(item.purpose)})</span></li>`).join('')}</ul>`
              : ''}
          `}
        <p class="helper">Requested: ${new Date(request.created_at).toLocaleString()} · by ${escapeHtml(request.requester_name)}</p>
        ${completed
          ? `<p class="helper">Completed: ${new Date(request.completed_at).toLocaleString()} · by ${escapeHtml(request.completed_by || 'Unknown')}</p>`
          : '<p class="helper">Completion: still pending</p>'}
          ${canceled
          ? `<p class="helper"><strong>Canceled:</strong> ${new Date(request.canceled_at).toLocaleString()} · by ${escapeHtml(request.canceled_by || 'Unknown')} · Reason: ${escapeHtml(request.cancel_reason || 'Not provided')}</p>`
          : ''}
        ${modified
          ? `<p class="helper request-history-card__modification"><strong>Modification:</strong> ${new Date(request.modified_at).toLocaleString()} · by ${escapeHtml(request.modified_by || 'Unknown')} · Reason: ${escapeHtml(request.modification_reason || 'Not provided')}</p>`
          : ''}
        ${(!completed && !canceled)
          ? `<div class="inline-actions"><button type="button" class="secondary" data-action="modify-request" data-request-id="${request.id}" data-station-code="${escapeHtml(stationCode)}">Modify request</button><button type="button" class="danger" data-action="cancel-request" data-request-id="${request.id}" data-station-code="${escapeHtml(stationCode)}">Cancel request</button></div>`
          : ''}
      </article>
    `;
  }).join('');
  target.querySelectorAll('[data-action="cancel-request"]').forEach((button) => {
    button.addEventListener('click', () => {
      openCancelRequestModal(button.dataset.requestId, button.dataset.stationCode);
    });
  });

  target.querySelectorAll('[data-action="modify-request"]').forEach((button) => {
    button.addEventListener('click', () => {
      openModifyRequestModal(button.dataset.requestId, button.dataset.stationCode);
    });
  });
}

function openCancelRequestModal(requestId, stationCode) {
  const request = state.stationRequests.find((entry) => String(entry.id) === String(requestId));
  if (!request) {
    showToast('Request not found.', true);
    return;
  }

  const overlay = document.createElement('div');
  overlay.className = 'scanner-modal';
  overlay.innerHTML = `
    <div class="scanner-modal__card">
      <h3>Cancel request</h3>
      <p class="helper">Request #${escapeHtml(request.id)} · ${escapeHtml(stationCode)}</p>
      <label>Canceled by
        <input type="text" name="canceledBy" placeholder="Name" required />
      </label>
      <label>Cancellation reason
        <input type="text" name="cancelReason" placeholder="Reason for canceling request" required />
      </label>
      <div class="scanner-modal__actions">
        <button type="button" class="ghost" data-action="cancel">Keep request</button>
        <button type="button" class="danger" data-action="submit">Cancel request</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  const canceledByInput = overlay.querySelector('input[name="canceledBy"]');
  const cancelReasonInput = overlay.querySelector('input[name="cancelReason"]');
  const submitButton = overlay.querySelector('[data-action="submit"]');

  overlay.querySelector('[data-action="cancel"]')?.addEventListener('click', close);
  submitButton?.addEventListener('click', async () => {
    const canceledBy = canceledByInput?.value.trim() || '';
    const cancelReason = cancelReasonInput?.value.trim() || '';

    if (!canceledBy) {
      showToast('Canceled by is required.', true);
      return;
    }

    if (!cancelReason) {
      showToast('Cancel reason is required.', true);
      return;
    }

    try {
      await fetchJson('/api/requests/cancel', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requestId,
          canceledBy,
          cancelReason,
        }),
      });
      close();
      await loadBootstrap();
      renderRecentStationRequests(stationCode);
      showToast('Request canceled.');
    } catch (error) {
      showToast(error.message, true);
    }
  });
}

function openModifyRequestModal(requestId, stationCode) {
  const request = state.stationRequests.find((entry) => String(entry.id) === String(requestId));
  if (!request) {
    showToast('Request not found.', true);
    return;
  }
  const addedItems = (Array.isArray(request.requested_items) ? request.requested_items : [])
    .map((item) => ({
      itemId: Number.parseInt(item?.itemId || 0, 10) || null,
      name: String(item?.name || '').trim(),
      supplyGroup: item?.supplyGroup || request.supply_group || 'station',
      quantity: Number.parseInt(item?.quantity || 0, 10),
    }))
    .filter((item) => item.name && item.quantity > 0);

  const overlay = document.createElement('div');
  overlay.className = 'scanner-modal';
  overlay.innerHTML = `
    <div class="scanner-modal__card">
      <h3>Modify request</h3>
      <label>Modified by
        <input type="text" name="modifiedBy" placeholder="Name" required />
      </label>
      <label>Modification reason
        <input type="text" name="modificationReason" placeholder="Reason for request update" required />
      </label>
      <div class="modify-summary stack compact">
        <strong>Requested items</strong>
        <div data-role="modifyRequestItems" class="stack compact"></div>
      </div>
      <div class="modify-summary stack compact">
        <strong>Add inventory item</strong>
        <label>Item
          <select name="addItemSelect"></select>
        </label>
        <label>Quantity
          <input type="number" name="addItemQty" min="1" value="1" />
        </label>
        <button type="button" data-action="add-item" class="secondary">Add item</button>
      </div>
      <div class="scanner-modal__actions">
        <button type="button" data-action="cancel" class="ghost">Cancel</button>
        <button type="button" data-action="submit">Save changes</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close();
  });

  const modifiedByInput = overlay.querySelector('input[name="modifiedBy"]');
  const modificationReasonInput = overlay.querySelector('input[name="modificationReason"]');
  const addItemSelect = overlay.querySelector('select[name="addItemSelect"]');
  const addItemQtyInput = overlay.querySelector('input[name="addItemQty"]');
  const requestItemsEl = overlay.querySelector('[data-role="modifyRequestItems"]');

  addItemSelect.innerHTML = `<option value="">Select an item</option>${state.items
    .filter((item) => String(item.supply_group || 'station') === String(request.supply_group || 'station'))
    .map((item) => `<option value="${item.id}" data-supply-group="${escapeHtml(item.supply_group || 'station')}">${escapeHtml(item.name)} (${escapeHtml(item.sku)} · ${escapeHtml(formatSupplyGroupLabel(item.supply_group))})</option>`)
    .join('')}`;

  const renderAddedItems = () => {
    if (!addedItems.length) {
      requestItemsEl.innerHTML = '<p class="helper">No items in this request.</p>';
      return;
    }
    requestItemsEl.innerHTML = `
      ${addedItems.map((item, index) => `
        <div class="inline-actions">
          <strong>${escapeHtml(item.name)}</strong>
          <input type="number" min="1" value="${escapeHtml(item.quantity)}" data-role="item-qty" data-index="${index}" />
          <button type="button" class="danger" data-action="remove-item" data-index="${index}">Remove</button>
        </div>
      `).join('')}
    `;

    requestItemsEl.querySelectorAll('[data-role="item-qty"]').forEach((input) => {
      input.addEventListener('input', () => {
        const index = Number.parseInt(input.dataset.index || '-1', 10);
        if (index < 0) return;
        const nextQuantity = Number.parseInt(input.value || '0', 10);
        addedItems[index].quantity = Number.isInteger(nextQuantity) && nextQuantity > 0 ? nextQuantity : 0;
      });
    });

    requestItemsEl.querySelectorAll('[data-action="remove-item"]').forEach((button) => {
      button.addEventListener('click', () => {
        const index = Number.parseInt(button.dataset.index || '-1', 10);
        if (index < 0) return;
        addedItems.splice(index, 1);
        renderAddedItems();
      });
    });
  };

  renderAddedItems();

  overlay.querySelector('[data-action="add-item"]').addEventListener('click', () => {
    const itemId = Number.parseInt(addItemSelect.value || '0', 10);
    const selectedItem = state.items.find((item) => Number(item.id) === itemId);
    const quantity = Number.parseInt(addItemQtyInput.value || '0', 10);
    if (!selectedItem) {
      showToast('Select an item to add.', true);
      return;
    }
    if (!quantity || quantity <= 0) {
      showToast('Enter a valid quantity to add.', true);
      return;
    }

    const existing = addedItems.find((item) => Number(item.itemId) === Number(selectedItem.id));
    if (existing) {
      existing.quantity += quantity;
    } else {
      addedItems.push({ itemId: selectedItem.id, name: selectedItem.name, quantity, supplyGroup: selectedItem.supply_group || request.supply_group || 'station' });
    }

    addItemQtyInput.value = '1';
    addItemSelect.value = '';
    renderAddedItems();
    showToast('Item added to request.');
  });

  overlay.querySelector('[data-action="cancel"]').addEventListener('click', close);
  overlay.querySelector('[data-action="submit"]').addEventListener('click', async () => {
    const modifiedBy = modifiedByInput.value.trim();
    const modificationReason = modificationReasonInput.value.trim();
    const parsedItems = addedItems
      .map((item) => ({
        itemId: item.itemId,
        name: String(item.name || '').trim(),
        supplyGroup: item.supplyGroup || request.supply_group || 'station',
        quantity: Number.parseInt(item.quantity || 0, 10),
      }))
      .filter((item) => item.name && item.quantity > 0);

    if (!modifiedBy) {
      showToast('Enter who is making this modification.', true);
      return;
    }
    if (!modificationReason) {
      showToast('Modification reason is required.', true);
      return;
    }
    if (!parsedItems.length) {
      showToast('Add at least one valid item before saving.', true);
      return;
    }

    try {
      await fetchJson('/api/requests/modify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requestId,
          modifiedBy,
          modificationReason,
          items: parsedItems,
        }),
      });
      close();
      await loadBootstrap();
      renderRecentStationRequests(stationCode);
      showToast('Request modified.');
    } catch (error) {
      showToast(error.message, true);
    }
  });
}

function openRequestItemModal(stationCode) {
  const station = state.stations.find((entry) => entry.code === stationCode);
  if (!station) {
    showToast('Select a station before creating a request.', true);
    return;
  }
  const addedItems = [];
  const addedNonInventoryItems = [];
  let activeItem = null;
  let scannedCode = '';
  const overlay = document.createElement('div');
  let manualSearchTerm = '';
  overlay.className = 'scanner-modal';
  overlay.innerHTML = `
    <div class="scanner-modal__card">
      <h3>Request inventory item</h3>
      <p class="helper">Station: ${escapeHtml(station.name)} (${escapeHtml(station.code)})</p>
      <label>Requested by
        <input type="text" name="requesterName" placeholder="Name" required />
      </label>
      <label class="checkbox-label">
        <input type="checkbox" name="noCode" />
        I do not have the QR code or barcode
      </label>
      <div data-role="scanBlock" class="stack compact">
        <button type="button" class="secondary" data-action="scan">Scan QR or barcode</button>
      </div>
      <div data-role="pickerBlock" class="hidden stack compact">
        <label>Search inventory item
          <input type="search" name="manualItemSearch" placeholder="Search by item name or SKU" autocomplete="off" />
        </label>
        <div data-role="manualItemList" class="manual-item-list"></div>
      </div>
      <div data-role="itemInfo" class="restock-item-summary hidden"></div>
      <label>Amount requesting
        <input type="number" min="1" value="1" name="requestQty" />
      </label>
      <div class="inline-actions">
        <button type="button" data-action="add">Add item</button>
        <button type="button" data-action="add-non-inventory" class="secondary">Item not on inventory list</button>
        <button type="button" data-action="submit" class="secondary">Submit request</button>
      </div>
      <div data-role="nonInventoryForm" class="hidden restock-followup stack compact">
        <strong>Item not on inventory list</strong>
        <label>Item name
          <input type="text" name="nonInventoryName" placeholder="Item name" />
        </label>
        <label>What is the item for?
          <input type="text" name="nonInventoryPurpose" placeholder="Purpose or use case" />
        </label>
        <label>Quantity requested
          <input type="number" min="1" value="1" name="nonInventoryQty" />
        </label>
        <div class="inline-actions">
          <button type="button" data-action="save-non-inventory">Save item not on list</button>
          <button type="button" data-action="cancel-non-inventory" class="ghost">Cancel</button>
        </div>
      </div>
      <button type="button" data-action="cancel" class="danger">Cancel</button>
      <div data-role="cancelConfirm" class="hidden restock-followup stack compact">
        <p>Canceling request.</p>
        <div class="inline-actions">
          <button type="button" data-action="goBack" class="request-success">Go back to request</button>
          <button type="button" data-action="confirmCancel" class="danger">Yes cancel the request</button>
        </div>
      </div>
      <div data-role="requestItems" class="stack compact"></div>
    </div>
  `;
  document.body.appendChild(overlay);

   const close = () => overlay.remove();
  const requesterInput = overlay.querySelector('input[name="requesterName"]');
  const noCodeInput = overlay.querySelector('input[name="noCode"]');
  const pickerBlock = overlay.querySelector('[data-role="pickerBlock"]');
  const scanBlock = overlay.querySelector('[data-role="scanBlock"]');
  const manualSearchInput = overlay.querySelector('input[name="manualItemSearch"]');
  const manualItemList = overlay.querySelector('[data-role="manualItemList"]');
  const itemInfo = overlay.querySelector('[data-role="itemInfo"]');
  const qtyInput = overlay.querySelector('input[name="requestQty"]');
  const requestItemsEl = overlay.querySelector('[data-role="requestItems"]');
  const nonInventoryForm = overlay.querySelector('[data-role="nonInventoryForm"]');
  const nonInventoryNameInput = overlay.querySelector('input[name="nonInventoryName"]');
  const nonInventoryPurposeInput = overlay.querySelector('input[name="nonInventoryPurpose"]');
  const nonInventoryQtyInput = overlay.querySelector('input[name="nonInventoryQty"]');
  const cancelConfirm = overlay.querySelector('[data-role="cancelConfirm"]');

  const renderAddedItems = () => {
    const inventoryList = addedItems.length
      ? `<div class="stack compact">${addedItems.map((entry, index) => `
          <div class="inline-actions">
            <strong>${escapeHtml(entry.name)}</strong>
            <input type="number" min="1" value="${escapeHtml(entry.quantity)}" data-role="inventory-item-qty" data-index="${index}" aria-label="Requested quantity for ${escapeHtml(entry.name)}" />
            <button type="button" class="danger" data-action="remove-inventory-item" data-index="${index}">Remove</button>
          </div>
        `).join('')}</div>`
      : '<p class="helper">No inventory items added yet.</p>';
    const nonInventoryList = addedNonInventoryItems.length
      ? `<div class="stack compact">${addedNonInventoryItems.map((entry, index) => `
          <div class="inline-actions">
            <strong>${escapeHtml(entry.name)}</strong>
            <span class="helper">(for ${escapeHtml(entry.purpose)})</span>
            <input type="number" min="1" value="${escapeHtml(entry.quantity)}" data-role="non-inventory-item-qty" data-index="${index}" aria-label="Requested quantity for ${escapeHtml(entry.name)}" />
            <button type="button" class="danger" data-action="remove-non-inventory-item" data-index="${index}">Remove</button>
          </div>
        `).join('')}</div>`
      : '<p class="helper">No out-of-list items added yet.</p>';
    requestItemsEl.innerHTML = (addedItems.length || addedNonInventoryItems.length)
      ? `<strong>Items in request</strong><p class="helper"><strong>Inventory items</strong></p>${inventoryList}<p class="helper"><strong>Items not on inventory list</strong></p>${nonInventoryList}`
      : '<p class="helper">No items added yet.</p>';
    
    requestItemsEl.querySelectorAll('[data-role="inventory-item-qty"]').forEach((input) => {
      input.addEventListener('input', () => {
        const index = Number.parseInt(input.dataset.index || '-1', 10);
        if (index < 0 || !addedItems[index]) return;
        const nextQty = Number.parseInt(input.value || '0', 10);
        addedItems[index].quantity = Number.isInteger(nextQty) && nextQty > 0 ? nextQty : 0;
      });
    });

    requestItemsEl.querySelectorAll('[data-role="non-inventory-item-qty"]').forEach((input) => {
      input.addEventListener('input', () => {
        const index = Number.parseInt(input.dataset.index || '-1', 10);
        if (index < 0 || !addedNonInventoryItems[index]) return;
        const nextQty = Number.parseInt(input.value || '0', 10);
        addedNonInventoryItems[index].quantity = Number.isInteger(nextQty) && nextQty > 0 ? nextQty : 0;
      });
    });

    requestItemsEl.querySelectorAll('[data-action="remove-inventory-item"]').forEach((button) => {
      button.addEventListener('click', () => {
        const index = Number.parseInt(button.dataset.index || '-1', 10);
        if (index < 0) return;
        addedItems.splice(index, 1);
        renderAddedItems();
      });
    });

    requestItemsEl.querySelectorAll('[data-action="remove-non-inventory-item"]').forEach((button) => {
      button.addEventListener('click', () => {
        const index = Number.parseInt(button.dataset.index || '-1', 10);
        if (index < 0) return;
        addedNonInventoryItems.splice(index, 1);
        renderAddedItems();
      });
    });
  };

  const renderManualItemList = () => {
    const query = manualSearchTerm.trim().toLowerCase();
    const filteredItems = query
      ? state.items.filter((item) => {
        const name = String(item.name || '').toLowerCase();
        const sku = String(item.sku || '').toLowerCase();
        return name.includes(query) || sku.includes(query);
      })
      : state.items;

    if (!filteredItems.length) {
      manualItemList.innerHTML = '<p class="helper">No matching inventory items.</p>';
      return;
    }

    manualItemList.innerHTML = filteredItems.map((item) => {
      const isActive = activeItem && String(activeItem.id) === String(item.id);
      return `
        <button type="button" class="manual-item-list__option ${isActive ? 'manual-item-list__option--active' : ''}" data-item-id="${item.id}">
          <strong>${escapeHtml(item.name)}</strong>
          <span class="helper">SKU: ${escapeHtml(item.sku)} · On hand: ${item.total_quantity}</span>
        </button>
      `;
    }).join('');

    manualItemList.querySelectorAll('[data-item-id]').forEach((button) => {
        button.addEventListener('click', () => {
        activeItem = state.items.find((item) => String(item.id) === String(button.dataset.itemId)) || null;
        scannedCode = '';
        updateActiveItemDisplay();
        renderManualItemList();
      });
    });
  };

  const updateActiveItemDisplay = () => {
    if (!activeItem) {
      itemInfo.classList.add('hidden');
      itemInfo.innerHTML = '';
      return;
    }
    itemInfo.classList.remove('hidden');
    itemInfo.innerHTML = `
      <strong>${escapeHtml(activeItem.name)}</strong>
      <p class="helper">SKU: ${escapeHtml(activeItem.sku)} · On hand: ${activeItem.total_quantity}</p>
      ${scannedCode ? `<p class="helper">Scanned code: ${escapeHtml(scannedCode)}</p>` : ''}
    `;
  };

  renderAddedItems();
  renderManualItemList();

  noCodeInput.addEventListener('change', () => {
    const useDropdown = noCodeInput.checked;
    pickerBlock.classList.toggle('hidden', !useDropdown);
    scanBlock.classList.toggle('hidden', useDropdown);
    activeItem = null;
    scannedCode = '';
    manualSearchTerm = '';
    manualSearchInput.value = '';
    renderManualItemList();
    updateActiveItemDisplay();
  });

  overlay.querySelector('[data-action="scan"]').addEventListener('click', async () => {
    try {
      scannedCode = await scanCodeWithCamera('Scan request item');
      const response = await fetchJson(`/api/scan?code=${encodeURIComponent(scannedCode)}`);
      activeItem = response.item || null;
      updateActiveItemDisplay();
    } catch (error) {
      showToast(error.message, true);
    }
  });

  manualSearchInput.addEventListener('input', (event) => {
    manualSearchTerm = event.target.value;
    renderManualItemList();
  });

  overlay.querySelector('[data-action="add"]').addEventListener('click', () => {
    if (!activeItem) {
      showToast('Select or scan an inventory item first.', true);
      return;
    }
    const qty = Number.parseInt(qtyInput.value || '0', 10);
    if (!qty || qty <= 0) {
      showToast('Enter a valid quantity.', true);
      return;
    }
    const existing = addedItems.find((item) => item.name === activeItem.name);
    if (existing) existing.quantity += qty;
    else addedItems.push({ itemId: activeItem.id, name: activeItem.name, quantity: qty, supplyGroup: activeItem.supply_group || 'station' });
    qtyInput.value = '1';
    activeItem = null;
    scannedCode = '';
    renderManualItemList();
    updateActiveItemDisplay();
    renderAddedItems();
    showToast('Item added to request.');
  });

   overlay.querySelector('[data-action="add-non-inventory"]').addEventListener('click', () => {
    nonInventoryForm.classList.remove('hidden');
    nonInventoryNameInput.focus();
  });

  overlay.querySelector('[data-action="cancel-non-inventory"]').addEventListener('click', () => {
    nonInventoryForm.classList.add('hidden');
  });

  overlay.querySelector('[data-action="save-non-inventory"]').addEventListener('click', () => {
    const name = nonInventoryNameInput.value.trim();
    const purpose = nonInventoryPurposeInput.value.trim();
    const quantity = Number.parseInt(nonInventoryQtyInput.value || '0', 10);
    if (!name) {
      showToast('Enter the item name for the item not on the list.', true);
      return;
    }
    if (!purpose) {
      showToast('Enter what the item is for.', true);
      return;
    }
    if (!quantity || quantity <= 0) {
      showToast('Enter a valid quantity requested.', true);
      return;
    }
    addedNonInventoryItems.push({ name, purpose, quantity });
    nonInventoryNameInput.value = '';
    nonInventoryPurposeInput.value = '';
    nonInventoryQtyInput.value = '1';
    nonInventoryForm.classList.add('hidden');
    renderAddedItems();
    showToast('Item not on inventory list added to request.');
  });

  overlay.querySelector('[data-action="submit"]').addEventListener('click', async () => {
    const requesterName = requesterInput.value.trim();
    const cleanedAddedItems = addedItems
      .map((item) => ({
        itemId: item.itemId,
        name: String(item.name || '').trim(),
        supplyGroup: item.supplyGroup || 'station',
        quantity: Number.parseInt(item.quantity || 0, 10),
      }))
      .filter((item) => item.name && item.quantity > 0);
    const cleanedAddedNonInventoryItems = addedNonInventoryItems
      .map((item) => ({
        name: String(item.name || '').trim(),
        purpose: String(item.purpose || '').trim(),
        supplyGroup: item.supplyGroup || 'station',
        quantity: Number.parseInt(item.quantity || 0, 10),
      }))
      .filter((item) => item.name && item.purpose && item.quantity > 0);
    if (!requesterName) {
      showToast('Enter who is sending the request.', true);
      return;
    }
    if (!cleanedAddedItems.length && !cleanedAddedNonInventoryItems.length) {
      showToast('Add at least one item before submitting.', true);
      return;
    }
    try {
      await fetchJson('/api/requests', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          stationCode,
          requesterName,
          items: cleanedAddedItems,
          otherItems: cleanedAddedNonInventoryItems,
        }),
      });
      close();
      await loadBootstrap();
      renderRecentStationRequests(stationCode);
      showToast('Request submitted to supply officer.');
    } catch (error) {
      showToast(error.message, true);
    }
  });

  overlay.querySelector('[data-action="cancel"]').addEventListener('click', () => {
    cancelConfirm.classList.remove('hidden');
  });
  overlay.querySelector('[data-action="goBack"]').addEventListener('click', () => {
    cancelConfirm.classList.add('hidden');
  });
  overlay.querySelector('[data-action="confirmCancel"]').addEventListener('click', close);

}

async function wireRequestPage() {
  const stationSelect = document.querySelector('#request-station-select');
  const openButton = document.querySelector('#open-request-modal');
  const emptyState = document.querySelector('#request-station-empty');
  if (!stationSelect) return;

  const sortedStations = [...state.stations].sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  stationSelect.innerHTML = [
    '<option value="">Select a station</option>',
    ...sortedStations.map((station) => `<option value="${escapeHtml(station.code)}">${escapeHtml(station.name)} (${escapeHtml(station.code)})</option>`),
  ].join('');

  const requestedStationCode = String(urlParams.get('station') || '').trim().toUpperCase();
  const defaultStationCode = sortedStations[0]?.code || '';
  const selectedStationCode = sortedStations.some((station) => station.code === requestedStationCode)
    ? requestedStationCode
    : defaultStationCode;

  stationSelect.value = selectedStationCode;
  stationSelect.disabled = !sortedStations.length;
  if (openButton) openButton.disabled = !sortedStations.length;
  emptyState?.classList.toggle('hidden', sortedStations.length > 0);
  renderRecentStationRequests(selectedStationCode);

  stationSelect.addEventListener('change', () => {
    const nextCode = stationSelect.value;
    const nextUrl = new URL(window.location.href);
    if (nextCode) nextUrl.searchParams.set('station', nextCode);
    else nextUrl.searchParams.delete('station');
    window.history.replaceState({}, '', `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`);
    renderRecentStationRequests(nextCode);
  });

  openButton?.addEventListener('click', () => {
    openRequestItemModal(stationSelect.value);
  });
}

async function wireAdminPage() {
  const form = document.querySelector('#admin-settings-form');
  const keyInput = document.querySelector('#admin-key');
  const refreshButton = document.querySelector('#refresh-errors');
  const summary24h = document.querySelector('#error-count-24h');
  const summary7d = document.querySelector('#error-count-7d');
  const summaryClient = document.querySelector('#error-count-client');
  const summaryServer = document.querySelector('#error-count-server');
  const errorList = document.querySelector('#error-list');
  const emptyState = document.querySelector('#error-empty-state');

  const headers = () => ({ ...(keyInput.value ? { 'x-admin-key': keyInput.value } : {}) });

  async function loadSettings() {
    const settings = await fetchJson('/api/admin/settings', { headers: headers() });
    form.querySelector('input[name="supplyOfficerEmail"]').value = settings.supply_officer_email || '';
    form.querySelector('input[name="adminEmails"]').value = settings.admin_emails || '';
  }

  function renderErrorSummary() {
    const summary = state.adminErrors.summary || {};
    summary24h.textContent = String(summary.last_24h_count || 0);
    summary7d.textContent = String(summary.last_7d_count || 0);
    summaryClient.textContent = String(summary.client_count || 0);
    summaryServer.textContent = String(summary.server_count || 0);
  }

  function renderAdminErrors() {
    renderErrorSummary();
    const errors = Array.isArray(state.adminErrors.errors) ? state.adminErrors.errors : [];
    emptyState.classList.toggle('hidden', errors.length > 0);
    errorList.innerHTML = errors.map((entry) => {
      const detailLines = [];
      if (entry.path) detailLines.push(`Path: ${escapeHtml(entry.path)}`);
      if (entry.method) detailLines.push(`Method: ${escapeHtml(entry.method)}`);
      if (entry.page) detailLines.push(`Page: ${escapeHtml(entry.page)}`);
      if (entry.status_code) detailLines.push(`Status: ${escapeHtml(entry.status_code)}`);
      if (entry.details?.userAgent) detailLines.push(`Browser: ${escapeHtml(entry.details.userAgent)}`);

      const context = entry.details?.context && Object.keys(entry.details.context).length
        ? `<pre class="error-event__details">${escapeHtml(JSON.stringify(entry.details.context, null, 2))}</pre>`
        : '';
      const stack = entry.stack ? `<pre class="error-event__details">${escapeHtml(entry.stack)}</pre>` : '';

      return `
        <article class="error-event">
          <div class="error-event__header">
            <div>
              <span class="error-event__badge">${escapeHtml(entry.source || 'unknown')}</span>
              <strong>${escapeHtml(entry.category || 'general')}</strong>
            </div>
            <span class="helper">${new Date(entry.created_at).toLocaleString()}</span>
          </div>
          <p>${escapeHtml(entry.message || 'Unknown error')}</p>
          ${detailLines.length ? `<p class="helper">${detailLines.join(' · ')}</p>` : ''}
          ${context}
          ${stack}
        </article>
      `;
    }).join('');
  }

  async function loadErrors() {
    const response = await fetchJson('/api/admin/errors?limit=25', { headers: headers() });
    state.adminErrors.summary = response.summary || null;
    state.adminErrors.errors = response.errors || [];
    renderAdminErrors();
  }

  keyInput?.addEventListener('change', () => {
    Promise.all([loadSettings(), loadErrors()])
      .catch((error) => showToast(error.message, true));
  });

  refreshButton?.addEventListener('click', async () => {
    try {
      await loadErrors();
      showToast('Error tracking refreshed.');
    } catch (error) {
      showToast(error.message, true);
    }
  });

  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const payload = formToPayload(form);
      await fetchJson('/api/admin/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers() },
        body: JSON.stringify(payload),
      });
      showToast('Admin settings saved.');
    } catch (error) {
      showToast(error.message, true);
    }
  });

  await Promise.all([loadSettings(), loadErrors()]);
}

async function wireLoginPage() {
  const form = document.querySelector('#login-form');
  const badgeInput = document.querySelector('#login-badge-code');
  const pinInput = document.querySelector('#login-pin');
  const scanButton = document.querySelector('#scan-login-badge');
  const message = document.querySelector('#login-message');

  scanButton?.addEventListener('click', async () => {
    try {
      const code = await scanCodeWithCamera('Scan your badge');
      badgeInput.value = code.trim();
      showToast('Badge scanned.');
    } catch (error) {
      showToast(error.message, true);
    }
  });

  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    message.textContent = '';
    try {
      const response = await fetchJson('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          badgeCode: badgeInput.value.trim(),
          pin: pinInput.value.trim(),
        }),
      });
      state.auth = response.user || null;
      window.location.replace(getDefaultPath());
    } catch (error) {
      message.textContent = error.message || 'Login failed.';
      showToast(error.message || 'Login failed.', true);
    }
  });
}

async function wireAccountPage() {
  const form = document.querySelector('#account-pin-form');
  const username = document.querySelector('#account-username');
  const badge = document.querySelector('#account-badge');
  const pages = document.querySelector('#account-pages');
  const notice = document.querySelector('#account-pin-notice');

  if (username) username.textContent = state.auth?.username || '';
  if (badge) badge.textContent = state.auth?.badgeCode || '';
  if (pages) {
    pages.innerHTML = (state.availablePages || [])
      .filter((entry) => state.auth?.isAdmin || (state.auth?.allowedPageKeys || []).includes(entry.key))
      .map((entry) => `<li>${escapeHtml(entry.label)}</li>`)
      .join('') || '<li>Account settings only</li>';
  }

  if (state.auth?.pinResetRequired && notice) {
    notice.textContent = 'Your PIN was reset by an account manager. Choose a new 4-digit PIN now.';
    notice.classList.remove('hidden');
  }

  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const currentPin = form.querySelector('input[name="currentPin"]').value.trim();
    const newPin = form.querySelector('input[name="newPin"]').value.trim();
    const confirmPin = form.querySelector('input[name="confirmPin"]').value.trim();

    if (newPin !== confirmPin) {
      showToast('New PIN and confirmation do not match.', true);
      return;
    }

    try {
      const response = await fetchJson('/api/account/pin', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ currentPin, newPin }),
      });
      state.auth = response.user || state.auth;
      notice?.classList.add('hidden');
      form.reset();
      renderAuthChrome();
      showToast('PIN updated.');
    } catch (error) {
      showToast(error.message, true);
    }
  });
}

function adminPageCheckboxMarkup(selectedKeys = []) {
  return (state.availablePages || []).map((entry) => `
    <label class="checkbox-label admin-checkbox">
      <input type="checkbox" data-page-key="${escapeHtml(entry.key)}" ${selectedKeys.includes(entry.key) ? 'checked' : ''} />
      <span>${escapeHtml(entry.label)}</span>
    </label>
  `).join('');
}

async function wireEnhancedAdminPage() {
  const form = document.querySelector('#admin-settings-form');
  const keyInput = document.querySelector('#admin-key');
  const refreshButton = document.querySelector('#refresh-errors');
  const summary24h = document.querySelector('#error-count-24h');
  const summary7d = document.querySelector('#error-count-7d');
  const summaryClient = document.querySelector('#error-count-client');
  const summaryServer = document.querySelector('#error-count-server');
  const errorList = document.querySelector('#error-list');
  const emptyState = document.querySelector('#error-empty-state');
  const createUserForm = document.querySelector('#admin-user-create-form');
  const userList = document.querySelector('#admin-user-list');
  const stationForm = document.querySelector('#admin-station-form');
  const stationList = document.querySelector('#admin-station-list');
  const accessNote = document.querySelector('#admin-access-note');

  const headers = () => ({ ...(keyInput?.value.trim() ? { 'x-admin-key': keyInput.value.trim() } : {}) });

  async function loadSettings() {
    const settings = await fetchJson('/api/admin/settings', { headers: headers(), suppressErrorTracking: true });
    form.querySelector('input[name="supplyOfficerEmail"]').value = settings.supply_officer_email || '';
    form.querySelector('input[name="adminEmails"]').value = settings.admin_emails || '';
  }

  function renderErrorSummary() {
    const summary = state.adminErrors.summary || {};
    summary24h.textContent = String(summary.last_24h_count || 0);
    summary7d.textContent = String(summary.last_7d_count || 0);
    summaryClient.textContent = String(summary.client_count || 0);
    summaryServer.textContent = String(summary.server_count || 0);
  }

  function renderAdminErrors() {
    renderErrorSummary();
    const errors = Array.isArray(state.adminErrors.errors) ? state.adminErrors.errors : [];
    emptyState.classList.toggle('hidden', errors.length > 0);
    errorList.innerHTML = errors.map((entry) => {
      const detailLines = [];
      if (entry.path) detailLines.push(`Path: ${escapeHtml(entry.path)}`);
      if (entry.method) detailLines.push(`Method: ${escapeHtml(entry.method)}`);
      if (entry.page) detailLines.push(`Page: ${escapeHtml(entry.page)}`);
      if (entry.status_code) detailLines.push(`Status: ${escapeHtml(entry.status_code)}`);
      if (entry.details?.userAgent) detailLines.push(`Browser: ${escapeHtml(entry.details.userAgent)}`);

      const context = entry.details?.context && Object.keys(entry.details.context).length
        ? `<pre class="error-event__details">${escapeHtml(JSON.stringify(entry.details.context, null, 2))}</pre>`
        : '';
      const stack = entry.stack ? `<pre class="error-event__details">${escapeHtml(entry.stack)}</pre>` : '';

      return `
        <article class="error-event">
          <div class="error-event__header">
            <div>
              <span class="error-event__badge">${escapeHtml(entry.source || 'unknown')}</span>
              <strong>${escapeHtml(entry.category || 'general')}</strong>
            </div>
            <span class="helper">${new Date(entry.created_at).toLocaleString()}</span>
          </div>
          <p>${escapeHtml(entry.message || 'Unknown error')}</p>
          ${detailLines.length ? `<p class="helper">${detailLines.join(' · ')}</p>` : ''}
          ${context}
          ${stack}
        </article>
      `;
    }).join('');
  }

  async function loadErrors() {
    const response = await fetchJson('/api/admin/errors?limit=25', { headers: headers(), suppressErrorTracking: true });
    state.adminErrors.summary = response.summary || null;
    state.adminErrors.errors = response.errors || [];
    renderAdminErrors();
  }

  function renderStationList() {
    if (!stationList) return;
    const stations = [...state.stations].sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    if (!stations.length) {
      stationList.innerHTML = '<p class="helper">No stations configured yet.</p>';
      return;
    }

    stationList.innerHTML = stations.map((station) => `
      <article class="admin-user-card" data-station-id="${station.id}">
        <div class="admin-user-card__header">
          <div>
            <strong>${escapeHtml(station.name)}</strong>
            <div class="helper">${escapeHtml(station.code)}</div>
          </div>
          <button type="button" class="danger" data-action="delete-station">Remove station</button>
        </div>
      </article>
    `).join('');

    stationList.querySelectorAll('[data-action="delete-station"]').forEach((button) => {
      button.addEventListener('click', async () => {
        const card = button.closest('[data-station-id]');
        const stationId = Number(card?.dataset.stationId || 0);
        const station = state.stations.find((entry) => Number(entry.id) === stationId);
        if (!station) return;
        const confirmed = window.confirm(`Remove ${station.name} (${station.code})? This only works when no inventory or request history exists for that station.`);
        if (!confirmed) return;

        try {
          await fetchJson('/api/admin/stations/delete', {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...headers() },
            body: JSON.stringify({ stationId }),
          });
          await loadStations();
          showToast('Station removed.');
        } catch (error) {
          showToast(error.message, true);
        }
      });
    });
  }

  async function loadStations() {
    const response = await fetchJson('/api/admin/stations', { headers: headers(), suppressErrorTracking: true });
    state.stations = response.stations || [];
    renderStationList();
  }

  function renderUserList(users) {
    userList.innerHTML = users.map((user) => `
      <article class="admin-user-card" data-user-id="${user.id}">
        <div class="admin-user-card__header">
          <div>
            <strong>${escapeHtml(user.displayName)}</strong>
            <div class="helper">${escapeHtml(user.username)} · Badge ${escapeHtml(user.badgeCode)}</div>
          </div>
          <span class="request-group-badge">${user.isAdmin ? 'Admin' : 'User'}</span>
        </div>
        <label>Display name<input type="text" name="displayName" value="${escapeHtml(user.displayName)}" /></label>
        <label>Username<input type="text" name="username" value="${escapeHtml(user.username)}" /></label>
        <label>Badge code<input type="text" name="badgeCode" value="${escapeHtml(user.badgeCode)}" /></label>
        <label class="checkbox-label">
          <input type="checkbox" name="isAdmin" ${user.isAdmin ? 'checked' : ''} />
          <span>Account manager / admin access</span>
        </label>
        <div class="admin-page-grid">${adminPageCheckboxMarkup(user.assignedPageKeys || [])}</div>
        <div class="inline-actions">
          <button type="button" data-action="save-user">Save user</button>
          <input type="text" name="resetPin" inputmode="numeric" maxlength="4" placeholder="New 4-digit PIN" />
          <button type="button" class="secondary" data-action="reset-pin">Reset PIN</button>
        </div>
        ${user.pinResetRequired ? '<p class="helper auth-warning">User must change PIN at next account settings visit.</p>' : ''}
      </article>
    `).join('');

    userList.querySelectorAll('[data-action="save-user"]').forEach((button) => {
      button.addEventListener('click', async () => {
        const card = button.closest('[data-user-id]');
        const userId = Number(card.dataset.userId);
        const pageKeys = [...card.querySelectorAll('[data-page-key]:checked')].map((input) => input.dataset.pageKey);
        try {
          await fetchJson('/api/admin/users', {
            method: 'PUT',
            headers: { 'content-type': 'application/json', ...headers() },
            body: JSON.stringify({
              userId,
              displayName: card.querySelector('input[name="displayName"]').value.trim(),
              username: card.querySelector('input[name="username"]').value.trim(),
              badgeCode: card.querySelector('input[name="badgeCode"]').value.trim(),
              isAdmin: card.querySelector('input[name="isAdmin"]').checked,
              pageKeys,
            }),
          });
          await loadUsers();
          showToast('User updated.');
        } catch (error) {
          showToast(error.message, true);
        }
      });
    });

    userList.querySelectorAll('[data-action="reset-pin"]').forEach((button) => {
      button.addEventListener('click', async () => {
        const card = button.closest('[data-user-id]');
        const userId = Number(card.dataset.userId);
        const newPin = card.querySelector('input[name="resetPin"]').value.trim();
        try {
          await fetchJson('/api/admin/users/reset-pin', {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...headers() },
            body: JSON.stringify({ userId, newPin }),
          });
          card.querySelector('input[name="resetPin"]').value = '';
          await loadUsers();
          showToast('PIN reset. User will be asked to change it.');
        } catch (error) {
          showToast(error.message, true);
        }
      });
    });
  }

  async function loadUsers() {
    const response = await fetchJson('/api/admin/users', { headers: headers(), suppressErrorTracking: true });
    state.availablePages = response.pages || [];
    renderUserList(response.users || []);
    const createPageList = createUserForm?.querySelector('[data-role="page-list"]');
    if (createPageList) createPageList.innerHTML = adminPageCheckboxMarkup();
  }

  async function loadAdminData() {
    try {
      if (accessNote) {
        accessNote.textContent = state.auth?.isAdmin
          ? 'Signed in with admin access.'
          : 'Enter the worker admin key to manage accounts and system settings.';
      }
      await Promise.all([loadSettings(), loadErrors(), loadUsers(), loadStations()]);
    } catch (error) {
      if (accessNote) accessNote.textContent = 'Admin access is required. Sign in as an admin user or enter the worker admin key.';
      if (error.statusCode !== 401) showToast(error.message, true);
    }
  }

  keyInput?.addEventListener('change', () => {
    void loadAdminData();
  });

  refreshButton?.addEventListener('click', async () => {
    try {
      await Promise.all([loadErrors(), loadUsers(), loadStations()]);
      showToast('Admin data refreshed.');
    } catch (error) {
      showToast(error.message, true);
    }
  });

  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const payload = formToPayload(form);
      await fetchJson('/api/admin/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers() },
        body: JSON.stringify(payload),
      });
      showToast('Admin settings saved.');
    } catch (error) {
      showToast(error.message, true);
    }
  });

  createUserForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const pageKeys = [...createUserForm.querySelectorAll('[data-page-key]:checked')].map((input) => input.dataset.pageKey);
    try {
      await fetchJson('/api/admin/users', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers() },
        body: JSON.stringify({
          displayName: createUserForm.querySelector('input[name="displayName"]').value.trim(),
          username: createUserForm.querySelector('input[name="username"]').value.trim(),
          badgeCode: createUserForm.querySelector('input[name="badgeCode"]').value.trim(),
          pin: createUserForm.querySelector('input[name="pin"]').value.trim(),
          isAdmin: createUserForm.querySelector('input[name="isAdmin"]').checked,
          pageKeys,
        }),
      });
      createUserForm.reset();
      await loadUsers();
      showToast('User created.');
    } catch (error) {
      showToast(error.message, true);
    }
  });

  stationForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await fetchJson('/api/admin/stations', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers() },
        body: JSON.stringify({
          name: stationForm.querySelector('input[name="stationName"]').value.trim(),
          code: stationForm.querySelector('input[name="stationCode"]').value.trim(),
        }),
      });
      stationForm.reset();
      await loadStations();
      showToast('Station added.');
    } catch (error) {
      showToast(error.message, true);
    }
  });

  await loadAdminData();
}

(async function init() {
  setupClientErrorTracking();
  updateScopedNavLinks();
  try {
    await loadAuthSession();
    if (page === 'login') {
      if (state.auth) {
        goToDefaultPath();
        return;
      }
      await wireLoginPage();
      return;
    }

    if (page !== 'admin' && !state.auth) {
      window.location.replace('/login.html');
      return;
    }

    if (state.auth) {
      if (!canAccessCurrentPath()) {
        goToDefaultPath();
        return;
      }
      renderAuthChrome();
      filterNavigationForUser();
    }

    if (page === 'account') {
      await wireAccountPage();
      return;
    }

    if (page === 'admin') {
      if (state.auth) {
        renderAuthChrome();
        filterNavigationForUser();
      }
      await wireEnhancedAdminPage();
      return;
    }

    await loadBootstrap();
    if (page === 'main') renderMain();
    if (page === 'inventory') {
      renderInventoryPage();
      await wireInventoryPage();
    }
    if (page === 'issue') {
      renderIssuePage();
      await wireIssueForm();
    }
    if (page === 'restock') {
      renderRestockPage();
      await wireRestockForm();
    }
    if (page === 'search') await wireSearchPage();
    if (page === 'request') await wireRequestPage();
  } catch (error) {
    trackClientError(error, {
      category: 'app_init_failure',
      context: { page },
    });
    showToast(error.message, true);
  }
})();
