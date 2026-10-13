import { JsonFileStore } from '../../packages/shared/dist/src/index.js';
import { ExecutionEngine } from '../../packages/core/dist/src/index.js';
import { planTaskResume } from '../../apps/cli/dist/recovery.js';
import { TaskDispatcher } from '../../apps/api/dist/server.js';
import { appendFile,readFile,writeFile } from 'node:fs/promises';
const [mode,dir] = process.argv.slice(2);
const store=new JsonFileStore(`${dir}/store.json`);
if(mode.startsWith('queue')) {
 const d=new TaskDispatcher(store);await d.ready;
 const request={requestId:'P5',executionId:'execution-P5',modelId:'none',messages:[]};
 if(mode==='queue-write') {await d.dispatch('worker-A',request);}
 else {
   const first=await d.claim('P5','worker-A');
   await appendFile(`${dir}/queue-effect`,'once\n');
   await d.resolve('P5',{ok:true,output:'committed',inputTokens:0,outputTokens:0,durationMs:1},first.token);
   const duplicate=await d.dispatch('worker-A',request);
   let secondClaim='unexpected';try{await d.claim('P5','worker-A');}catch(e){secondClaim=e.message;}
   console.log(JSON.stringify({duplicate,secondClaim,status:await d.status('P5')}));
 }
} else {
 const engine=new ExecutionEngine({persist:r=>store.put(`execution/${r.execution.id}`,r),load:async()=> (await store.list('execution/')).map(e=>e.value)});await engine.ready;
 if(mode==='interrupt') {
  const r=await engine.create({task:{id:'P2',type:'coding',input:'side effect',requirements:{},priority:'normal',status:'pending',createdAt:new Date()},computerId:'local',runtimeId:'fixture',modelId:'none'});
  await engine.setStatus(r.execution.id,'running');
  await writeFile(`${dir}/id`,r.execution.id);
  await engine.recordToolStart(r.execution.id,'shell',{command:'append marker'},{callId:'effect-1',sideEffectClass:'NON_IDEMPOTENT_WRITE'});
  await appendFile(`${dir}/effect`,'once\n');
  process.kill(process.pid,'SIGKILL');
 }else {
  const id=await readFile(`${dir}/id`,'utf8');
  const before=await planTaskResume(engine,id,async()=>({outcome:'UNDETERMINED',evidence:'No physical inspection yet'}));
  let replay='unexpected';try{await engine.recordToolStart(id,'shell',{command:'append marker'},{callId:'effect-2',sideEffectClass:'NON_IDEMPOTENT_WRITE'});}catch(e){replay=e.message;}
  const physical=await readFile(`${dir}/effect`,'utf8');
  if(physical!=='once\n')throw new Error('Side effect evidence mismatch');
  const after=await planTaskResume(engine,id,async()=>({outcome:'APPLIED',evidence:'Isolated effect file contains exactly one expected record'}));
  console.log(JSON.stringify({before,replay,after,physical}));
 }
}
