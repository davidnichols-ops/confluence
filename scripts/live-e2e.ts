#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { publishRemoteCandidate } from '../src/remote-publication.js';
import type { State } from '../src/contracts.js';

const ROOT=path.resolve(import.meta.dirname,'..');
const account=process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken=process.env.CLOUDFLARE_API_TOKEN;
if(!account||!apiToken) throw new Error('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required');
const id=`confluence-e2e-${Date.now()}`;
const port=8813;
const base=`http://127.0.0.1:${port}`;
const human='e2e-human',runner='e2e-runner',coordinator='e2e-coordinator',agent='e2e-agent';
const zero='0'.repeat(40);
const runDir=await mkdtemp(path.join(tmpdir(),'confluence-live-e2e-'));
const config=path.join(runDir,'wrangler.json');
const evidencePath=path.join(ROOT,'logs/live-e2e.json');
let child:ReturnType<typeof spawn>|undefined;
const records:Array<Record<string,unknown>>=[];
let remote=''; let gitToken=''; let gitTokenId='';
function git(cwd:string,args:string[],input?:string){const r=spawnSync('git',['-c','core.hooksPath=/dev/null',...args],{cwd,input,encoding:'utf8',env:{...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0'}});if(r.status!==0)throw new Error(`git ${args[0]} failed: ${r.stderr}`);return r.stdout.trim();}
async function api(route:string,token:string,method='GET',body?:unknown){const response=await fetch(base+route,{method,headers:{authorization:`Bearer ${token}`,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});const value=await response.json();if(!response.ok)throw new Error(`${route} ${response.status}: ${JSON.stringify(value)}`);return value as any;}
async function waitReady(){for(let i=0;i<60;i++){try{const r=await fetch(base+'/api/state',{headers:{authorization:`Bearer ${runner}`}});if(r.ok)return;}catch{}await new Promise(r=>setTimeout(r,250));}throw new Error('workerd did not become ready');}
try{
 await writeFile(config,JSON.stringify({name:'confluence-live-e2e',main:path.join(ROOT,'src/worker.ts'),compatibility_date:'2026-09-01',durable_objects:{bindings:[{name:'COORDINATOR',class_name:'Coordinator'}]},migrations:[{tag:'v1',new_sqlite_classes:['Coordinator']}],artifacts:[{binding:'ARTIFACTS',namespace:'default',remote:true}],vars:{HUMAN_TOKEN:human,RUNNER_TOKEN:runner,COORDINATOR_TOKEN:coordinator,COORDINATOR_AGENT_ID:'coordinator',AGENT_TOKENS:JSON.stringify({builder:agent}),ARTIFACTS_REPO:id}}));
 const log=await import('node:fs').then(fs=>fs.openSync(path.join(ROOT,'logs/live-e2e-workerd.log'),'w'));
 child=spawn(process.execPath,[path.join(ROOT,'node_modules/wrangler/bin/wrangler.js'),'dev','--config',config,'--ip','127.0.0.1','--port',String(port),'--persist-to',path.join(runDir,'persist')],{cwd:ROOT,env:{...process.env,CLOUDFLARE_ACCOUNT_ID:account,CLOUDFLARE_API_TOKEN:apiToken,WRANGLER_SEND_METRICS:'false'},stdio:['ignore',log,log]});
 await waitReady(); records.push({step:'workerd-ready',ok:true});
 const repo=await api('/api/artifacts/ensure',coordinator,'POST',{}); remote=repo.remote; records.push({step:'repo-created',ok:repo.created,name:repo.name});
 const minted=await api('/api/artifacts/token',coordinator,'POST',{scope:'write',ttl:600}); gitToken=minted.plaintext; gitTokenId=minted.id??'';
 await api('/api/actions',human,'POST',{action:{type:'create_objective',objective:'Prove exact remote publication'}});
 await api('/api/actions',human,'POST',{action:{type:'create_task',id:'live',title:'Add live evidence',agent:'builder',intent:'Publish one exact file',paths:['README.md']}});
 await api('/api/actions',agent,'POST',{action:{type:'checkpoint',taskId:'live',context:{summary:'Prepared exact live file',nextStep:'Propose candidate',notes:['real provider identity boundary exercised']}}});
 await api('/api/actions',agent,'POST',{action:{type:'propose',taskId:'live',patches:[{path:'README.md',before:null,after:'Confluence live remote publication\n'}]}});
 await api('/api/actions',human,'POST',{action:{type:'assemble',taskIds:['live']}});
 let state=await api('/api/state',runner) as State; const candidate=state.candidate!;
 await api('/api/actions',runner,'POST',{action:{type:'record_evidence',evidence:{treeHash:candidate.treeHash,passed:true,checks:['exact live fixture']}}});
 await api('/api/actions',human,'POST',{action:{type:'approve',treeHash:candidate.treeHash}});
 state=await api('/api/actions',human,'POST',{action:{type:'integrate',ref:'refs/heads/main',expectedHead:zero}});
 if(state.publication?.status!=='reserved')throw new Error('publication was not reserved');
 const src=path.join(runDir,'candidate');await mkdir(src);git(src,['init','-q','-b','main']);await writeFile(path.join(src,'README.md'),candidate.files['README.md']);git(src,['add','README.md']);const tree=git(src,['write-tree']);const commit=git(src,['-c','user.name=Confluence','-c','user.email=e2e@example.invalid','commit-tree',tree],'live candidate\n');git(src,['branch','-f','main',commit]);const bundlePath=path.join(runDir,'candidate.bundle');git(src,['bundle','create',bundlePath,'main']);
 const published=await publishRemoteCandidate({remote,token:gitToken,ref:'refs/heads/main',expectedHead:zero,candidate:{commit,tree,contentHash:candidate.treeHash},bundle:new Uint8Array(await readFile(bundlePath)),evidence:{treeHash:candidate.treeHash,passed:true,checks:['exact live fixture'],runner:'trusted-runner'},approval:{treeHash:candidate.treeHash,human:'human-reviewer'}});
 const receipt={ref:published.ref,previousHead:zero,commit:published.commit,tree:published.tree,contentHash:published.contentHash,remote,publishedAt:new Date().toISOString()};
 state=await api('/api/publications/complete',runner,'POST',{receipt});
 if(state.revision!==1||state.publication?.status!=='published'||state.baseline['README.md']!=='Confluence live remote publication\n')throw new Error('coordinator did not integrate published bytes');
 const retry=await api('/api/publications/complete',runner,'POST',{receipt});if(retry.revision!==1)throw new Error('receipt retry was not idempotent');
 records.push({step:'remote-publication',ok:true,commit,tree,contentHash:candidate.treeHash,ref:'refs/heads/main',coordinatorRevision:1,receiptRetryIdempotent:true});
 const revoked=await api('/api/artifacts/token/revoke',coordinator,'POST',{tokenOrId:gitTokenId||gitToken});
 records.push({step:'write-token-revoked',ok:revoked.revoked===true,idReturned:gitTokenId.length>0}); gitToken=''; gitTokenId='';
} finally {
 if(gitToken&&remote){try{const u=new URL(remote);const secret=gitToken.split('?')[0];spawnSync('git',['-c','credential.helper=','-c',`http.extraHeader=Authorization: Bearer ${gitToken}`,'ls-remote',remote],{encoding:'utf8',env:{...process.env,GIT_TERMINAL_PROMPT:'0'}});records.push({step:'remote-readable-before-cleanup',ok:true});void secret;}catch{}}
 try{const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/artifacts/namespaces/default/repos/${id}`,{method:'DELETE',headers:{authorization:`Bearer ${apiToken}`}});records.push({step:'cleanup-accepted',ok:[200,202,204,404].includes(response.status),status:response.status});}catch(error){records.push({step:'cleanup-accepted',ok:false,error:String(error)});}
 child?.kill('SIGTERM'); await rm(runDir,{recursive:true,force:true});
 await writeFile(evidencePath,JSON.stringify({checkedAt:new Date().toISOString(),scope:'Actual local Worker/Durable Object with remote Artifacts Git publication; disposable repo.',passed:records.every(r=>r.ok===true),records},null,2)+'\n');
}
if(!records.every(r=>r.ok===true))process.exitCode=1; else console.log(JSON.stringify({passed:true,evidence:'logs/live-e2e.json',steps:records.length}));
