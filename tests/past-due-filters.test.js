import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PAST_DUE_FILTERS,
  addDays,
  filterChips,
  filterPastDueItems,
  groupPastDueItems,
  isClosedStatus,
  loadPastDueFilters,
  normalizeTodoStatus,
  removeFilterChip,
  savePastDueFilters,
} from '../js/past-due-filters.js';

const today = '2026-04-01';

function item(title, due, status, email) {
  return {
    todoId: title,
    title,
    dueDate: due,
    status,
    assignedTo: email,
    email,
    displayName: email ? email : 'Unassigned',
    unassigned: !email,
    daysOverdue: due < today ? 1 : 0,
    daysFromToday: due < today ? -1 : 1,
  };
}

const sample = [
  item('Old open', '2026-03-20', 'open', 'brian@example.com'),
  item('Old done', '2026-03-20', 'done', 'brian@example.com'),
  item('Working', '2026-03-20', 'in_progress', 'brian@example.com'),
  item('Blocked', '2026-03-20', "Can't do", ''),
  item('Today', '2026-04-01', 'todo', 'brian@example.com'),
  item('Soon', '2026-04-08', 'todo', 'pat@example.com'),
  item('Later', '2026-04-20', 'todo', 'brian@example.com'),
];

test('old open and done values map onto To do and Complete', () => {
  assert.equal(normalizeTodoStatus('open'), 'todo');
  assert.equal(normalizeTodoStatus('done'), 'complete');
  assert.equal(normalizeTodoStatus(''), 'todo');
  assert.equal(normalizeTodoStatus('In progress'), 'in_progress');
  assert.equal(normalizeTodoStatus("Can't do"), 'cant_do');
  assert.equal(isClosedStatus('done'), true);
  assert.equal(isClosedStatus('complete'), true);
  assert.equal(isClosedStatus("Can't do"), true);
  assert.equal(isClosedStatus('open'), false);
  assert.equal(isClosedStatus('in_progress'), false);
});

test('the default filter is the old past-due list, and other modes use the Chicago day', () => {
  assert.equal(addDays(today, 7), '2026-04-08');
  const past = filterPastDueItems(sample, DEFAULT_PAST_DUE_FILTERS, today).map((row) => row.title);
  assert.deepEqual(past.sort(), ['Old open', 'Working']);
  const nextWeek = filterPastDueItems(sample, Object.assign({}, DEFAULT_PAST_DUE_FILTERS, { due: 'next7' }), today);
  assert.deepEqual(nextWeek.map((row) => row.title).sort(), ['Soon', 'Today']);
  const onlyBrian = filterPastDueItems(sample, Object.assign({}, DEFAULT_PAST_DUE_FILTERS, {
    due: 'all',
    people: ['brian@example.com'],
    statuses: [],
    hideClosed: false,
  }), today);
  assert.ok(onlyBrian.every((row) => row.email === 'brian@example.com'));
  assert.ok(onlyBrian.some((row) => row.title === 'Old done'));
  const hidden = filterPastDueItems(sample, Object.assign({}, DEFAULT_PAST_DUE_FILTERS, {
    due: 'all',
    statuses: ['complete', 'cant_do'],
    hideClosed: true,
  }), today);
  assert.equal(hidden.length, 0);
  const groups = groupPastDueItems(filterPastDueItems(sample, DEFAULT_PAST_DUE_FILTERS, today));
  assert.equal(groups.length, 1);
  assert.equal(groups[0].count, 2);
});

test('filter chips can be removed, and the choice is remembered per person', () => {
  const filters = Object.assign({}, DEFAULT_PAST_DUE_FILTERS, { people: ['__unassigned__', 'brian@example.com'] });
  const chips = filterChips(filters, [{ email: 'brian@example.com', name: 'Brian' }]);
  assert.ok(chips.some((chip) => chip.label === 'Assignee: Brian'));
  assert.ok(chips.some((chip) => chip.label === 'Due date: Past due'));
  assert.ok(chips.some((chip) => chip.label === 'Hide closed'));
  const clearedDue = removeFilterChip(filters, 'due');
  assert.equal(clearedDue.due, 'all');
  const clearedPerson = removeFilterChip(filters, 'person:brian@example.com');
  assert.deepEqual(clearedPerson.people, ['__unassigned__']);
  const mem = new Map();
  const storage = {
    getItem: (key) => mem.get(key) || null,
    setItem: (key, value) => mem.set(key, value),
  };
  savePastDueFilters(storage, 'Cassidy@Example.com', filters);
  const loaded = loadPastDueFilters(storage, 'cassidy@example.com');
  assert.deepEqual(loaded.people, ['__unassigned__', 'brian@example.com']);
  assert.equal(loadPastDueFilters(storage, 'brian@example.com').due, 'past');
});
