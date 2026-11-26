// The /setup page: structure, the token, no inline scripts, and that setup.js only builds DOM from text.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const UI = fileURLToPath(new URL('../src/console/ui/', import.meta.url));
const read = (name: string) => readFileSync(join(UI, name), 'utf8');
const html = read('setup.html');
const js = read('setup.js');
const css = read('setup.css');

describe('setup page', () => {
  test('loads style.css, setup.css and setup.js; carries the token meta; no inline scripts', () => {
    assert.match(html, /<html lang="en">/);
    assert.match(html, /name="color-scheme" content="light dark"/);
    assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1/);
    assert.ok(html.includes('<meta name="switchyard-console" content="">'), 'the server injects the API token here');
    assert.match(html, /<link rel="stylesheet" href="\/style\.css">\s*<link rel="stylesheet" href="\/setup\.css">/);
    assert.match(html, /<script type="module" src="\/setup\.js"><\/script>/);
    assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)[^>]*>/);
    assert.doesNotMatch(html, /\sstyle="/, 'no inline styles needed');
  });

  test('every element setup.js looks up by id exists', () => {
    const used = [...js.matchAll(/\$\('([\w-]+)'\)/g)].map((m) => m[1]!);
    assert.ok(used.length >= 8);
    for (const id of new Set(used)) assert.ok(html.includes(`id="${id}"`), `setup.js uses #${id}, which setup.html lacks`);
  });

  test('calls /api/doctor with the token header; server strings only as text', () => {
    assert.match(js, /fetch\(fresh \? '\/api\/doctor\?fresh=1' : '\/api\/doctor', \{ headers: \{ \[TOKEN_HEADER\]: TOKEN \}/);
    assert.match(js, /const TOKEN_HEADER = 'x-switchyard-console'/);
    assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    assert.match(js, /document\.createTextNode/);
  });

  test('"Check again" skips the console\'s kept doctor result; the first load may use it', () => {
    assert.match(js, /\$\('recheck'\)\.addEventListener\('click', \(\) => load\(true\)\)/);
    assert.match(js, /async function load\(fresh = false\)/);
    assert.match(js, /\nload\(\);/);
  });

  test('shows Expected → Actual for every check that is not OK, and the fix', () => {
    assert.match(js, /if \(status !== 'ok'\)/);
    assert.match(js, /'Expected'/);
    assert.match(js, /'Actual'/);
    assert.match(js, /c\.fix/);
    assert.ok(html.includes('id="recheck"') && html.includes('Check again'));
    assert.match(html, /id="verdict"[^>]*aria-live="polite"/);
    assert.match(html, /id="error"[^>]*role="alert"/);
  });

  test('green, amber and red from the shared tokens; phones from 320 px', () => {
    assert.match(css, /\[data-status="ok"\][^{]*\{ --sc: var\(--good\); \}/);
    assert.match(css, /\[data-status="warn"\][^{]*\{ --sc: var\(--warn\); \}/);
    assert.match(css, /\[data-status="fail"\][^{]*\{ --sc: var\(--bad\); \}/);
    assert.match(css, /@media \(prefers-color-scheme: dark\)/);
    assert.match(css, /--tap: 44px/);
    assert.match(css, /overflow-wrap: anywhere/, 'long values wrap instead of scrolling sideways');
  });
});
