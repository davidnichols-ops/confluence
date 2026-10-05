#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { publishRemoteCandidate } from '../src/remote-publication.js';
import { treeHash } from '../src/core.js';
import type { Files, State } from '../src/contracts.js';

const endpoint=process.env.CONFLUENCE_URL;
const secretsPath=process.env.CONFLUENCE_SECRETS_FILE;
if(!endpoint||!secretsPath)throw new Error('CONFLUENCE_URL and CONFLUENCE_SECRETS_FILE are required');
const secrets=JSON.parse(await readFile(secretsPath,'utf8')) as Record<string,string>;
const agents=JSON.parse(secrets.AGENT_TOKENS) as Record<string,string>;
const remote='https://77bda5395b515f5be1a663ee4fbc54ba.artifacts.cloudflare.net/git/default/confluence-baseline.git';
const ref='refs/heads/main'; const records:Array<Record<string,unknown>>=[];
async function call(route:string,token:string,method='GET',body?:unknown){const r=await fetch(endpoint+route,{method,headers:{authorization:`Bearer ${token}`,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});const value=await r.json();if(!r.ok)throw new Error(`${route} ${r.status}: ${JSON.stringify(value)}`);return value as any;}
function git(cwd:string,args:string[],token?:string){const full=[...(token?['-c','credential.helper=','-c',`http.extraHeader=Authorization: Bearer ${token}`]:[]),'-c','core.hooksPath=/dev/null',...args];const r=spawnSync('git',full,{cwd,encoding:'utf8',env:{...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0'}});if(r.status!==0)throw new Error(`git ${args[0]} failed: ${r.stderr}`);return r.stdout.trim();}
const unauth=await fetch(endpoint+'/api/state');records.push({step:'unauthenticated-state-denied',ok:unauth.status===401,status:unauth.status});
let state=await call('/api/state',secrets.RUNNER_TOKEN) as State;records.push({step:'authenticated-state',ok:state.mode==='cloudflare'});
if(state.objective)throw new Error('deployed coordinator is not fresh; refusing to overwrite state');
const repo=await call('/api/artifacts/info',secrets.COORDINATOR_TOKEN);records.push({step:'artifacts-info',ok:repo.name==='confluence-baseline'});
const minted=await call('/api/artifacts/token',secrets.COORDINATOR_TOKEN,'POST',{scope:'write',ttl:600}) as {id?:string;plaintext:string};
const token=minted.plaintext;
const expectedHead=git(process.cwd(),['ls-remote',remote,ref],token).split(/\s+/)[0];
const files:Files={'README.md':'Confluence baseline repository\n','evidence/deployed.txt':`Protected Worker publication verified at ${new Date().toISOString()}\n`};
await call('/api/actions',secrets.HUMAN_TOKEN,'POST',{action:{type:'create_objective',objective:'Verify protected Worker to Artifacts publication'}});
await call('/api/actions',secrets.HUMAN_TOKEN,'POST',{action:{type:'create_task',id:'deployed-proof',title:'Publish deployment evidence',agent:'builder',intent:'Exercise exact production path',paths:Object.keys(files)}});
await call('/api/actions',agents.builder,'POST',{action:{type:'checkpoint',taskId:'deployed-proof',context:{summary:'Deployment and repository authenticated',nextStep:'Publish exact approved candidate',notes:['Production Worker and Artifacts binding active']}}});
await call('/api/actions',agents.builder,'POST',{action:{type:'propose',taskId:'deployed-proof',patches:Object.entries(files).map(([p,after])=>({path:p,before:null,after}))}});
await call('/api/actions',secrets.HUMAN_TOKEN,'POST',{action:{type:'assemble',taskIds:['deployed-proof']}});
state=await call('/api/state',secrets.RUNNER_TOKEN);const candidate=state.candidate!;if(candidate.treeHash!==await treeHash(files))throw new Error('candidate hash differs');
await call('/api/actions',secrets.RUNNER_TOKEN,'POST',{action:{type:'record_evidence',evidence:{treeHash:candidate.treeHash,passed:true,checks:['deployed exact-content fixture']}}});
await call('/api/actions',secrets.HUMAN_TOKEN,'POST',{action:{type:'approve',treeHash:candidate.treeHash}});
state=await call('/api/actions',secrets.HUMAN_TOKEN,'POST',{action:{type:'integrate',ref,expectedHead}});if(state.publication?.status!=='reserved')throw new Error('reservation failed');
const work=await mkdtemp(path.join(tmpdir(),'confluence-deployed-'));
try{
 git(work,['clone','--quiet',remote,'repo'],token);const repoDir=path.join(work,'repo');git(repoDir,['rm','-r','-f','--ignore-unmatch','-q','.']);for(const [p,c] of Object.entries(files)){await mkdir(path.dirname(path.join(repoDir,p)),{recursive:true});await writeFile(path.join(repoDir,p),c);}git(repoDir,['add','-A']);git(repoDir,['-c','user.name=Confluence','-c','user.email=runner@example.invalid','commit','--no-gpg-sign','-q','-m','Record deployed publication proof']);const commit=git(repoDir,['rev-parse','HEAD']);const tree=git(repoDir,['rev-parse','HEAD^{tree}']);const bundlePath=path.join(work,'candidate.bundle');git(repoDir,['bundle','create',bundlePath,'HEAD']);
 const published=await publishRemoteCandidate({remote,token,ref,expectedHead,candidate:{commit,tree,contentHash:candidate.treeHash},bundle:new Uint8Array(await readFile(bundlePath)),evidence:{treeHash:candidate.treeHash,passed:true,checks:['deployed exact-content fixture'],runner:'trusted-runner'},approval:{treeHash:candidate.treeHash,human:'human-reviewer'}});
 const receipt={ref,previousHead:expectedHead,commit:published.commit,tree:published.tree,contentHash:published.contentHash,remote,publishedAt:new Date().toISOString()};state=await call('/api/publications/complete',secrets.RUNNER_TOKEN,'POST',{receipt});const retry=await call('/api/publications/complete',secrets.RUNNER_TOKEN,'POST',{receipt});
 records.push({step:'deployed-publication',ok:state.revision===1&&retry.revision===1&&state.publication?.receipt?.commit===commit,expectedHead,commit,tree,contentHash:candidate.treeHash,receiptRetryIdempotent:retry.revision===1});
} finally {await rm(work,{recursive:true,force:true});}
const revoked=await call('/api/artifacts/token/revoke',secrets.COORDINATOR_TOKEN,'POST',{tokenOrId:minted.id??token});
records.push({step:'write-token-revoked',ok:revoked.revoked===true,idReturned:typeof minted.id==='string'});
const report={checkedAt:new Date().toISOString(),endpoint,remote,passed:records.every(x=>x.ok===true),records};await writeFile(path.join(process.cwd(),'logs/deployed-smoke.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({passed:report.passed,evidence:'logs/deployed-smoke.json'}));if(!report.passed)process.exitCode=1;
