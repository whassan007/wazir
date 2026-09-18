/**
 * Output hygiene helpers shared by the CLI, the control plane and the
 * execution history: model and tool output is untrusted text that ends up
 * both on the operator's terminal and in durable execution records.
 */

// ESC-based sequences: CSI (`ESC [ ... final`), OSC (`ESC ] ... BEL|ST`),
// and the remaining two-byte escapes (charset selection, keypad modes...).
// Also strips the C1 8-bit CSI/OSC forms and lone control characters that
// terminals interpret, but keeps `\n`, `\r` and `\t` so text stays readable.
const ANSI_RE =
  // eslint-disable-next-line no-control-regex
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[@-Z\\-_]|\x9b[0-?]*[ -/]*[@-~]|\x9d[^\x07\x9c]*(?:\x07|\x9c)|[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f]/g;

/**
 * Removes terminal escape sequences so untrusted output cannot move the
 * cursor, change the window title, write to the clipboard (OSC 52) or
 * repaint the screen when printed (security review F-23).
 */
export function stripTerminalEscapes(text: string): string {
  return text.replace(ANSI_RE, '');
}

// `SOME_API_KEY=value` / `DB_PASSWORD: value` — environment-style keys.
const ENV_SECRET_RE =
  /\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|CREDENTIALS?|DATABASE_URL|CONNECTION_STRING)[A-Z0-9_]*)(\s*[=:]\s*)(["']?)([^\s"'`,;]+)\3/g;
// `"password": "value"` / `token: 'value'` — config/JSON-style keys; the
// quoted value requirement keeps ordinary code (`const token = parse(x)`) intact.
const CONFIG_SECRET_RE =
  /\b((?:api[_-]?key|apikey|secret|password|passwd|token|access[_-]?token|refresh[_-]?token|private[_-]?key|client[_-]?secret|auth[_-]?token)["']?)(\s*[=:]\s*)(["'])([^"'\n]{4,})\3/gi;
// `aws_secret_access_key = value` / `db-password: value` — ini/yaml-style
// snake- or kebab-case keys with an unquoted value. The separator inside the
// key is what keeps plain code (`token = parse(x)`) out of scope.
const INI_SECRET_RE =
  /(^|[\s,;{("'])((?=[A-Za-z0-9]+[_-])(?:[A-Za-z0-9]+[_-])*?(?:secret|password|passwd|token|api[_-]?key|apikey|private[_-]?key|access[_-]?key)(?:[_-][A-Za-z0-9]+)*)(\s*[=:]\s*)([^\s"'`,;]{4,})/gi;
const BEARER_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g;
const URL_CREDS_RE = /(\b[a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]+)@/gi;
const PEM_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
// Common provider key shapes that carry no `KEY=` prefix in raw output.
const KNOWN_TOKEN_RE =
  /\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g;

export const REDACTED = '[REDACTED]';

/**
 * Best-effort scrubbing of credential-shaped material before text is
 * persisted to the execution store or a control-plane record (security
 * review F-13). It is a safety net, not a guarantee: the primary controls
 * are the minimal child environment and the policy engine's refusal to
 * auto-allow `env`/`printenv`.
 */
export function redactSecrets(text: string): string {
  if (!text) return text;
  return text
    .replace(PEM_RE, `-----BEGIN PRIVATE KEY-----${REDACTED}-----END PRIVATE KEY-----`)
    .replace(URL_CREDS_RE, `$1$2:${REDACTED}@`)
    .replace(BEARER_RE, `$1 ${REDACTED}`)
    .replace(ENV_SECRET_RE, (_m, key: string, sep: string, quote: string) => `${key}${sep}${quote}${REDACTED}${quote}`)
    .replace(CONFIG_SECRET_RE, (_m, key: string, sep: string, quote: string) => `${key}${sep}${quote}${REDACTED}${quote}`)
    .replace(INI_SECRET_RE, (_m, pre: string, key: string, sep: string) => `${pre}${key}${sep}${REDACTED}`)
    .replace(KNOWN_TOKEN_RE, REDACTED);
}

/** Both passes, in the order persisted output should receive them. */
export function sanitizeUntrustedOutput(text: string): string {
  return redactSecrets(stripTerminalEscapes(text));
}
