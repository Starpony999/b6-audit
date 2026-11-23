import test from 'node:test';
import assert from 'node:assert/strict';
import { api, sendKeepalive } from '../js/api.js';

test('an open-page save is a normal fetch, and only unload uses keepalive', async () => {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push(opts);
    return { text: async () => JSON.stringify({ ok: true }), catch() { return this; } };
  };
  try {
    await api('pauseAudit', { auditId: 'audit-1', sectionIndex: 0, answers: [] });
    assert.equal(calls[0].keepalive, false);
    const sent = sendKeepalive('pauseAudit', { auditId: 'audit-1', sectionIndex: 0, answers: [] });
    assert.equal(sent, true);
    assert.equal(calls[1].keepalive, true);
  } finally {
    global.fetch = original;
  }
});
