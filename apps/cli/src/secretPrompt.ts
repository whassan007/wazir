import readline from 'node:readline';

/**
 * Interactive masked secret entry. No TTY (piped input, CI, non-interactive
 * session) always throws rather than waiting — matches `approve.ts`'s
 * `process.stdin.isTTY !== true` guard, and is what keeps `wa auth login`
 * from hanging forever when there's no human to answer it.
 *
 * There is no existing masked-input helper anywhere in this CLI (grepped);
 * this uses raw `readline` stdin-echo suppression rather than pulling in a
 * prompts/inquirer dependency, matching `approve.ts`'s zero-dependency
 * convention for interactive input.
 */
export async function promptSecret(question: string): Promise<string> {
  if (process.stdin.isTTY !== true) {
    throw new Error('no TTY available for interactive secret entry — pass --api-key or set the provider environment variable instead');
  }

  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let masking = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const original = (rl as any)._writeToOutput?.bind(rl);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (rl as any)._writeToOutput = (str: string) => {
      if (!masking) {
        (original ?? ((s: string) => process.stdout.write(s)))(str);
      }
    };

    const onSigint = (): void => {
      masking = false;
      rl.close();
      process.stdout.write('\n');
      reject(new Error('cancelled'));
    };
    process.once('SIGINT', onSigint);

    process.stdout.write(question);
    masking = true;
    rl.question('', (answer) => {
      masking = false;
      process.off('SIGINT', onSigint);
      process.stdout.write('\n');
      rl.close();
      resolve(answer.trim());
    });
  });
}
