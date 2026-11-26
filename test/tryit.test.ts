import assert from 'node:assert/strict';
import { test } from 'node:test';
import { splitTag, tarOne } from '../src/tryit/docker.ts';
import { checkSource, kindFor, namesFor } from '../src/tryit/server.ts';
import { pathToFileURL } from 'node:url';
import { join as joinPath } from 'node:path';

// The browser's half of Try it (plain JS, as the console serves it).
const model = (): Promise<any> => import(pathToFileURL(joinPath(import.meta.dirname, '../src/console/ui/try-model.js')).href);

test('each version source is checked before anything is built, with a reason a person can act on', () => {
  assert.equal(checkSource({ kind: 'dockerfile', value: 'FROM nginx:alpine\nRUN echo hi' }), null);
  assert.match(checkSource({ kind: 'dockerfile', value: 'RUN echo hi' })!, /no FROM line/);
  assert.equal(checkSource({ kind: 'git', value: 'https://github.com/acme/web.git#main:site' }), null);
  assert.match(checkSource({ kind: 'git', value: 'file:///etc' })!, /public git URL/);
  assert.equal(checkSource({ kind: 'image', value: 'ghcr.io/acme/web:1.2' }), null);
  assert.match(checkSource({ kind: 'image', value: 'nginx; rm -rf /' })!, /image name/);
  assert.match(checkSource({ kind: 'image', value: '  ' })!, /is empty/);
});

test('one version is an A/A test, two an A/B test, three an A/B/C test; names come from what you gave', () => {
  assert.deepEqual([1, 2, 3].map(kindFor), ['A/A', 'A/B', 'A/B/C']);
  assert.deepEqual(namesFor([{ kind: 'image', value: 'acme/web:1.0' }]), { 'try:a': 'acme/web:1.0', 'try:b': 'acme/web:1.0 (copy)' });
  assert.deepEqual(namesFor([{ kind: 'git', value: 'https://github.com/acme/shop.git#main' }, { kind: 'dockerfile', value: 'FROM x' }]), { 'try:a': 'shop', 'try:b': 'Dockerfile 2' });
});

test('image names split into name and tag, a registry port is not a tag', () => {
  assert.deepEqual(splitTag('nginx:1.27'), ['nginx', '1.27']);
  assert.deepEqual(splitTag('nginx'), ['nginx', 'latest']);
  assert.deepEqual(splitTag('registry:5000/app'), ['registry:5000/app', 'latest']);
  assert.deepEqual(splitTag('registry:5000/app:2'), ['registry:5000/app', '2']);
});

test('a lone Dockerfile becomes a valid tar archive (the build context Docker reads)', () => {
  const content = 'FROM nginx:alpine\nRUN echo "héllo"\n';
  const tar = tarOne('Dockerfile', content);
  assert.equal(tar.length % 512, 0, 'whole 512-byte blocks');
  assert.equal(tar.subarray(0, 10).toString('ascii'), 'Dockerfile');
  const size = parseInt(tar.subarray(124, 136).toString('ascii').replace(/\0.*$/, ''), 8);
  assert.equal(size, Buffer.byteLength(content));
  assert.equal(tar.subarray(512, 512 + size).toString('utf8'), content);
  // The checksum: the header's bytes summed with the checksum field read as spaces.
  const header = Buffer.from(tar.subarray(0, 512));
  const stored = parseInt(header.subarray(148, 156).toString('ascii').replace(/[\0 ].*$/, ''), 8);
  header.fill(0x20, 148, 156);
  assert.equal(stored, header.reduce((a, b) => a + b, 0));
  assert.equal(tar.subarray(257, 262).toString('ascii'), 'ustar');
});

test("your app's settings: KEY=value lines become the containers' environment; comments and junk are skipped", async () => {
  const { parseEnv } = await import('../src/tryit/server.ts');
  assert.deepEqual(parseEnv('DATABASE_URL=postgresql://u:p@host.docker.internal:5433/db\r\n# a comment\n\nNEXTAUTH_SECRET=a=b\nnot a setting\n'), ['DATABASE_URL=postgresql://u:p@host.docker.internal:5433/db', 'NEXTAUTH_SECRET=a=b']);
  assert.deepEqual(parseEnv(undefined), []);
});

test('a repository Docker cannot build says what to add, in words a person can act on', async () => {
  const { gitBuildError } = await import('../src/tryit/server.ts');
  assert.match(gitBuildError('Cannot locate specified Dockerfile: Dockerfile'), /no Dockerfile at its root/);
  assert.equal(gitBuildError('step 3 failed'), 'step 3 failed');
});

test('Try it works out what you pasted: a Dockerfile, a GitHub link (with or without https, .git) or an image name', async () => {
  const { detect } = await model();
  assert.equal(detect('FROM nginx:alpine\nRUN echo hi')!.kind, 'dockerfile');
  assert.equal(detect('github.com/acme/shop')!.value, 'https://github.com/acme/shop.git');
  assert.equal(detect('https://github.com/acme/shop.git#main:web')!.value, 'https://github.com/acme/shop.git#main:web');
  assert.equal(detect('https://gitlab.com/acme/shop/')!.kind, 'git');
  assert.equal(detect('indicraft:1.1-teal')!.kind, 'image');
  assert.equal(detect('ghcr.io/acme/web:1.2')!.kind, 'image');
  assert.equal(detect('hello there')!.kind, null);
  assert.equal(detect('  '), null);
});

test('a Dockerfile that copies project files needs its folder; one that copies from a build stage or a URL does not', async () => {
  const { copiesFiles } = await model();
  const { needsFolder } = await import('../src/tryit/server.ts');
  for (const f of [copiesFiles, needsFolder]) {
    assert.equal(f('FROM node:22\nCOPY . .\nRUN npm ci'), true);
    assert.equal(f('FROM node:22\nCOPY --chown=node package.json ./'), true);
    assert.equal(f('FROM node:22\nCOPY --from=build /app/.next ./.next'), false);
    assert.equal(f('FROM nginx\nADD https://example.com/x.tgz /x.tgz\nRUN printf hi > /i.html'), false);
  }
  const { checkSource } = await import('../src/tryit/server.ts');
  assert.match(checkSource({ kind: 'dockerfile', value: 'FROM node:22\nCOPY . .' })!, /Choose project folder/);
  assert.equal(checkSource({ kind: 'folder', value: 'a'.repeat(24), dockerfile: 'Dockerfile.teal' }), null);
  assert.match(checkSource({ kind: 'folder', value: 'a'.repeat(24), dockerfile: '../etc/passwd' })!, /cannot use/);
  assert.match(checkSource({ kind: 'imagefile', value: 'nope' })!, /unknown upload/);
});

test('a chosen folder: its top-level Dockerfiles found (Dockerfile first), node_modules and .git left out', async () => {
  const { dockerfilesIn, SKIP } = await model();
  assert.deepEqual(dockerfilesIn(['src/Dockerfile', 'Dockerfile.teal', 'package.json', 'Dockerfile', 'web.Dockerfile']), ['Dockerfile', 'Dockerfile.teal', 'web.Dockerfile']);
  assert.equal(SKIP.test('node_modules/react/index.js'), true);
  assert.equal(SKIP.test('app/.git/HEAD'), true);
  assert.equal(SKIP.test('src/app/page.tsx'), false);
});

test("a folder becomes a tar archive the system tar reads back, long paths included", async () => {
  const { tarParts } = await model();
  const { mkdtempSync, writeFileSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const long = `${'deep/'.repeat(30)}file.txt`;
  const enc = new TextEncoder();
  const files = [{ path: 'Dockerfile', text: 'FROM nginx\nCOPY . /x\n' }, { path: long, text: 'héllo' }];
  const parts = tarParts(files.map((f) => ({ path: f.path, size: enc.encode(f.text).length, data: enc.encode(f.text) })));
  const dir = mkdtempSync(join(tmpdir(), 'tarparts-'));
  writeFileSync(join(dir, 'a.tar'), Buffer.from(await new Blob(parts).arrayBuffer()));
  let listed: string;
  try {
    listed = execFileSync('tar', ['-tf', 'a.tar'], { cwd: dir, encoding: 'utf8' });
  } catch {
    return; // no tar on this machine
  }
  assert.deepEqual(listed.trim().split(/\r?\n/), ['Dockerfile', long]);
  execFileSync('tar', ['-xf', 'a.tar'], { cwd: dir });
  assert.equal(readFileSync(join(dir, long), 'utf8'), 'héllo');
});

test("a git URL without a branch builds the repository's default branch, not Docker's guess of master", async () => {
  const { defaultBranch, gitBuildError } = await import('../src/tryit/server.ts');
  assert.equal(defaultBranch('https://github.com/acme/web.git'), 'https://github.com/acme/web.git#HEAD');
  assert.equal(defaultBranch('https://github.com/acme/web.git#:site'), 'https://github.com/acme/web.git#HEAD:site');
  assert.equal(defaultBranch('https://github.com/acme/web.git#main'), 'https://github.com/acme/web.git#main');
  assert.match(gitBuildError("error fetching: fatal: couldn't find remote ref dev"), /that branch doesn't exist/);
});

test('build output becomes clean log lines: colour codes and progress-bar rewrites dropped', async () => {
  const { cleanLines, gitBuildError } = await import('../src/tryit/server.ts');
  assert.deepEqual(cleanLines('\x1b[32mStep 1/4 : FROM nginx\x1b[0m\r\n\nDownloading 10%\rDownloading 100%\n'), ['Step 1/4 : FROM nginx', 'Downloading 100%']);
  assert.match(gitBuildError('When using COPY with more than one source file, the destination must be a directory and end with a /'), /repository's own Dockerfile has a mistake/);
});
