import { MemoryService, SqliteMemoryStore } from '../../packages/memory/dist/src/index.js';
const [mode, file] = process.argv.slice(2);
const store = new SqliteMemoryStore({ dbPath: file });
const memory = new MemoryService(store);
if (mode === 'write') {
  memory.recordEpisode({repositoryScope:'tenant-A/repository',taskType:'coding',taskPrompt:'Unique calibration fact: heliotrope-67231',executionId:'memory-test',attemptOutcome:'success',filesInvolved:['fact.txt'],workspaceRevision:1});
  memory.recordProcedure({repositoryScope:'tenant-A/repository',kind:'test',name:'verify',triggerPattern:'test',recipe:{command:'node --test'},associatedFiles:['fact.txt']});
} else if (mode === 'invalidate') memory.invalidateOnMutation('tenant-A/repository',['fact.txt']);
else console.log(JSON.stringify({
  episodes:memory.queryEpisodic({repositoryScope:'tenant-A/repository'}),
  procedures:memory.queryProcedural({repositoryScope:'tenant-A/repository'}),
  foreign:memory.queryEpisodic({repositoryScope:'tenant-B/repository'}),
}));
store.close();
