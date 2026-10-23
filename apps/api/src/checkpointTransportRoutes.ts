import express, {
  type Express,
  type Router,
  type Request,
  type Response,
  type NextFunction,
  type RequestHandler,
} from 'express';

export interface CheckpointTransportServiceLike {
  registerManifest(
    manifest: any,
    options?: { authToken?: string },
  ): Promise<{
    checkpointId: string;
    missingBlobHashes: string[];
    deduplicatedBlobHashes: string[];
    alreadyCommitted: boolean;
  }>;
  putBlob(
    blobHash: string,
    content: string,
    options?: { authToken?: string },
  ): Promise<{
    blobHash: string;
    sizeBytes: number;
    deduplicated: boolean;
  }>;
  commitCheckpoint(
    checkpointId: string,
    options?: { authToken?: string; sourceWorkerId?: string },
  ): Promise<any>;
  getBundle(
    checkpointId: string,
    options?: { authToken?: string; requestingWorkerId?: string },
  ): Promise<{
    manifest: any;
    blobs: Record<string, string>;
    receipt: any;
  }>;
}

function extractAuthToken(req: Request): string | undefined {
  const authHeader = req.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.trim().length > 0) {
    return authHeader.trim();
  }
  const customToken = req.headers['x-wazir-transport-token'];
  if (typeof customToken === 'string' && customToken.trim().length > 0) {
    return customToken.trim();
  }
  return undefined;
}

function extractWorkerId(req: Request, bodyField?: string): string | undefined {
  if (bodyField && typeof req.body?.[bodyField] === 'string' && req.body[bodyField].trim()) {
    return req.body[bodyField].trim();
  }
  const queryWorker = req.query.workerId ?? req.query.targetWorkerId;
  if (typeof queryWorker === 'string' && queryWorker.trim()) {
    return queryWorker.trim();
  }
  const headerWorker = req.headers['x-wazir-worker-id'];
  if (typeof headerWorker === 'string' && headerWorker.trim()) {
    return headerWorker.trim();
  }
  return undefined;
}

function mapTransportErrorToStatus(error: unknown): { status: number; code: string; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  const codeMatch = /^([A-Z0-9_]+):/.exec(message);
  const code = codeMatch?.[1] ?? 'CHECKPOINT_TRANSPORT_ERROR';

  switch (code) {
    case 'UNAUTHORIZED_CHECKPOINT_TRANSFER':
      return { status: 401, code, message };
    case 'CHECKPOINT_TARGET_WORKER_MISMATCH':
    case 'CHECKPOINT_WORKER_IDENTITY_MISMATCH':
      return { status: 403, code, message };
    case 'CHECKPOINT_MANIFEST_NOT_FOUND':
    case 'CHECKPOINT_NOT_FOUND':
      return { status: 404, code, message };
    case 'CHECKPOINT_MANIFEST_EXPIRED':
    case 'CHECKPOINT_EXPIRED':
      return { status: 410, code, message };
    case 'CHECKPOINT_FILE_TOO_LARGE':
    case 'CHECKPOINT_SIZE_LIMIT_EXCEEDED':
      return { status: 413, code, message };
    case 'CHECKPOINT_BLOB_HASH_MISMATCH':
    case 'CHECKPOINT_DIGEST_MISMATCH':
    case 'CHECKPOINT_INCOMPLETE_BLOBS':
    case 'CHECKPOINT_BLOB_MISSING':
    case 'UNSAFE_CHECKPOINT_PATH':
    case 'CHECKPOINT_SECRET_DETECTED':
    case 'STALE_CHECKPOINT_RESTORATION':
      return { status: 422, code, message };
    case 'INVALID_CHECKPOINT_MANIFEST':
    case 'INVALID_BLOB_HASH':
    case 'INVALID_BLOB_CONTENT':
    case 'INVALID_CHECKPOINT_FILE':
      return { status: 400, code, message };
    default:
      return { status: 500, code, message };
  }
}

/**
 * Registers remote checkpoint transport HTTP endpoints on an Express application or router:
 * - POST /api/v1/checkpoints/manifests
 * - PUT  /api/v1/checkpoints/blobs/:hash
 * - POST /api/v1/checkpoints/:checkpointId/commit
 * - GET  /api/v1/checkpoints/:checkpointId/bundle
 */
export function registerCheckpointTransportRoutes(
  app: Express,
  transportService: CheckpointTransportServiceLike,
  authMiddleware?: RequestHandler,
): void {
  const passThrough: RequestHandler = (_req, _res, next) => next();
  const auth = authMiddleware ?? passThrough;
  const jsonParser = express.json({ limit: '60mb' });
  const textParser = express.text({ type: ['text/*', 'application/octet-stream'], limit: '15mb' });

  app.post(
    '/api/v1/checkpoints/manifests',
    auth,
    jsonParser,
    async (req: Request, res: Response, _next: NextFunction) => {
      try {
        const manifest = req.body?.manifest ?? req.body;
        const authToken = extractAuthToken(req);
        const result = await transportService.registerManifest(manifest, { authToken });
        res.status(200).json({
          ok: true,
          ...result,
        });
      } catch (error) {
        const mapped = mapTransportErrorToStatus(error);
        res.status(mapped.status).json({
          ok: false,
          code: mapped.code,
          error: mapped.message,
        });
      }
    },
  );

  app.put(
    '/api/v1/checkpoints/blobs/:hash',
    auth,
    jsonParser,
    textParser,
    async (req: Request, res: Response, _next: NextFunction) => {
      try {
        const blobHash = String(req.params.hash ?? '');
        const authToken = extractAuthToken(req);
        let content: string | undefined;
        if (typeof req.body === 'string') {
          content = req.body;
        } else if (Buffer.isBuffer(req.body)) {
          content = req.body.toString('utf8');
        } else if (req.body && typeof req.body.content === 'string') {
          content = req.body.content;
        }

        if (typeof content !== 'string') {
          res.status(400).json({
            ok: false,
            code: 'INVALID_BLOB_CONTENT',
            error: 'INVALID_BLOB_CONTENT: Request body must provide string content',
          });
          return;
        }

        const result = await transportService.putBlob(blobHash, content, { authToken });
        res.status(200).json({
          ok: true,
          ...result,
        });
      } catch (error) {
        const mapped = mapTransportErrorToStatus(error);
        res.status(mapped.status).json({
          ok: false,
          code: mapped.code,
          error: mapped.message,
        });
      }
    },
  );

  app.post(
    '/api/v1/checkpoints/:checkpointId/commit',
    auth,
    jsonParser,
    async (req: Request, res: Response, _next: NextFunction) => {
      try {
        const checkpointId = String(req.params.checkpointId ?? '');
        const authToken = extractAuthToken(req);
        const sourceWorkerId = extractWorkerId(req, 'sourceWorkerId');
        const receipt = await transportService.commitCheckpoint(checkpointId, {
          authToken,
          sourceWorkerId,
        });
        res.status(200).json({
          ok: true,
          receipt,
        });
      } catch (error) {
        const mapped = mapTransportErrorToStatus(error);
        res.status(mapped.status).json({
          ok: false,
          code: mapped.code,
          error: mapped.message,
        });
      }
    },
  );

  app.get(
    '/api/v1/checkpoints/:checkpointId/bundle',
    auth,
    async (req: Request, res: Response, _next: NextFunction) => {
      try {
        const checkpointId = String(req.params.checkpointId ?? '');
        const authToken = extractAuthToken(req);
        const requestingWorkerId = extractWorkerId(req, 'targetWorkerId');
        const bundle = await transportService.getBundle(checkpointId, {
          authToken,
          requestingWorkerId,
        });
        res.status(200).json({
          ok: true,
          manifest: bundle.manifest,
          blobs: bundle.blobs,
          receipt: bundle.receipt,
        });
      } catch (error) {
        const mapped = mapTransportErrorToStatus(error);
        res.status(mapped.status).json({
          ok: false,
          code: mapped.code,
          error: mapped.message,
        });
      }
    },
  );
}
