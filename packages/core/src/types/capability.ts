export type ModelCapability =
  | 'generalChat'
  | 'coding'
  | 'reasoning'
  | 'vision'
  | 'audio'
  | 'embedding'
  | 'classification'
  | 'summarization'
  | 'longContext'
  | 'structuredOutput'
  | 'toolCalling'
  | 'agenticExecution'
  | 'research'
  | 'documentAnalysis';

export interface CapabilityDefinition {
  id: string;
  name: string;
  description: string;
  category: CapabilityCategory;
}

export type CapabilityCategory =
  | 'general'
  | 'coding'
  | 'reasoning'
  | 'perception'
  | 'output';

export interface CapabilityRegistry {
  [key: string]: CapabilityDefinition;
}
