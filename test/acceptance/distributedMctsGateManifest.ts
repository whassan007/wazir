/** Requested release-gate names mapped to the repository's existing acceptance IDs. */
export const distributedMctsGateMap = Object.freeze({
  G83: { acceptanceId: 'G91', test: 'G91: executes depth-three branches on multiple real worker processes with controller reward' },
  G84: { acceptanceId: 'G92', test: 'G92: isolates worker crash mid-expansion, sets lease to UNKNOWN, and preserves tree revision' },
  G85: { acceptanceId: 'G94', test: 'G94: persisted controller state restores without replaying accepted results' },
  G86: { acceptanceId: 'G95', test: 'G95: equivalent worker states converge centrally and are marked as transpositions' },
  G87: { acceptanceId: 'G96', test: 'G96: records measurable parallel execution results without assuming unmeasured speedup' },
});
