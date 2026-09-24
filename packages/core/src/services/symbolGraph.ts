import type {
  SymbolEdge,
  SymbolEdgeType,
  SymbolNode,
} from '../types/codeIntelligence.js';

/**
 * SymbolGraph stores nodes and directed typed edges representing code symbols,
 * relationships, calls, implementations, tests, and dependencies.
 */
export class SymbolGraph {
  private readonly nodes = new Map<string, SymbolNode>();
  private readonly edges: SymbolEdge[] = [];
  private readonly fileToNodes = new Map<string, Set<string>>();
  private readonly nameToNodes = new Map<string, Set<string>>();

  addNode(node: SymbolNode): void {
    // If node already exists, clean up index maps
    if (this.nodes.has(node.id)) {
      this.removeNode(node.id);
    }

    this.nodes.set(node.id, node);

    let fileSet = this.fileToNodes.get(node.file);
    if (!fileSet) {
      fileSet = new Set();
      this.fileToNodes.set(node.file, fileSet);
    }
    fileSet.add(node.id);

    let nameSet = this.nameToNodes.get(node.name);
    if (!nameSet) {
      nameSet = new Set();
      this.nameToNodes.set(node.name, nameSet);
    }
    nameSet.add(node.id);
  }

  removeNode(id: string): void {
    const node = this.nodes.get(id);
    if (!node) return;

    this.nodes.delete(id);

    const fileSet = this.fileToNodes.get(node.file);
    if (fileSet) {
      fileSet.delete(id);
      if (fileSet.size === 0) this.fileToNodes.delete(node.file);
    }

    const nameSet = this.nameToNodes.get(node.name);
    if (nameSet) {
      nameSet.delete(id);
      if (nameSet.size === 0) this.nameToNodes.delete(node.name);
    }

    // Remove any edges touching this node
    for (let i = this.edges.length - 1; i >= 0; i--) {
      if (this.edges[i].from === id || this.edges[i].to === id) {
        this.edges.splice(i, 1);
      }
    }
  }

  getNode(id: string): SymbolNode | undefined {
    return this.nodes.get(id);
  }

  getNodes(): SymbolNode[] {
    return Array.from(this.nodes.values());
  }

  addEdge(edge: SymbolEdge): void {
    // Check for duplicate edge
    const exists = this.edges.some(
      (e) => e.from === edge.from && e.to === edge.to && e.type === edge.type,
    );
    if (!exists) {
      this.edges.push(edge);
    }
  }

  removeEdge(from: string, to: string, type?: SymbolEdgeType): void {
    for (let i = this.edges.length - 1; i >= 0; i--) {
      const e = this.edges[i];
      if (e.from === from && e.to === to && (!type || e.type === type)) {
        this.edges.splice(i, 1);
      }
    }
  }

  getEdges(from?: string, to?: string, type?: SymbolEdgeType): SymbolEdge[] {
    return this.edges.filter((e) => {
      if (from && e.from !== from) return false;
      if (to && e.to !== to) return false;
      if (type && e.type !== type) return false;
      return true;
    });
  }

  getOutEdges(nodeId: string, type?: SymbolEdgeType): SymbolEdge[] {
    return this.getEdges(nodeId, undefined, type);
  }

  getInEdges(nodeId: string, type?: SymbolEdgeType): SymbolEdge[] {
    return this.getEdges(undefined, nodeId, type);
  }

  clearFile(filePath: string): void {
    const nodeIds = this.fileToNodes.get(filePath);
    if (nodeIds) {
      const idsCopy = Array.from(nodeIds);
      for (const id of idsCopy) {
        this.removeNode(id);
      }
    }
    // Also remove any file-level edges where from or to is the file path itself
    for (let i = this.edges.length - 1; i >= 0; i--) {
      if (this.edges[i].from === filePath || this.edges[i].to === filePath) {
        this.edges.splice(i, 1);
      }
    }
  }

  findNodesByName(name: string): SymbolNode[] {
    const ids = this.nameToNodes.get(name);
    if (!ids) return [];
    return Array.from(ids)
      .map((id) => this.nodes.get(id))
      .filter((n): n is SymbolNode => n !== undefined);
  }

  findNodesByFile(filePath: string): SymbolNode[] {
    const ids = this.fileToNodes.get(filePath);
    if (!ids) return [];
    return Array.from(ids)
      .map((id) => this.nodes.get(id))
      .filter((n): n is SymbolNode => n !== undefined);
  }

  query(filter: (node: SymbolNode) => boolean): SymbolNode[] {
    return this.getNodes().filter(filter);
  }

  findCallers(targetNodeIdOrName: string): SymbolNode[] {
    const targetIds = new Set<string>();
    if (this.nodes.has(targetNodeIdOrName)) {
      targetIds.add(targetNodeIdOrName);
    }
    for (const node of this.findNodesByName(targetNodeIdOrName)) {
      targetIds.add(node.id);
    }
    targetIds.add(targetNodeIdOrName);

    const callers = new Set<SymbolNode>();
    for (const edge of this.edges) {
      if (edge.type === 'CALLS') {
        const matches =
          targetIds.has(edge.to) ||
          edge.to === targetNodeIdOrName ||
          edge.to.endsWith(`.${targetNodeIdOrName}`) ||
          targetNodeIdOrName.endsWith(`.${edge.to}`) ||
          this.getNode(edge.to)?.name === targetNodeIdOrName;
        if (matches) {
          const callerNode = this.nodes.get(edge.from);
          if (callerNode) {
            callers.add(callerNode);
          }
        }
      }
    }
    return Array.from(callers);
  }

  findCallees(sourceNodeIdOrName: string): SymbolNode[] {
    const callees = new Set<SymbolNode>();
    for (const edge of this.edges) {
      if (edge.type === 'CALLS') {
        const matches =
          edge.from === sourceNodeIdOrName ||
          edge.from.includes(sourceNodeIdOrName) ||
          this.getNode(edge.from)?.name === sourceNodeIdOrName;
        if (matches) {
          const directNode = this.getNode(edge.to);
          if (directNode) {
            callees.add(directNode);
          } else {
            const calleeName = edge.to.includes('.') ? edge.to.split('.').pop()! : edge.to;
            const nodes = this.findNodesByName(calleeName);
            for (const n of nodes) {
              callees.add(n);
            }
            if (nodes.length === 0) {
              callees.add({
                id: `callee:${edge.to}`,
                name: calleeName,
                kind: 'function',
                language: 'typescript',
                file: '',
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              });
            }
          }
        }
      }
    }
    return Array.from(callees);
  }

  findImplementations(interfaceNodeIdOrName: string): SymbolNode[] {
    const targetIds = new Set<string>();
    if (this.nodes.has(interfaceNodeIdOrName)) {
      targetIds.add(interfaceNodeIdOrName);
    }
    for (const node of this.findNodesByName(interfaceNodeIdOrName)) {
      targetIds.add(node.id);
    }
    targetIds.add(interfaceNodeIdOrName);

    const impls = new Set<SymbolNode>();
    for (const edge of this.edges) {
      if (edge.type === 'IMPLEMENTS' && (targetIds.has(edge.to) || edge.to === interfaceNodeIdOrName)) {
        const node = this.nodes.get(edge.from);
        if (node) impls.add(node);
      }
    }
    return Array.from(impls);
  }

  findTests(targetNodeIdOrNameOrFile: string): SymbolNode[] {
    const targetIds = new Set<string>();
    if (this.nodes.has(targetNodeIdOrNameOrFile)) {
      targetIds.add(targetNodeIdOrNameOrFile);
    }
    for (const node of this.findNodesByName(targetNodeIdOrNameOrFile)) {
      targetIds.add(node.id);
    }
    targetIds.add(targetNodeIdOrNameOrFile);

    const testNodes = new Set<SymbolNode>();
    for (const edge of this.edges) {
      if (edge.type === 'TESTS' && targetIds.has(edge.to)) {
        const node = this.nodes.get(edge.from);
        if (node) testNodes.add(node);
      }
    }
    return Array.from(testNodes);
  }

  findDependencies(packageOrFile: string): string[] {
    const deps = new Set<string>();
    for (const edge of this.edges) {
      if ((edge.type === 'DEPENDS_ON' || edge.type === 'IMPORTS') && edge.from === packageOrFile) {
        deps.add(edge.to);
      }
    }
    return Array.from(deps);
  }

  findDependents(packageOrFile: string): string[] {
    const deps = new Set<string>();
    for (const edge of this.edges) {
      if ((edge.type === 'DEPENDS_ON' || edge.type === 'IMPORTS') && edge.to === packageOrFile) {
        deps.add(edge.from);
      }
    }
    return Array.from(deps);
  }
}
