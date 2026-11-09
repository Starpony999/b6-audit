import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, objectsFrom } from './gas-harness.js';

function adminHarness() {
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
  const add = (name, email, role, store) => {
    const res = h.call({
      action: 'addUser', token: admin.token, name, email, role, store,
      password: 'shared-secret', mustChangePassword: false,
    });
    assert.equal(res.ok, true, res.message);
  };
  add('Brian', 'brian@example.com', 'manager', 'RANCH');
  add('Carter', 'carter@example.com', 'gm', 'SPZ');
  add('Nina', 'nina@example.com', 'manager', 'ALL');
  return { h, admin };
}

test('yes/no full-points side and multiple choice scoring', () => {
  const h = createHarness();
  assert.equal(h.context.scoreYesNo_({ points: 5, fullPointsAnswer: 'yes' }, 'yes'), 5);
  assert.equal(h.context.scoreYesNo_({ points: 5, fullPointsAnswer: 'yes' }, 'no'), 0);
  assert.equal(h.context.scoreYesNo_({ points: 5, fullPointsAnswer: '' }, 'Yes'), 5);
  assert.equal(h.context.scoreYesNo_({ points: 4, fullPointsAnswer: 'no' }, 'no'), 4);
  assert.equal(h.context.scoreYesNo_({ points: 4, fullPointsAnswer: 'no' }, 'yes'), 0);
  const parsed = h.context.validateMultipleOptions_('Good:5|Fair:3|Poor:0');
  assert.equal(parsed.map.Good, 5);
  assert.equal(parsed.map.Poor, 0);
  assert.throws(() => h.context.validateMultipleOptions_('OnlyOne:1'), /at least two/);
});

test('applies-to and user store scopes', () => {
  const h = createHarness();
  assert.equal(h.context.normalizeAppliesToValue_(''), 'ALL');
  assert.equal(h.context.normalizeAppliesToValue_('ranch'), 'RANCH');
  assert.equal(h.context.normalizeAppliesToValue_('wpr,cpr,wz,spz'), 'ALL');
  assert.equal(h.context.templateAppliesToStore_({ appliesTo: 'RANCH' }, 'CPR'), true);
  assert.equal(h.context.templateAppliesToStore_({ appliesTo: 'RANCH' }, 'WZ'), false);
  assert.equal(h.context.templateAppliesToStore_({ appliesTo: 'ZIGGIS' }, 'SPZ'), true);
  assert.equal(h.context.templateAppliesToStore_({ appliesTo: 'WPR,SPZ' }, 'SPZ'), true);
  assert.equal(h.context.templateAppliesToStore_({ appliesTo: 'WPR,SPZ' }, 'CPR'), false);
  assert.equal(h.context.userCoversPhysicalStore_('RANCH', 'CPR'), true);
  assert.equal(h.context.userCoversPhysicalStore_('RANCH', 'WZ'), false);
  assert.equal(h.context.userCoversPhysicalStore_('SPZ', 'CPR'), false);
  assert.equal(h.context.userCoversPhysicalStore_('ALL', 'WZ'), true);
  assert.throws(() => h.context.assertPhysicalStore_('RANCH'), /not one audit/);
});

test('store list, assignee filter, and hidden scores on the audit payload', () => {
  const { h, admin } = adminHarness();
  const ranch = h.call({
    action: 'createTemplate', token: admin.token, name: 'Ranch walk', appliesTo: 'RANCH',
  });
  const zig = h.call({
    action: 'createTemplate', token: admin.token, name: 'Coffee bar', appliesTo: 'ZIGGIS',
  });
  const q = h.call({
    action: 'addBuilderQuestion',
    token: admin.token,
    templateId: ranch.template.templateId,
    section: 'Lobby',
    text: 'Mats down?',
    points: 7,
    type: 'multiple',
    options: 'Good:7|Poor:0',
    todoIfImperfect: 'Fix mats',
  });
  assert.equal(q.ok, true, q.message);
  h.call({
    action: 'addBuilderQuestion',
    token: admin.token,
    templateId: ranch.template.templateId,
    section: 'Team',
    text: 'Uniforms?',
    points: 5,
    type: 'yesno',
    fullPointsAnswer: 'no',
    todoIfImperfect: 'OFF',
  });

  const brian = h.call({ action: 'login', email: 'brian@example.com', password: 'shared-secret' });
  const carter = h.call({ action: 'login', email: 'carter@example.com', password: 'shared-secret' });
  const forBrian = h.call({ action: 'listTemplatesForStore', token: brian.token, store: 'CPR' });
  assert.deepEqual(forBrian.templates.map((t) => t.name), ['Ranch walk']);
  const forCarter = h.call({ action: 'listTemplatesForStore', token: carter.token, store: 'SPZ' });
  assert.deepEqual(forCarter.templates.map((t) => t.name), ['Coffee bar']);
  assert.equal(zig.ok, true);

  const audit = h.call({
    action: 'beginAudit', token: brian.token, templateId: ranch.template.templateId, store: 'CPR',
  });
  assert.equal(audit.ok, true, audit.message);
  const payload = JSON.stringify(audit.questions);
  assert.equal(payload.includes('fullPointsAnswer'), false);
  assert.equal(payload.includes(':7'), false);
  assert.equal(payload.includes('points'), false);
  assert.ok(payload.includes('Good'));
  assert.ok(payload.includes('Poor'));

  const people = h.call({ action: 'listEligibleAssignees', token: brian.token, auditId: audit.auditId });
  const emails = people.users.map((u) => u.email).sort();
  assert.ok(emails.includes('brian@example.com'));
  assert.ok(emails.includes('nina@example.com'));
  assert.ok(emails.includes('cassidy@example.com'));
  assert.equal(emails.includes('carter@example.com'), false);

  const saved = h.call({
    action: 'submitAuditAnswers',
    token: brian.token,
    auditId: audit.auditId,
    answers: [
      { questionId: audit.questions[0].questionId, answer: 'Poor', note: 'curled' },
      { questionId: audit.questions[1].questionId, answer: 'no', note: '' },
    ],
  });
  assert.equal(saved.ok, true, saved.message);
  assert.equal(saved.score, 5);
  assert.equal(saved.maxScore, 12);
  assert.equal(saved.todoCandidates.length, 1);
  assert.equal(saved.todoCandidates[0].title, 'Fix mats');
  const rows = objectsFrom(h.sheets.Answers);
  assert.equal(rows.length, 2);
  assert.equal(Number(rows.find((r) => r.answer === 'Poor').pointsEarned), 0);
  assert.equal(Number(rows.find((r) => r.answer === 'no').pointsEarned), 5);
});

test('save all writes nothing when one question is invalid', () => {
  const { h, admin } = adminHarness();
  const created = h.call({
    action: 'createTemplate', token: admin.token, name: 'Original name', appliesTo: 'ALL',
  });
  const q = h.call({
    action: 'addBuilderQuestion',
    token: admin.token,
    templateId: created.template.templateId,
    section: 'Lobby',
    text: 'Keep this text',
    points: 5,
    type: 'yesno',
  });
  const bad = h.call({
    action: 'saveAllBuilderTemplate',
    token: admin.token,
    templateId: created.template.templateId,
    meta: { name: 'Should not stick', appliesTo: 'ZIGGIS' },
    questions: [{
      questionId: q.question.questionId,
      section: '',
      text: 'Changed',
      points: 5,
      type: 'yesno',
      fullPointsAnswer: 'yes',
    }],
  });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /nothing was written/);
  const template = objectsFrom(h.sheets.Templates).find((t) => t.templateId === created.template.templateId);
  assert.equal(template.name, 'Original name');
  assert.equal(template.appliesTo, 'ALL');
  const question = objectsFrom(h.sheets.Questions)[0];
  assert.equal(question.text, 'Keep this text');
});
