/** Single synchronous entry point for conversation output; Writable queues backpressure. */
export class OutputWriter {
  constructor(private readonly output: NodeJS.WritableStream) {}

  writeDurable(text: string): boolean { return this.output.write(text); }
  writeTransient(text: string): boolean { return this.output.write(text); }
}
