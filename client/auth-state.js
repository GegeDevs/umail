export const PERMISSION_GROUPS = {
  mail: [
    'mail:view', 'mail:read', 'mail:send', 'mail:draft', 'mail:modify',
    'mail:archive', 'mail:delete', 'mail:spam', 'mail:labels',
    'mail:attachments', 'mail:search'
  ],
  accounts: [
    'accounts:view', 'accounts:view_email', 'accounts:add', 'accounts:remove',
    'accounts:refresh', 'accounts:color', 'accounts:set_default', 'accounts:signature'
  ],
  settings: ['settings:view', 'settings:edit', 'settings:database'],
  admin: [
    'admin:view_users', 'admin:manage_users', 'admin:edit_permissions',
    'admin:view_activity', 'admin:view_logs', 'admin:manage_api',
    'admin:view_api_docs'
  ]
};

let currentUser = null;

export function setCurrentUser(user) {
  currentUser = user;
}

export function getCurrentUser() {
  return currentUser;
}

export function hasPermission(permission) {
  if (!currentUser) return false;
  if (currentUser.role === 'master') return true;
  return currentUser.permissions.includes(permission);
}

export function hasPageAccess(page) {
  if (!currentUser) return false;
  if (currentUser.role === 'master') return true;
  const group = PERMISSION_GROUPS[page];
  return Boolean(group && group.some((permission) => currentUser.permissions.includes(permission)));
}

export function defaultLanding() {
  if (hasPageAccess('mail')) return '/';
  if (hasPageAccess('accounts')) return '/accounts';
  if (hasPageAccess('settings')) return '/settings';
  return '/';
}
