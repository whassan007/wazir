// Uses the established Wazir live-session process runner and real CLI task path.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parseArgs, isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { runProcess } from './live-session-harness/runner.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const {values} = parseArgs({options:{model:{type:'string',multiple:true},output:{type:'string'},case:{type:'string',multiple:true},'timeout-ms':{type:'string',default:'120000'}}});
if (!values.model?.length || !values.output) throw new Error('Require --model and --output');
const dataset = JSON.parse(await fs.readFile(path.join(root,'test/reliability/benchmarks/v1.json'),'utf8'));
const out = path.resolve(values.output); await fs.mkdir(out,{recursive:true});
const sha = (await runProcess('git',['rev-parse','HEAD'],{cwd:root})).output.trim();
const report = {schema_version:1,dataset_version:dataset.version,source_sha:sha,node:process.version,platform:process.platform,arch:process.arch,started_at:new Date().toISOString(),results:[]};
for (const model of values.model) for (const c of dataset.cases.filter(c=>!values.case || values.case.includes(c.id))) {
  const result = {id:c.id,title:c.title,model,kind:c.kind,status:'NOT RUN',input:c.input,expected:c.expected??c.checks??c.verification,verification:c.kind==='system'?c.test:'Independent JSON/file/code oracle',latency_ms:null,failure_class:null};
  report.results.push(result);
  if(c.kind==='system') {result.reason='Model-independent case: run referenced Vitest suite; excluded from model accuracy';continue;}
  const artifact = await fs.mkdtemp(path.join(out,`${c.id}-`)); const workspace = path.join(artifact,'workspace'), home = path.join(artifact,'home');
  await fs.mkdir(workspace);await fs.mkdir(home);
  const files={...c.files};
  if(c.largeInput) files['large.txt']='irrelevant calibration row\n'.repeat(650)+'calibration_code=cobalt-73921\n'+'irrelevant calibration row\n'.repeat(650);
  for(const [file,content] of Object.entries(files)){await fs.mkdir(path.dirname(path.join(workspace,file)),{recursive:true});await fs.writeFile(path.join(workspace,file),content);}
  await fs.writeFile(path.join(home,'config.json'),JSON.stringify({lmstudioUrl:'http://127.0.0.1:1234/v1',ollamaUrl:'http://127.0.0.1:1',models:{startup:{mode:'none'}},networkAllowed:false}));
  const env={...process.env,WAZIR_HOME:home,WAZIR_SECRETS_BACKEND:'encrypted-file'};delete env.WAZIR_DATABASE_URL;delete env.DATABASE_URL;delete env.WAZIR_IN_MEMORY;
  const start=Date.now();console.error(`Running ${model} ${c.id}`);
  const run=await runProcess(process.execPath,[path.join(root,'bin/wa.js'),'task','run',c.input,'--type','coding','--model',model,'--max-turns','12','--json'],{cwd:workspace,env,timeoutMs:Number(values['timeout-ms']),log:path.join(artifact,'session.log')});
  result.latency_ms=Date.now()-start;result.trace=path.relative(out,artifact);result.process={code:run.code,signal:run.signal,timed_out:run.timedOut};
  const failures=[];
  let record;
  try {const store=JSON.parse(await fs.readFile(path.join(home,'wazir.json'),'utf8'));record=Object.values(store).find(v=>v?.execution);await fs.writeFile(path.join(artifact,'execution.json'),JSON.stringify(record,null,2));}catch{}
  result.runtime_success=record?.execution?.status==='completed';
  result.tool_calls=record?.toolCalls?.length??0;result.tool_success=record?.toolCalls?.filter(t=>t.ok).length??0;
  try {
    if(c.code){
      const code=`const f=require(process.argv[1]);const cases=JSON.parse(process.argv[2]);for(const [input,want] of cases)if(f(input)!==want)process.exit(1)`;
      const verification=await runProcess(process.execPath,['-e',code,path.join(workspace,c.code),JSON.stringify(c.checks)],{cwd:workspace,timeoutMs:5000,log:path.join(artifact,'oracle.log')});
      result.actual={oracle_exit_code:verification.code};if(verification.code!==0)failures.push('independent code oracle failed');
    }else{const actual=JSON.parse(await fs.readFile(path.join(workspace,c.target??'report.json'),'utf8'));result.actual=actual;if(!isDeepStrictEqual(actual,c.expected))failures.push('exact JSON mismatch');}
    for(const p of c.protected??[])if(await fs.readFile(path.join(workspace,p),'utf8')!==files[p])failures.push(`protected file modified: ${p}`);
    if(c.requireTool&&!record?.toolCalls?.some(t=>t.tool===c.requireTool))failures.push(`required tool not observed: ${c.requireTool}`);
    if(c.minimumReads&&(record?.toolCalls?.filter(t=>t.tool==='read'&&t.ok).length??0)<c.minimumReads)failures.push('insufficient dependent reads');
    if(c.minimumDelegations&&(record?.toolCalls?.filter(t=>t.tool==='dispatch_subagent'&&t.ok).length??0)<c.minimumDelegations)failures.push('missing real delegation');
  }catch(e){failures.push(String(e));}
  result.answer_correct=failures.length===0;
  if(run.code!==0||run.timedOut)failures.push('runtime did not complete successfully');
  result.status=failures.length?'FAILED':'PASSED';result.failures=failures;result.failure_class=run.timedOut?'TIMEOUT':failures.length?'TASK_OR_RUNTIME_FAILURE':null;
  console.error(`${c.id} ${result.status} ${result.latency_ms}ms`);
  await fs.writeFile(path.join(out,'run.json'),JSON.stringify(report,null,2));
}
report.finished_at=new Date().toISOString();await fs.writeFile(path.join(out,'run.json'),JSON.stringify(report,null,2));
process.exitCode=report.results.some(r=>r.status==='FAILED')?1:0;
