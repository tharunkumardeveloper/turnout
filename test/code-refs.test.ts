import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { init } from '../src/commands/init.ts';
import { loadConfig, parseConfig } from '../src/config.ts';
import { AdminClient } from '../src/flagsmith/admin.ts';
import { findReferences, githubRepoUrl, listFiles, resolveRepository, scanAndSubmit, type Git } from '../src/flagsmith/code-refs.ts';
import { calls, emptyState, SEED, seededState, startFakeAdmin } from './fake-admin.ts';

const REPO = fileURLToPath(new URL('../', import.meta.url));
const noGit: Git = () => {
  throw new Error('git: not found');
};
// A git that knows only what it's told: ls-files output, the origin remote and HEAD.
const fakeGit = (o: { files?: string[]; origin?: string; head?: string }): Git => (args) => {
  if (args[0] === 'ls-files' && o.files) return o.files.join('\0') + '\0';
  if (args[0] === 'remote' && o.origin) return `${o.origin}\n`;
  if (args[0] === 'rev-parse' && o.head) return `${o.head}\n`;
  throw new Error(`fatal: ${args.join(' ')}`);
};

function checkout(): string {
  const root = mkdtempSync(join(tmpdir(), 'sy-refs-'));
  const write = (path: string, text: string | Buffer) => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  write('turnout.config.yml', '# release router\nflag: my_flag\nreleases: {}\n');
  write('compose.yaml', 'services:\r\n  proxy:\r\n    environment:\r\n      FLAG: my_flag\r\n');
  write('demo/shop/server.ts', 'export const flagless = true; // my_flag_v2 is a different name\n');
  write('README.md', 'The my_flag flag routes releases.\n');
  write('docs/notes.ts', 'my_flag\n');
  write('test/fixture.ts', 'my_flag\n');
  write('spikes/a.ts', 'my_flag\n');
  write('node_modules/x/index.js', 'my_flag\n');
  write('.turnout/ledger.jsonl', '{"flag":"my_flag"}\n');
  write('.env', 'SECRET=my_flag\n');
  write('.env.example', 'FLAG=\n');
  write('logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0x6d, 0x79, 0x5f, 0x66, 0x6c, 0x61, 0x67]));
  return root;
}

describe('code references: the scan', () => {
  test('without git it walks the files, skipping dependencies, state, spikes, docs, tests, Markdown and .env', () => {
    const files = listFiles(checkout(), noGit);
    assert.deepEqual(files, ['.env.example', 'compose.yaml', 'demo/shop/server.ts', 'logo.png', 'turnout.config.yml']);
  });

  test('with git it takes tracked and not-ignored files, with the same skips', () => {
    const git = fakeGit({ files: ['src/a.ts', 'docs/b.ts', 'test/c.ts', 'README.md', 'app/.env.local'] });
    assert.deepEqual(listFiles('/nowhere', git), ['src/a.ts']);
  });

  test('one reference per line naming the flag as a whole word, in text files only, CRLF or not', () => {
    const root = checkout();
    assert.deepEqual(findReferences(root, ['my_flag'], listFiles(root, noGit)), [
      { feature_name: 'my_flag', file_path: 'compose.yaml', line_number: 4 },
      { feature_name: 'my_flag', file_path: 'turnout.config.yml', line_number: 2 },
    ]);
  });

  test("this repository names its release flag only in infrastructure config, never in the app", () => {
    const flag = loadConfig(join(REPO, 'turnout.config.yml')).flag;
    const refs = findReferences(REPO, [flag]);
    assert.ok(refs.length > 0, 'the config names the flag');
    for (const r of refs) assert.match(r.file_path, /^(turnout\.config\.yml|compose[\w.-]*\.ya?ml|action\.yml|\.github\/)/, `${r.file_path}:${r.line_number}`);
  });
});

describe('code references: the repository', () => {
  test('GitHub remotes: https only, without .git or credentials', () => {
    assert.equal(githubRepoUrl('https://github.com/acme/turnout.git'), 'https://github.com/acme/turnout');
    assert.equal(githubRepoUrl('https://user:ghp_secret@github.com/acme/turnout'), 'https://github.com/acme/turnout');
    assert.equal(githubRepoUrl('git@github.com:acme/turnout.git'), undefined);
    assert.equal(githubRepoUrl('https://gitlab.com/acme/turnout'), undefined);
    assert.equal(githubRepoUrl('https://github.com/acme'), undefined);
  });

  test("GitHub Actions' variables first, then the https origin remote, then TURNOUT_REPOSITORY_URL, else skip", () => {
    const gh = { GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'acme/app', GITHUB_SHA: 'abc123' };
    const git = fakeGit({ origin: 'https://github.com/acme/other.git', head: 'def456' });
    assert.deepEqual(resolveRepository(gh, '.', git), { repositoryUrl: 'https://github.com/acme/app', revision: 'abc123', from: 'github-actions' });
    assert.deepEqual(resolveRepository({ TURNOUT_REPOSITORY_URL: 'https://github.com/acme/env' }, '.', git), {
      repositoryUrl: 'https://github.com/acme/other',
      revision: 'def456',
      from: 'git remote',
    });
    // The Docker image has no git: the env URL, with TURNOUT_REVISION or HEAD.
    assert.deepEqual(resolveRepository({ TURNOUT_REPOSITORY_URL: 'https://github.com/acme/env.git' }, '.', noGit), {
      repositoryUrl: 'https://github.com/acme/env',
      revision: 'HEAD',
      from: 'TURNOUT_REPOSITORY_URL',
    });
    assert.equal((resolveRepository({ TURNOUT_REPOSITORY_URL: 'https://x.example/r', TURNOUT_REVISION: 'v1.6' }, '.', noGit) as { revision: string }).revision, 'v1.6');
    assert.match((resolveRepository({}, '.', fakeGit({ origin: 'git@github.com:acme/app.git' })) as { skip: string }).skip, /no repository URL/);
    assert.match((resolveRepository({ TURNOUT_REPOSITORY_URL: 'https://u:p@github.com/a/b' }, '.', noGit) as { skip: string }).skip, /without credentials/);
  });
});

describe('code references: submitting to Flagsmith', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  test('submits the scan; Flagsmith lists the references with GitHub permalinks and files the flag as live', async () => {
    const state = seededState();
    const fake = await startFakeAdmin(state);
    close = fake.close;
    const api = new AdminClient(fake.apiUrl, { apiKey: SEED.adminKey });
    const root = checkout();
    writeFileSync(join(root, 'turnout.config.yml'), 'flag: shop_release\n');
    const lines: string[] = [];
    const result = await scanAndSubmit({
      api,
      projectId: SEED.projectId,
      flags: ['shop_release'],
      root,
      env: { GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'acme/app', GITHUB_SHA: 'abc123' },
      git: noGit,
      log: (l) => lines.push(l),
    });
    assert.equal(result.submitted, true);
    const [post] = calls(state, 'POST', /code-references\/$/);
    assert.deepEqual(post?.body, {
      repository_url: 'https://github.com/acme/app',
      vcs_provider: 'github',
      revision: 'abc123',
      code_references: [{ feature_name: 'shop_release', file_path: 'turnout.config.yml', line_number: 1 }],
    });
    assert.match(lines.join('\n'), /✓ code references: shop_release appears in 1 place: turnout\.config\.yml:1/);

    const listed = await api.get<{ code_references: { permalink: string }[] }[]>(`/api/v1/projects/${SEED.projectId}/features/${SEED.featureId}/code-references/`);
    assert.equal(listed[0]?.code_references[0]?.permalink, 'https://github.com/acme/app/blob/abc123/turnout.config.yml#L1');
    const counts = await api.get<Record<string, number>>('/api/v1/environments/3/feature-lifecycle-counts/');
    assert.equal(counts.live, 1);
  });

  test('without a repository URL it reports what it found and submits nothing', async () => {
    const state = seededState();
    const fake = await startFakeAdmin(state);
    close = fake.close;
    const lines: string[] = [];
    const result = await scanAndSubmit({
      api: new AdminClient(fake.apiUrl, { apiKey: SEED.adminKey }),
      projectId: SEED.projectId,
      flags: ['my_flag'],
      root: checkout(),
      env: {},
      git: noGit,
      log: (l) => lines.push(l),
    });
    assert.equal(result.submitted, false);
    assert.equal(calls(state, 'POST', /code-references/).length, 0);
    assert.match(lines[0]!, /^· code references not submitted \(no repository URL.*\)\. my_flag appears in 2 places: compose\.yaml:4, turnout\.config\.yml:2\.$/);
  });

  test('init submits the scan when asked, and a refused submission never fails init', async () => {
    const config = parseConfig({
      flag: 'my_flag',
      releases: { 'shop:1.4': 'http://shop-1-4:8080', 'shop:1.5': 'http://shop-1-5:8080' },
      goal: { event: 'order_placed', when: { method: 'POST', path: '/checkout', status: '2xx' } },
      guardrails: ['doc_latency_ms'],
    });
    for (const refuse of [false, true]) {
      const state = emptyState();
      if (refuse) state.failWhen = (method, path) => method === 'POST' && path.endsWith('/code-references/');
      const fake = await startFakeAdmin(state);
      const dir = mkdtempSync(join(tmpdir(), 'sy-init-refs-'));
      const lines: string[] = [];
      await init({
        apiUrl: fake.apiUrl,
        dashboardUrl: 'http://localhost:8000',
        config,
        adminKey: undefined,
        envFile: join(dir, '.env'),
        log: (l) => lines.push(l),
        codeReferences: { root: checkout(), env: { TURNOUT_REPOSITORY_URL: 'https://github.com/acme/app' }, git: noGit },
      });
      await fake.close();
      const text = lines.join('\n');
      if (refuse) {
        assert.match(text, /· code references not submitted: POST \/api\/v1\/projects\/\d+\/code-references\/ → 500/);
        assert.equal(state.codeScans.length, 0);
      } else {
        assert.match(text, /✓ code references: my_flag appears in 2 places/);
        assert.equal(state.codeScans[0]?.repositoryUrl, 'https://github.com/acme/app');
        assert.equal(state.codeScans[0]?.revision, 'HEAD');
      }
      assert.match(text, /✓ experiment ".*" is running/, 'init carried on to the end');
    }
  });

  test('init without the option scans nothing', async () => {
    const state = emptyState();
    const fake = await startFakeAdmin(state);
    close = fake.close;
    await init({
      apiUrl: fake.apiUrl,
      dashboardUrl: 'http://localhost:8000',
      config: loadConfig(join(REPO, 'turnout.config.yml')),
      adminKey: undefined,
      envFile: join(mkdtempSync(join(tmpdir(), 'sy-init-')), '.env'),
      log: () => {},
    });
    assert.equal(calls(state, 'POST', /code-references/).length, 0);
  });
});
