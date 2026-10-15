import {it,expect} from 'vitest';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
const exec=promisify(execFile);
const child=(mode:string,dir:string)=>exec(process.execPath,['tests/reliability/recoveryProcess.mjs',mode,dir],{timeout:15000});
it.skipIf(process.platform === 'win32')('P2/P7: actual SIGKILL after side effect requires proof and forbids blind replay across process restart',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'wazir-recovery-'));
 try {
  await expect(child('interrupt',dir)).rejects.toMatchObject({signal:'SIGKILL'});
  const recovered=JSON.parse((await child('recover',dir)).stdout);
  expect(recovered.before.action).toBe('refuse');expect(recovered.replay).toContain('reconcil');expect(recovered.after.action).toBe('resume');expect(recovered.physical).toBe('once\n');
 }finally{await rm(dir,{recursive:true,force:true});}
});
it('P5/P7: another worker process retrieves a queued task and rejects duplicate execution after commit',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'wazir-queue-'));
 try{
  await child('queue-write',dir);
  const result=JSON.parse((await child('queue-read',dir)).stdout);
  expect(result.duplicate).toEqual({ok:false,reason:'REQUEST_ALREADY_DISPATCHED'});expect(result.secondClaim).toBe('RESOURCE_BUSY');expect(result.status.outcome.output).toBe('committed');expect(await readFile(`${dir}/queue-effect`,'utf8')).toBe('once\n');
 }finally{await rm(dir,{recursive:true,force:true});}
});
