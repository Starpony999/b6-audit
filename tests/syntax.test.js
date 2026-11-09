import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

function walk(dir, acc) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
    if (entry.name === 'node_modules' || entry.name === '.git') return;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else acc.push(full);
  });
  return acc;
}

test('every JavaScript file parses, including Apps Script', () => {
  const files = walk(root, []).filter((file) => /\.(js|mjs|gs)$/.test(file));
  assert.ok(files.some((file) => file.endsWith('Code.gs')));
  assert.ok(files.some((file) => file.endsWith('app.js')));
  files.forEach((file) => {
    if (file.endsWith('.gs')) {
      const source = fs.readFileSync(file);
      const result = spawnSync(process.execPath, ['--check', '--input-type=commonjs'], { input: source });
      if (result.status !== 0) {
        throw new Error(result.stderr.toString() || result.stdout.toString());
      }
      return;
    }
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  });
});

const DEPLOYED_WEB_APP = 'https://script.google.com/macros/s/AKfycbyKHDcdkeCuG3smlzgaPTUubHIqs3S9zjqRLlXJrwTVnf5GI2r47f1-5rm19PUPseex/exec';

test('the manifest is an anonymous web app and the config uses the deployed URL', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'apps-script', 'appsscript.json'), 'utf8'));
  assert.equal(manifest.webapp.executeAs, 'USER_DEPLOYING');
  assert.equal(manifest.webapp.access, 'ANYONE_ANONYMOUS');
  assert.equal(manifest.oauthScopes.includes('https://www.googleapis.com/auth/drive'), false);
  const config = fs.readFileSync(path.join(root, 'js', 'config.js'), 'utf8');
  assert.match(config, new RegExp('export const SCRIPT_URL = "' + DEPLOYED_WEB_APP.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '";'));
});

test('the repo does not contain another web-app URL or a private key', () => {
  const files = walk(root, []).filter((file) => !file.includes(`${path.sep}tests${path.sep}media-sigv4.test.js`));
  const banned = [
    /AIza[0-9A-Za-z_-]{20,}/,
    /script\.google\.com\/macros\/s\/[A-Za-z0-9_-]{20,}/,
    /BEGIN [A-Z ]*PRIVATE KEY/,
  ];
  files.forEach((file) => {
    if (!/\.(js|gs|json|html|css|md|yml)$/.test(file)) return;
    const text = fs.readFileSync(file, 'utf8').split(DEPLOYED_WEB_APP).join('');
    banned.forEach((pattern) => {
      assert.equal(pattern.test(text), false, file + ' matched ' + pattern);
    });
  });
  const sample = fs.readFileSync(path.join(root, 'tests', 'media-sigv4.test.js'), 'utf8');
  assert.match(sample, /AKIAIOSFODNN7EXAMPLE/);
});
