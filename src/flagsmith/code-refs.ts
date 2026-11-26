// Code References: where the release flag's name appears in this repository, submitted to Flagsmith so its dashboard
// shows it on the flag (Usage tab) and its Lifecycle page can use it.
//
// Switchyard's claim is "zero app code": the flag's name should appear only in infrastructure config
// (switchyard.config.yml), never in the app. This scan is the evidence, kept in Flagsmith itself.
//
// Flagsmith 2.291.0, projects/code_references/:
// - POST /api/v1/projects/<id>/code-references/ takes { repository_url, vcs_provider ("github", the only choice),
//   revision, code_references: [{ feature_name, file_path, line_number }] } (serializers.py:30-41, types.py:10-11);
//   any user who can view the project may submit (permissions.py:10-21). Names that aren't flags in the project are
//   dropped (services.py:140-160). Flagsmith stores the repository URL and never fetches it; it only builds
//   permalinks from it: <repository_url>/blob/<revision>/<file_path>#L<line> (services.py:183-196).
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import type { AdminClient } from './admin.ts';

// Not scanned: dependencies, VCS and state, throwaway spikes, tests (they name the flag in fixtures) and
// documentation (Markdown prose talks about the flag; it doesn't use it).
export const SKIP_DIRS = new Set(['node_modules', '.git', '.switchyard', 'spikes', 'docs', 'test', 'coverage', '.tmp']);
const SKIP_EXTENSIONS = new Set(['.md', '.mdx']);
const MAX_BYTES = 1_000_000;

export type CodeReference = { feature_name: string; file_path: string; line_number: number };
export type Repository = { repositoryUrl: string; revision: string; from: 'github-actions' | 'git remote' | 'SWITCHYARD_REPOSITORY_URL' };
export type Git = (args: string[], cwd: string) => string; // throws when git or the repository is missing

const runGit: Git = (args, cwd) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 });

const toPosix = (p: string) => p.split(sep).join('/');

export function skipped(path: string): boolean {
  const parts = path.split('/');
  const base = parts[parts.length - 1] ?? '';
  if (parts.slice(0, -1).some((d) => SKIP_DIRS.has(d)) || SKIP_DIRS.has(base)) return true;
  if (SKIP_EXTENSIONS.has(extname(base).toLowerCase())) return true;
  return base.startsWith('.env') && base !== '.env.example'; // secrets never get read, even for a name
}

// Tracked and not-ignored files when this is a git checkout; otherwise (the Docker image has no .git and no git)
// every file under root. Paths are relative and use "/".
export function listFiles(root: string, git: Git = runGit): string[] {
  let files: string[];
  try {
    files = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], root).split('\0').filter(Boolean);
  } catch {
    files = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        const rel = toPosix(relative(root, full));
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) walk(full);
        } else if (entry.isFile()) files.push(rel);
      }
    };
    walk(root);
  }
  return files.filter((f) => !skipped(f)).sort();
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// One reference per line that names a flag as a whole word: "my_flag" matches my_flag, not my_flag_v2.
export function findReferences(root: string, flags: string[], files: string[] = listFiles(root)): CodeReference[] {
  const patterns = flags.map((flag) => ({ flag, re: new RegExp(`(?<![A-Za-z0-9_])${escape(flag)}(?![A-Za-z0-9_])`) }));
  const found: CodeReference[] = [];
  for (const file of files) {
    let text: string;
    try {
      const full = join(root, file);
      if (statSync(full).size > MAX_BYTES) continue;
      const buf = readFileSync(full);
      if (buf.subarray(0, 8192).includes(0)) continue; // binary
      text = buf.toString('utf8');
    } catch {
      continue; // listed but gone, or unreadable
    }
    text.split(/\r?\n/).forEach((line, i) => {
      for (const { flag, re } of patterns) if (re.test(line)) found.push({ feature_name: flag, file_path: file, line_number: i + 1 });
    });
  }
  return found;
}

// "https://github.com/owner/repo(.git)" → "https://github.com/owner/repo". Anything else (SSH remotes, other hosts)
// → undefined. Credentials embedded in the remote are never kept.
export function githubRepoUrl(remote: string): string | undefined {
  let url: URL;
  try {
    url = new URL(remote.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com') return undefined;
  const path = url.pathname.replace(/\.git$/, '').replace(/\/+$/, '');
  if (!/^\/[\w.-]+\/[\w.-]+$/.test(path)) return undefined;
  return `https://github.com${path}`;
}

function publicHttpUrl(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return undefined;
    return url.href.replace(/\/+$/, '').replace(/\.git$/, '');
  } catch {
    return undefined;
  }
}

// Where the scan came from. GitHub Actions' own variables first; then the checkout's https GitHub "origin"; then
// SWITCHYARD_REPOSITORY_URL. Without any of them there is nothing honest to submit, so the scan is skipped.
export function resolveRepository(env: NodeJS.ProcessEnv, root: string, git: Git = runGit): Repository | { skip: string } {
  if (env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_SHA) {
    const url = publicHttpUrl(`${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}`);
    if (url) return { repositoryUrl: url, revision: env.GITHUB_SHA, from: 'github-actions' };
  }
  const head = () => {
    try {
      return git(['rev-parse', 'HEAD'], root).trim() || undefined;
    } catch {
      return undefined; // no git, or no commits yet
    }
  };
  let remote: string | undefined;
  try {
    remote = githubRepoUrl(git(['remote', 'get-url', 'origin'], root));
  } catch {
    remote = undefined;
  }
  // A commit Flagsmith's permalinks can point at; without one, HEAD (GitHub resolves it to the default branch).
  const revision = () => env.SWITCHYARD_REVISION?.trim() || head() || 'HEAD';
  if (remote) return { repositoryUrl: remote, revision: revision(), from: 'git remote' };
  if (env.SWITCHYARD_REPOSITORY_URL) {
    const url = publicHttpUrl(env.SWITCHYARD_REPOSITORY_URL);
    if (!url) return { skip: 'SWITCHYARD_REPOSITORY_URL is not an http(s) URL without credentials' };
    return { repositoryUrl: url, revision: revision(), from: 'SWITCHYARD_REPOSITORY_URL' };
  }
  return { skip: 'no repository URL: the checkout has no https GitHub "origin" remote and SWITCHYARD_REPOSITORY_URL is not set' };
}

export type ScanResult = {
  references: CodeReference[];
  filesScanned: number;
  repository: Repository | null;
  submitted: boolean;
  skipReason?: string;
};

const where = (refs: CodeReference[]) => refs.map((r) => `${r.file_path}:${r.line_number}`).join(', ');

// Scan, then submit unless there's no repository to name. Throws only when Flagsmith refuses the submission.
export async function scanAndSubmit(o: {
  api: AdminClient;
  projectId: number;
  flags: string[];
  root: string;
  env?: NodeJS.ProcessEnv;
  git?: Git;
  log?: (line: string) => void;
}): Promise<ScanResult> {
  const log = o.log ?? console.log;
  const git = o.git ?? runGit;
  const files = listFiles(o.root, git);
  const references = findReferences(o.root, o.flags, files);
  const found = references.length
    ? `${o.flags.join(', ')} appears in ${references.length} place${references.length === 1 ? '' : 's'}: ${where(references)}`
    : `${o.flags.join(', ')} appears in none of the ${files.length} files scanned`;
  const repository = resolveRepository(o.env ?? process.env, o.root, git);
  if ('skip' in repository) {
    log(`· code references not submitted (${repository.skip}). ${found}.`);
    return { references, filesScanned: files.length, repository: null, submitted: false, skipReason: repository.skip };
  }
  await o.api.post(`/api/v1/projects/${o.projectId}/code-references/`, {
    repository_url: repository.repositoryUrl,
    vcs_provider: 'github',
    revision: repository.revision,
    code_references: references,
  });
  log(`✓ code references: ${found} (${files.length} files scanned; submitted for ${repository.repositoryUrl} at ${repository.revision.slice(0, 12)})`);
  return { references, filesScanned: files.length, repository, submitted: true };
}
