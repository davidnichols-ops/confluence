import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { prepareGitCandidate } from './git-runner.js';
import { validateCandidate } from './demo.js';
import type { Files } from './contracts.js';
const execute = promisify(execFile);

export async function validateWithGit(baseline: Files, files: Files): Promise<{passed:boolean;checks:string[]}> {
  const source = await mkdtemp(join(tmpdir(), 'confluence-baseline-'));
  const git = async (...args:string[]) => (await execute('git',args,{cwd:source,env:{...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null',GIT_TERMINAL_PROMPT:'0'}})).stdout.trim();
  try {
    await git('init','-q');
    for(const [name,contents] of Object.entries(baseline)) {
      if(name.split('/').some(part=>!part||part==='.'||part==='..'||part.toLowerCase()==='.git')||name.includes('\\')||name.startsWith('/')||/^[A-Za-z]:/.test(name)) throw new Error('Unsafe baseline path');
      const path=join(source,name);await mkdir(dirname(path),{recursive:true});await writeFile(path,contents);
    }
    await git('add','-A');
    await git('-c','user.name=Confluence','-c','user.email=prototype@example.invalid','commit','--allow-empty','--no-gpg-sign','-q','-m','Local candidate baseline');
    const head = await git('rev-parse','HEAD');
    const result = await prepareGitCandidate({repository:source,expectedHead:head,files,validate:async directory=>{
      const actual:Files={};
      for(const name of Object.keys(files)) actual[name]=await readFile(join(directory,name),'utf8');
      return validateCandidate(actual);
    }});
    const directory=resolve('.local/candidates');await mkdir(directory,{recursive:true});
    const output=join(directory,`${result.contentHash}.bundle`);
    const temporary=`${output}.${randomUUID()}.tmp`;
    await writeFile(temporary,result.bundle,{mode:0o600});await rename(temporary,output);
    await writeFile(join(directory,`${result.contentHash}.json`),JSON.stringify({commit:result.commit,tree:result.tree,contentHash:result.contentHash,baseCommit:head,passed:result.passed,checks:result.checks,scope:'Local isolated Git fixture; no remote push'},null,2),{mode:0o600});
    return {passed:result.passed,checks:[...result.checks,`Git candidate commit: ${result.commit}`,`Git candidate tree: ${result.tree}`,`Retained Git bundle: .local/candidates/${result.contentHash}.bundle`]};
  } finally {await rm(source,{recursive:true,force:true});}
}
