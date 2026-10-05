// Read-only platform access probe. Never upgrades a plan or creates resources.
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (![2,4].includes(args.length) || args[0] !== '--account' || !/^[a-f0-9]{32}$/.test(args[1]) || (args.length===4 && args[2]!=='--token-file')) {
  console.error('Usage: node scripts/platform-preflight.mjs --account <Cloudflare account ID> [--token-file <private file>]');
  process.exit(2);
}
const account = args[1];
const env = { ...process.env, CLOUDFLARE_ACCOUNT_ID: account, CI: '1', WRANGLER_SEND_METRICS: 'false' };
for (const name of ['CLOUDFLARE_API_TOKEN','CLOUDFLARE_API_KEY','CLOUDFLARE_EMAIL']) delete env[name];
if(args.length===4) env.CLOUDFLARE_API_TOKEN=(await readFile(args[3],'utf8')).trim();
const output = path.join(root, 'logs', 'platform-preflight');
await mkdir(output, { recursive: true });
async function run(name, command) {
  const started = new Date().toISOString();
  const result = await new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(root,'node_modules/wrangler/bin/wrangler.js'),...command], { cwd:root, env, stdio:['ignore','pipe','pipe'] });
    let text='', done=false, timeout=false;
    const timer = setTimeout(()=>{timeout=true;child.kill('SIGTERM');setTimeout(()=>{if(!done)child.kill('SIGKILL');},2000).unref();},45000);
    const append=data=>{text+=data.toString();if(text.length>1024*1024){text=text.slice(-1024*1024);child.kill('SIGTERM');}};
    child.stdout.on('data',append);child.stderr.on('data',append);
    child.on('error',error=>{clearTimeout(timer);done=true;resolve({exit:1,text:String(error),timeout});});
    child.on('close',code=>{clearTimeout(timer);done=true;resolve({exit:code??1,text,timeout});});
  });
  const safe=env.CLOUDFLARE_API_TOKEN?result.text.split(env.CLOUDFLARE_API_TOKEN).join('[REDACTED]'):result.text;
  await writeFile(path.join(output,name+'.txt'),safe,{mode:0o600});
  const code=result.text.match(/\[code: (\d+)\]/)?.[1];
  return {name,command:['node','node_modules/wrangler/bin/wrangler.js',...command],started,ended:new Date().toISOString(),exit:result.exit,timeout:result.timeout,...(code?{apiCode:code}:{}),log:'logs/platform-preflight/'+name+'.txt'};
}
const checks=[];
checks.push(await run('oauth',['whoami']));
if(checks[0].exit===0) checks.push(await run('artifacts-access',['artifacts','repos','list','--namespace','default']));
const report={checkedAt:new Date().toISOString(),account,credentialSource:args.length===4?'Explicit private API token file; inherited credentials excluded':'Wrangler OAuth; inherited API token/key/email excluded',checks,passed:checks.length===2&&checks.every(x=>x.exit===0),writesPerformed:false};
await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({passed:report.passed,checks:checks.map(({name,exit,apiCode,timeout})=>({name,exit,apiCode,timeout})),report:'logs/platform-preflight/report.json',writesPerformed:false},null,2));
process.exitCode=report.passed?0:1;
