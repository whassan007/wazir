import { randomUUID } from 'node:crypto';
import type { RuntimeAdapter, GenerationRequest, GenerationEvent } from '@wazir/runtimes-interfaces';
import type {
  ImprovementOpportunity,
  ImprovementHypothesis,
  ConfigMutation,
  SelfImprovementDomain,
  MeasurableMetricName,
} from '@wazir/core';

export interface ModelOptimizationHelperOptions {
  adapter: RuntimeAdapter;
  defaultModelId: string;
  timeoutMs?: number;
}

export class LocalModelOptimizerHelper {
  private readonly adapter: RuntimeAdapter;
  private readonly defaultModelId: string;
  private readonly timeoutMs: number;

  constructor(options: ModelOptimizationHelperOptions) {
    this.adapter = options.adapter;
    this.defaultModelId = options.defaultModelId;
    this.timeoutMs = options.timeoutMs ?? 45_000;
  }

  /**
   * Queries the local model to analyze failure telemetry and formulate a testable hypothesis.
   */
  async formulateHypothesis(
    opportunity: ImprovementOpportunity,
    modelId?: string,
  ): Promise<ImprovementHypothesis | null> {
    const targetModel = modelId ?? this.defaultModelId;
    const prompt = [
      'You are Wazir\'s autonomous meta-optimization intelligence analyzing empirical execution telemetry.',
      `An opportunity for improvement was detected in component "${opportunity.component}":`,
      `- Category: ${opportunity.category}`,
      `- Domain: ${opportunity.domain}`,
      `- Target metric: ${opportunity.metric}`,
      `- Baseline value: ${opportunity.baseline}`,
      `- Evidence count: ${opportunity.evidence}`,
      '',
      'Formulate a precise, testable self-improvement hypothesis with concrete configuration or prompt mutations.',
      'Respond ONLY with a valid JSON object strictly matching this schema:',
      '{',
      '  "proposedChange": "concise description of the specific mutation or prompt refinement",',
      '  "domain": "routing" | "tool_surfaces" | "prompts" | "context_policy" | "orchestration" | "wazir_source_code",',
      '  "expectedMetric": "name of primary metric to improve",',
      '  "expectedDelta": -0.25,',
      '  "direction": "decrease" | "increase",',
      '  "possibleRegressions": ["wall_time", "task_success"],',
      '  "configMutations": [',
      '    {',
      '      "type": "PROMPT_TWEAK" | "WEIGHT_ADJUSTMENT" | "TOOL_SURFACE_MODIFICATION" | "ROUTING_RULE",',
      '      "path": "prompts.repairGuidance" | "contextWeights.recencyRelevance" | "toolPolicies.phaseToolSurfaces.plan" | string,',
      '      "newValue": "string or number or array of strings",',
      '      "rationale": "reason for this specific mutation"',
      '    }',
      '  ]',
      '}',
    ].join('\n');

    const rawResponse = await this.callModel(prompt, targetModel);
    if (!rawResponse) return null;

    try {
      const parsed = this.parseJsonBlock(rawResponse);
      if (!parsed || typeof parsed !== 'object') return null;

      const proposedChange = String(parsed.proposedChange ?? '').trim();
      if (!proposedChange) return null;

      const validDomains: SelfImprovementDomain[] = [
        'routing',
        'tool_surfaces',
        'context_policy',
        'prompts',
        'orchestration',
        'wazir_source_code',
      ];
      const domain: SelfImprovementDomain = validDomains.includes(parsed.domain)
        ? parsed.domain
        : opportunity.domain;

      const expectedDelta = typeof parsed.expectedDelta === 'number' ? parsed.expectedDelta : -0.2;
      const direction: 'decrease' | 'increase' = parsed.direction === 'increase' ? 'increase' : 'decrease';
      const metric: MeasurableMetricName = (parsed.expectedMetric ?? opportunity.metric) as MeasurableMetricName;

      const configMutations: ConfigMutation[] = Array.isArray(parsed.configMutations)
        ? parsed.configMutations.map((m: any) => ({
            type: m.type ?? 'PROMPT_TWEAK',
            path: String(m.path ?? 'prompts.repairGuidance'),
            oldValue: m.oldValue ?? undefined,
            newValue: m.newValue ?? 'Verified repair oracle requirement',
            rationale: String(m.rationale ?? proposedChange),
          }))
        : [];

      return {
        id: `hyp-${randomUUID().slice(0, 8)}`,
        opportunityId: opportunity.id,
        targetComponent: opportunity.component,
        domain,
        proposedChange,
        expectedMetricEffect: {
          metric,
          expectedDelta,
          direction,
        },
        possibleRegressions: Array.isArray(parsed.possibleRegressions)
          ? parsed.possibleRegressions
          : ['wall_time', 'task_success'],
        requiredBenchmark: [opportunity.domain.toUpperCase()],
        successThreshold: direction === 'decrease'
          ? opportunity.baseline * (1 + expectedDelta)
          : opportunity.baseline * (1 + Math.abs(expectedDelta)),
        configMutations,
      };
    } catch {
      return null;
    }
  }

  /**
   * Queries the local model to generate candidate mutations for a given hypothesis.
   */
  async generateCandidateMutations(
    hypothesis: ImprovementHypothesis,
    modelId?: string,
  ): Promise<ConfigMutation[] | null> {
    const targetModel = modelId ?? this.defaultModelId;
    const prompt = [
      'You are Wazir\'s autonomous meta-optimization intelligence synthesizing configuration mutations.',
      `Hypothesis: ${hypothesis.proposedChange}`,
      `Target Component: ${hypothesis.targetComponent}`,
      `Domain: ${hypothesis.domain}`,
      `Primary Goal: ${hypothesis.expectedMetricEffect.direction} ${hypothesis.expectedMetricEffect.metric}`,
      '',
      'Generate 1 to 3 surgical configuration mutations that directly implement this hypothesis.',
      'Respond ONLY with a valid JSON array of mutations:',
      '[',
      '  {',
      '    "type": "PROMPT_TWEAK" | "WEIGHT_ADJUSTMENT" | "TOOL_SURFACE_MODIFICATION" | "ROUTING_RULE",',
      '    "path": "configuration property path (e.g. prompts.repairGuidance)",',
      '    "newValue": "refined prompt text, numeric weight, or allowed tool string array",',
      '    "rationale": "concise explanation of why this mutation achieves the objective"',
      '  }',
      ']',
    ].join('\n');

    const rawResponse = await this.callModel(prompt, targetModel);
    if (!rawResponse) return null;

    try {
      const parsed = this.parseJsonBlock(rawResponse);
      if (!Array.isArray(parsed)) return null;

      return parsed.map((m: any) => ({
        type: m.type ?? 'PROMPT_TWEAK',
        path: String(m.path ?? 'prompts.repairGuidance'),
        oldValue: m.oldValue ?? undefined,
        newValue: m.newValue ?? 'Strict oracle verification required.',
        rationale: String(m.rationale ?? hypothesis.proposedChange),
      }));
    } catch {
      return null;
    }
  }

  private async callModel(prompt: string, modelId: string): Promise<string | null> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.timeoutMs);

    const req: GenerationRequest = {
      modelId,
      messages: [
        {
          role: 'system',
          content: 'You are an autonomous meta-optimization engineer. Always output strict valid JSON.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      temperature: 0.2,
      maxTokens: 1024,
      stream: true,
    };

    let result = '';
    try {
      for await (const event of this.adapter.generate(req)) {
        if (abort.signal.aborted) break;
        if (event.type === 'token' && event.content) {
          result += event.content;
        } else if (event.type === 'completed' && event.content) {
          if (!result) result = event.content;
        } else if (event.type === 'error') {
          return null;
        }
      }
      return result.trim() || null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private parseJsonBlock(text: string): any {
    // 1. Try direct parse
    try {
      return JSON.parse(text);
    } catch {
      // 2. Extract from markdown code fences
      const match = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
      if (match) {
        try {
          return JSON.parse(match[1]);
        } catch {
          // fall through
        }
      }
      // 3. Extract bracketed substring
      const startObj = text.indexOf('{');
      const endObj = text.lastIndexOf('}');
      if (startObj !== -1 && endObj !== -1 && endObj > startObj) {
        try {
          return JSON.parse(text.substring(startObj, endObj + 1));
        } catch {
          // fall through
        }
      }
      const startArr = text.indexOf('[');
      const endArr = text.lastIndexOf(']');
      if (startArr !== -1 && endArr !== -1 && endArr > startArr) {
        try {
          return JSON.parse(text.substring(startArr, endArr + 1));
        } catch {
          // fall through
        }
      }
      return null;
    }
  }
}
