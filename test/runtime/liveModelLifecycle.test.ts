import { describe, it, expect, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { ModelLifecycleService, ModelLifecycleError } from '@wazir/core';
import { createEngine } from '../../apps/cli/src/engine.js';

const GiB = 1024 ** 3;

describe.skipIf(process.env.WAZIR_QUALIFY_MODEL_LIFECYCLE !== '1')('live model lifecycle', () => {
  it('admits and serves a small model, drains it, and denies an impossible load before allocation', async () => {
    const engine = await createEngine({ quiet: true, readOnlyLifecycle: true });
    const runtime = engine.runtimes.get('lmstudio');
    if (runtime?.health !== 'healthy') throw new Error('LM Studio is unavailable for live qualification');
    const computer = engine.computers.get(runtime.computerId!);
    if (!computer || computer.hardware.gpu?.vendor !== 'nvidia') throw new Error('NVIDIA qualification target unavailable');

    const candidate = engine.models.listInstallations()
      .filter(installation => installation.runtimeId === runtime.id && installation.computerId === computer.id && installation.installed)
      .filter(installation => !engine.models.instancesOf(installation.modelId).some(instance => instance.loaded))
      .filter(installation => {
        const model = engine.models.get(installation.modelId);
        const bytes = installation.profile?.weightBytes;
        return model && !model.embedding && model.contextMax >= 4096 && bytes !== undefined && bytes >= 2 * GiB && bytes <= 10 * GiB;
      })
      .sort((a, b) => (a.profile?.weightBytes ?? Infinity) - (b.profile?.weightBytes ?? Infinity))[0];
    if (!candidate) throw new Error('No unloaded 2–10 GiB generative model is installed for qualification');

    const adapter = engine.adapters.get(runtime.id)!;
    const originalLoad = adapter.loadModel!.bind(adapter);
    const loadSpy = vi.spyOn(adapter, 'loadModel').mockImplementation(originalLoad);
    const originalUnload = adapter.unloadModel!.bind(adapter);
    const unloadSpy = vi.spyOn(adapter, 'unloadModel').mockImplementation(originalUnload);
    const context = 4096;
    const before = engine.computers.resourceSnapshot(computer.id);
    const reserveGiB = Math.max(0, Math.floor((before.availableMemoryBytes ?? 0) / GiB) - 1);
    const protectedLifecycle = new ModelLifecycleService({
      models: engine.models, runtimes: engine.runtimes, computers: engine.computers,
      adapters: engine.adapters, policy: engine.policy, store: engine.store,
      resources: { minimumReserveGiB: reserveGiB },
    });
    const evidence: Record<string, unknown> = {
      computer: computer.id,
      gpu: computer.hardware.gpu?.model,
      unifiedMemory: before.unifiedMemory,
      availableMemoryGiB: (before.availableMemoryBytes ?? 0) / GiB,
      modelId: candidate.modelId,
      originallyLoaded: false,
      context,
    };

    try {
      const denied = await protectedLifecycle.load(candidate.modelId, { computerId: computer.id, runtimeId: runtime.id, context })
        .then(() => undefined, error => error as ModelLifecycleError);
      expect(denied).toBeInstanceOf(ModelLifecycleError);
      expect(denied.code).toBe('MODEL_ADMISSION_DENIED');
      expect(denied.reasons).toContain('INSUFFICIENT_MEMORY');
      expect(loadSpy).toHaveBeenCalledTimes(0);
      evidence.impossibleLoad = {
        code: denied.code, reasons: denied.reasons, runtimeLoadCalls: loadSpy.mock.calls.length,
        estimateSource: denied.plan?.estimate.estimateSource,
        requiredGiB: (denied.plan?.estimate.estimatedTotalMemory ?? 0) / GiB,
        usableGiB: (denied.plan?.estimate.usableMemory ?? 0) / GiB,
      };

      const plan = await engine.lifecycle.load(candidate.modelId, { computerId: computer.id, runtimeId: runtime.id, context });
      expect(plan.admissionDecision.status).toBe('ADMITTED');
      expect(engine.models.isModelReady(candidate.modelId)).toBe(true);
      expect(engine.models.instancesOf(candidate.modelId).find(instance => instance.computerId === computer.id)?.contextTokens).toBe(context);
      evidence.safeLoad = { state: 'READY', runtimeLoadCalls: loadSpy.mock.calls.length, estimateSource: plan.estimate.estimateSource };

      const task = { id: `qualification-${Date.now()}`, requirements: { minimumContext: context } } as never;
      const record = await engine.executions.create({ task, modelId: candidate.modelId, runtimeId: runtime.id, computerId: computer.id });
      expect(await engine.lifecycle.activateExecution(record.execution.id, context)).toBe(context);
      let completed = false;
      for await (const event of adapter.generate({
        modelId: candidate.runtimeModelId, messages: [{ role: 'user', content: 'Reply OK.' }],
        contextTokens: context, maxTokens: 1, stream: true,
      })) {
        if (event.type === 'completed') completed = true;
        if (event.type === 'error') throw new Error(event.error);
      }
      expect(completed).toBe(true);
      expect(record.events.some(event => event.type === 'WAITING_FOR_MODEL')).toBe(true);
      evidence.taskExecution = { taskId: record.execution.taskId, executionId: record.execution.id, completed };

      await expect(engine.lifecycle.unload(candidate.modelId, { computerId: computer.id, runtimeId: runtime.id }))
        .rejects.toMatchObject({ code: 'MODEL_IN_USE' });
      const drain = engine.lifecycle.unload(candidate.modelId, { computerId: computer.id, runtimeId: runtime.id, drain: true });
      await vi.waitFor(() => expect(engine.models.getModelState(candidate.modelId)).toBe('DRAINING'));
      await engine.executions.setStatus(record.execution.id, 'completed');
      await drain;
      expect(unloadSpy).toHaveBeenCalledTimes(1);
      await engine.lifecycle.reconcile();
      expect(engine.models.instancesOf(candidate.modelId).find(instance => instance.computerId === computer.id)?.loaded).toBe(false);
      evidence.unload = { state: 'UNLOADED', runtimeUnloadCalls: unloadSpy.mock.calls.length, reconciled: true };
    } finally {
      const observed = await adapter.inspectModel?.(candidate.runtimeModelId).catch(() => undefined);
      if (observed?.loaded) await engine.lifecycle.unload(candidate.modelId, { computerId: computer.id, runtimeId: runtime.id }).catch(() => undefined);
      if (process.env.WAZIR_QUALIFY_REPORT) await writeFile(process.env.WAZIR_QUALIFY_REPORT, JSON.stringify(evidence, null, 2));
    }
  }, 180_000);
});
