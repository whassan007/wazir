import type { Express } from 'express';
import type { GoalStudioRouteContext } from './context.js';
import { registerGraphRoutes } from './graphRoutes.js';
import { registerControlRoutes } from './controlRoutes.js';
import { registerPromptRoutes } from './promptRoutes.js';
import { registerFleetRoutes } from './fleetRoutes.js';
import { registerVerificationRoutes } from './verificationRoutes.js';
import { registerGovernanceRoutes } from './governanceRoutes.js';

export type { GoalStudioRouteContext } from './context.js';
export {
  createGoalStudioServices,
  type CreateGoalStudioServicesOptions,
  type WiredGoalStudioServices,
} from './services.js';

// Coordinator-owned composition point for Goal Studio HTTP routes.
export function registerGoalStudioRoutes(app: Express, ctx: GoalStudioRouteContext): void {
  registerGraphRoutes(app, ctx);
  registerControlRoutes(app, ctx);
  registerPromptRoutes(app, ctx);
  registerFleetRoutes(app, ctx);
  registerVerificationRoutes(app, ctx);
  registerGovernanceRoutes(app, ctx);
}
