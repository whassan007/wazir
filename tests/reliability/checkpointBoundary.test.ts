import {it,expect} from 'vitest';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {CheckpointService,ExecutionEngine,WorktreeManager} from '@wazir/core';
it.each(['../outside.txt','/absolute.txt','.git/config','node_modules/payload'])('rejects unsafe checkpoint path %s before deleting any workspace file',async unsafe=>{
 const root=await mkdtemp(path.join(tmpdir(),'wazir-checkpoint-boundary-'));
 try{
  const workspace=path.join(root,'workspace');await mkdir(workspace);await writeFile(path.join(workspace,'keep.txt'),'keep');
  const service=new CheckpointService({executionEngine:new ExecutionEngine(),worktreeManager:new WorktreeManager()});
  const checkpoint:any={workspaceRevision:0,worktreeState:{filesSnapshot:{[unsafe]:'bad'}}};
  await expect(service.materializeOnTarget(workspace,checkpoint)).rejects.toThrow('UNSAFE_CHECKPOINT_PATH');
  expect(await readFile(path.join(workspace,'keep.txt'),'utf8')).toBe('keep');
 }finally{await rm(root,{recursive:true,force:true});}
});
it.skipIf(process.platform==='win32')('rejects a snapshot write through a target symlink before any mutation',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'wazir-checkpoint-symlink-'));
 try{
  const workspace=path.join(root,'workspace');await mkdir(workspace);await mkdir(path.join(root,'outside'));await symlink(path.join(root,'outside'),path.join(workspace,'link'));
  const service=new CheckpointService({executionEngine:new ExecutionEngine(),worktreeManager:new WorktreeManager()});
  await expect(service.materializeOnTarget(workspace,{workspaceRevision:0,worktreeState:{filesSnapshot:{'link/escape.txt':'bad'}}} as any)).rejects.toThrow('UNSAFE_CHECKPOINT_PATH');
 }finally{await rm(root,{recursive:true,force:true});}
});
