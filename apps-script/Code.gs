/**
 * B6 Audit data service.
 *
 * Paste this whole file into the Apps Script editor as Code.gs.
 * The spreadsheet it is bound to is the database (tabs Users, Templates,
 * Questions, Audits, Answers, Todos, and Sessions created on first login).
 *
 * Deploy as a web app: Execute as me, Who has access: Anyone.
 * The phone page is the GitHub Pages site. This script only answers JSON.
 *
 * Passwords: PBKDF2-HMAC-SHA256, 5000 rounds, random 16-byte salt.
 * Apps Script has no bcrypt/scrypt/argon2. PBKDF2 is built from
 * Utilities.computeHmacSha256Signature. 5000 rounds is the practical amount
 * inside a web-app request (hundreds of thousands of rounds would time out).
 * The sheet stores salt, passwordHash, and passwordIterations. Never a password.
 * Sessions: random token returned to the phone; only its SHA-256 hash is stored
 * on the Sessions tab, with an expiry. Every call re-reads role, active, and
 * store access from Users. Login lockout is 8 failures, then 15 minutes.
 *
 * Photos/videos: short-lived S3 SigV4 URLs for a private Backblaze B2 bucket.
 * Keys live in Script Properties only. See README for CORS and key capabilities.
 */

var PASSWORD_ITERATIONS = 5000;
var PASSWORD_MIN_LENGTH = 10;
var SESSION_MS = 12 * 60 * 60 * 1000;
var LOGIN_MAX_FAILS = 8;
var LOGIN_LOCK_MS = 15 * 60 * 1000;
var MEDIA_MAX_IMAGE_BYTES = 4 * 1024 * 1024;
var MEDIA_MAX_VIDEO_BYTES = 8 * 1024 * 1024;
var MEDIA_MAX_PER_QUESTION = 5;
var MEDIA_MAX_SIGNATURES = 20;
var MEDIA_PUT_SECONDS = 600;
var MEDIA_GET_SECONDS = 900;
var TODO_DEFAULT_DUE_DAYS = 30;
var TODO_REMINDER_LEAD_DAYS = 7;
var MAX_BODY_CHARS = 200000;

var PROP_APP_URL = 'APP_URL';
var PROP_BOOTSTRAP = 'BOOTSTRAP_SECRET';
var PROP_B2_KEY_ID = 'B2_KEY_ID';
var PROP_B2_APP_KEY = 'B2_APPLICATION_KEY';
var PROP_B2_BUCKET = 'B2_BUCKET';
var PROP_B2_ENDPOINT = 'B2_ENDPOINT';
var PROP_B2_REGION = 'B2_REGION';

var USER_AUTH_COLUMNS = [
  'passwordHash',
  'salt',
  'passwordIterations',
  'mustChangePassword',
  'failedLoginCount',
  'lockedUntil'
];
var TODO_MARKER_COLUMNS = [
  'assignmentNotifiedAt',
  'reminderDueSoonSentOn',
  'reminderDueDaySentOn'
];

var PHYSICAL_STORE_CODES = ['WPR', 'CPR', 'WZ', 'SPZ'];
var PHYSICAL_STORE_LABELS = {
  WPR: 'Pizza Ranch Wentzville',
  CPR: 'Pizza Ranch Cottleville',
  WZ: "Ziggi's Coffee Wentzville",
  SPZ: "Ziggi's Coffee St. Peters"
};
var TEMPLATE_SCOPE_ALL = 'ALL';
var TEMPLATE_SCOPE_RANCH = 'RANCH';
var TEMPLATE_SCOPE_ZIGGIS = 'ZIGGIS';
var RANCH_STORES = ['WPR', 'CPR'];
var ZIGGIS_STORES = ['WZ', 'SPZ'];
var TODO_RULE_OFF = 'OFF';
var YESNO_FULL_DEFAULT = 'yes';
var DUMMY_SALT_B64 = 'AAAAAAAAAAAAAAAAAAAAAA==';
var DUMMY_EXPECTED_B64 = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

/** Tests set this to a date string or ms. Leave null in production. */
var B6_TEST_NOW = null;

function now_() {
  if (B6_TEST_NOW) return new Date(B6_TEST_NOW);
  return new Date();
}

function fail_(message, code) {
  var err = new Error(message);
  err.code = code || 'error';
  return err;
}

function doGet() {
  return respond_({
    ok: true,
    service: 'b6-audit',
    message: 'B6 Audit data service. The app page is on GitHub Pages. Send POST JSON with an action name.'
  });
}

function doPost(e) {
  try {
    var raw = (e && e.postData && e.postData.contents) || '';
    if (raw.length > MAX_BODY_CHARS) {
      return respond_({ ok: false, error: 'too-large', message: 'That request was too large.' });
    }
    var body = raw ? JSON.parse(raw) : {};
    return respond_(withLock_(function () { return dispatch_(body || {}); }));
  } catch (err) {
    if (err && err.code) return respond_(publicError_(err));
    var message = 'The app sent something this script could not read.';
    if (err && err.message && String(err.message).indexOf('busy') !== -1) {
      message = err.message;
    }
    return respond_({ ok: false, error: 'bad-json', message: message });
  }
}

function respond_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function publicError_(err) {
  var message = (err && err.message) ? String(err.message) : 'Something went wrong.';
  var code = (err && err.code) ? String(err.code) : 'error';
  try { console.error(code + ': ' + message); } catch (e) {}
  return { ok: false, error: code, message: message };
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (err) {
    throw fail_('The app is busy. Wait a moment and try again.', 'busy');
  }
  try {
    return fn();
  } finally {
    try { lock.releaseLock(); } catch (e2) {}
  }
}

function dispatch_(body) {
  var action = String(body.action || '').trim();
  try {
    if (!action || action === 'ping') {
      return {
        ok: true,
        service: 'b6-audit',
        message: 'B6 Audit data service is running.'
      };
    }
    if (action === 'login') return login_(body);
    if (action === 'bootstrapAdmin') return bootstrapAdmin_(body);
    if (action === 'logout') return logout_(body);

    var user = requireUser_(body);
    if (action === 'me') {
      return { ok: true, user: toPublicUser_(user), stores: listMyStores_(user) };
    }
    if (action === 'changeOwnPassword') return changeOwnPassword_(body, user);

    if (isTruthyActive_(user.mustChangePassword)) {
      throw fail_('Choose a new password before continuing.', 'must-change-password');
    }

    if (action === 'listTemplatesForStore') return listTemplatesForStore_(body, user);
    if (action === 'beginAudit') return beginAudit_(body, user);
    if (action === 'submitAuditAnswers') return submitAudit_(body, user);
    if (action === 'listEligibleAssignees') return listAssignees_(body, user);
    if (action === 'createTodosFromReview') return createTodos_(body, user);
    if (action === 'listMyTodos') return { ok: true, todos: listMyTodos_(user) };
    if (action === 'updateTodoDueDate') return updateDue_(body, user);
    if (action === 'markTodoDone') return markDone_(body, user);
    if (action === 'signMediaUpload') return signUpload_(body, user);
    if (action === 'signMediaRead') return signRead_(body, user);

    if (action === 'getBuilderHome') return builderHome_(requireAdmin_(user));
    if (action === 'ensureSchema') return ensureSchema_(requireAdmin_(user));
    if (action === 'createTemplate') return createTemplateAction_(body, requireAdmin_(user));
    if (action === 'updateTemplateMeta') return updateMeta_(body, requireAdmin_(user));
    if (action === 'listBuilderQuestions') return listBuilderQs_(body, requireAdmin_(user));
    if (action === 'addBuilderQuestion') return addBuilderQ_(body, requireAdmin_(user));
    if (action === 'updateBuilderQuestion') return updateBuilderQ_(body, requireAdmin_(user));
    if (action === 'saveAllBuilderTemplate') return saveAll_(body, requireAdmin_(user));
    if (action === 'getPastDueReport') return pastDue_(requireAdmin_(user));
    if (action === 'listUsers') {
      requireAdmin_(user);
      return { ok: true, users: listUsers().map(toAdminUser_) };
    }
    if (action === 'addUser') return addUserAction_(body, requireAdmin_(user));
    if (action === 'resetUserPassword') return resetPassword_(body, requireAdmin_(user));
    if (action === 'setUserActive') return setActive_(body, requireAdmin_(user));

    throw fail_('Unknown action.', 'unknown-action');
  } catch (err) {
    return publicError_(err);
  }
}

// --- sheets ---

function getSheet_(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) throw fail_('Missing sheet tab: ' + name, 'schema');
  return sheet;
}

function trimHeaders_(headerRow) {
  return (headerRow || []).map(function (h) {
    return String(h == null ? '' : h).trim();
  });
}

function ensureColumn_(sheet, headerName) {
  var lastCol = Math.max(sheet.getLastColumn(), 1);
  var headers = trimHeaders_(sheet.getRange(1, 1, 1, lastCol).getValues()[0]);
  var name = String(headerName).trim();
  var existing = headers.indexOf(name);
  if (existing >= 0) return existing;
  var newCol = headers.length + 1;
  sheet.getRange(1, newCol).setValue(name);
  return newCol - 1;
}

function ensureNamedColumns_(sheetName, names) {
  var sheet = getSheet_(sheetName);
  var added = [];
  names.forEach(function (name) {
    var lastCol = Math.max(sheet.getLastColumn(), 1);
    var headers = trimHeaders_(sheet.getRange(1, 1, 1, lastCol).getValues()[0]);
    if (headers.indexOf(name) === -1) {
      ensureColumn_(sheet, name);
      added.push(sheetName + '.' + name);
    }
  });
  return added;
}

function ensureSessionsSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Sessions');
  if (sheet) return { created: false, added: [] };
  sheet = ss.insertSheet('Sessions');
  sheet.appendRow(['tokenHash', 'userId', 'expiresAt', 'createdAt', 'revoked']);
  return { created: true, added: ['Sessions tab'] };
}

function appendRowByHeaders_(sheet, valuesByHeader) {
  var lastCol = Math.max(sheet.getLastColumn(), 1);
  var headers = trimHeaders_(sheet.getRange(1, 1, 1, lastCol).getValues()[0]);
  Object.keys(valuesByHeader).forEach(function (key) {
    if (headers.indexOf(key) === -1) ensureColumn_(sheet, key);
  });
  var refreshedLast = Math.max(sheet.getLastColumn(), 1);
  headers = trimHeaders_(sheet.getRange(1, 1, 1, refreshedLast).getValues()[0]);
  var row = headers.map(function (h) {
    if (!h || !Object.prototype.hasOwnProperty.call(valuesByHeader, h)) return '';
    var v = valuesByHeader[h];
    return v === undefined || v === null ? '' : v;
  });
  sheet.appendRow(row);
}

function sheetIndex_(sheet) {
  var data = sheet.getDataRange().getValues();
  if (!data.length) data = [[]];
  var headers = trimHeaders_(data[0]);
  var map = {};
  headers.forEach(function (h, i) { if (h) map[h] = i; });
  return { sheet: sheet, data: data, headers: headers, map: map };
}

function writeCell_(info, rowIndex0, headerName, value) {
  var col = info.map[headerName];
  if (col == null) throw fail_('Missing column ' + headerName + ' on ' + info.sheet.getName() + '.', 'schema');
  info.sheet.getRange(rowIndex0 + 1, col + 1).setValue(value);
  if (!info.data[rowIndex0]) info.data[rowIndex0] = [];
  info.data[rowIndex0][col] = value;
}

function serializeValue_(value) {
  if (value instanceof Date || Object.prototype.toString.call(value) === '[object Date]') {
    try { return value.toISOString(); } catch (err) { return String(value); }
  }
  if (value && typeof value === 'object' && typeof value.getTime === 'function') {
    try {
      var ms = value.getTime();
      if (typeof ms === 'number' && isFinite(ms)) return new Date(ms).toISOString();
    } catch (err2) {}
  }
  return value;
}

function rowsToObjects_(sheet) {
  var data = sheet.getDataRange().getValues();
  if (!data.length) return [];
  var headers = trimHeaders_(data[0]);
  var rows = [];
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    if (row[0] === '' || row[0] == null) continue;
    var obj = {};
    for (var c = 0; c < headers.length; c++) {
      if (!headers[c]) continue;
      obj[headers[c]] = serializeValue_(row[c]);
    }
    rows.push(obj);
  }
  return rows;
}

function isTruthyActive_(value) {
  if (value === true || value === 1) return true;
  return String(value == null ? '' : value).trim().toLowerCase() === 'true';
}

// --- calendar (script timezone, default America/Chicago) ---

function getScriptTimeZone_() {
  try {
    var tz = Session.getScriptTimeZone();
    if (tz) return tz;
  } catch (err) {}
  return 'America/Chicago';
}

function calendarDayPartsFromDate_(dateObj) {
  var tz = getScriptTimeZone_();
  var raw = Utilities.formatDate(dateObj, tz, 'yyyy|M|d');
  var p = String(raw).split('|');
  return {
    y: Number(p[0]),
    m: Number(p[1]),
    d: Number(p[2]),
    key: Utilities.formatDate(dateObj, tz, 'yyyy-MM-dd'),
    tz: tz
  };
}

function calendarTodayParts_() {
  return calendarDayPartsFromDate_(now_());
}

function parseDueCalendarDay_(value) {
  if (value === null || value === undefined || value === '') return null;
  if (Object.prototype.toString.call(value) === '[object Date]' ||
      (value && typeof value === 'object' && typeof value.getTime === 'function')) {
    try {
      var ms = value.getTime();
      if (typeof ms === 'number' && isFinite(ms) && !isNaN(ms)) {
        return calendarDayPartsFromDate_(new Date(ms));
      }
    } catch (err) {}
    return null;
  }
  var s = String(value).trim();
  if (!s) return null;
  var dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (dateOnly) {
    var y = Number(dateOnly[1]);
    var mo = Number(dateOnly[2]);
    var d = Number(dateOnly[3]);
    if (!y || !mo || !d) return null;
    return { y: y, m: mo, d: d, key: s, tz: getScriptTimeZone_() };
  }
  var stamped = /^(\d{4})-(\d{2})-(\d{2})[T\s]/.exec(s);
  if (stamped) {
    var parsedIso = new Date(s);
    if (!isNaN(parsedIso.getTime())) return calendarDayPartsFromDate_(parsedIso);
    return null;
  }
  var mdy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (mdy) {
    var mo2 = Number(mdy[1]);
    var d2 = Number(mdy[2]);
    var y2 = Number(mdy[3]);
    var key = y2 + '-' + (mo2 < 10 ? '0' : '') + mo2 + '-' + (d2 < 10 ? '0' : '') + d2;
    return { y: y2, m: mo2, d: d2, key: key, tz: getScriptTimeZone_() };
  }
  var parsed = new Date(s);
  if (!isNaN(parsed.getTime())) return calendarDayPartsFromDate_(parsed);
  return null;
}

function daysFromToCalendar_(fromParts, toParts) {
  if (!fromParts || !toParts) return null;
  var a = Date.UTC(fromParts.y, fromParts.m - 1, fromParts.d);
  var b = Date.UTC(toParts.y, toParts.m - 1, toParts.d);
  return Math.round((b - a) / 86400000);
}

function dateFromCalendarParts_(parts) {
  return new Date(parts.y, parts.m - 1, parts.d);
}

function addCalendarDaysKey_(parts, days) {
  var dt = new Date(Date.UTC(parts.y, parts.m - 1, parts.d));
  dt.setUTCDate(dt.getUTCDate() + days);
  var y = dt.getUTCFullYear();
  var m = dt.getUTCMonth() + 1;
  var d = dt.getUTCDate();
  var mm = (m < 10 ? '0' : '') + m;
  var dd = (d < 10 ? '0' : '') + d;
  return { y: y, m: m, d: d, key: y + '-' + mm + '-' + dd, tz: parts.tz || getScriptTimeZone_() };
}

function defaultTodoDueDateParts_() {
  return addCalendarDaysKey_(calendarTodayParts_(), TODO_DEFAULT_DUE_DAYS);
}

function formatDueLabel_(parts) {
  if (!parts) return '(no due date)';
  return Utilities.formatDate(dateFromCalendarParts_(parts), getScriptTimeZone_(), 'MMM d, yyyy');
}

function resolveTodoDueKey_(rawDue) {
  var s = String(rawDue == null ? '' : rawDue).trim();
  if (!s) return defaultTodoDueDateParts_().key;
  var parts = parseDueCalendarDay_(s);
  if (!parts) return defaultTodoDueDateParts_().key;
  return parts.key;
}

function markerAlreadySentOn_(rawMarker, todayKey) {
  var day = parseDueCalendarDay_(rawMarker);
  return !!(day && day.key === todayKey);
}

// --- crypto helpers (bytes are unsigned 0-255 inside this file) ---

function u8_(b) {
  var n = Number(b) || 0;
  n = n % 256;
  if (n < 0) n += 256;
  return n;
}

function toSignedBytes_(unsigned) {
  var out = [];
  for (var i = 0; i < unsigned.length; i++) {
    var b = u8_(unsigned[i]);
    out.push(b > 127 ? b - 256 : b);
  }
  return out;
}

function fromSignedBytes_(signed) {
  var out = [];
  for (var i = 0; i < signed.length; i++) out.push(u8_(signed[i]));
  return out;
}

function utf8Bytes_(str) {
  var s = String(str);
  var out = [];
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    if (c < 0x80) {
      out.push(c);
    } else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c >= 0xd800 && c <= 0xdbff) {
      var c2 = s.charCodeAt(++i);
      var u = ((c - 0xd800) << 10) + (c2 - 0xdc00) + 0x10000;
      out.push(0xf0 | (u >> 18), 0x80 | ((u >> 12) & 0x3f), 0x80 | ((u >> 6) & 0x3f), 0x80 | (u & 0x3f));
    } else {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return out;
}

function hmacSha256_(key, message) {
  var keyBytes = typeof key === 'string' ? utf8Bytes_(key) : key;
  var msgBytes = typeof message === 'string' ? utf8Bytes_(message) : message;
  var signed = Utilities.computeHmacSha256Signature(toSignedBytes_(msgBytes), toSignedBytes_(keyBytes));
  return fromSignedBytes_(signed);
}

function sha256Hex_(text) {
  var raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(text));
  return hexFromBytes_(fromSignedBytes_(raw));
}

function hexFromBytes_(bytes) {
  var hex = '';
  for (var i = 0; i < bytes.length; i++) {
    var s = bytes[i].toString(16);
    if (s.length < 2) s = '0' + s;
    hex += s;
  }
  return hex;
}

function bytesToBase64_(unsigned) {
  return Utilities.base64Encode(toSignedBytes_(unsigned));
}

function base64ToBytes_(b64) {
  return fromSignedBytes_(Utilities.base64Decode(String(b64 || '')));
}

function randomBytes_(n) {
  var out = [];
  var guard = 0;
  while (out.length < n && guard < 16) {
    guard++;
    var material = Utilities.getUuid() + '|' + Utilities.getUuid() + '|' + now_().getTime() + '|' + out.length + '|' + guard;
    var digest = fromSignedBytes_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, material));
    for (var i = 0; i < digest.length && out.length < n; i++) out.push(digest[i]);
  }
  return out;
}

function pbkdf2HmacSha256_(password, saltUnsigned, iterations, dkLen) {
  var rounds = Number(iterations) || PASSWORD_ITERATIONS;
  var blocksNeeded = Math.ceil(dkLen / 32);
  var out = [];
  for (var blockIndex = 1; blockIndex <= blocksNeeded; blockIndex++) {
    var saltBlock = saltUnsigned.concat([
      (blockIndex >>> 24) & 255,
      (blockIndex >>> 16) & 255,
      (blockIndex >>> 8) & 255,
      blockIndex & 255
    ]);
    var u = hmacSha256_(utf8Bytes_(password), saltBlock);
    var t = u.slice();
    for (var i = 1; i < rounds; i++) {
      u = hmacSha256_(utf8Bytes_(password), u);
      for (var k = 0; k < t.length; k++) t[k] = t[k] ^ u[k];
    }
    for (var j = 0; j < t.length && out.length < dkLen; j++) out.push(t[j]);
  }
  return out;
}

function hashPassword_(password, saltB64, iterations) {
  var salt = base64ToBytes_(saltB64);
  var dk = pbkdf2HmacSha256_(String(password), salt, iterations, 32);
  return bytesToBase64_(dk);
}

function newSaltB64_() {
  return bytesToBase64_(randomBytes_(16));
}

function safeEqual_(a, b) {
  var x = String(a);
  var y = String(b);
  var n = Math.max(x.length, y.length);
  var diff = x.length === y.length ? 0 : 1;
  for (var i = 0; i < n; i++) {
    var ca = i < x.length ? x.charCodeAt(i) : 0;
    var cb = i < y.length ? y.charCodeAt(i) : 0;
    diff |= (ca ^ cb);
  }
  return diff === 0;
}

function normalizeNewPassword_(password) {
  var p = String(password == null ? '' : password);
  if (p.length > 200) throw fail_('That password is too long.', 'bad-password');
  if (p.length < PASSWORD_MIN_LENGTH) {
    throw fail_('Use at least ' + PASSWORD_MIN_LENGTH + ' characters.', 'bad-password');
  }
  if (/^\s|\s$/.test(p)) throw fail_('Do not start or end the password with a space.', 'bad-password');
  return p;
}

function temporaryPassword_() {
  var alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  var bytes = randomBytes_(18);
  var out = '';
  for (var i = 0; i < bytes.length; i++) out += alphabet.charAt(bytes[i] % alphabet.length);
  return out;
}

// --- SigV4 presign (S3 / Backblaze B2) ---

function awsUriEncode_(value, encodeSlash) {
  var str = String(value);
  var out = '';
  for (var i = 0; i < str.length; i++) {
    var ch = str.charAt(i);
    if (/[A-Za-z0-9\-_.~]/.test(ch)) out += ch;
    else if (!encodeSlash && ch === '/') out += ch;
    else {
      var hex = ch.charCodeAt(0).toString(16).toUpperCase();
      if (hex.length < 2) hex = '0' + hex;
      out += '%' + hex;
    }
  }
  return out;
}

function canonicalQuery_(pairs) {
  var items = pairs.map(function (p) {
    return [awsUriEncode_(p[0], true), awsUriEncode_(String(p[1]), true)];
  });
  items.sort(function (a, b) {
    if (a[0] < b[0]) return -1;
    if (a[0] > b[0]) return 1;
    if (a[1] < b[1]) return -1;
    if (a[1] > b[1]) return 1;
    return 0;
  });
  return items.map(function (p) { return p[0] + '=' + p[1]; }).join('&');
}

function signingKey_(secret, dateStamp, region, service) {
  var kDate = hmacSha256_('AWS4' + secret, dateStamp);
  var kRegion = hmacSha256_(kDate, region);
  var kService = hmacSha256_(kRegion, service);
  return hmacSha256_(kService, 'aws4_request');
}

/**
 * Build a presigned URL. opts.canonicalUri must already be encoded (/test.txt).
 * contentType, when set, is a signed header so the browser must send it on PUT.
 */
function buildPresignedUrl_(opts) {
  var method = String(opts.method || 'GET').toUpperCase();
  var host = String(opts.host);
  var canonicalUri = String(opts.canonicalUri || '/');
  if (canonicalUri.charAt(0) !== '/') canonicalUri = '/' + canonicalUri;
  var region = String(opts.region);
  var accessKeyId = String(opts.accessKeyId);
  var secret = String(opts.secretAccessKey);
  var expires = String(opts.expiresSeconds);
  var amzDate = String(opts.amzDate);
  var dateStamp = String(opts.dateStamp);
  var contentType = opts.contentType ? String(opts.contentType).trim() : '';
  var service = opts.service || 's3';
  var credential = accessKeyId + '/' + dateStamp + '/' + region + '/' + service + '/aws4_request';
  var signedHeaderNames = contentType ? ['content-type', 'host'] : ['host'];
  var signedHeaders = signedHeaderNames.join(';');
  var canonicalQuery = canonicalQuery_([
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', credential],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', expires],
    ['X-Amz-SignedHeaders', signedHeaders]
  ]);
  var canonicalHeaders = '';
  if (contentType) canonicalHeaders += 'content-type:' + contentType + '\n';
  canonicalHeaders += 'host:' + host + '\n';
  var canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    'UNSIGNED-PAYLOAD'
  ].join('\n');
  var hash = sha256Hex_(canonicalRequest);
  var scope = dateStamp + '/' + region + '/' + service + '/aws4_request';
  var stringToSign = 'AWS4-HMAC-SHA256\n' + amzDate + '\n' + scope + '\n' + hash;
  var signature = hexFromBytes_(hmacSha256_(signingKey_(secret, dateStamp, region, service), stringToSign));
  return {
    url: 'https://' + host + canonicalUri + '?' + canonicalQuery + '&X-Amz-Signature=' + signature,
    signature: signature,
    canonicalRequest: canonicalRequest,
    stringToSign: stringToSign,
    signedHeaders: signedHeaders
  };
}

function canonicalUriForKey_(objectKey) {
  var parts = String(objectKey).split('/').map(function (seg) {
    return awsUriEncode_(seg, true);
  });
  return '/' + parts.join('/');
}

function amzDates_(date) {
  var iso = date.toISOString();
  var amz = iso.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return { amzDate: amz, dateStamp: amz.substring(0, 8) };
}

// --- users, sessions, login ---

function normalizeEmailKey_(email) {
  return String(email || '').toLowerCase().trim();
}

function normalizeRole_(role) {
  var r = String(role || '').toLowerCase().trim();
  if (r === 'admin' || r === 'gm' || r === 'manager') return r;
  throw fail_('Role must be admin, gm, or manager.', 'bad-role');
}

function isAdmin_(user) {
  return String(user && user.role || '').toLowerCase().trim() === 'admin';
}

function listUsers() {
  return rowsToObjects_(getSheet_('Users'));
}

function findUserByEmail_(email) {
  var needle = normalizeEmailKey_(email);
  if (!needle) return null;
  var users = listUsers();
  for (var i = 0; i < users.length; i++) {
    if (normalizeEmailKey_(users[i].email) === needle) return users[i];
  }
  return null;
}

function findUserById_(userId) {
  var id = String(userId || '');
  var users = listUsers();
  for (var i = 0; i < users.length; i++) {
    if (String(users[i].userId) === id) return users[i];
  }
  return null;
}

function toPublicUser_(u) {
  return {
    userId: String(u.userId || ''),
    name: String(u.name || ''),
    email: String(u.email || ''),
    role: String(u.role || ''),
    store: String(u.store || ''),
    active: isTruthyActive_(u.active),
    mustChangePassword: isTruthyActive_(u.mustChangePassword)
  };
}

function toAdminUser_(u) {
  var pub = toPublicUser_(u);
  pub.hasPassword = !!String(u.passwordHash || '').trim();
  pub.locked = userLockActive_(u);
  return pub;
}

function userLockActive_(user) {
  if (!user || !user.lockedUntil) return false;
  var t = new Date(user.lockedUntil).getTime();
  return isFinite(t) && t > now_().getTime();
}

function setUserFields_(userId, fields) {
  ensureNamedColumns_('Users', USER_AUTH_COLUMNS);
  var info = sheetIndex_(getSheet_('Users'));
  var idCol = info.map.userId;
  if (idCol == null) throw fail_('Users sheet is missing userId.', 'schema');
  for (var i = 1; i < info.data.length; i++) {
    if (String(info.data[i][idCol]) !== String(userId)) continue;
    Object.keys(fields).forEach(function (name) {
      if (info.map[name] == null) {
        ensureColumn_(info.sheet, name);
        info = sheetIndex_(info.sheet);
      }
      writeCell_(info, i, name, fields[name]);
    });
    return;
  }
  throw fail_('User not found.', 'not-found');
}

function failKey_(email) {
  return 'loginfail:' + (normalizeEmailKey_(email) || '(blank)');
}

function readFailState_(email) {
  var raw = null;
  try { raw = CacheService.getScriptCache().get(failKey_(email)); } catch (err) { raw = null; }
  if (!raw) return { count: 0, lockUntil: 0 };
  try {
    var parsed = JSON.parse(raw);
    return { count: Number(parsed.count) || 0, lockUntil: Number(parsed.lockUntil) || 0 };
  } catch (err2) {
    return { count: 0, lockUntil: 0 };
  }
}

function writeFailState_(email, state) {
  try {
    CacheService.getScriptCache().put(failKey_(email), JSON.stringify(state), 21600);
  } catch (err) {}
}

function clearFailState_(email) {
  try { CacheService.getScriptCache().remove(failKey_(email)); } catch (err) {}
}

function cacheLockActive_(email) {
  var state = readFailState_(email);
  return !!(state.lockUntil && state.lockUntil > now_().getTime());
}

function noteLoginFailure_(email, user, lockedMessage, failMessage) {
  var state = readFailState_(email);
  if (state.lockUntil && state.lockUntil <= now_().getTime()) state = { count: 0, lockUntil: 0 };
  state.count += 1;
  var locked = state.count >= LOGIN_MAX_FAILS;
  if (locked) state.lockUntil = now_().getTime() + LOGIN_LOCK_MS;
  writeFailState_(email, state);
  if (user) {
    var count = Number(user.failedLoginCount) || 0;
    if (user.lockedUntil && !userLockActive_(user)) count = 0;
    count += 1;
    var fields = { failedLoginCount: count };
    if (count >= LOGIN_MAX_FAILS) fields.lockedUntil = new Date(now_().getTime() + LOGIN_LOCK_MS).toISOString();
    try { setUserFields_(user.userId, fields); } catch (err) {}
    if (count >= LOGIN_MAX_FAILS) locked = true;
  }
  if (locked) {
    throw fail_(lockedMessage || 'Too many sign-in attempts. Wait 15 minutes and try again.', 'locked');
  }
  throw fail_(failMessage || 'Email or password is incorrect.', 'bad-login');
}

function assertLoginAllowed_(email, user, lockedMessage) {
  if (cacheLockActive_(email) || userLockActive_(user)) {
    throw fail_(lockedMessage || 'Too many sign-in attempts. Wait 15 minutes and try again.', 'locked');
  }
}

function clearLoginFailures_(email, user) {
  clearFailState_(email);
  if (user && (Number(user.failedLoginCount) || user.lockedUntil)) {
    try { setUserFields_(user.userId, { failedLoginCount: 0, lockedUntil: '' }); } catch (err) {}
  }
}

function iterationsFor_(user) {
  var n = Number(user && user.passwordIterations);
  if (!n || n < 1 || n > 20000) return PASSWORD_ITERATIONS;
  return n;
}

function purgeExpiredSessions_() {
  var sheet = getSheet_('Sessions');
  var data = sheet.getDataRange().getValues();
  if (!data || data.length < 2) return;
  var headers = trimHeaders_(data[0]);
  var expCol = headers.indexOf('expiresAt');
  var revCol = headers.indexOf('revoked');
  if (expCol < 0) return;
  var now = now_().getTime();
  for (var i = data.length - 1; i >= 1; i--) {
    var exp = new Date(data[i][expCol]).getTime();
    var revoked = revCol >= 0 && isTruthyActive_(data[i][revCol]);
    if (revoked || !isFinite(exp) || exp <= now) sheet.deleteRow(i + 1);
  }
}

function issueSession_(userId) {
  ensureSessionsSheet_();
  purgeExpiredSessions_();
  var token = bytesToBase64_(randomBytes_(32)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  var tokenHash = sha256Hex_(token);
  var created = now_();
  var exp = new Date(created.getTime() + SESSION_MS);
  appendRowByHeaders_(getSheet_('Sessions'), {
    tokenHash: tokenHash,
    userId: String(userId),
    expiresAt: exp.toISOString(),
    createdAt: created.toISOString(),
    revoked: false
  });
  return { token: token, expiresAt: exp.toISOString() };
}

function findSessionRow_(tokenHash) {
  ensureSessionsSheet_();
  var info = sheetIndex_(getSheet_('Sessions'));
  var col = info.map.tokenHash;
  if (col == null) return null;
  for (var i = 1; i < info.data.length; i++) {
    if (String(info.data[i][col]) === tokenHash) return { info: info, index: i };
  }
  return null;
}

function sessionRecordFromRow_(info, index) {
  var obj = {};
  info.headers.forEach(function (h, c) {
    if (!h) return;
    obj[h] = info.data[index][c];
  });
  return obj;
}

function requireSession_(token) {
  var raw = String(token || '').trim();
  if (!raw) throw fail_('Sign in required.', 'unauthorized');
  var found = findSessionRow_(sha256Hex_(raw));
  if (!found) throw fail_('Sign in required.', 'unauthorized');
  var rec = sessionRecordFromRow_(found.info, found.index);
  if (isTruthyActive_(rec.revoked)) throw fail_('Sign in required.', 'unauthorized');
  var exp = new Date(rec.expiresAt);
  if (!rec.expiresAt || isNaN(exp.getTime()) || exp.getTime() <= now_().getTime()) {
    throw fail_('Your session expired. Sign in again.', 'session-expired');
  }
  return rec;
}

function requireUser_(body) {
  var session = requireSession_(body && body.token);
  var user = findUserById_(session.userId);
  if (!user || !isTruthyActive_(user.active)) {
    throw fail_('Your account is inactive.', 'unauthorized');
  }
  return user;
}

function logout_(body) {
  var raw = String(body && body.token || '').trim();
  if (!raw) return { ok: true };
  var found = null;
  try { found = findSessionRow_(sha256Hex_(raw)); } catch (err) { found = null; }
  if (found && found.info.map.revoked != null) {
    writeCell_(found.info, found.index, 'revoked', true);
  }
  return { ok: true };
}

function anyPasswordSet_() {
  var users = listUsers();
  for (var i = 0; i < users.length; i++) {
    if (String(users[i].passwordHash || '').trim()) return true;
  }
  return false;
}

function login_(body) {
  ensureNamedColumns_('Users', USER_AUTH_COLUMNS);
  ensureSessionsSheet_();
  var email = String(body.email || '');
  var password = String(body.password || '');
  var user = findUserByEmail_(email);
  assertLoginAllowed_(email, user);
  if (password.length > 200) {
    noteLoginFailure_(email, user);
  }
  var rounds = user ? iterationsFor_(user) : PASSWORD_ITERATIONS;
  var salt = user && user.salt ? String(user.salt) : DUMMY_SALT_B64;
  var computed = hashPassword_(password, salt, rounds);
  var expected = user && user.passwordHash ? String(user.passwordHash) : DUMMY_EXPECTED_B64;
  var match = !!(user && user.passwordHash && safeEqual_(computed, expected));
  if (!match) noteLoginFailure_(email, user);
  clearLoginFailures_(email, user);
  if (Number(user.passwordIterations) !== PASSWORD_ITERATIONS) {
    try {
      var freshSalt = newSaltB64_();
      setUserFields_(user.userId, {
        salt: freshSalt,
        passwordHash: hashPassword_(password, freshSalt, PASSWORD_ITERATIONS),
        passwordIterations: PASSWORD_ITERATIONS
      });
    } catch (err) {}
  }
  var session = issueSession_(user.userId);
  var fresh = findUserById_(user.userId) || user;
  return {
    ok: true,
    token: session.token,
    expiresAt: session.expiresAt,
    mustChangePassword: isTruthyActive_(fresh.mustChangePassword),
    user: toPublicUser_(fresh),
    stores: listMyStores_(fresh)
  };
}

function bootstrapAdmin_(body) {
  ensureNamedColumns_('Users', USER_AUTH_COLUMNS);
  ensureSessionsSheet_();
  var props = PropertiesService.getScriptProperties();
  var secret = String(props.getProperty(PROP_BOOTSTRAP) || '');
  if (!secret) {
    throw fail_(
      'First-admin setup is not turned on. In Apps Script → Project Settings → Script properties, add BOOTSTRAP_SECRET with a long phrase only you know. Deploy a new version, create the admin, then delete that property.',
      'bootstrap-off'
    );
  }
  var setupLocked = 'Too many setup attempts. Wait 15 minutes and try again.';
  assertLoginAllowed_('__bootstrap__', null, setupLocked);
  if (!safeEqual_(String(body.bootstrapSecret || ''), secret)) {
    noteLoginFailure_('__bootstrap__', null, setupLocked, 'That setup phrase does not match.');
  }
  clearFailState_('__bootstrap__');
  if (anyPasswordSet_()) {
    throw fail_('An account already has a password. Sign in, or ask an admin to reset a password.', 'bootstrap-closed');
  }
  var name = normalizeRequiredText_(body.name, 'Name');
  var email = normalizeEmailKey_(body.email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw fail_('Enter a real email address.', 'bad-email');
  var password = normalizeNewPassword_(body.password);
  if (String(body.passwordConfirm || '') !== password) {
    throw fail_('The two passwords do not match.', 'bad-password');
  }
  var salt = newSaltB64_();
  var hash = hashPassword_(password, salt, PASSWORD_ITERATIONS);
  var existing = findUserByEmail_(email);
  var userId;
  if (existing) {
    userId = existing.userId;
    setUserFields_(userId, {
      name: name,
      role: 'admin',
      active: true,
      salt: salt,
      passwordHash: hash,
      passwordIterations: PASSWORD_ITERATIONS,
      mustChangePassword: false,
      failedLoginCount: 0,
      lockedUntil: ''
    });
  } else {
    userId = Utilities.getUuid();
    var store = 'ALL';
    try { store = normalizeAppliesToValue_(body.store || 'ALL'); } catch (err) { store = 'ALL'; }
    appendRowByHeaders_(getSheet_('Users'), {
      userId: userId,
      name: name,
      email: email,
      role: 'admin',
      store: store,
      active: true,
      passwordHash: hash,
      salt: salt,
      passwordIterations: PASSWORD_ITERATIONS,
      mustChangePassword: false,
      failedLoginCount: 0,
      lockedUntil: ''
    });
  }
  var session = issueSession_(userId);
  var user = findUserById_(userId);
  return {
    ok: true,
    token: session.token,
    expiresAt: session.expiresAt,
    mustChangePassword: false,
    user: toPublicUser_(user),
    stores: listMyStores_(user),
    message: 'Admin account ready. Delete the BOOTSTRAP_SECRET script property when you are done.'
  };
}

function changeOwnPassword_(body, user) {
  var current = String(body.currentPassword || '');
  if (current.length > 200) throw fail_('Email or password is incorrect.', 'bad-login');
  var rounds = iterationsFor_(user);
  var computed = hashPassword_(current, String(user.salt || DUMMY_SALT_B64), rounds);
  if (!user.passwordHash || !safeEqual_(computed, String(user.passwordHash))) {
    throw fail_('The current password is incorrect.', 'bad-login');
  }
  var next = normalizeNewPassword_(body.newPassword);
  if (String(body.passwordConfirm || '') !== next) throw fail_('The two passwords do not match.', 'bad-password');
  if (safeEqual_(next, current)) throw fail_('Choose a different password than the one you have now.', 'bad-password');
  var salt = newSaltB64_();
  setUserFields_(user.userId, {
    salt: salt,
    passwordHash: hashPassword_(next, salt, PASSWORD_ITERATIONS),
    passwordIterations: PASSWORD_ITERATIONS,
    mustChangePassword: false,
    failedLoginCount: 0,
    lockedUntil: ''
  });
  return { ok: true, user: toPublicUser_(findUserById_(user.userId)) };
}

function addUserAction_(body, admin) {
  var name = normalizeRequiredText_(body.name, 'Name');
  var email = normalizeEmailKey_(body.email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw fail_('Enter a real email address.', 'bad-email');
  if (findUserByEmail_(email)) throw fail_('That email is already in Users.', 'duplicate');
  var role = normalizeRole_(body.role || 'manager');
  var store = normalizeAppliesToValue_(body.store || 'ALL');
  var password = normalizeNewPassword_(body.password);
  var salt = newSaltB64_();
  var userId = Utilities.getUuid();
  appendRowByHeaders_(getSheet_('Users'), {
    userId: userId,
    name: name,
    email: email,
    role: role,
    store: store,
    active: true,
    passwordHash: hashPassword_(password, salt, PASSWORD_ITERATIONS),
    salt: salt,
    passwordIterations: PASSWORD_ITERATIONS,
    mustChangePassword: body.mustChangePassword === false ? false : true,
    failedLoginCount: 0,
    lockedUntil: ''
  });
  return { ok: true, user: toAdminUser_(findUserById_(userId)) };
}

function resetPassword_(body, admin) {
  var user = findUserById_(body.userId) || findUserByEmail_(body.email);
  if (!user) throw fail_('User not found.', 'not-found');
  var temp = temporaryPassword_();
  var salt = newSaltB64_();
  setUserFields_(user.userId, {
    salt: salt,
    passwordHash: hashPassword_(temp, salt, PASSWORD_ITERATIONS),
    passwordIterations: PASSWORD_ITERATIONS,
    mustChangePassword: true,
    failedLoginCount: 0,
    lockedUntil: ''
  });
  clearFailState_(user.email);
  return {
    ok: true,
    user: toAdminUser_(findUserById_(user.userId)),
    temporaryPassword: temp,
    message: 'Tell this person the temporary password. It is not saved in the sheet. They must choose a new one at next sign-in.'
  };
}

function setActive_(body, admin) {
  var user = findUserById_(body.userId);
  if (!user) throw fail_('User not found.', 'not-found');
  var want = !!body.active;
  if (!want && String(user.userId) === String(admin.userId)) {
    throw fail_('You cannot deactivate your own login.', 'forbidden');
  }
  if (!want && isAdmin_(user) && isTruthyActive_(user.active)) {
    var admins = listUsers().filter(function (u) {
      return isAdmin_(u) && isTruthyActive_(u.active);
    });
    if (admins.length <= 1) throw fail_('Keep at least one active admin.', 'forbidden');
  }
  setUserFields_(user.userId, { active: want });
  return { ok: true, user: toAdminUser_(findUserById_(user.userId)) };
}

function requireAdmin_(user) {
  if (!isAdmin_(user)) throw fail_('Only an admin can do that.', 'forbidden');
  return user;
}

// --- stores, templates, questions, scoring ---

function normalizePhysicalStore_(store) {
  return String(store || '').trim().toUpperCase();
}

function assertPhysicalStore_(store) {
  var code = normalizePhysicalStore_(store);
  if (PHYSICAL_STORE_CODES.indexOf(code) === -1) {
    throw fail_(
      'Pick a store for this audit: WPR, CPR, WZ, or SPZ. (ALL / RANCH / ZIGGIS are for user access, not one audit.)',
      'bad-store'
    );
  }
  return code;
}

function normalizeAppliesToValue_(raw) {
  var s = String(raw == null ? '' : raw).trim().toUpperCase();
  if (!s || s === TEMPLATE_SCOPE_ALL) return TEMPLATE_SCOPE_ALL;
  if (s === TEMPLATE_SCOPE_RANCH) return TEMPLATE_SCOPE_RANCH;
  if (s === TEMPLATE_SCOPE_ZIGGIS) return TEMPLATE_SCOPE_ZIGGIS;
  var parts = s.split(/[,|;]+/).map(function (p) { return p.trim().toUpperCase(); }).filter(function (p) { return !!p; });
  if (!parts.length) return TEMPLATE_SCOPE_ALL;
  var uniq = [];
  parts.forEach(function (code) {
    if (PHYSICAL_STORE_CODES.indexOf(code) === -1) {
      throw fail_('Invalid store in Applies to: ' + code + '. Use WPR, CPR, WZ, SPZ, ALL, RANCH, or ZIGGIS.', 'bad-store');
    }
    if (uniq.indexOf(code) === -1) uniq.push(code);
  });
  uniq.sort();
  if (uniq.length === PHYSICAL_STORE_CODES.length) return TEMPLATE_SCOPE_ALL;
  return uniq.join(',');
}

function parseAppliesTo_(raw) {
  var normalized = normalizeAppliesToValue_(raw);
  if (normalized === TEMPLATE_SCOPE_ALL) return { mode: 'ALL', value: TEMPLATE_SCOPE_ALL, stores: PHYSICAL_STORE_CODES.slice() };
  if (normalized === TEMPLATE_SCOPE_RANCH) return { mode: 'RANCH', value: TEMPLATE_SCOPE_RANCH, stores: RANCH_STORES.slice() };
  if (normalized === TEMPLATE_SCOPE_ZIGGIS) return { mode: 'ZIGGIS', value: TEMPLATE_SCOPE_ZIGGIS, stores: ZIGGIS_STORES.slice() };
  return { mode: 'LIST', value: normalized, stores: normalized.split(',') };
}

function templateAppliesToStore_(template, storeCode) {
  var code = assertPhysicalStore_(storeCode);
  var applies = parseAppliesTo_(template && template.appliesTo);
  return applies.stores.indexOf(code) !== -1;
}

function userCoversPhysicalStore_(userStoreScope, physicalStore) {
  var code = assertPhysicalStore_(physicalStore);
  try {
    var covers = parseAppliesTo_(userStoreScope);
    return covers.stores.indexOf(code) !== -1;
  } catch (e) {
    return false;
  }
}

function listMyStores_(user) {
  return PHYSICAL_STORE_CODES.filter(function (code) {
    return userCoversPhysicalStore_(user.store, code);
  }).map(function (code) {
    return { code: code, label: PHYSICAL_STORE_LABELS[code] || code };
  });
}

function assertUserCoversStore_(user, storeCode) {
  var code = assertPhysicalStore_(storeCode);
  if (!userCoversPhysicalStore_(user.store, code)) {
    throw fail_('Your account does not cover store ' + code + '.', 'forbidden');
  }
  return code;
}

function normalizeFullPointsAnswer_(raw) {
  var s = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!s) return YESNO_FULL_DEFAULT;
  if (s === 'yes' || s === 'no') return s;
  throw fail_('Full-points answer must be Yes or No.', 'bad-question');
}

function isTodoRuleOff_(raw) {
  return String(raw == null ? '' : raw).trim().toUpperCase() === TODO_RULE_OFF;
}

function shouldProposeTodo_(todoIfImperfect) {
  return !isTodoRuleOff_(todoIfImperfect);
}

function todoTitleForQuestion_(q) {
  var raw = String((q && q.todoIfImperfect) || '').trim();
  if (!raw || isTodoRuleOff_(raw)) return 'Follow up: ' + ((q && q.text) || 'item');
  return raw;
}

function scoreYesNo_(question, answer) {
  var full = normalizeFullPointsAnswer_(question.fullPointsAnswer);
  var ans = String(answer || '').trim().toLowerCase();
  if (ans !== 'yes' && ans !== 'no') return 0;
  return ans === full ? (Number(question.points) || 0) : 0;
}

function parseOptions_(optionsText) {
  var map = {};
  var labels = [];
  if (!optionsText) return { map: map, labels: labels };
  String(optionsText).split('|').forEach(function (part) {
    var chunk = String(part || '').trim();
    if (!chunk) return;
    var idx = chunk.lastIndexOf(':');
    if (idx <= 0) return;
    var label = chunk.substring(0, idx).trim();
    var pts = Number(chunk.substring(idx + 1).trim());
    if (!label || !isFinite(pts) || isNaN(pts)) return;
    map[label] = pts;
    labels.push(label);
  });
  return { map: map, labels: labels };
}

function validateMultipleOptions_(optionsText) {
  var text = String(optionsText || '').trim();
  if (!text) throw fail_('Multiple-choice questions need options like Good:5|Fair:3|Poor:0.', 'bad-question');
  var parts = text.split('|').map(function (p) { return p.trim(); }).filter(function (p) { return !!p; });
  if (parts.length < 2) throw fail_('Add at least two answer choices.', 'bad-question');
  var map = {};
  var labels = [];
  parts.forEach(function (part) {
    var idx = part.lastIndexOf(':');
    if (idx <= 0) throw fail_('Each choice needs Label:points (got "' + part + '").', 'bad-question');
    var label = part.substring(0, idx).trim();
    var ptsRaw = part.substring(idx + 1).trim();
    if (!label) throw fail_('Choice label cannot be empty.', 'bad-question');
    if (Object.prototype.hasOwnProperty.call(map, label)) throw fail_('Duplicate choice label: ' + label, 'bad-question');
    var pts = Number(ptsRaw);
    if (!isFinite(pts) || isNaN(pts)) throw fail_('Points for "' + label + '" must be a number.', 'bad-question');
    if (pts < 0) throw fail_('Points for "' + label + '" cannot be negative.', 'bad-question');
    if (pts > 100) throw fail_('Points for "' + label + '" must be 100 or less.', 'bad-question');
    map[label] = pts;
    labels.push(label);
  });
  return {
    map: map,
    options: labels.map(function (label) { return label + ':' + map[label]; }).join('|')
  };
}

function normalizeQuestionType_(type) {
  var t = String(type || '').trim().toLowerCase();
  if (t === 'yesno' || t === 'multiple') return t;
  throw fail_('Supported question types: yesno, multiple.', 'bad-question');
}

function normalizeRequiredText_(value, label) {
  var text = String(value == null ? '' : value).trim();
  if (!text) throw fail_(label + ' is required.', 'bad-request');
  return text;
}

function normalizePoints_(points) {
  var n = Number(points);
  if (!isFinite(n) || isNaN(n)) throw fail_('Points must be a number.', 'bad-question');
  if (n < 0) throw fail_('Points cannot be negative.', 'bad-question');
  if (n > 100) throw fail_('Points must be 100 or less for now.', 'bad-question');
  return n;
}

function listTemplates() {
  return rowsToObjects_(getSheet_('Templates'));
}

function findTemplateById_(templateId) {
  var id = String(templateId || '').trim();
  if (!id) throw fail_('Template id is required.', 'bad-request');
  var templates = listTemplates();
  for (var i = 0; i < templates.length; i++) {
    if (String(templates[i].templateId) === id) return templates[i];
  }
  throw fail_('Template not found.', 'not-found');
}

function toPlainTemplate_(t) {
  var applies = parseAppliesTo_(t && t.appliesTo);
  return {
    templateId: String(t.templateId || ''),
    name: String(t.name || ''),
    description: String(t.description || ''),
    createdByEmail: String(t.createdByEmail || ''),
    createdAt: t.createdAt ? String(t.createdAt) : '',
    appliesTo: applies.value,
    appliesMode: applies.mode,
    appliesStores: applies.stores.slice()
  };
}

function getQuestionsForTemplate(templateId) {
  var questions = rowsToObjects_(getSheet_('Questions')).filter(function (q) {
    return String(q.templateId) === String(templateId);
  });
  questions.sort(function (a, b) { return Number(a.order) - Number(b.order); });
  return questions;
}

function toPlainQuestion_(q) {
  var type = String(q.type || '');
  var fullPointsAnswer = '';
  try {
    fullPointsAnswer = type === 'yesno' ? normalizeFullPointsAnswer_(q.fullPointsAnswer) : '';
  } catch (err) {
    fullPointsAnswer = YESNO_FULL_DEFAULT;
  }
  var todoRaw = String(q.todoIfImperfect || '');
  return {
    questionId: String(q.questionId || ''),
    templateId: String(q.templateId || ''),
    order: Number(q.order) || 0,
    section: String(q.section || ''),
    text: String(q.text || ''),
    type: type,
    options: String(q.options || ''),
    points: Number(q.points) || 0,
    todoIfImperfect: todoRaw,
    todoEnabled: shouldProposeTodo_(todoRaw),
    fullPointsAnswer: fullPointsAnswer,
    requiresMedia: q.requiresMedia === true || String(q.requiresMedia || '').toUpperCase() === 'TRUE'
  };
}

function toAuditQuestion_(q) {
  var plain = toPlainQuestion_(q);
  var options = '';
  if (plain.type === 'multiple') options = parseOptions_(plain.options).labels.join('|');
  return {
    questionId: plain.questionId,
    order: plain.order,
    section: plain.section,
    text: plain.text,
    type: plain.type,
    options: options,
    requiresMedia: plain.requiresMedia
  };
}

function nextQuestionOrder_(templateId) {
  var questions = getQuestionsForTemplate(templateId);
  var maxOrder = 0;
  for (var i = 0; i < questions.length; i++) {
    var n = Number(questions[i].order) || 0;
    if (n > maxOrder) maxOrder = n;
  }
  return maxOrder + 1;
}

function listTemplatesForStore_(body, user) {
  var storeCode = assertUserCoversStore_(user, body.store);
  var templates = listTemplates().filter(function (t) {
    return templateAppliesToStore_(t, storeCode);
  }).map(toPlainTemplate_);
  return { ok: true, store: storeCode, templates: templates };
}

function beginAudit_(body, user) {
  var storeCode = assertUserCoversStore_(user, body.store);
  var template = findTemplateById_(body.templateId);
  if (!templateAppliesToStore_(template, storeCode)) {
    throw fail_('Checklist "' + (template.name || '') + '" does not apply to store ' + storeCode + '.', 'bad-store');
  }
  var questions = getQuestionsForTemplate(template.templateId);
  var maxScore = 0;
  questions.forEach(function (q) { maxScore += Number(q.points) || 0; });
  var auditId = Utilities.getUuid();
  appendRowByHeaders_(getSheet_('Audits'), {
    auditId: auditId,
    templateId: template.templateId,
    store: storeCode,
    auditorEmail: user.email,
    startedAt: now_(),
    completedAt: '',
    score: 0,
    maxScore: maxScore
  });
  return {
    ok: true,
    auditId: auditId,
    store: storeCode,
    storeLabel: PHYSICAL_STORE_LABELS[storeCode] || storeCode,
    templateName: String(template.name || ''),
    questions: questions.map(toAuditQuestion_)
  };
}

function getAuditMetaById_(auditId) {
  var id = String(auditId || '').trim();
  if (!id) throw fail_('Audit id is required.', 'bad-request');
  var info = sheetIndex_(getSheet_('Audits'));
  if (info.map.auditId == null || info.map.store == null) {
    throw fail_('Audits sheet is missing auditId or store columns.', 'schema');
  }
  for (var i = 1; i < info.data.length; i++) {
    if (String(info.data[i][info.map.auditId]) === id) {
      return {
        auditId: id,
        store: assertPhysicalStore_(info.data[i][info.map.store]),
        auditorEmail: info.map.auditorEmail == null ? '' : String(info.data[i][info.map.auditorEmail] || ''),
        templateId: info.map.templateId == null ? '' : String(info.data[i][info.map.templateId] || ''),
        maxScore: info.map.maxScore == null ? 0 : (Number(info.data[i][info.map.maxScore]) || 0),
        rowIndex: i
      };
    }
  }
  throw fail_('Audit not found.', 'not-found');
}

function requireAuditActor_(auditId, user) {
  var meta = getAuditMetaById_(auditId);
  var me = normalizeEmailKey_(user.email);
  var auditor = normalizeEmailKey_(meta.auditorEmail);
  if (isAdmin_(user) || (auditor && auditor === me)) return meta;
  throw fail_('You cannot change this audit.', 'forbidden');
}

function questionOnTemplate_(templateId, questionId) {
  var questions = getQuestionsForTemplate(templateId);
  for (var i = 0; i < questions.length; i++) {
    if (String(questions[i].questionId) === String(questionId)) return questions[i];
  }
  return null;
}

function auditHasPersistedTodos_(auditId) {
  var id = String(auditId || '').trim();
  if (!id) return false;
  var todos = rowsToObjects_(getSheet_('Todos'));
  for (var i = 0; i < todos.length; i++) {
    if (String(todos[i].auditId || '') === id) return true;
  }
  return false;
}

function deleteAnswersForAudit_(auditId) {
  var id = String(auditId || '').trim();
  var sheet = getSheet_('Answers');
  var data = sheet.getDataRange().getValues();
  if (!data.length) return 0;
  var headers = trimHeaders_(data[0]);
  var auditCol = headers.indexOf('auditId');
  if (auditCol < 0) throw fail_('Answers sheet is missing auditId column.', 'schema');
  var removed = 0;
  for (var i = data.length - 1; i >= 1; i--) {
    if (String(data[i][auditCol]) === id) {
      sheet.deleteRow(i + 1);
      removed++;
    }
  }
  return removed;
}

function scoreAnswer_(question, answer) {
  var type = String(question.type || '').toLowerCase();
  if (type === 'yesno') {
    var ans = String(answer || '').trim().toLowerCase();
    if (ans !== 'yes' && ans !== 'no') {
      throw fail_('Choose Yes or No for: ' + (question.text || 'a question'), 'bad-answer');
    }
    return scoreYesNo_(question, ans);
  }
  if (type === 'multiple') {
    var parsed = parseOptions_(question.options);
    if (!Object.prototype.hasOwnProperty.call(parsed.map, answer)) {
      throw fail_('That choice is not on the question: ' + (question.text || ''), 'bad-answer');
    }
    return parsed.map[answer];
  }
  throw fail_('This question type cannot be scored.', 'bad-question');
}

function submitAudit_(body, user) {
  var meta = requireAuditActor_(body.auditId, user);
  if (auditHasPersistedTodos_(meta.auditId)) {
    throw fail_(
      'To-dos already exist for this audit. Editing answers would leave those tasks out of date. Manage tasks under My to-dos, or start a new audit.',
      'locked'
    );
  }
  deleteAnswersForAudit_(meta.auditId);
  var questions = getQuestionsForTemplate(meta.templateId);
  var todoCandidates = [];
  (body.answers || []).forEach(function (a) {
    if (!a || !String(a.answer || '').trim()) return;
    var q = null;
    for (var i = 0; i < questions.length; i++) {
      if (String(questions[i].questionId) === String(a.questionId)) q = questions[i];
    }
    if (!q) throw fail_('A question on this audit was not found.', 'bad-answer');
    var storedAnswer = String(a.answer).trim();
    if (String(q.type).toLowerCase() === 'yesno') storedAnswer = storedAnswer.toLowerCase();
    var pointsEarned = scoreAnswer_(q, storedAnswer);
    var mediaUrls = normalizeAnswerMedia_(meta.auditId, q.questionId, a.mediaUrls || a.media || []);
    appendRowByHeaders_(getSheet_('Answers'), {
      answerId: Utilities.getUuid(),
      auditId: meta.auditId,
      questionId: q.questionId,
      answer: storedAnswer,
      pointsEarned: pointsEarned,
      note: String(a.note || ''),
      mediaUrls: mediaUrls
    });
    var maxPts = Number(q.points) || 0;
    if (pointsEarned < maxPts && shouldProposeTodo_(q.todoIfImperfect)) {
      todoCandidates.push({
        questionId: String(q.questionId),
        questionText: String(q.text || ''),
        title: todoTitleForQuestion_(q),
        details: String(a.note || ''),
        pointsEarned: pointsEarned,
        maxPoints: maxPts,
        mediaUrls: mediaUrls,
        mediaCount: parseMediaUrlList_(mediaUrls).length
      });
    }
  });
  var score = sumAuditScore_(meta.auditId);
  var info = sheetIndex_(getSheet_('Audits'));
  writeCell_(info, meta.rowIndex, 'completedAt', now_());
  writeCell_(info, meta.rowIndex, 'score', score);
  return {
    ok: true,
    score: score,
    maxScore: meta.maxScore,
    auditId: meta.auditId,
    store: meta.store,
    auditorEmail: user.email,
    todoCandidates: todoCandidates,
    todosLocked: false
  };
}

function sumAuditScore_(auditId) {
  var answers = rowsToObjects_(getSheet_('Answers'));
  var score = 0;
  answers.forEach(function (a) {
    if (String(a.auditId) === String(auditId)) score += Number(a.pointsEarned) || 0;
  });
  return score;
}

function listEligibleAssigneesForStore_(physicalStore) {
  var storeCode = assertPhysicalStore_(physicalStore);
  return listUsers().filter(function (u) {
    if (!isTruthyActive_(u.active)) return false;
    return userCoversPhysicalStore_(u.store, storeCode);
  }).map(function (u) {
    return {
      email: String(u.email || ''),
      name: String(u.name || ''),
      role: String(u.role || ''),
      store: String(u.store || '')
    };
  });
}

function assertAssigneeEligibleForStore_(email, physicalStore) {
  var needle = normalizeEmailKey_(email);
  if (!needle) return '';
  var eligible = listEligibleAssigneesForStore_(physicalStore);
  for (var i = 0; i < eligible.length; i++) {
    if (normalizeEmailKey_(eligible[i].email) === needle) return eligible[i].email;
  }
  throw fail_(
    'Cannot assign to ' + email + ' for store ' + physicalStore + '. That person is inactive or their store access does not include this location.',
    'bad-assignee'
  );
}

function listAssignees_(body, user) {
  var meta = getAuditMetaById_(body.auditId);
  var me = normalizeEmailKey_(user.email);
  var allowed = isAdmin_(user) || normalizeEmailKey_(meta.auditorEmail) === me || userCoversPhysicalStore_(user.store, meta.store);
  if (!allowed) throw fail_('You cannot view assignees for this audit.', 'forbidden');
  return { ok: true, store: meta.store, users: listEligibleAssigneesForStore_(meta.store) };
}

function userCanTouchTodo_(todo, user) {
  if (isAdmin_(user)) return true;
  var assignee = normalizeEmailKey_(todo.assignedTo);
  var me = normalizeEmailKey_(user.email);
  if (assignee && assignee === me) return true;
  if (!assignee && todo.store && userCoversPhysicalStore_(user.store, todo.store)) return true;
  return false;
}

function findTodo_(todoId) {
  var id = String(todoId || '').trim();
  if (!id) throw fail_('To-do id is required.', 'bad-request');
  var todos = rowsToObjects_(getSheet_('Todos'));
  for (var i = 0; i < todos.length; i++) {
    if (String(todos[i].todoId) === id) return todos[i];
  }
  throw fail_('To-do not found.', 'not-found');
}

function listMyTodos_(user) {
  var email = normalizeEmailKey_(user.email);
  var today = calendarTodayParts_();
  return rowsToObjects_(getSheet_('Todos')).filter(function (t) {
    if (String(t.status || '').toLowerCase() === 'done') return false;
    return normalizeEmailKey_(t.assignedTo) === email;
  }).map(function (t) {
    var due = parseDueCalendarDay_(t.dueDate);
    var delta = due ? daysFromToCalendar_(today, due) : null;
    var dueState = 'none';
    if (delta != null) {
      if (delta < 0) dueState = 'past';
      else if (delta === 0) dueState = 'today';
      else dueState = 'upcoming';
    }
    return {
      todoId: String(t.todoId || ''),
      title: String(t.title || ''),
      details: String(t.details || ''),
      assignedTo: String(t.assignedTo || ''),
      store: String(t.store || ''),
      dueDate: due ? due.key : '',
      dueState: dueState,
      status: String(t.status || ''),
      mediaUrls: String(t.mediaUrls || ''),
      auditId: String(t.auditId || '')
    };
  });
}

function updateDue_(body, user) {
  var todo = findTodo_(body.todoId);
  if (!userCanTouchTodo_(todo, user)) throw fail_('You cannot change that to-do.', 'forbidden');
  var key = resolveTodoDueKey_(body.dueDate);
  if (!String(body.dueDate || '').trim()) throw fail_('Pick a due date.', 'bad-request');
  var parsed = parseDueCalendarDay_(body.dueDate);
  if (!parsed) throw fail_('That due date was not understood.', 'bad-request');
  var info = sheetIndex_(getSheet_('Todos'));
  for (var i = 1; i < info.data.length; i++) {
    if (String(info.data[i][info.map.todoId]) !== String(todo.todoId)) continue;
    writeCell_(info, i, 'dueDate', parsed.key);
    if (info.map.lastDueDateChange == null) ensureColumn_(info.sheet, 'lastDueDateChange');
    info = sheetIndex_(getSheet_('Todos'));
    writeCell_(info, i, 'lastDueDateChange', now_().toISOString());
    return { ok: true, dueDate: parsed.key };
  }
  throw fail_('To-do not found.', 'not-found');
}

function markDone_(body, user) {
  var todo = findTodo_(body.todoId);
  if (!userCanTouchTodo_(todo, user)) throw fail_('You cannot change that to-do.', 'forbidden');
  var info = sheetIndex_(getSheet_('Todos'));
  for (var i = 1; i < info.data.length; i++) {
    if (String(info.data[i][info.map.todoId]) !== String(todo.todoId)) continue;
    writeCell_(info, i, 'status', 'done');
    if (info.map.completedAt == null) {
      ensureColumn_(info.sheet, 'completedAt');
      info = sheetIndex_(getSheet_('Todos'));
    }
    writeCell_(info, i, 'completedAt', now_().toISOString());
    return { ok: true };
  }
  throw fail_('To-do not found.', 'not-found');
}

function createTodos_(body, user) {
  var meta = requireAuditActor_(body.auditId, user);
  if (body.store) {
    var claimed = assertPhysicalStore_(body.store);
    if (claimed !== meta.store) throw fail_('Store does not match this audit (' + meta.store + ').', 'bad-store');
  }
  if (auditHasPersistedTodos_(meta.auditId)) {
    throw fail_('To-dos were already created for this audit. Create them once; manage existing tasks under My to-dos.', 'locked');
  }
  ensureNamedColumns_('Todos', TODO_MARKER_COLUMNS);
  var created = [];
  (body.todos || []).forEach(function (t) {
    if (!t || !String(t.title || '').trim()) return;
    var dueKey = resolveTodoDueKey_(t.dueDate);
    var assignedTo = assertAssigneeEligibleForStore_(t.assignedTo || '', meta.store);
    var mediaUrls = '';
    if (t.mediaUrls && parseMediaUrlList_(t.mediaUrls).length) {
      var qid = String(t.questionId || '').trim();
      if (!qid) throw fail_('A photo or video is missing its question.', 'bad-media');
      mediaUrls = normalizeAnswerMedia_(meta.auditId, qid, t.mediaUrls);
    }
    var todoId = Utilities.getUuid();
    appendRowByHeaders_(getSheet_('Todos'), {
      todoId: todoId,
      auditId: meta.auditId,
      questionId: t.questionId || '',
      title: String(t.title).trim(),
      details: String(t.details || ''),
      assignedTo: assignedTo,
      assignedBy: user.email,
      store: meta.store,
      dueDate: dueKey,
      status: 'open',
      mediaUrls: mediaUrls,
      createdAt: now_().toISOString(),
      completedAt: '',
      lastDueDateChange: ''
    });
    created.push({
      todoId: todoId,
      title: String(t.title).trim(),
      details: String(t.details || ''),
      assignedTo: assignedTo,
      store: meta.store,
      dueDate: dueKey,
      mediaUrls: mediaUrls
    });
  });
  var mail = notifyAssignmentDigests_(created, meta.store);
  var emailStatus = 'none';
  var emailMessage = 'No assignment emails (all unassigned or none created).';
  if (mail.attempted > 0 && mail.failed.length === 0) {
    emailStatus = 'ok';
    emailMessage = 'Assignment email' + (mail.sent === 1 ? '' : 's') + ' sent to ' + mail.sent + ' recipient(s).';
  } else if (mail.attempted > 0 && mail.sent > 0) {
    emailStatus = 'partial';
    emailMessage = 'To-dos saved. Some assignment emails failed. Do not create them again.';
  } else if (mail.attempted > 0) {
    emailStatus = 'failed';
    emailMessage = 'To-dos saved, but assignment email failed. Do not create them again.';
  }
  return {
    ok: true,
    created: created,
    count: created.length,
    emailStatus: emailStatus,
    emailMessage: emailMessage,
    emailsSent: mail.sent,
    emailErrors: mail.failed,
    skippedUnassigned: mail.skippedUnassigned
  };
}

function getAppUrl_() {
  var url = String(PropertiesService.getScriptProperties().getProperty(PROP_APP_URL) || '').trim();
  if (!url) return '';
  if (/script\.google\.com/i.test(url)) return '';
  if (/^https:\/\/[^\s]+$/i.test(url)) return url;
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/.*)?$/i.test(url)) return url;
  return '';
}

function setTodoFieldById_(todoId, fieldName, value) {
  var info = sheetIndex_(getSheet_('Todos'));
  if (info.map.todoId == null || info.map[fieldName] == null) return false;
  for (var i = 1; i < info.data.length; i++) {
    if (String(info.data[i][info.map.todoId]) === String(todoId)) {
      writeCell_(info, i, fieldName, value);
      return true;
    }
  }
  return false;
}

function notifyAssignmentDigests_(createdRows, storeCode) {
  var result = { attempted: 0, sent: 0, failed: [], skippedUnassigned: 0, recipients: [] };
  var byEmail = {};
  (createdRows || []).forEach(function (row) {
    var email = String(row.assignedTo || '').trim();
    if (!email) {
      result.skippedUnassigned++;
      return;
    }
    try {
      assertAssigneeEligibleForStore_(email, storeCode);
    } catch (err) {
      result.failed.push({ email: email, error: err.message || String(err) });
      return;
    }
    var key = normalizeEmailKey_(email);
    if (!byEmail[key]) byEmail[key] = { email: email, items: [] };
    byEmail[key].items.push(row);
  });
  var appUrl = getAppUrl_();
  Object.keys(byEmail).forEach(function (key) {
    var bundle = byEmail[key];
    result.attempted++;
    var lines = bundle.items.map(function (item) {
      var dueParts = parseDueCalendarDay_(item.dueDate);
      var fileCount = parseMediaUrlList_(item.mediaUrls).length;
      return '• ' + (item.title || 'To-do') +
        '\n  Store: ' + (item.store || storeCode || '') +
        '\n  Due: ' + formatDueLabel_(dueParts) +
        (item.details ? ('\n  Details: ' + item.details) : '') +
        (fileCount ? ('\n  Photos/videos: ' + fileCount + ' (open the app to view)') : '');
    });
    var body = 'Hi,\n\nYou were assigned ' + bundle.items.length + ' audit to-do(s):\n\n' + lines.join('\n\n');
    if (appUrl) body += '\n\nOpen the app: ' + appUrl + '\n(My to-dos)';
    else body += '\n\nOpen the B6 Audit app and go to My to-dos.';
    body += '\n\n— B6 Audit App';
    try {
      MailApp.sendEmail({
        to: bundle.email,
        subject: 'B6 Audit: new to-do' + (bundle.items.length > 1 ? 's' : '') + ' assigned (' + bundle.items.length + ')',
        body: body
      });
      result.sent++;
      result.recipients.push(bundle.email);
      bundle.items.forEach(function (item) {
        setTodoFieldById_(item.todoId, 'assignmentNotifiedAt', now_().toISOString());
      });
    } catch (err) {
      result.failed.push({ email: bundle.email, error: err && err.message ? err.message : String(err) });
    }
  });
  return result;
}

function sendTodoReminders() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { skipped: true, reason: 'Another reminder run is in progress.' };
  try {
    return sendTodoRemindersUnlocked_();
  } finally {
    try { lock.releaseLock(); } catch (err) {}
  }
}

function sendTodoRemindersUnlocked_() {
  ensureNamedColumns_('Todos', TODO_MARKER_COLUMNS);
  var todos = rowsToObjects_(getSheet_('Todos'));
  var today = calendarTodayParts_();
  var byEmail = {};
  todos.forEach(function (t) {
    if (String(t.status || '').toLowerCase() === 'done') return;
    var email = String(t.assignedTo || '').trim();
    if (!email || email.indexOf('@') === -1) return;
    var dueParts = parseDueCalendarDay_(t.dueDate);
    if (!dueParts) return;
    var delta = daysFromToCalendar_(today, dueParts);
    if (delta === null) return;
    var label = '';
    var markField = '';
    if (delta === TODO_REMINDER_LEAD_DAYS) {
      if (markerAlreadySentOn_(t.reminderDueSoonSentOn, today.key)) return;
      label = 'DUE IN 7 DAYS';
      markField = 'reminderDueSoonSentOn';
    } else if (delta === 0) {
      if (markerAlreadySentOn_(t.reminderDueDaySentOn, today.key)) return;
      label = 'DUE TODAY';
      markField = 'reminderDueDaySentOn';
    } else if (delta < 0) {
      if (markerAlreadySentOn_(t.reminderDueDaySentOn, today.key)) return;
      label = 'PAST DUE (' + Math.abs(delta) + ' day' + (Math.abs(delta) === 1 ? '' : 's') + ')';
      markField = 'reminderDueDaySentOn';
    } else {
      return;
    }
    var assignedNotified = parseDueCalendarDay_(t.assignmentNotifiedAt);
    if (assignedNotified && assignedNotified.key === today.key) return;
    var line = '• [' + label + '] ' + (t.title || 'To-do') +
      ' (' + (t.store || '') + ') — due ' + formatDueLabel_(dueParts) +
      (t.details ? ('\n  ' + String(t.details)) : '');
    if (!byEmail[email]) byEmail[email] = { lines: [], marks: [] };
    byEmail[email].lines.push(line);
    byEmail[email].marks.push({ todoId: t.todoId, field: markField, value: today.key });
  });
  var appUrl = getAppUrl_();
  var sentTo = 0;
  var items = 0;
  var failures = [];
  Object.keys(byEmail).forEach(function (email) {
    var bundle = byEmail[email];
    var body = 'Hi,\n\nYou have open audit to-dos that need attention:\n\n' + bundle.lines.join('\n\n');
    if (appUrl) body += '\n\nOpen the app: ' + appUrl + '\n(My to-dos)';
    else body += '\n\nOpen the B6 Audit app and go to My to-dos.';
    body += '\n\n— B6 Audit App';
    try {
      MailApp.sendEmail({
        to: email,
        subject: 'B6 Audit: to-do reminder (' + bundle.lines.length + ')',
        body: body
      });
      sentTo++;
      items += bundle.lines.length;
      bundle.marks.forEach(function (m) { setTodoFieldById_(m.todoId, m.field, m.value); });
    } catch (err) {
      failures.push({ email: email, error: err && err.message ? err.message : String(err) });
    }
  });
  return { sentTo: sentTo, items: items, failures: failures, today: today.key, timezone: today.tz };
}

function installTodoReminderTrigger() {
  var handlers = ScriptApp.getProjectTriggers();
  handlers.forEach(function (tr) {
    if (tr.getHandlerFunction() === 'sendTodoReminders') ScriptApp.deleteTrigger(tr);
  });
  ScriptApp.newTrigger('sendTodoReminders').timeBased().atHour(8).nearMinute(15).everyDays(1).create();
  return 'Daily reminder trigger installed (around 8:15am script time).';
}

function removeTodoReminderTrigger() {
  var handlers = ScriptApp.getProjectTriggers();
  var removed = 0;
  handlers.forEach(function (tr) {
    if (tr.getHandlerFunction() === 'sendTodoReminders') {
      ScriptApp.deleteTrigger(tr);
      removed++;
    }
  });
  return 'Removed ' + removed + ' reminder trigger(s).';
}

function pastDue_(admin) {
  var today = calendarTodayParts_();
  var usersByEmail = {};
  listUsers().forEach(function (u) {
    var key = normalizeEmailKey_(u.email);
    if (!key) return;
    usersByEmail[key] = {
      name: String(u.name || ''),
      email: String(u.email || ''),
      active: isTruthyActive_(u.active)
    };
  });
  var groupMap = {};
  rowsToObjects_(getSheet_('Todos')).forEach(function (t) {
    if (String(t.status || '').toLowerCase() === 'done') return;
    var dueParts = parseDueCalendarDay_(t.dueDate);
    if (!dueParts) return;
    var delta = daysFromToCalendar_(today, dueParts);
    if (delta === null || delta >= 0) return;
    var emailRaw = String(t.assignedTo || '').trim();
    var key = emailRaw ? normalizeEmailKey_(emailRaw) : '__unassigned__';
    if (!groupMap[key]) {
      var known = emailRaw ? usersByEmail[key] : null;
      groupMap[key] = {
        key: key,
        email: emailRaw || '',
        displayName: known && known.name ? known.name : (emailRaw || 'Unassigned'),
        inactiveUser: !!(known && !known.active),
        unassigned: !emailRaw,
        items: []
      };
    }
    groupMap[key].items.push({
      todoId: String(t.todoId || ''),
      title: String(t.title || 'To-do'),
      store: String(t.store || ''),
      dueDate: dueParts.key,
      dueLabel: formatDueLabel_(dueParts),
      daysOverdue: Math.abs(delta),
      details: String(t.details || ''),
      mediaUrls: String(t.mediaUrls || '')
    });
  });
  var groups = Object.keys(groupMap).map(function (k) {
    var g = groupMap[k];
    g.items.sort(function (a, b) {
      if (b.daysOverdue !== a.daysOverdue) return b.daysOverdue - a.daysOverdue;
      return String(a.title).localeCompare(String(b.title));
    });
    g.count = g.items.length;
    return g;
  });
  groups.sort(function (a, b) {
    if (a.unassigned !== b.unassigned) return a.unassigned ? 1 : -1;
    if (b.count !== a.count) return b.count - a.count;
    return String(a.displayName).localeCompare(String(b.displayName));
  });
  var totalItems = 0;
  groups.forEach(function (g) { totalItems += g.count; });
  return {
    ok: true,
    today: today.key,
    timezone: today.tz,
    totalAssignees: groups.filter(function (g) { return !g.unassigned; }).length,
    totalItems: totalItems,
    groups: groups
  };
}

// --- template builder (admin) ---

function ensureSchema_(admin) {
  var added = [];
  added = added.concat(ensureNamedColumns_('Users', USER_AUTH_COLUMNS));
  var sessions = ensureSessionsSheet_();
  if (sessions.created) added = added.concat(sessions.added);
  var templates = getSheet_('Templates');
  var beforeT = trimHeaders_(templates.getRange(1, 1, 1, Math.max(templates.getLastColumn(), 1)).getValues()[0]);
  if (beforeT.indexOf('appliesTo') === -1) {
    ensureColumn_(templates, 'appliesTo');
    added.push('Templates.appliesTo');
  }
  var questions = getSheet_('Questions');
  var beforeQ = trimHeaders_(questions.getRange(1, 1, 1, Math.max(questions.getLastColumn(), 1)).getValues()[0]);
  if (beforeQ.indexOf('fullPointsAnswer') === -1) {
    ensureColumn_(questions, 'fullPointsAnswer');
    added.push('Questions.fullPointsAnswer');
  }
  added = added.concat(ensureNamedColumns_('Todos', TODO_MARKER_COLUMNS));
  return {
    ok: true,
    added: added,
    message: added.length
      ? ('Added: ' + added.join(', ') + '. Existing cells were not changed.')
      : 'Nothing to add. Password columns, Applies to, full-points answer, to-do markers, and Sessions were already there. Existing cells were not changed.'
  };
}

function builderHome_(admin) {
  return { ok: true, access: { ok: true, email: admin.email, name: admin.name }, templates: listTemplates().map(toPlainTemplate_) };
}

function createTemplateAction_(body, admin) {
  var name = normalizeRequiredText_(body.name, 'Checklist name');
  var description = String(body.description == null ? '' : body.description).trim();
  var scope = normalizeAppliesToValue_(body.appliesTo);
  var templateId = Utilities.getUuid();
  appendRowByHeaders_(getSheet_('Templates'), {
    templateId: templateId,
    name: name,
    description: description,
    createdByEmail: admin.email,
    createdAt: now_(),
    appliesTo: scope
  });
  return { ok: true, template: toPlainTemplate_(findTemplateById_(templateId)) };
}

function updateMeta_(body, admin) {
  var templateId = String(body.templateId || '').trim();
  findTemplateById_(templateId);
  var cleanName = (body.name === null || body.name === undefined) ? null : normalizeRequiredText_(body.name, 'Checklist name');
  var scope = (body.appliesTo === null || body.appliesTo === undefined) ? null : normalizeAppliesToValue_(body.appliesTo);
  var info = sheetIndex_(getSheet_('Templates'));
  if (scope !== null && info.map.appliesTo == null) {
    ensureColumn_(info.sheet, 'appliesTo');
    info = sheetIndex_(info.sheet);
  }
  for (var i = 1; i < info.data.length; i++) {
    if (String(info.data[i][info.map.templateId]) !== templateId) continue;
    if (cleanName !== null) writeCell_(info, i, 'name', cleanName);
    if (scope !== null) writeCell_(info, i, 'appliesTo', scope);
    return { ok: true, template: toPlainTemplate_(findTemplateById_(templateId)) };
  }
  throw fail_('Template not found.', 'not-found');
}

function listBuilderQs_(body, admin) {
  var template = findTemplateById_(body.templateId);
  return {
    ok: true,
    template: toPlainTemplate_(template),
    questions: getQuestionsForTemplate(template.templateId).map(toPlainQuestion_)
  };
}

function prepareQuestionWrite_(raw) {
  var qType = normalizeQuestionType_(raw.type || 'yesno');
  var cleanSection = normalizeRequiredText_(raw.section, 'Section');
  var cleanText = normalizeRequiredText_(raw.text, 'Question text');
  var pts = normalizePoints_(raw.points);
  var optionsOut = '';
  var fullOut = '';
  if (qType === 'multiple') optionsOut = validateMultipleOptions_(raw.options).options;
  else fullOut = normalizeFullPointsAnswer_(raw.fullPointsAnswer);
  var todoOut = String(raw.todoIfImperfect == null ? '' : raw.todoIfImperfect).trim();
  if (todoOut && todoOut.toUpperCase() === TODO_RULE_OFF) todoOut = TODO_RULE_OFF;
  return {
    section: cleanSection,
    text: cleanText,
    points: pts,
    type: qType,
    options: optionsOut,
    todoIfImperfect: todoOut,
    fullPointsAnswer: qType === 'yesno' ? fullOut : ''
  };
}

function addBuilderQ_(body, admin) {
  var template = findTemplateById_(body.templateId);
  var prepared = prepareQuestionWrite_(body);
  var questionId = Utilities.getUuid();
  var order = nextQuestionOrder_(template.templateId);
  appendRowByHeaders_(getSheet_('Questions'), {
    questionId: questionId,
    templateId: template.templateId,
    order: order,
    section: prepared.section,
    text: prepared.text,
    type: prepared.type,
    options: prepared.options,
    points: prepared.points,
    todoIfImperfect: prepared.todoIfImperfect,
    fullPointsAnswer: prepared.fullPointsAnswer
  });
  var created = getQuestionsForTemplate(template.templateId).filter(function (q) {
    return String(q.questionId) === questionId;
  })[0];
  return { ok: true, question: toPlainQuestion_(created) };
}

function updateBuilderQ_(body, admin) {
  var id = String(body.questionId || '').trim();
  if (!id) throw fail_('Question id is required.', 'bad-request');
  var prepared = prepareQuestionWrite_(body);
  var info = sheetIndex_(getSheet_('Questions'));
  if (info.map.fullPointsAnswer == null) {
    ensureColumn_(info.sheet, 'fullPointsAnswer');
    info = sheetIndex_(info.sheet);
  }
  for (var i = 1; i < info.data.length; i++) {
    if (String(info.data[i][info.map.questionId]) !== id) continue;
    writeCell_(info, i, 'section', prepared.section);
    writeCell_(info, i, 'text', prepared.text);
    writeCell_(info, i, 'points', prepared.points);
    writeCell_(info, i, 'type', prepared.type);
    writeCell_(info, i, 'options', prepared.options);
    if (info.map.todoIfImperfect != null) writeCell_(info, i, 'todoIfImperfect', prepared.todoIfImperfect);
    writeCell_(info, i, 'fullPointsAnswer', prepared.fullPointsAnswer);
    return { ok: true, question: toPlainQuestion_({
      questionId: id,
      templateId: info.data[i][info.map.templateId],
      order: info.data[i][info.map.order],
      section: prepared.section,
      text: prepared.text,
      type: prepared.type,
      options: prepared.options,
      points: prepared.points,
      todoIfImperfect: prepared.todoIfImperfect,
      fullPointsAnswer: prepared.fullPointsAnswer
    }) };
  }
  throw fail_('Question not found.', 'not-found');
}

function saveAll_(body, admin) {
  var tid = String(body.templateId || '').trim();
  findTemplateById_(tid);
  var cleanName = normalizeRequiredText_(body.meta && body.meta.name, 'Checklist name');
  var scope = normalizeAppliesToValue_(body.meta && body.meta.appliesTo);
  var existingList = getQuestionsForTemplate(tid);
  var existingById = {};
  existingList.forEach(function (q) { existingById[String(q.questionId)] = q; });
  var errors = [];
  var prepared = [];
  var seen = {};
  (body.questions || []).forEach(function (raw, idx) {
    var label = 'Question ' + (idx + 1);
    try {
      var id = String(raw && raw.questionId || '').trim();
      if (!id) throw fail_('Missing questionId.', 'bad-question');
      if (seen[id]) throw fail_('Duplicate questionId in payload: ' + id, 'bad-question');
      seen[id] = true;
      var existing = existingById[id];
      if (!existing || String(existing.templateId) !== tid) {
        throw fail_('Unknown questionId (not on this checklist): ' + id, 'bad-question');
      }
      var row = prepareQuestionWrite_(raw);
      row.questionId = id;
      row.order = existing.order;
      row.templateId = tid;
      prepared.push(row);
    } catch (err) {
      errors.push(label + ': ' + (err && err.message ? err.message : String(err)));
    }
  });
  if (errors.length) {
    throw fail_('Save all blocked — nothing was written.\n' + errors.join('\n'), 'validation');
  }
  updateMeta_({ templateId: tid, name: cleanName, appliesTo: scope }, admin);
  var info = sheetIndex_(getSheet_('Questions'));
  if (info.map.fullPointsAnswer == null) {
    ensureColumn_(info.sheet, 'fullPointsAnswer');
    info = sheetIndex_(info.sheet);
  }
  prepared.forEach(function (p) {
    var found = false;
    for (var i = 1; i < info.data.length; i++) {
      if (String(info.data[i][info.map.questionId]) !== p.questionId) continue;
      writeCell_(info, i, 'section', p.section);
      writeCell_(info, i, 'text', p.text);
      writeCell_(info, i, 'points', p.points);
      writeCell_(info, i, 'type', p.type);
      writeCell_(info, i, 'options', p.options);
      if (info.map.todoIfImperfect != null) writeCell_(info, i, 'todoIfImperfect', p.todoIfImperfect);
      writeCell_(info, i, 'fullPointsAnswer', p.fullPointsAnswer);
      found = true;
      break;
    }
    if (!found) throw fail_('Question disappeared during save: ' + p.questionId, 'not-found');
  });
  return {
    ok: true,
    updatedCount: prepared.length,
    template: toPlainTemplate_(findTemplateById_(tid)),
    questions: getQuestionsForTemplate(tid).map(toPlainQuestion_)
  };
}

// --- media (Backblaze B2 via S3 presign) ---

function missingB2Props_() {
  var props = PropertiesService.getScriptProperties();
  var names = [PROP_B2_KEY_ID, PROP_B2_APP_KEY, PROP_B2_BUCKET, PROP_B2_ENDPOINT, PROP_B2_REGION];
  var missing = [];
  names.forEach(function (n) {
    if (!String(props.getProperty(n) || '').trim()) missing.push(n);
  });
  return missing;
}

function b2NotConfigured_(user, missing) {
  var message = 'Media storage is not configured. Photos and videos cannot be uploaded until Backblaze B2 is set up.';
  if (user && isAdmin_(user) && missing && missing.length) {
    message += ' Missing script properties: ' + missing.join(', ') + '.';
  }
  throw fail_(message, 'media-not-configured');
}

function getB2Config_(user) {
  var missing = missingB2Props_();
  if (missing.length) b2NotConfigured_(user, missing);
  var props = PropertiesService.getScriptProperties();
  var endpoint = String(props.getProperty(PROP_B2_ENDPOINT) || '').trim().replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
  var region = String(props.getProperty(PROP_B2_REGION) || '').trim().toLowerCase();
  var bucket = String(props.getProperty(PROP_B2_BUCKET) || '').trim().toLowerCase();
  var keyId = String(props.getProperty(PROP_B2_KEY_ID) || '').trim();
  var appKey = String(props.getProperty(PROP_B2_APP_KEY) || '');
  if (!/^[a-z0-9.-]+$/.test(endpoint) || endpoint.indexOf('backblazeb2.com') === -1) {
    throw fail_('Backblaze endpoint should look like s3.us-west-004.backblazeb2.com.', 'media-not-configured');
  }
  if (!/^[a-z0-9-]+$/.test(region) || !/^[a-z0-9.-]+$/.test(bucket)) {
    throw fail_('Check B2_REGION and B2_BUCKET. Use a lowercase bucket name with no spaces.', 'media-not-configured');
  }
  return { endpoint: endpoint, region: region, bucket: bucket, keyId: keyId, appKey: appKey };
}

function assertAllowedMediaMime_(mimeType, byteLength) {
  var mime = String(mimeType || '').toLowerCase().trim();
  if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(mime)) {
    throw fail_('Only photo or video uploads are allowed.', 'bad-media');
  }
  if (mime === 'image/svg+xml') throw fail_('SVG files are not allowed.', 'bad-media');
  var isImage = mime.indexOf('image/') === 0;
  var isVideo = mime.indexOf('video/') === 0;
  if (!isImage && !isVideo) throw fail_('Only photo (image/*) or video (video/*) uploads are allowed.', 'bad-media');
  var size = Number(byteLength);
  if (!isFinite(size) || size <= 0) throw fail_('File size is missing.', 'bad-media');
  if (isImage && size > MEDIA_MAX_IMAGE_BYTES) {
    throw fail_('Photo is too large after processing (max about 4 MB). Try a smaller picture.', 'bad-media');
  }
  if (isVideo && size > MEDIA_MAX_VIDEO_BYTES) {
    throw fail_('Video is too large for this app (max about 8 MB). Record a shorter clip or lower quality.', 'bad-media');
  }
  return mime;
}

function sanitizeMediaFileName_(raw) {
  var name = String(raw || 'upload').trim().toLowerCase();
  name = name.replace(/[^a-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^\.+/, '');
  if (!name || name === '.' || name === '..') name = 'upload';
  if (name.length > 80) name = name.substring(0, 80);
  return name;
}

function parseAuditObjectKey_(key) {
  var s = String(key || '');
  if (!s || s.indexOf('..') !== -1 || s.charAt(0) === '/') return null;
  var m = /^audits\/([0-9a-f-]{36})\/([0-9a-f-]{36})\/[A-Za-z0-9_-]{8,80}\/[A-Za-z0-9._-]{1,80}$/i.exec(s);
  if (!m) return null;
  return { auditId: m[1], questionId: m[2], key: s };
}

function parseMediaUrlList_(raw) {
  if (Array.isArray(raw)) {
    return raw.map(function (item) {
      if (item && typeof item === 'object') return String(item.objectKey || item.url || '').trim();
      return String(item || '').trim();
    }).filter(Boolean);
  }
  return String(raw || '').split('|').map(function (s) { return s.trim(); }).filter(Boolean);
}

function serializeMediaUrlList_(raw) {
  var urls = parseMediaUrlList_(raw);
  var out = [];
  var seen = {};
  urls.forEach(function (u) {
    if (seen[u]) return;
    seen[u] = true;
    out.push(u);
  });
  return out.join('|');
}

function normalizeAnswerMedia_(auditId, questionId, raw) {
  var keys = [];
  var seen = {};
  parseMediaUrlList_(raw).forEach(function (key) {
    if (seen[key]) return;
    seen[key] = true;
    keys.push(key);
  });
  if (keys.length > MEDIA_MAX_PER_QUESTION) {
    throw fail_('Limit of 5 media files per question.', 'media-limit');
  }
  var prefix = 'audits/' + auditId + '/' + questionId + '/';
  keys.forEach(function (key) {
    var parsed = parseAuditObjectKey_(key);
    if (!parsed || key.indexOf(prefix) !== 0 || parsed.questionId.toLowerCase() !== String(questionId).toLowerCase()) {
      throw fail_('A photo or video does not belong to this question.', 'bad-media');
    }
  });
  return keys.join('|');
}

function signUpload_(body, user) {
  var cfg = getB2Config_(user);
  var meta = requireAuditActor_(body.auditId, user);
  if (auditHasPersistedTodos_(meta.auditId)) {
    throw fail_('To-dos already exist for this audit, so files can no longer be added.', 'locked');
  }
  var qid = String(body.questionId || '').trim();
  var question = questionOnTemplate_(meta.templateId, qid);
  if (!question) throw fail_('That question is not on this audit.', 'bad-request');
  var mime = assertAllowedMediaMime_(body.mimeType, body.byteLength);
  var uploadKey = String(body.clientUploadId || '').trim();
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(uploadKey)) throw fail_('Upload id is required.', 'bad-request');
  var existing = parseMediaUrlList_(body.existingKeys || []);
  var prefix = 'audits/' + meta.auditId + '/' + qid + '/';
  var kept = existing.filter(function (k) { return String(k).indexOf(prefix) === 0; });
  if (kept.length >= MEDIA_MAX_PER_QUESTION) throw fail_('Limit of 5 media files per question.', 'media-limit');
  var cacheKey = 'media:' + meta.auditId + ':' + qid;
  var issued = [];
  try { issued = JSON.parse(CacheService.getScriptCache().get(cacheKey) || '[]'); } catch (err) { issued = []; }
  if (!Array.isArray(issued)) issued = [];
  if (issued.length >= MEDIA_MAX_SIGNATURES) {
    throw fail_('Too many upload attempts for this question. Remove a file or start a new audit.', 'media-limit');
  }
  var objectKey = prefix + uploadKey + '/' + sanitizeMediaFileName_(body.fileName);
  if (!parseAuditObjectKey_(objectKey)) throw fail_('Could not name that file safely.', 'bad-media');
  var dates = amzDates_(now_());
  var host = cfg.bucket + '.' + cfg.endpoint;
  var signed = buildPresignedUrl_({
    method: 'PUT',
    host: host,
    canonicalUri: canonicalUriForKey_(objectKey),
    region: cfg.region,
    accessKeyId: cfg.keyId,
    secretAccessKey: cfg.appKey,
    expiresSeconds: MEDIA_PUT_SECONDS,
    amzDate: dates.amzDate,
    dateStamp: dates.dateStamp,
    contentType: mime
  });
  issued.push(objectKey);
  try { CacheService.getScriptCache().put(cacheKey, JSON.stringify(issued), 21600); } catch (err2) {}
  return {
    ok: true,
    objectKey: objectKey,
    uploadUrl: signed.url,
    method: 'PUT',
    headers: { 'Content-Type': mime },
    expiresIn: MEDIA_PUT_SECONDS
  };
}

function requireMediaRead_(auditId, user) {
  var meta = getAuditMetaById_(auditId);
  if (isAdmin_(user)) return meta;
  if (normalizeEmailKey_(meta.auditorEmail) === normalizeEmailKey_(user.email)) return meta;
  if (userCoversPhysicalStore_(user.store, meta.store)) return meta;
  var me = normalizeEmailKey_(user.email);
  var todos = rowsToObjects_(getSheet_('Todos'));
  for (var i = 0; i < todos.length; i++) {
    if (String(todos[i].auditId) === String(auditId) && normalizeEmailKey_(todos[i].assignedTo) === me) return meta;
  }
  throw fail_('You cannot view files for that audit.', 'forbidden');
}

function signRead_(body, user) {
  var cfg = getB2Config_(user);
  var keys = body.keys || [];
  if (!Array.isArray(keys)) throw fail_('keys must be a list.', 'bad-request');
  if (keys.length > 30) throw fail_('Too many files at once.', 'bad-request');
  var dates = amzDates_(now_());
  var host = cfg.bucket + '.' + cfg.endpoint;
  var files = [];
  var seenAudit = {};
  keys.forEach(function (key) {
    var parsed = parseAuditObjectKey_(key);
    if (!parsed) throw fail_('That file key is not valid.', 'bad-media');
    if (!seenAudit[parsed.auditId]) {
      requireMediaRead_(parsed.auditId, user);
      seenAudit[parsed.auditId] = true;
    }
    var signed = buildPresignedUrl_({
      method: 'GET',
      host: host,
      canonicalUri: canonicalUriForKey_(parsed.key),
      region: cfg.region,
      accessKeyId: cfg.keyId,
      secretAccessKey: cfg.appKey,
      expiresSeconds: MEDIA_GET_SECONDS,
      amzDate: dates.amzDate,
      dateStamp: dates.dateStamp
    });
    files.push({ objectKey: parsed.key, url: signed.url, expiresIn: MEDIA_GET_SECONDS });
  });
  return { ok: true, files: files };
}
