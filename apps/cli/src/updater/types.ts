import type { KeyValueStore } from '@wazir/shared';

export type UpdateChannel = 'stable' | 'prerelease' | 'development';
export type UpdatePhase =
  | 'CHECKING' | 'UPDATE_AVAILABLE' | 'DOWNLOADING' | 'VERIFYING' | 'STAGED'
  | 'WAITING_FOR_SAFE_ACTIVATION' | 'INSTALLING' | 'VALIDATING' | 'COMPLETED'
  | 'FAILED' | 'ROLLING_BACK' | 'ROLLED_BACK' | 'ACTION_REQUIRED' | 'UP_TO_DATE';

export type UpdateStatusCode =
  | 'checking'
  | 'update_available'
  | 'downloading'
  | 'verifying'
  | 'staged'
  | 'deferred_busy'
  | 'installing'
  | 'validating'
  | 'completed'
  | 'failed'
  | 'rolling_back'
  | 'rolled_back'
  | 'action_required'
  | 'up_to_date';

export interface ActiveWorkSummary {
  busy: boolean;
  executions: string[];
  jobs: string[];
  dispatches: string[];
  processes: boolean;
  reasons: string[];
}

export type ActiveRecordSource<T = unknown> =
  | Iterable<T>
  | (() => Iterable<T> | Promise<Iterable<T>>)
  | { list: (prefix?: string) => Iterable<T> | Promise<Iterable<T>> };

export interface ActiveTaskDetectorOptions {
  store?: KeyValueStore;
  configDir?: string;
  storePath?: string;
  executions?: ActiveRecordSource;
  jobs?: ActiveRecordSource;
  dispatches?: ActiveRecordSource;
  checkProcesses?: boolean;
  processProbe?: () => boolean;
  isProcessAlive?: (pid: number) => boolean;
  now?: () => number;
}

export interface DrainAndApplyOptions extends ActiveTaskDetectorOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  force?: boolean;
}

export interface UpdateConfig {
  enabled: boolean;
  intervalSeconds: number;
  channel: UpdateChannel;
  automaticDownload: boolean;
  automaticInstall: boolean;
  deferWhileJobsRunning: boolean;
  automaticRollback: boolean;
  verifyArtifacts: true;
  managedFleetRollout: boolean;
  retainPreviousVersions: number;
  releaseRepository: 'whassan007/wazir';
}

export interface UpdateRecord {
  at: string;
  phase: UpdatePhase;
  status?: UpdateStatusCode;
  installedVersion: string;
  availableVersion?: string;
  installMethod?: string;
  message?: string;
  artifact?: string;
  checksum?: string;
  retryAfter?: string;
  deferred?: boolean;
  deferredReason?: string;
  applied?: boolean;
  timedOut?: boolean;
  activeWork?: ActiveWorkSummary;
}

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number;
  digest?: string | null;
}

export interface GitHubRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  html_url: string;
  assets: ReleaseAsset[];
  published_at?: string;
}
