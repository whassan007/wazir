import { describe, expect, it } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { LMStudioAdapter } from '../../packages/runtimes/lmstudio/src/index.js';
const chunk = (delta: object, finish_reason: string | null = null) => `data: ${JSON.stringify({choices:[{delta,finish_reason}]})}\n\n`;
async function fixture(handler: (res: ServerResponse, attempt: number) => void, test: (adapter: LMStudioAdapter, attempts: () => number) => Promise<void>) {
  let attempts=0;
  const server=createServer((req,res)=>{req.resume();handler(res,++attempts);});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  try {await test(new LMStudioAdapter(`http://127.0.0.1:${(server.address() as any).port}/v1`),()=>attempts);}
  finally {server.closeAllConnections();server.close();await once(server,'close');}
}
async function collect(adapter: LMStudioAdapter) {
  const events=[];
  for await (const e of adapter.generate({modelId:'fault-fixture',requestId:'fault',messages:[],providerRetryPolicy:{maxRetries:2,initialDelayMs:1,maxDelayMs:2,jitter:0}}))events.push(e);
  return events;
}
describe('real socket provider faults (deterministic protocol, not live inference)',()=>{
  it.each([429,500,503])('B14: recovers HTTP %s once, with observable retry',async status=>{
    await fixture((res,n)=>{if(n===1){res.writeHead(status);res.end('temporary');}else{res.writeHead(200,{'content-type':'text/event-stream'});res.end(chunk({content:'42'},'stop')+'data: [DONE]\n\n');}},async(adapter,attempts)=>{
      const events=await collect(adapter);expect(attempts()).toBe(2);expect(events.filter(e=>e.type==='retry')).toHaveLength(1);expect(events.at(-1)).toMatchObject({type:'completed',content:'42'});
    });
  });
  it('bounds persistent HTTP 500 to three requests',async()=>{
    await fixture(res=>{res.writeHead(500);res.end('unavailable');},async(adapter,attempts)=>{const events=await collect(adapter);expect(attempts()).toBe(3);expect(events.at(-1)).toMatchObject({type:'error',retryExhausted:true});});
  });
  it.each(['reset','partial','invalid-json'])('B15: %s is observable failure, never success or blind replay',async fault=>{
    await fixture(res=>{
      res.writeHead(200,{'content-type':'text/event-stream'});
      res.write(fault==='invalid-json'?'data: {invalid}\n\n':chunk({content:'partial'}));
      if(fault==='reset')setTimeout(()=>res.destroy(),20);else res.end();
    },async(adapter,attempts)=>{const events=await collect(adapter);expect(events.some(e=>e.type==='completed')).toBe(false);expect(events.at(-1)?.type).toBe('error');expect(attempts()).toBe(1);});
  });
  it('cancels a slow connected server without waiting for a response',async()=>{
    await fixture(()=>{},async(adapter,attempts)=>{const pending=collect(adapter);await new Promise(r=>setTimeout(r,30));await adapter.cancel('fault');const events=await pending;expect(attempts()).toBe(1);expect(events.at(-1)).toMatchObject({type:'error',failureClass:'CANCELLED'});});
  });
});
