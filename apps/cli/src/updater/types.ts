export type UpdateChannel = 'stable' | 'prerelease' | 'development';
export type UpdatePhase =
  | 'CHECKING' | 'UPDATE_AVAILABLE' | 'DOWNLOADING' | 'VERIFYING' | 'STAGED'
  | 'WAITING_FOR_SAFE_ACTIVATION' | 'INSTALLING' | 'VALIDATING' | 'COMPLETED'
  | 'FAILED' | 'ROLLING_BACK' | 'ROLLED_BACK' | 'ACTION_REQUIRED' | 'UP_TO_DATE';

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
  installedVersion: string;
  availableVersion?: string;
  installMethod?: string;
  message?: string;
  artifact?: string;
  checksum?: string;
  retryAfter?: string;
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
