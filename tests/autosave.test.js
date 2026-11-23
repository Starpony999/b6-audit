import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTOSAVE_INTERVAL_MS,
  AUTOSAVE_STATUS,
  buildPausePayload,
  createAutosaveController,
  decideAutosave,
  fingerprintPause,
} from '../js/autosave.js';

function snapshot(answer, section) {
  return buildPausePayload(
    { auditId: 'audit-1', questions: [{ questionId: 'q1' }] },
    { q1: { answer, note: '' } },
    {},
    section || 0
  );
}

function controller(hooks) {
  const posts = [];
  const beacons = [];
  const timers = [];
  let cleared = 0;
  const ctl = createAutosaveController({
    intervalMs: AUTOSAVE_INTERVAL_MS,
    snapshot: () => hooks.snapshot(),
    post: async (payload) => {
      posts.push(payload);
      if (hooks.fail) throw new Error('offline');
      return { ok: true };
    },
    keepalive: (payload) => {
      beacons.push(payload);
      return true;
    },
    setTimer: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimer: () => { cleared += 1; },
    onStatus: (text) => { hooks.status = text; },
  });
  return { ctl, posts, beacons, timers, cleared: () => cleared, hooks };
}

test('an unchanged snapshot is not saved again', () => {
  const snap = snapshot('no', 1);
  const fingerprint = fingerprintPause(snap);
  assert.equal(decideAutosave({
    snapshot: snap,
    savedFingerprint: fingerprint,
    inflightFingerprint: '',
    suspended: false,
  }).save, false);
  assert.equal(decideAutosave({
    snapshot: snap,
    savedFingerprint: '',
    inflightFingerprint: fingerprint,
    suspended: false,
  }).skip, 'in-flight');
  assert.equal(decideAutosave({
    snapshot: snapshot('yes', 1),
    savedFingerprint: fingerprint,
    inflightFingerprint: '',
    suspended: false,
  }).save, true);
});

test('the timer waits 30 seconds, saves once, and skips when nothing changed', async () => {
  let answer = 'no';
  const bag = controller({ snapshot: () => snapshot(answer, 0), status: '' });
  bag.ctl.start();
  assert.equal(bag.timers[0].ms, 30000);
  assert.equal(bag.posts.length, 0);
  assert.equal(bag.hooks.status, AUTOSAVE_STATUS.pending);

  await bag.timers[0].fn();
  assert.equal(bag.posts.length, 1);
  assert.equal(bag.posts[0].answers[0].answer, 'no');
  assert.equal(bag.hooks.status, AUTOSAVE_STATUS.saved);

  await bag.timers[1].fn();
  assert.equal(bag.posts.length, 1);

  answer = 'yes';
  bag.ctl.touch();
  assert.equal(bag.hooks.status, AUTOSAVE_STATUS.pending);
  await bag.timers[2].fn();
  assert.equal(bag.posts.length, 2);
  assert.equal(bag.posts[1].answers[0].answer, 'yes');
});

test('a successful save is not repeated, and a failed save is retried on the next trigger', async () => {
  let answer = 'no';
  let fail = false;
  const posts = [];
  let label = '';
  const ctl = createAutosaveController({
    snapshot: () => snapshot(answer, 0),
    post: async (payload) => {
      posts.push(payload.answers[0].answer);
      if (fail) throw new Error('offline');
      return { ok: true };
    },
    setTimer: () => 0,
    clearTimer: () => {},
    onStatus: (text) => { label = text; },
  });
  const first = await ctl.flush();
  const second = await ctl.flush();
  assert.equal(first.saved, true);
  assert.equal(second.skip, 'unchanged');
  assert.deepEqual(posts, ['no']);
  assert.equal(label, AUTOSAVE_STATUS.saved);

  fail = true;
  answer = 'yes';
  const third = await ctl.flush();
  assert.equal(third.saved, false);
  assert.equal(label, AUTOSAVE_STATUS.pending);
  const fourth = await ctl.flush();
  assert.equal(fourth.saved, false);
  assert.deepEqual(posts, ['no', 'yes', 'yes']);

  fail = false;
  const fifth = await ctl.flush();
  assert.equal(fifth.saved, true);
  assert.equal(label, AUTOSAVE_STATUS.saved);
  const sixth = await ctl.flush();
  assert.equal(sixth.skip, 'unchanged');
  assert.equal(posts.length, 4);
});

test('a save already running is not duplicated, and submit suspends further saves', async () => {
  let release;
  let answer = 'no';
  const posts = [];
  const ctl = createAutosaveController({
    snapshot: () => snapshot(answer, 0),
    post: (payload) => new Promise((resolve) => {
      posts.push(payload.answers[0].answer);
      release = resolve;
    }),
    keepalive: () => true,
    setTimer: () => 0,
    clearTimer: () => {},
  });
  const pending = ctl.flush();
  await Promise.resolve();
  answer = 'no';
  const joined = ctl.flushKeepalive();
  assert.equal(joined.skip, 'in-flight');
  release({ ok: true });
  assert.equal((await pending).saved, true);
  assert.deepEqual(posts, ['no']);

  ctl.suspend();
  answer = 'yes';
  const blocked = await ctl.flush();
  assert.equal(blocked.skip, 'suspended');
  assert.equal(posts.length, 1);
  assert.equal(ctl.flushKeepalive().skip, 'suspended');
});
