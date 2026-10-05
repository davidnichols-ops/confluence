#!/usr/bin/env node
// Confluence provider demo — real provider execution and resumption evidence.
//
// Runs two installed provider CLIs (agy, devin) concurrently against isolated
// disposable git worktrees, proves overlapping execution intervals from
// recorded timestamps, intentionally terminates one bounded child, then
// resumes it in a fresh OS process from the atomic checkpoint. Writes machine
// JSON evidence and a command transcript under --out (default inside the
// git-ignored logs/ directory). Never simulates a provider: if a provider
// binary is missing the demo skips with exit code 3.
//
// Usage:
//   npx tsx scripts/provider-demo.mjs [--out DIR] [--main-timeout-ms N]
//       [--terminate-after-ms N] [--resume-timeout-ms N] [--keep]
// Exit codes: 0 success, 1 failure, 2 usage, 3 provider unavailable (skip).

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  intervalsOverlap,
  loadCheckpoint,
  resumeProvider,
  runProvider,
  runProviderBatch,
} from '../src/provider-runner.js';

const DEMO_SELF = fileURLToPath(import.meta.url);
const MAX_OUTPUT_BYTES = 262144;

function argValue(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] !== undefined ? Number(process.argv[i + 1]) : fallback;
}

function failUsage(message) {
  console.error(JSON.stringify({ error: 'usage', message }));
  process.exit(2);
}

function git(cwd, args, { check = true } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => resolve({ code: -1, stdout, stderr: `${stderr}${err.message}` }));
    child.on('close', (code) => {
      transcript.push({ command: `git ${args.join(' ')} (cwd ${cwd})`, exit: code });
      if (check && code !== 0) {
        reject(new Error(`git ${args[0]} exited ${code}: ${stderr.trim()}`));
      } else {
        resolve({ code, stdout, stderr });
      }
    });
  });
}

const transcript = [];

async function writeJsonAtomic(filePath, value) {
  const tmp = `${filePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  await writeFile(tmp, JSON.stringify(value, null, 2));
  await rename(tmp, filePath);
}

function providerAvailable(bin) {
  return new Promise((resolve) => {
    const child = spawn(bin, ['--help'], { stdio: 'ignore' });
    child.on('error', (err) => resolve({ available: err.code !== 'ENOENT', err: err.code }));
    child.on('close', () => resolve({ available: true, err: null }));
  });
}

function intervalOf(result) {
  return {
    startedAt: result.startedAt,
    endedAt: result.endedAt,
    startedAtMs: result.startedAtMs,
    endedAtMs: result.endedAtMs,
    durationMs: result.durationMs,
  };
}

const AGY_TASK = [
  'You are working alone in a git repository checked out at the current directory (a worktree on branch task/agy-parse-int).',
  'Task: create a new file src/parse_int.py containing a function parse_int(s: str) -> int that parses a positive integer string with optional thousands separators (commas, spaces, or underscores) and raises ValueError on malformed input. Include a docstring and, under "if __name__ == \'__main__\':", at least three assert-based self-tests. Python 3 standard library only.',
  'When the file is done and `python3 src/parse_int.py` passes, run exactly: git add src/parse_int.py && git commit -m "Add parse_int utility"',
  'Do not modify any other files. Do not ask questions. Finish autonomously.',
].join('\n');

const DEVIN_TASK = [
  'You are working alone in a git repository checked out at the current directory (a worktree on branch task/devin-format-int).',
  'Task: create a new file src/format_int.py containing a function format_int(n: int) -> str that renders an integer with comma thousands separators (e.g. 1234567 -> "1,234,567") and handles negative numbers. Include a docstring and, under "if __name__ == \'__main__\':", at least three assert-based self-tests. Python 3 standard library only.',
  'When the file is done and `python3 src/format_int.py` passes, run exactly: git add src/format_int.py && git commit -m "Add format_int utility"',
  'Do not modify any other files. Do not ask questions. Finish autonomously.',
].join('\n');

const ROMAN_TASK = [
  'You are working alone in a git repository checked out at the current directory (a dedicated worktree branch created for this task).',
  'Task: create a new file src/roman.py containing a function to_roman(n: int) -> str that converts integers 1..3999 to Roman numerals and raises ValueError outside that range. Include a docstring and, under "if __name__ == \'__main__\':", at least three assert-based self-tests. Python 3 standard library only.',
  'When the file is done and `python3 src/roman.py` passes, run exactly: git add src/roman.py && git commit -m "Add roman numeral utility"',
  'Do not modify any other files. Do not ask questions. Finish autonomously.',
].join('\n');

function agyArgv(prompt) {
  return ['agy', `--print=${prompt}`, '--print-timeout=600s', '--dangerously-skip-permissions'];
}

function devinArgv(prompt) {
  return ['devin', '-p', prompt, '--permission-mode', 'dangerous', '--respect-workspace-trust', 'false'];
}

function resumePrompt(checkpoint, terminateAfterMs) {
  const partial = checkpoint.partial
    ? `captured stdout sha256 ${checkpoint.partial.stdout.sha256} (${checkpoint.partial.stdout.bytes} bytes), stderr sha256 ${checkpoint.partial.stderr.sha256} (${checkpoint.partial.stderr.bytes} bytes)`
    : 'no captured output';
  return [
    `You are working alone in a git repository checked out at the current directory. A previous agent process was intentionally terminated by its supervisor after ${terminateAfterMs}ms; a checkpoint recorded its partial progress (${partial}).`,
    `Original task, unchanged: ${checkpoint.taskPrompt}`,
    'Continue from the current worktree state: if the target file already exists, finish and fix it instead of starting over. Complete the task, make the self-tests pass, then run the exact git add && git commit command from the original task.',
    'Do not modify any other files. Do not ask questions. Finish autonomously.',
  ].join('\n');
}

async function collectCommit(worktree, label, baseHead) {
  const head = (await git(worktree, ['rev-parse', 'HEAD'])).stdout.trim();
  const subject = (await git(worktree, ['log', '-1', '--pretty=%s'])).stdout.trim();
  const status = (await git(worktree, ['status', '--porcelain'])).stdout.trim();
  return {
    label,
    worktree,
    head,
    subject,
    clean: status === '',
    newCommitVsBase: head !== baseHead,
  };
}

async function main() {
  const outDir = (() => {
    const i = process.argv.indexOf('--out');
    return i >= 0 ? path.resolve(process.argv[i + 1]) : path.resolve('logs', `provider-demo-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  })();
  const mainTimeoutMs = argValue('--main-timeout-ms', 420000);
  const terminateAfterMs = argValue('--terminate-after-ms', 40000);
  const resumeTimeoutMs = argValue('--resume-timeout-ms', 420000);
  const keep = process.argv.includes('--keep');
  if (!(mainTimeoutMs > 0) || !(terminateAfterMs > 0) || !(resumeTimeoutMs > 0)) failUsage('timeouts must be positive');
  await mkdir(outDir, { recursive: true });

  const availability = { agy: await providerAvailable('agy'), devin: await providerAvailable('devin') };
  const missing = Object.entries(availability).filter(([, a]) => !a.available).map(([p, a]) => `${p} (${a.err})`);
  if (missing.length > 0) {
    await writeJsonAtomic(path.join(outDir, 'evidence.json'), { skipped: true, missing, at: new Date().toISOString() });
    console.error(JSON.stringify({ skipped: true, missing }));
    process.exit(3);
  }

  // Disposable origin repository plus one isolated worktree per provider.
  const workRoot = await mkdtemp(path.join(tmpdir(), 'confluence-provider-demo-'));
  const origin = path.join(workRoot, 'origin');
  await mkdir(origin, { recursive: true });
  await git(origin, ['init', '-q']);
  await git(origin, ['config', 'user.name', 'Confluence Provider Demo']);
  await git(origin, ['config', 'user.email', 'provider-demo@example.invalid']);
  await writeFile(path.join(origin, 'README.md'), [
    '# Confluence provider demo toolkit',
    '',
    'Tiny Python utility library used to verify concurrent provider execution.',
    'Conventions: Python 3 standard library only; each utility lives in its own',
    'module under src/ with assert-based self-tests runnable via python3.',
    '',
  ].join('\n'));
  await mkdir(path.join(origin, 'src'), { recursive: true });
  await writeFile(path.join(origin, 'src', '__init__.py'), '');
  await git(origin, ['add', '-A']);
  await git(origin, ['commit', '-q', '-m', 'Seed toolkit']);
  const baseHead = (await git(origin, ['rev-parse', 'HEAD'])).stdout.trim();

  const wtAgy = path.join(workRoot, 'wt-agy');
  const wtDevin = path.join(workRoot, 'wt-devin');
  const wtResume = path.join(workRoot, 'wt-agy-resume');
  const wtResumeRetry = path.join(workRoot, 'wt-agy-resume-retry');
  await git(origin, ['worktree', 'add', '-q', '-b', 'task/agy-parse-int', wtAgy]);
  await git(origin, ['worktree', 'add', '-q', '-b', 'task/devin-format-int', wtDevin]);
  await git(origin, ['worktree', 'add', '-q', '-b', 'task/agy-roman', wtResume]);

  const cpDir = path.join(outDir, 'checkpoints');
  const allowlist = [wtAgy, wtDevin, wtResume, wtResumeRetry];
  const common = {
    cwdAllowlist: allowlist,
    timeoutMs: mainTimeoutMs,
    maxOutputBytes: MAX_OUTPUT_BYTES,
  };

  // Phase 1: two real providers, concurrent, disjoint tiny tasks.
  const batchResults = await runProviderBatch([
    {
      ...common, jobId: 'agy-parse-int', provider: 'agy', argv: agyArgv(AGY_TASK),
      cwd: wtAgy, taskPrompt: AGY_TASK, checkpointPath: path.join(cpDir, 'agy-parse-int.json'),
    },
    {
      ...common, jobId: 'devin-format-int', provider: 'devin', argv: devinArgv(DEVIN_TASK),
      cwd: wtDevin, taskPrompt: DEVIN_TASK, checkpointPath: path.join(cpDir, 'devin-format-int.json'),
    },
  ], { concurrency: 2 });
  const [agyRun, devinRun] = batchResults;
  const overlapProved = intervalsOverlap(agyRun, devinRun);

  // Phase 2: intentionally terminate one bounded child, checkpoint, resume fresh.
  // If the provider finishes before the terminate timer, retry once with a
  // shorter window on a fresh worktree so the interruption is genuinely observed.
  let terminatedRun = null;
  let interruptedCheckpoint = null;
  let romanWorktree = wtResume;
  let romanCheckpointPath = path.join(cpDir, 'agy-roman.json');
  let terminateWindowMs = terminateAfterMs;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const wt = attempt === 1 ? wtResume : wtResumeRetry;
    const cpPath = path.join(cpDir, attempt === 1 ? 'agy-roman.json' : 'agy-roman-retry.json');
    const controller = new AbortController();
    const terminateTimer = setTimeout(
      () => controller.abort(new Error(`intentional supervisor terminate after ${terminateWindowMs}ms`)),
      terminateWindowMs,
    );
    terminateTimer.unref?.();
    const run = await runProvider({
      ...common, jobId: attempt === 1 ? 'agy-roman' : 'agy-roman-retry', provider: 'agy',
      argv: agyArgv(ROMAN_TASK), cwd: wt, taskPrompt: ROMAN_TASK,
      checkpointPath: cpPath, signal: controller.signal,
    });
    if (run.status === 'interrupted' || run.status === 'failed' || attempt === 2) {
      terminatedRun = run;
      romanWorktree = wt;
      romanCheckpointPath = cpPath;
      if (run.status === 'interrupted') interruptedCheckpoint = await loadCheckpoint(cpPath);
      break;
    }
    terminateWindowMs = Math.max(8000, Math.floor(terminateWindowMs / 4));
  }

  let resumedRun = null;
  let resumedCheckpoint = null;
  let resumeRunnerPid = null;
  if (terminatedRun.status === 'interrupted') {
    // Fresh OS process performs the resume from the persisted checkpoint only.
    const resumeResultPath = path.join(cpDir, 'agy-roman.resume.json');
    const child = spawn(process.execPath, ['--import', 'tsx', DEMO_SELF,
      '--resume-stage', romanCheckpointPath,
      '--resume-result', resumeResultPath,
      '--terminate-after-ms', String(terminateAfterMs),
      '--resume-timeout-ms', String(resumeTimeoutMs)], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    let resumeChildOut = '';
    child.stdout.on('data', (d) => { resumeChildOut += d; });
    child.stderr.on('data', (d) => { resumeChildOut += d; });
    const resumeChildExit = await new Promise((resolve) => child.on('close', resolve));
    transcript.push({ command: `node --import tsx scripts/provider-demo.mjs --resume-stage <checkpoint> (fresh process pid ${child.pid})`, exit: resumeChildExit });
    resumeRunnerPid = child.pid;
    if (resumeChildExit === 0) {
      resumedRun = JSON.parse(await readFile(resumeResultPath, 'utf8'));
      resumedCheckpoint = JSON.parse(await readFile(path.join(cpDir, 'agy-roman.json'), 'utf8'));
    } else {
      console.error(`resume stage failed (exit ${resumeChildExit}): ${resumeChildOut.slice(-2000)}`);
    }
  }

  // Phase 3: collect real commits from every worktree.
  const commits = [];
  for (const [label, wt] of [['agy-parse-int', wtAgy], ['devin-format-int', wtDevin], ['agy-roman', romanWorktree]]) {
    commits.push(await collectCommit(wt, label, baseHead));
  }

  const mainCommitsOk = commits.filter((c) => c.label !== 'agy-roman').every((c) => c.newCommitVsBase);
  const resumeOk = terminatedRun !== null && terminatedRun.status === 'interrupted'
    && resumedRun !== null && resumedRun.status === 'completed'
    && resumedCheckpoint !== null && resumedCheckpoint.attempt === 2
    && interruptedCheckpoint !== null
    && resumedCheckpoint.resumeOf === interruptedCheckpoint.checkpointId
    && resumeRunnerPid !== null && resumeRunnerPid !== process.pid;

  const evidence = {
    schema: 'confluence-provider-demo-evidence/1',
    at: new Date().toISOString(),
    demoRunnerPid: process.pid,
    workRoot,
    baseHead,
    config: { mainTimeoutMs, terminateAfterMs, resumeTimeoutMs, maxOutputBytes: MAX_OUTPUT_BYTES, concurrency: 2 },
    providers: {
      agy: { jobId: agyRun.jobId, status: agyRun.status, exitCode: agyRun.exitCode, interval: intervalOf(agyRun), stdout: agyRun.stdout, stderr: agyRun.stderr, error: agyRun.error },
      devin: { jobId: devinRun.jobId, status: devinRun.status, exitCode: devinRun.exitCode, interval: intervalOf(devinRun), stdout: devinRun.stdout, stderr: devinRun.stderr, error: devinRun.error },
    },
    overlap: { proved: overlapProved, method: 'half-open interval intersection on recorded startedAtMs/endedAtMs' },
    termination: {
      jobId: terminatedRun.jobId,
      status: terminatedRun.status,
      killedBy: terminatedRun.killedBy,
      interval: intervalOf(terminatedRun),
      partialStdout: terminatedRun.stdout,
      partialStderr: terminatedRun.stderr,
      checkpoint: interruptedCheckpoint,
    },
    resume: resumedRun ? {
      status: resumedRun.status,
      exitCode: resumedRun.exitCode,
      interval: intervalOf(resumedRun),
      freshProcessPid: resumeRunnerPid,
      demoRunnerPid: process.pid,
      freshProcess: resumeRunnerPid !== process.pid,
      attempt: resumedCheckpoint.attempt,
      resumeOf: resumedCheckpoint.resumeOf,
      lineageMatches: resumedCheckpoint.resumeOf === interruptedCheckpoint.checkpointId,
      stdout: resumedRun.stdout,
      stderr: resumedRun.stderr,
      error: resumedRun.error,
    } : { performed: false, reason: terminatedRun.status !== 'interrupted' ? `terminated run status was ${terminatedRun.status}` : 'resume stage failed' },
    commits,
    checks: {
      mainTasksCommitted: mainCommitsOk,
      overlapProved,
      resumeFreshProcessOk: resumeOk,
    },
    transcript,
  };

  const success = mainCommitsOk && overlapProved && resumeOk;
  await writeJsonAtomic(path.join(outDir, 'evidence.json'), evidence);
  await writeJsonAtomic(path.join(outDir, 'transcript.json'), transcript);
  const summary = {
    ok: success,
    outDir,
    overlap: overlapProved,
    agy: agyRun.status,
    devin: devinRun.status,
    terminated: terminatedRun.status,
    resumed: resumedRun ? resumedRun.status : 'not-performed',
    commits: Object.fromEntries(commits.map((c) => [c.label, c.newCommitVsBase ? c.head.slice(0, 12) : null])),
  };
  console.log(JSON.stringify(summary, null, 2));
  if (!keep) await rm(workRoot, { recursive: true, force: true });
  process.exit(success ? 0 : 1);
}

async function resumeStage() {
  const i = process.argv.indexOf('--resume-stage');
  const checkpointPath = path.resolve(process.argv[i + 1]);
  const j = process.argv.indexOf('--resume-result');
  const resultPath = path.resolve(process.argv[j + 1]);
  const terminateAfterMs = argValue('--terminate-after-ms', 40000);
  const resumeTimeoutMs = argValue('--resume-timeout-ms', 420000);
  const checkpoint = await loadCheckpoint(checkpointPath);
  const buildResumeArgv = (cp) => (cp.provider === 'devin'
    ? devinArgv(resumePrompt(cp, terminateAfterMs))
    : agyArgv(resumePrompt(cp, terminateAfterMs)));
  const result = await resumeProvider({
    checkpointPath,
    cwdAllowlist: [checkpoint.cwd],
    timeoutMs: resumeTimeoutMs,
    maxOutputBytes: MAX_OUTPUT_BYTES,
    buildResumeArgv,
  });
  await writeJsonAtomic(resultPath, result);
  console.log(JSON.stringify({ status: result.status, exitCode: result.exitCode, runnerPid: process.pid }));
  process.exit(result.status === 'completed' ? 0 : 1);
}

const stageIndex = process.argv.indexOf('--resume-stage');
if (stageIndex >= 0) {
  resumeStage().catch((err) => {
    console.error(JSON.stringify({ error: String(err && err.stack || err) }));
    process.exit(1);
  });
} else {
  main().catch((err) => {
    console.error(JSON.stringify({ error: String(err && err.stack || err) }));
    process.exit(1);
  });
}
