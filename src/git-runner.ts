import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DomainError, treeHash } from './core.js';
import type { Files } from './contracts.js';

export interface GitCandidateInput {
  repository: string;
  expectedHead: string;
  files: Files;
  validate: (directory: string) => Promise<{ passed: boolean; checks: string[] }>;
}

export interface GitCandidate {
  commit: string;
  tree: string;
  contentHash: string;
  passed: boolean;
  checks: string[];
  bundle: Uint8Array;
}

const IDENTITY = ['-c', 'user.name=Confluence', '-c', 'user.email=prototype@example.invalid'];

function fail(code: string, message: string): never {
  throw new DomainError(code, message);
}

function req(cond: boolean, code: string, message: string): void {
  if (!cond) fail(code, message);
}

interface GitOut { stdout: string; stderr: string }

function git(cwd: string, args: string[]): Promise<GitOut> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d; });
    child.stderr.on('data', (d: Buffer) => { stderr += d; });
    child.on('error', (err) => reject(new DomainError('git_failed', `git ${args[0]} could not run: ${String(err)}`)));
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new DomainError('git_failed', `git ${args.join(' ')} exited ${code}: ${(stderr || stdout).trim()}`));
    });
  });
}

function filesOf(v: unknown): Files {
  req(typeof v === 'object' && v !== null && !Array.isArray(v), 'invalid_files', 'files must be a record of path to string content');
  const files = v as Record<string, unknown>;
  for (const [p, c] of Object.entries(files)) {
    req(typeof c === 'string', 'invalid_files', `files[${p}] must be string content`);
  }
  return files as Files;
}

function safeSegments(raw: string): string[] {
  req(raw.length > 0, 'unsafe_path', 'path must be non-empty');
  req(!raw.includes('\\'), 'unsafe_path', `backslash not allowed in path ${raw}`);
  req(!raw.includes('\0'), 'unsafe_path', `control character in path ${raw}`);
  req(!raw.startsWith('/') && !/^[A-Za-z]:/.test(raw), 'unsafe_path', `absolute path not allowed: ${raw}`);
  const segments = raw.split('/');
  for (const seg of segments) {
    req(seg !== '' , 'unsafe_path', `empty path segment in ${raw}`);
    req(seg !== '.' && seg !== '..', 'unsafe_path', `traversal segment in ${raw}`);
    req(seg.toLowerCase() !== '.git', 'unsafe_path', `.git path not allowed: ${raw}`);
    req(!/[\u0001-\u001f\u007f]/.test(seg), 'unsafe_path', `control character in path ${raw}`);
  }
  return segments;
}

function checkAmbiguity(paths: string[]): void {
  const sorted = [...paths].sort();
  for (let i = 1; i < sorted.length; i++) {
    req(!(sorted[i] === sorted[i - 1] || sorted[i].startsWith(`${sorted[i - 1]}/`)), 'duplicate_path', `ambiguous candidate path ${sorted[i - 1]} vs ${sorted[i]}`);
  }
}

async function scanWorktree(dir: string, rel = ''): Promise<string[]> {
  const found: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '.git') continue;
    const p = rel ? `${rel}/${entry.name}` : entry.name;
    req(!entry.isSymbolicLink(), 'symlink_escape', `symlink in candidate worktree: ${p}`);
    if (entry.isDirectory()) {
      found.push(...await scanWorktree(path.join(dir, entry.name), p));
    } else {
      req(entry.isFile(), 'unsafe_path', `unsupported file type in candidate worktree: ${p}`);
      found.push(p);
    }
  }
  return found.sort();
}

async function verifyPrepared(dir: string, files: Files, contentHash: string): Promise<void> {
  const present = await scanWorktree(dir);
  const expected = Object.keys(files).sort();
  req(present.join('\n') === expected.join('\n'), 'candidate_mutated', 'worktree file set does not match candidate');
  const readBack: Files = {};
  for (const p of expected) readBack[p] = await readFile(path.join(dir, ...safeSegments(p)), 'utf8');
  req((await treeHash(readBack)) === contentHash, 'candidate_mutated', 'candidate bytes changed');
}

export async function prepareGitCandidate(input: GitCandidateInput): Promise<GitCandidate> {
  req(typeof input === 'object' && input !== null, 'invalid_input', 'input required');
  const { validate } = input;
  req(typeof validate === 'function', 'invalid_validate', 'validate must be a function');
  const repository = input.repository;
  req(typeof repository === 'string' && repository.length > 0 && !repository.includes('://'), 'invalid_repository', 'repository must be an existing local git repository path');
  const repoDir = path.resolve(repository);
  req(typeof input.expectedHead === 'string' && input.expectedHead.trim().length > 0, 'invalid_head', 'expectedHead must be a non-empty string');
  const files = filesOf(input.files);
  for (const p of Object.keys(files)) safeSegments(p);
  checkAmbiguity(Object.keys(files));
  const contentHash = await treeHash(files);

  let head: string;
  try {
    head = (await git(repoDir, ['rev-parse', 'HEAD'])).stdout.trim().toLowerCase();
  } catch {
    fail('invalid_repository', `not an existing local git repository: ${repoDir}`);
  }
  req(head !== '', 'invalid_repository', `repository has no HEAD commit: ${repoDir}`);
  req(head === input.expectedHead.trim().toLowerCase(), 'stale_head', `repository HEAD ${head.slice(0, 12)} does not match expectedHead ${input.expectedHead.trim().toLowerCase().slice(0, 12)}`);

  const tracked = (await git(repoDir, ['ls-files', '-s', '-z'])).stdout;
  const unsafe: string[] = [];
  for (const entry of tracked.split('\0').filter(Boolean)) {
    const mode = entry.slice(0, 6);
    const p = entry.slice(entry.indexOf('\t') + 1);
    if (mode === '120000' || mode === '160000') unsafe.push(`${p} (${mode})`);
  }
  req(unsafe.length === 0, 'unsafe_source', `source repository tracks symlink/submodule entries; refusing unsafe removal: ${unsafe.join(', ')}`);

  const tmpRoot = await mkdtemp(path.join(tmpdir(), 'confluence-git-'));
  try {
    const cloneDir = path.join(tmpRoot, 'clone');
    await git(tmpRoot, ['clone', '--no-hardlinks', '--quiet', repoDir, cloneDir]);
    const cloneHead = (await git(cloneDir, ['rev-parse', 'HEAD'])).stdout.trim().toLowerCase();
    req(cloneHead === head, 'stale_head', 'clone HEAD does not match verified source HEAD');
    await scanWorktree(cloneDir);
    await git(cloneDir, ['rm', '-r', '-f', '--ignore-unmatch', '-q', '.']);
    for (const [p, content] of Object.entries(files)) {
      const abs = path.join(cloneDir, ...safeSegments(p));
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, content);
    }
    await verifyPrepared(cloneDir, files, contentHash);
    const result = await validate(cloneDir);
    req(typeof result === 'object' && result !== null && typeof result.passed === 'boolean' && Array.isArray(result.checks) && result.checks.every((c) => typeof c === 'string'), 'invalid_validate', 'validate must return {passed: boolean, checks: string[]}');
    await verifyPrepared(cloneDir, files, contentHash);
    await git(cloneDir, ['add', '-A', '.']);
    await git(cloneDir, [...IDENTITY, 'commit', '--no-gpg-sign', '--allow-empty', '-q', '-m', `candidate ${contentHash.slice(0, 12)}`]);
    const commit = (await git(cloneDir, ['rev-parse', 'HEAD'])).stdout.trim();
    const tree = (await git(cloneDir, ['rev-parse', 'HEAD^{tree}'])).stdout.trim();
    // Staging may apply attributes/filters. Evidence must describe the committed
    // bytes as well as the worktree the validator observed.
    for (const [name, expected] of Object.entries(files)) {
      const actual = (await git(cloneDir, ['show', `${commit}:${name}`])).stdout;
      req(actual === expected, 'candidate_mutated', `committed bytes differ for ${name}`);
    }
    const bundlePath = path.join(tmpRoot, 'candidate.bundle');
    await git(cloneDir, ['bundle', 'create', bundlePath, 'HEAD']);
    const bundle = new Uint8Array(await readFile(bundlePath));
    return { commit, tree, contentHash, passed: result.passed, checks: [...result.checks], bundle };
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
}
