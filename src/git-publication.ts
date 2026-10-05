import { spawn } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DomainError, treeHash } from './core.js';
import type { Evidence, Files } from './contracts.js';

export interface PreparedCandidate {
  commit: string;
  tree: string;
  contentHash: string;
}

export interface PublishGitCandidateInput {
  repository: string;
  ref: string;
  expectedHead: string;
  candidate: PreparedCandidate;
  bundle: Uint8Array;
  evidence: Evidence;
  approval: { treeHash: string; human: string };
}

export interface PublicationReceipt {
  ref: string;
  head: string;
  previousHead: string;
  commit: string;
  tree: string;
  contentHash: string;
  idempotent: boolean;
}

const ZERO_OID = '0'.repeat(40);
const OID = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const LOG_FILE = 'logs/git-publication.jsonl';

function fail(code: string, message: string): never {
  throw new DomainError(code, message);
}

function req(cond: boolean, code: string, message: string): void {
  if (!cond) fail(code, message);
}

interface GitResult { code: number; stdout: string; stderr: string; stdoutBytes: Buffer }

async function logGit(args: string[], code: number, detail: string): Promise<void> {
  try {
    const file = path.resolve(LOG_FILE);
    await mkdir(path.dirname(file), { recursive: true });
    const entry = { ts: new Date().toISOString(), command: `git ${args.join(' ')}`, exit: code, ...(detail ? { detail } : {}) };
    await appendFile(file, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    return;
  }
}

function runGit(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawn('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
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
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => err.push(d));
    child.on('error', (e) => {
      const detail = String(e);
      void logGit(args, -1, detail);
      resolve({ code: -1, stdout: '', stderr: detail, stdoutBytes: Buffer.alloc(0) });
    });
    child.on('close', (code) => {
      const stdout = Buffer.concat(out).toString('utf8');
      const stderr = Buffer.concat(err).toString('utf8');
      void logGit(args, code ?? -1, code === 0 ? '' : (stderr || stdout).trim().slice(0, 200));
      resolve({ code: code ?? -1, stdout, stderr, stdoutBytes: Buffer.concat(out) });
    });
  });
}

async function expectGit(cwd: string, args: string[], code: string, message: string): Promise<string> {
  const r = await runGit(cwd, args);
  req(r.code === 0, code, `${message}: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}

function oid(v: unknown, code: string, label: string): string {
  req(typeof v === 'string' && OID.test(v.trim().toLowerCase()), code, `${label} must be a 40-character hex object id`);
  return (v as string).trim().toLowerCase();
}

function sha256(v: unknown, code: string, label: string): string {
  req(typeof v === 'string' && SHA256.test(v.trim().toLowerCase()), code, `${label} must be a 64-character hex sha-256 digest`);
  return (v as string).trim().toLowerCase();
}

function safeRef(raw: unknown): string {
  req(typeof raw === 'string' && raw.length > 0, 'invalid_ref', 'ref must be a non-empty string');
  const ref = raw as string;
  req(ref === ref.trim(), 'invalid_ref', `ref must not have surrounding whitespace: ${raw}`);
  req(ref.startsWith('refs/heads/'), 'invalid_ref', `ref must be a branch under refs/heads/: ${raw}`);
  const branch = ref.slice('refs/heads/'.length);
  req(!branch.startsWith('.'), 'invalid_ref', `branch must not start with '.': ${raw}`);
  for (const seg of branch.split('/')) {
    req(seg.length > 0, 'invalid_ref', `empty ref segment in ${raw}`);
    req(seg !== '.' && seg !== '..', 'invalid_ref', `ref segment must not be '.' or '..': ${raw}`);
    req(!seg.endsWith('.lock'), 'invalid_ref', `ref segment must not end with '.lock': ${raw}`);
    req(!seg.endsWith('.'), 'invalid_ref', `ref segment must not end with '.': ${raw}`);
    req(!seg.includes('@{'), 'invalid_ref', `ref must not contain '@{': ${raw}`);
    req(!/[\u0000-\u0020\u007f~^:?*\[\\]/.test(seg), 'invalid_ref', `ref must not contain control, space or git-special characters: ${raw}`);
  }
  return ref;
}

async function requireBareRepo(repository: unknown): Promise<string> {
  req(typeof repository === 'string' && repository.length > 0 && !repository.includes('://'), 'invalid_repository', 'repository must be an existing local bare git repository path');
  const repoDir = path.resolve(repository as string);
  const info = await stat(repoDir).catch(() => null);
  req(info !== null && info.isDirectory(), 'invalid_repository', `repository does not exist or is not a directory: ${repoDir}`);
  const r = await runGit(repoDir, ['rev-parse', '--is-bare-repository']);
  req(r.code === 0 && r.stdout.trim() === 'true', 'invalid_repository', `not an existing local bare git repository: ${repoDir}`);
  return repoDir;
}

function requireApproval(evidence: unknown, approval: unknown, contentHash: string): void {
  req(typeof evidence === 'object' && evidence !== null, 'invalid_evidence', 'evidence required');
  const ev = evidence as Record<string, unknown>;
  req(ev.passed === true, 'evidence_failed', 'evidence has not passed; refusing to publish');
  req(typeof ev.treeHash === 'string' && ev.treeHash.trim().toLowerCase() === contentHash, 'evidence_mismatch', 'evidence.treeHash does not match candidate contentHash');
  req(Array.isArray(ev.checks) && ev.checks.every((c) => typeof c === 'string'), 'invalid_evidence', 'evidence.checks must be an array of strings');
  req(typeof ev.runner === 'string' && ev.runner.length > 0, 'invalid_evidence', 'evidence.runner must be a non-empty string');
  req(typeof approval === 'object' && approval !== null, 'approval_missing', 'human approval required');
  const ap = approval as Record<string, unknown>;
  req(typeof ap.human === 'string' && ap.human.length > 0, 'approval_missing', 'approval.human must be a non-empty string');
  req(typeof ap.treeHash === 'string' && ap.treeHash.trim().toLowerCase() === contentHash, 'approval_mismatch', 'approval.treeHash does not match candidate contentHash');
}

export async function publishGitCandidate(input: unknown): Promise<PublicationReceipt> {
  req(typeof input === 'object' && input !== null, 'invalid_input', 'input required');
  const i = input as PublishGitCandidateInput;
  const repoDir = await requireBareRepo(i.repository);
  const ref = safeRef(i.ref);
  const expectedHead = oid(i.expectedHead, 'invalid_head', 'expectedHead');
  req(typeof i.candidate === 'object' && i.candidate !== null, 'invalid_candidate', 'candidate required');
  const commit = oid((i.candidate as PreparedCandidate).commit, 'invalid_candidate', 'candidate.commit');
  const tree = oid((i.candidate as PreparedCandidate).tree, 'invalid_candidate', 'candidate.tree');
  const contentHash = sha256((i.candidate as PreparedCandidate).contentHash, 'invalid_candidate', 'candidate.contentHash');
  req(i.bundle instanceof Uint8Array && i.bundle.byteLength > 0, 'invalid_bundle', 'bundle must be non-empty bytes');
  requireApproval(i.evidence, i.approval, contentHash);

  const tmp = await mkdtemp(path.join(tmpdir(), 'confluence-publish-'));
  try {
    const bundlePath = path.join(tmp, 'candidate.bundle');
    await writeFile(bundlePath, Buffer.from(i.bundle), { mode: 0o600 });
    await expectGit(repoDir, ['bundle', 'verify', '--quiet', bundlePath], 'invalid_bundle', 'bundle failed verification');
    const heads = await expectGit(repoDir, ['bundle', 'list-heads', bundlePath], 'invalid_bundle', 'bundle could not be read');
    const listed = heads.split('\n').map((l) => l.trim().split(/\s+/)[0] ?? '').filter(Boolean).map((s) => s.toLowerCase());
    req(listed.length > 0 && listed.every((s) => s === commit), 'bundle_mismatch', 'bundle does not exclusively contain the candidate commit');
    await expectGit(repoDir, ['bundle', 'unbundle', bundlePath], 'invalid_bundle', 'bundle failed to unbundle');

    const commitOut = await runGit(repoDir, ['rev-parse', '--verify', '--quiet', `${commit}^{commit}`]);
    req(commitOut.code === 0 && commitOut.stdout.trim().toLowerCase() === commit, 'commit_mismatch', `bundle does not provide candidate commit ${commit.slice(0, 12)}`);
    const treeOut = await runGit(repoDir, ['rev-parse', '--verify', '--quiet', `${commit}^{tree}`]);
    req(treeOut.code === 0 && treeOut.stdout.trim().toLowerCase() === tree, 'tree_mismatch', `actual tree of candidate commit does not match candidate.tree ${tree.slice(0, 12)}`);
    const parentOut = await expectGit(repoDir, ['rev-list', '--parents', '-n', '1', commit], 'git_failed', 'could not inspect candidate commit parents');
    const parents = parentOut.trim().split(/\s+/).slice(1);
    if (expectedHead === ZERO_OID) req(parents.length === 0, 'wrong_parent', 'expectedHead is the zero id but candidate commit has parents');
    else req(parents.length === 1 && parents[0] === expectedHead, 'wrong_parent', `candidate commit parent ${(parents[0] ?? 'none').slice(0, 12)} does not match expectedHead ${expectedHead.slice(0, 12)}`);

    const ls = await expectGit(repoDir, ['ls-tree', '-r', '-z', commit], 'git_failed', 'could not list candidate tree');
    const files: Files = Object.create(null);
    for (const entry of ls.split('\0').filter(Boolean)) {
      const tab = entry.indexOf('\t');
      req(tab > 0, 'unsafe_tree', 'malformed ls-tree entry');
      const [mode, type, sha] = entry.slice(0, tab).split(/\s+/);
      const p = entry.slice(tab + 1);
      req(mode === '100644', 'unsafe_tree', `unsupported mode ${mode} for ${p}; this prototype publishes non-executable text files`);
      req(type === 'blob', 'unsafe_tree', `unsupported entry type ${type} for ${p}`);
      const blob = await runGit(repoDir, ['cat-file', 'blob', sha]);
      req(blob.code === 0, 'git_failed', `could not read blob for ${p}`);
      req(Buffer.from(blob.stdout, 'utf8').equals(blob.stdoutBytes), 'unsafe_tree', `non-UTF-8 blob for ${p}; cannot bind lossy text to exact bytes`);
      files[p] = blob.stdout;
    }
    req((await treeHash(files)) === contentHash, 'content_mismatch', 'committed tree content does not match candidate contentHash');

    const cur = await runGit(repoDir, ['rev-parse', '--verify', '--quiet', ref]);
    const current = cur.code === 0 ? cur.stdout.trim().toLowerCase() : '';
    if (current === commit) {
      return { ref, head: commit, previousHead: current, commit, tree, contentHash, idempotent: true };
    }
    if (current !== '') req(current === expectedHead, 'stale_head', `ref ${ref} is at ${current.slice(0, 12)} but expectedHead is ${expectedHead.slice(0, 12)}`);
    else req(expectedHead === ZERO_OID, 'stale_head', `ref ${ref} does not exist and expectedHead is not the zero id`);
    const upd = await runGit(repoDir, ['update-ref', ref, commit, expectedHead]);
    req(upd.code === 0, 'stale_head', `compare-and-swap update of ${ref} failed: ${(upd.stderr || upd.stdout).trim()}`);
    return { ref, head: commit, previousHead: expectedHead, commit, tree, contentHash, idempotent: false };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
