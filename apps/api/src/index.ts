import express from 'express';
import cors from 'cors';

import { createOllamaAdapter } from '@rook/runtimes-ollama';
import { createLMStudioAdapter } from '@rook/runtimes-lmstudio';
import { createScheduler } from '@rook/scheduler';
import { createModelRouter } from '@rook/models';
import { createPolicyEngine } from '@rook/policies';

const app = express();
app.use(cors());
app.use(express.json());

const scheduler = createScheduler();
const modelRouter = createModelRouter();
const policyEngine = createPolicyEngine();

// Runtime adapters registry
const runtimeAdapters: Record<string, any> = {
  ollama: createOllamaAdapter(),
  lmstudio: createLMStudioAdapter()
};

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Computer endpoints
app.get('/computers', (req, res) => {
  // Return registered computers from database
  res.json([]);
});

app.post('/computers/register', (req, res) => {
  const computer = req.body;
  // Register computer in database
  res.status(201).json(computer);
});

app.post('/computers/:id/heartbeat', (req, res) => {
  const { id } = req.params;
  const heartbeat = req.body;
  // Update computer state
  res.json({ status: 'acknowledged' });
});

// Runtime endpoints
app.get('/runtimes', async (req, res) => {
  try {
    const ollamaHealth = await runtimeAdapters.ollama.healthCheck();
    const lmstudioHealth = await runtimeAdapters.lmstudio.healthCheck();

    res.json({
      ollama: { ...runtimeAdapters.ollama, health: ollamaHealth },
      lmstudio: { ...runtimeAdapters.lmstudio, health: lmstudioHealth }
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to check runtimes' });
  }
});

app.get('/models', async (req, res) => {
  try {
    const models = [];
    
    for (const [runtimeId, adapter] of Object.entries(runtimeAdapters)) {
      const runtimeModels = await adapter.listModels();
      models.push(...runtimeModels.map(m => ({ ...m, runtime: runtimeId })));
    }

    res.json(models);
  } catch (error) {
    res.status(500).json({ error: 'Failed to list models' });
  }
});

// Task endpoints
app.post('/tasks', async (req, res) => {
  const task = req.body;
  
  // Validate policy
  const policyResult = policyEngine.evaluate(task);
  if (!policyResult.valid) {
    return res.status(400).json({ 
      status: 'blocked',
      reason: 'Policy violation',
      details: policyResult.reasons
    });
  }

  // Discover available computers and models (placeholder)
  const computers = [];
  const availableRuntimes = ['ollama', 'lmstudio'];
  const models = [];

  // Run scheduler
  const decision = await scheduler.selectTarget(task, computers, models, availableRuntimes);

  if (decision.score === 0) {
    return res.status(400).json({ 
      status: 'blocked',
      reason: 'No eligible target found',
      details: decision.reasons
    });
  }

  // Schedule execution
  const execution = {
    taskId: task.id,
    computerId: decision.selectedComputer,
    runtimeId: decision.selectedRuntime,
    modelId: decision.selectedModel,
    status: 'queued' as const
  };

  res.status(201).json({
    ...decision,
    execution,
    reasons: decision.reasons
  });
});

app.get('/tasks', (req, res) => {
  // Return tasks from database
  res.json([]);
});

// Execution endpoints
app.post('/executions/:id/cancel', async (req, res) => {
  const { id } = req.params;
  
  try {
    await runtimeAdapters[req.body.runtimeId]?.cancel(id);
    res.json({ status: 'cancelled' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to cancel execution' });
  }
});

app.get('/executions/:id', (req, res) => {
  const { id } = req.params;
  // Return execution from database
  res.json({});
});

// Scheduling endpoints
app.post('/tasks/plan', async (req, res) => {
  const task = req.body;

  const computers = [];
  const availableRuntimes = ['ollama', 'lmstudio'];
  const models = [];

  const decision = await scheduler.selectTarget(task, computers, models, availableRuntimes);

  res.json({
    plan: decision,
    taskRequirements: task.requirements
  });
});

// Benchmark endpoints
app.post('/benchmark/run', async (req, res) => {
  // Run benchmark on specified computer/model/runtime
  const result = {
    benchmarkId: 'bench-123',
    results: []
  };
  
  res.status(202).json(result);
});

app.get('/benchmarks', (req, res) => {
  // Return benchmark history from database
  res.json([]);
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Meta-Harness API server running on port ${PORT}`);
});
