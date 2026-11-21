/** Deterministic OS-backed answers: no model, planner, or remote network. */
export function answerLocalUtilityQuestion(input: string, now: Date = new Date()): string | undefined {
  const query = input.trim().toLowerCase().replace(/[?!.]+$/g, '').replace(/\s+/g, ' ');
  const timeQuestions = new Set([
    'what time is it', 'what time is it today', 'what time is it now',
    'what is the time', 'what is the time now', "what's the time",
    "what's the time now", 'current time', 'time',
  ]);
  const dateQuestions = new Set([
    'what date is it', 'what date is it today', 'what is the date',
    'what is the date today', "what's the date", "what's today's date",
    'todays date', "today's date", 'current date', 'date',
  ]);
  if (timeQuestions.has(query)) {
    return `Local time: ${new Intl.DateTimeFormat(undefined, {
      dateStyle: 'full', timeStyle: 'long',
    }).format(now)}`;
  }
  if (dateQuestions.has(query)) {
    return `Local date: ${new Intl.DateTimeFormat(undefined, { dateStyle: 'full' }).format(now)}`;
  }
  return undefined;
}
