import {
  APP_PATH_LOOKUP,
  addItem,
  adjustInventory,
  badRequest,
  bootstrapData,
  createAdminStation,
  changeOwnPin,
  createAdminUser,
  createStationRequest,
  completeStationRequests,
  cancelStationRequest,
  deleteAdminStation,
  issueStationRequestItems,
  deleteItem,
  getAdminUsers,
  getAdminErrors,
  getAdminSettings,
  getAdminStations,
  getAnalytics,
  getAuthContext,
  getCurrentSession,
  getDefaultPagePath,
  json,
  loginWithBadge,
  logServerError,
  logoutCurrentSession,
  lookupScan,
  recordClientError,
  resetAdminUserPin,
  updateItem,
  updateAdminUser,
  modifyStationRequest,
  updateAdminSettings,
} from './server.js';

const LEGACY_REQUEST_PATHS = new Set([
  '/request-ST01.html',
  '/request-ST02.html',
  '/request-ST03.html',
  '/request-ST04.html',
  '/request-ST05.html',
  '/request-ST06.html',
  '/request-ST07.html',
]);

function normalizePathname(pathname) {
  return pathname === '/' ? '/index.html' : pathname;
}

function isHtmlRequest(pathname) {
  return pathname === '/' || pathname.endsWith('.html');
}

function redirectTo(pathname, request) {
  return Response.redirect(new URL(pathname, request.url), 302);
}

async function guardHtmlRequest(request, env, pathname) {
  const normalizedPath = normalizePathname(pathname);
  const auth = await getAuthContext(request, env);

  if (normalizedPath === '/login.html') {
    if (auth?.user) return redirectTo(auth.user.defaultPath || getDefaultPagePath(auth.user.allowedPageKeys, auth.user.isAdmin), request);
    return null;
  }

  if (normalizedPath === '/admin.html') {
    return null;
  }

  if (!auth?.user) return redirectTo('/login.html', request);

  if (normalizedPath === '/index.html' || normalizedPath === '/account.html' || normalizedPath === '/how-to.html') {
    return null;
  }

  const page = APP_PATH_LOOKUP.get(normalizedPath);
  if (!page) return null;
  if (auth.user.isAdmin || auth.user.allowedPageKeys.includes(page.key)) return null;

  return redirectTo(auth.user.defaultPath || '/account.html', request);
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const pathname = normalizePathname(url.pathname);

      if (LEGACY_REQUEST_PATHS.has(pathname)) {
        return redirectTo('/request.html', request);
      }

      if (isHtmlRequest(url.pathname)) {
        const guardResponse = await guardHtmlRequest(request, env, pathname);
        if (guardResponse) return guardResponse;
      }

      const auth = await getAuthContext(request, env);
      const requireAuth = () => auth?.user ? null : badRequest('Login required', 401);

      if (pathname === '/api/auth/login' && request.method === 'POST') {
        return loginWithBadge(request, env);
      }

      if (pathname === '/api/auth/logout' && request.method === 'POST') {
        return logoutCurrentSession(request, env);
      }

      if (pathname === '/api/auth/me' && request.method === 'GET') {
        return getCurrentSession(request, env);
      }

      if (pathname === '/api/account/pin' && request.method === 'POST') {
        return requireAuth() || changeOwnPin(request, env);
      }

      if (pathname === '/api/bootstrap' && request.method === 'GET') {
        if (requireAuth()) return requireAuth();
        return json(await bootstrapData(env.DB));
      }

      if (pathname === '/api/analytics' && request.method === 'GET') {
        if (requireAuth()) return requireAuth();
        return getAnalytics(request, env);
      }

      if (pathname === '/api/errors' && request.method === 'POST') {
        return recordClientError(request, env);
      }

      if (pathname === '/api/items' && request.method === 'POST') {
        if (requireAuth()) return requireAuth();
        return addItem(request, env);
      }

      if (pathname === '/api/items' && request.method === 'PUT') {
        if (requireAuth()) return requireAuth();
        return updateItem(request, env);
      }

      if (pathname === '/api/items/delete' && request.method === 'POST') {
        if (requireAuth()) return requireAuth();
        return deleteItem(request, env);
      }

      if (pathname === '/api/inventory/adjust' && request.method === 'POST') {
        if (requireAuth()) return requireAuth();
        return adjustInventory(request, env);
      }

      if (pathname === '/api/scan' && request.method === 'GET') {
        if (requireAuth()) return requireAuth();
        return lookupScan(request, env);
      }

      if (pathname === '/api/requests' && request.method === 'POST') {
        if (requireAuth()) return requireAuth();
        return createStationRequest(request, env);
      }

      if (pathname === '/api/requests/complete' && request.method === 'POST') {
        if (requireAuth()) return requireAuth();
        return completeStationRequests(request, env);
      }

      if (pathname === '/api/requests/issue-items' && request.method === 'POST') {
        if (requireAuth()) return requireAuth();
        return issueStationRequestItems(request, env);
      }

      if (pathname === '/api/requests/cancel' && request.method === 'POST') {
        if (requireAuth()) return requireAuth();
        return cancelStationRequest(request, env);
      }

      if (pathname === '/api/requests/modify' && request.method === 'POST') {
        if (requireAuth()) return requireAuth();
        return modifyStationRequest(request, env);
      }

      if (pathname === '/api/admin/settings' && request.method === 'GET') {
        return getAdminSettings(request, env);
      }

      if (pathname === '/api/admin/settings' && request.method === 'POST') {
        return updateAdminSettings(request, env);
      }

      if (pathname === '/api/admin/errors' && request.method === 'GET') {
        return getAdminErrors(request, env);
      }

      if (pathname === '/api/admin/stations' && request.method === 'GET') {
        return getAdminStations(request, env);
      }

      if (pathname === '/api/admin/stations' && request.method === 'POST') {
        return createAdminStation(request, env);
      }

      if (pathname === '/api/admin/stations/delete' && request.method === 'POST') {
        return deleteAdminStation(request, env);
      }

      if (pathname === '/api/admin/users' && request.method === 'GET') {
        return getAdminUsers(request, env);
      }

      if (pathname === '/api/admin/users' && request.method === 'POST') {
        return createAdminUser(request, env);
      }

      if (pathname === '/api/admin/users' && request.method === 'PUT') {
        return updateAdminUser(request, env);
      }

      if (pathname === '/api/admin/users/reset-pin' && request.method === 'POST') {
        return resetAdminUserPin(request, env);
      }

      if (pathname.startsWith('/api/')) {
        return badRequest('Route not found', 404);
      }

      return env.ASSETS.fetch(request);
    } catch (error) {
      await logServerError(env, request, error, {
        category: 'worker_unhandled_exception',
        statusCode: 500,
      });
      return badRequest('An unexpected server error occurred.', 500);
    }
  },
};
