import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { databaseFor, generatedDockerfile, missingSettings, tarAppend, tarIndex, wantsDatabase } from '../src/tryit/autobuild.ts';

const none = () => null;

test('a Node app with a start script runs npm start', () => {
  const d = generatedDockerfile(['package.json', 'server.js'], () => '{"scripts":{"start":"node server.js"}}')!;
  assert.match(d, /FROM node:22-alpine/);
  assert.match(d, /CMD \["npm", "start"\]/);
});

test('a Node project with only a build script is served as a static site', () => {
  const d = generatedDockerfile(['package.json'], () => '{"scripts":{"build":"vite build"}}')!;
  assert.match(d, /nginx/);
  assert.match(d, /\/app\/dist/);
});

test('Python, Go, PHP and plain HTML each get their own', () => {
  assert.match(generatedDockerfile(['requirements.txt', 'app.py'], () => 'flask==3')!, /flask", "--app", "app"/);
  assert.match(generatedDockerfile(['requirements.txt', 'manage.py'], () => 'django')!, /manage.py", "runserver/);
  assert.match(generatedDockerfile(['go.mod', 'main.go'], none)!, /golang/);
  assert.match(generatedDockerfile(['index.php'], none)!, /php:8.3-apache/);
  assert.match(generatedDockerfile(['index.html', 'style.css'], none)!, /nginx/);
  assert.equal(generatedDockerfile(['notes.txt'], none), null);
});

test('settings named in an error', () => {
  assert.deepEqual(missingSettings('Error: SECRET_KEY is not set'), ['SECRET_KEY']);
  assert.deepEqual(missingSettings("KeyError: 'STRIPE_KEY'"), ['STRIPE_KEY']);
  assert.deepEqual(missingSettings('Error: DATABASE_URL is not set'), ['DATABASE_URL']);
  assert.deepEqual(missingSettings('missing environment variable API_TOKEN'), ['API_TOKEN']);
  assert.deepEqual(missingSettings('listening on port 3000'), []);
});

test('a database when the settings point at one', () => {
  assert.equal(wantsDatabase(['DATABASE_URL']), 'postgres');
  assert.equal(wantsDatabase(['MYSQL_HOST']), 'mysql');
  assert.equal(wantsDatabase(['SECRET_KEY']), null);
  assert.equal(wantsDatabase([], 'connect ECONNREFUSED 127.0.0.1:5432'), 'postgres');
  assert.match(databaseFor('postgres').appEnv[0]!, /^DATABASE_URL=postgres:\/\/.*@try-db:5432/);
});

test('a tar is read and added to without unpacking it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tn-tar-'));
  const file = join(dir, 'a.tar');
  writeFileSync(file, Buffer.alloc(1024));
  tarAppend(file, 'package.json', '{"name":"x"}');
  tarAppend(file, 'Dockerfile.turnout', 'FROM node\n');
  const { files, read } = tarIndex(readFileSync(file));
  assert.deepEqual(files, ['package.json', 'Dockerfile.turnout']);
  assert.equal(read('package.json'), '{"name":"x"}');
  assert.equal(read('Dockerfile.turnout'), 'FROM node\n');
});

test('the running site is walked once and only actions every version has are offered', async () => {
  const { walk, common, describeAction } = await import('../src/tryit/discover.ts');
  const pages: Record<string, string> = {
    '/': '<a href="/about">About</a><form method="post" action="/signup"></form>',
    '/about': '<a href="/cv.pdf">CV</a><a href="/gone">Gone</a>',
    '/cv.pdf': '%PDF',
  };
  const fake = (async (u: URL) => new Response(pages[u.pathname] ?? 'nope', { status: pages[u.pathname] ? 200 : 404, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch;
  const goals = await walk('http://x', 8, fake);
  assert.deepEqual(goals, ['POST /signup', 'GET /about*', 'GET /cv.pdf']);
  assert.deepEqual(common([goals, ['GET /cv.pdf', 'POST /signup']]), ['POST /signup', 'GET /cv.pdf']);
  assert.equal(describeAction('POST /signup'), 'sends the form to /signup');
  assert.equal(describeAction('GET /cv.pdf'), 'downloads cv.pdf');
});
