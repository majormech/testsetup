const json = (data, init = {}) => new Response(JSON.stringify(data), {
  ...init,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    ...(init.headers || {}),
  },
});

const badRequest = (message, status = 400) => json({ error: message }, { status });

const ERROR_MESSAGE_LIMIT = 500;
const ERROR_STACK_LIMIT = 4000;
const ERROR_DETAILS_LIMIT = 4000;
const SESSION_COOKIE_NAME = 'dfd_supply_session';
const SESSION_DURATION_DAYS = 14;
const LEGACY_REQUEST_PAGE_KEYS = ['request-st01', 'request-st02', 'request-st03', 'request-st04', 'request-st05', 'request-st06', 'request-st07'];
const PAGE_KEY_ALIASES = new Map(LEGACY_REQUEST_PAGE_KEYS.map((key) => [key, 'request']));
const APP_PAGE_DEFINITIONS = [
  { key: 'main', path: '/index.html', label: 'Main dashboard', assignable: true },
  { key: 'restock', path: '/restock.html', label: 'Restock page', assignable: true },
  { key: 'issue', path: '/issue.html', label: 'Issue page', assignable: true },
  { key: 'inventory', path: '/inventory.html', label: 'Inventory actions', assignable: true },
  { key: 'search', path: '/search.html', label: 'Search and usage', assignable: true },
  { key: 'request', path: '/request.html', label: 'Station request page', assignable: true },
];
const APP_PAGE_LOOKUP = new Map(APP_PAGE_DEFINITIONS.map((page) => [page.key, page]));
const APP_PATH_LOOKUP = new Map(APP_PAGE_DEFINITIONS.map((page) => [page.path, page]));

async function parseBody(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function truncate(value, maxLength) {
  const text = String(value ?? '');
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ note: 'Unable to serialize details' });
  }
}

function normalizeStatusCode(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function hex(buffer) {
  return [...new Uint8Array(buffer)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function normalizeBoolean(value) {
  return value === true || value === 1 || String(value || '').trim().toLowerCase() === 'true';
}

function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeBadgeCode(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizeStationCode(value) {
  return String(value || '').trim().toUpperCase();
}

function validatePin(value) {
  return /^\d{4}$/.test(String(value || '').trim());
}

function parseCookies(request) {
  return String(request.headers.get('cookie') || '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((acc, entry) => {
      const separator = entry.indexOf('=');
      if (separator === -1) return acc;
      const key = entry.slice(0, separator).trim();
      const val = entry.slice(separator + 1).trim();
      acc[key] = decodeURIComponent(val);
      return acc;
    }, {});
}

function createSessionCookie(token, expiresAt, options = {}) {
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Expires=${expiresAt.toUTCString()}`,
  ];
  if (!options.insecure) parts.push('Secure');
  return parts.join('; ');
}

function clearSessionCookie(options = {}) {
  return createSessionCookie('', new Date(0), options);
}

async function hashPin(pin, salt) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}:${String(pin || '').trim()}`));
  return hex(digest);
}

function createSalt() {
  return crypto.randomUUID().replaceAll('-', '');
}

function createSessionToken() {
  return `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll('-', '');
}

function getAssignablePages() {
  return APP_PAGE_DEFINITIONS.map((page) => ({ ...page }));
}

function normalizeAssignedPageKeys(pageKeys) {
  const values = Array.isArray(pageKeys) ? pageKeys : [];
  return [...new Set(values
    .map((value) => PAGE_KEY_ALIASES.get(String(value || '').trim()) || String(value || '').trim())
    .filter((value) => APP_PAGE_LOOKUP.has(value)))];
}

async function getUserAssignedPageKeys(db, userId) {
  const response = await db.prepare(`
    SELECT page_key
    FROM user_page_assignments
    WHERE user_id = ?
    ORDER BY page_key ASC
  `).bind(userId).all();
  return [...new Set((response.results || [])
    .map((row) => PAGE_KEY_ALIASES.get(row.page_key) || row.page_key)
    .filter((pageKey) => APP_PAGE_LOOKUP.has(pageKey)))];
}

function getAllowedPageKeys(assignedPageKeys, isAdmin = false) {
  const assigned = normalizeAssignedPageKeys(assignedPageKeys);
  return isAdmin
    ? APP_PAGE_DEFINITIONS.map((page) => page.key)
    : assigned;
}

function getDefaultPagePath(allowedPageKeys, isAdmin = false) {
  if (isAdmin) return '/index.html';
  const firstMatch = normalizeAssignedPageKeys(allowedPageKeys)
    .map((pageKey) => APP_PAGE_LOOKUP.get(pageKey))
    .find(Boolean);
  return firstMatch?.path || '/account.html';
}

async function buildUserResponse(db, userRow) {
  const assignedPageKeys = await getUserAssignedPageKeys(db, userRow.id);
  const isAdmin = normalizeBoolean(userRow.is_admin);
  const allowedPageKeys = getAllowedPageKeys(assignedPageKeys, isAdmin);
  return {
    id: userRow.id,
    username: userRow.username,
    displayName: userRow.display_name,
    badgeCode: userRow.badge_code,
    isAdmin,
    pinResetRequired: normalizeBoolean(userRow.pin_reset_required),
    assignedPageKeys,
    allowedPageKeys,
    defaultPath: getDefaultPagePath(allowedPageKeys, isAdmin),
  };
}

async function getAuthContext(request, env) {
  const cookies = parseCookies(request);
  const sessionToken = cookies[SESSION_COOKIE_NAME];
  if (!sessionToken) return null;

  const row = await env.DB.prepare(`
    SELECT
      s.id AS session_id,
      s.session_token,
      s.expires_at,
      u.id,
      u.username,
      u.display_name,
      u.badge_code,
      u.is_admin,
      u.pin_reset_required
    FROM auth_sessions s
    JOIN app_users u ON u.id = s.user_id
    WHERE s.session_token = ?
      AND datetime(s.expires_at) > datetime('now')
    LIMIT 1
  `).bind(sessionToken).first();

  if (!row) return null;
  return {
    sessionId: row.session_id,
    sessionToken: row.session_token,
    expiresAt: row.expires_at,
    user: await buildUserResponse(env.DB, row),
  };
}

function errorMessage(error) {
  if (error instanceof Error) return error.message || 'Unknown error';
  return String(error || 'Unknown error');
}

function errorStack(error) {
  return error instanceof Error ? error.stack || '' : '';
}

function requestPathname(request) {
  try {
    return new URL(request.url).pathname;
  } catch {
    return null;
  }
}

export async function logErrorEvent(env, payload) {
  if (!env?.DB || !payload?.message) return;

  try {
    await env.DB.prepare(`
      INSERT INTO error_events (source, category, message, stack, path, method, page, status_code, details_json)
      VALUES (?, ?, ?, NULLIF(?, ''), NULLIF(?, ''), NULLIF(?, ''), NULLIF(?, ''), ?, NULLIF(?, ''))
    `).bind(
      payload.source === 'client' ? 'client' : 'server',
      truncate(payload.category || 'general', 100),
      truncate(payload.message, ERROR_MESSAGE_LIMIT),
      truncate(payload.stack || '', ERROR_STACK_LIMIT),
      truncate(payload.path || '', 255),
      truncate(payload.method || '', 20),
      truncate(payload.page || '', 255),
      normalizeStatusCode(payload.statusCode),
      truncate(payload.detailsJson || '', ERROR_DETAILS_LIMIT),
    ).run();
  } catch {
    // Do not let logging failures interrupt the main request flow.
  }
}

export async function logServerError(env, request, error, extra = {}) {
  await logErrorEvent(env, {
    source: 'server',
    category: extra.category || 'request_failure',
    message: errorMessage(error),
    stack: errorStack(error),
    path: extra.path || requestPathname(request),
    method: extra.method || request.method,
    page: extra.page || '',
    statusCode: extra.statusCode || 500,
    detailsJson: safeJson(extra.details || {}),
  });
}

async function getSettings(db) {
  const row = await db.prepare('SELECT supply_officer_email, admin_emails FROM admin_settings WHERE id = 1').first();
  return row || { supply_officer_email: '', admin_emails: '' };
}

function normalizeSupplyGroup(value, fallback = 'station') {
  return fallback;
}

function selectSupplyOfficerEmail(settings, supplyGroup) {
  return settings.supply_officer_email || '';
}

function parseBarcodes(body) {
  const candidateValues = [body?.barcodes ?? '', body?.barcode ?? ''];
  const splitValues = candidateValues
    .flatMap((value) => String(value || '').split(/[\n,]/g))
    .map((value) => value.trim())
    .filter(Boolean);
  return [...new Set(splitValues)];
}

function generateSku(body) {
  const provided = String(body?.sku || '').trim();
  if (provided) return provided;
  const qrPart = String(body?.qrCode || '').trim().replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 10);
  const namePart = String(body?.name || '').trim().replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 6);
  const stamp = Date.now().toString().slice(-6);
  return `${(namePart || 'ITEM')}-${(qrPart || 'QR')}-${stamp}`;
}

function buildQrImageUrl(qrCode) {
  const value = String(qrCode || '').trim();
  if (!value) return null;
  return `https://api.qrserver.com/v1/create-qr-code/?size=96x96&data=${encodeURIComponent(value)}`;
}

function normalizeRequestedItems(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map((entry) => {
      const name = String(entry?.name || '').trim();
      const quantity = Number.parseInt(entry?.quantity || 0, 10);
      const issuedQuantity = Number.parseInt(entry?.issuedQuantity || 0, 10);
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
  if (Array.isArray(items)) {
    return items
      .map((entry) => {
        const name = String(entry?.name || '').trim();
        const purpose = String(entry?.purpose || entry?.usedFor || '').trim();
        const quantity = Number.parseInt(entry?.quantity || 0, 10);
        const issuedQuantity = Number.parseInt(entry?.issuedQuantity || 0, 10);
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

  if (typeof items === 'string') {
    const trimmed = items.trim();
    if (!trimmed) return [];
    return [{
      name: trimmed,
      purpose: 'Legacy note',
      quantity: 1,
      issuedQuantity: 0,
    }];
  }

  return [];
}

export async function bootstrapData(db) {
  const [stationsRes, itemsRes, txRes, stationRequestsRes, settings] = await Promise.all([
    db.prepare('SELECT id, name, code FROM stations ORDER BY id').all(),
    db.prepare(`
      SELECT
        i.id,
        i.name,
        i.sku,
        i.barcode,
        i.qr_code,
        i.description,
        i.qr_image_url,
        i.unit_cost,
        i.low_stock_level,
        i.total_quantity,
        i.updated_at,
        COALESCE((
          SELECT json_group_array(json_object(
            'stationId', s.id,
            'stationName', s.name,
            'quantity', COALESCE(si.quantity, 0)
            ))
          FROM station_inventory si
          JOIN stations s ON s.id = si.station_id
          WHERE si.item_id = i.id
        ), '[]') AS station_breakdown,
        COALESCE((
          SELECT json_group_array(ib.barcode)
          FROM item_barcodes ib
          WHERE ib.item_id = i.id
          ORDER BY ib.id
        ), '[]') AS barcodes_json
      FROM items i
      WHERE i.deleted_at IS NULL
      ORDER BY i.name COLLATE NOCASE ASC
    `).all(),
    db.prepare(`
      SELECT
        t.id,
        t.quantity_delta,
        t.action_type,
        t.source,
        t.note,
        t.performed_by,
        t.created_at,
        i.name AS item_name,
        i.sku AS item_sku,
        s.name AS station_name
      FROM stock_transactions t
      JOIN items i ON i.id = t.item_id
      LEFT JOIN stations s ON s.id = t.station_id
      ORDER BY t.created_at DESC, t.id DESC
      LIMIT 25
    `).all(),
     db.prepare(`
      SELECT
        sr.id,
        sr.station_id,
        sr.requester_name,
        sr.requested_items_json,
        sr.other_items,
        sr.modified_by,
        sr.modification_reason,
        sr.modified_at,
        sr.canceled_by,
        sr.cancel_reason,
        sr.canceled_at,
        sr.completed_by,
        sr.completed_at,
        sr.created_at,
        s.name AS station_name,
        s.code AS station_code
      FROM station_requests sr
      JOIN stations s ON s.id = sr.station_id
      ORDER BY sr.created_at DESC, sr.id DESC
    `).all(),
    getSettings(db),
  ]);

    const stationRequests = stationRequestsRes.results.map((request) => {
    let parsedOtherItems = [];
    try {
      parsedOtherItems = JSON.parse(request.other_items || '[]');
    } catch {
      parsedOtherItems = request.other_items || '';
    }

    return {
      ...request,
      requested_items: normalizeRequestedItems(JSON.parse(request.requested_items_json || '[]')),
      non_inventory_items: normalizeOtherRequestedItems(parsedOtherItems),
    };
  });

  return {
    stations: stationsRes.results,
    items: itemsRes.results.map((item) => ({
      ...item,
      station_breakdown: JSON.parse(item.station_breakdown).filter(Boolean),
      barcodes: JSON.parse(item.barcodes_json || '[]').filter(Boolean),
    })),
    recentTransactions: txRes.results,
    stationRequests,
    settings,
  };
}

async function resolveItem(db, { itemId, code }) {
  if (itemId) {
    const found = await db.prepare('SELECT * FROM items WHERE id = ? AND deleted_at IS NULL').bind(itemId).first();
    return found || null;
  }
  if (!code) return null;
  return db.prepare(`
    SELECT *
    FROM items
  WHERE (barcode = ? OR qr_code = ? OR sku = ?
      OR id IN (SELECT item_id FROM item_barcodes WHERE barcode = ?))
      AND deleted_at IS NULL
    LIMIT 1
  `).bind(code, code, code, code).first();
}

async function ensureStationRow(db, stationId, itemId) {
  await db.prepare(`
    INSERT INTO station_inventory (station_id, item_id, quantity)
    VALUES (?, ?, 0)
    ON CONFLICT(station_id, item_id) DO NOTHING
  `).bind(stationId, itemId).run();
}

async function findItemForRequest(db, entry) {
  const itemId = Number.parseInt(entry?.itemId || 0, 10);
  if (Number.isInteger(itemId) && itemId > 0) {
    return db.prepare('SELECT id, name, sku FROM items WHERE id = ? AND deleted_at IS NULL').bind(itemId).first();
  }
  const name = String(entry?.name || '').trim();
  if (!name) return null;
  return db.prepare('SELECT id, name, sku FROM items WHERE lower(name) = lower(?) AND deleted_at IS NULL LIMIT 1').bind(name).first();
}

export async function addItem(request, env) {
  const body = await parseBody(request);
  if (!body?.name || !body?.qrCode) return badRequest('name and qrCode are required');
  const barcodes = parseBarcodes(body);
  const skipBarcodeCapture = String(body?.skipBarcodeCapture || 'true') === 'true';
  if (!skipBarcodeCapture && !barcodes.length) {
    return badRequest('Provide at least one barcode or enable skip barcode scan.');
  }
  const primaryBarcode = barcodes[0] || '';
  const qty = Number.parseInt(body.totalQuantity ?? 0, 10);
  const unitCost = body.unitCost === '' || body.unitCost == null ? 0 : Number.parseFloat(body.unitCost);
  const lowStockLevel = Number.parseInt(body.lowStockLevel ?? 0, 10);
  const performedBy = String(body.performedBy || '').trim();
  const performedAtRaw = String(body.performedAt || '').trim();
  const performedAt = performedAtRaw ? performedAtRaw.replace('T', ' ') : null;
  const sku = generateSku(body);
  const qrImageUrl = buildQrImageUrl(body.qrCode);
  if (Number.isNaN(qty) || qty < 0) return badRequest('totalQuantity must be a positive number or 0');
  if (Number.isNaN(unitCost) || unitCost < 0) return badRequest('unitCost must be a positive number or 0');
  if (Number.isNaN(lowStockLevel) || lowStockLevel < 0) return badRequest('lowStockLevel must be a positive number or 0');
  if (!performedBy) return badRequest('performedBy is required');
  
  try {
    const inserted = await env.DB.prepare(`
      INSERT INTO items (name, sku, barcode, qr_code, qr_image_url, description, unit_cost, low_stock_level, total_quantity, updated_at)
      VALUES (?, ?, NULLIF(?, ''), NULLIF(?, ''), NULLIF(?, ''), NULLIF(?, ''), ?, ?, ?, CURRENT_TIMESTAMP)
      RETURNING *
    `).bind(body.name.trim(), sku, primaryBarcode, body.qrCode ?? '', qrImageUrl ?? '', body.description ?? '', unitCost, lowStockLevel, qty).first();

    const operations = [];
    
    if (barcodes.length) {
     operations.push(...barcodes.map((barcode) => env.DB.prepare(`
        INSERT INTO item_barcodes (item_id, barcode)
        VALUES (?, ?)
      `).bind(inserted.id, barcode)));
    }

    operations.push(env.DB.prepare(`
      INSERT INTO stock_transactions (item_id, station_id, quantity_delta, action_type, source, note, performed_by, created_at)
      VALUES (?, NULL, ?, 'restock', 'manual', NULLIF(?, ''), ?, COALESCE(NULLIF(?, ''), CURRENT_TIMESTAMP))
    `).bind(inserted.id, qty, body.note ?? '', performedBy, performedAt || ''));

    if (operations.length) {
      await env.DB.batch(operations);
    }

    return json({ item: { ...inserted, barcodes } }, { status: 201 });
  } catch (error) {
    await logServerError(env, request, error, {
      category: 'item_create_failure',
      statusCode: 400,
      details: { name: body?.name || '', sku, qrCode: body?.qrCode || '' },
    });
    return badRequest(error.message.includes('UNIQUE') ? 'Item SKU, each barcode, and QR code must be unique.' : error.message);
  }
}

export async function updateItem(request, env) {
  const body = await parseBody(request);
  const itemId = Number.parseInt(body?.itemId, 10);
  if (!Number.isInteger(itemId) || itemId <= 0) return badRequest('itemId is required');

  const item = await env.DB.prepare('SELECT * FROM items WHERE id = ? AND deleted_at IS NULL').bind(itemId).first();
  if (!item) return badRequest('Item not found', 404);

  const name = String(body?.name || '').trim();
  const sku = String(body?.sku || '').trim();
  const qrCode = String(body?.qrCode || '').trim();
  const qrImageUrl = buildQrImageUrl(qrCode);
  const description = String(body?.description || '').trim();
  const performedBy = String(body?.performedBy || 'Main Page Edit').trim() || 'Main Page Edit';
  const barcodes = parseBarcodes(body);
  const primaryBarcode = barcodes[0] || '';

  const totalQuantity = Number.parseInt(body?.totalQuantity, 10);
  const lowStockLevel = Number.parseInt(body?.lowStockLevel, 10);
  const unitCost = Number.parseFloat(body?.unitCost);

  if (!name) return badRequest('name is required');
  if (!sku) return badRequest('sku is required');
  if (!qrCode) return badRequest('qrCode is required');
  if (Number.isNaN(totalQuantity) || totalQuantity < 0) return badRequest('totalQuantity must be a positive number or 0');
  if (Number.isNaN(lowStockLevel) || lowStockLevel < 0) return badRequest('lowStockLevel must be a positive number or 0');
  if (Number.isNaN(unitCost) || unitCost < 0) return badRequest('unitCost must be a positive number or 0');

  const quantityDelta = totalQuantity - Number.parseInt(item.total_quantity || 0, 10);

  try {
    const operations = [
      env.DB.prepare(`
        UPDATE items
        SET name = ?,
            sku = ?,
            qr_code = ?,
            barcode = NULLIF(?, ''),
            qr_image_url = NULLIF(?, ''),
            description = NULLIF(?, ''),
            unit_cost = ?,
            low_stock_level = ?,
            total_quantity = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
     `).bind(name, sku, qrCode, primaryBarcode, qrImageUrl ?? '', description, unitCost, lowStockLevel, totalQuantity, itemId),
      env.DB.prepare('DELETE FROM item_barcodes WHERE item_id = ?').bind(itemId),
      ...barcodes.map((barcode) => env.DB.prepare(`
        INSERT INTO item_barcodes (item_id, barcode)
        VALUES (?, ?)
      `).bind(itemId, barcode)),
    ];

    if (quantityDelta !== 0) {
      operations.push(env.DB.prepare(`
        INSERT INTO stock_transactions (item_id, station_id, quantity_delta, action_type, source, note, performed_by, created_at)
        VALUES (?, NULL, ?, 'adjustment', 'manual', ?, ?, CURRENT_TIMESTAMP)
      `).bind(itemId, quantityDelta, 'Quantity changed from item modify popup.', performedBy));
    }

    await env.DB.batch(operations);
  } catch (error) {
    await logServerError(env, request, error, {
      category: 'item_update_failure',
      statusCode: 400,
      details: { itemId, sku, qrCode },
    });
    return badRequest(error.message.includes('UNIQUE') ? 'Item SKU, each barcode, and QR code must be unique.' : error.message);
  }

  const updatedItem = await env.DB.prepare(`
    SELECT
      i.*,
      COALESCE((
        SELECT json_group_array(ib.barcode)
        FROM item_barcodes ib
        WHERE ib.item_id = i.id
        ORDER BY ib.id
      ), '[]') AS barcodes_json
    FROM items i
    WHERE i.id = ?
  `).bind(itemId).first();

  return json({
    ok: true,
    item: {
      ...updatedItem,
      barcodes: JSON.parse(updatedItem?.barcodes_json || '[]').filter(Boolean),
    },
  });
}

export async function adjustInventory(request, env) {
  const body = await parseBody(request);
  const qty = Number.parseInt(body?.quantity, 10);
  if (Number.isNaN(qty) || qty <= 0) return badRequest('quantity must be greater than 0');

  const item = await resolveItem(env.DB, { itemId: body.itemId, code: body.code?.trim() });
  if (!item) return badRequest('Item not found', 404);

  const stationId = body.stationId ? Number.parseInt(body.stationId, 10) : null;
  const mode = body.mode;
  const performedBy = (body.performedBy || '').trim();
  if (!['restock', 'issue'].includes(mode)) return badRequest('mode must be restock or issue');
  if (mode === 'issue' && !stationId) return badRequest('stationId is required when issuing inventory');
  if (!performedBy) return badRequest('performedBy is required');

   const unitCost = body.unitCost === '' || body.unitCost == null ? null : Number.parseFloat(body.unitCost);
  if (unitCost !== null && (Number.isNaN(unitCost) || unitCost < 0)) {
    return badRequest('unitCost must be a positive number or 0');
  }

  const performedAtRaw = String(body.performedAt || '').trim();
  const performedAt = performedAtRaw ? performedAtRaw.replace('T', ' ') : null;

  const newBarcode = String(body.newBarcode || '').trim();
  const skipBarcodeCapture = String(body.skipBarcodeCapture || 'true') === 'true';

  const delta = mode === 'restock' ? qty : -qty;

  if (item.total_quantity + delta < 0) {
    return badRequest(`Not enough inventory for ${item.name}.`, 409);
  }

  if (stationId) {
    await ensureStationRow(env.DB, stationId, item.id);
  }

  try {
    const operations = [
      env.DB.prepare(`
        UPDATE items
        SET total_quantity = total_quantity + ?,
            unit_cost = COALESCE(?, unit_cost),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
     `).bind(delta, unitCost, item.id),
      ...(stationId
        ? [env.DB.prepare(`
            UPDATE station_inventory
            SET quantity = quantity + ?
            WHERE station_id = ? AND item_id = ?
          `).bind(Math.abs(delta), stationId, item.id)]
        : []),
      env.DB.prepare(`
        INSERT INTO stock_transactions (item_id, station_id, quantity_delta, action_type, source, note, performed_by, created_at)
        VALUES (?, ?, ?, ?, ?, NULLIF(?, ''), ?, COALESCE(NULLIF(?, ''), CURRENT_TIMESTAMP))
      `).bind(
        item.id,
        stationId,
        delta,
        mode,
        body.source === 'scan' ? 'scan' : 'manual',
        body.note ?? '',
        performedBy,
        performedAt || ''
      ),
     ];

    if (mode === 'restock' && !skipBarcodeCapture && newBarcode) {
      operations.push(env.DB.prepare(`
        INSERT INTO item_barcodes (item_id, barcode)
        VALUES (?, ?)
        ON CONFLICT(barcode) DO NOTHING
      `).bind(item.id, newBarcode));
      operations.push(env.DB.prepare(`
        UPDATE items
        SET barcode = COALESCE(barcode, ?)
        WHERE id = ?
      `).bind(newBarcode, item.id));
    }

    await env.DB.batch(operations);
  } catch (error) {
    await logServerError(env, request, error, {
      category: 'inventory_adjust_failure',
      statusCode: 500,
      details: { itemId: item.id, mode, stationId, quantity: qty },
    });
    return badRequest(error.message.includes('UNIQUE') ? 'Barcode already belongs to another item.' : error.message, 500);
  }

  const updatedItem = await env.DB.prepare('SELECT * FROM items WHERE id = ?').bind(item.id).first();

  return json({
    ok: true,
    item: updatedItem,
    previousTotalQuantity: item.total_quantity,
    newTotalQuantity: updatedItem?.total_quantity,
  });
}

export async function lookupScan(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code')?.trim();
  if (!code) return badRequest('code query parameter is required');

  const item = await resolveItem(env.DB, { code });
  if (!item) return badRequest('No item matches that code.', 404);
  return json({ item });
}

export async function getAnalytics(request, env) {
  const url = new URL(request.url);
  const days = Math.min(Math.max(Number.parseInt(url.searchParams.get('days') || '30', 10), 7), 365);
  const stationId = Number.parseInt(url.searchParams.get('stationId') || '', 10);
  const itemId = Number.parseInt(url.searchParams.get('itemId') || '', 10);
  const search = (url.searchParams.get('search') || '').trim().toLowerCase();
  const startDate = (url.searchParams.get('startDate') || '').trim();
  const endDate = (url.searchParams.get('endDate') || '').trim();
  const hasDateRange = Boolean(startDate || endDate);
  const lookbackDays = `-${days} days`;

  const [byItem, byStation, trend, transactions] = await Promise.all([
    env.DB.prepare(`
      SELECT i.name, i.sku,
        SUM(CASE WHEN t.quantity_delta < 0 THEN ABS(t.quantity_delta) ELSE 0 END) AS used_qty,
        ROUND(SUM(CASE WHEN t.quantity_delta < 0 THEN ABS(t.quantity_delta) * i.unit_cost ELSE 0 END), 2) AS used_cost
       FROM stock_transactions t
      JOIN items i ON i.id = t.item_id
      LEFT JOIN stations s ON s.id = t.station_id
      WHERE t.quantity_delta < 0
        AND (
          (? = 0 AND date(t.created_at) >= date('now', ?))
          OR (? = 1 AND (? = '' OR date(t.created_at) >= date(?)) AND (? = '' OR date(t.created_at) <= date(?)))
        )
        AND (? = 0 OR t.station_id = ?)
        AND (? = 0 OR i.id = ?)
        AND (? = '' OR lower(i.name) LIKE ? OR lower(i.sku) LIKE ? OR lower(COALESCE(s.name, '')) LIKE ?)
      GROUP BY i.id
      ORDER BY used_qty DESC, i.name COLLATE NOCASE ASC
    `).bind(
      hasDateRange ? 1 : 0,
      lookbackDays,
      hasDateRange ? 1 : 0,
      startDate,
      startDate,
      endDate,
      endDate,
      Number.isInteger(stationId) && stationId > 0 ? stationId : 0,
      Number.isInteger(stationId) && stationId > 0 ? stationId : 0,
      Number.isInteger(itemId) && itemId > 0 ? itemId : 0,
      Number.isInteger(itemId) && itemId > 0 ? itemId : 0,
      search,
      `%${search}%`,
      `%${search}%`,
      `%${search}%`,
    ).all(),
    env.DB.prepare(`
      SELECT COALESCE(s.name, 'Unassigned') AS station_name,
        SUM(CASE WHEN t.quantity_delta < 0 THEN ABS(t.quantity_delta) ELSE 0 END) AS used_qty,
        ROUND(SUM(CASE WHEN t.quantity_delta < 0 THEN ABS(t.quantity_delta) * i.unit_cost ELSE 0 END), 2) AS used_cost
      FROM stock_transactions t
      JOIN items i ON i.id = t.item_id
      LEFT JOIN stations s ON s.id = t.station_id
      WHERE t.quantity_delta < 0
        AND (
          (? = 0 AND date(t.created_at) >= date('now', ?))
          OR (? = 1 AND (? = '' OR date(t.created_at) >= date(?)) AND (? = '' OR date(t.created_at) <= date(?)))
        )
        AND (? = 0 OR t.station_id = ?)
        AND (? = 0 OR i.id = ?)
        AND (? = '' OR lower(i.name) LIKE ? OR lower(i.sku) LIKE ? OR lower(COALESCE(s.name, '')) LIKE ?)
      GROUP BY s.id
      ORDER BY used_cost DESC
    `).bind(
      hasDateRange ? 1 : 0,
      lookbackDays,
      hasDateRange ? 1 : 0,
      startDate,
      startDate,
      endDate,
      endDate,
      Number.isInteger(stationId) && stationId > 0 ? stationId : 0,
      Number.isInteger(stationId) && stationId > 0 ? stationId : 0,
      Number.isInteger(itemId) && itemId > 0 ? itemId : 0,
      Number.isInteger(itemId) && itemId > 0 ? itemId : 0,
      search,
      `%${search}%`,
      `%${search}%`,
      `%${search}%`,
    ).all(),
    env.DB.prepare(`
      SELECT date(t.created_at) AS day,
        SUM(CASE WHEN t.quantity_delta < 0 THEN ABS(t.quantity_delta) ELSE 0 END) AS used_qty,
        ROUND(SUM(CASE WHEN t.quantity_delta < 0 THEN ABS(t.quantity_delta) * i.unit_cost ELSE 0 END), 2) AS used_cost
      FROM stock_transactions t
      JOIN items i ON i.id = t.item_id
       LEFT JOIN stations s ON s.id = t.station_id
      WHERE t.quantity_delta < 0
        AND (
          (? = 0 AND date(t.created_at) >= date('now', ?))
          OR (? = 1 AND (? = '' OR date(t.created_at) >= date(?)) AND (? = '' OR date(t.created_at) <= date(?)))
        )
        AND (? = 0 OR t.station_id = ?)
        AND (? = 0 OR i.id = ?)
        AND (? = '' OR lower(i.name) LIKE ? OR lower(i.sku) LIKE ? OR lower(COALESCE(s.name, '')) LIKE ?)
      GROUP BY date(t.created_at)
      ORDER BY day ASC
    `).bind(
      hasDateRange ? 1 : 0,
      lookbackDays,
      hasDateRange ? 1 : 0,
      startDate,
      startDate,
      endDate,
      endDate,
      Number.isInteger(stationId) && stationId > 0 ? stationId : 0,
      Number.isInteger(stationId) && stationId > 0 ? stationId : 0,
      Number.isInteger(itemId) && itemId > 0 ? itemId : 0,
      Number.isInteger(itemId) && itemId > 0 ? itemId : 0,
      search,
      `%${search}%`,
      `%${search}%`,
      `%${search}%`,
    ).all(),
    env.DB.prepare(`
      SELECT
        t.created_at,
        COALESCE(s.name, 'Unassigned') AS station_name,
        i.name AS item_name,
        i.sku AS item_sku,
        ABS(t.quantity_delta) AS used_qty,
        ROUND(i.unit_cost, 2) AS unit_cost,
        ROUND(ABS(t.quantity_delta) * i.unit_cost, 2) AS used_cost,
        t.performed_by,
        t.source
      FROM stock_transactions t
      JOIN items i ON i.id = t.item_id
      LEFT JOIN stations s ON s.id = t.station_id
      WHERE t.quantity_delta < 0
        AND (
          (? = 0 AND date(t.created_at) >= date('now', ?))
          OR (? = 1 AND (? = '' OR date(t.created_at) >= date(?)) AND (? = '' OR date(t.created_at) <= date(?)))
        )
        AND (? = 0 OR t.station_id = ?)
        AND (? = 0 OR i.id = ?)
        AND (? = '' OR lower(i.name) LIKE ? OR lower(i.sku) LIKE ? OR lower(COALESCE(s.name, '')) LIKE ?)
      ORDER BY t.created_at DESC, t.id DESC
    `).bind(
      hasDateRange ? 1 : 0,
      lookbackDays,
      hasDateRange ? 1 : 0,
      startDate,
      startDate,
      endDate,
      endDate,
      Number.isInteger(stationId) && stationId > 0 ? stationId : 0,
      Number.isInteger(stationId) && stationId > 0 ? stationId : 0,
      Number.isInteger(itemId) && itemId > 0 ? itemId : 0,
      Number.isInteger(itemId) && itemId > 0 ? itemId : 0,
      search,
      `%${search}%`,
      `%${search}%`,
      `%${search}%`,
    ).all(),
  ]);

  return json({
    byItem: byItem.results,
    byStation: byStation.results,
    trend: trend.results,
    transactions: transactions.results,
    days,
    filters: {
      stationId: Number.isInteger(stationId) && stationId > 0 ? stationId : null,
      itemId: Number.isInteger(itemId) && itemId > 0 ? itemId : null,
      search,
      startDate: startDate || null,
      endDate: endDate || null,
      mode: hasDateRange ? 'date-range' : 'days',
    },
  });
}

async function isAuthorizedAdmin(request, env) {
  const configuredKey = env.ADMIN_KEY;
  if (configuredKey && request.headers.get('x-admin-key') === configuredKey) return true;
  const auth = await getAuthContext(request, env);
  if (auth?.user?.isAdmin) return true;
  const userCountRow = await env.DB.prepare('SELECT COUNT(*) AS count FROM app_users').first();
  if (Number(userCountRow?.count || 0) === 0) return true;
  return !configuredKey ? Boolean(auth?.user?.isAdmin) : false;
}

export async function getCurrentSession(request, env) {
  const auth = await getAuthContext(request, env);
  if (!auth) return badRequest('Login required', 401);
  return json({
    user: auth.user,
    pages: getAssignablePages(),
  });
}

export async function loginWithBadge(request, env) {
  const body = await parseBody(request);
  const badgeCode = normalizeBadgeCode(body?.badgeCode || body?.badge_code || '');
  const pin = String(body?.pin || '').trim();

  if (!badgeCode) return badRequest('badgeCode is required');
  if (!validatePin(pin)) return badRequest('Enter a 4-digit PIN.');

  const user = await env.DB.prepare(`
    SELECT *
    FROM app_users
    WHERE badge_code = ?
    LIMIT 1
  `).bind(badgeCode).first();

  if (!user) return badRequest('Badge or PIN is not correct.', 401);

  const pinHash = await hashPin(pin, user.pin_salt);
  if (pinHash !== user.pin_hash) return badRequest('Badge or PIN is not correct.', 401);

  const sessionToken = createSessionToken();
  const expiresAt = new Date(Date.now() + (SESSION_DURATION_DAYS * 24 * 60 * 60 * 1000));
  await env.DB.prepare(`
    INSERT INTO auth_sessions (user_id, session_token, expires_at)
    VALUES (?, ?, ?)
  `).bind(user.id, sessionToken, expiresAt.toISOString()).run();

  return json({
    ok: true,
    user: await buildUserResponse(env.DB, user),
    pages: getAssignablePages(),
  }, {
    headers: {
      'Set-Cookie': createSessionCookie(sessionToken, expiresAt, { insecure: request.url.startsWith('http://') }),
    },
  });
}

export async function logoutCurrentSession(request, env) {
  const auth = await getAuthContext(request, env);
  if (auth?.sessionToken) {
    await env.DB.prepare('DELETE FROM auth_sessions WHERE session_token = ?').bind(auth.sessionToken).run();
  }
  return json({ ok: true }, {
    headers: {
      'Set-Cookie': clearSessionCookie({ insecure: request.url.startsWith('http://') }),
    },
  });
}

export async function changeOwnPin(request, env) {
  const auth = await getAuthContext(request, env);
  if (!auth?.user) return badRequest('Login required', 401);

  const body = await parseBody(request);
  const currentPin = String(body?.currentPin || '').trim();
  const nextPin = String(body?.newPin || '').trim();

  if (!validatePin(nextPin)) return badRequest('New PIN must be exactly 4 digits.');

  const user = await env.DB.prepare('SELECT id, pin_hash, pin_salt FROM app_users WHERE id = ?').bind(auth.user.id).first();
  if (!user) return badRequest('User not found', 404);

  const currentHash = await hashPin(currentPin, user.pin_salt);
  if (currentHash !== user.pin_hash) return badRequest('Current PIN is not correct.', 401);

  const nextSalt = createSalt();
  const nextHash = await hashPin(nextPin, nextSalt);
  await env.DB.prepare(`
    UPDATE app_users
    SET pin_hash = ?,
        pin_salt = ?,
        pin_reset_required = 0,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(nextHash, nextSalt, auth.user.id).run();

  const updated = await env.DB.prepare(`
    SELECT id, username, display_name, badge_code, is_admin, pin_reset_required
    FROM app_users
    WHERE id = ?
  `).bind(auth.user.id).first();

  return json({
    ok: true,
    user: await buildUserResponse(env.DB, updated),
  });
}

export async function getAdminUsers(request, env) {
  if (!(await isAuthorizedAdmin(request, env))) return badRequest('Unauthorized', 401);

  const usersRes = await env.DB.prepare(`
    SELECT
      id,
      username,
      display_name,
      badge_code,
      is_admin,
      pin_reset_required,
      created_at,
      updated_at
    FROM app_users
    ORDER BY lower(display_name) ASC, lower(username) ASC
  `).all();

  const users = [];
  for (const row of usersRes.results || []) {
    users.push(await buildUserResponse(env.DB, row));
  }

  return json({
    users,
    pages: getAssignablePages(),
  });
}

export async function createAdminUser(request, env) {
  if (!(await isAuthorizedAdmin(request, env))) return badRequest('Unauthorized', 401);

  const body = await parseBody(request);
  const username = normalizeUsername(body?.username);
  const displayName = String(body?.displayName || '').trim();
  const badgeCode = normalizeBadgeCode(body?.badgeCode);
  const pin = String(body?.pin || '').trim();
  const isAdmin = normalizeBoolean(body?.isAdmin);
  const assignedPageKeys = normalizeAssignedPageKeys(body?.pageKeys);

  if (!username) return badRequest('username is required');
  if (!displayName) return badRequest('displayName is required');
  if (!badgeCode) return badRequest('badgeCode is required');
  if (!validatePin(pin)) return badRequest('PIN must be exactly 4 digits.');
  if (!isAdmin && !assignedPageKeys.length) return badRequest('Assign at least one page or mark the user as admin.');

  const pinSalt = createSalt();
  const pinHash = await hashPin(pin, pinSalt);

  try {
    const created = await env.DB.prepare(`
      INSERT INTO app_users (username, display_name, badge_code, pin_hash, pin_salt, is_admin, pin_reset_required, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
      RETURNING id, username, display_name, badge_code, is_admin, pin_reset_required
    `).bind(username, displayName, badgeCode, pinHash, pinSalt, isAdmin ? 1 : 0).first();

    if (assignedPageKeys.length) {
      await env.DB.batch(assignedPageKeys.map((pageKey) => env.DB.prepare(`
        INSERT INTO user_page_assignments (user_id, page_key)
        VALUES (?, ?)
      `).bind(created.id, pageKey)));
    }

    return json({
      ok: true,
      user: await buildUserResponse(env.DB, created),
    }, { status: 201 });
  } catch (error) {
    return badRequest(error.message.includes('UNIQUE') ? 'Username and badge code must be unique.' : error.message);
  }
}

export async function updateAdminUser(request, env) {
  if (!(await isAuthorizedAdmin(request, env))) return badRequest('Unauthorized', 401);

  const body = await parseBody(request);
  const userId = Number.parseInt(body?.userId, 10);
  if (!Number.isInteger(userId) || userId <= 0) return badRequest('userId is required');

  const existing = await env.DB.prepare('SELECT * FROM app_users WHERE id = ?').bind(userId).first();
  if (!existing) return badRequest('User not found', 404);

  const username = normalizeUsername(body?.username || existing.username);
  const displayName = String(body?.displayName ?? existing.display_name).trim();
  const badgeCode = normalizeBadgeCode(body?.badgeCode ?? existing.badge_code);
  const isAdmin = normalizeBoolean(body?.isAdmin ?? existing.is_admin);
  const assignedPageKeys = normalizeAssignedPageKeys(body?.pageKeys);

  if (!username) return badRequest('username is required');
  if (!displayName) return badRequest('displayName is required');
  if (!badgeCode) return badRequest('badgeCode is required');
  if (!isAdmin && !assignedPageKeys.length) return badRequest('Assign at least one page or mark the user as admin.');

  try {
    await env.DB.prepare(`
      UPDATE app_users
      SET username = ?,
          display_name = ?,
          badge_code = ?,
          is_admin = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(username, displayName, badgeCode, isAdmin ? 1 : 0, userId).run();

    await env.DB.batch([
      env.DB.prepare('DELETE FROM user_page_assignments WHERE user_id = ?').bind(userId),
      ...assignedPageKeys.map((pageKey) => env.DB.prepare(`
        INSERT INTO user_page_assignments (user_id, page_key)
        VALUES (?, ?)
      `).bind(userId, pageKey)),
    ]);

    const updated = await env.DB.prepare(`
      SELECT id, username, display_name, badge_code, is_admin, pin_reset_required
      FROM app_users
      WHERE id = ?
    `).bind(userId).first();

    return json({
      ok: true,
      user: await buildUserResponse(env.DB, updated),
    });
  } catch (error) {
    return badRequest(error.message.includes('UNIQUE') ? 'Username and badge code must be unique.' : error.message);
  }
}

export async function resetAdminUserPin(request, env) {
  if (!(await isAuthorizedAdmin(request, env))) return badRequest('Unauthorized', 401);

  const body = await parseBody(request);
  const userId = Number.parseInt(body?.userId, 10);
  const newPin = String(body?.newPin || '').trim();

  if (!Number.isInteger(userId) || userId <= 0) return badRequest('userId is required');
  if (!validatePin(newPin)) return badRequest('New PIN must be exactly 4 digits.');

  const existing = await env.DB.prepare('SELECT id FROM app_users WHERE id = ?').bind(userId).first();
  if (!existing) return badRequest('User not found', 404);

  const pinSalt = createSalt();
  const pinHash = await hashPin(newPin, pinSalt);
  await env.DB.prepare(`
    UPDATE app_users
    SET pin_hash = ?,
        pin_salt = ?,
        pin_reset_required = 1,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(pinHash, pinSalt, userId).run();

  return json({ ok: true, userId });
}

export async function getAdminSettings(request, env) {
  if (!(await isAuthorizedAdmin(request, env))) return badRequest('Unauthorized', 401);
  return json(await getSettings(env.DB));
}

export async function getAdminStations(request, env) {
  if (!(await isAuthorizedAdmin(request, env))) return badRequest('Unauthorized', 401);

  const stationsRes = await env.DB.prepare(`
    SELECT id, name, code
    FROM stations
    ORDER BY lower(name) ASC, id ASC
  `).all();

  return json({
    stations: stationsRes.results || [],
  });
}

export async function getAdminErrors(request, env) {
  if (!(await isAuthorizedAdmin(request, env))) return badRequest('Unauthorized', 401);

  const limit = Math.min(Math.max(Number.parseInt(new URL(request.url).searchParams.get('limit') || '25', 10), 1), 100);
  const [recentRes, summaryRes] = await Promise.all([
    env.DB.prepare(`
      SELECT id, source, category, message, stack, path, method, page, status_code, details_json, created_at
      FROM error_events
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).bind(limit).all(),
    env.DB.prepare(`
      SELECT
        COUNT(*) AS total_count,
        SUM(CASE WHEN datetime(created_at) >= datetime('now', '-1 day') THEN 1 ELSE 0 END) AS last_24h_count,
        SUM(CASE WHEN datetime(created_at) >= datetime('now', '-7 days') THEN 1 ELSE 0 END) AS last_7d_count,
        SUM(CASE WHEN source = 'client' THEN 1 ELSE 0 END) AS client_count,
        SUM(CASE WHEN source = 'server' THEN 1 ELSE 0 END) AS server_count
      FROM error_events
    `).all(),
  ]);

  return json({
    summary: summaryRes.results?.[0] || {
      total_count: 0,
      last_24h_count: 0,
      last_7d_count: 0,
      client_count: 0,
      server_count: 0,
    },
    errors: (recentRes.results || []).map((entry) => {
      let details = null;
      try {
        details = entry.details_json ? JSON.parse(entry.details_json) : null;
      } catch {
        details = null;
      }
      return {
        ...entry,
        details,
      };
    }),
  });
}

export async function updateAdminSettings(request, env) {
  if (!(await isAuthorizedAdmin(request, env))) return badRequest('Unauthorized', 401);
  const body = await parseBody(request);
  const supplyOfficerEmail = (body?.supplyOfficerEmail || '').trim();
  const adminEmails = (body?.adminEmails || '').trim();

  await env.DB.prepare(`
    INSERT INTO admin_settings (id, supply_officer_email, admin_emails, updated_at)
    VALUES (1, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      supply_officer_email = excluded.supply_officer_email,
      admin_emails = excluded.admin_emails,
      updated_at = CURRENT_TIMESTAMP
  `).bind(supplyOfficerEmail, adminEmails).run();

  return json({ ok: true });
}

export async function createAdminStation(request, env) {
  if (!(await isAuthorizedAdmin(request, env))) return badRequest('Unauthorized', 401);

  const body = await parseBody(request);
  const name = String(body?.name || '').trim();
  const code = normalizeStationCode(body?.code);

  if (!name) return badRequest('Station name is required.');
  if (!code) return badRequest('Station code is required.');

  try {
    const station = await env.DB.prepare(`
      INSERT INTO stations (name, code)
      VALUES (?, ?)
      RETURNING id, name, code
    `).bind(name, code).first();

    return json({
      ok: true,
      station,
    }, { status: 201 });
  } catch (error) {
    return badRequest(error.message.includes('UNIQUE') ? 'Station name and code must be unique.' : error.message);
  }
}

export async function deleteAdminStation(request, env) {
  if (!(await isAuthorizedAdmin(request, env))) return badRequest('Unauthorized', 401);

  const body = await parseBody(request);
  const stationId = Number.parseInt(body?.stationId, 10);
  if (!Number.isInteger(stationId) || stationId <= 0) return badRequest('stationId is required');

  const station = await env.DB.prepare('SELECT id, name, code FROM stations WHERE id = ?').bind(stationId).first();
  if (!station) return badRequest('Station not found', 404);

  const [inventoryUsage, requestUsage, transactionUsage] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) AS count FROM station_inventory WHERE station_id = ?').bind(stationId).first(),
    env.DB.prepare('SELECT COUNT(*) AS count FROM station_requests WHERE station_id = ?').bind(stationId).first(),
    env.DB.prepare('SELECT COUNT(*) AS count FROM stock_transactions WHERE station_id = ?').bind(stationId).first(),
  ]);

  const totalReferences = Number(inventoryUsage?.count || 0) + Number(requestUsage?.count || 0) + Number(transactionUsage?.count || 0);
  if (totalReferences > 0) {
    return badRequest('This station already has inventory or request history and cannot be removed.');
  }

  await env.DB.prepare('DELETE FROM stations WHERE id = ?').bind(stationId).run();
  return json({ ok: true, stationId });
}

async function sendRequestEmail(env, to, subject, text) {
  if (!to || !env.RESEND_API_KEY || !env.SUPPLY_FROM_EMAIL) return { sent: false };

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: env.SUPPLY_FROM_EMAIL,
      to: [to],
      subject,
      text,
    }),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Email provider rejected request: ${message}`);
  }

  return { sent: true };
}

export async function createStationRequest(request, env) {
  const body = await parseBody(request);
  const stationCode = (body?.stationCode || '').trim();
  const requesterName = (body?.requesterName || '').trim();
  const requestedItems = Array.isArray(body?.items)
    ? normalizeRequestedItems(body.items)
    : [];
  const otherItems = normalizeOtherRequestedItems(body?.otherItems);

  if (!stationCode) return badRequest('stationCode is required');
  if (!requesterName) return badRequest('requesterName is required');
  if (!requestedItems.length && !otherItems.length) return badRequest('Provide at least one inventory request or other item notes.');

  const station = await env.DB.prepare('SELECT id, name, code FROM stations WHERE code = ?').bind(stationCode).first();
  if (!station) return badRequest('Invalid station', 404);

  const otherItemsJson = otherItems.length ? JSON.stringify(otherItems) : '';

  await env.DB.prepare(`
    INSERT INTO station_requests (station_id, requester_name, requested_items_json, other_items)
    VALUES (?, ?, ?, NULLIF(?, ''))
  `).bind(station.id, requesterName, JSON.stringify(requestedItems), otherItemsJson).run();

  const settings = await getSettings(env.DB);
  const lines = requestedItems.map((item) => `- ${item.name}: ${item.quantity}`).join('\n');
  const message = [
    `Station request submitted by ${requesterName}.`,
    `Station: ${station.name} (${station.code})`,
    '',
    'Requested inventory:',
    lines || '- None listed',
    '',
    `Other items: ${otherItems.length ? otherItems.map((item) => `${item.name} (${item.quantity}) for ${item.purpose}`).join('; ') : 'None'}`,
    `Submitted at: ${new Date().toISOString()}`,
  ].join('\n');

  try {
    await sendRequestEmail(env, settings.supply_officer_email, `Supply request: ${station.name}`, message);
  } catch (error) {
    await logServerError(env, request, error, {
      category: 'email_send_failure',
      statusCode: 502,
      details: { stationCode, requesterName, to: settings.supply_officer_email || '' },
    });
    return badRequest(error.message, 502);
  }

  return json({ ok: true, emailed: Boolean(settings.supply_officer_email && env.RESEND_API_KEY && env.SUPPLY_FROM_EMAIL) }, { status: 201 });
}

export async function completeStationRequests(request, env) {
  const body = await parseBody(request);
  const completedBy = String(body?.completedBy || '').trim();
  const stationId = body?.stationId ? Number.parseInt(body.stationId, 10) : null;
  const stationCode = String(body?.stationCode || '').trim();
  const requestIds = Array.isArray(body?.requestIds)
    ? body.requestIds.map((value) => Number.parseInt(value, 10)).filter((value) => Number.isInteger(value) && value > 0)
    : [];

  if (!completedBy) return badRequest('completedBy is required');

  let resolvedStationId = stationId;
  if (!resolvedStationId && stationCode) {
    const station = await env.DB.prepare('SELECT id FROM stations WHERE code = ?').bind(stationCode).first();
    if (!station) return badRequest('Invalid station', 404);
    resolvedStationId = Number(station.id);
  }

  if (!resolvedStationId && !requestIds.length) return badRequest('stationId, stationCode, or requestIds is required');

  if (requestIds.length) {
    const placeholders = requestIds.map(() => '?').join(', ');
    await env.DB.prepare(`
      UPDATE station_requests
      SET completed_by = ?, completed_at = CURRENT_TIMESTAMP
      WHERE id IN (${placeholders}) AND completed_at IS NULL AND canceled_at IS NULL
    `).bind(completedBy, ...requestIds).run();
    return json({ ok: true, completedBy, requestIds });
  }

  await env.DB.prepare(`
    UPDATE station_requests
    SET completed_by = ?, completed_at = CURRENT_TIMESTAMP
    WHERE station_id = ? AND completed_at IS NULL AND canceled_at IS NULL
  `).bind(completedBy, resolvedStationId).run();

  return json({ ok: true, stationId: resolvedStationId, completedBy });
}

export async function cancelStationRequest(request, env) {
  const body = await parseBody(request);
  const requestId = Number.parseInt(body?.requestId, 10);
  const canceledBy = String(body?.canceledBy || '').trim();
  const cancelReason = String(body?.cancelReason || '').trim();

  if (!Number.isInteger(requestId) || requestId <= 0) return badRequest('requestId is required');
  if (!canceledBy) return badRequest('canceledBy is required');
  if (!cancelReason) return badRequest('cancelReason is required');

  const existing = await env.DB.prepare(`
    SELECT id, completed_at, canceled_at
    FROM station_requests
    WHERE id = ?
  `).bind(requestId).first();
  if (!existing) return badRequest('Request not found', 404);
  if (existing.canceled_at) return badRequest('Request is already canceled');
  if (existing.completed_at) return badRequest('Completed requests cannot be canceled');

  await env.DB.prepare(`
    UPDATE station_requests
    SET canceled_by = ?,
        cancel_reason = ?,
        canceled_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(canceledBy, cancelReason, requestId).run();

  return json({ ok: true, requestId, canceledBy });
}

export async function modifyStationRequest(request, env) {
  const body = await parseBody(request);
  const requestId = Number.parseInt(body?.requestId, 10);
  const modifiedBy = String(body?.modifiedBy || '').trim();
  const modificationReason = String(body?.modificationReason || '').trim();
  const requestedItems = Array.isArray(body?.items)
    ? normalizeRequestedItems(body.items)
    : [];

  if (!Number.isInteger(requestId) || requestId <= 0) return badRequest('requestId is required');
  if (!modifiedBy) return badRequest('modifiedBy is required');
  if (!modificationReason) return badRequest('modificationReason is required');
  if (!requestedItems.length) return badRequest('Provide at least one inventory item.');

  const existing = await env.DB.prepare(`
    SELECT id, completed_at, canceled_at
    FROM station_requests
    WHERE id = ?
  `).bind(requestId).first();
  if (!existing) return badRequest('Request not found', 404);
  if (existing.canceled_at) return badRequest('Canceled requests cannot be modified');
  if (existing.completed_at) return badRequest('Completed requests cannot be modified');

  await env.DB.prepare(`
    UPDATE station_requests
    SET requested_items_json = ?,
        modified_by = ?,
        modification_reason = ?,
        modified_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(JSON.stringify(requestedItems), modifiedBy, modificationReason, requestId).run();

  return json({ ok: true, requestId, modifiedBy });
}

export async function issueStationRequestItems(request, env) {
  const body = await parseBody(request);
  const issuedBy = String(body?.issuedBy || '').trim();
  const issueItems = Array.isArray(body?.items)
    ? body.items
      .map((entry) => ({
        requestId: Number.parseInt(entry?.requestId, 10),
        itemId: Number.parseInt(entry?.itemId || 0, 10),
        itemName: String(entry?.itemName || '').trim(),
        quantity: Number.parseInt(entry?.quantity || 0, 10),
      }))
      .filter((entry) => Number.isInteger(entry.requestId) && entry.requestId > 0 && (entry.itemName || (Number.isInteger(entry.itemId) && entry.itemId > 0)) && entry.quantity > 0)
    : [];

  if (!issuedBy) return badRequest('issuedBy is required');
  if (!issueItems.length) return badRequest('Provide at least one issued item.');

  const groupedByRequest = issueItems.reduce((acc, entry) => {
    if (!acc[entry.requestId]) acc[entry.requestId] = [];
    acc[entry.requestId].push(entry);
    return acc;
  }, {});

  const completedRequestIds = [];
  for (const [requestIdRaw, entries] of Object.entries(groupedByRequest)) {
    const requestId = Number.parseInt(requestIdRaw, 10);
    const existing = await env.DB.prepare(`
      SELECT id, canceled_at, completed_at, requested_items_json, other_items
      FROM station_requests
      WHERE id = ?
    `).bind(requestId).first();
    if (!existing || existing.canceled_at || existing.completed_at) continue;

    const normalizedItems = normalizeRequestedItems(JSON.parse(existing.requested_items_json || '[]'));
    let parsedOtherItems = [];
    try {
      parsedOtherItems = JSON.parse(existing.other_items || '[]');
    } catch {
      parsedOtherItems = existing.other_items || '';
    }
    const normalizedOtherItems = normalizeOtherRequestedItems(parsedOtherItems);
    const updatesByName = entries.reduce((acc, entry) => {
      const key = entry.itemId > 0 ? `id:${entry.itemId}` : `name:${entry.itemName.toLowerCase()}`;
      acc[key] = (acc[key] || 0) + entry.quantity;
      return acc;
    }, {});

    const nextItems = normalizedItems.map((item) => {
      const key = item.itemId ? `id:${item.itemId}` : `name:${item.name.toLowerCase()}`;
      if (!updatesByName[key]) return item;
      return {
        ...item,
        issuedQuantity: Math.min(item.quantity, item.issuedQuantity + updatesByName[key]),
      };
    });

    const nextOtherItems = normalizedOtherItems.map((item) => {
      const key = `name:${item.name.toLowerCase()}`;
      if (!updatesByName[key]) return item;
      return {
        ...item,
        issuedQuantity: Math.min(item.quantity, item.issuedQuantity + updatesByName[key]),
      };
    });

    const hasAnyRequestedItems = (nextItems.length + nextOtherItems.length) > 0;
    const allIssued = hasAnyRequestedItems
      && [...nextItems, ...nextOtherItems].every((item) => item.issuedQuantity >= item.quantity);
    await env.DB.prepare(`
      UPDATE station_requests
      SET requested_items_json = ?,
          other_items = ?,
          modified_by = ?,
          modification_reason = 'Items issued from request queue',
          modified_at = CURRENT_TIMESTAMP,
          completed_by = CASE WHEN ? THEN ? ELSE completed_by END,
          completed_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE completed_at END
      WHERE id = ?
    `).bind(
      JSON.stringify(nextItems),
      JSON.stringify(nextOtherItems),
      issuedBy,
      allIssued ? 1 : 0,
      issuedBy,
      allIssued ? 1 : 0,
      requestId,
    ).run();

    if (allIssued) completedRequestIds.push(requestId);
  }

  return json({ ok: true, completedRequestIds });
}

export async function deleteItem(request, env) {
  const body = await parseBody(request);
  const itemId = Number.parseInt(body?.itemId, 10);
  const employeeOrDepartment = String(body?.employeeOrDepartment || '').trim();
  const performedBy = String(body?.performedBy || employeeOrDepartment).trim();
  const confirmed = String(body?.confirmed || '').toLowerCase() === 'true';

  if (!Number.isInteger(itemId) || itemId <= 0) return badRequest('itemId is required');
  if (!performedBy) return badRequest('performedBy is required');
  if (!employeeOrDepartment) return badRequest('employeeOrDepartment is required');
  if (!confirmed) return badRequest('Confirmation checkbox must be checked');

  const item = await env.DB.prepare('SELECT * FROM items WHERE id = ? AND deleted_at IS NULL').bind(itemId).first();
  if (!item) return badRequest('Item not found', 404);

  const note = `Item deleted from active inventory by ${performedBy} (${employeeOrDepartment}).`;
  const txDelta = -Math.max(0, Number.parseInt(item.total_quantity || 0, 10));

  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO stock_transactions (item_id, station_id, quantity_delta, action_type, source, note, performed_by, created_at)
      VALUES (?, NULL, ?, 'adjustment', 'manual', ?, ?, CURRENT_TIMESTAMP)
    `).bind(item.id, txDelta, note, performedBy),
    env.DB.prepare(`
      UPDATE items
      SET total_quantity = 0,
          deleted_at = CURRENT_TIMESTAMP,
          deleted_by = ?,
          deleted_by_identifier = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(performedBy, employeeOrDepartment, item.id),
  ]);

  return json({ ok: true, itemId: item.id, deletedAt: new Date().toISOString() });
}

export async function recordClientError(request, env) {
  const body = await parseBody(request);
  if (!body?.message) return badRequest('message is required');

  await logErrorEvent(env, {
    source: 'client',
    category: body.category || 'client_runtime',
    message: body.message,
    stack: body.stack || '',
    path: body.path || requestPathname(request),
    method: body.method || '',
    page: body.page || '',
    statusCode: body.statusCode,
    detailsJson: safeJson({
      userAgent: body.userAgent || '',
      context: body.context || {},
    }),
  });

  return json({ ok: true }, { status: 201 });
}

export { APP_PAGE_DEFINITIONS, APP_PATH_LOOKUP, badRequest, getAuthContext, getDefaultPagePath, json };
