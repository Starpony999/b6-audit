import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, objectsFrom } from './gas-harness.js';

function setup() {
  const h = createHarness();
  h.context.B6_TEST_NOW = '2026-04-01T15:00:00.000Z';
  const admin = h.call({
    action: 'bootstrapAdmin',
    name: 'Cassidy',
    email: 'cassidy@example.com',
    password: 'correct-horse',
    passwordConfirm: 'correct-horse',
    bootstrapSecret: 'setup-phrase-for-tests-only',
  });
  assert.equal(admin.ok, true, admin.message);
  ['Brian', 'brian@example.com', 'RANCH', 'Carter', 'carter@example.com', 'SPZ'].forEach((_, i, all) => {
    if (i % 3 !== 0) return;
    const added = h.call({
      action: 'addUser',
      token: admin.token,
      name: all[i],
      email: all[i + 1],
      role: 'manager',
      store: all[i + 2],
      password: 'shared-secret',
      mustChangePassword: false,
    });
    assert.equal(added.ok, true, added.message);
  });
  const template = h.call({
    action: 'createTemplate', token: admin.token, name: 'Ranch walk', appliesTo: 'RANCH',
  });
  const question = h.call({
    action: 'addBuilderQuestion',
    token: admin.token,
    templateId: template.template.templateId,
    section: 'Lobby',
    text: 'Mats flat?',
    points: 9,
    type: 'yesno',
    fullPointsAnswer: 'yes',
    todoIfImperfect: 'Fix mats',
  });
  assert.equal(question.ok, true, question.message);
  const brian = h.call({ action: 'login', email: 'brian@example.com', password: 'shared-secret' });
  const carter = h.call({ action: 'login', email: 'carter@example.com', password: 'shared-secret' });
  assert.equal(brian.ok, true, brian.message);
  const audit = h.call({
    action: 'beginAudit',
    token: brian.token,
    templateId: template.template.templateId,
    store: 'CPR',
  });
  assert.equal(audit.ok, true, audit.message);
  return { h, admin, brian, carter, audit, questionId: question.question.questionId };
}

test('pause and resume round-trip keeps answers and hides scores', () => {
  const { h, brian, audit, questionId } = setup();
  const media = 'audits/' + audit.auditId + '/' + questionId + '/uploadkey1/photo.jpg';
  const paused = h.call({
    action: 'pauseAudit',
    token: brian.token,
    auditId: audit.auditId,
    sectionIndex: 1,
    answers: [{ questionId, answer: 'no', note: 'torn', mediaUrls: [media] }],
  });
  assert.equal(paused.ok, true, paused.message);
  assert.equal(paused.sectionIndex, 1);
  const again = h.call({
    action: 'pauseAudit',
    token: brian.token,
    auditId: audit.auditId,
    sectionIndex: 1,
    answers: [{ questionId, answer: 'no', note: 'still torn', mediaUrls: [media] }],
  });
  assert.equal(again.ok, true, again.message);
  assert.equal(objectsFrom(h.sheets.PausedAudits).length, 1);

  const resumed = h.call({ action: 'resumePausedAudit', token: brian.token, auditId: audit.auditId });
  assert.equal(resumed.ok, true, resumed.message);
  assert.equal(resumed.sectionIndex, 1);
  assert.equal(resumed.store, 'CPR');
  assert.equal(resumed.templateName, 'Ranch walk');
  assert.equal(resumed.questions[0].points, undefined);
  assert.equal(resumed.questions[0].fullPointsAnswer, undefined);
  assert.equal(JSON.stringify(resumed.questions).includes('Fix mats'), false);
  const saved = resumed.answers.find((item) => item.questionId === questionId);
  assert.equal(saved.answer, 'no');
  assert.equal(saved.note, 'still torn');
  assert.deepEqual(saved.mediaUrls, [media]);

  const submitted = h.call({
    action: 'submitAuditAnswers',
    token: brian.token,
    auditId: audit.auditId,
    answers: [{ questionId, answer: 'no', note: 'still torn', mediaUrls: [media] }],
  });
  assert.equal(submitted.ok, true, submitted.message);
  assert.equal(h.call({ action: 'listPausedAudits', token: brian.token }).paused.length, 0);
});

test('a non-starter who is not an admin cannot list, resume, or delete someone else’s pause', () => {
  const { h, admin, brian, carter, audit, questionId } = setup();
  const paused = h.call({
    action: 'pauseAudit',
    token: brian.token,
    auditId: audit.auditId,
    sectionIndex: 0,
    answers: [{ questionId, answer: 'yes', note: '' }],
  });
  assert.equal(paused.ok, true, paused.message);

  const listed = h.call({ action: 'listPausedAudits', token: carter.token });
  assert.equal(listed.ok, true, listed.message);
  assert.equal(listed.paused.length, 0);
  const wrongStore = h.call({ action: 'listPausedAudits', token: carter.token, store: 'CPR' });
  assert.equal(wrongStore.error, 'forbidden');

  const resume = h.call({ action: 'resumePausedAudit', token: carter.token, auditId: audit.auditId });
  assert.equal(resume.error, 'forbidden');
  const remove = h.call({ action: 'deletePausedAudit', token: carter.token, auditId: audit.auditId });
  assert.equal(remove.error, 'forbidden');
  assert.equal(objectsFrom(h.sheets.PausedAudits).length, 1);

  const adminList = h.call({ action: 'listPausedAudits', token: admin.token });
  assert.equal(adminList.paused.length, 1);
  assert.equal(adminList.paused[0].auditorEmail, 'brian@example.com');
  assert.equal(adminList.paused[0].auditorName, 'Brian');
  assert.ok(adminList.paused[0].updatedAt);

  const brianList = h.call({ action: 'listPausedAudits', token: brian.token, store: 'CPR' });
  assert.equal(brianList.paused.length, 1);
  const adminResume = h.call({ action: 'resumePausedAudit', token: admin.token, auditId: audit.auditId });
  assert.equal(adminResume.ok, true, adminResume.message);
});

test('losing store access blocks resume, and a pause older than 7 days is removed', () => {
  const { h, admin, brian, audit, questionId } = setup();
  assert.equal(h.call({
    action: 'pauseAudit',
    token: brian.token,
    auditId: audit.auditId,
    sectionIndex: 0,
    answers: [{ questionId, answer: 'no', note: 'x' }],
  }).ok, true);

  const users = h.sheets.Users._rows;
  const row = users.findIndex((cells) => cells[2] === 'brian@example.com');
  users[row][4] = 'SPZ';
  const blocked = h.call({ action: 'resumePausedAudit', token: brian.token, auditId: audit.auditId });
  assert.equal(blocked.error, 'forbidden');
  assert.match(blocked.message, /no longer covers/);
  assert.equal(h.call({ action: 'resumePausedAudit', token: admin.token, auditId: audit.auditId }).ok, true);

  users[row][4] = 'RANCH';
  h.context.B6_TEST_NOW = '2026-04-08T14:59:00.000Z';
  const brianLater = h.call({ action: 'login', email: 'brian@example.com', password: 'shared-secret' });
  assert.equal(brianLater.ok, true, brianLater.message);
  assert.equal(h.call({ action: 'listPausedAudits', token: brianLater.token }).paused.length, 1);

  h.context.B6_TEST_NOW = '2026-04-08T15:00:00.000Z';
  const gone = h.call({ action: 'listPausedAudits', token: brianLater.token });
  assert.equal(gone.paused.length, 0);
  assert.equal(h.sheets.PausedAudits._rows.length, 1);
  assert.equal(objectsFrom(h.sheets.Audits).some((item) => item.auditId === audit.auditId), false);
});

test('the daily reminder also discards a pause that is 7 days old', () => {
  const { h, brian, audit, questionId } = setup();
  h.call({
    action: 'pauseAudit',
    token: brian.token,
    auditId: audit.auditId,
    sectionIndex: 0,
    answers: [{ questionId, answer: 'yes', note: '' }],
  });
  h.context.B6_TEST_NOW = '2026-04-08T15:00:00.000Z';
  const result = h.context.sendTodoReminders();
  assert.equal(result.skipped, undefined);
  assert.equal(objectsFrom(h.sheets.PausedAudits).length, 0);
});
