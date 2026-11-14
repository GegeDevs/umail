import { test, expect } from 'bun:test';
import { hashPassword, verifyPassword } from '../src/services/password.js';

test('password hash verifies and rejects wrong password', async () => {
  const hash = await hashPassword('correct horse battery staple');
  expect(hash).toMatch(/^210000:[0-9a-f]{32}:[0-9a-f]{128}$/);
  expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
  expect(await verifyPassword('wrong', hash)).toBe(false);
});

test('legacy salt:hash format still verifies', async () => {
  const legacy = '0123456789abcdef0123456789abcdef:' + '0'.repeat(128);
  expect(await verifyPassword('wrong', legacy)).toBe(false);
});
