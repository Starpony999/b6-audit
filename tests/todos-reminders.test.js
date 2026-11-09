import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, objectsFrom } from './gas-harness.js';

function setupAudit() {
  const h = createHarness();
  const admin = h.call({
    action: 'bootstrapAdmin',
    name: 'Cassidy',
    email: 'cassidy@example.com',
    password: 'correct-horse',
    passwordConfirm: 'correct-horse',
    bootstrapSecret: 'setup-phrase-for-tests-only',
  });
  h.call({
    action: 'addUser', token: admin.token, name: 'Brian', email: 'brian@example.com',
    role: 'manager', store: 'RANCH', password: 'shared-secret', mustChangePassword: false,
  });
  h.call({
    action: 'addUser', token: admin.token, name: 'Carter', email: 'carter@example.com',
    role: 'gm', store: 'SPZ', password: 'shared-secret', mustChangePassword: false,
  });
  const template = h.call({
    action: 'createTemplate', token: admin.token, name: 'Walk', appliesTo: 'RANCH',
  });
  const q1 = h.call({
    action: 'addBuilderQuestion', token: admin.token, templateId: template.template.templateId,
    section: 'Lobby', text: 'Mats?', points: 5, type: 'yesno', fullPointsAnswer: 'yes',
    todoIfImperfect: 'Fix mats',
  });
  const q2 = h.call({
    action: 'addBuilderQuestion', token: admin.token, templateId: template.template.templateId,
    section: 'Lobby', text: 'Glass?', points: 5, type: 'yesno', fullPointsAnswer: 'yes',
    todoIfImperfect: '',
  });
  const brian = h.call({ action: 'login', email: 'brian@example.com', password: 'shared-secret' });
  const audit = h.call({
    action: 'beginAudit', token: brian.token, templateId: template.template.templateId, store: 'CPR',
  });
  return { h, admin, brian, audit, q1: q1.question.questionId, q2: q2.question.questionId };
}

test('default due date is 30 days, explicit date wins, unassigned sends no mail', () => {
  const { h, brian, audit, q1 } = setupAudit();
  const saved = h.call({
    action: 'submitAuditAnswers',
    token: brian.token,
    auditId: audit.auditId,
    answers: [{ questionId: q1, answer: 'no', note: 'torn' }],
  });
  assert.equal(saved.todoCandidates.length, 1);
  const created = h.call({
    action: 'createTodosFromReview',
    token: brian.token,
    auditId: audit.auditId,
    store: 'CPR',
    auditorEmail: 'someone-else@example.com',
    todos: [
      { questionId: q1, title: 'Fix mats', details: 'torn', assignedTo: '', dueDate: '' },
      { questionId: q1, title: 'Second look', details: '', assignedTo: 'brian@example.com', dueDate: '2026-05-15' },
    ],
  });
  assert.equal(created.ok, true, created.message);
  assert.equal(created.skippedUnassigned, 1);
  assert.equal(created.emailsSent, 1);
  assert.equal(h.emails.length, 1);
  assert.equal(h.emails[0].to, 'brian@example.com');
  assert.match(h.emails[0].body, /Second look/);
  assert.doesNotMatch(h.emails[0].body, /Fix mats/);
  assert.match(h.emails[0].body, /https:\/\/starpony999\.github\.io\/b6-audit\//);
  assert.doesNotMatch(h.emails[0].body, /script\.google\.com/);
  const todos = objectsFrom(h.sheets.Todos);
  const unassigned = todos.find((t) => t.title === 'Fix mats');
  const assigned = todos.find((t) => t.title === 'Second look');
  assert.equal(unassigned.assignedTo, '');
  assert.equal(unassigned.dueDate, '2026-05-01');
  assert.equal(assigned.dueDate, '2026-05-15');
  assert.equal(assigned.assignedBy, 'brian@example.com');
  const denied = h.call({
    action: 'createTodosFromReview',
    token: brian.token,
    auditId: audit.auditId,
    todos: [{ questionId: q1, title: 'Nope', assignedTo: 'carter@example.com', dueDate: '2026-05-15' }],
  });
  assert.equal(denied.ok, false);
});

test('resubmit replaces answers until to-dos exist, then locks', () => {
  const { h, brian, audit, q1, q2 } = setupAudit();
  const first = h.call({
    action: 'submitAuditAnswers',
    token: brian.token,
    auditId: audit.auditId,
    answers: [
      { questionId: q1, answer: 'no', note: 'first' },
      { questionId: q2, answer: 'no', note: 'glass' },
    ],
  });
  assert.equal(first.ok, true, first.message);
  assert.equal(objectsFrom(h.sheets.Answers).length, 2);
  const second = h.call({
    action: 'submitAuditAnswers',
    token: brian.token,
    auditId: audit.auditId,
    answers: [{ questionId: q1, answer: 'yes', note: 'fixed' }],
  });
  assert.equal(second.ok, true, second.message);
  const answers = objectsFrom(h.sheets.Answers);
  assert.equal(answers.length, 1);
  assert.equal(answers[0].note, 'fixed');
  assert.equal(second.todoCandidates.length, 0);
  const created = h.call({
    action: 'createTodosFromReview',
    token: brian.token,
    auditId: audit.auditId,
    todos: [{ questionId: q2, title: 'Glass', assignedTo: '', dueDate: '2026-05-02' }],
  });
  assert.equal(created.ok, true, created.message);
  assert.equal(h.emails.length, 0);
  const locked = h.call({
    action: 'submitAuditAnswers',
    token: brian.token,
    auditId: audit.auditId,
    answers: [{ questionId: q1, answer: 'no', note: 'again' }],
  });
  assert.equal(locked.ok, false);
  assert.match(locked.message, /To-dos already exist/);
  assert.equal(objectsFrom(h.sheets.Answers).length, 1);
});

test('two tasks for one person make one email; my list ignores a requested email', () => {
  const { h, brian, audit, q1, q2 } = setupAudit();
  h.call({
    action: 'submitAuditAnswers',
    token: brian.token,
    auditId: audit.auditId,
    answers: [
      { questionId: q1, answer: 'no', note: '' },
      { questionId: q2, answer: 'no', note: '' },
    ],
  });
  const created = h.call({
    action: 'createTodosFromReview',
    token: brian.token,
    auditId: audit.auditId,
    todos: [
      { questionId: q1, title: 'Mats', assignedTo: 'brian@example.com', dueDate: '2026-05-01' },
      { questionId: q2, title: 'Glass', assignedTo: 'Brian@Example.com', dueDate: '2026-05-01' },
    ],
  });
  assert.equal(created.emailsSent, 1);
  assert.equal(h.emails.length, 1);
  assert.match(h.emails[0].body, /Mats/);
  assert.match(h.emails[0].body, /Glass/);
  const mine = h.call({ action: 'listMyTodos', token: brian.token, email: 'cassidy@example.com' });
  assert.equal(mine.todos.length, 2);
  assert.ok(mine.todos.every((t) => t.assignedTo.toLowerCase() === 'brian@example.com'));
  const cassidy = h.call({ action: 'login', email: 'cassidy@example.com', password: 'correct-horse' });
  const hers = h.call({ action: 'listMyTodos', token: cassidy.token });
  assert.equal(hers.todos.length, 0);
});

test('reminders: 7 days, due today, overdue, done skipped, same-day marker, assignment same day', () => {
  const h = createHarness();
  const admin = h.call({
    action: 'bootstrapAdmin',
    name: 'Cassidy', email: 'cassidy@example.com',
    password: 'correct-horse', passwordConfirm: 'correct-horse',
    bootstrapSecret: 'setup-phrase-for-tests-only',
  });
  const sheet = h.sheets.Todos;
  const header = sheet._rows[0];
  header.push('assignmentNotifiedAt', 'reminderDueSoonSentOn', 'reminderDueDaySentOn');
  function add(title, due, status, assignedTo, notified) {
    const row = header.map(() => '');
    const set = (name, value) => { row[header.indexOf(name)] = value; };
    set('todoId', 'todo-' + title);
    set('title', title);
    set('assignedTo', assignedTo);
    set('store', 'CPR');
    set('dueDate', due);
    set('status', status);
    set('assignmentNotifiedAt', notified || '');
    sheet._rows.push(row);
  }
  add('Soon', '2026-04-08', 'open', 'brian@example.com', '');
  add('Today', '2026-04-01', 'open', 'brian@example.com', '');
  add('Late', '2026-03-30', 'open', 'brian@example.com', '');
  add('Done', '2026-03-01', 'done', 'brian@example.com', '');
  add('Later', '2026-04-20', 'open', 'brian@example.com', '');
  add('Mid', '2026-04-04', 'open', 'brian@example.com', '');
  add('Fresh', '2026-04-08', 'open', 'pat@example.com', '2026-04-01T20:00:00.000Z');
  add('No one', '2026-03-30', 'open', '', '');

  let result = h.context.sendTodoReminders();
  assert.equal(result.sentTo, 1, JSON.stringify(result));
  assert.equal(h.emails.length, 1);
  assert.match(h.emails[0].body, /DUE IN 7 DAYS/);
  assert.match(h.emails[0].body, /DUE TODAY/);
  assert.match(h.emails[0].body, /PAST DUE \(2 days\)/);
  assert.doesNotMatch(h.emails[0].body, /Done/);
  assert.doesNotMatch(h.emails[0].body, /Later/);
  assert.doesNotMatch(h.emails[0].body, /Mid/);
  assert.doesNotMatch(h.emails[0].body, /Fresh/);
  assert.match(h.emails[0].body, /https:\/\/starpony999\.github\.io\/b6-audit\//);
  assert.doesNotMatch(h.emails[0].body, /script\.google\.com/);

  h.emails.length = 0;
  result = h.context.sendTodoReminders();
  assert.equal(result.sentTo, 0);
  assert.equal(h.emails.length, 0);

  h.context.B6_TEST_NOW = '2026-04-02T15:00:00.000Z';
  result = h.context.sendTodoReminders();
  assert.equal(result.sentTo, 1);
  assert.match(h.emails[0].body, /Late/);
  assert.doesNotMatch(h.emails[0].body, /Soon/);
  assert.equal(admin.ok, true);
});

test('an evening UTC timestamp still counts as the Chicago calendar day', () => {
  const h = createHarness();
  const day = h.context.parseDueCalendarDay_('2026-04-02T02:00:00.000Z');
  assert.equal(day.key, '2026-04-01');
  const dateOnly = h.context.parseDueCalendarDay_('2026-04-08');
  assert.equal(dateOnly.key, '2026-04-08');
  assert.equal(h.context.daysFromToCalendar_(
    h.context.calendarTodayParts_(),
    dateOnly
  ), 7);
});

test('past due is strictly before today and groups unassigned', () => {
  const h = createHarness();
  const admin = h.call({
    action: 'bootstrapAdmin',
    name: 'Cassidy', email: 'cassidy@example.com',
    password: 'correct-horse', passwordConfirm: 'correct-horse',
    bootstrapSecret: 'setup-phrase-for-tests-only',
  });
  h.call({
    action: 'addUser', token: admin.token, name: 'Brian', email: 'brian@example.com',
    role: 'manager', store: 'RANCH', password: 'shared-secret', mustChangePassword: false,
  });
  const header = h.sheets.Todos._rows[0];
  function add(title, due, status, assignedTo) {
    const row = header.map(() => '');
    const set = (name, value) => { row[header.indexOf(name)] = value; };
    set('todoId', 'id-' + title);
    set('title', title);
    set('assignedTo', assignedTo);
    set('store', 'WPR');
    set('dueDate', due);
    set('status', status);
    h.sheets.Todos._rows.push(row);
  }
  add('Old', '2026-03-28', 'open', 'brian@example.com');
  add('Today', '2026-04-01', 'open', 'brian@example.com');
  add('Finished', '2026-03-01', 'done', 'brian@example.com');
  add('Loose', '2026-03-20', 'open', '');
  const report = h.call({ action: 'getPastDueReport', token: admin.token });
  assert.equal(report.ok, true);
  assert.equal(report.totalItems, 2);
  const brian = report.groups.find((g) => g.email === 'brian@example.com');
  assert.equal(brian.items.length, 1);
  assert.equal(brian.items[0].title, 'Old');
  assert.equal(brian.items[0].daysOverdue, 4);
  const loose = report.groups.find((g) => g.unassigned);
  assert.equal(loose.items[0].title, 'Loose');
  const brianLogin = h.call({ action: 'login', email: 'brian@example.com', password: 'shared-secret' });
  const denied = h.call({ action: 'getPastDueReport', token: brianLogin.token });
  assert.equal(denied.error, 'forbidden');
});

test('only the assignee or an admin can close a to-do; due date stays a calendar day', () => {
  const { h, admin, brian, audit, q1 } = setupAudit();
  h.call({
    action: 'submitAuditAnswers', token: brian.token, auditId: audit.auditId,
    answers: [{ questionId: q1, answer: 'no', note: '' }],
  });
  h.call({
    action: 'createTodosFromReview', token: brian.token, auditId: audit.auditId,
    todos: [{ questionId: q1, title: 'Mats', assignedTo: 'brian@example.com', dueDate: '2026-06-01' }],
  });
  const todo = objectsFrom(h.sheets.Todos)[0];
  const carter = h.call({ action: 'login', email: 'carter@example.com', password: 'shared-secret' });
  const nope = h.call({ action: 'markTodoDone', token: carter.token, todoId: todo.todoId });
  assert.equal(nope.error, 'forbidden');
  const moved = h.call({ action: 'updateTodoDueDate', token: brian.token, todoId: todo.todoId, dueDate: '2026-06-15' });
  assert.equal(moved.ok, true, moved.message);
  assert.equal(objectsFrom(h.sheets.Todos)[0].dueDate, '2026-06-15');
  const done = h.call({ action: 'markTodoDone', token: admin.token, todoId: todo.todoId });
  assert.equal(done.ok, true, done.message);
  assert.equal(String(objectsFrom(h.sheets.Todos)[0].status), 'done');
});
