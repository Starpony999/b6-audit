import crypto from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHarness, objectsFrom } from './gas-harness.js';

function boot(h, extra) {
  return h.call(Object.assign({
    action: 'bootstrapAdmin',
    name: 'Cassidy',
    email: 'cassidy@example.com',
    password: 'correct-horse',
    passwordConfirm: 'correct-horse',
    bootstrapSecret: 'setup-phrase-for-tests-only',
    store: 'ALL',
  }, extra || {}));
}

test('PBKDF2-HMAC-SHA256 matches Node at 5000 rounds and with unicode', () => {
  const h = createHarness();
  const salt = Buffer.from('0123456789abcdef');
  assert.equal(salt.length, 16);
  const saltB64 = salt.toString('base64');
  const cases = [
    ['password', 1],
    ['password', 2],
    ['correct-horse', 5000],
    ['páßword-✓', 3],
  ];
  cases.forEach(([password, rounds]) => {
    const expected = crypto.pbkdf2Sync(password, salt, rounds, 32, 'sha256').toString('base64');
    const actual = h.context.hashPassword_(password, saltB64, rounds);
    assert.equal(actual, expected, password + ' @ ' + rounds);
  });
});

test('bootstrap refuses a missing or wrong phrase and does not invent a password', () => {
  const h = createHarness();
  delete h.props.BOOTSTRAP_SECRET;
  const off = boot(h);
  assert.equal(off.ok, false);
  assert.equal(off.error, 'bootstrap-off');
  assert.equal(objectsFrom(h.sheets.Users).length, 0);

  h.props.BOOTSTRAP_SECRET = 'setup-phrase-for-tests-only';
  const bad = boot(h, { bootstrapSecret: 'nope-not-it' });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'bad-login');
  assert.equal(objectsFrom(h.sheets.Users).length, 0);

  const source = fs.readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');
  assert.equal(/DEFAULT_PASSWORD\s*=/.test(source), false);
  assert.equal(source.includes('password123'), false);
  assert.equal(source.includes("password: 'admin'"), false);
});

test('bootstrap stores a salted hash, signs in, and will not run again', () => {
  const h = createHarness();
  const created = boot(h);
  assert.equal(created.ok, true);
  assert.ok(created.token);
  const row = objectsFrom(h.sheets.Users)[0];
  assert.equal(row.role, 'admin');
  assert.equal(row.email, 'cassidy@example.com');
  assert.ok(row.passwordHash);
  assert.ok(row.salt);
  assert.equal(row.passwordIterations, 200);
  assert.equal(JSON.stringify(row).includes('correct-horse'), false);
  assert.equal(row.passwordHash === 'correct-horse', false);

  const sessions = objectsFrom(h.sheets.Sessions);
  assert.equal(sessions.length, 1);
  assert.notEqual(sessions[0].tokenHash, created.token);
  assert.equal(sessions[0].tokenHash, h.context.sha256Hex_(created.token));
  assert.equal(JSON.stringify(h.sheets.Sessions._rows).includes(created.token), false);

  const again = boot(h);
  assert.equal(again.ok, false);
  assert.equal(again.error, 'bootstrap-closed');
  assert.equal(created.user.passwordHash, undefined);
  assert.equal(created.user.salt, undefined);
});

test('existing admin row gets a password without a second user or rewritten store', () => {
  const h = createHarness();
  h.sheets.Users.appendRow(['user-cass', 'Cassidy Hodgen', 'Cassidy@Example.com', 'admin', 'RANCH', true, 'keep-me']);
  const created = boot(h);
  assert.equal(created.ok, true);
  const rows = objectsFrom(h.sheets.Users);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].userId, 'user-cass');
  assert.equal(rows[0].store, 'RANCH');
  assert.equal(rows[0].role, 'admin');
  assert.ok(rows[0].passwordHash);
  assert.equal(String(rows[0].passwordHash).includes('correct-horse'), false);
});

test('login failure, lockout, expiry, and same message for an unknown email', () => {
  const h = createHarness();
  boot(h);
  const unknown = h.call({ action: 'login', email: 'nobody@example.com', password: 'correct-horse' });
  const wrong = h.call({ action: 'login', email: 'cassidy@example.com', password: 'not-the-password' });
  assert.equal(unknown.ok, false);
  assert.equal(wrong.ok, false);
  assert.equal(unknown.message, wrong.message);
  assert.equal(unknown.error, 'bad-login');

  for (let i = 0; i < 7; i += 1) {
    h.call({ action: 'login', email: 'cassidy@example.com', password: 'still-wrong' });
  }
  const locked = h.call({ action: 'login', email: 'cassidy@example.com', password: 'correct-horse' });
  assert.equal(locked.ok, false);
  assert.equal(locked.error, 'locked');
  const row = objectsFrom(h.sheets.Users)[0];
  assert.ok(row.lockedUntil);
  assert.equal(JSON.stringify(row).includes('correct-horse'), false);

  h.context.B6_TEST_NOW = '2026-04-01T15:20:00.000Z';
  const after = h.call({ action: 'login', email: 'cassidy@example.com', password: 'correct-horse' });
  assert.equal(after.ok, true, after.message);
  assert.equal(objectsFrom(h.sheets.Users)[0].failedLoginCount, 0);
});

test('session expiry, logout, inactive, and role are re-read from the sheet', () => {
  const h = createHarness();
  const created = boot(h);
  const token = created.token;
  const me = h.call({ action: 'me', token });
  assert.equal(me.user.role, 'admin');

  h.context.B6_TEST_NOW = '2026-04-02T04:00:00.000Z';
  const expired = h.call({ action: 'me', token });
  assert.equal(expired.error, 'session-expired');

  h.context.B6_TEST_NOW = '2026-04-01T15:00:00.000Z';
  const again = h.call({ action: 'login', email: 'cassidy@example.com', password: 'correct-horse' });
  const token2 = again.token;
  h.sheets.Users._rows[1][3] = 'manager';
  const demoted = h.call({ action: 'getPastDueReport', token: token2 });
  assert.equal(demoted.ok, false);
  assert.equal(demoted.error, 'forbidden');
  const stillIn = h.call({ action: 'me', token: token2 });
  assert.equal(stillIn.ok, true);
  assert.equal(stillIn.user.role, 'manager');

  h.sheets.Users._rows[1][5] = false;
  const inactive = h.call({ action: 'me', token: token2 });
  assert.equal(inactive.error, 'unauthorized');

  h.sheets.Users._rows[1][3] = 'admin';
  h.sheets.Users._rows[1][5] = true;
  const back = h.call({ action: 'login', email: 'cassidy@example.com', password: 'correct-horse' });
  const bye = h.call({ action: 'logout', token: back.token });
  assert.equal(bye.ok, true);
  const afterOut = h.call({ action: 'me', token: back.token });
  assert.equal(afterOut.error, 'unauthorized');
});

test('forced password change blocks admin actions until a new password is set', () => {
  const h = createHarness();
  const admin = boot(h);
  const added = h.call({
    action: 'addUser',
    token: admin.token,
    name: 'Brian',
    email: 'brian@example.com',
    role: 'manager',
    store: 'RANCH',
    password: 'brian-temp-1',
  });
  assert.equal(added.ok, true, added.message);
  assert.equal(added.user.mustChangePassword, true);
  assert.equal(added.user.passwordHash, undefined);
  const login = h.call({ action: 'login', email: 'brian@example.com', password: 'brian-temp-1' });
  assert.equal(login.ok, true);
  assert.equal(login.mustChangePassword, true);
  const blocked = h.call({ action: 'getPastDueReport', token: login.token });
  assert.equal(blocked.error, 'must-change-password');
  const changed = h.call({
    action: 'changeOwnPassword',
    token: login.token,
    currentPassword: 'brian-temp-1',
    newPassword: 'brian-stable',
    passwordConfirm: 'brian-stable',
  });
  assert.equal(changed.ok, true, changed.message);
  const todos = h.call({ action: 'listMyTodos', token: login.token });
  assert.equal(todos.ok, true);
  const stillBlocked = h.call({ action: 'listUsers', token: login.token });
  assert.equal(stillBlocked.error, 'forbidden');
});

test('admin reset returns a one-time password and clears a lock', () => {
  const h = createHarness();
  const admin = boot(h);
  h.call({
    action: 'addUser',
    token: admin.token,
    name: 'Pat',
    email: 'pat@example.com',
    role: 'gm',
    store: 'SPZ',
    password: 'pat-temp-11',
  });
  for (let i = 0; i < 8; i += 1) h.call({ action: 'login', email: 'pat@example.com', password: 'wrong-pass' });
  const pat = objectsFrom(h.sheets.Users).find((u) => u.email === 'pat@example.com');
  const reset = h.call({ action: 'resetUserPassword', token: admin.token, userId: pat.userId });
  assert.equal(reset.ok, true, reset.message);
  assert.ok(reset.temporaryPassword);
  assert.equal(reset.temporaryPassword.length >= 10, true);
  const sheetText = JSON.stringify(h.sheets.Users._rows);
  assert.equal(sheetText.includes(reset.temporaryPassword), false);
  const signed = h.call({ action: 'login', email: 'pat@example.com', password: reset.temporaryPassword });
  assert.equal(signed.ok, true, signed.message);
  assert.equal(signed.mustChangePassword, true);
});

test('Add missing columns does not rewrite existing cells', () => {
  const h = createHarness();
  h.sheets.Users.appendRow(['user-1', 'Keep This Name', 'keep@example.com', 'manager', 'WPR', true]);
  h.props.BOOTSTRAP_SECRET = 'setup-phrase-for-tests-only';
  const admin = boot(h, { email: 'new-admin@example.com' });
  assert.equal(admin.ok, true, admin.message);
  const before = h.sheets.Users._rows[1].slice();
  const result = h.call({ action: 'ensureSchema', token: admin.token });
  assert.equal(result.ok, true, result.message);
  const headers = h.sheets.Users._rows[0].map((cell) => String(cell));
  ['passwordHash', 'salt', 'passwordIterations', 'mustChangePassword', 'failedLoginCount', 'lockedUntil'].forEach((name) => {
    assert.ok(headers.includes(name), name);
  });
  assert.equal(h.sheets.Users._rows[1][1], 'Keep This Name');
  assert.equal(h.sheets.Users._rows[1][2], before[2]);
  assert.equal(h.sheets.Users._rows[1][4], 'WPR');
  const hashCol = headers.indexOf('passwordHash');
  assert.equal(h.sheets.Users._rows[1][hashCol] || '', '');
  assert.ok(h.sheets.Todos._rows[0].includes('assignmentNotifiedAt'));
  assert.ok(h.sheets.Sessions);
});
