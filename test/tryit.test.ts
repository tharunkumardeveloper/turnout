import assert from 'node:assert/strict';
import { test } from 'node:test';
import { splitTag, tarOne } from '../src/tryit/docker.ts';
import { checkSource, kindFor, namesFor } from '../src/tryit/server.ts';

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
