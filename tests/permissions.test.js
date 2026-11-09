import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './gas-harness.js';

function setup() {
  const h = createHarness();
  const admin = h.call({
    action: 'bootstrapAdmin',
    name: 'Cassidy',
    email: 'cassidy@example.com',
    password: 'correct-horse',
    passwordConfirm: 'correct-horse',
    bootstrapSecret: 'setup-phrase-for-tests-only',
  });
  assert.equal(admin.ok, true, admin.message);
  const brian = h.call({
    action: 'addUser',
    token: admin.token,
    name: 'Brian',
    email: 'brian@example.com',
    role: 'manager',
    store: 'RANCH',
    password: 'brian-stable',
    mustChangePassword: false,
  });
  assert.equal(brian.ok, true, brian.message);
  const login = h.call({ action: 'login', email: 'brian@example.com', password: 'brian-stable' });
  assert.equal(login.ok, true, login.message);
  return { h, admin, manager: login };
}

const ADMIN_ACTIONS = [
  ['getBuilderHome', {}],
  ['ensureSchema', {}],
  ['createTemplate', { name: 'Lobby', appliesTo: 'ALL' }],
  ['updateTemplateMeta', { templateId: 'x', name: 'Nope', appliesTo: 'ALL' }],
  ['listBuilderQuestions', { templateId: 'x' }],
  ['addBuilderQuestion', { templateId: 'x', section: 'A', text: 'B', points: 1, type: 'yesno' }],
  ['updateBuilderQuestion', { questionId: 'x', section: 'A', text: 'B', points: 1, type: 'yesno' }],
  ['saveAllBuilderTemplate', { templateId: 'x', meta: { name: 'N', appliesTo: 'ALL' }, questions: [] }],
  ['getPastDueReport', {}],
  ['listUsers', {}],
  ['addUser', { name: 'X', email: 'x@example.com', role: 'manager', store: 'ALL', password: 'long-password' }],
  ['resetUserPassword', { userId: 'nope' }],
  ['setUserActive', { userId: 'nope', active: false }],
];

test('non-admins cannot open or change the template builder, past due, or users', () => {
  const { h, manager } = setup();
  ADMIN_ACTIONS.forEach(([action, payload]) => {
    const result = h.call(Object.assign({ action, token: manager.token }, payload));
    assert.equal(result.ok, false, action + ' ' + result.message);
    assert.equal(result.error, 'forbidden', action + ' returned ' + result.error + ' ' + result.message);
  });
  assert.equal(h.sheets.Templates._rows.length, 1);
  assert.equal(h.sheets.Questions._rows.length, 1);
});

test('admin can open the builder and past due; a manager still cannot after a refresh', () => {
  const { h, admin, manager } = setup();
  const home = h.call({ action: 'getBuilderHome', token: admin.token });
  assert.equal(home.ok, true, home.message);
  assert.equal(home.access.ok, true);
  const report = h.call({ action: 'getPastDueReport', token: admin.token });
  assert.equal(report.ok, true, report.message);
  const users = h.call({ action: 'listUsers', token: admin.token });
  assert.equal(users.ok, true);
  assert.equal(users.users.some((u) => u.passwordHash), false);
  const again = h.call({ action: 'getBuilderHome', token: manager.token });
  assert.equal(again.error, 'forbidden');
  const past = h.call({ action: 'getPastDueReport', token: manager.token });
  assert.equal(past.error, 'forbidden');
});

test('a manager cannot audit or read files outside their store', () => {
  const { h, admin, manager } = setup();
  const created = h.call({
    action: 'createTemplate',
    token: admin.token,
    name: 'All stores',
    appliesTo: 'ALL',
  });
  const question = h.call({
    action: 'addBuilderQuestion',
    token: admin.token,
    templateId: created.template.templateId,
    section: 'Lobby',
    text: 'Mats down?',
    points: 5,
    type: 'yesno',
    fullPointsAnswer: 'yes',
  });
  assert.equal(question.ok, true, question.message);
  const denied = h.call({
    action: 'beginAudit',
    token: manager.token,
    templateId: created.template.templateId,
    store: 'WZ',
  });
  assert.equal(denied.error, 'forbidden');
  const started = h.call({
    action: 'beginAudit',
    token: admin.token,
    templateId: created.template.templateId,
    store: 'WZ',
  });
  assert.equal(started.ok, true, started.message);
  const key = 'audits/' + started.auditId + '/' + question.question.questionId + '/uploadkey1/photo.jpg';
  const read = h.call({ action: 'signMediaRead', token: manager.token, keys: [key] });
  assert.notEqual(read.error, undefined);
  assert.ok(read.error === 'forbidden' || read.error === 'media-not-configured');
  if (read.error === 'media-not-configured') {
    h.props.B2_KEY_ID = 'key-id';
    h.props.B2_APPLICATION_KEY = 'secret-app-key';
    h.props.B2_BUCKET = 'b6-audit-media';
    h.props.B2_ENDPOINT = 's3.us-west-004.backblazeb2.com';
    h.props.B2_REGION = 'us-west-004';
    const read2 = h.call({ action: 'signMediaRead', token: manager.token, keys: [key] });
    assert.equal(read2.error, 'forbidden');
  }
});
