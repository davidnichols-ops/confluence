import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { applyAction, createState, DomainError } from './core.js';
import { fixtureFiles, runDemo, validateCandidate } from './demo.js';
import { validateWithGit } from './local-git-validator.js';
import type { Action, State } from './contracts.js';

const port = Number(process.env.PORT ?? 8787);
const store = resolve('.local/state.json');
const token = process.env.CONFLUENCE_TOKEN;
let state: State;
try { state = JSON.parse(await readFile(store, 'utf8')) as State; }
catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  state = createState(fixtureFiles);
}

async function persist(next: State) {
  await mkdir(dirname(store), { recursive: true });
  const temporary = `${store}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(next, null, 2), { mode: 0o600 });
  await rename(temporary, store);
  state = next;
}
let queue: Promise<unknown> = Promise.resolve();
function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const next = queue.then(operation);
  queue = next.catch(() => undefined);
  return next;
}
function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
}
async function body(req: IncomingMessage): Promise<unknown> {
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 262144) throw new Error('Request exceeds 256 KiB');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function authorized(req: IncomingMessage): boolean {
  if (!token) return true;
  const supplied = Buffer.from(req.headers.authorization ?? '');
  const expected = Buffer.from(`Bearer ${token}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

createServer(async (req, res) => {
  try {
    // Restrict Host and Origin to the local listener, including DNS rebinding.
    const validHosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
    if (!validHosts.has(req.headers.host ?? '')) return json(res, 403, { error: 'Invalid Host' });
    if (req.headers.origin && ![...validHosts].some(host => req.headers.origin === `http://${host}`)) {
      return json(res, 403, { error: 'Cross-origin requests are refused' });
    }
    const path = new URL(req.url ?? '/', `http://localhost:${port}`).pathname;
    if (req.method === 'GET' && path === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      return res.end(await readFile(resolve('public/index.html')));
    }
    if (!authorized(req)) return json(res, 401, { error: 'Bearer token required' });
    if (req.method === 'GET' && path === '/api/state') return json(res, 200, state);
    if (req.method === 'POST' && !req.headers['content-type']?.startsWith('application/json')) {
      return json(res, 415, { error: 'Content-Type must be application/json' });
    }
    if (req.method === 'POST' && path === '/api/demo') {
      const result = await serialize(async () => { const demo = await runDemo(validateWithGit); await persist(demo.state); return demo; });
      return json(res, 200, result);
    }
    if (req.method === 'POST' && path === '/api/validate') {
      return json(res, 200, await serialize(async () => {
        if (!state.candidate) throw new Error('Assemble a candidate first');
        const checked = await validateWithGit(state.baseline, state.candidate.files);
        const next = await applyAction(state, {
          type: 'record_evidence', actor: { id: 'local-fixture-runner', role: 'runner' },
          evidence: { treeHash: state.candidate.treeHash, ...checked }
        });
        await persist(next); return next;
      }));
    }
    if (req.method === 'POST' && path === '/api/actions') {
      const input = await body(req) as { action?: Action };
      if (!input || !input.action || typeof input.action !== 'object') return json(res, 400, { error: 'action is required' });
      if (input.action.type === 'record_evidence') return json(res, 403, { error: 'Evidence must come from the trusted runner endpoint' });
      const next = await serialize(async () => {
        const action = structuredClone(input.action!);
        // This listener is a local human console. Remote agent clients require
        // separate scoped credentials in the Cloudflare deployment.
        const human = ['create_objective', 'create_task', 'assemble', 'approve', 'integrate'].includes(action.type);
        action.actor = { id: human ? 'local-human' : String(action.actor?.id ?? 'local-agent'), role: human ? 'human' : 'agent' };
        const result = await applyAction(state, action);
        await persist(result); return result;
      });
      return json(res, 200, next);
    }
    return json(res, 404, { error: 'Route not found' });
  } catch (error) {
    const status = error instanceof DomainError ? 409 : 400;
    json(res, status, { error: error instanceof Error ? error.message : 'Request failed', code: error instanceof DomainError ? error.code : 'BAD_REQUEST' });
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`Confluence local prototype: http://127.0.0.1:${port}`);
  console.log('Local fixture execution; Cloudflare Artifacts has not been exercised.');
});
