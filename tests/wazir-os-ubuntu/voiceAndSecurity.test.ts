import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  PiperTtsAdapter,
  WhisperCppSttAdapter,
  requiresVoiceConfirmation,
  type VoiceTranscript,
} from '../../packages/ubuntu-os/src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

describe('Voice Safety, GNOME 50 Search & Ubuntu Packaging (Agents 06, 07, 08, 10, 11)', () => {
  it('treats voice transcripts as untrusted and requires confirmation for consequential commands', () => {
    const safeTranscript: VoiceTranscript = {
      text: 'Show my downloads',
      confidence: 0.94,
      language: 'en',
      untrustedTranscript: true,
      requiresConfirmationForConsequential: true,
      durationMs: 120,
    };
    expect(requiresVoiceConfirmation(safeTranscript)).toBe(false);

    const dangerousTranscript: VoiceTranscript = {
      ...safeTranscript,
      text: 'sudo apt install curl and rm -rf /tmp/test',
    };
    expect(requiresVoiceConfirmation(dangerousTranscript)).toBe(true);
  });

  it('handles missing whisper.cpp / piper binaries and cancellation gracefully', async () => {
    const stt = new WhisperCppSttAdapter('nonexistent-whisper-bin');
    const tts = new PiperTtsAdapter('nonexistent-piper-bin');
    expect(await stt.isAvailable()).toBe(false);
    expect(await tts.isAvailable()).toBe(false);

    const ac = new AbortController();
    ac.abort();
    const cancelled = await tts.speak('hello', { signal: ac.signal });
    expect(cancelled.played).toBe(false);
  });

  it('ships valid GNOME SearchProvider2 D-Bus service, .desktop files, and Ubuntu autoinstall config', () => {
    const pyCheck = spawnSync(
      'python3',
      ['-m', 'py_compile', path.join(repoRoot, 'os/wazir-os-ubuntu/gnome/wazir-gnome-search.py')],
      { encoding: 'utf8' },
    );
    expect(pyCheck.status).toBe(0);

    const ini = fs.readFileSync(
      path.join(repoRoot, 'os/wazir-os-ubuntu/gnome/org.wazir.SearchProvider.ini'),
      'utf8',
    );
    expect(ini).toContain('[Shell Search Provider]');
    expect(ini).toContain('Version=2');

    const autoinstall = fs.readFileSync(
      path.join(repoRoot, 'os/wazir-os-ubuntu/image/ubuntu-26.04.1-autoinstall.yaml'),
      'utf8',
    );
    expect(autoinstall).toContain('autoinstall:');
    expect(autoinstall).toContain('wazir-gnome-search.service');
  });
});
