import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './gas-harness.js';

const AWS_CANONICAL = [
  'GET',
  '/test.txt',
  'X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host',
  'host:examplebucket.s3.amazonaws.com',
  '',
  'host',
  'UNSIGNED-PAYLOAD',
].join('\n');

test('SigV4 presign matches the AWS query-string example', () => {
  const h = createHarness();
  // Amazon's published sample key. It is not a real account.
  const signed = h.context.buildPresignedUrl_({
    method: 'GET',
    host: 'examplebucket.s3.amazonaws.com',
    canonicalUri: '/test.txt',
    region: 'us-east-1',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    expiresSeconds: 86400,
    amzDate: '20130524T000000Z',
    dateStamp: '20130524',
  });
  assert.equal(signed.canonicalRequest, AWS_CANONICAL);
  assert.equal(h.context.sha256Hex_(signed.canonicalRequest), '3bfa292879f6447bbcda7001decf97f4a54dc650c8942174ae0a9121cf58ad04');
  assert.equal(signed.signature, 'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
  assert.equal(
    signed.url,
    'https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404'
  );
});

function readyAudit() {
  const h = createHarness();
  const admin = h.call({
    action: 'bootstrapAdmin',
    name: 'Cassidy', email: 'cassidy@example.com',
    password: 'correct-horse', passwordConfirm: 'correct-horse',
    bootstrapSecret: 'setup-phrase-for-tests-only',
  });
  const template = h.call({
    action: 'createTemplate', token: admin.token, name: 'Walk', appliesTo: 'ALL',
  });
  const question = h.call({
    action: 'addBuilderQuestion', token: admin.token, templateId: template.template.templateId,
    section: 'Lobby', text: 'Photo the mats', points: 5, type: 'yesno',
  });
  const audit = h.call({
    action: 'beginAudit', token: admin.token, templateId: template.template.templateId, store: 'WPR',
  });
  return { h, admin, audit, questionId: question.question.questionId };
}

test('missing Backblaze settings return a clear message and no upload URL', () => {
  const { h, admin, audit, questionId } = readyAudit();
  const missing = h.call({
    action: 'signMediaUpload',
    token: admin.token,
    auditId: audit.auditId,
    questionId,
    fileName: 'photo.jpg',
    mimeType: 'image/jpeg',
    byteLength: 1000,
    clientUploadId: 'uploadkey1',
    existingKeys: [],
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'media-not-configured');
  assert.match(missing.message, /Media storage is not configured/);
  assert.match(missing.message, /B2_BUCKET/);
  assert.equal(missing.uploadUrl, undefined);
});

test('presign checks type, size, count, and audit ownership; secret stays off the URL', () => {
  const { h, admin, audit, questionId } = readyAudit();
  h.props.B2_KEY_ID = '001examplekeyid';
  h.props.B2_APPLICATION_KEY = 'super-secret-application-key';
  h.props.B2_BUCKET = 'b6-audit-media';
  h.props.B2_ENDPOINT = 'https://s3.us-west-004.backblazeb2.com';
  h.props.B2_REGION = 'us-west-004';

  const svg = h.call({
    action: 'signMediaUpload', token: admin.token, auditId: audit.auditId, questionId,
    fileName: 'x.svg', mimeType: 'image/svg+xml', byteLength: 100, clientUploadId: 'uploadkey1',
  });
  assert.equal(svg.error, 'bad-media');
  const big = h.call({
    action: 'signMediaUpload', token: admin.token, auditId: audit.auditId, questionId,
    fileName: 'clip.mp4', mimeType: 'video/mp4', byteLength: 8 * 1024 * 1024 + 1,
    clientUploadId: 'uploadkey1',
  });
  assert.match(big.message, /8 MB/);
  const pdf = h.call({
    action: 'signMediaUpload', token: admin.token, auditId: audit.auditId, questionId,
    fileName: 'notes.pdf', mimeType: 'application/pdf', byteLength: 100, clientUploadId: 'uploadkey1',
  });
  assert.equal(pdf.error, 'bad-media');

  const signed = h.call({
    action: 'signMediaUpload', token: admin.token, auditId: audit.auditId, questionId,
    fileName: 'Lobby Photo.JPG', mimeType: 'image/jpeg', byteLength: 200000,
    clientUploadId: 'uploadkey1', existingKeys: [],
  });
  assert.equal(signed.ok, true, signed.message);
  assert.match(signed.objectKey, new RegExp('^audits/' + audit.auditId + '/' + questionId + '/uploadkey1/'));
  assert.equal(signed.method, 'PUT');
  assert.equal(signed.headers['Content-Type'], 'image/jpeg');
  assert.match(signed.uploadUrl, /X-Amz-Signature=/);
  assert.match(signed.uploadUrl, /X-Amz-SignedHeaders=content-type%3Bhost/);
  assert.equal(signed.uploadUrl.includes('super-secret-application-key'), false);
  assert.equal(JSON.stringify(signed).includes('super-secret-application-key'), false);

  const tooMany = h.call({
    action: 'signMediaUpload', token: admin.token, auditId: audit.auditId, questionId,
    fileName: 'more.jpg', mimeType: 'image/jpeg', byteLength: 100,
    clientUploadId: 'uploadkey2',
    existingKeys: [1, 2, 3, 4, 5].map((n) => 'audits/' + audit.auditId + '/' + questionId + '/uploadkey' + n + '/a.jpg'),
  });
  assert.equal(tooMany.error, 'media-limit');

  const other = h.call({
    action: 'addUser', token: admin.token, name: 'Carter', email: 'carter@example.com',
    role: 'gm', store: 'SPZ', password: 'shared-secret', mustChangePassword: false,
  });
  assert.equal(other.ok, true, other.message);
  const carter = h.call({ action: 'login', email: 'carter@example.com', password: 'shared-secret' });
  const stolen = h.call({
    action: 'signMediaRead', token: carter.token, keys: [signed.objectKey],
  });
  assert.equal(stolen.error, 'forbidden');

  const view = h.call({ action: 'signMediaRead', token: admin.token, keys: [signed.objectKey] });
  assert.equal(view.ok, true, view.message);
  assert.match(view.files[0].url, /X-Amz-Signature=/);
  assert.equal(view.files[0].url.includes('super-secret-application-key'), false);

  const foreign = 'audits/00000000-0000-4000-8000-000000009999/00000000-0000-4000-8000-000000008888/uploadkey1/a.jpg';
  const badKey = h.call({ action: 'signMediaRead', token: admin.token, keys: [foreign] });
  assert.equal(badKey.ok, false);
});

test('saved answers only keep object keys for that question', () => {
  const { h, admin, audit, questionId } = readyAudit();
  const good = 'audits/' + audit.auditId + '/' + questionId + '/uploadkey1/photo.jpg';
  const saved = h.call({
    action: 'submitAuditAnswers',
    token: admin.token,
    auditId: audit.auditId,
    answers: [{ questionId, answer: 'no', note: '', mediaUrls: [good, good] }],
  });
  assert.equal(saved.ok, true, saved.message);
  assert.equal(saved.todoCandidates[0].mediaUrls, good);
  const bad = h.call({
    action: 'submitAuditAnswers',
    token: admin.token,
    auditId: audit.auditId,
    answers: [{ questionId, answer: 'no', mediaUrls: ['https://evil.example/a.jpg'] }],
  });
  assert.equal(bad.error, 'bad-media');
});
