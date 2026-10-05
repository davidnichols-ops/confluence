import { spawn } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DomainError, treeHash } from './core.js';
import type { Evidence, Files } from './contracts.js';
import type { PreparedCandidate, PublicationReceipt } from './git-publication.js';

export interface RemotePublishInput {
  remote: string;
  token: string;
  ref: string;
  expectedHead: string;
  candidate: PreparedCandidate;
  bundle: Uint8Array;
  evidence: Evidence;
  approval: { treeHash: string; human: string };
  timeoutMs?: number;
}

const ZERO_OID = '0'.repeat(40);
const OID = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const LOG_FILE = 'logs/remote-publication.jsonl';
const DEFAULT_TIMEOUT_MS = 30_000;
const HOOKS_OFF = ['-c', 'core.hooksPath=/dev/null'];
const CREDENTIALS_OFF = ['-c', 'credential.helper='];

function fail(code: string, message: string): never {
  throw new DomainError(code, message);
}

function req(cond: boolean, code: string, message: string): void {
  if (!cond) fail(code, message);
}

function short(v: string): string {
  return v.slice(0, 12);
}

interface GitResult { code: number; stdout: string; stderr: string; stdoutBytes: Buffer }

function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) if (s.length > 0) out = out.split(s).join('[redacted]');
  return out;
}

async function logGit(label: string, code: number, detail: string): Promise<void> {
  try {
    const file = path.resolve(LOG_FILE);
    await mkdir(path.dirname(file), { recursive: true });
    const entry = { ts: new Date().toISOString(), command: label, exit: code, ...(detail ? { detail } : {}) };
    await appendFile(file, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    return;
  }
}

interface RunOptions { secrets?: string[]; timeoutMs: number; label?: string }

function runGit(cwd: string, args: string[], opts: RunOptions): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      cwd,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: 'echo',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const secrets = opts.secrets ?? [];
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) child.kill('SIGKILL');
    }, opts.timeoutMs);
    const finish = (code: number, stderr: string, stdoutBytes: Buffer, stdout: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void logGit(opts.label ?? `git ${args.join(' ')}`, code, code === 0 ? '' : stderr.trim().slice(0, 200));
      resolve({ code, stdout, stderr, stdoutBytes });
    };
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => err.push(d));
    child.on('error', (e) => {
      finish(-1, redact(String(e), secrets), Buffer.alloc(0), '');
    });
    child.on('close', (code) => {
      const stdoutBytes = Buffer.concat(out);
      const stdout = redact(stdoutBytes.toString('utf8'), secrets);
      const stderr = redact(Buffer.concat(err).toString('utf8'), secrets);
      finish(code ?? -1, code === null ? 'git command timed out' : stderr || stdout, stdoutBytes, stdout);
    });
  });
}

async function expectGit(cwd: string, args: string[], code: string, message: string, opts: RunOptions): Promise<string> {
  const r = await runGit(cwd, args, opts);
  req(r.code === 0, code, `${message}: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}

// The token travels only as an http.extraHeader value; the log label never
// contains the real header so tokens cannot reach logs through command lines.
function remoteCommand(token: string, rest: string[]): { args: string[]; label: string } {
  return {
    args: [...HOOKS_OFF, '-c', `http.extraHeader=Authorization: Bearer ${token}`, ...CREDENTIALS_OFF, ...rest],
    label: `git ${[...HOOKS_OFF, '-c', 'http.extraHeader=Authorization: Bearer [redacted]', ...CREDENTIALS_OFF, ...rest].join(' ')}`,
  };
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

async function safeRemote(raw: unknown): Promise<string> {
  req(typeof raw === 'string' && raw.length > 0, 'invalid_remote', 'remote must be a non-empty string');
  const remote = raw as string;
  req(!remote.includes('@'), 'invalid_remote', 'remote must not embed credentials; pass the token separately');
  if (/^https:\/\//i.test(remote)) return remote;
  req(!/^[a-z][a-z0-9+.-]*:\/\//i.test(remote), 'invalid_remote', `unsupported remote transport, use https or a local path: ${remote}`);
  const dir = path.resolve(remote);
  const info = await stat(dir).catch(() => null);
  req(info !== null && info.isDirectory(), 'invalid_remote', `remote is not an https URL or an existing local directory: ${dir}`);
  return dir;
}

function safeToken(raw: unknown): string {
  req(typeof raw === 'string' && raw.length > 0, 'invalid_token', 'token must be a non-empty string');
  const token = raw as string;
  req(token === token.trim(), 'invalid_token', 'token must not have surrounding whitespace');
  req(!/[\r\n\0]/.test(token), 'invalid_token', 'token must not contain control characters');
  return token;
}

function boundedTimeout(raw: unknown): number {
  if (raw === undefined) return DEFAULT_TIMEOUT_MS;
  req(typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 && raw <= 120_000, 'invalid_timeout', 'timeoutMs must be an integer between 1 and 120000');
  return raw as number;
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

function advertisedHead(stdout: string, ref: string): string {
  for (const line of stdout.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab <= 0) continue;
    if (line.slice(tab + 1).trim() === ref) return line.slice(0, tab).trim().toLowerCase();
  }
  return '';
}

function pushFailureCode(r: GitResult): string {
  return /stale info|is at \w+ but expected/.test(`${r.stderr}\n${r.stdout}`) ? 'stale_head' : 'git_failed';
}

async function readTree(work: string, commit: string, timeoutMs: number): Promise<Files> {
  const ls = await expectGit(work, ['ls-tree', '-r', '-z', commit], 'git_failed', 'could not list candidate tree', { timeoutMs });
  const files: Files = Object.create(null);
  for (const entry of ls.split('\0').filter(Boolean)) {
    const tab = entry.indexOf('\t');
    req(tab > 0, 'unsafe_tree', 'malformed ls-tree entry');
    const [mode, type, sha] = entry.slice(0, tab).split(/\s+/);
    const p = entry.slice(tab + 1);
    req(mode === '100644', 'unsafe_tree', `unsupported mode ${mode} for ${p}; this prototype publishes non-executable text files`);
    req(type === 'blob', 'unsafe_tree', `unsupported entry type ${type} for ${p}`);
    const blob = await runGit(work, ['cat-file', 'blob', sha], { timeoutMs });
    req(blob.code === 0, 'git_failed', `could not read blob for ${p}`);
    req(Buffer.from(blob.stdout, 'utf8').equals(blob.stdoutBytes), 'unsafe_tree', `non-UTF-8 blob for ${p}; cannot bind lossy text to exact bytes`);
    files[p] = blob.stdout;
  }
  return files;
}

// Idempotent retry path: the remote already advertises the candidate commit, so
// the actual remote bytes are fetched and re-verified before any receipt.
async function verifyRemoteCandidate(
  work: string,
  remote: string,
  ref: string,
  token: string,
  candidate: { commit: string; tree: string; contentHash: string },
  timeoutMs: number,
  secrets: string[],
): Promise<void> {
  const fetchCmd = remoteCommand(token, ['fetch', '--no-tags', remote, `+${ref}:refs/confluence-verify`]);
  const fetched = await runGit(work, fetchCmd.args, { timeoutMs, secrets, label: fetchCmd.label });
  req(fetched.code === 0, 'git_failed', `could not fetch remote ${ref} for idempotent verification: ${(fetched.stderr || fetched.stdout).trim()}`);
  const remoteCommit = (await runGit(work, ['rev-parse', '--verify', 'refs/confluence-verify'], { timeoutMs })).stdout.trim().toLowerCase();
  req(remoteCommit === candidate.commit, 'commit_mismatch', `remote ${ref} is at ${short(remoteCommit || 'unknown')}, not the candidate commit ${short(candidate.commit)}`);
  const remoteTree = (await runGit(work, ['rev-parse', '--verify', `${remoteCommit}^{tree}`], { timeoutMs })).stdout.trim().toLowerCase();
  req(remoteTree === candidate.tree, 'tree_mismatch', `remote tree ${short(remoteTree)} does not match candidate.tree ${short(candidate.tree)}`);
  const files = await readTree(work, remoteCommit, timeoutMs);
  req((await treeHash(files)) === candidate.contentHash, 'content_mismatch', 'fetched remote tree content does not match candidate contentHash');
}

export async function publishRemoteCandidate(input: unknown): Promise<PublicationReceipt> {
  req(typeof input === 'object' && input !== null, 'invalid_input', 'input required');
  const i = input as RemotePublishInput;
  const remote = await safeRemote(i.remote);
  const token = safeToken(i.token);
  const ref = safeRef(i.ref);
  const expectedHead = oid(i.expectedHead, 'invalid_head', 'expectedHead');
  req(typeof i.candidate === 'object' && i.candidate !== null, 'invalid_candidate', 'candidate required');
  const commit = oid((i.candidate as PreparedCandidate).commit, 'invalid_candidate', 'candidate.commit');
  const tree = oid((i.candidate as PreparedCandidate).tree, 'invalid_candidate', 'candidate.tree');
  const contentHash = sha256((i.candidate as PreparedCandidate).contentHash, 'invalid_candidate', 'candidate.contentHash');
  req(i.bundle instanceof Uint8Array && i.bundle.byteLength > 0, 'invalid_bundle', 'bundle must be non-empty bytes');
  requireApproval(i.evidence, i.approval, contentHash);
  const timeoutMs = boundedTimeout(i.timeoutMs);
  const secrets = [token, token.split('?')[0]].filter((s, idx, arr) => s.length > 0 && arr.indexOf(s) === idx);

  const tmp = await mkdtemp(path.join(tmpdir(), 'confluence-remote-publish-'));
  try {
    const work = path.join(tmp, 'verify');
    const local = { timeoutMs };
    await expectGit(tmp, ['init', '-q', '--bare', work], 'git_failed', 'could not create isolated verification repository', local);
    const bundlePath = path.join(tmp, 'candidate.bundle');
    await writeFile(bundlePath, Buffer.from(i.bundle), { mode: 0o600 });
    await expectGit(work, ['bundle', 'verify', '--quiet', bundlePath], 'invalid_bundle', 'bundle failed verification', local);
    const heads = await expectGit(work, ['bundle', 'list-heads', bundlePath], 'invalid_bundle', 'bundle could not be read', local);
    const listed = heads.split('\n').map((l) => l.trim().split(/\s+/)[0] ?? '').filter(Boolean).map((s) => s.toLowerCase());
    req(listed.length > 0 && listed.every((s) => s === commit), 'bundle_mismatch', 'bundle does not exclusively contain the candidate commit');
    await expectGit(work, ['bundle', 'unbundle', bundlePath], 'invalid_bundle', 'bundle failed to unbundle', local);

    const commitOut = await runGit(work, ['rev-parse', '--verify', '--quiet', `${commit}^{commit}`], local);
    req(commitOut.code === 0 && commitOut.stdout.trim().toLowerCase() === commit, 'commit_mismatch', `bundle does not provide candidate commit ${short(commit)}`);
    const treeOut = await runGit(work, ['rev-parse', '--verify', '--quiet', `${commit}^{tree}`], local);
    req(treeOut.code === 0 && treeOut.stdout.trim().toLowerCase() === tree, 'tree_mismatch', `actual tree of candidate commit does not match candidate.tree ${short(tree)}`);
    const parentOut = await expectGit(work, ['rev-list', '--parents', '-n', '1', commit], 'git_failed', 'could not inspect candidate commit parents', local);
    const parents = parentOut.trim().split(/\s+/).slice(1);
    if (expectedHead === ZERO_OID) req(parents.length === 0, 'wrong_parent', 'expectedHead is the zero id but candidate commit has parents');
    else req(parents.length === 1 && parents[0] === expectedHead, 'wrong_parent', `candidate commit parent ${short(parents[0] ?? 'none')} does not match expectedHead ${short(expectedHead)}`);

    const files = await readTree(work, commit, timeoutMs);
    req((await treeHash(files)) === contentHash, 'content_mismatch', 'committed tree content does not match candidate contentHash');
    await expectGit(work, ['update-ref', 'refs/confluence/candidate', commit], 'git_failed', 'could not stage candidate for push', local);

    const lsRemoteCmd = remoteCommand(token, ['ls-remote', remote, ref]);
    const adv = await runGit(work, lsRemoteCmd.args, { timeoutMs, secrets, label: lsRemoteCmd.label });
    req(adv.code === 0, 'git_failed', `could not query remote ref ${ref}: ${(adv.stderr || adv.stdout).trim()}`);
    const current = advertisedHead(adv.stdout, ref);

    if (current === commit) {
      await verifyRemoteCandidate(work, remote, ref, token, { commit, tree, contentHash }, timeoutMs, secrets);
      return { ref, head: commit, previousHead: expectedHead, commit, tree, contentHash, idempotent: true };
    }
    if (current === '') req(expectedHead === ZERO_OID, 'stale_head', `remote ref ${ref} does not exist but expectedHead is not the zero id`);
    else req(current === expectedHead, 'stale_head', `remote ref ${ref} is at ${short(current)} but expectedHead is ${short(expectedHead)}`);

    const lease = `${ref}:${expectedHead === ZERO_OID ? '' : expectedHead}`;
    const pushCmd = remoteCommand(token, ['push', '--porcelain', `--force-with-lease=${lease}`, remote, `refs/confluence/candidate:${ref}`]);
    const pushed = await runGit(work, pushCmd.args, { timeoutMs, secrets, label: pushCmd.label });
    req(pushed.code === 0, pushFailureCode(pushed), `push of ${ref} failed: ${(pushed.stderr || pushed.stdout).trim()}`);

    const confirmCmd = remoteCommand(token, ['ls-remote', remote, ref]);
    const confirmed = await runGit(work, confirmCmd.args, { timeoutMs, secrets, label: confirmCmd.label });
    req(confirmed.code === 0 && advertisedHead(confirmed.stdout, ref) === commit, 'stale_head', `push of ${ref} did not leave the remote at the candidate commit; reconcile instead of retrying blindly`);
    return { ref, head: commit, previousHead: expectedHead, commit, tree, contentHash, idempotent: false };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
