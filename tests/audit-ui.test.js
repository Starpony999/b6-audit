import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appliesValue,
  auditQuestionHtml,
  choiceLabel,
  defaultDueDate,
  groupQuestionsBySection,
  mergeSectionAnswers,
  stepSection,
} from '../js/audit-ui.js';
import { validateLocalFile } from '../js/media.js';

test('audit questions hide scores and keep section order', () => {
  const html = auditQuestionHtml({
    questionId: 'q1',
    order: 2,
    text: 'Are the mats flat?',
    type: 'multiple',
    options: 'Good:9|Poor:0',
    points: 9,
    fullPointsAnswer: 'yes',
  }, { answer: 'Good' });
  assert.match(html, /Are the mats flat/);
  assert.match(html, /> Good</);
  assert.match(html, /> Poor</);
  assert.equal(html.includes('9'), false);
  assert.equal(/points/i.test(html), false);
  assert.equal(choiceLabel('Good:9'), 'Good');
  const sections = groupQuestionsBySection([
    { questionId: 'a', section: 'Lobby' },
    { questionId: 'b', section: 'Team' },
    { questionId: 'c', section: 'Lobby' },
  ]);
  assert.deepEqual(sections.map((s) => s.name), ['Lobby', 'Team']);
  assert.equal(sections[0].questions.length, 2);
});

test('next and back keep answers and notes', () => {
  const questions = [{ questionId: 'q1' }];
  const first = mergeSectionAnswers(questions, {}, () => ({ answer: 'no', note: 'torn' }));
  assert.deepEqual(first.q1, { answer: 'no', note: 'torn' });
  const kept = mergeSectionAnswers(questions, first, () => ({ answer: '', note: null }));
  assert.deepEqual(kept.q1, { answer: 'no', note: 'torn' });
  const edited = mergeSectionAnswers(questions, kept, () => ({ answer: 'yes', note: 'fixed' }));
  assert.deepEqual(edited.q1, { answer: 'yes', note: 'fixed' });
  assert.equal(stepSection(0, 3, 1), 1);
  assert.equal(stepSection(0, 3, -1), 0);
  assert.equal(stepSection(2, 3, 1), 2);
});

test('default due date is 30 calendar days and applies-to needs a store', () => {
  assert.equal(defaultDueDate(new Date(2026, 3, 1)), '2026-05-01');
  assert.equal(appliesValue('RANCH', []), 'RANCH');
  assert.equal(appliesValue('SELECTED', ['WPR', 'SPZ']), 'WPR,SPZ');
  assert.throws(() => appliesValue('SELECTED', []), /at least one store/);
});

test('the phone rejects a video over about 8 MB before asking for an upload link', () => {
  assert.equal(validateLocalFile({ type: 'video/mp4', size: 8 * 1024 * 1024 }).ok, true);
  const big = validateLocalFile({ type: 'video/mp4', size: 8 * 1024 * 1024 + 1 });
  assert.equal(big.ok, false);
  assert.match(big.message, /8 MB/);
  assert.equal(validateLocalFile({ type: 'image/jpeg', size: 9 * 1024 * 1024 }).ok, true);
  assert.equal(validateLocalFile({ type: 'image/svg+xml', size: 10 }).ok, false);
  assert.match(validateLocalFile({ type: 'application/pdf', size: 10 }).message, /photo or video/);
});
