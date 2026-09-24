/**
 * InputController: Centralized owner of standard input.
 * Subscribes to stdin, normalizes raw terminal bytes via KeyDecoder,
 * tracks focus, and propagates semantic InputEvents.
 * No arbitrary component may directly subscribe to stdin.
 */

import { EventEmitter } from 'node:events';
import { KeyDecoder, type InputEvent } from './keyDecoder.js';

export type FocusPane = 'prompt' | 'nav' | 'main' | 'modal';

export class InputController extends EventEmitter {
  private readonly decoder = new KeyDecoder();
  private readonly inStream: NodeJS.ReadableStream;
  private focus: FocusPane = 'nav';
  private dataListener?: (chunk: Buffer | string) => void;
  private endListener?: () => void;
  private attached = false;

  constructor(inStream: NodeJS.ReadableStream = process.stdin) {
    super();
    this.inStream = inStream;
  }

  getFocus(): FocusPane {
    return this.focus;
  }

  setFocus(focus: FocusPane): void {
    this.focus = focus;
    this.emit('focusChange', focus);
  }

  /**
   * Attaches as the single subscriber to the input stream.
   */
  attach(): void {
    if (this.attached) return;
    this.attached = true;
    this.decoder.reset();

    this.dataListener = (chunk: Buffer | string) => {
      const events = this.decoder.feed(chunk);
      for (const event of events) {
        this.emit('event', event);
      }
    };
    this.inStream.on('data', this.dataListener);

    this.endListener = () => {
      this.emit('end');
    };
    this.inStream.once('end', this.endListener);
  }

  /**
   * Detaches from the input stream.
   */
  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    if (this.dataListener) {
      this.inStream.off('data', this.dataListener);
      this.dataListener = undefined;
    }
    if (this.endListener) {
      this.inStream.off('end', this.endListener);
      this.endListener = undefined;
    }
    this.decoder.reset();
  }

  /**
   * Directly feeds an input event (used by tests or synthetic actions).
   */
  dispatch(event: InputEvent): void {
    this.emit('event', event);
  }

  /**
   * Feeds raw data (string/Buffer) into the controller.
   */
  feed(data: string | Buffer): void {
    const events = this.decoder.feed(data);
    for (const event of events) {
      this.emit('event', event);
    }
  }

  isAttached(): boolean {
    return this.attached;
  }
}
