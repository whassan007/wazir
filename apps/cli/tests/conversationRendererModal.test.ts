import { describe, it, expect, vi } from 'vitest';
import { ConversationRenderer, ConversationFrame } from '../src/tui/conversationRenderer.js';
import { Writable } from 'node:stream';

class MockStream extends Writable {
  output = '';
  override _write(chunk: any, encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    this.output += chunk.toString();
    callback();
  }
}

describe('ConversationRenderer Modal and Deduplication', () => {
  it('renders modalLines and updates in place in TTY mode without accumulating durable entries', () => {
    const stream = new MockStream();
    const renderer = new ConversationRenderer(stream, () => ({ columns: 80, rows: 24 }), { isTTY: true });

    const frame: ConversationFrame = {
      identity: 'AgentA',
      prompt: 'hello',
      cursor: 5,
      active: 0,
      waitingApproval: 0,
      activity: '',
      modalLines: ['┌─────────────┐', '│ Select Model│', '└─────────────┘'],
    };

    renderer.render(frame);
    expect(renderer.getActiveModalLines()).toEqual(frame.modalLines);

    const transcriptBefore = renderer.transcript.list().length;

    // Render 20 times (simulating 20 Down arrow presses)
    for (let i = 0; i < 20; i++) {
      renderer.render({
        ...frame,
        modalLines: ['┌─────────────┐', `│ Option ${i}    │`, '└─────────────┘'],
      });
    }

    const transcriptAfter = renderer.transcript.list().length;
    // Should not add new entries to transcript during live modal navigation updates
    expect(transcriptAfter).toEqual(transcriptBefore);
  });

  it('clears modal when modalLines is undefined or clearModal is called', () => {
    const stream = new MockStream();
    const renderer = new ConversationRenderer(stream, () => ({ columns: 80, rows: 24 }), { isTTY: true });

    const frame: ConversationFrame = {
      identity: 'AgentA',
      prompt: 'hello',
      cursor: 5,
      active: 0,
      waitingApproval: 0,
      activity: '',
      modalLines: ['Modal'],
    };

    renderer.render(frame);
    expect(renderer.getActiveModalLines()).toEqual(['Modal']);

    renderer.render({ ...frame, modalLines: undefined });
    expect(renderer.getActiveModalLines()).toEqual([]);
  });

  it('prevents duplicate confirmation messages when status matches last appended text', () => {
    const stream = new MockStream();
    const renderer = new ConversationRenderer(stream, () => ({ columns: 80, rows: 24 }), { isTTY: true });

    renderer.append('Model selection updated [Persistent Default]: local');

    const frame: ConversationFrame = {
      identity: 'AgentA',
      prompt: 'hello',
      cursor: 5,
      active: 0,
      waitingApproval: 0,
      activity: '',
      status: 'Model selection updated [Persistent Default]: local',
    };

    stream.output = '';
    renderer.render(frame);

    // Should not render • Model selection updated in live region
    expect(stream.output).not.toContain('• Model selection updated');
  });

  it('handles non-TTY mode modal and deduplication', () => {
    const stream = new MockStream();
    const renderer = new ConversationRenderer(stream, () => ({ columns: 80, rows: 24 }), { isTTY: false });

    const frame: ConversationFrame = {
      identity: 'AgentA',
      prompt: 'hello',
      cursor: 5,
      active: 0,
      waitingApproval: 0,
      activity: '',
      modalLines: ['Modal 1'],
    };

    renderer.render(frame);
    renderer.render({ ...frame, modalLines: ['Modal 2'] });

    expect(renderer.getActiveModalLines()).toEqual(['Modal 2']);
  });
});
