import type { Action, Actor, Context, Event, Files, Patch, Role, State, Task } from './contracts';

export class DomainError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'DomainError';
  }
}

const ROLES: Role[] = ['agent', 'runner', 'human'];

function req(cond: boolean, code: string, msg: string): void {
  if (!cond) throw new DomainError(code, msg);
}

function str(v: unknown, code: string, name: string): string {
  if (typeof v !== 'string' || v.length === 0) throw new DomainError(code, `${name} must be a non-empty string`);
  return v;
}

function filesOf(v: unknown, code: string): Files {
  req(typeof v === 'object' && v !== null && !Array.isArray(v) && Object.values(v).every((c) => typeof c === 'string'), code, 'expected a record of path to string content');
  return { ...(v as Files) };
}

function contextOf(v: unknown): Context {
  const c = v as Record<string, unknown>;
  req(typeof c === 'object' && c !== null, 'invalid_context', 'context must be an object');
  req(Array.isArray(c.notes) && c.notes.every((n) => typeof n === 'string'), 'invalid_context', 'context.notes must be a string array');
  return { summary: str(c.summary, 'invalid_context', 'context.summary'), nextStep: str(c.nextStep, 'invalid_context', 'context.nextStep'), notes: [...(c.notes as string[])] };
}

function patchOf(v: unknown): Patch {
  const p = v as Record<string, unknown>;
  req(typeof p === 'object' && p !== null, 'invalid_patch', 'patch must be an object');
  req(p.before === null || typeof p.before === 'string', 'invalid_patch', 'patch.before must be string or null');
  req(p.after === null || typeof p.after === 'string', 'invalid_patch', 'patch.after must be string or null');
  const before = p.before as string | null;
  const after = p.after as string | null;
  const path = str(p.path, 'invalid_patch', 'patch.path');
  req(before !== after, 'invalid_patch', 'patch.before and patch.after must differ');
  return { path, before, after };
}

function actorOf(v: unknown): Actor {
  const a = v as Record<string, unknown>;
  req(typeof a === 'object' && a !== null, 'invalid_actor', 'actor must be an object');
  const id = str(a.id, 'invalid_actor', 'actor.id');
  req(ROLES.includes(a.role as Role), 'invalid_actor', 'actor.role must be agent, runner or human');
  return { id, role: a.role as Role };
}

export async function treeHash(files: Files): Promise<string> {
  const canonical = JSON.stringify(Object.keys(files).sort().map((k) => [k, files[k]]));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function createState(files?: Files): State {
  return { mode: 'local', objective: '', baseline: filesOf(files ?? {}, 'invalid_files'), revision: 0, tasks: [], events: [] };
}

export async function applyAction(state: State, action: Action): Promise<State> {
  req(typeof state === 'object' && state !== null, 'invalid_state', 'state required');
  req(typeof state.objective === 'string' && typeof state.revision === 'number' && Array.isArray(state.tasks) && Array.isArray(state.events), 'invalid_state', 'state shape invalid');
  filesOf(state.baseline, 'invalid_state');
  const a = action as unknown as Record<string, unknown>;
  req(typeof a === 'object' && a !== null, 'invalid_action', 'action required');
  const act = actorOf(a.actor);
  const base: State = {
    ...state,
    baseline: { ...state.baseline },
    tasks: state.tasks.map((t) => ({ ...t, paths: [...t.paths], baseFiles: { ...t.baseFiles }, context: { ...t.context, notes: [...t.context.notes] }, patches: [...t.patches] })),
    events: [...state.events],
  };
  if (base.candidate) {
    const c = base.candidate;
    base.candidate = { ...c, files: { ...c.files }, taskIds: [...c.taskIds], evidence: c.evidence ? { ...c.evidence } : undefined, approval: c.approval ? { ...c.approval } : undefined };
  }
  const task = (id: unknown): Task => {
    const t = base.tasks.find((x) => x.id === id);
    if (!t) throw new DomainError('unknown_task', `unknown task ${String(id)}`);
    return t;
  };
  const ev = (type: string, message: string): Event => ({ sequence: (base.events.at(-1)?.sequence ?? 0) + 1, type, actor: act.id, message });
  const agentOnly = () => req(act.role === 'agent', 'forbidden', `action requires an agent (got ${act.role})`);
  const owned = (t: Task) => req(t.agent === act.id, 'not_owner', `task ${t.id} belongs to ${t.agent}`);
  switch (a.type) {
    case 'create_objective': {
      req(act.role === 'human', 'forbidden', 'only a human can create an objective');
      req(!state.objective, 'already_initialized', 'objective already exists');
      const objective = str(a.objective, 'invalid_objective', 'objective');
      base.objective = objective;
      base.events.push(ev('create_objective', `objective set: ${objective}`));
      return base;
    }
    case 'create_task': {
      req(act.role === 'agent' || act.role === 'human', 'forbidden', 'task creation requires an agent or human');
      const id = str(a.id, 'invalid_task', 'task id');
      req(!base.tasks.some((t) => t.id === id), 'duplicate_task_id', `task ${id} already exists`);
      const agent = str(a.agent, 'invalid_task', 'task agent');
      req(act.role === 'human' || agent === act.id, 'forbidden', 'agents can only create tasks for themselves');
      req(Array.isArray(a.paths) && a.paths.every((p) => typeof p === 'string' && p.length > 0), 'invalid_task', 'task paths must be non-empty strings');
      base.tasks.push({
        id,
        title: str(a.title, 'invalid_task', 'task title'),
        agent,
        intent: str(a.intent, 'invalid_task', 'task intent'),
        paths: [...new Set(a.paths as string[])],
        baseRevision: state.revision,
        baseFiles: { ...state.baseline },
        status: 'working',
        context: { summary: '', nextStep: '', notes: [] },
        patches: [],
      });
      base.events.push(ev('create_task', `task ${id} created for ${agent}`));
      return base;
    }
    case 'checkpoint': {
      agentOnly();
      const t = task(a.taskId);
      owned(t);
      req(t.status !== 'integrated', 'already_integrated', `task ${t.id} is integrated`);
      t.context = contextOf(a.context);
      base.events.push(ev('checkpoint', `task ${t.id} checkpoint saved`));
      return base;
    }
    case 'propose': {
      agentOnly();
      const t = task(a.taskId);
      owned(t);
      req(t.status !== 'integrated', 'already_integrated', `task ${t.id} is integrated`);
      if (!Array.isArray(a.patches) || a.patches.length === 0) throw new DomainError('invalid_patches', 'patches must be a non-empty array');
      const patches = (a.patches as unknown[]).map(patchOf);
      const seen = new Set<string>();
      for (const p of patches) {
        req(!seen.has(p.path), 'duplicate_path', `duplicate patch path ${p.path}`);
        seen.add(p.path);
        req(p.before === (t.baseFiles[p.path] ?? null), 'precondition_failed', `patch precondition failed for ${p.path}`);
      }
      t.patches = patches;
      t.status = 'proposed';
      const prior = base.candidate ? `; prior candidate ${base.candidate.treeHash.slice(0, 8)} invalidated` : '';
      base.candidate = undefined;
      base.events.push(ev('propose', `task ${t.id} proposed ${patches.length} patch(es)${prior}`));
      return base;
    }
    case 'assemble': {
      req(act.role === 'agent' || act.role === 'human', 'forbidden', 'assemble requires an agent or human');
      if (!Array.isArray(a.taskIds) || a.taskIds.length === 0) throw new DomainError('invalid_assemble', 'taskIds must be a non-empty array');
      const ids = a.taskIds as string[];
      req(new Set(ids).size === ids.length, 'duplicate_task', 'duplicate taskIds in assemble');
      const tasks = ids.map(task);
      const claimed = new Set<string>();
      for (const t of tasks) {
        req(t.status === 'proposed', t.status === 'integrated' ? 'already_integrated' : 'not_proposed', `task ${t.id} has no active proposal`);
        req(t.baseRevision === state.revision, 'stale_base', `task ${t.id} base revision ${t.baseRevision} is stale (current ${state.revision})`);
        for (const p of t.patches) {
          req(!claimed.has(p.path), 'path_conflict', `path ${p.path} is patched by multiple tasks`);
          claimed.add(p.path);
        }
      }
      const files: Files = { ...state.baseline };
      for (const t of tasks) {
        for (const p of t.patches) {
          req(p.before === (files[p.path] ?? null), 'precondition_failed', `patch precondition failed for ${p.path}`);
          if (p.after === null) delete files[p.path];
          else files[p.path] = p.after;
        }
      }
      base.candidate = { treeHash: await treeHash(files), baseRevision: state.revision, files, taskIds: ids };
      base.events.push(ev('assemble', `candidate ${base.candidate.treeHash.slice(0, 8)} assembled from [${ids.join(', ')}]`));
      return base;
    }
    case 'record_evidence': {
      req(act.role === 'runner', 'forbidden', 'only the trusted runner records evidence');
      const c = base.candidate;
      if (!c) throw new DomainError('no_candidate', 'no candidate to evidence');
      const e = a.evidence as Record<string, unknown>;
      if (typeof e !== 'object' || e === null) throw new DomainError('invalid_evidence', 'evidence must be an object');
      const hash = str(e.treeHash, 'invalid_evidence', 'evidence.treeHash');
      if (typeof e.passed !== 'boolean') throw new DomainError('invalid_evidence', 'evidence.passed must be a boolean');
      if (!Array.isArray(e.checks) || !e.checks.every((x) => typeof x === 'string')) throw new DomainError('invalid_evidence', 'evidence.checks must be a string array');
      req(hash === c.treeHash, 'hash_mismatch', 'evidence tree hash does not match candidate');
      c.evidence = { treeHash: hash, passed: e.passed, checks: [...(e.checks as string[])], runner: act.id };
      base.events.push(ev('record_evidence', `evidence ${c.evidence.passed ? 'passed' : 'failed'} for ${c.treeHash.slice(0, 8)}`));
      return base;
    }
    case 'approve': {
      req(act.role === 'human', 'forbidden', 'only a human can approve');
      const c = base.candidate;
      if (!c) throw new DomainError('no_candidate', 'no candidate to approve');
      req(!!c.evidence && c.evidence.passed, 'no_evidence', 'candidate has no passing evidence');
      const hash = str(a.treeHash, 'invalid_approve', 'treeHash');
      req(hash === c.treeHash, 'hash_mismatch', 'approval hash does not match candidate');
      c.approval = { treeHash: c.treeHash, human: act.id };
      base.events.push(ev('approve', `candidate ${c.treeHash.slice(0, 8)} approved by ${act.id}`));
      return base;
    }
    case 'integrate': {
      req(act.role === 'human', 'forbidden', 'only a human can integrate');
      const c = base.candidate;
      if (!c) throw new DomainError('no_candidate', 'no candidate to integrate');
      req(!!c.evidence && c.evidence.passed, 'no_evidence', 'integration requires passing evidence');
      req(c.evidence!.treeHash === c.treeHash, 'hash_mismatch', 'integration evidence hash does not match candidate');
      req(!!c.approval && c.approval.treeHash === c.treeHash, 'no_approval', 'integration requires approval matching the candidate hash');
      req(c.baseRevision === state.revision, 'stale_base', 'candidate baseline revision is stale');
      req((await treeHash(c.files)) === c.treeHash, 'hash_mismatch', 'candidate files do not match candidate hash');
      base.baseline = { ...c.files };
      base.revision = state.revision + 1;
      base.tasks = base.tasks.map((t) => (c.taskIds.includes(t.id) ? { ...t, status: 'integrated' as const } : t));
      base.candidate = undefined;
      base.events.push(ev('integrate', `candidate ${c.treeHash.slice(0, 8)} integrated; baseline revision ${base.revision}`));
      return base;
    }
    default:
      throw new DomainError('invalid_action', `unknown action type ${String(a.type)}`);
  }
}
