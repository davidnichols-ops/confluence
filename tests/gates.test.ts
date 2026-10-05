import { describe, expect, it } from 'vitest';
import { applyAction, createState, treeHash } from '../src/core.js';
import type { Actor, State } from '../src/contracts.js';
const human: Actor = { id: 'reviewer', role: 'human' };
const agent: Actor = { id: 'builder', role: 'agent' };
const runner: Actor = { id: 'validator', role: 'runner' };

async function proposed() {
  let state = createState({ 'a.txt': 'original' });
  state = await applyAction(state, { type:'create_objective', objective:'Improve fixture', actor:human });
  state = await applyAction(state, { type:'create_task', id:'one', title:'Update a', agent:agent.id, intent:'Change a', paths:['a.txt'], actor:human });
  state = await applyAction(state, { type:'propose', taskId:'one', patches:[{path:'a.txt',before:'original',after:'updated'}], actor:agent });
  return state;
}
async function ready() {
  let state = await applyAction(await proposed(), {type:'assemble',taskIds:['one'],actor:human});
  state = await applyAction(state, {type:'record_evidence',evidence:{treeHash:state.candidate!.treeHash,passed:true,checks:['fixture check']},actor:runner});
  return state;
}

describe('integration admission invariants', () => {
  it('binds evidence and approval to exact bytes and requires both', async () => {
    let state = await ready();
    await expect(applyAction(state,{type:'integrate',actor:human})).rejects.toThrow();
    await expect(applyAction(state,{type:'approve',treeHash:'another-tree',actor:human})).rejects.toThrow();
    state = await applyAction(state,{type:'approve',treeHash:state.candidate!.treeHash,actor:human});
    const result = await applyAction(state,{type:'integrate',actor:human});
    expect(result.baseline['a.txt']).toBe('updated');
    expect(result.revision).toBe(state.revision+1);
    expect(result.tasks[0].status).toBe('integrated');
    expect(state.baseline['a.txt']).toBe('original');
  });
  it('rejects fabricated evidence, failed evidence and unauthorized approval', async () => {
    const state = await applyAction(await proposed(),{type:'assemble',taskIds:['one'],actor:human});
    const evidence={treeHash:state.candidate!.treeHash,passed:true,checks:['fabricated']};
    await expect(applyAction(state,{type:'record_evidence',evidence,actor:agent})).rejects.toThrow();
    await expect(applyAction(state,{type:'record_evidence',evidence:{...evidence,treeHash:'stale'},actor:runner})).rejects.toThrow();
    const failed=await applyAction(state,{type:'record_evidence',evidence:{...evidence,passed:false},actor:runner});
    await expect(applyAction(failed,{type:'integrate',actor:human})).rejects.toThrow();
    await expect(applyAction(await ready(),{type:'approve',treeHash:state.candidate!.treeHash,actor:agent})).rejects.toThrow();
  });
  it('rejects duplicate integration inputs and preserves input on rejection', async () => {
    const state=await proposed(); const snapshot=structuredClone(state);
    await expect(applyAction(state,{type:'assemble',taskIds:['one','one'],actor:human})).rejects.toThrow();
    expect(state).toEqual(snapshot);
  });
  it('invalidates evidence and approval when proposal changes', async () => {
    let state=await ready();
    state=await applyAction(state,{type:'approve',treeHash:state.candidate!.treeHash,actor:human});
    state=await applyAction(state,{type:'propose',taskId:'one',patches:[{path:'a.txt',before:'original',after:'different'}],actor:agent});
    expect(state.candidate).toBeUndefined();
    await expect(applyAction(state,{type:'integrate',actor:human})).rejects.toThrow();
  });
  it('hashes canonical file content, independent of insertion order', async () => {
    expect(await treeHash({b:'2',a:'1'})).toBe(await treeHash({a:'1',b:'2'}));
    expect(await treeHash({a:'1',b:'2'})).not.toBe(await treeHash({a:'1',b:'3'}));
  });
});
