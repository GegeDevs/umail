import { test, expect } from 'bun:test';
import { hasPageAccess, PERMISSION_GROUPS, ALL_PERMISSIONS, DEFAULT_SLAVE_PERMISSIONS } from '../src/middleware/auth.js';

test('page access needs at least one permission in group', () => {
  expect(hasPageAccess(['mail:read'], 'mail')).toBe(true);
  expect(hasPageAccess(['accounts:view'], 'mail')).toBe(false);
  expect(hasPageAccess([], 'settings')).toBe(false);
});

test('permission catalog contains defaults and no duplicates', () => {
  expect(ALL_PERMISSIONS.length).toBe(new Set(ALL_PERMISSIONS).size);
  for (const permission of DEFAULT_SLAVE_PERMISSIONS) expect(ALL_PERMISSIONS).toContain(permission);
  expect(Object.keys(PERMISSION_GROUPS)).toEqual(['mail', 'accounts', 'settings', 'admin']);
});
