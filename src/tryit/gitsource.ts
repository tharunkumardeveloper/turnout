// A git repository as a folder: cloned (shallow), then packed as the same tar a folder upload is, so it gets
// everything a folder gets, a Dockerfile written for it when it has none included. Docker's own git build can only
// use a repository's Dockerfile, and most small repositories don't have one.
import { execFile } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error: a plain browser module with no types (the console page loads it as is)
import { SKIP, tarParts } from '../console/ui/try-model.js';

const MAX_BYTES = 512 * 1024 ** 2; // a repository bigger than this, without node_modules and .git, isn't a small app

/** "https://host/owner/repo[.git][#ref[:folder]]" → the clone URL, the ref (null: the default branch) and the folder. */
export function parseGitSource(url: string): { repo: string; ref: string | null; folder: string } {
  const [base = '', fragment = ''] = url.trim().split('#');
  let repo = base.replace(/\/+$/, '');
  // A link copied from the browser (github.com/owner/repo) works as well as the clone URL.
  if (/^https:\/\/(www\.)?(github\.com|gitlab\.com|bitbucket\.org)\/[^/]+\/[^/]+$/i.test(repo) && !repo.endsWith('.git')) repo += '.git';
  const [ref = '', folder = ''] = fragment.split(':');
  const cleanFolder = folder.replace(/^\/+|\/+$/g, '');
  if (cleanFolder.split('/').includes('..')) throw new Error('the folder after the colon must be inside the repository');
  return { repo, ref: ref && ref !== 'HEAD' ? ref : null, folder: cleanFolder };
}

/** True when this machine can clone (the Turnout image has git; a bare checkout may not). */
export function hasGit(): Promise<boolean> {
  return new Promise((resolve) => execFile('git', ['--version'], (error) => resolve(!error)));
}

function git(args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 5 * 60_000, maxBuffer: 4 * 1024 ** 2, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1' } }, (error, _out, err) =>
      error ? reject(new Error((err || error.message).trim().split('\n').slice(-3).join(' '))) : resolve(_out),
    );
  });
}

function filesOf(root: string, dir = ''): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(root, dir))) {
    const rel = dir ? `${dir}/${name}` : name;
    if (SKIP.test(rel)) continue;
    const st = statSync(join(root, rel), { throwIfNoEntry: false });
    if (!st) continue;
    if (st.isDirectory()) out.push(...filesOf(root, rel));
    else if (st.isFile()) out.push(rel);
  }
  return out;
}

/** Clones the repository and writes it to `tarFile` as a folder upload. Returns the commit it got. */
export async function gitToTar(url: string, tarFile: string, onLog: (line: string) => void = () => {}): Promise<string> {
  const { repo, ref, folder } = parseGitSource(url);
  if (!/^https:\/\//.test(repo)) throw new Error('only https git URLs can be cloned here, such as https://github.com/you/app');
  const work = mkdtempSync(join(tmpdir(), 'turnout-git-'));
  try {
    onLog(`Cloning ${repo}${ref ? ` (${ref})` : ''}`);
    await git(['clone', '--depth', '1', '--single-branch', '--no-tags', ...(ref ? ['--branch', ref] : []), '--', repo, 'repo'], work).catch((error: Error) => {
      if (/not found|could not read Username|Authentication|terminal prompts disabled/i.test(error.message)) throw new Error(`git couldn't fetch the repository (${error.message}). It must be a public git URL.`);
      if (/Remote branch .* not found/i.test(error.message)) throw new Error(`that branch doesn't exist in the repository (${error.message}). Leave the branch out to use the repository's default one.`);
      throw new Error(`git clone failed: ${error.message}`);
    });
    const commit = (await git(['rev-parse', '--short', 'HEAD'], join(work, 'repo')).catch(() => '')).trim();
    const root = join(work, 'repo', folder);
    if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`the repository has no folder "${folder}"`);
    let total = 0;
    const entries = filesOf(root).map((path) => {
      const data = new Uint8Array(readFileSync(join(root, path)));
      total += data.length;
      if (total > MAX_BYTES) throw new Error('the repository is over 512 MB without node_modules and .git: build its image yourself and paste the image name');
      // Executable files stay executable (bin/rails, gradlew, entrypoint scripts): git records the bit.
      const mode = statSync(join(root, path)).mode & 0o111 ? 0o755 : 0o644;
      return { path, size: data.length, data, mode };
    });
    writeFileSync(tarFile, Buffer.concat(tarParts(entries)));
    onLog(`Cloned ${entries.length} files${commit ? ` at ${commit}` : ''}${folder ? `, folder ${folder}` : ''}`);
    return commit;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
