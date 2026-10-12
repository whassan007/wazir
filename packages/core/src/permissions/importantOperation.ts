/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 * Adapted for Wazir.
 */

export interface PermissionDetails {
  command?: string;
  operation?: string;
  target?: string;
  incomplete?: boolean;
}

/**
 * Security classifier: identifies operations requiring human confirmation or high scrutiny.
 * Read-only operations and safe inspection commands pass as non-important;
 * mutating, executing, piping, redirecting, and destructive operations are classified as important.
 */
export function isImportantPermissionOperation(
  details?: PermissionDetails,
): boolean {
  if (!details || details.incomplete) return true;

  if (details.command) {
    let command = details.command.trim();
    try {
      const argv: unknown = JSON.parse(command);
      if (Array.isArray(argv) && argv.every((v) => typeof v === 'string')) {
        if (
          argv.length === 3 &&
          /^(?:\/bin\/|\/usr\/bin\/)?(?:bash|zsh|sh)$/.test(argv[0]) &&
          ['-c', '-lc'].includes(argv[1])
        ) {
          command = argv[2];
        } else {
          command = argv.join(' ');
        }
      }
    } catch {
      /* Shell strings remain quoted data; never evaluate them */
    }

    // Any composition, substitution, pipe, or redirection is important
    if (/[;&|<>$`\n\r]/u.test(command)) return true;
    if (/(?:^|\s)--(?:output|ext-diff|textconv|exec)(?:=|\s|$)/u.test(command)) {
      return true;
    }

    // Explicitly safe read-only inspection commands
    if (
      /^(?:(?:\/bin\/|\/usr\/bin\/))?(?:pwd|ls)(?:\s[^;&|<>$`\n\r]*)?$/u.test(
        command,
      )
    ) {
      return false;
    }

    if (
      /^(?:\/usr\/bin\/)?git\s+(?:status|diff|log|show)(?:\s[^;&|<>$`\n\r]*)?$/u.test(
        command,
      )
    ) {
      return false;
    }

    return true;
  }

  // Safe file/data query operations
  return !['read', 'list', 'search', 'inspect', 'query'].includes(
    details.operation?.toLowerCase() ?? '',
  );
}
