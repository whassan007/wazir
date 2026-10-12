import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FleetTui } from '../src/tui/fleetTui.js';
import {
  renderSearchView,
  renderSearchTreeNode,
  renderSearchNodeInspection,
  flattenSearchTree,
  type SearchTreeNode,
  type SearchViewData,
  type SearchNodeInspection,
} from '../src/tui/observabilityViews.js';

interface MockScreen {
  buffer: string;
  width: number;
  height: number;
  writes: string[];
  clear(): void;
  write(str: string): void;
  moveTo(x: number, y: number): void;
  repaint(): void;
  clearLastBuffer(): void;
  hideCursor(): void;
  showCursor(): void;
  getScreenBuffer(): string;
}

function createMockScreen(width = 120, height = 40): MockScreen {
  let writes: string[] = [];
  return {
    width,
    height,
    writes,
    clear() { writes = []; },
    write(str: string) { writes.push(str); },
    moveTo() {},
    repaint() {},
    clearLastBuffer() {},
    hideCursor() {},
    showCursor() {},
    getScreenBuffer() { return writes.join(''); },
  };
}

function createMockEngine() {
  const searches = new Map<string, any>();
  return {
    solutionSearch: {
      listSearches: () => Array.from(searches.values()),
      searches,
      pauseSearch: (id: string) => true,
      cancelCandidate: (sId: string, cId: string) => true,
      promoteCandidate: async () => ({ success: true }),
    },
    optimizer: {
      listExperiments: () => [],
    },
    executions: {
      list: async () => [],
    },
    computers: {
      heartbeat: () => {},
      listComputers: () => [],
    },
    approvalQueue: {
      getPending: () => [],
      approveAll: () => 0,
    },
    checkpoints: {
      getCheckpoint: (id: string) => undefined,
    },
    verification: {
      getLastVerificationResult: () => undefined,
    },
    provenance: undefined,
  };
}

describe('Mission Control SEARCH View Keyboard Navigation & Selection', () => {
  let engine: any;
  let screen: MockScreen;
  let tui: FleetTui;

  const sampleTree: SearchTreeNode[] = [
    {
      id: 'C0',
      name: 'C0',
      state: 'completed',
      tokens: 0,
      children: [
        {
          id: 'A',
          name: 'A',
          state: 'completed',
          tokens: 840,
          children: [
            {
              id: 'A1',
              name: 'A1',
              state: 'completed',
              tokens: 1250,
              testsPassed: true,
              isFrontier: true,
            },
            {
              id: 'A2',
              name: 'A2',
              state: 'pruned',
              prunedReason: 'build failed',
              tokens: 920,
              testsPassed: false,
              isDominated: true,
            },
          ],
        },
        {
          id: 'B',
          name: 'B',
          state: 'active',
          tokens: 610,
        },
        {
          id: 'C',
          name: 'C',
          state: 'pruned',
          prunedReason: 'timeout',
          tokens: 450,
          isDominated: true,
        },
      ],
    },
  ];

  beforeEach(() => {
    engine = createMockEngine();
    screen = createMockScreen(120, 40);
    tui = new FleetTui({ engine, screen: screen as any });
    tui.switchView('search');
  });

  afterEach(() => {
    tui.destroy();
  });

  it('1. tree cursor movement: down and up navigate flat visible nodes sequentially', () => {
    const search = {
      searchId: 'test-search-1',
      status: 'running',
      strategy: 'hierarchical_mcts',
      treeNodes: sampleTree,
      candidates: [],
    };
    engine.solutionSearch.searches.set(search.searchId, search);

    // Initial state: cursor is at 0 (C0)
    expect(tui.getSearchTreeCursor()).toBe(0);
    expect(tui.getSelectedNodeId()).toBe('C0');

    // Down arrow: moves to index 1 (A)
    tui.handleKey('\u001b[B');
    expect(tui.getSearchTreeCursor()).toBe(1);
    expect(tui.getSelectedNodeId()).toBe('A');

    // Down arrow: moves to index 2 (A1)
    tui.handleKey('\u001b[B');
    expect(tui.getSearchTreeCursor()).toBe(2);
    expect(tui.getSelectedNodeId()).toBe('A1');

    // Down arrow: moves to index 3 (A2)
    tui.handleKey('\u001b[B');
    expect(tui.getSearchTreeCursor()).toBe(3);
    expect(tui.getSelectedNodeId()).toBe('A2');

    // Up arrow: moves back to index 2 (A1)
    tui.handleKey('\u001b[A');
    expect(tui.getSearchTreeCursor()).toBe(2);
    expect(tui.getSelectedNodeId()).toBe('A1');

    // Up arrow: moves back to index 1 (A)
    tui.handleKey('\u001b[A');
    expect(tui.getSearchTreeCursor()).toBe(1);
    expect(tui.getSelectedNodeId()).toBe('A');

    // Up arrow: moves back to index 0 (C0)
    tui.handleKey('\u001b[A');
    expect(tui.getSearchTreeCursor()).toBe(0);
    expect(tui.getSelectedNodeId()).toBe('C0');

    // Up arrow at top: remains at index 0 (boundary clamp)
    tui.handleKey('\u001b[A');
    expect(tui.getSearchTreeCursor()).toBe(0);
    expect(tui.getSelectedNodeId()).toBe('C0');
  });

  it('2. parent navigation: left arrow navigates from child to parent', () => {
    const search = {
      searchId: 'test-search-2',
      status: 'running',
      treeNodes: sampleTree,
      candidates: [],
    };
    engine.solutionSearch.searches.set(search.searchId, search);

    // Move to A1 (child of A)
    tui.setSelectedNodeId('A1');
    expect(tui.getSelectedNodeId()).toBe('A1');

    // Left arrow: should jump to parent 'A'
    tui.handleKey('\u001b[D');
    expect(tui.getSelectedNodeId()).toBe('A');

    // Left arrow from 'A': should jump to parent 'C0'
    tui.handleKey('\u001b[D');
    expect(tui.getSelectedNodeId()).toBe('C0');

    // Left arrow from root 'C0': has no parent, stays at 'C0'
    tui.handleKey('\u001b[D');
    expect(tui.getSelectedNodeId()).toBe('C0');
  });

  it('3. child navigation: right arrow navigates from node to its first child', () => {
    const search = {
      searchId: 'test-search-3',
      status: 'running',
      treeNodes: sampleTree,
      candidates: [],
    };
    engine.solutionSearch.searches.set(search.searchId, search);

    // Start at root C0
    tui.setSelectedNodeId('C0');
    expect(tui.getSelectedNodeId()).toBe('C0');

    // Right arrow: should jump to first child 'A'
    tui.handleKey('\u001b[C');
    expect(tui.getSelectedNodeId()).toBe('A');

    // Right arrow from A: should jump to first child 'A1'
    tui.handleKey('\u001b[C');
    expect(tui.getSelectedNodeId()).toBe('A1');

    // Right arrow from leaf A1: has no children, stays at 'A1'
    tui.handleKey('\u001b[C');
    expect(tui.getSelectedNodeId()).toBe('A1');
  });

  it('4. visible selection marker: selected node is rendered with "> " prefix while unselected have "  "', () => {
    const renderedLines = renderSearchTreeNode(sampleTree[0], '', true, true, 80, 'A1');
    const text = renderedLines.join('\n');

    // A1 line should be marked with '> '
    const a1Line = renderedLines.find((l) => l.includes('A1'));
    expect(a1Line).toBeDefined();
    expect(a1Line).toMatch(/^>\s/);

    // Root C0 and sibling A2 should NOT be marked with '> ' (they have '  ')
    const c0Line = renderedLines.find((l) => l.includes('C0'));
    expect(c0Line).toBeDefined();
    expect(c0Line).toMatch(/^\s{2}/);

    const a2Line = renderedLines.find((l) => l.includes('A2'));
    expect(a2Line).toBeDefined();
    expect(a2Line).toMatch(/^\s{2}/);
  });

  it('5. Enter inspection and Esc close: Enter opens node detail modal, Esc closes it', () => {
    const search = {
      searchId: 'test-search-5',
      status: 'running',
      treeNodes: sampleTree,
      candidates: [],
    };
    engine.solutionSearch.searches.set(search.searchId, search);

    tui.setSelectedNodeId('A1');
    expect(tui.isEvidenceModalOpen()).toBe(false);

    // Press Enter to inspect node
    tui.handleKey('\r');
    expect(tui.isEvidenceModalOpen()).toBe(true);

    const modalData = tui.getEvidenceModalData();
    expect(modalData).toBeDefined();
    expect(modalData?.candidateId).toBe('A1');
    expect(modalData?.nodeInspection).toBeDefined();
    expect(modalData?.nodeInspection?.nodeId).toBe('A1');

    // Press Esc to close inspection modal
    tui.handleKey('\u001b');
    expect(tui.isEvidenceModalOpen()).toBe(false);
  });

  it('6. node detail panel renders required fields with UNKNOWN fallbacks and never invents values', () => {
    const inspection: SearchNodeInspection = {
      nodeId: 'MINIMAL_NODE',
    };

    const lines = renderSearchNodeInspection(inspection, { width: 80 });
    const text = lines.join('\n');

    expect(text).toContain('NODE MINIMAL_NODE');
    expect(text).toContain('Parent:      UNKNOWN');
    expect(text).toContain('Phase:       UNKNOWN');
    expect(text).toContain('State:       UNKNOWN');
    expect(text).toContain('Model:       UNKNOWN');
    expect(text).toContain('Worker:      ${inspection.workerId ?? \'UNKNOWN\'}'.replace('${inspection.workerId ?? \'UNKNOWN\'}', 'UNKNOWN'));
    expect(text).toContain('Checkpoint:  UNKNOWN');
    expect(text).toContain('Revision:    UNKNOWN');
    expect(text).toContain('Tests       UNKNOWN');
    expect(text).toContain('Controller reward    UNKNOWN');
    expect(text).toContain('Pareto membership    UNKNOWN');
    expect(text).toContain('Pruning reason: UNKNOWN');

    // Verify absent values are not invented
    expect(text).not.toContain('Parent:      root');
    expect(text).not.toContain('State:       VERIFIED');
    expect(text).not.toContain('Controller reward    0');
  });

  it('7. pruned node inspection: properly renders state, prune reason, and parent', () => {
    const inspection: SearchNodeInspection = {
      nodeId: 'A2',
      parentId: 'A',
      state: 'PRUNED',
      prunedReason: 'build failed',
      modelId: 'qwen-2.5-coder-32b',
      workerId: 'MAC-01',
      search: {
        paretoMembership: 'DOMINATED',
      },
      provenance: {
        parentNodeId: 'A',
      },
    };

    const lines = renderSearchNodeInspection(inspection, { width: 80 });
    const text = lines.join('\n');

    expect(text).toContain('NODE A2');
    expect(text).toContain('Parent:      A');
    expect(text).toContain('State:       PRUNED');
    expect(text).toContain('Pruning reason: build failed');
    expect(text).toContain('Model:       qwen-2.5-coder-32b');
    expect(text).toContain('Worker:      MAC-01');
    expect(text).toContain('Pareto membership    DOMINATED');
  });

  it('8. empty tree: handles empty tree without crashing or throwing errors', () => {
    const search = {
      searchId: 'empty-search',
      status: 'running',
      treeNodes: [],
      candidates: [],
    };
    engine.solutionSearch.searches.set(search.searchId, search);

    expect(tui.getSearchTreeNodes()).toEqual([]);
    expect(tui.getFlattenedSearchTreeNodes()).toEqual([]);

    // Navigation attempts should be no-ops
    tui.handleKey('\u001b[B'); // Down
    tui.handleKey('\u001b[A'); // Up
    tui.handleKey('\u001b[D'); // Left
    tui.handleKey('\u001b[C'); // Right

    expect(tui.getSearchTreeCursor()).toBe(0);

    // TUI draw should not throw
    expect(() => tui.draw()).not.toThrow();
  });

  it('9. single-node tree: root only with no children or parents', () => {
    const singleNodeTree: SearchTreeNode[] = [
      {
        id: 'SOLO_ROOT',
        name: 'SOLO_ROOT',
        state: 'active',
      },
    ];
    const search = {
      searchId: 'single-node-search',
      status: 'running',
      treeNodes: singleNodeTree,
      candidates: [],
    };
    engine.solutionSearch.searches.set(search.searchId, search);

    expect(tui.getSearchTreeCursor()).toBe(0);
    expect(tui.getSelectedNodeId()).toBe('SOLO_ROOT');

    // Movement clamped to single node
    tui.handleKey('\u001b[B');
    expect(tui.getSearchTreeCursor()).toBe(0);
    expect(tui.getSelectedNodeId()).toBe('SOLO_ROOT');

    tui.handleKey('\u001b[A');
    expect(tui.getSearchTreeCursor()).toBe(0);

    tui.handleKey('\u001b[D'); // parent of root: no-op
    expect(tui.getSelectedNodeId()).toBe('SOLO_ROOT');

    tui.handleKey('\u001b[C'); // child of leaf: no-op
    expect(tui.getSelectedNodeId()).toBe('SOLO_ROOT');
  });

  it('10. deep tree: traverses multi-level nested hierarchy', () => {
    const deepTree: SearchTreeNode[] = [
      {
        id: 'L0',
        state: 'completed',
        children: [
          {
            id: 'L1',
            state: 'completed',
            children: [
              {
                id: 'L2',
                state: 'completed',
                children: [
                  {
                    id: 'L3',
                    state: 'active',
                  },
                ],
              },
            ],
          },
        ],
      },
    ];
    const search = {
      searchId: 'deep-search',
      status: 'running',
      treeNodes: deepTree,
      candidates: [],
    };
    engine.solutionSearch.searches.set(search.searchId, search);

    const flat = tui.getFlattenedSearchTreeNodes();
    expect(flat.map((n) => n.id)).toEqual(['L0', 'L1', 'L2', 'L3']);

    // Step down to L3
    tui.handleKey('\u001b[B'); // L1
    tui.handleKey('\u001b[B'); // L2
    tui.handleKey('\u001b[B'); // L3
    expect(tui.getSelectedNodeId()).toBe('L3');

    // Parent navigation all the way back to L0
    tui.handleKey('\u001b[D');
    expect(tui.getSelectedNodeId()).toBe('L2');
    tui.handleKey('\u001b[D');
    expect(tui.getSelectedNodeId()).toBe('L1');
    tui.handleKey('\u001b[D');
    expect(tui.getSelectedNodeId()).toBe('L0');
  });

  it('11. selected node disappearing after refresh: clamps cursor gracefully and resets selection', () => {
    // Initial tree with node 'TEMP_NODE'
    const initialTree: SearchTreeNode[] = [
      { id: 'ROOT', state: 'completed', children: [{ id: 'TEMP_NODE', state: 'active' }] },
    ];
    const search = {
      searchId: 'dynamic-search',
      status: 'running',
      treeNodes: initialTree,
      candidates: [],
    };
    engine.solutionSearch.searches.set(search.searchId, search);

    tui.setSelectedNodeId('TEMP_NODE');
    expect(tui.getSelectedNodeId()).toBe('TEMP_NODE');
    expect(tui.getSearchTreeCursor()).toBe(1);

    // Dynamic update / refresh: TEMP_NODE was pruned or removed entirely
    const updatedTree: SearchTreeNode[] = [
      { id: 'ROOT', state: 'completed', children: [] },
    ];
    search.treeNodes = updatedTree;

    // When querying selected node after disappearance, cursor clamps to 0 and selects ROOT
    expect(tui.getSelectedNodeId()).toBe('ROOT');
    expect(tui.getSearchTreeCursor()).toBe(0);
  });

  it('12. terminal resize: draw handles narrow and wide terminal dimensions cleanly without crash', () => {
    const search = {
      searchId: 'resize-search',
      status: 'running',
      treeNodes: sampleTree,
      candidates: [],
    };
    engine.solutionSearch.searches.set(search.searchId, search);

    // Normal terminal
    tui.draw();
    expect(screen.writes.length).toBeGreaterThan(0);

    // Narrow terminal (cols: 40, rows: 20)
    screen.width = 40;
    screen.height = 20;
    expect(() => tui.draw()).not.toThrow();

    // Wide terminal (cols: 200, rows: 60)
    screen.width = 200;
    screen.height = 60;
    expect(() => tui.draw()).not.toThrow();
  });
});
