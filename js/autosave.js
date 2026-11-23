// Decides when an in-progress audit should be written with the existing
// pauseAudit action. The sheet already keeps one paused row per audit id.

export const AUTOSAVE_INTERVAL_MS = 30000;

export const AUTOSAVE_STATUS = {
  saving: "Saving…",
  saved: "Saved",
  pending: "Not saved yet",
};

export function buildPausePayload(audit, answers, media, sectionIndex) {
  if (!audit || !audit.auditId) return null;
  return {
    auditId: audit.auditId,
    sectionIndex: Number(sectionIndex) || 0,
    answers: (audit.questions || []).map((question) => ({
      questionId: question.questionId,
      answer: (answers[question.questionId] || {}).answer || "",
      note: (answers[question.questionId] || {}).note || "",
      mediaUrls: (media[question.questionId] || []).map((file) => file.objectKey).filter(Boolean),
    })),
  };
}

export function fingerprintPause(payload) {
  if (!payload || !payload.auditId) return "";
  return JSON.stringify({
    auditId: String(payload.auditId),
    sectionIndex: Number(payload.sectionIndex) || 0,
    answers: (payload.answers || []).map((item) => ({
      questionId: String(item.questionId || ""),
      answer: String(item.answer || ""),
      note: String(item.note || ""),
      mediaUrls: (item.mediaUrls || []).map((key) => String(key || "")),
    })),
  });
}

export function decideAutosave(input) {
  const fingerprint = fingerprintPause(input && input.snapshot);
  if (!fingerprint) return { save: false, fingerprint: "", skip: "idle" };
  if (input.suspended) return { save: false, fingerprint, skip: "suspended" };
  if (input.inflightFingerprint && input.inflightFingerprint === fingerprint) {
    return { save: false, fingerprint, skip: "in-flight" };
  }
  if (input.savedFingerprint === fingerprint) {
    return { save: false, fingerprint, skip: "unchanged" };
  }
  return { save: true, fingerprint, skip: "" };
}

export function createAutosaveController(options) {
  const intervalMs = options.intervalMs || AUTOSAVE_INTERVAL_MS;
  const setTimer = options.setTimer || ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer || ((id) => clearTimeout(id));
  let savedFingerprint = "";
  let inflightFingerprint = "";
  let suspended = false;
  let started = false;
  let timer = null;
  let status = "";
  let tail = Promise.resolve();

  function paint(next) {
    status = next || "";
    if (options.onStatus) options.onStatus(status);
  }

  function syncLabel() {
    if (suspended) {
      paint("");
      return;
    }
    const snap = options.snapshot ? options.snapshot() : null;
    const fingerprint = fingerprintPause(snap);
    if (!fingerprint) {
      paint("");
      return;
    }
    if (inflightFingerprint && inflightFingerprint === fingerprint) {
      paint(AUTOSAVE_STATUS.saving);
      return;
    }
    paint(fingerprint === savedFingerprint ? AUTOSAVE_STATUS.saved : AUTOSAVE_STATUS.pending);
  }

  function takeSnapshot() {
    if (suspended) return null;
    if (options.capture) options.capture();
    return options.snapshot ? options.snapshot() : null;
  }

  function enqueue(work) {
    const run = tail.then(work, work);
    tail = run.then(() => {}, () => {});
    return run;
  }

  async function postSnapshot(snap, fingerprint) {
    inflightFingerprint = fingerprint;
    paint(AUTOSAVE_STATUS.saving);
    try {
      const result = await options.post(snap);
      if (inflightFingerprint === fingerprint) inflightFingerprint = "";
      savedFingerprint = fingerprint;
      syncLabel();
      if (options.onSaved) options.onSaved(result);
      return { saved: true, result };
    } catch (err) {
      if (inflightFingerprint === fingerprint) inflightFingerprint = "";
      syncLabel();
      return { saved: false, error: err, skip: "" };
    }
  }

  function flush() {
    return enqueue(async () => {
      if (suspended) return { saved: false, skip: "suspended" };
      const snap = takeSnapshot();
      const decision = decideAutosave({
        snapshot: snap,
        savedFingerprint,
        inflightFingerprint,
        suspended,
      });
      if (!decision.save) {
        syncLabel();
        return { saved: false, skip: decision.skip };
      }
      return postSnapshot(snap, decision.fingerprint);
    });
  }

  function flushKeepalive() {
    if (!suspended && options.capture) options.capture();
    const snap = options.snapshot ? options.snapshot() : null;
    const decision = decideAutosave({
      snapshot: snap,
      savedFingerprint,
      inflightFingerprint,
      suspended,
    });
    if (!decision.save) return { saved: false, skip: decision.skip, keepalive: false };
    let ok = false;
    try {
      ok = !!(options.keepalive && options.keepalive(snap));
    } catch (err) {
      ok = false;
    }
    // Do not treat a beacon as confirmed. The next timer or Next/Back retries
    // if this page is still open and the sheet copy is still behind.
    return { saved: false, skip: ok ? "" : "keepalive-failed", keepalive: ok };
  }

  function arm() {
    if (!started || suspended || timer) return;
    timer = setTimer(() => {
      timer = null;
      return flush().finally(() => arm());
    }, intervalMs);
  }

  function disarm() {
    if (timer) clearTimer(timer);
    timer = null;
  }

  return {
    start() {
      started = true;
      syncLabel();
      arm();
    },
    stop() {
      started = false;
      disarm();
    },
    suspend() {
      suspended = true;
      disarm();
      paint("");
    },
    resume() {
      suspended = false;
      syncLabel();
      if (started) arm();
    },
    acknowledge(snapshot) {
      const snap = snapshot || (options.snapshot ? options.snapshot() : null);
      savedFingerprint = fingerprintPause(snap);
      if (inflightFingerprint === savedFingerprint) inflightFingerprint = "";
      if (!suspended) syncLabel();
    },
    touch() {
      syncLabel();
    },
    flush,
    flushKeepalive,
    whenIdle() {
      return tail;
    },
    label() {
      return status;
    },
  };
}
