#!/usr/bin/env node

/**
 * Confluence Machine Release Verifier
 *
 * Runs local test suite, TypeScript typecheck, and Worker dry-run build sequentially.
 * Built strictly with Node.js built-in modules (no external dependencies required).
 *
 * Guarantees:
 * - Bounded execution with configurable per-step timeouts (default 60s).
 * - Uses process.execPath and workspace-local binaries to avoid broken global npm.
 * - Captures raw execution logs and exit codes under logs/.
 * - Emits machine-readable JSON summary.
 * - Does NOT perform remote writes, live deployments, or state mutations.
 * - Exits non-zero immediately upon any step failure.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const LOGS_DIR = path.join(ROOT_DIR, 'logs');

// Default 60 seconds per step unless overridden
const STEP_TIMEOUT_MS = parseInt(process.env.VERIFY_TIMEOUT_MS || '60000', 10);
if (!Number.isSafeInteger(STEP_TIMEOUT_MS) || STEP_TIMEOUT_MS < 1000 || STEP_TIMEOUT_MS > 60000) {
  console.error('VERIFY_TIMEOUT_MS must be between 1000 and 60000 milliseconds');
  process.exit(2);
}

if (!existsSync(LOGS_DIR)) {
  mkdirSync(LOGS_DIR, { recursive: true });
}

const steps = [
  {
    id: 'test',
    name: 'Unit & Integration Tests (vitest)',
    command: process.execPath,
    args: [path.join(ROOT_DIR, 'node_modules', 'vitest', 'vitest.mjs'), 'run', '--fileParallelism=false'],
    description: 'Execute local unit/integration suite; Artifacts adapter unit tests use fakes, Git and server tests use real local processes',
  },
  {
    id: 'typecheck',
    name: 'TypeScript Compilation Check (tsc)',
    command: process.execPath,
    args: [path.join(ROOT_DIR, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit'],
    description: 'Run tsc --noEmit to verify full project type integrity',
  },
  {
    id: 'worker_drybuild',
    name: 'Cloudflare Worker Dry Build (wrangler)',
    command: process.execPath,
    args: [path.join(ROOT_DIR, 'node_modules', 'wrangler', 'bin', 'wrangler.js'), 'deploy', '--dry-run'],
    description: 'Dry-run compile Cloudflare Worker with Durable Object and Artifacts bindings',
  },
];

const runTimestamp = new Date().toISOString();
const combinedLogPath = path.join(LOGS_DIR, 'verify-release.log');
const summaryJsonPath = path.join(LOGS_DIR, 'verify-release-summary.json');

let combinedLogBuffer = `=== Confluence Release Verification Run: ${runTimestamp} ===\n\n`;

const results = [];
let overallSuccess = true;
const runStartTime = Date.now();

for (const step of steps) {
  process.stderr.write(`[verify-release] Running step: ${step.name} ...\n`);
  const stepStartTime = Date.now();

  const stepLogPath = path.join(LOGS_DIR, `verify-release-${step.id}.log`);

  let status = 'failed';
  let exitCode = null;
  let signal = null;
  let stdout = '';
  let stderr = '';

  try {
    const proc = spawnSync(step.command, step.args, {
      cwd: ROOT_DIR,
      timeout: STEP_TIMEOUT_MS,
      encoding: 'utf8',
      env: {
        ...process.env,
        CI: 'true',
        FORCE_COLOR: '0',
      },
      maxBuffer: 10 * 1024 * 1024,
    });

    exitCode = proc.status;
    signal = proc.signal;
    stdout = proc.stdout || '';
    stderr = proc.stderr || '';

    if (proc.error) {
      if (proc.error.code === 'ETIMEDOUT') {
        status = 'timeout';
      } else {
        status = 'error';
        stderr += `\nProcess error: ${proc.error.message}`;
      }
    } else if (proc.status === 0) {
      status = 'passed';
    } else {
      status = 'failed';
    }
  } catch (err) {
    status = 'error';
    stderr = String(err);
  }

  const durationMs = Date.now() - stepStartTime;
  const isPassed = status === 'passed';

  if (!isPassed) {
    overallSuccess = false;
  }

  const stepLogContent = [
    `Step: ${step.name} (${step.id})`,
    `Description: ${step.description}`,
    `Command: ${step.command} ${step.args.join(' ')}`,
    `Status: ${status} (Exit Code: ${exitCode}, Signal: ${signal})`,
    `Duration: ${durationMs}ms`,
    `--- STDOUT ---`,
    stdout,
    `--- STDERR ---`,
    stderr,
    `=== END OF STEP ===\n`,
  ].join('\n');

  writeFileSync(stepLogPath, stepLogContent, 'utf8');

  combinedLogBuffer += stepLogContent + '\n';

  const stdoutLines = stdout.trim().split('\n');
  const stderrLines = stderr.trim().split('\n');

  const stdoutSnippet = stdoutLines.slice(-10).join('\n');
  const stderrSnippet = stderrLines.slice(-10).join('\n');

  const result = {
    id: step.id,
    name: step.name,
    command: step.command,
    args: step.args,
    description: step.description,
    status,
    exitCode,
    signal,
    durationMs,
    stdoutSnippet,
    stderrSnippet,
    logFile: path.relative(ROOT_DIR, stepLogPath),
  };

  results.push(result);

  process.stderr.write(
    `[verify-release] Step ${step.id} finished with status=${status}, exitCode=${exitCode} (${durationMs}ms)\n`
  );

  // If a step failed, break immediately (fail-fast bounded verification)
  if (!isPassed) {
    process.stderr.write(`[verify-release] Aborting subsequent steps due to failure in '${step.id}'.\n`);
    break;
  }
}

const totalDurationMs = Date.now() - runStartTime;

const summary = {
  verifier: 'confluence-release-verifier-v1',
  timestamp: runTimestamp,
  nodeVersion: process.version,
  platform: process.platform,
  workspace: ROOT_DIR,
  allPassed: overallSuccess,
  totalDurationMs,
  steps: results,
};

combinedLogBuffer += `=== Overall Verification Result: ${overallSuccess ? 'ALL PASSED' : 'FAILED'} (${totalDurationMs}ms) ===\n`;

writeFileSync(combinedLogPath, combinedLogBuffer, 'utf8');
writeFileSync(summaryJsonPath, JSON.stringify(summary, null, 2), 'utf8');

// Emit JSON summary to stdout
process.stdout.write(JSON.stringify(summary, null, 2) + '\n');

if (!overallSuccess) {
  process.exit(1);
} else {
  process.exit(0);
}
