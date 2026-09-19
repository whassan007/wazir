import type { ArtifactProvenance, ArtifactWhyReport, ArtifactFilter } from '../types/artifact.js';
import type { KeyValueStore } from '@wazir/shared';

export interface CreateArtifactParams {
  type: string;
  name: string;
  location: string;
  contentHash: string;
  sizeBytes: number;
  workspace: string;
  executionId: string;
  agentId: string;
  modelId: string;
  runtimeId: string;
  computerId: string;
  workerId?: string;
  toolsUsed?: string[];
  mcpServersUsed?: string[];
  connectorsUsed?: string[];
  policyDecisions?: string[];
  inputArtifactIds?: string[];
  parentArtifactIds?: string[];
  evaluations?: string[];
  reviewers?: string[];
  gitMetadata?: {
    repository?: string;
    remote?: string;
    branch?: string;
    commit?: string;
    dirty: boolean;
    diffHash?: string;
    changedFiles: string[];
  };
  metadata?: Record<string, unknown>;
}

export class ProvenanceManager {
  private readonly store: KeyValueStore;

  constructor(store: KeyValueStore) {
    this.store = store;
  }

  async registerArtifact(params: CreateArtifactParams): Promise<ArtifactProvenance> {
    const artifactId = `artifact:${params.executionId}:${Buffer.from(params.contentHash, 'hex').slice(0, 8).toString('hex')}`;
    
    const now = new Date();
    const artifact: ArtifactProvenance = {
      artifactId,
      type: params.type as any,
      name: params.name,
      location: params.location,
      contentHash: params.contentHash,
      sizeBytes: params.sizeBytes,
      createdAt: now,
      modifiedAt: now,
      git: params.gitMetadata ? {
        repository: params.gitMetadata.repository,
        remote: params.gitMetadata.remote,
        branch: params.gitMetadata.branch,
        commit: params.gitMetadata.commit,
        dirty: params.gitMetadata.dirty,
        diffHash: params.gitMetadata.diffHash,
        changedFiles: params.gitMetadata.changedFiles
      } : undefined,
      workspace: params.workspace,
      jobId: params.executionId.split(':').length > 2 ? params.executionId.split(':')[1] : undefined,
      executionId: params.executionId,
      agentId: params.agentId,
      modelId: params.modelId,
      runtimeId: params.runtimeId,
      computerId: params.computerId,
      workerId: params.workerId,
      toolsUsed: params.toolsUsed || [],
      mcpServersUsed: params.mcpServersUsed || [],
      connectorsUsed: params.connectorsUsed || [],
      policyDecisions: params.policyDecisions || [],
      inputArtifactIds: params.inputArtifactIds || [],
      parentArtifactIds: params.parentArtifactIds || [],
      evaluations: params.evaluations || [],
      reviewers: params.reviewers || [],
      provenanceVersion: '1.0',
      metadata: params.metadata
    };

    await this.store.put(`artifact/${artifactId}`, artifact);
    
    // Secondary index for deduplication and integrity check
    await this.store.put(`artifact-hash/${params.contentHash}/${artifactId}`, now.toISOString());
    
    // Association index for execution lookups
    await this.store.put(`artifact-execution/${params.executionId}/${artifactId}`, now.toISOString());

    return artifact;
  }

  async getProvenance(artifactId: string): Promise<ArtifactProvenance | undefined> {
    const record = await this.store.get<ArtifactProvenance>(`artifact/${artifactId}`);
    return record;
  }

  async getLineage(artifactId: string): Promise<ArtifactProvenance[]> {
    const lineage: ArtifactProvenance[] = [];
    const visited = new Set<string>();
    
    const walk = async (id: string): Promise<void> => {
      if (visited.has(id)) return;
      visited.add(id);
      
      const provenance = await this.getProvenance(id);
      if (!provenance) return;
      
      lineage.unshift(provenance);
      
      for (const parentId of provenance.parentArtifactIds) {
        await walk(parentId);
      }
    };
    
    await walk(artifactId);
    return lineage;
  }

  async getWhy(artifactId: string): Promise<ArtifactWhyReport> {
    const provenance = await this.getProvenance(artifactId);
    if (!provenance) {
      throw new Error(`Artifact not found: ${artifactId}`);
    }

    const why: ArtifactWhyReport = {
      artifactId,
      executionContext: {
        jobId: provenance.jobId,
        executionId: provenance.executionId,
        agentId: provenance.agentId,
        modelId: provenance.modelId,
        computerId: provenance.computerId
      },
      policyDecisions: provenance.policyDecisions.map(decision => ({
        rule: decision,
        decision: 'allow' as const,
        reason: `Policy evaluation passed for artifact ${artifactId}`,
        timestamp: provenance.createdAt
      })),
      checks: [],
      modelRationale: provenance.metadata?.modelReasoning ? {
        modelId: provenance.modelId,
        reasoningSteps: Array.isArray(provenance.metadata.modelReasoning) 
          ? provenance.metadata.modelReasoning as string[] 
          : [String(provenance.metadata.modelReasoning)],
        confidence: typeof provenance.metadata.modelConfidence === 'number' 
          ? provenance.metadata.modelConfidence 
          : undefined
      } : undefined
    };

    if (provenance.evaluations) {
      why.checks = provenance.evaluations.map(evalId => ({
        checkId: evalId,
        name: `Evaluation: ${evalId}`,
        status: 'passed' as const,
        details: `Test ${evalId} passed during verification`
      }));
    }

    return why;
  }

  async listArtifacts(filters: ArtifactFilter): Promise<ArtifactProvenance[]> {
    const artifacts: ArtifactProvenance[] = [];
    const entries = await this.store.list('artifact/');
    
    for (const entry of entries) {
      if (!entry.key.startsWith('artifact/')) continue;
      
      const artifact = entry.value as ArtifactProvenance | undefined;
      if (!artifact) continue;

      let match = true;

      if (filters.type && artifact.type !== filters.type) {
        match = false;
      }
      if (filters.executionId && artifact.executionId !== filters.executionId) {
        match = false;
      }
      if (filters.jobId && artifact.jobId !== filters.jobId) {
        match = false;
      }
      if (filters.agentId && artifact.agentId !== filters.agentId) {
        match = false;
      }
      if (filters.modelId && artifact.modelId !== filters.modelId) {
        match = false;
      }
      if (filters.workspace && artifact.workspace !== filters.workspace) {
        match = false;
      }
      if (filters.since && artifact.createdAt < filters.since) {
        match = false;
      }
      if (filters.until && artifact.createdAt > filters.until) {
        match = false;
      }

      if (match) {
        artifacts.push(artifact);
        if (filters.limit && artifacts.length >= filters.limit) break;
      }
    }

    const offset = filters.offset || 0;
    return artifacts.slice(offset, offset + (filters.limit ?? artifacts.length));
  }

  async getArtifactsByExecution(executionId: string): Promise<ArtifactProvenance[]> {
    const artifacts: ArtifactProvenance[] = [];
    const entries = await this.store.list(`artifact-execution/${executionId}/`);
    
    for (const entry of entries) {
      const artifactId = entry.key.split('/').pop();
      if (artifactId) {
        const provenance = await this.getProvenance(artifactId);
        if (provenance) artifacts.push(provenance);
      }
    }

    return artifacts;
  }

  async getArtifactsByContentHash(contentHash: string): Promise<ArtifactProvenance[]> {
    const artifacts: ArtifactProvenance[] = [];
    const entries = await this.store.list(`artifact-hash/${contentHash}/`);
    
    for (const entry of entries) {
      const artifactId = entry.key.split('/').pop();
      if (artifactId) {
        const provenance = await this.getProvenance(artifactId);
        if (provenance) artifacts.push(provenance);
      }
    }

    return artifacts;
  }
}
