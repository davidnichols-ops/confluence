import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { publishRemoteCandidate } from '../src/remote-publication.js';
import type { GitCandidate } from '../src/git-runner.js';
import type { PublicationReceipt } from '../src/git-publication.js';
import { treeHash } from '../src/core.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

const ID = ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid'];
const ZERO = '0'.repeat(40);
const TOKEN = 'fixture-token-0123456789abcdef0123456789abcdef?expires=9999999999';
const TOKEN_SECRET = TOKEN.split('?')[0];

function g(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

async function makeSource(files: Record<string, string>): Promise<{ root: string; dir: string; head: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'remote-publish-src-'));
  roots.push(root);
  const dir = path.join(root, 'src');
  await mkdir(dir);
  g(dir, 'init', '-q', '-b', 'main');
  for (const [p, c] of Object.entries(files)) {
    const abs = path.join(dir, p);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, c);
  }
  g(dir, 'add', '-A');
  g(dir, ...ID, 'commit', '-q', '-m', 'base');
  return { root, dir, head: g(dir, 'rev-parse', 'HEAD').trim() };
}

async function makeRemote(source?: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'remote-publish-remote-'));
  roots.push(root);
  const dir = path.join(root, 'remote.git');
  if (source) g(root, 'clone', '--bare', '--quiet', source, dir);
  else g(root, 'init', '-q', '--bare', dir);
  return dir;
}

async function prepareCandidate(source: { dir: string; head: string }, files: Record<string, string>): Promise<GitCandidate> {
  const root = await mkdtemp(path.join(tmpdir(), 'remote-publish-cand-'));
  roots.push(root);
  const dir = path.join(root, 'cand');
  g(root, 'clone', '--no-hardlinks', '--quiet', source.dir, dir);
  g(dir, 'rm', '-r', '-f', '--ignore-unmatch', '-q', '.');
  for (const [p, c] of Object.entries(files)) {
    const abs = path.join(dir, p);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, c);
  }
  g(dir, 'add', '-A');
  g(dir, ...ID, 'commit', '--no-gpg-sign', '-q', '-m', 'candidate');
  const bundlePath = path.join(root, 'cand.bundle');
  g(dir, 'bundle', 'create', bundlePath, 'HEAD');
  return {
    commit: g(dir, 'rev-parse', 'HEAD').trim(),
    tree: g(dir, 'rev-parse', 'HEAD^{tree}').trim(),
    contentHash: await treeHash(files),
    passed: true,
    checks: ['fixture-check'],
    bundle: new Uint8Array(await readFile(bundlePath)),
  };
}

function remoteInput(remote: string, baseHead: string, cand: GitCandidate) {
  return {
    remote,
    token: TOKEN,
    ref: 'refs/heads/main',
    expectedHead: baseHead,
    candidate: { commit: cand.commit, tree: cand.tree, contentHash: cand.contentHash },
    bundle: cand.bundle,
    evidence: { treeHash: cand.contentHash, passed: true, checks: ['fixture-check'], runner: 'test-runner' },
    approval: { treeHash: cand.contentHash, human: 'david' },
  };
}

function remoteHead(remoteDir: string): string {
  return g(remoteDir, 'rev-parse', 'refs/heads/main').trim();
}

describe('publishRemoteCandidate', () => {
  it('publishes a verified candidate to a real local remote via compare-and-swap', async () => {
    const base = await makeSource({ 'app.txt': 'v1' });
    const remote = await makeRemote(base.dir);
    const cand = await prepareCandidate(base, { 'app.txt': 'v2' });
    const receipt = await publishRemoteCandidate(remoteInput(remote, base.head, cand));
    expect(receipt).toMatchObject({
      ref: 'refs/heads/main', head: cand.commit, previousHead: base.head,
      commit: cand.commit, tree: cand.tree, contentHash: cand.contentHash, idempotent: false,
    });
    expect(remoteHead(remote)).toBe(cand.commit);
    expect(g(remote, 'rev-parse', 'refs/heads/main^{tree}').trim()).toBe(cand.tree);
  });

  it('returns an idempotent receipt after re-verifying fetched remote bytes on retry', async () => {
    const base = await makeSource({ 'app.txt': 'v1' });
    const remote = await makeRemote(base.dir);
    const cand = await prepareCandidate(base, { 'app.txt': 'v2' });
    const first = await publishRemoteCandidate(remoteInput(remote, base.head, cand));
    expect(first.idempotent).toBe(false);
    // Simulates a crash after push but before the coordinator recorded the receipt.
    const retry = await publishRemoteCandidate(remoteInput(remote, base.head, cand));
    expect(retry).toMatchObject({ idempotent: true, head: cand.commit, previousHead: base.head, commit: cand.commit });
    expect(remoteHead(remote)).toBe(cand.commit);
  });

  it('rejects a retry whose candidate no longer matches the remote bytes', async () => {
    const base = await makeSource({ 'app.txt': 'v1' });
    const remote = await makeRemote(base.dir);
    const cand = await prepareCandidate(base, { 'app.txt': 'v2' });
    await publishRemoteCandidate(remoteInput(remote, base.head, cand));
    const forged = { ...cand, contentHash: await treeHash({ 'app.txt': 'FORGED' }) };
    const input = remoteInput(remote, base.head, forged);
    await expect(publishRemoteCandidate({
      ...input,
      evidence: { ...input.evidence, treeHash: forged.contentHash },
      approval: { treeHash: forged.contentHash, human: 'david' },
    })).rejects.toMatchObject({ code: 'content_mismatch' });
    expect(remoteHead(remote)).toBe(cand.commit);
  });

  it('rejects a stale competing candidate after another candidate was installed', async () => {
    const base = await makeSource({ 'app.txt': 'v1' });
    const remote = await makeRemote(base.dir);
    const cand1 = await prepareCandidate(base, { 'app.txt': 'v2' });
    const cand2 = await prepareCandidate(base, { 'app.txt': 'v3' });
    await publishRemoteCandidate(remoteInput(remote, base.head, cand1));
    await expect(publishRemoteCandidate(remoteInput(remote, base.head, cand2))).rejects.toMatchObject({ code: 'stale_head' });
    expect(remoteHead(remote)).toBe(cand1.commit);
  });

  it('lets exactly one competing publisher win the remote compare-and-swap race', async () => {
    const base = await makeSource({ 'app.txt': 'v1' });
    const remote = await makeRemote(base.dir);
    const cand1 = await prepareCandidate(base, { 'app.txt': 'v2' });
    const cand2 = await prepareCandidate(base, { 'app.txt': 'v3' });
    const results = await Promise.allSettled([
      publishRemoteCandidate(remoteInput(remote, base.head, cand1)),
      publishRemoteCandidate(remoteInput(remote, base.head, cand2)),
    ]);
    const fulfilled = results.filter((r): r is PromiseFulfilledResult<PublicationReceipt> => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(['stale_head', 'git_failed']).toContain(rejected[0].reason.code);
    const winner = fulfilled[0].value;
    expect([cand1.commit, cand2.commit]).toContain(winner.head);
    expect(remoteHead(remote)).toBe(winner.head);
  });

  it('rejects a tampered bundle without contacting or mutating the remote', async () => {
    const base = await makeSource({ 'app.txt': 'v1' });
    const remote = await makeRemote(base.dir);
    const cand = await prepareCandidate(base, { 'app.txt': 'v2' });
    const tampered = new Uint8Array(cand.bundle);
    tampered[Math.floor(tampered.length / 2)] ^= 0xff;
    await expect(publishRemoteCandidate({ ...remoteInput(remote, base.head, cand), bundle: tampered })).rejects.toMatchObject({ code: 'invalid_bundle' });
    expect(remoteHead(remote)).toBe(base.head);
  });

  it('rejects altered tree and contentHash claims against the actual bundle objects', async () => {
    const base = await makeSource({ 'app.txt': 'v1' });
    const remote = await makeRemote(base.dir);
    const cand = await prepareCandidate(base, { 'app.txt': 'v2' });
    const good = remoteInput(remote, base.head, cand);
    await expect(publishRemoteCandidate({ ...good, candidate: { ...cand, tree: 'b'.repeat(40) } })).rejects.toMatchObject({ code: 'tree_mismatch' });
    const other = await treeHash({ 'app.txt': 'OTHER' });
    await expect(publishRemoteCandidate({
      ...good, candidate: { ...cand, contentHash: other },
      evidence: { ...good.evidence, treeHash: other }, approval: { treeHash: other, human: 'david' },
    })).rejects.toMatchObject({ code: 'content_mismatch' });
    expect(remoteHead(remote)).toBe(base.head);
  });

  it('rejects failed, mismatched or missing evidence and approval before any remote contact', async () => {
    const base = await makeSource({ 'app.txt': 'v1' });
    const remote = await makeRemote(base.dir);
    const cand = await prepareCandidate(base, { 'app.txt': 'v2' });
    const good = remoteInput(remote, base.head, cand);
    await expect(publishRemoteCandidate({ ...good, evidence: { ...good.evidence, passed: false } })).rejects.toMatchObject({ code: 'evidence_failed' });
    await expect(publishRemoteCandidate({ ...good, evidence: { ...good.evidence, treeHash: 'f'.repeat(64) } })).rejects.toMatchObject({ code: 'evidence_mismatch' });
    await expect(publishRemoteCandidate({ ...good, approval: undefined as unknown as { treeHash: string; human: string } })).rejects.toMatchObject({ code: 'approval_missing' });
    await expect(publishRemoteCandidate({ ...good, approval: { treeHash: 'f'.repeat(64), human: 'david' } })).rejects.toMatchObject({ code: 'approval_mismatch' });
    expect(remoteHead(remote)).toBe(base.head);
  });

  it('rejects a candidate whose parent does not match expectedHead', async () => {
    const base = await makeSource({ 'app.txt': 'v1' });
    const other = await makeSource({ 'app.txt': 'competing' });
    const remote = await makeRemote(other.dir);
    const cand = await prepareCandidate(base, { 'app.txt': 'v2' });
    await expect(publishRemoteCandidate(remoteInput(remote, other.head, cand))).rejects.toMatchObject({ code: 'wrong_parent' });
  });

  it('creates the branch on an empty remote from the zero expectedHead with a root-commit candidate', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'remote-publish-root-'));
    roots.push(root);
    const dir = path.join(root, 'src');
    await mkdir(dir);
    g(dir, 'init', '-q', '-b', 'main');
    await writeFile(path.join(dir, 'app.txt'), 'seed');
    g(dir, 'add', '-A');
    const tree = g(dir, 'write-tree').trim();
    const rootCommit = execFileSync('git', [...ID, 'commit-tree', tree], { cwd: dir, encoding: 'utf8', input: 'seed commit\n' }).trim();
    g(dir, 'branch', '-q', 'main', rootCommit);
    const bundlePath = path.join(root, 'seed.bundle');
    g(dir, 'bundle', 'create', bundlePath, 'main');
    const remote = await makeRemote();
    const contentHash = await treeHash({ 'app.txt': 'seed' });
    const receipt = await publishRemoteCandidate({
      remote, token: TOKEN, ref: 'refs/heads/main', expectedHead: ZERO,
      candidate: { commit: rootCommit, tree, contentHash },
      bundle: new Uint8Array(await readFile(bundlePath)),
      evidence: { treeHash: contentHash, passed: true, checks: ['fixture-check'], runner: 'test-runner' },
      approval: { treeHash: contentHash, human: 'david' },
    });
    expect(receipt).toMatchObject({ idempotent: false, head: rootCommit, previousHead: ZERO });
    expect(remoteHead(remote)).toBe(rootCommit);
  });

  it('never writes the token to logs or error messages', async () => {
    const base = await makeSource({ 'app.txt': 'v1' });
    const remote = await makeRemote(base.dir);
    const cand = await prepareCandidate(base, { 'app.txt': 'v2' });
    await publishRemoteCandidate(remoteInput(remote, base.head, cand));
    const stale = await prepareCandidate(base, { 'app.txt': 'v3' });
    let message = '';
    try {
      await publishRemoteCandidate(remoteInput(remote, base.head, stale));
    } catch (e) {
      message = String((e as Error).message) + JSON.stringify((e as Error & { code?: string }).code ?? '');
    }
    expect(message).not.toContain(TOKEN_SECRET);
    const log = await readFile(path.resolve('logs/remote-publication.jsonl'), 'utf8');
    expect(log).not.toContain(TOKEN_SECRET);
    expect(log).not.toContain(TOKEN);
    expect(log).toContain('ls-remote');
    expect(log).toContain('"exit":0');
  });

  it('rejects unsafe remotes, tokens, refs and unbounded timeouts', async () => {
    const base = await makeSource({ 'app.txt': 'v1' });
    const remote = await makeRemote(base.dir);
    const cand = await prepareCandidate(base, { 'app.txt': 'v2' });
    const good = remoteInput(remote, base.head, cand);
    await expect(publishRemoteCandidate({ ...good, remote: 'https://x:token@example.com/repo.git' })).rejects.toMatchObject({ code: 'invalid_remote' });
    await expect(publishRemoteCandidate({ ...good, remote: 'http://example.com/repo.git' })).rejects.toMatchObject({ code: 'invalid_remote' });
    await expect(publishRemoteCandidate({ ...good, remote: 'ssh://example.com/repo.git' })).rejects.toMatchObject({ code: 'invalid_remote' });
    await expect(publishRemoteCandidate({ ...good, remote: path.join(remote, 'missing') })).rejects.toMatchObject({ code: 'invalid_remote' });
    await expect(publishRemoteCandidate({ ...good, token: '' })).rejects.toMatchObject({ code: 'invalid_token' });
    await expect(publishRemoteCandidate({ ...good, token: 'art_v1_bad\nAuthorization: Bearer evil' })).rejects.toMatchObject({ code: 'invalid_token' });
    await expect(publishRemoteCandidate({ ...good, ref: 'main' })).rejects.toMatchObject({ code: 'invalid_ref' });
    await expect(publishRemoteCandidate({ ...good, timeoutMs: 1 })).rejects.toMatchObject({ code: 'git_failed' });
    await expect(publishRemoteCandidate({ ...good, timeoutMs: 0 })).rejects.toMatchObject({ code: 'invalid_timeout' });
    expect(remoteHead(remote)).toBe(base.head);
  });
});
