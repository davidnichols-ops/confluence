import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DomainError } from './core.js';

export const CHECKPOINT_SCHEMA_VERSION = 1;
const KILL_GRACE_MS = 2000;
const DEFAULT_PREVIEW_BYTES = 4096;

export type ProviderRunStatus = 'completed' | 'failed' | 'timeout' | 'interrupted';

export interface EvidenceDigest {
  sha256: string;
  bytes: number;
  storedBytes: number;
  truncated: boolean;
  preview: string;
}

export interface ProviderRunResult {
  jobId: string;
  checkpointId: string;
  status: ProviderRunStatus;
  exitCode: number | null;
  signal: string | null;
  startedAt: string;
  endedAt: string;
  startedAtMs: number;
  endedAtMs: number;
  durationMs: number;
  stdout: EvidenceDigest;
  stderr: EvidenceDigest;
  killedBy: 'timeout' | 'abort' | null;
  unavailable: boolean;
  error: string | null;
}

export interface ProviderCheckpoint {
  schemaVersion: number;
  checkpointId: string;
  jobId: string;
  provider: string;
  argv: string[];
  cwd: string;
  taskPrompt: string;
  status: ProviderRunStatus | 'running';
  attempt: number;
  pid: number;
  startedAt: string;
  updatedAt: string;
  endedAt: string | null;
  killedBy: 'timeout' | 'abort' | null;
  resumeOf: string | null;
  partial: { stdout: EvidenceDigest; stderr: EvidenceDigest } | null;
  result: ProviderRunResult | null;
}

export interface ProviderRunOptions {
  jobId: string;
  provider: string;
  argv: string[];
  cwd: string;
  cwdAllowlist: string[];
  timeoutMs: number;
  maxOutputBytes: number;
  checkpointPath: string;
  taskPrompt?: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
  attempt?: number;
  resumeOf?: string | null;
}

function fail(code: string, message: string): never {
  throw new DomainError(code, message);
}

function req(cond: unknown, code: string, message: string): void {
  if (!cond) fail(code, message);
}

function isoNow(): string {
  return new Date().toISOString();
}

export function resolveAllowlist(allowlist: string[]): string[] {
  req(Array.isArray(allowlist) && allowlist.length > 0, 'invalid_allowlist', 'cwdAllowlist must be a non-empty array of absolute directories');
  const resolved = allowlist.map((p) => {
    req(typeof p === 'string' && p.length > 0, 'invalid_allowlist', 'allowlist entries must be non-empty strings');
    return path.resolve(p);
  });
  return [...new Set(resolved)];
}

function requireAllowedCwd(cwd: string, allowlist: string[]): string {
  req(typeof cwd === 'string' && cwd.length > 0, 'invalid_cwd', 'cwd must be a non-empty string');
  const resolved = path.resolve(cwd);
  req(allowlist.includes(resolved), 'cwd_not_allowed', `cwd ${resolved} is not in the allowlist`);
  return resolved;
}

function digestOf(buffer: Buffer, storedLimit: number): EvidenceDigest {
  const stored = buffer.subarray(0, storedLimit);
  return {
    sha256: createHash('sha256').update(buffer).digest('hex'),
    bytes: buffer.length,
    storedBytes: stored.length,
    truncated: buffer.length > storedLimit,
    preview: stored.toString('utf8'),
  };
}

const checkpointWriteChains = new Map<string, Promise<void>>();

async function writeCheckpointAtomic(checkpointPath: string, checkpoint: ProviderCheckpoint): Promise<void> {
  const dir = path.dirname(checkpointPath);
  await mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(checkpointPath)}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`);
  await writeFile(tmp, JSON.stringify(checkpoint, null, 2));
  await rename(tmp, checkpointPath);
}

function writeCheckpoint(checkpointPath: string, checkpoint: ProviderCheckpoint): Promise<void> {
  const chained = (checkpointWriteChains.get(checkpointPath) ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => writeCheckpointAtomic(checkpointPath, checkpoint));
  checkpointWriteChains.set(checkpointPath, chained);
  return chained;
}

const activeControllers = new Set<AbortController>();
let signalHandlersInstalled = false;

function forwardSignal(controllers: Set<AbortController>, signal: NodeJS.Signals): void {
  for (const c of controllers) c.abort(new Error(`process received ${signal}`));
  // Checkpoints flush once the terminated children close; then die like the
  // signal demanded instead of silently swallowing it.
  setTimeout(() => process.kill(process.pid, signal), 1000);
}

function installSignalBridge(): void {
  if (signalHandlersInstalled) return;
  const forward = (sig: NodeJS.Signals) => forwardSignal(activeControllers, sig);
  process.on('SIGINT', forward);
  process.on('SIGTERM', forward);
  signalHandlersInstalled = true;
}

interface StreamCapture {
  full: Buffer[];
  stored: Buffer[];
  storedBytes: number;
  limit: number;
}

function newCapture(limit: number): StreamCapture {
  return { full: [], stored: [], storedBytes: 0, limit };
}

function capturePush(c: StreamCapture, chunk: Buffer): void {
  c.full.push(chunk);
  if (c.storedBytes < c.limit) {
    const take = chunk.subarray(0, c.limit - c.storedBytes);
    c.stored.push(take);
    c.storedBytes += take.length;
  }
}

function captureBuffer(c: StreamCapture): Buffer {
  return Buffer.concat(c.full);
}

export function validateArgv(argv: string[]): void {
  req(Array.isArray(argv) && argv.length > 0, 'invalid_argv', 'argv must be a non-empty array');
  for (const part of argv) req(typeof part === 'string', 'invalid_argv', 'argv entries must be strings');
  req((argv[0] ?? '').length > 0, 'invalid_argv', 'argv[0] must name the executable');
}

export async function runProvider(options: ProviderRunOptions): Promise<ProviderRunResult> {
  req(typeof options === 'object' && options !== null, 'invalid_input', 'options required');
  validateArgv(options.argv);
  req(typeof options.provider === 'string' && options.provider.length > 0, 'invalid_provider', 'provider label required');
  req(Number.isInteger(options.timeoutMs) && options.timeoutMs > 0, 'invalid_limits', 'timeoutMs must be a positive integer');
  req(Number.isInteger(options.maxOutputBytes) && options.maxOutputBytes > 0, 'invalid_limits', 'maxOutputBytes must be a positive integer');
  req(typeof options.checkpointPath === 'string' && options.checkpointPath.length > 0, 'invalid_checkpoint_path', 'checkpointPath required');
  const allowlist = resolveAllowlist(options.cwdAllowlist);
  const cwd = requireAllowedCwd(options.cwd, allowlist);

  const jobId = options.jobId;
  req(typeof jobId === 'string' && jobId.length > 0, 'invalid_job', 'jobId required');
  const attempt = options.attempt ?? 1;
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const checkpointId = `${jobId}-${startedAtMs}`;
  const previewLimit = Math.min(DEFAULT_PREVIEW_BYTES, options.maxOutputBytes);

  const stdoutCapture = newCapture(previewLimit);
  const stderrCapture = newCapture(previewLimit);

  const internal = new AbortController();
  const onExternalAbort = () => internal.abort(new Error('external abort signal'));
  options.signal?.addEventListener('abort', onExternalAbort, { once: true });
  installSignalBridge();
  activeControllers.add(internal);

  const child: ReturnType<typeof spawn> = spawn(options.argv[0], options.argv.slice(1), {
    cwd,
    env: { ...process.env, ...options.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let settled = false;
  let killedBy: 'timeout' | 'abort' | null = null;
  let spawnError: NodeJS.ErrnoException | null = null;
  let exitCode: number | null = null;
  let signalTerminated: string | null = null;

  const killChild = (why: 'timeout' | 'abort') => {
    if (killedBy || exitCode !== null || signalTerminated !== null) return;
    killedBy = why;
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      const grace = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, KILL_GRACE_MS);
      grace.unref?.();
    }
  };

  // All child listeners attach synchronously: the first checkpoint await below
  // yields the event loop, and 'error'/'close' can fire during it.
  child.stdout?.on('data', (d: Buffer) => capturePush(stdoutCapture, d));
  child.stderr?.on('data', (d: Buffer) => capturePush(stderrCapture, d));
  const closed = new Promise<void>((resolve) => {
    child.on('close', (code, sig) => {
      exitCode = code;
      signalTerminated = sig;
      resolve();
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      spawnError = err;
      // A failed spawn never opens streams and never emits 'close'.
      if (!child.pid) resolve();
    });
  });

  const checkpoint = (): ProviderCheckpoint => ({
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    checkpointId,
    jobId,
    provider: options.provider,
    argv: [...options.argv],
    cwd,
    taskPrompt: options.taskPrompt ?? '',
    status: settled ? 'completed' : 'running',
    attempt,
    pid: child.pid ?? process.pid,
    startedAt,
    updatedAt: isoNow(),
    endedAt: null,
    killedBy,
    resumeOf: options.resumeOf ?? null,
    partial: null,
    result: null,
  });

  const timeoutTimer = setTimeout(() => killChild('timeout'), options.timeoutMs);
  timeoutTimer.unref?.();
  const onAbort = () => killChild('abort');
  internal.signal.addEventListener('abort', onAbort, { once: true });

  await writeCheckpoint(options.checkpointPath, checkpoint());

  await closed;
  clearTimeout(timeoutTimer);
  activeControllers.delete(internal);
  options.signal?.removeEventListener('abort', onExternalAbort);
  internal.signal.removeEventListener('abort', onAbort);
  settled = true;

  const endedAtMs = Date.now();
  const endedAt = new Date(endedAtMs).toISOString();
  const stdoutDigest = digestOf(captureBuffer(stdoutCapture), previewLimit);
  const stderrDigest = digestOf(captureBuffer(stderrCapture), previewLimit);

  let status: ProviderRunStatus;
  let error: string | null = null;
  let unavailable = false;
  const spawnErr = spawnError as NodeJS.ErrnoException | null;
  if (spawnErr) {
    status = 'failed';
    unavailable = spawnErr.code === 'ENOENT' || spawnErr.code === 'EACCES';
    error = `could not start ${options.argv[0]}: ${spawnErr.message}`;
  } else if (killedBy === 'timeout') {
    status = 'timeout';
    error = `exceeded timeout of ${options.timeoutMs}ms`;
  } else if (killedBy === 'abort') {
    status = 'interrupted';
    error = internal.signal.reason instanceof Error ? internal.signal.reason.message : 'aborted';
  } else if (exitCode === 0) {
    status = 'completed';
  } else {
    status = 'failed';
    error = `exited with code ${exitCode} signal ${signalTerminated}`;
  }

  const result: ProviderRunResult = {
    jobId,
    checkpointId,
    status,
    exitCode,
    signal: signalTerminated,
    startedAt,
    endedAt,
    startedAtMs,
    endedAtMs,
    durationMs: endedAtMs - startedAtMs,
    stdout: stdoutDigest,
    stderr: stderrDigest,
    killedBy,
    unavailable,
    error,
  };

  const finalCheckpoint = checkpoint();
  finalCheckpoint.status = status;
  finalCheckpoint.updatedAt = endedAt;
  finalCheckpoint.endedAt = endedAt;
  finalCheckpoint.killedBy = killedBy;
  finalCheckpoint.partial = killedBy ? { stdout: stdoutDigest, stderr: stderrDigest } : null;
  finalCheckpoint.result = result;
  await writeCheckpoint(options.checkpointPath, finalCheckpoint);

  return result;
}

const RESUMABLE: ReadonlySet<string> = new Set(['interrupted', 'timeout', 'failed']);

export async function loadCheckpoint(checkpointPath: string): Promise<ProviderCheckpoint> {
  let raw: string;
  try {
    raw = await readFile(checkpointPath, 'utf8');
  } catch {
    fail('invalid_checkpoint', `checkpoint not readable: ${checkpointPath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail('invalid_checkpoint', 'checkpoint is not valid JSON');
  }
  const cp = parsed as ProviderCheckpoint;
  req(typeof cp === 'object' && cp !== null, 'invalid_checkpoint', 'checkpoint must be an object');
  req(cp.schemaVersion === CHECKPOINT_SCHEMA_VERSION, 'invalid_checkpoint', `checkpoint schemaVersion must be ${CHECKPOINT_SCHEMA_VERSION}`);
  for (const field of ['checkpointId', 'jobId', 'provider', 'cwd', 'status', 'startedAt'] as const) {
    req(typeof cp[field] === 'string' && (cp[field] as string).length > 0, 'invalid_checkpoint', `checkpoint.${field} must be a non-empty string`);
  }
  validateArgv(cp.argv);
  return cp;
}

export interface ResumeOptions extends Omit<ProviderRunOptions, 'argv' | 'jobId' | 'provider' | 'attempt' | 'resumeOf' | 'cwd'> {
  checkpointPath: string;
  buildResumeArgv?: (checkpoint: ProviderCheckpoint) => string[];
}

export async function resumeProvider(options: ResumeOptions): Promise<ProviderRunResult> {
  const previous = await loadCheckpoint(options.checkpointPath);
  req(RESUMABLE.has(previous.status), 'not_resumable', `checkpoint status ${previous.status} is not resumable`);
  const cwd = requireAllowedCwd(previous.cwd, resolveAllowlist(options.cwdAllowlist));
  req(cwd === path.resolve(previous.cwd), 'cwd_not_allowed', 'checkpoint cwd does not match allowlist entry');
  const argv = options.buildResumeArgv ? options.buildResumeArgv(previous) : previous.argv;
  validateArgv(argv);
  return runProvider({
    ...options,
    argv,
    jobId: `${previous.jobId}-attempt${previous.attempt + 1}`,
    provider: previous.provider,
    cwd: previous.cwd,
    taskPrompt: options.taskPrompt ?? previous.taskPrompt,
    attempt: previous.attempt + 1,
    resumeOf: previous.checkpointId,
  });
}

export interface BatchOptions { concurrency: number }

export async function runProviderBatch(jobs: ProviderRunOptions[], batch: BatchOptions): Promise<ProviderRunResult[]> {
  req(Number.isInteger(batch.concurrency) && batch.concurrency >= 1, 'invalid_concurrency', 'concurrency must be a positive integer');
  const results: ProviderRunResult[] = new Array(jobs.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < jobs.length) {
      const index = next++;
      const job = jobs[index];
      try {
        results[index] = await runProvider(job);
      } catch (err) {
        results[index] = {
          jobId: job.jobId,
          checkpointId: `${job.jobId}-invalid`,
          status: 'failed',
          exitCode: null,
          signal: null,
          startedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
          startedAtMs: Date.now(),
          endedAtMs: Date.now(),
          durationMs: 0,
          stdout: { sha256: '', bytes: 0, storedBytes: 0, truncated: false, preview: '' },
          stderr: { sha256: '', bytes: 0, storedBytes: 0, truncated: false, preview: '' },
          killedBy: null,
          unavailable: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(batch.concurrency, jobs.length) }, () => worker()));
  return results;
}

export function intervalsOverlap(
  a: { startedAtMs: number; endedAtMs: number },
  b: { startedAtMs: number; endedAtMs: number },
): boolean {
  return a.startedAtMs < b.endedAtMs && b.startedAtMs < a.endedAtMs;
}
