import { describe, expect, it } from 'vitest';
import { authorize } from '../src/auth';
const env={HUMAN_TOKEN:'human-secret',RUNNER_TOKEN:'runner-secret',AGENT_TOKENS:JSON.stringify({alice:'alice-secret',bob:'bob-secret'})};
const request=(token?:string)=>new Request('http://example.test',{headers:token?{authorization:`Bearer ${token}`}:{}});
describe('credential-bound authority',()=>{
  it('fails closed with missing credentials',()=>{
    expect(authorize(request(),{},'propose').ok).toBe(false);
    expect(authorize(request(),{},'record_evidence').ok).toBe(false);
  });
  it('binds identity to agent credentials and separates review and runner roles',()=>{
    expect(authorize(request('alice-secret'),env,'checkpoint')).toEqual({ok:true,actor:{id:'alice',role:'agent'}});
    expect(authorize(request('bob-secret'),env,'propose')).toEqual({ok:true,actor:{id:'bob',role:'agent'}});
    expect(authorize(request('alice-secret'),env,'approve').ok).toBe(false);
    expect(authorize(request('alice-secret'),env,'record_evidence').ok).toBe(false);
    expect(authorize(request('human-secret'),env,'integrate')).toEqual({ok:true,actor:{id:'human-reviewer',role:'human'}});
    expect(authorize(request('runner-secret'),env,'record_evidence')).toEqual({ok:true,actor:{id:'trusted-runner',role:'runner'}});
  });
  it('refuses ambiguous and malformed credential configuration',()=>{
    expect(authorize(request('same'),{HUMAN_TOKEN:'same',RUNNER_TOKEN:'same'},'approve').ok).toBe(false);
    expect(authorize(request(),{AGENT_TOKENS:'null'},'checkpoint').ok).toBe(false);
  });
  it('requires scoped credentials for private state reads, including runner inspection',()=>{
    expect(authorize(request(),env,'read_state').ok).toBe(false);
    expect(authorize(request('unknown'),env,'read_state').ok).toBe(false);
    expect(authorize(request(),{},'read_state').ok).toBe(false);
    for(const token of ['human-secret','runner-secret','alice-secret']) expect(authorize(request(token),env,'read_state').ok).toBe(true);
    expect(authorize(request('runner-secret'),env,'checkpoint').ok).toBe(false);
  });
});
