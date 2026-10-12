import { describe, expect, it } from 'vitest';
import { CanaryDeploymentService } from '@wazir/evaluation';
import { DEFAULT_OPTIMIZABLE_CONFIG } from '../../../packages/evaluation/src/metaOptimizerService.js';
import { MemoryStore } from '@wazir/shared';
import { canaryControlCommand, canaryInspectCommand, canaryRollbackCommand, canaryStatusCommand } from '../src/commands.js';

async function fixture() {
  const store = new MemoryStore();
  const service = new CanaryDeploymentService({ store });
  const record = await service.registerCanary({
    candidateId: 'candidate-1', candidateConfig: DEFAULT_OPTIMIZABLE_CONFIG,
    baselineConfig: DEFAULT_OPTIMIZABLE_CONFIG, domain: 'routing', qualificationStatus: 'QUALIFIED',
  });
  const engine = { optimizer: { getCanaryDeploymentService: () => service } } as any;
  return { service, record, engine, store };
}

describe('canary operator CLI', () => {
  it('reports status and inspection as plain JSON', async () => {
    const { engine, record } = await fixture();
    expect(JSON.parse(await canaryStatusCommand(engine, { json: true })).canaryId).toBe(record.canaryId);
    expect(JSON.parse(await canaryInspectCommand(engine, record.canaryId, { json: true })).candidateId).toBe('candidate-1');
    expect(await canaryInspectCommand(engine, 'missing', { json: true })).toContain('not found');
  });

  it('pauses, resumes, throttles, and advances one stage with persisted audit events', async () => {
    const { engine, service, record, store } = await fixture();
    const id = record.canaryId;
    expect(JSON.parse(await canaryControlCommand(engine, 'pause', id, { json: true })).status).toBe('PAUSED');
    expect(service.assignExecution({ canaryId: id, executionId: 'paused' }).assignedVariant).toBe('baseline');
    await expect(canaryControlCommand(engine, 'advance', id)).rejects.toThrow('Cannot advance');
    expect(JSON.parse(await canaryControlCommand(engine, 'resume', id, { json: true })).status).toBe('ACTIVE');
    expect(JSON.parse(await canaryControlCommand(engine, 'throttle', id, { percentage: '0.5', json: true })).currentAllocation).toBe(0.005);
    expect(JSON.parse(await canaryControlCommand(engine, 'advance', id, { json: true })).stage).toBe('CANARY_5');
    expect((await store.list('canary/events/')).length).toBe(4);
    const event = (await store.list('canary/events/'))[0].value as any;
    expect(event.data).toMatchObject({ candidate: 'candidate-1', previousState: 'ACTIVE', requestedAction: 'pause', resultingState: 'PAUSED', source: 'operator:cli' });
    expect(event.data.timestamp).toBeTruthy();
    const reloaded = new CanaryDeploymentService({ store });
    await reloaded.hydrate();
    expect(reloaded.getDeployment(id)?.stage).toBe('CANARY_5');
  });

  it('rejects invalid ids, percentages, stages, and terminal transitions', async () => {
    const { engine, service, record } = await fixture();
    await expect(canaryControlCommand(engine, 'pause', 'missing')).rejects.toThrow('not found');
    for (const percentage of ['0', '-1', 'abc', '2']) {
      await expect(canaryControlCommand(engine, 'throttle', record.canaryId, { percentage })).rejects.toThrow();
    }
    record.stage = 'CANARY_25';
    await expect(canaryControlCommand(engine, 'advance', record.canaryId)).rejects.toThrow('Cannot advance');
    record.stage = 'CANARY_1';
    expect(JSON.parse(await canaryRollbackCommand(engine, record.canaryId, { json: true })).status).toBe('ROLLED_BACK');
    await expect(canaryControlCommand(engine, 'resume', record.canaryId)).rejects.toThrow('Cannot resume');
    await expect(canaryControlCommand(engine, 'advance', record.canaryId)).rejects.toThrow('Cannot advance');
    expect(service.getDeployment(record.canaryId)?.currentAllocation).toBe(0);
    record.status = 'CANARY_FAILED';
    await expect(canaryControlCommand(engine, 'advance', record.canaryId)).rejects.toThrow('Cannot advance');
  });

  it('advances through 1, 5, 10, 25, and 50 percent without skipping', async () => {
    const { engine, record } = await fixture();
    for (const stage of ['CANARY_5', 'CANARY_10', 'CANARY_25', 'CANARY_50']) {
      expect(JSON.parse(await canaryControlCommand(engine, 'advance', record.canaryId, { json: true })).stage).toBe(stage);
    }
    await expect(canaryControlCommand(engine, 'advance', record.canaryId)).rejects.toThrow('Cannot advance');
  });

  it('retains the domain restriction for operator controls', async () => {
    const { engine, record } = await fixture();
    record.domain = 'wazir_source_code';
    await expect(canaryControlCommand(engine, 'pause', record.canaryId)).rejects.toThrow('CANARY_DOMAIN_RESTRICTION');
    await expect(canaryRollbackCommand(engine, record.canaryId)).rejects.toThrow('CANARY_DOMAIN_RESTRICTION');
  });
});
