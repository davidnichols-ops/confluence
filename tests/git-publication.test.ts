import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { publishGitCandidate } from '../src/git-publication.js';
import type { PublicationReceipt } from '../src/git-publication.js';
import type { GitCandidate } from '../src/git-runner.js';
import { treeHash } from '../src/core.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

const ID = ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid'];
const ZERO = '0'.repeat(40);

function g(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

async function makeSource(files: Record<string, string>): Promise<{ root: string; dir: string; head: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'git-publish-src-'));
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

async function makeBare(source: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'git-publish-bare-'));
  roots.push(root);
  const dir = path.join(root, 'bare');
  g(root, 'clone', '--bare', '--quiet', source, dir);
  return dir;
}

async function prepareCandidate(source: { dir: string; head: string }, files: Record<string, string>): Promise<GitCandidate> {
  const root = await mkdtemp(path.join(tmpdir(), 'git-publish-cand-'));
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

function publishInput(bare: string, baseHead: string, cand: GitCandidate) {
  return {
    repository: bare,
    ref: 'refs/heads/main',
    expectedHead: baseHead,
    candidate: cand,
    bundle: cand.bundle,
    evidence: { treeHash: cand.contentHash, passed: true, checks: ['fixture-check'], runner: 'test-runner' },
    approval: { treeHash: cand.contentHash, human: 'david' },
  };
}

function headOf(bare: string): string {
  return g(bare, 'rev-parse', 'refs/heads/main').trim();
}

describe('publishGitCandidate', () => {
  it('disables repository hooks during ref publication', async () => {
    const base = await makeSource({ 'app.txt': 'v1' });
    const bare = await makeBare(base.dir);
    const cand = await prepareCandidate(base, { 'app.txt': 'v2' });
    const marker = path.join(base.root, 'hook-ran');
    const hook = path.join(bare, 'hooks', 'reference-transaction');
    await writeFile(hook, '#!/bin/sh\ntouch "'+marker+'"\n');
    await chmod(hook, 0o755);
    await publishGitCandidate(publishInput(bare, base.head, cand));
    expect(await readFile(marker, 'utf8').catch(()=>null)).toBeNull();
    expect(headOf(bare)).toBe(cand.commit);
  });

  it('includes special object-key paths in the committed content hash', async () => {
    const base = await makeSource({ 'app.txt': 'v1' });
    const bare = await makeBare(base.dir);
    const cand = await prepareCandidate(base, JSON.parse('{"__proto__":"hidden code"}'));
    const empty = await treeHash({});
    const forged = { ...cand, contentHash: empty };
    await expect(publishGitCandidate(publishInput(bare, base.head, forged))).rejects.toMatchObject({ code: 'content_mismatch' });
    expect(headOf(bare)).toBe(base.head);
    await publishGitCandidate(publishInput(bare, base.head, cand));
    expect(g(bare, 'show', cand.commit+':__proto__')).toBe('hidden code');
  });

  it('rejects binary bytes that would hash as replacement text', async () => {
    const base = await makeSource({ 'app.txt': 'v1' });
    const bare = await makeBare(base.dir);
    await writeFile(path.join(base.dir, 'app.txt'), Buffer.from([255]));
    g(base.dir, 'add', '-A');g(base.dir,...ID,'commit','-q','-m','invalid UTF-8');
    const bundlePath = path.join(base.root, 'invalid.bundle');g(base.dir,'bundle','create',bundlePath,'HEAD');
    const cand = {commit:g(base.dir,'rev-parse','HEAD').trim(),tree:g(base.dir,'rev-parse','HEAD^{tree}').trim(),contentHash:await treeHash({'app.txt':'\ufffd'}),passed:true,checks:[],bundle:new Uint8Array(await readFile(bundlePath))};
    await expect(publishGitCandidate(publishInput(bare,base.head,cand))).rejects.toMatchObject({code:'unsafe_tree'});
    expect(headOf(bare)).toBe(base.head);
  });
  it('publishes a verified candidate to the local bare repository via compare-and-swap', async () => {
    const base = await makeSource({ 'app.txt': 'v1' });
    const bare = await makeBare(base.dir);
    const cand = await prepareCandidate(base, { 'app.txt': 'v2' });
    const receipt = await publishGitCandidate(publishInput(bare, base.head, cand));
    expect(receipt).toMatchObject({ ref: 'refs/heads/main', head: cand.commit, previousHead: base.head, commit: cand.commit, tree: cand.tree, contentHash: cand.contentHash, idempotent: false });
    expect(headOf(bare)).toBe(cand.commit);
    expect(g(bare, 'rev-parse', 'refs/heads/main^{tree}').trim()).toBe(cand.tree);
    const log = await readFile(path.resolve('logs/git-publication.jsonl'), 'utf8');
    expect(log).toContain('"command":"git update-ref refs/heads/main');
    expect(log).toContain('"exit":0');
  });

  it('rejects failed, mismatched or missing evidence and approval before any mutation', async () => {
    const base = await makeSource({ 'app.txt': 'v1' });
    const bare = await makeBare(base.dir);
    const cand = await prepareCandidate(base, { 'app.txt': 'v2' });
    const good = publishInput(bare, base.head, cand);
    await expect(publishGitCandidate({ ...good, evidence: { ...good.evidence, passed: false } })).rejects.toMatchObject({ code: 'evidence_failed' });
    await expect(publishGitCandidate({ ...good, evidence: { ...good.evidence, treeHash: 'f'.repeat(64) } })).rejects.toMatchObject({ code: 'evidence_mismatch' });
    await expect(publishGitCandidate({ ...good, approval: undefined as unknown as { treeHash: string; human: string } })).rejects.toMatchObject({ code: 'approval_missing' });
    await expect(publishGitCandidate({ ...good, approval: { treeHash: 'f'.repeat(64), human: 'david' } })).rejects.toMatchObject({ code: 'approval_mismatch' });
    expect(headOf(bare)).toBe(base.head);
  });

  it('rejects a tampered bundle without mutating the repository', async () => {
    const base = await makeSource({ 'app.txt': 'v1' });
    const bare = await makeBare(base.dir);
    const cand = await prepareCandidate(base, { 'app.txt': 'v2' });
    const tampered = new Uint8Array(cand.bundle);
    tampered[Math.floor(tampered.length / 2)] ^= 0xff;
    await expect(publishGitCandidate({ ...publishInput(bare, base.head, cand), bundle: tampered })).rejects.toMatchObject({ code: 'invalid_bundle' });
    expect(headOf(bare)).toBe(base.head);
  });

  it('rejects altered commit, tree and contentHash claims against the actual bundle objects', async () => {
    const base = await makeSource({ 'app.txt': 'v1' });
    const bare = await makeBare(base.dir);
    const cand = await prepareCandidate(base, { 'app.txt': 'v2' });
    const good = publishInput(bare, base.head, cand);
    await expect(publishGitCandidate({ ...good, candidate: { ...cand, commit: 'a'.repeat(40) } })).rejects.toMatchObject({ code: 'bundle_mismatch' });
    await expect(publishGitCandidate({ ...good, candidate: { ...cand, tree: 'b'.repeat(40) } })).rejects.toMatchObject({ code: 'tree_mismatch' });
    const other = await treeHash({ 'app.txt': 'OTHER' });
    await expect(publishGitCandidate({
      ...good, candidate: { ...cand, contentHash: other },
      evidence: { ...good.evidence, treeHash: other }, approval: { treeHash: other, human: 'david' },
    })).rejects.toMatchObject({ code: 'content_mismatch' });
    expect(headOf(bare)).toBe(base.head);
  });

  it('rejects a candidate whose parent does not match expectedHead', async () => {
    const base = await makeSource({ 'app.txt': 'v1' });
    const other = await makeSource({ 'app.txt': 'competing' });
    const bare = await makeBare(other.dir);
    const cand = await prepareCandidate(base, { 'app.txt': 'v2' });
    await expect(publishGitCandidate(publishInput(bare, other.head, cand))).rejects.toMatchObject({ code: 'wrong_parent' });
    expect(headOf(bare)).toBe(other.head);
  });

  it('rejects a stale competing candidate after another candidate was installed', async () => {
    const base = await makeSource({ 'app.txt': 'v1' });
    const bare = await makeBare(base.dir);
    const cand1 = await prepareCandidate(base, { 'app.txt': 'v2' });
    const cand2 = await prepareCandidate(base, { 'app.txt': 'v3' });
    await publishGitCandidate(publishInput(bare, base.head, cand1));
    await expect(publishGitCandidate(publishInput(bare, base.head, cand2))).rejects.toMatchObject({ code: 'stale_head' });
    expect(headOf(bare)).toBe(cand1.commit);
  });

  it('returns an idempotent receipt when the same approved candidate is already installed', async () => {
    const base = await makeSource({ 'app.txt': 'v1' });
    const bare = await makeBare(base.dir);
    const cand = await prepareCandidate(base, { 'app.txt': 'v2' });
    const first = await publishGitCandidate(publishInput(bare, base.head, cand));
    expect(first.idempotent).toBe(false);
    const retry = await publishGitCandidate(publishInput(bare, base.head, cand));
    expect(retry).toMatchObject({ idempotent: true, head: cand.commit, previousHead: cand.commit });
    expect(headOf(bare)).toBe(cand.commit);
  });

  it('lets exactly one competing publisher win the compare-and-swap race', async () => {
    const base = await makeSource({ 'app.txt': 'v1' });
    const bare = await makeBare(base.dir);
    const cand1 = await prepareCandidate(base, { 'app.txt': 'v2' });
    const cand2 = await prepareCandidate(base, { 'app.txt': 'v3' });
    const results = await Promise.allSettled([
      publishGitCandidate(publishInput(bare, base.head, cand1)),
      publishGitCandidate(publishInput(bare, base.head, cand2)),
    ]);
    const fulfilled = results.filter((r): r is PromiseFulfilledResult<PublicationReceipt> => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({ code: 'stale_head' });
    const winner = fulfilled[0].value;
    expect([cand1.commit, cand2.commit]).toContain(winner.commit);
    expect(headOf(bare)).toBe(winner.commit);
  });

  it('creates the branch from the zero expectedHead when the candidate is a root commit', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'git-publish-root-'));
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
    const bundle = new Uint8Array(await readFile(bundlePath));
    const bare = path.join(root, 'bare');
    g(root, 'init', '-q', '--bare', bare);
    const contentHash = await treeHash({ 'app.txt': 'seed' });
    const receipt = await publishGitCandidate({
      repository: bare, ref: 'refs/heads/main', expectedHead: ZERO,
      candidate: { commit: rootCommit, tree, contentHash }, bundle,
      evidence: { treeHash: contentHash, passed: true, checks: ['fixture-check'], runner: 'test-runner' },
      approval: { treeHash: contentHash, human: 'david' },
    });
    expect(receipt).toMatchObject({ idempotent: false, head: rootCommit, previousHead: ZERO });
    expect(headOf(bare)).toBe(rootCommit);
  });

  it('rejects unsafe refs and non-bare, missing or remote repositories', async () => {
    const base = await makeSource({ 'app.txt': 'v1' });
    const bare = await makeBare(base.dir);
    const cand = await prepareCandidate(base, { 'app.txt': 'v2' });
    const good = publishInput(bare, base.head, cand);
    for (const ref of ['', 'HEAD', 'main', 'refs/tags/v1', 'refs/heads/', 'refs/heads/main.lock', 'refs/heads/a b', 'refs/heads/../x', ' refs/heads/main']) {
      await expect(publishGitCandidate({ ...good, ref })).rejects.toMatchObject({ code: 'invalid_ref' });
    }
    await expect(publishGitCandidate({ ...good, repository: 'https://example.com/repo.git' })).rejects.toMatchObject({ code: 'invalid_repository' });
    await expect(publishGitCandidate({ ...good, repository: base.dir })).rejects.toMatchObject({ code: 'invalid_repository' });
    await expect(publishGitCandidate({ ...good, repository: path.join(bare, 'missing') })).rejects.toMatchObject({ code: 'invalid_repository' });
    expect(headOf(bare)).toBe(base.head);
  });
});
