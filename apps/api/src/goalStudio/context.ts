import type { GoalStudioServices } from '@wazir/goals';
import type { KeyValueStore } from '@wazir/shared';
import type { ApiAuth } from '../auth.js';

/** Coordinator-owned. Services are optional so each route module degrades to 503 until wired. */
export interface GoalStudioRouteContext {
  auth: ApiAuth;
  store: KeyValueStore;
  services: Partial<GoalStudioServices>;
}
