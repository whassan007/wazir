import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';

/**
 * Computes SHA-256 hash of a buffer or readable stream.
 * Uses streaming for large files to avoid memory issues.
 */
export async function computeContentHash(
  bufferOrStream: Buffer | NodeJS.ReadableStream,
): Promise<string> {
  const hash = createHash('sha256');

  if (Buffer.isBuffer(bufferOrStream)) {
    hash.update(bufferOrStream);
  } else {
    const stream = Readable.from(bufferOrStream as any);
    for await (const chunk of stream) {
      hash.update(chunk);
    }
  }

  return hash.digest('hex');
}

/**
 * Computes SHA-256 hash from a file path.
 */
export async function computeFileHash(filePath: string): Promise<string> {
  const stream = createReadStream(filePath);
  return computeContentHash(stream);
}

/**
 * Extracts the first N bytes of a buffer as a hex prefix for quick comparison.
 */
export function getShortHash(bufferOrStream: Buffer | NodeJS.ReadableStream, length: number = 16): Promise<string> {
  const hash = createHash('sha256');

  if (Buffer.isBuffer(bufferOrStream)) {
    hash.update(bufferOrStream.slice(0, length));
  } else {
    return new Promise((resolve, reject) => {
      let data = Buffer.alloc(0);
      bufferOrStream.on('data', (chunk: Buffer) => {
        if (data.length < length) {
          const remaining = length - data.length;
          data = Buffer.concat([data, chunk.slice(0, remaining)]);
        }
        if (data.length >= length) {
          hash.update(data);
          resolve(hash.digest('hex'));
          (bufferOrStream as Readable).destroy?.();
        }
      });
      bufferOrStream.on('end', () => {
        if (data.length > 0) {
          hash.update(data);
          resolve(hash.digest('hex'));
        } else {
          resolve(hash.digest('hex'));
        }
      });
      bufferOrStream.on('error', reject);
    });
  }

  return Promise.resolve(hash.digest('hex'));
}
