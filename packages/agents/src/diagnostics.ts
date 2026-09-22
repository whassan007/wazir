export function extractDiagnosticFingerprints(output: string): Set<string> {
  const lines = output.split('\n');
  const fingerprints = new Set<string>();
  
  for (const line of lines) {
    // Typical gcc/clang: file.cpp:10:5: error: expected ';'
    const gccMatch = line.match(/^([^:]+):(\d+):\d+:?\s+(error|warning):\s+(.*)$/);
    if (gccMatch) {
      fingerprints.add(`[${gccMatch[1]}:${gccMatch[2]}] ${gccMatch[3]}: ${gccMatch[4].trim()}`);
      continue;
    }
    
    // Typical tsc: file.ts(10,5): error TS1005: expected ';'
    const tscMatch = line.match(/^([^(]+)\(\d+,\d+\):\s+(error\s+TS\d+):\s+(.*)$/);
    if (tscMatch) {
      fingerprints.add(`[${tscMatch[1]}] ${tscMatch[2]}: ${tscMatch[3].trim()}`);
      continue;
    }

    // Typical python/pytest: E   AssertionError: assert 1 == 2
    const pytestMatch = line.match(/^E\s+([^:]+):\s+(.*)$/);
    if (pytestMatch) {
      fingerprints.add(`[pytest] ${pytestMatch[1]}: ${pytestMatch[2].trim()}`);
      continue;
    }
  }

  // If we couldn't parse specific errors, fallback to counting lines with "error"
  if (fingerprints.size === 0) {
    for (const line of lines) {
      if (line.toLowerCase().includes('error')) {
        fingerprints.add(line.trim());
      }
    }
  }
  
  return fingerprints;
}

export function detectProgress(before: string, after: string): 'PROGRESS' | 'NO_PROGRESS' | 'REGRESSION' {
  const fpBefore = extractDiagnosticFingerprints(before);
  const fpAfter = extractDiagnosticFingerprints(after);
  
  if (fpAfter.size < fpBefore.size) return 'PROGRESS';
  if (fpAfter.size > fpBefore.size) return 'REGRESSION';
  
  // If sizes are equal, check if they are identical
  let identical = true;
  for (const fp of fpAfter) {
    if (!fpBefore.has(fp)) {
      identical = false;
      break;
    }
  }
  
  if (identical) return 'NO_PROGRESS';
  return 'PROGRESS'; // different errors, count same => still progressing through issues
}
