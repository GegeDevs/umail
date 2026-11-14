const routes = {};
let currentCleanup = null;

export function registerRoute(path, handler) {
  routes[path] = handler;
}

export function navigate(path) {
  if (window.location.hash === `#${path}`) return;
  window.location.hash = path;
}

export function getQueryParams() {
  const hash = window.location.hash.slice(1) || '/';
  return new URLSearchParams(hash.split('?')[1] || '');
}

export function getCurrentPath() {
  const hash = window.location.hash.slice(1) || '/';
  return hash.split('?')[0];
}

function matchRoute(path) {
  if (routes[path]) return { handler: routes[path], params: {} };
  const segments = path.split('/');
  for (const pattern of Object.keys(routes)) {
    if (!pattern.includes(':')) continue;
    const expected = pattern.split('/');
    if (expected.length !== segments.length) continue;
    const params = {};
    const matched = expected.every((part, index) => {
      if (part.startsWith(':')) {
        params[part.slice(1)] = decodeURIComponent(segments[index]);
        return true;
      }
      return part === segments[index];
    });
    if (matched) return { handler: routes[pattern], params };
  }
  return null;
}

export function initRouter() {
  window.addEventListener('hashchange', handleRoute);
  handleRoute();
}

function handleRoute() {
  const path = getCurrentPath();
  if (currentCleanup) {
    currentCleanup();
    currentCleanup = null;
  }
  const match = matchRoute(path) || matchRoute('/');
  if (!match) return;
  const cleanup = match.handler(match.params);
  if (typeof cleanup === 'function') currentCleanup = cleanup;
}
