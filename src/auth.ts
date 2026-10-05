import type { Actor } from './contracts';

export interface Credentials {
  COORDINATOR_TOKEN?: string;
  COORDINATOR_AGENT_ID?: string;
  RUNNER_TOKEN?: string;
  HUMAN_TOKEN?: string;
  AGENT_TOKENS?: string; // secret JSON map of agent ID to token; never returned/logged
}
export type Authorization = { ok: true; actor: Actor } | { ok: false; status: number; code: string; message: string };
const humanOnly = new Set(['create_objective', 'approve', 'integrate', 'reserve_publication']);
function equal(a: string, b: string) {
  const length = Math.max(a.length,b.length); let diff = a.length ^ b.length;
  for (let i=0;i<length;i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
export function authorize(request: Request, env: Credentials, type: string): Authorization {
  const deny = (status:number,code:string,message:string): Authorization => ({ok:false,status,code,message});
  const token = request.headers.get('authorization')?.match(/^Bearer (.+)$/)?.[1] ?? '';
  let agents: Record<string,string> = {};
  if (env.AGENT_TOKENS) {
    try {
      agents = JSON.parse(env.AGENT_TOKENS);
      if (!agents || typeof agents !== 'object' || Array.isArray(agents) || !Object.entries(agents).every(([id,value])=>id.length>0 && typeof value==='string' && value.length>0)) throw new Error();
    } catch { return deny(503,'invalid_credentials','Agent credentials are misconfigured'); }
  }
  if (env.COORDINATOR_TOKEN) agents[env.COORDINATOR_AGENT_ID || 'coordinator-agent'] = env.COORDINATOR_TOKEN;
  const configured=[env.HUMAN_TOKEN,env.RUNNER_TOKEN,...Object.values(agents)].filter((value):value is string=>!!value);
  if(new Set(configured).size!==configured.length) return deny(503,'invalid_credentials','Roles and agent identities require distinct credentials');
  if(type==='read_state' && env.RUNNER_TOKEN && token && equal(token,env.RUNNER_TOKEN)) return {ok:true,actor:{id:'trusted-runner',role:'runner'}};
  if(type==='record_evidence' || type==='record_publication') {
    if(!env.RUNNER_TOKEN) return deny(403,'runner_token_not_configured','Trusted runner credential is not configured');
    return token && equal(token,env.RUNNER_TOKEN) ? {ok:true,actor:{id:'trusted-runner',role:'runner'}} : deny(401,'unauthorized','Trusted runner token required');
  }
  if(env.HUMAN_TOKEN && token && equal(token,env.HUMAN_TOKEN)) return {ok:true,actor:{id:'human-reviewer',role:'human'}};
  if(humanOnly.has(type)) return deny(env.HUMAN_TOKEN?401:403,'unauthorized','Human credential required');
  for(const [id,secret] of Object.entries(agents)) {
    if(token && equal(token,secret)) return {ok:true,actor:{id,role:'agent'}};
  }
  return deny(configured.length?401:403,'unauthorized','A configured scoped credential is required');
}
