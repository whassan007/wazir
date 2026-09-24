/**
 * Shortens text to `limit` characters by keeping its start and its end. Process and check
 * output puts its verdict last (a test run's failure summary, a build's final error), so
 * a head-only cut discards exactly the evidence that matters.
 */
export function keepEnds(text: string, limit: number, head = Math.floor(limit / 5)): string {
  if (text.length <= limit) return text;
  const tail = Math.max(0, limit - head);
  return `${text.slice(0, head)}\n… [${text.length - head - tail} characters omitted] …\n${text.slice(text.length - tail)}`;
}
