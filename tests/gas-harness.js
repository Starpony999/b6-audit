import crypto from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

function u8(b) {
  let n = Number(b) || 0;
  n %= 256;
  if (n < 0) n += 256;
  return n;
}

function toBuf(data) {
  if (typeof data === 'string') return Buffer.from(data, 'utf8');
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data) || ArrayBuffer.isView(data)) return Buffer.from(Array.from(data, u8));
  throw new Error('bad byte input');
}

export function createHarness() {
  const sheets = {};
  const props = {};
  const cache = new Map();
  const emails = [];
  let lockHeld = false;
  let uuidN = 0;

  function lastCol(rows) {
    let max = 1;
    rows.forEach((row) => {
      let end = row.length;
      while (end > 0 && (row[end - 1] === '' || row[end - 1] == null)) end -= 1;
      if (end > max) max = end;
    });
    return max;
  }

  function ensureRow(rows, r) {
    while (rows.length < r) rows.push([]);
  }

  function makeSheet(name, rows) {
    const sheet = {
      getName() { return name; },
      getLastColumn() { return lastCol(rows); },
      getLastRow() { return Math.max(rows.length, 1); },
      getRange(row, col, numRows, numCols) {
        const r1 = row;
        const c1 = col;
        const rCount = numRows == null ? 1 : numRows;
        const cCount = numCols == null ? 1 : numCols;
        return {
          getValues() {
            const out = [];
            for (let r = 0; r < rCount; r += 1) {
              const line = [];
              for (let c = 0; c < cCount; c += 1) {
                const src = rows[r1 - 1 + r];
                const value = src && src[c1 - 1 + c] != null ? src[c1 - 1 + c] : '';
                line.push(value);
              }
              out.push(line);
            }
            return out;
          },
          setValue(value) {
            ensureRow(rows, r1);
            const line = rows[r1 - 1];
            while (line.length < c1) line.push('');
            line[c1 - 1] = value;
          },
        };
      },
      getDataRange() {
        return sheet.getRange(1, 1, Math.max(rows.length, 1), lastCol(rows));
      },
      appendRow(row) {
        rows.push(row.slice());
      },
      deleteRow(rowNumber) {
        rows.splice(rowNumber - 1, 1);
      },
      _rows: rows,
    };
    return sheet;
  }

  function seed(name, headers, dataRows) {
    const rows = [headers.slice()];
    (dataRows || []).forEach((row) => rows.push(row.slice()));
    sheets[name] = makeSheet(name, rows);
    return sheets[name];
  }

  const ss = {
    getSheetByName(name) { return sheets[name] || null; },
    insertSheet(name) {
      if (sheets[name]) throw new Error('sheet exists: ' + name);
      sheets[name] = makeSheet(name, []);
      return sheets[name];
    },
  };

  function formatDate(date, tz, fmt) {
    const d = new Date(date);
    const bag = {};
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(d).forEach((part) => { bag[part.type] = part.value; });
    const y = bag.year;
    const mNum = Number(bag.month);
    const dNum = Number(bag.day);
    const monthName = new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short' }).format(d);
    if (fmt === 'yyyy|M|d') return y + '|' + mNum + '|' + dNum;
    if (fmt === 'yyyy-MM-dd') {
      return y + '-' + String(mNum).padStart(2, '0') + '-' + String(dNum).padStart(2, '0');
    }
    if (fmt === 'MMM d, yyyy') return monthName + ' ' + dNum + ', ' + y;
    throw new Error('unsupported format ' + fmt);
  }

  const context = {
    console,
    B6_TEST_NOW: null,
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key) => (Object.prototype.hasOwnProperty.call(props, key) ? props[key] : null),
        setProperty: (key, value) => { props[key] = String(value); },
      }),
    },
    CacheService: {
      getScriptCache: () => ({
        get: (key) => {
          const hit = cache.get(key);
          if (!hit) return null;
          return hit.v;
        },
        put: (key, value) => { cache.set(key, { v: String(value) }); },
        remove: (key) => { cache.delete(key); },
      }),
    },
    LockService: {
      getScriptLock: () => ({
        waitLock() {
          if (lockHeld) throw new Error('lock busy');
          lockHeld = true;
        },
        tryLock() {
          if (lockHeld) return false;
          lockHeld = true;
          return true;
        },
        releaseLock() { lockHeld = false; },
      }),
    },
    MailApp: {
      sendEmail(msg) { emails.push({ to: msg.to, subject: msg.subject, body: msg.body }); },
    },
    Session: { getScriptTimeZone: () => 'America/Chicago' },
    ContentService: {
      MimeType: { JSON: 'JSON' },
      createTextOutput(text) {
        const out = {
          setMimeType() { return out; },
          getContent() { return text; },
        };
        return out;
      },
    },
    ScriptApp: {
      getProjectTriggers: () => [],
      deleteTrigger() {},
      newTrigger() {
        const chain = {
          timeBased() { return chain; },
          atHour() { return chain; },
          nearMinute() { return chain; },
          everyDays() { return chain; },
          create() { return {}; },
        };
        return chain;
      },
    },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      getUuid() {
        uuidN += 1;
        return '00000000-0000-4000-8000-' + String(uuidN).padStart(12, '0');
      },
      formatDate,
      computeDigest(alg, value) {
        const buf = crypto.createHash('sha256').update(toBuf(value)).digest();
        return Array.from(buf, (b) => (b > 127 ? b - 256 : b));
      },
      computeHmacSha256Signature(value, key) {
        const mac = crypto.createHmac('sha256', toBuf(key)).update(toBuf(value)).digest();
        return Array.from(mac, (b) => (b > 127 ? b - 256 : b));
      },
      base64Encode(data) {
        return toBuf(data).toString('base64');
      },
      base64Decode(text) {
        return Array.from(Buffer.from(String(text), 'base64'), (b) => (b > 127 ? b - 256 : b));
      },
    },
  };
  context.globalThis = context;

  const codePath = fileURLToPath(new URL('../apps-script/Code.gs', import.meta.url));
  const code = fs.readFileSync(codePath, 'utf8');
  vm.createContext(context);
  vm.runInContext(code, context, { filename: 'Code.gs' });
  context.PASSWORD_ITERATIONS = 200;

  function call(body) {
    const out = context.doPost({ postData: { contents: JSON.stringify(body || {}) } });
    return JSON.parse(out.getContent());
  }

  function resetSheets() {
    Object.keys(sheets).forEach((name) => { delete sheets[name]; });
    seed('Users', ['userId', 'name', 'email', 'role', 'store', 'active']);
    seed('Templates', ['templateId', 'name', 'description', 'createdByEmail', 'createdAt', 'appliesTo']);
    seed('Questions', ['questionId', 'templateId', 'order', 'section', 'text', 'type', 'options', 'points', 'todoIfImperfect', 'fullPointsAnswer']);
    seed('Audits', ['auditId', 'templateId', 'store', 'auditorEmail', 'startedAt', 'completedAt', 'score', 'maxScore']);
    seed('Answers', ['answerId', 'auditId', 'questionId', 'answer', 'pointsEarned', 'note', 'mediaUrls']);
    seed('Todos', ['todoId', 'auditId', 'questionId', 'title', 'details', 'assignedTo', 'assignedBy', 'store', 'dueDate', 'status', 'mediaUrls', 'createdAt', 'completedAt', 'lastDueDateChange']);
    emails.length = 0;
    cache.clear();
    lockHeld = false;
    context.B6_TEST_NOW = '2026-04-01T15:00:00.000Z';
  }

  resetSheets();
  props.BOOTSTRAP_SECRET = 'setup-phrase-for-tests-only';
  props.APP_URL = 'https://starpony999.github.io/b6-audit/';

  return { context, sheets, props, emails, cache, seed, call, resetSheets };
}

export function objectsFrom(sheet) {
  const rows = sheet._rows;
  const headers = rows[0].map((h) => String(h || '').trim());
  return rows.slice(1).filter((row) => row[0] !== '' && row[0] != null).map((row) => {
    const obj = {};
    headers.forEach((h, i) => { if (h) obj[h] = row[i]; });
    return obj;
  });
}
