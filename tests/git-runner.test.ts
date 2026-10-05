import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prepareGitCandidate } from '../src/git-runner.js';
import { treeHash } from '../src/core.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

function g(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

async function makeRepo(files: Record<string, string>): Promise<{ root: string; dir: string; head: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'git-runner-test-'));
  roots.push(root);
  const dir = path.join(root, 'repo');
  await mkdir(dir);
  g(dir, 'init', '-q');
  for (const [p, c] of Object.entries(files)) {
    const abs = path.join(dir, p);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, c);
  }
  g(dir, 'add', '-A');
  g(dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'init');
  return { root, dir, head: g(dir, 'rev-parse', 'HEAD').trim() };
}

async function referenceTree(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'git-runner-ref-'));
  roots.push(root);
  const dir = path.join(root, 'ref');
  await mkdir(dir);
  g(dir, 'init', '-q');
  for (const [p, c] of Object.entries(files)) {
    const abs = path.join(dir, p);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, c);
  }
  g(dir, 'add', '-A');
  g(dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'ref');
  return g(dir, 'rev-parse', 'HEAD^{tree}').trim();
}

async function snapshot(dir: string): Promise<{ head: string; status: string; files: Record<string, string> }> {
  const files: Record<string, string> = {};
  for (const rel of g(dir, 'ls-files').split('\n').filter(Boolean)) {
    files[rel] = await readFile(path.join(dir, rel), 'utf8');
  }
  return { head: g(dir, 'rev-parse', 'HEAD').trim(), status: g(dir, 'status', '--porcelain'), files };
}

const ok = (checks: string[] = ['fixture-check']) => async () => ({ passed: true, checks });

describe('prepareGitCandidate', () => {
  it('commits the candidate in an isolated clone, replacing the tracked tree', async () => {
    const { dir, head } = await makeRepo({ 'keep.txt': 'kept', 'old.txt': 'obsolete' });
    const files = { 'keep.txt': 'kept', 'new/deep/a.txt': 'A' };
    const r = await prepareGitCandidate({ repository: dir, expectedHead: head, files, validate: ok(['unit:ok']) });
    expect(r.passed).toBe(true);
    expect(r.checks).toEqual(['unit:ok']);
    expect(r.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(r.tree).toMatch(/^[0-9a-f]{40}$/);
    expect(r.commit).not.toBe(head);
    expect(r.contentHash).toBe(await treeHash(files));
    const bundleRoot = await mkdtemp(path.join(tmpdir(), 'git-bundle-restore-'));
    roots.push(bundleRoot);
    const bundlePath = path.join(bundleRoot, 'candidate.bundle');
    await writeFile(bundlePath, r.bundle);
    const restored = path.join(bundleRoot, 'restored');
    g(bundleRoot, 'clone', '-q', bundlePath, restored);
    expect(g(restored, 'rev-parse', 'HEAD').trim()).toBe(r.commit);
    expect(await readFile(path.join(restored, 'new/deep/a.txt'), 'utf8')).toBe('A');
    expect(r.tree).toBe(await referenceTree(files));
  });

  it('runs validate on the prepared bytes in the temp worktree', async () => {
    const { dir, head } = await makeRepo({ 'f.txt': 'original' });
    let seen: string | undefined;
    const r = await prepareGitCandidate({
      repository: dir, expectedHead: head, files: { 'f.txt': 'prepared' },
      validate: async (directory) => {
        seen = await readFile(path.join(directory, 'f.txt'), 'utf8');
        return { passed: true, checks: [`content:${seen}`] };
      },
    });
    expect(seen).toBe('prepared');
    expect(r.passed).toBe(true);
  });

  it('returns a failed result with checks when validation fails', async () => {
    const { dir, head } = await makeRepo({ 'f.txt': 'x' });
    const r = await prepareGitCandidate({
      repository: dir, expectedHead: head, files: { 'f.txt': 'y' },
      validate: async () => ({ passed: false, checks: ['unit:fail'] }),
    });
    expect(r.passed).toBe(false);
    expect(r.checks).toEqual(['unit:fail']);
    expect(r.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(r.tree).toBe(await referenceTree({ 'f.txt': 'y' }));
  });

  it('rejects a stale expectedHead before any candidate work', async () => {
    const { dir, head } = await makeRepo({ 'f.txt': 'x' });
    const before = await snapshot(dir);
    await expect(prepareGitCandidate({ repository: dir, expectedHead: '0'.repeat(40), files: { 'f.txt': 'y' }, validate: ok() }))
      .rejects.toMatchObject({ name: 'DomainError', code: 'stale_head' });
    expect(await snapshot(dir)).toEqual(before);
  });

  it('rejects unsafe candidate paths without touching the repository', async () => {
    const { dir, head } = await makeRepo({ 'f.txt': 'x' });
    const before = await snapshot(dir);
    const bad: Record<string, string>[] = [
      { '../escape.txt': 'x' },
      { '/etc/passwd': 'x' },
      { 'a\\b.txt': 'x' },
      { '.git/config': 'x' },
      { 'sub/.GIT/config': 'x' },
      { 'sub/../x.txt': 'x' },
      { './x.txt': 'x' },
      { 'x/': 'x' },
      { 'C:\\tmp\\x': 'x' },
    ];
    for (const files of bad) {
      await expect(prepareGitCandidate({ repository: dir, expectedHead: head, files, validate: ok() }))
        .rejects.toMatchObject({ code: 'unsafe_path' });
    }
    await expect(prepareGitCandidate({ repository: dir, expectedHead: head, files: { 'a': '1', 'a/b': '2' }, validate: ok() }))
      .rejects.toMatchObject({ code: 'duplicate_path' });
    expect(await snapshot(dir)).toEqual(before);
  });

  it('rejects a validate callback that mutates candidate bytes', async () => {
    const { dir, head } = await makeRepo({ 'f.txt': 'x' });
    await expect(prepareGitCandidate({
      repository: dir, expectedHead: head, files: { 'f.txt': 'y' },
      validate: async (d) => { await writeFile(path.join(d, 'f.txt'), 'TAMPERED'); return { passed: true, checks: [] }; },
    })).rejects.toMatchObject({ code: 'candidate_mutated' });
    await expect(prepareGitCandidate({
      repository: dir, expectedHead: head, files: { 'f.txt': 'y' },
      validate: async (d) => { await writeFile(path.join(d, 'extra.txt'), 'smuggled'); return { passed: true, checks: [] }; },
    })).rejects.toMatchObject({ code: 'candidate_mutated' });
  });

  it('leaves the source repository and worktree unchanged across success and failure', async () => {
    const { dir, head } = await makeRepo({ 'f.txt': 'original', 'g/h.txt': 'nested' });
    const before = await snapshot(dir);
    await prepareGitCandidate({ repository: dir, expectedHead: head, files: { 'f.txt': 'changed' }, validate: ok() });
    expect(await snapshot(dir)).toEqual(before);
    await prepareGitCandidate({ repository: dir, expectedHead: head, files: { 'f.txt': 'changed' }, validate: async () => ({ passed: false, checks: [] }) });
    expect(await snapshot(dir)).toEqual(before);
  });

  it('cleans up its temporary clone on success and on rejection', async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), 'git-runner-cleanup-'));
    roots.push(tmp);
    const { dir, head } = await makeRepo({ 'f.txt': 'x' });
    const list = async () => (await readdir(tmpdir())).filter((d) => d.startsWith('confluence-git-'));
    const before = await list();
    await prepareGitCandidate({ repository: dir, expectedHead: head, files: { 'f.txt': 'y' }, validate: ok() });
    expect(await list()).toEqual(before);
    await expect(prepareGitCandidate({
      repository: dir, expectedHead: head, files: { 'f.txt': 'y' },
      validate: async (d) => { await writeFile(path.join(d, 'f.txt'), 'nope'); return { passed: true, checks: [] }; },
    })).rejects.toThrow();
    expect(await list()).toEqual(before);
  });

  it('fails closed on tracked symlinks and submodules in the source repository', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'git-runner-test-'));
    roots.push(root);
    const dir = path.join(root, 'repo');
    await mkdir(dir);
    g(dir, 'init', '-q');
    await writeFile(path.join(dir, 'f.txt'), 'x');
    await symlink('f.txt', path.join(dir, 'link.txt'));
    g(dir, 'add', '-A');
    g(dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'init');
    const head = g(dir, 'rev-parse', 'HEAD').trim();
    await expect(prepareGitCandidate({ repository: dir, expectedHead: head, files: { 'f.txt': 'y' }, validate: ok() }))
      .rejects.toMatchObject({ code: 'unsafe_source' });

    const root2 = await mkdtemp(path.join(tmpdir(), 'git-runner-test-'));
    roots.push(root2);
    const dir2 = path.join(root2, 'repo');
    await mkdir(dir2);
    g(dir2, 'init', '-q');
    await writeFile(path.join(dir2, 'f.txt'), 'x');
    g(dir2, 'add', '-A');
    g(dir2, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'init');
    g(dir2, 'update-index', '--add', '--cacheinfo', '160000,0123456789012345678901234567890123456789,sub');
    g(dir2, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'gitlink');
    const head2 = g(dir2, 'rev-parse', 'HEAD').trim();
    await expect(prepareGitCandidate({ repository: dir2, expectedHead: head2, files: { 'f.txt': 'y' }, validate: ok() }))
      .rejects.toMatchObject({ code: 'unsafe_source' });
  });

  it('rejects missing or non-git repositories and invalid input shapes', async () => {
    const { dir, head } = await makeRepo({ 'f.txt': 'x' });
    await expect(prepareGitCandidate({ repository: path.join(dir, '..', 'missing'), expectedHead: head, files: {}, validate: ok() }))
      .rejects.toMatchObject({ code: 'invalid_repository' });
    const plain = await mkdtemp(path.join(tmpdir(), 'git-runner-plain-'));
    roots.push(plain);
    await expect(prepareGitCandidate({ repository: plain, expectedHead: head, files: {}, validate: ok() }))
      .rejects.toMatchObject({ code: 'invalid_repository' });
    await expect(prepareGitCandidate({ repository: dir, expectedHead: head, files: { 'f.txt': 5 as unknown as string }, validate: ok() }))
      .rejects.toMatchObject({ code: 'invalid_files' });
    await expect(prepareGitCandidate({ repository: dir, expectedHead: head, files: { 'f.txt': 'y' }, validate: undefined as unknown as () => Promise<{ passed: boolean; checks: string[] }> }))
      .rejects.toMatchObject({ code: 'invalid_validate' });
  });
});
