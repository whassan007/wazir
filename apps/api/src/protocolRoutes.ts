import type express from 'express';
import type { Response } from 'express';
import {
  JSONRPC_FORBIDDEN,
  ProtocolError,
  type ProtocolPrincipal,
  type ProtocolRequestContext,
} from '@wazir/core';
import type { ApiAuth } from './auth.js';
import type { ApiState } from './server.js';

/**
 * Registers Agent Protocol (`/ap/v1/*`) and MCP (`/mcp`, `/mcp/v1`) JSON-RPC routes
 * along with malformed-JSON error handling.
 */
export function registerProtocolRoutes(
  app: express.Express,
  state: ApiState,
  auth: ApiAuth,
): void {
  // Agent Protocol (ACP) Standard Endpoints.
  // Authorization matrix: GETs need viewer or operator; every POST (task,
  // step, artifact) needs operator. The service re-checks the principal's
  // scope, so a route added without the middleware still fails closed.
  app.use('/ap/v1', auth.requireProtocolPrincipal);
  const protocolContext = (req: express.Request, res: Response): ProtocolRequestContext => {
    const controller = new AbortController();
    // A client that disconnects mid-execution cancels the dispatched tool.
    res.on('close', () => {
      if (!res.writableFinished) controller.abort();
    });
    return { principal: res.locals.principal as ProtocolPrincipal | undefined, signal: controller.signal };
  };
  const protocolError = (res: Response, err: unknown): void => {
    const code = err instanceof ProtocolError ? err.code : undefined;
    const status =
      code === 'TASK_NOT_FOUND'
        ? 404
        : code === 'TASK_TERMINAL'
          ? 409
          : code === 'FORBIDDEN'
            ? 403
            : code === 'STEP_INVALID'
              ? 400
              : 500;
    res.status(status).json({ error: status === 500 ? 'internal error' : (err as Error).message, code });
  };

  app.post('/ap/v1/agent/tasks', auth.requireOperator, async (req, res) => {
    try {
      const task = await state.editorProtocol.createTask(req.body ?? {}, protocolContext(req, res));
      res.status(201).json(task);
    } catch (err) {
      protocolError(res, err);
    }
  });

  app.get('/ap/v1/agent/tasks', async (_req, res) => {
    const tasks = await state.editorProtocol.listTasks();
    res.json({ tasks, pagination: { total: tasks.length, pages: 1, current: 1, page_size: tasks.length } });
  });

  app.get('/ap/v1/agent/tasks/:task_id', async (req, res) => {
    const task = await state.editorProtocol.getTask(req.params.task_id);
    if (!task) {
      res.status(404).json({ error: `Task not found: ${req.params.task_id}` });
      return;
    }
    res.json(task);
  });

  app.post('/ap/v1/agent/tasks/:task_id/steps', auth.requireOperator, async (req, res) => {
    try {
      const step = await state.editorProtocol.executeStep(
        String(req.params.task_id),
        req.body,
        protocolContext(req, res),
      );
      res.json(step);
    } catch (err) {
      protocolError(res, err);
    }
  });

  app.get('/ap/v1/agent/tasks/:task_id/steps', async (req, res) => {
    try {
      const steps = await state.editorProtocol.listSteps(req.params.task_id);
      res.json({ steps, pagination: { total: steps.length, pages: 1, current: 1, page_size: steps.length } });
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  app.get('/ap/v1/agent/tasks/:task_id/steps/:step_id', async (req, res) => {
    const step = await state.editorProtocol.getStep(req.params.task_id, req.params.step_id);
    if (!step) {
      res.status(404).json({ error: `Step not found: ${req.params.step_id}` });
      return;
    }
    res.json(step);
  });

  app.get('/ap/v1/agent/tasks/:task_id/artifacts', async (req, res) => {
    try {
      const artifacts = await state.editorProtocol.listArtifacts(req.params.task_id);
      res.json({ artifacts });
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  app.post('/ap/v1/agent/tasks/:task_id/artifacts', auth.requireOperator, async (req, res) => {
    try {
      const artifact = await state.editorProtocol.createArtifact(
        String(req.params.task_id),
        req.body ?? {},
        protocolContext(req, res),
      );
      res.status(201).json(artifact);
    } catch (err) {
      protocolError(res, err);
    }
  });

  app.get('/ap/v1/agent/tasks/:task_id/artifacts/:artifact_id', async (req, res) => {
    const artifact = await state.editorProtocol.getArtifact(req.params.task_id, req.params.artifact_id);
    if (!artifact) {
      res.status(404).json({ error: `Artifact not found: ${req.params.artifact_id}` });
      return;
    }
    res.json(artifact);
  });

  // Model Context Protocol (MCP) Server JSON-RPC 2.0 Endpoint. Any valid
  // credential may connect; each JSON-RPC method is then classified on its
  // own (read-only metadata vs. tool execution) against the principal.
  app.use('/mcp', auth.requireProtocolPrincipal);

  const mcpHandler = async (req: express.Request, res: Response) => {
    const response = await state.editorProtocol.handleJsonRpc(req.body, protocolContext(req, res));
    if (response === null) {
      res.status(204).end();
    } else if (response.error?.code === JSONRPC_FORBIDDEN) {
      res.status(403).json(response);
    } else {
      res.json(response);
    }
  };

  app.post('/mcp', mcpHandler);
  app.post('/mcp/v1', mcpHandler);

  // Malformed JSON bodies: JSON-RPC parse error on MCP, plain 400 elsewhere —
  // never Express's default HTML page.
  app.use((err: unknown, req: express.Request, res: Response, next: express.NextFunction) => {
    if ((err as { type?: string })?.type !== 'entity.parse.failed') {
      next(err);
      return;
    }
    if (req.path.startsWith('/mcp')) {
      res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    res.status(400).json({ error: 'malformed JSON body' });
  });
}
