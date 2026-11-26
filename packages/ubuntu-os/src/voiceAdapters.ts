import { spawnSync } from 'node:child_process';
import type {
  SpeechToTextAdapter,
  TextToSpeechAdapter,
  VoiceTranscript,
} from './contracts.js';

const CONSEQUENTIAL_VOICE_PATTERNS =
  /\b(sudo|rm|delete|remove|format|mkfs|dd|apt\s+install|apt\s+remove|systemctl\s+(stop|disable|restart)|chmod|chown|kill)\b/i;

export function requiresVoiceConfirmation(transcript: VoiceTranscript): boolean {
  return transcript.untrustedTranscript && CONSEQUENTIAL_VOICE_PATTERNS.test(transcript.text);
}

/**
 * Offline Speech-to-Text adapter backed by whisper.cpp (`whisper-cli`).
 * Push-to-talk by default; transcripts are always marked untrusted.
 */
export class WhisperCppSttAdapter implements SpeechToTextAdapter {
  readonly id = 'whisper.cpp';
  readonly name = 'Whisper.cpp (Offline STT)';

  constructor(private readonly binary = 'whisper-cli', private readonly modelPath = '/usr/share/wazir/models/ggml-base.en.bin') {}

  async isAvailable(): Promise<boolean> {
    const res = spawnSync('which', [this.binary], { encoding: 'utf8', timeout: 800 });
    return res.status === 0;
  }

  async transcribeFile(audioPath: string, language = 'en'): Promise<VoiceTranscript> {
    const t0 = performance.now();
    const proc = spawnSync(
      this.binary,
      ['-m', this.modelPath, '-l', language, '-f', audioPath, '--no-timestamps'],
      { encoding: 'utf8', timeout: 15_000 },
    );
    if (proc.status !== 0) {
      throw new Error(`whisper.cpp transcription failed: ${proc.stderr || 'binary unavailable'}`);
    }
    return {
      text: (proc.stdout ?? '').trim(),
      confidence: 0.9,
      language,
      untrustedTranscript: true,
      requiresConfirmationForConsequential: true,
      durationMs: Number((performance.now() - t0).toFixed(2)),
    };
  }
}

/**
 * Offline Text-to-Speech adapter backed by Piper (`piper`).
 * Guards against recursive TTS->STT activation by tracking active playback state.
 */
export class PiperTtsAdapter implements TextToSpeechAdapter {
  readonly id = 'piper';
  readonly name = 'Piper (Offline Neural TTS)';
  private playing = false;

  constructor(private readonly binary = 'piper', private readonly modelPath = '/usr/share/wazir/voices/en_US-lessac-medium.onnx') {}

  isPlaying(): boolean {
    return this.playing;
  }

  async isAvailable(): Promise<boolean> {
    const res = spawnSync('which', [this.binary], { encoding: 'utf8', timeout: 800 });
    return res.status === 0;
  }

  async speak(
    text: string,
    options?: { voice?: string; signal?: AbortSignal },
  ): Promise<{ played: boolean; durationMs: number }> {
    const t0 = performance.now();
    if (options?.signal?.aborted) {
      return { played: false, durationMs: 0 };
    }
    this.playing = true;
    try {
      const proc = spawnSync(
        this.binary,
        ['--model', options?.voice ?? this.modelPath, '--output_raw'],
        { input: text, encoding: 'utf8', timeout: 15_000 },
      );
      return {
        played: proc.status === 0,
        durationMs: Number((performance.now() - t0).toFixed(2)),
      };
    } finally {
      this.playing = false;
    }
  }

  stop(): void {
    this.playing = false;
  }
}
