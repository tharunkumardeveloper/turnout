import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const UI = fileURLToPath(new URL('../src/console/ui/', import.meta.url));
const read = (name: string) => readFileSync(join(UI, name), 'utf8');
const html = read('flagsmith.html');
const js = read('flagsmith.js');
const css = read('flagsmith.css');
// Plain browser JS: it touches the DOM only when the page is there, so Node can import it.
const M: any = await import(pathToFileURL(join(UI, 'flagsmith.js')).href);

describe('the feature map page', () => {
  test('loads its module, the shared stylesheet and its own, with a token slot and no inline script', () => {
    assert.match(html, /<script type="module" src="\/flagsmith\.js"><\/script>/);
    assert.match(html, /<link rel="stylesheet" href="\/style\.css">\s*<link rel="stylesheet" href="\/flagsmith\.css">/);
    assert.match(html, /name="color-scheme" content="light dark"/);
    assert.match(html, /name="viewport" content="width=device-width/);
    assert.ok(html.includes('<meta name="turnout-console" content="">'));
    assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)[^>]*>/);
    for (const tag of ['<header', '<main', '<footer']) assert.ok(html.includes(tag), tag);
  });

  test('every element the script looks up exists, and the API call carries the token', () => {
    const used = [...js.matchAll(/\$\('([\w-]+)'\)/g)].map((m) => m[1]!);
    assert.ok(used.length >= 5);
    for (const id of new Set(used)) assert.ok(html.includes(`id="${id}"`), `flagsmith.js uses #${id}`);
    // Under /judge on the public page (menu.js BASE).
    assert.match(js, /fetch\(`\$\{BASE\}\/api\/flagsmith-map`, \{ headers: \{ \[TOKEN_HEADER\]: TOKEN \} \}\)/);
    assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });

  test('groups: used live, read only, needs a public endpoint or account, not used', () => {
    assert.deepEqual(
      M.GROUPS.map((g: { status: string; title: string }) => [g.status, g.title]),
      [
        ['used', 'Used live'],
        ['used-read-only', 'Read only'],
        ['not-available-locally', 'Needs a public endpoint or account'],
        ['not-used', 'Not used'],
      ],
    );
  });

  test('only http(s) links from the server become hrefs', () => {
    assert.equal(M.safeHref('http://localhost:8000/project/1/segments'), 'http://localhost:8000/project/1/segments');
    assert.equal(M.safeHref('https://github.com/acme/app/blob/abc/x.yml#L2'), 'https://github.com/acme/app/blob/abc/x.yml#L2');
    for (const bad of ['javascript:alert(1)', 'data:text/html,hi', '/relative', '', null, 42]) assert.equal(M.safeHref(bad), null, String(bad));
  });

  test('phones to desktops, light and dark: one column at 360 px, 44 px targets, status colours from the tokens', () => {
    assert.match(css, /--gutter: 16px/);
    assert.match(css, /grid-template-columns: repeat\(auto-fill, minmax\(min\(100%, 300px\), 1fr\)\)/);
    assert.match(css, /min-height: var\(--tap\)/);
    assert.match(css, /@media \(prefers-color-scheme: dark\)/);
    assert.match(css, /\[data-status="used"\] \{ --s: var\(--treatment\); \}/);
    assert.match(css, /\[data-status="used-read-only"\] \{ --s: var\(--control\); \}/);
    assert.match(css, /overflow-wrap: anywhere/);
  });
});
