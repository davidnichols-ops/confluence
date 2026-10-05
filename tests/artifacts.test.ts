import { describe, expect, it } from 'vitest';
import {
  ArtifactsAdapter,
  RemoteMergeUnavailableError,
  REMOTE_MERGE_UNAVAILABLE,
  redactToken,
  type ArtifactsCreateRepoResult,
  type ArtifactsNamespace,
  type ArtifactsRepo,
} from '../src/artifacts';

class FakeRepo implements ArtifactsRepo {
  disposed = false;
  createTokenCalls = 0;
  forkCalls = 0;

  constructor(
    private readonly repoInfo: { name: string; remote: string; defaultBranch: string },
    private readonly files: Map<string, string> = new Map(),
  ) {}

  [Symbol.dispose](): void {
    this.disposed = true;
  }

  async info() {
    return { ...this.repoInfo, status: 'ready' };
  }

  async createToken(scope?: 'read' | 'write', ttlSeconds?: number) {
    this.createTokenCalls += 1;
    return { plaintext: `git-token-${scope ?? 'write'}-${ttlSeconds ?? 0}-secret`, expiresAt: '2026-10-05T00:00:00Z', scope: scope ?? 'write' };
  }

  async listTokens() {
    return { total: 0, tokens: [] };
  }

  async revokeToken(): Promise<boolean> {
    return true;
  }

  async fork(name: string) {
    this.forkCalls += 1;
    const result: ArtifactsCreateRepoResult = {
      name,
      remote: `https://artifacts.example.com/${name}.git`,
      defaultBranch: 'main',
      token: 'initial-fork-token-secret',
    };
    return result;
  }

  async log() {
    return [{ hash: 'a'.repeat(40), message: 'init' }];
  }

  async readCommit() {
    return null;
  }

  async readTree() {
    return null;
  }

  async readBlob() {
    return null;
  }

  async readFile(args: { ref: string; path: string }) {
    const content = this.files.get(args.path);
    if (content === undefined) return null;
    return new Blob([content], { type: 'text/plain;charset=utf-8' });
  }
}

class FakeNamespace implements ArtifactsNamespace {
  repos = new Map<string, FakeRepo>();
  createCalls = 0;

  async get(name: string): Promise<ArtifactsRepo> {
    const repo = this.repos.get(name);
    if (!repo) throw Object.assign(new Error(`repo ${name} not found`), { code: 'NOT_FOUND' });
    return repo;
  }

  async create(name: string, opts?: { description?: string }) {
    this.createCalls += 1;
    const repo = new FakeRepo({ name, remote: `https://artifacts.example.com/${name}.git`, defaultBranch: 'main' });
    this.repos.set(name, repo);
    void opts;
    return { name, remote: `https://artifacts.example.com/${name}.git`, defaultBranch: 'main', token: 'initial-create-token-secret' };
  }

  async list() {
    return { repos: Array.from(this.repos.keys()).map((name) => ({ name, status: 'ready' })) };
  }

  async import(params: { target: { name: string } }) {
    return this.create(params.target.name);
  }

  async delete(name: string): Promise<boolean> {
    return this.repos.delete(name);
  }
}

describe('ArtifactsAdapter', () => {
  it('confirms absence independently when the remote proxy strips error codes', async () => {
    const ns = new FakeNamespace();
    ns.get = async () => { throw Object.assign(new Error('unstructured remote exception'), {remote:true}); };
    const adapter = new ArtifactsAdapter({ artifacts: ns, repoName: 'missing' });
    expect((await adapter.ensureRepo()).created).toBe(true);
    expect(ns.createCalls).toBe(1);
  });

  it('does not create on a proxy fault when listing contains the repository or fails', async () => {
    const ns = new FakeNamespace();
    ns.repos.set('r',new FakeRepo({name:'r',remote:'remote',defaultBranch:'main'}));
    const fault = Object.assign(new Error('proxy fault'),{remote:true});
    ns.get=async()=>{throw fault;};
    const adapter=new ArtifactsAdapter({artifacts:ns,repoName:'r'});
    await expect(adapter.ensureRepo()).rejects.toBe(fault);
    ns.list=async()=>{throw new Error('listing denied');};
    await expect(adapter.ensureRepo()).rejects.toThrow('listing denied');
    expect(ns.createCalls).toBe(0);
  });
  it('creates the repo when missing and never exposes the initial token', async () => {
    const ns = new FakeNamespace();
    const adapter = new ArtifactsAdapter({ artifacts: ns, repoName: 'confluence-baseline' });
    const result = await adapter.ensureRepo();
    expect(ns.createCalls).toBe(1);
    expect(result.created).toBe(true);
    expect(result.name).toBe('confluence-baseline');
    expect(result.remote).toContain('confluence-baseline');
    expect(JSON.stringify(result)).not.toContain('initial-create-token-secret');
  });

  it('reuses an existing repo without creating', async () => {
    const ns = new FakeNamespace();
    ns.repos.set('confluence-baseline', new FakeRepo({ name: 'confluence-baseline', remote: 'https://artifacts.example.com/confluence-baseline.git', defaultBranch: 'main' }));
    const adapter = new ArtifactsAdapter({ artifacts: ns, repoName: 'confluence-baseline' });
    const result = await adapter.ensureRepo();
    expect(ns.createCalls).toBe(0);
    expect(result.created).toBe(false);
  });

  it('disposes the repo handle after every operation', async () => {
    const ns = new FakeNamespace();
    const repo = new FakeRepo({ name: 'r', remote: 'remote', defaultBranch: 'main' });
    ns.repos.set('r', repo);
    const adapter = new ArtifactsAdapter({ artifacts: ns, repoName: 'r' });
    await adapter.info();
    await adapter.mintToken('read', 600);
    await adapter.readFileText('main', 'README.md');
    await adapter.log(10);
    expect(repo.disposed).toBe(true);
  });

  it('mints scoped tokens and redaction never reveals the plaintext', async () => {
    const ns = new FakeNamespace();
    const repo = new FakeRepo({ name: 'r', remote: 'remote', defaultBranch: 'main' });
    ns.repos.set('r', repo);
    const adapter = new ArtifactsAdapter({ artifacts: ns, repoName: 'r' });
    const token = await adapter.mintToken('read', 600);
    expect(repo.createTokenCalls).toBe(1);
    expect(token.scope).toBe('read');
    const redacted = redactToken(token);
    expect(redacted.hint).not.toContain('secret');
    expect(redacted.hint.startsWith('git-')).toBe(true);
    expect(redacted.expiresAt).toBe(token.expiresAt);
  });

  it('forks with options and strips the fork token from the result', async () => {
    const ns = new FakeNamespace();
    const repo = new FakeRepo({ name: 'r', remote: 'remote', defaultBranch: 'main' });
    ns.repos.set('r', repo);
    const adapter = new ArtifactsAdapter({ artifacts: ns, repoName: 'r' });
    const forked = await adapter.fork('task-1-scratch', { description: 'task scratch', defaultBranchOnly: true });
    expect(repo.forkCalls).toBe(1);
    expect(forked.name).toBe('task-1-scratch');
    expect(JSON.stringify(forked)).not.toContain('initial-fork-token-secret');
  });

  it('reads file text and returns null for missing paths', async () => {
    const ns = new FakeNamespace();
    const repo = new FakeRepo({ name: 'r', remote: 'remote', defaultBranch: 'main' }, new Map([['src/index.ts', 'export {};\n']]));
    ns.repos.set('r', repo);
    const adapter = new ArtifactsAdapter({ artifacts: ns, repoName: 'r' });
    expect(await adapter.readFileText('main', 'src/index.ts')).toBe('export {};\n');
    expect(await adapter.readFileText('main', 'missing.ts')).toBeNull();
  });

  it('fails closed on remote merge and performs no repo calls', async () => {
    const ns = new FakeNamespace();
    const repo = new FakeRepo({ name: 'r', remote: 'remote', defaultBranch: 'main' });
    ns.repos.set('r', repo);
    const adapter = new ArtifactsAdapter({ artifacts: ns, repoName: 'r' });
    await expect(adapter.mergeIntoRemote({ 'a.txt': 'x' })).rejects.toMatchObject({
      name: 'RemoteMergeUnavailableError',
      code: REMOTE_MERGE_UNAVAILABLE,
    });
    expect(repo.forkCalls).toBe(0);
    expect(repo.createTokenCalls).toBe(0);
    expect(ns.createCalls).toBe(0);
  });

  it('maps an unavailable repo to RepoNotFoundError with code', async () => {
    const ns = new FakeNamespace();
    const adapter = new ArtifactsAdapter({ artifacts: ns, repoName: 'ghost' });
    await expect(adapter.info()).rejects.toMatchObject({ code: 'repo_not_found' });
  });

  it('documents the merge boundary as a thrown error type', () => {
    const err = new RemoteMergeUnavailableError();
    expect(err instanceof RemoteMergeUnavailableError).toBe(true);
    expect(err.message).toContain('no merge or write API');
  });

  it('does not create a replacement repo on transient or permission failures', async () => {
    const ns = new FakeNamespace();
    const fault = new Error('temporary backend outage');
    ns.get = async () => { throw fault; };
    const adapter = new ArtifactsAdapter({ artifacts: ns, repoName: 'r' });
    await expect(adapter.ensureRepo()).rejects.toBe(fault);
    await expect(adapter.info()).rejects.toBe(fault);
    expect(ns.createCalls).toBe(0);
  });

  it('preserves metadata lookup failures and disposes only after RPC completes', async () => {
    const ns = new FakeNamespace();
    const repo = new FakeRepo({ name: 'r', remote: 'remote', defaultBranch: 'main' });
    ns.repos.set('r', repo);
    const adapter = new ArtifactsAdapter({ artifacts: ns, repoName: 'r' });
    repo.info = async () => {
      await new Promise(resolve => setTimeout(resolve, 5));
      expect(repo.disposed).toBe(false);
      throw new Error('metadata unavailable');
    };
    await expect(adapter.ensureRepo()).rejects.toThrow('metadata unavailable');
    expect(ns.createCalls).toBe(0);
    expect(repo.disposed).toBe(true);
    repo.disposed = false;
    await expect(adapter.info()).rejects.toThrow('metadata unavailable');
    expect(repo.disposed).toBe(true);
  });
});
