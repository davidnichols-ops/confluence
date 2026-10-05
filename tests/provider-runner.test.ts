import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  CHECKPOINT_SCHEMA_VERSION,
  intervalsOverlap,
  loadCheckpoint,
  resolveAllowlist,
  resumeProvider,
  runProvider,
  runProviderBatch,
} from '../src/provider-runner.js';
import { DomainError } from '../src/core.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

async function makeSandbox(): Promise<{ dir: string; checkpointPath: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'provider-runner-test-'));
  roots.push(dir);
  return { dir, checkpointPath: path.join(dir, 'checkpoint.json') };
}

function nodeProc(code: string): string[] {
  return [process.execPath, '-e', code];
}

function domainCode(fn: () => Promise<unknown>): Promise<string> {
  return fn().then(
    () => Promise.reject(new Error('expected DomainError')),
    (err) => {
      expect(err).toBeInstanceOf(DomainError);
      return (err as DomainError).code;
    },
  );
}

describe('runProvider', () => {
  it('passes argv to the child verbatim without a shell', async () => {
    const { dir, checkpointPath } = await makeSandbox();
    const result = await runProvider({
      jobId: 'argv-check', provider: 'node', argv: nodeProc('console.log(JSON.stringify(process.argv));'),
      cwd: dir, cwdAllowlist: [dir], timeoutMs: 10_000, maxOutputBytes: 65_536, checkpointPath,
    });
    expect(result.status).toBe('completed');
    const argv = JSON.parse(result.stdout.preview) as string[];
    expect(argv[0]).toBe(process.execPath);
    const spaced = await runProvider({
      jobId: 'argv-spaces', provider: 'node',
      argv: [...nodeProc('console.log(JSON.stringify(process.argv));'), 'one spaced arg', '$HOME `rm -rf /` ;'],
      cwd: dir, cwdAllowlist: [dir], timeoutMs: 10_000, maxOutputBytes: 65_536, checkpointPath,
    });
    const spacedArgv = JSON.parse(spaced.stdout.preview) as string[];
    expect(spacedArgv).toContain('one spaced arg');
    expect(spacedArgv).toContain('$HOME `rm -rf /` ;');
  });

  it('rejects cwd outside the allowlist and resolves allowlist entries', async () => {
    const { dir, checkpointPath } = await makeSandbox();
    expect(resolveAllowlist([dir])).toEqual([path.resolve(dir)]);
    await expect(domainCode(() => runProvider({
      jobId: 'cwd-check', provider: 'node', argv: nodeProc(''),
      cwd: path.join(dir, 'elsewhere'), cwdAllowlist: [dir],
      timeoutMs: 10_000, maxOutputBytes: 1024, checkpointPath,
    }))).resolves.toBe('cwd_not_allowed');
  });

  it('bounds runtime with timeout and records a killed child', async () => {
    const { dir, checkpointPath } = await makeSandbox();
    const result = await runProvider({
      jobId: 'timeout-check', provider: 'node', argv: nodeProc('setTimeout(() => {}, 30000); setInterval(()=>{},100);'),
      cwd: dir, cwdAllowlist: [dir], timeoutMs: 300, maxOutputBytes: 1024, checkpointPath,
    });
    expect(result.status).toBe('timeout');
    expect(result.killedBy).toBe('timeout');
    expect(result.durationMs).toBeLessThan(5000);
    const cp = JSON.parse(await readFile(checkpointPath, 'utf8'));
    expect(cp.status).toBe('timeout');
    expect(cp.partial.stdout.sha256).toBeTruthy();
    expect(cp.result.jobId).toBe('timeout-check');
  });

  it('interrupts on abort signal and keeps partial evidence in the checkpoint', async () => {
    const { dir, checkpointPath } = await makeSandbox();
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('intentional terminate')), 1500);
    const result = await runProvider({
      jobId: 'abort-check', provider: 'node',
      argv: nodeProc('setInterval(() => console.log("tick"), 50);'),
      cwd: dir, cwdAllowlist: [dir], timeoutMs: 30_000, maxOutputBytes: 65_536,
      checkpointPath, signal: controller.signal,
    });
    expect(result.status).toBe('interrupted');
    expect(result.killedBy).toBe('abort');
    expect(result.stdout.bytes).toBeGreaterThan(0);
    const cp = JSON.parse(await readFile(checkpointPath, 'utf8'));
    expect(cp.status).toBe('interrupted');
    expect(cp.partial).not.toBeNull();
    expect(cp.result.status).toBe('interrupted');
  });

  it('bounds captured output but digests the full stream', async () => {
    const { dir, checkpointPath } = await makeSandbox();
    const chunk = 'x'.repeat(100_000);
    const result = await runProvider({
      jobId: 'output-check', provider: 'node',
      argv: nodeProc(`process.stdout.write(${JSON.stringify(chunk)});`),
      cwd: dir, cwdAllowlist: [dir], timeoutMs: 10_000, maxOutputBytes: 1024, checkpointPath,
    });
    expect(result.status).toBe('completed');
    expect(result.stdout.bytes).toBe(100_000);
    expect(result.stdout.storedBytes).toBe(1024);
    expect(result.stdout.truncated).toBe(true);
    expect(result.stdout.sha256).toBe(createHash('sha256').update(chunk).digest('hex'));
  });

  it('records exact stream digests and monotonic timestamps', async () => {
    const { dir, checkpointPath } = await makeSandbox();
    const result = await runProvider({
      jobId: 'digest-check', provider: 'node',
      argv: nodeProc('process.stdout.write("hello evidence"); process.stderr.write("oops");'),
      cwd: dir, cwdAllowlist: [dir], timeoutMs: 10_000, maxOutputBytes: 65_536, checkpointPath,
    });
    expect(result.stdout.sha256).toBe(createHash('sha256').update('hello evidence').digest('hex'));
    expect(result.stderr.sha256).toBe(createHash('sha256').update('oops').digest('hex'));
    expect(result.startedAtMs).toBeLessThanOrEqual(result.endedAtMs);
    expect(Number.isNaN(Date.parse(result.startedAt))).toBe(false);
    expect(result.exitCode).toBe(0);
  });

  it('flags missing executables as unavailable instead of crashing', async () => {
    const { dir, checkpointPath } = await makeSandbox();
    const result = await runProvider({
      jobId: 'missing-check', provider: 'ghost',
      argv: ['definitely-not-a-real-provider-binary-xyz', '--version'],
      cwd: dir, cwdAllowlist: [dir], timeoutMs: 10_000, maxOutputBytes: 1024, checkpointPath,
    });
    expect(result.status).toBe('failed');
    expect(result.unavailable).toBe(true);
  });
});

describe('checkpoint resume contract', () => {
  it('resumes a failed run in the same checkpoint file with attempt and lineage', async () => {
    const { dir, checkpointPath } = await makeSandbox();
    const first = await runProvider({
      jobId: 'resume-check', provider: 'node', argv: nodeProc('process.exit(3);'),
      cwd: dir, cwdAllowlist: [dir], timeoutMs: 10_000, maxOutputBytes: 1024, checkpointPath,
      taskPrompt: 'tiny task',
    });
    expect(first.status).toBe('failed');
    const resumed = await resumeProvider({
      checkpointPath, cwdAllowlist: [dir], timeoutMs: 10_000, maxOutputBytes: 1024,
      buildResumeArgv: () => nodeProc('console.log("recovered");'),
    });
    expect(resumed.status).toBe('completed');
    expect(resumed.jobId).toBe('resume-check-attempt2');
    const cp = JSON.parse(await readFile(checkpointPath, 'utf8'));
    expect(cp.attempt).toBe(2);
    expect(cp.resumeOf).toBe(first.checkpointId);
    expect(cp.schemaVersion).toBe(CHECKPOINT_SCHEMA_VERSION);
  });

  it('rejects tampered, unreadable and non-resumable checkpoints', async () => {
    const { dir, checkpointPath } = await makeSandbox();
    await writeFile(checkpointPath, JSON.stringify({ schemaVersion: 99 }), 'utf8');
    await expect(domainCode(() => loadCheckpoint(checkpointPath))).resolves.toBe('invalid_checkpoint');
    await writeFile(checkpointPath, 'not json', 'utf8');
    await expect(domainCode(() => loadCheckpoint(checkpointPath))).resolves.toBe('invalid_checkpoint');
    await runProvider({
      jobId: 'done-check', provider: 'node', argv: nodeProc(''),
      cwd: dir, cwdAllowlist: [dir], timeoutMs: 10_000, maxOutputBytes: 1024, checkpointPath,
    });
    await expect(domainCode(() => resumeProvider({
      checkpointPath, cwdAllowlist: [dir], timeoutMs: 10_000, maxOutputBytes: 1024,
    }))).resolves.toBe('not_resumable');
  });
});

describe('runProviderBatch', () => {
  it('runs jobs with bounded concurrency and provable interval overlap', async () => {
    const { dir, checkpointPath } = await makeSandbox();
    const jobs = [0, 1, 2].map((i) => ({
      jobId: `batch-${i}`, provider: 'node',
      argv: nodeProc('setTimeout(() => {}, 400);'),
      cwd: dir, cwdAllowlist: [dir], timeoutMs: 10_000, maxOutputBytes: 1024,
      checkpointPath: `${checkpointPath}-${i}`,
    }));
    const results = await runProviderBatch(jobs, { concurrency: 2 });
    expect(results.every((r) => r.status === 'completed')).toBe(true);

    const maxConcurrent = (runs: { startedAtMs: number; endedAtMs: number }[]): number => {
      const events = runs.flatMap((r) => [
        { t: r.startedAtMs, d: 1 }, { t: r.endedAtMs, d: -1 },
      ]).sort((a, b) => a.t - b.t || a.d - b.d);
      let cur = 0; let max = 0;
      for (const e of events) { cur += e.d; max = Math.max(max, cur); }
      return max;
    };
    expect(maxConcurrent(results)).toBe(2);

    const serial = await runProviderBatch(jobs.map((j) => ({ ...j, jobId: `${j.jobId}-serial` })), { concurrency: 1 });
    expect(maxConcurrent(serial)).toBe(1);
    expect(intervalsOverlap(serial[0], serial[1])).toBe(false);
    expect(intervalsOverlap(results[0], results[1])).toBe(true);
  });

  it('captures per-job invalid input as failed results instead of rejecting', async () => {
    const { dir, checkpointPath } = await makeSandbox();
    const results = await runProviderBatch([
      {
        jobId: 'bad-argv', provider: 'node', argv: [],
        cwd: dir, cwdAllowlist: [dir], timeoutMs: 10_000, maxOutputBytes: 1024, checkpointPath,
      },
      {
        jobId: 'good', provider: 'node', argv: nodeProc('console.log("fine");'),
        cwd: dir, cwdAllowlist: [dir], timeoutMs: 10_000, maxOutputBytes: 1024, checkpointPath,
      },
    ], { concurrency: 2 });
    expect(results[0].status).toBe('failed');
    expect(results[0].error).toContain('argv');
    expect(results[1].status).toBe('completed');
  });
});
