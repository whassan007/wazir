export type SymbolKind =
  | 'file'
  | 'module'
  | 'namespace'
  | 'package'
  | 'class'
  | 'method'
  | 'property'
  | 'field'
  | 'constructor'
  | 'enum'
  | 'interface'
  | 'function'
  | 'variable'
  | 'constant'
  | 'string'
  | 'number'
  | 'boolean'
  | 'array'
  | 'object'
  | 'key'
  | 'null'
  | 'enumMember'
  | 'struct'
  | 'event'
  | 'operator'
  | 'typeParameter'
  | 'typeAlias';

export interface SymbolPosition {
  line: number;
  character: number;
}

export interface SymbolRange {
  start: SymbolPosition;
  end: SymbolPosition;
}

export interface SymbolLocation {
  file: string;
  range: SymbolRange;
  preview?: string;
}

export interface SymbolNode {
  id: string;
  name: string;
  kind: SymbolKind;
  language: string;
  file: string;
  range: SymbolRange;
  package?: string;
  detail?: string;
  containerName?: string;
  docstring?: string;
  signature?: string;
}

export type SymbolEdgeType =
  | 'DEFINES'
  | 'REFERENCES'
  | 'CALLS'
  | 'IMPLEMENTS'
  | 'EXTENDS'
  | 'IMPORTS'
  | 'EXPORTS'
  | 'TESTS'
  | 'DEPENDS_ON';

export interface SymbolEdge {
  from: string;
  to: string;
  type: SymbolEdgeType;
  metadata?: Record<string, unknown>;
}

export interface DiagnosticItem {
  file: string;
  range: SymbolRange;
  message: string;
  severity: 'error' | 'warning' | 'info' | 'hint';
  code?: number | string;
  source?: string;
}

export interface CodeIntelligenceQuery {
  file?: string;
  name?: string;
  kind?: SymbolKind;
  package?: string;
}
