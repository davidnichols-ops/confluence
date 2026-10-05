import type { Files } from './contracts';

// Minimal structural types for the Cloudflare Artifacts Workers binding.
// Source of truth: https://developers.cloudflare.com/artifacts/api/workers-binding/
// (checked 2026-10-04, wrangler 4.147.0). Worker env uses generated types;
// these minimal structural types also support test fixtures without Cloudflare.

export interface ArtifactsCreateRepoResult {
  name: string;
  remote: string;
  defaultBranch: string;
  token?: string;
}

export interface ArtifactsRepoInfo {
  name: string;
  remote: string;
  defaultBranch: string;
  status?: string;
  readOnly?: boolean;
  description?: string | null;
}

export interface ArtifactsCreateTokenResult {
  plaintext: string;
  expiresAt: string;
  id?: string;
  scope?: 'read' | 'write';
}

export interface ArtifactsTokenSummary {
  id?: string;
  scope?: string;
  expiresAt?: string;
}

export interface ArtifactsTokenListResult {
  total: number;
  tokens: ArtifactsTokenSummary[];
}

export interface ArtifactsCommitMetadata {
  hash: string;
  message?: string;
  author?: { name: string; email: string };
  timestamp?: string;
  tree?: string;
  parents?: string[];
}

export interface ArtifactsTreeEntry {
  path?: string;
  name?: string;
  mode?: string;
  type?: string;
  hash: string;
}

export interface ArtifactsRepoListResult {
  repos: Array<{ name: string; status?: string }>;
  cursor?: string;
}

export interface ArtifactsRepo extends Disposable {
  info(): Promise<ArtifactsRepoInfo>;
  createToken(scope?: 'read' | 'write', ttlSeconds?: number): Promise<ArtifactsCreateTokenResult>;
  listTokens(): Promise<ArtifactsTokenListResult>;
  revokeToken(tokenOrId: string): Promise<boolean>;
  fork(
    name: string,
    opts?: { description?: string; readOnly?: boolean; defaultBranchOnly?: boolean },
  ): Promise<ArtifactsCreateRepoResult>;
  log(opts?: { ref?: string; limit?: number; offset?: number }): Promise<ArtifactsCommitMetadata[]>;
  readCommit(hash: string): Promise<ArtifactsCommitMetadata | null>;
  readTree(hash: string): Promise<ArtifactsTreeEntry[] | null>;
  readBlob(hash: string): Promise<Blob | null>;
  readFile(args: { ref: string; path: string }): Promise<Blob | null>;
}

export interface ArtifactsNamespace {
  create(
    name: string,
    opts?: { readOnly?: boolean; description?: string; setDefaultBranch?: string },
  ): Promise<ArtifactsCreateRepoResult>;
  get(name: string): Promise<ArtifactsRepo>;
  list(opts?: { limit?: number; cursor?: string }): Promise<ArtifactsRepoListResult>;
  import(params: {
    source: { url: string; branch?: string; depth?: number };
    target: { name: string; opts?: { description?: string; readOnly?: boolean } };
  }): Promise<ArtifactsCreateRepoResult>;
  delete(name: string): Promise<boolean>;
}

export const REMOTE_MERGE_UNAVAILABLE = 'remote_merge_unavailable';
export const REPO_NOT_FOUND = 'repo_not_found';

export class RemoteMergeUnavailableError extends Error {
  readonly code = REMOTE_MERGE_UNAVAILABLE;
  constructor(message?: string) {
    super(
      message ??
        'remote merge unavailable: the Artifacts binding exposes no merge or write API; integration is performed by the coordinator state machine and agents push via git with minted tokens',
    );
    this.name = 'RemoteMergeUnavailableError';
  }
}

export class RepoNotFoundError extends Error {
  readonly code = REPO_NOT_FOUND;
  constructor(message?: string) {
    super(message ?? 'artifacts repo not found');
    this.name = 'RepoNotFoundError';
  }
}

export interface RedactedToken {
  hint: string;
  expiresAt: string;
}

export function redactToken(token: { plaintext: string; expiresAt: string }): RedactedToken {
  const hint = token.plaintext.length <= 4 ? '****' : `${token.plaintext.slice(0, 4)}...`;
  return { hint, expiresAt: token.expiresAt };
}

export interface ArtifactsAdapterOptions {
  artifacts: ArtifactsNamespace;
  repoName: string;
  description?: string;
}

export interface EnsureRepoResult {
  name: string;
  remote: string;
  defaultBranch: string;
  created: boolean;
}

export class ArtifactsAdapter {
  private readonly artifacts: ArtifactsNamespace;
  readonly repoName: string;
  private readonly description?: string;

  constructor(options: ArtifactsAdapterOptions) {
    this.artifacts = options.artifacts;
    this.repoName = options.repoName;
    this.description = options.description;
  }

  async ensureRepo(): Promise<EnsureRepoResult> {
    let handle: ArtifactsRepo;
    try {
      handle = await this.getRepo();
    } catch (err) {
      // Wrangler's remote RPC proxy currently strips ArtifactsError.code.
      // Never infer absence from its message: independently list the namespace.
      const proxy = err as { remote?: unknown; code?: unknown };
      if (!(err instanceof RepoNotFoundError) && !(proxy.remote === true && proxy.code === undefined && await this.confirmAbsent())) throw err;
      const created = await this.artifacts.create(this.repoName, {
        description: this.description,
        setDefaultBranch: 'main',
      });
      await this.revokeBootstrapToken(created.name, created.token);
      return { name: created.name, remote: created.remote, defaultBranch: created.defaultBranch, created: true };
    }
    using repo = handle;
    const info = await repo.info();
    return { name: info.name, remote: info.remote, defaultBranch: info.defaultBranch, created: false };
  }

  async info(): Promise<ArtifactsRepoInfo> {
    using repo = await this.getRepo();
    return await repo.info();
  }

  async mintToken(scope: 'read' | 'write', ttlSeconds: number): Promise<ArtifactsCreateTokenResult> {
    using repo = await this.getRepo();
    return await repo.createToken(scope, ttlSeconds);
  }

  async revokeToken(tokenOrId: string): Promise<boolean> {
    using repo = await this.getRepo();
    return await repo.revokeToken(tokenOrId);
  }

  async fork(newName: string, opts?: { description?: string; readOnly?: boolean; defaultBranchOnly?: boolean }): Promise<ArtifactsCreateRepoResult> {
    using repo = await this.getRepo();
    const forked = await repo.fork(newName, opts);
    await this.revokeBootstrapToken(forked.name, forked.token);
    return { name: forked.name, remote: forked.remote, defaultBranch: forked.defaultBranch };
  }

  async readFileText(ref: string, path: string): Promise<string | null> {
    using repo = await this.getRepo();
    const file = await repo.readFile({ ref, path });
    if (file === null) return null;
    return file.text();
  }

  async log(limit = 50): Promise<ArtifactsCommitMetadata[]> {
    using repo = await this.getRepo();
    return await repo.log({ limit });
  }

  async mergeIntoRemote(_files: Files, _baseRef?: string): Promise<never> {
    throw new RemoteMergeUnavailableError();
  }

  private async confirmAbsent(): Promise<boolean> {
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < 20; page++) {
      const result = await this.artifacts.list({ limit: 100, ...(cursor ? { cursor } : {}) });
      if (result.repos.some(repo => repo.name === this.repoName)) return false;
      if (!result.cursor) return true;
      if (seen.has(result.cursor)) throw new Error('Namespace listing did not advance; repository absence is unknown');
      seen.add(result.cursor);
      cursor = result.cursor;
    }
    throw new Error('Namespace listing exceeded verification bound; repository absence is unknown');
  }

  private async revokeBootstrapToken(repoName: string, token?: string): Promise<void> {
    if (!token) return;
    let repo: ArtifactsRepo;
    try {
      repo = await this.artifacts.get(repoName);
    } catch (err) {
      throw new Error(`created artifacts repo "${repoName}" but could not revoke its bootstrap token: ${err instanceof Error ? err.message : String(err)}`);
    }
    using disposable = repo;
    if (!(await disposable.revokeToken(token))) {
      throw new Error(`created artifacts repo "${repoName}" but its bootstrap token was not revoked`);
    }
  }

  private async getRepo(): Promise<ArtifactsRepo> {
    try {
      return await this.artifacts.get(this.repoName);
    } catch (err) {
      if ((err as { code?: string })?.code !== 'NOT_FOUND') throw err;
      throw new RepoNotFoundError(
        `artifacts repo "${this.repoName}" is unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
