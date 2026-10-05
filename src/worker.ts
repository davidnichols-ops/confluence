// Confluence Worker: persisted Durable Object coordinator on the shared core
// state machine, authenticated API, Artifacts adapter routes, static asset UI.
//
// Platform status: real code path, labeled UNVERIFIED until executed on the
// Cloudflare platform (local prototype runs without credentials per BUILD_SPEC).

import { applyAction, createState, DomainError } from './core';
import { DurableObject } from 'cloudflare:workers';
import type { Action, Role, State } from './contracts';
import { authorize, type Credentials } from './auth';
import {
  ArtifactsAdapter,
  RepoNotFoundError,
  REMOTE_MERGE_UNAVAILABLE,
  type ArtifactsNamespace,
} from './artifacts';

export interface Env extends Credentials {
  COORDINATOR: DurableObjectNamespace<Coordinator>;
  ARTIFACTS: Artifacts;
  COORDINATOR_TOKEN?: string;
  RUNNER_TOKEN?: string;
  HUMAN_TOKEN?: string;
  ARTIFACTS_REPO?: string;
}

const STATE_KEY = 'state';
type ApplyResult =
  | { ok: true; state: State }
  | { ok: false; code: string; message: string };

// Durable Object extending the runtime base class so RPC method calls work.
export class Coordinator extends DurableObject<Env> {
  private readonly store: DurableObjectStorage;
  private readonly doState: DurableObjectState;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.store = state.storage;
    this.doState = state;
  }

  async getState(): Promise<State | null> {
    return (await this.store.get<State>(STATE_KEY)) ?? null;
  }

  async apply(action: Action): Promise<ApplyResult> {
    return this.doState.blockConcurrencyWhile(async () => {
      const current = (await this.store.get<State>(STATE_KEY)) ?? createState();
      try {
        const next = await applyAction(current, action);
        await this.store.put(STATE_KEY, next);
        return { ok: true as const, state: next };
      } catch (err) {
        if (err instanceof DomainError) {
          return { ok: false as const, code: err.code, message: err.message };
        }
        return {
          ok: false as const,
          code: 'internal_error',
          message: err instanceof Error ? err.message : String(err),
        };
      }
    });
  }
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get('Authorization');
  if (!header || !header.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

type AuthResult =
  | { ok: true; role: Role }
  | { ok: false; status: number; code: string; message: string };

// Server-side authority injection: the API client supplies actor.id only.
// The role is decided by which server token authenticated the request, so an
// API client can never self-assign 'runner' or 'human'. If the required token
// is not configured, the action fails closed.
function authorizeWrite(request: Request, env: Env, action: Action) {
  return authorize(request, env, action.type);
}

// Artifacts routes mutate platform resources or mint credentials, so they
// always require the coordinator token, even when other writes would be open.
function authorizeArtifacts(request: Request, env: Env): AuthResult {
  if (!env.COORDINATOR_TOKEN) {
    return {
      ok: false,
      status: 403,
      code: 'coordinator_token_not_configured',
      message: 'artifacts routes require COORDINATOR_TOKEN to be configured; failing closed',
    };
  }
  const token = bearerToken(request);
  if (!token || !constantTimeEqual(token, env.COORDINATOR_TOKEN)) {
    return { ok: false, status: 401, code: 'unauthorized', message: 'coordinator token required' };
  }
  return { ok: true, role: 'agent' };
}

function json(body: unknown, status: number, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...extraHeaders },
  });
}

function errorStatus(code: string): number {
  return 409;
}

function adapterFor(env: Env): ArtifactsAdapter {
  return new ArtifactsAdapter({ artifacts: env.ARTIFACTS, repoName: env.ARTIFACTS_REPO || 'confluence-baseline', description: 'Confluence baseline tree' });
}

async function handleArtifacts(request: Request, env: Env, url: URL): Promise<Response> {
  const auth = authorizeArtifacts(request, env);
  if (!auth.ok) return json({ error: auth.message, code: auth.code }, auth.status);
  const adapter = adapterFor(env);
  const route = url.pathname;
  try {
    if (request.method === 'GET' && route === '/api/artifacts/info') {
      return json(await adapter.info(), 200);
    }
    if (request.method === 'GET' && route === '/api/artifacts/log') {
      return json(await adapter.log(50), 200);
    }
    if (request.method === 'GET' && route === '/api/artifacts/file') {
      const ref = url.searchParams.get('ref') ?? 'main';
      const path = url.searchParams.get('path');
      if (!path) return json({ error: 'path query parameter required', code: 'invalid_input' }, 400);
      const text = await adapter.readFileText(ref, path);
      return text === null ? json({ error: 'file not found', code: 'not_found' }, 404) : json({ ref, path, text }, 200);
    }
    if (request.method === 'POST' && route === '/api/artifacts/ensure') {
      return json(await adapter.ensureRepo(), 200);
    }
    if (request.method === 'POST' && route === '/api/artifacts/token') {
      let body: { scope?: string; ttl?: number } = {};
      try {
        body = (await request.json()) as { scope?: string; ttl?: number };
      } catch {
        return json({error:'Invalid token request JSON',code:'invalid_input'},400);
      }
      if (body.scope !== 'read' && body.scope !== 'write') return json({error:'scope must be read or write',code:'invalid_input'},400);
      const scope = body.scope;
      const requested = typeof body.ttl === 'number' && Number.isFinite(body.ttl) ? Math.floor(body.ttl) : 3600;
      const ttl = Math.min(Math.max(requested, 60), 86400);
      const minted = await adapter.mintToken(scope, ttl);
      return json(
        { id: minted.id, plaintext: minted.plaintext, expiresAt: minted.expiresAt, scope, ttl },
        200,
        { 'cache-control': 'no-store' },
      );
    }
    if (request.method === 'POST' && route === '/api/artifacts/token/revoke') {
      let body: { tokenOrId?: string } = {};
      try {
        body = (await request.json()) as { tokenOrId?: string };
      } catch {
        return json({ error: 'Invalid revoke request JSON', code: 'invalid_input' }, 400);
      }
      if (!body.tokenOrId || typeof body.tokenOrId !== 'string') {
        return json({ error: 'tokenOrId required', code: 'invalid_input' }, 400);
      }
      return json({ revoked: await adapter.revokeToken(body.tokenOrId) }, 200, { 'cache-control': 'no-store' });
    }
    if (request.method === 'POST' && route === '/api/artifacts/fork') {
      let body: { name?: string; description?: string } = {};
      try {
        body = (await request.json()) as { name?: string; description?: string };
      } catch {
        body = {};
      }
      if (!body.name || typeof body.name !== 'string') {
        return json({ error: 'name required', code: 'invalid_input' }, 400);
      }
      const forked = await adapter.fork(body.name, { description: body.description, defaultBranchOnly: true });
      return json(forked, 200);
    }
    if (request.method === 'POST' && route === '/api/artifacts/merge') {
      return json(
        {
          error: 'remote merge unavailable: the Artifacts binding exposes no merge or write API; integration runs through the coordinator state machine and agents push via git with minted tokens',
          code: REMOTE_MERGE_UNAVAILABLE,
        },
        501,
      );
    }
    return json({ error: 'unknown artifacts route', code: 'not_found' }, 404);
  } catch (err) {
    if (err instanceof RepoNotFoundError) {
      return json({ error: err.message, code: err.code }, 404);
    }
    return json(
      { error: err instanceof Error ? err.message : String(err), code: 'artifacts_error' },
      502,
    );
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === 'POST' && !request.headers.get('content-type')?.startsWith('application/json')) return json({error:'Content-Type must be application/json'},415);
    if (request.method === 'POST' && (await request.clone().arrayBuffer()).byteLength > 262144) return json({error:'Request exceeds 256 KiB'},413);

    if (!path.startsWith('/api/')) {
      // Static assets serve the UI for matching paths; unmatched paths land here.
      return json({ error: 'not found', code: 'not_found' }, 404);
    }

    const coordinator = env.COORDINATOR.get(env.COORDINATOR.idFromName('global'));

    if (request.method === 'GET' && path === '/api/state') {
      const auth = authorize(request, env, 'read_state');
      if (!auth.ok) return json({ error: auth.message, code: auth.code }, auth.status, { 'cache-control': 'no-store' });
      const state = await coordinator.getState();
      return json({ ...(state ?? createState()), mode: 'cloudflare' }, 200, { 'cache-control': 'no-store' });
    }

    if (request.method === 'POST' && path === '/api/demo') {
      return json(
        {
          error: 'the deterministic demo runs on the local server only; this Worker does not simulate it',
          code: 'demo_unavailable_on_worker',
        },
        501,
      );
    }

    if (request.method === 'POST' && path === '/api/actions') {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return json({ error: 'invalid JSON body', code: 'invalid_json' }, 400);
      }
      const action = (body as {action?: Action})?.action;
      if (!action || typeof action !== 'object' || typeof action.type !== 'string') {
        return json({ error: 'action with a string type is required', code: 'invalid_action' }, 400);
      }
      const auth = authorizeWrite(request, env, action);
      if (!auth.ok) return json({ error: auth.message, code: auth.code }, auth.status);
      let serverAction: Action;
      if (action.type === 'integrate') {
        const input = action as Action & {ref?:string;expectedHead?:string};
        let ref = input.ref;
        let expectedHead = input.expectedHead;
        if (!ref || !expectedHead) {
          const adapter = adapterFor(env);
          const [info, commits] = await Promise.all([adapter.info(), adapter.log(1)]);
          ref = `refs/heads/${info.defaultBranch}`;
          expectedHead = commits[0]?.hash ?? '0'.repeat(40);
        }
        serverAction = {type:'reserve_publication',ref,expectedHead,actor:auth.actor};
      } else serverAction = { ...action, actor: auth.actor } as Action;
      const result = await coordinator.apply(serverAction);
      if (!result.ok) {
        const status = result.code === 'internal_error' ? 500 : errorStatus(result.code);
        return json({ error: result.message, code: result.code }, status);
      }
      return json({ ...result.state, mode: 'cloudflare' }, 200);
    }

    if (request.method === 'POST' && path === '/api/publications/complete') {
      const auth = authorize(request, env, 'record_publication');
      if (!auth.ok) return json({error:auth.message,code:auth.code},auth.status);
      let receipt: unknown;
      try { receipt = (await request.json() as {receipt?:unknown}).receipt; } catch { return json({error:'invalid JSON body',code:'invalid_json'},400); }
      const result = await coordinator.apply({type:'record_publication',receipt,actor:auth.actor} as Action);
      return result.ok ? json({...result.state,mode:'cloudflare'},200) : json({error:result.message,code:result.code},result.code==='internal_error'?500:409);
    }

    if (path.startsWith('/api/artifacts/')) {
      return handleArtifacts(request, env, url);
    }

    return json({ error: 'not found', code: 'not_found' }, 404);
  },
};
