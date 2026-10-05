import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { once } from 'node:events';

const project = resolve('.');
const port = 19000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${port}`;
let child: ChildProcess;
let directory: string;
async function start() {
  child = spawn(process.execPath, [resolve(project, 'node_modules/tsx/dist/cli.mjs'), resolve(project, 'src/server.ts')], {
    cwd: directory, env: { ...process.env, PORT: String(port), CONFLUENCE_TOKEN: 'test-console-token' }, stdio: ['ignore','pipe','pipe']
  });
  await new Promise<void>((accept, reject) => {
    const timeout = setTimeout(() => reject(new Error('server startup timeout')), 10000);
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`server exited ${code}`)); });
    child.stdout!.on('data', data => { if (data.toString().includes('local prototype:')) { clearTimeout(timeout); accept(); } });
    child.stderr!.on('data', data => { if (data.toString().includes('Error:')) { clearTimeout(timeout); reject(new Error(data.toString())); } });
  });
}
async function stop() {
  if (child.exitCode === null) { const ended = once(child, 'exit'); child.kill('SIGTERM'); await ended; }
}
async function request(path: string, value?: unknown, extra: Record<string,string> = {}) {
  return fetch(base + path, {
    method: value === undefined ? 'GET' : 'POST',
    headers: { 'Authorization': 'Bearer test-console-token', 'Content-Type': 'application/json', ...extra },
    body: value === undefined ? undefined : JSON.stringify(value)
  });
}
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'confluence-test-'));
  await mkdir(join(directory, 'public'));
  await copyFile(join(project, 'public/index.html'), join(directory, 'public/index.html'));
  await start();
}, 15000);
afterAll(async () => { if (child) await stop(); if (directory) await rm(directory, { recursive: true, force: true }); });

describe('local console actual HTTP boundary', () => {
  it('requires a token and rejects cross-origin mutation', async () => {
    expect((await fetch(base + '/api/state')).status).toBe(401);
    expect((await request('/api/demo', {}, { Origin: 'https://attacker.example' })).status).toBe(403);
  });
  it('does not accept agent-supplied passing evidence', async () => {
    expect((await request('/api/actions', { action: { type: 'record_evidence', actor: { role:'runner' }, evidence: { passed: true } } })).status).toBe(403);
  });
  it('executes the scenario and persists its result through a process restart', async () => {
    const response = await request('/api/demo', {});
    expect(response.status).toBe(200);
    const result = await response.json() as {state:{revision:number;tasks:unknown[]}; outcomes:{accepted:boolean}[]};
    expect(result.state.revision).toBeGreaterThan(0);
    expect(result.state.tasks.length).toBeGreaterThanOrEqual(3);
    expect(result.outcomes.some(outcome => !outcome.accepted)).toBe(true);
    await stop(); await start();
    expect(await (await request('/api/state')).json()).toEqual(result.state);
  });
  it('serializes concurrent task writes without lost updates or duplicate IDs', async () => {
    const action=(id:string)=>({action:{type:'create_task',id,title:id,agent:id,intent:'Concurrent test',paths:['config/service.json'],actor:{id,role:'agent'}}});
    const replies=await Promise.all(Array.from({length:6},(_,index)=>request('/api/actions',action(`concurrent-${index}`))));
    expect(replies.every(reply=>reply.status===200)).toBe(true);
    const duplicate=await Promise.all([request('/api/actions',action('same-id')),request('/api/actions',action('same-id'))]);
    expect(duplicate.map(reply=>reply.status).sort()).toEqual([200,409]);
    const state=await (await request('/api/state')).json() as {tasks:{id:string}[]};
    expect(state.tasks.filter(task=>task.id.startsWith('concurrent-'))).toHaveLength(6);
    expect(state.tasks.filter(task=>task.id==='same-id')).toHaveLength(1);
  });
});
