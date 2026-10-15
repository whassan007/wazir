import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  isPathInside,
  isProcessAlive,
  getEnvCaseInsensitive,
  sanitizeChildEnvironment,
  resolveExecutable,
  isExecutableOnPath,
  GIT_NULL_DEVICE,
  GIT_NO_HOOKS,
  isBatchScript,
  getSpawnCommand,
  isWindowsReservedName,
  quoteWindowsArg,
  quotePosixArg,
} from '../src/platform.js';

describe('platform utilities', () => {
  describe('isPathInside', () => {
    it('returns true when target is identical to root', () => {
      expect(isPathInside('/home/user/project', '/home/user/project')).toBe(true);
    });

    it('returns true when target is a child of root', () => {
      expect(isPathInside('/home/user/project', '/home/user/project/src/index.ts')).toBe(true);
    });

    it('returns false when target traverses outside root', () => {
      expect(isPathInside('/home/user/project', '/home/user/project/../other')).toBe(false);
      expect(isPathInside('/home/user/project', '/home/user/other')).toBe(false);
      expect(isPathInside('/home/user/project', '/etc/passwd')).toBe(false);
    });

    it('handles relative traversal correctly', () => {
      expect(isPathInside('/home/user/project', '/home/user/project/src/../file')).toBe(true);
    });

    it('handles Windows drive paths safely', () => {
      const winPath = path.win32;
      const root = 'C:\\Users\\User\\project';
      const targetChild = 'C:\\Users\\User\\project\\file.txt';
      const targetDiffDrive = 'D:\\Users\\User\\project\\file.txt';
      const targetEscaped = 'C:\\Users\\User\\other.txt';

      const relChild = winPath.relative(winPath.resolve(root), winPath.resolve(targetChild));
      expect(relChild === '' || (!relChild.startsWith('..') && !winPath.isAbsolute(relChild))).toBe(true);

      const relDiff = winPath.relative(winPath.resolve(root), winPath.resolve(targetDiffDrive));
      expect(relDiff === '' || (!relDiff.startsWith('..') && !winPath.isAbsolute(relDiff))).toBe(false);

      const relEsc = winPath.relative(winPath.resolve(root), winPath.resolve(targetEscaped));
      expect(relEsc === '' || (!relEsc.startsWith('..') && !winPath.isAbsolute(relEsc))).toBe(false);
    });
  });

  describe('isProcessAlive', () => {
    it('returns true for current process', () => {
      expect(isProcessAlive(process.pid)).toBe(true);
    });

    it('returns false for undefined or non-existent pid', () => {
      expect(isProcessAlive(undefined)).toBe(false);
      expect(isProcessAlive(-1)).toBe(false);
      expect(isProcessAlive(0)).toBe(false);
      expect(isProcessAlive(9999999)).toBe(false);
    });
  });

  describe('getEnvCaseInsensitive', () => {
    it('finds env vars regardless of case', () => {
      const mockEnv = { Path: 'C:\\Windows', USER: 'alice', MixedCase_VAR: 'value' };
      expect(getEnvCaseInsensitive('PATH', mockEnv)).toBe('C:\\Windows');
      expect(getEnvCaseInsensitive('path', mockEnv)).toBe('C:\\Windows');
      expect(getEnvCaseInsensitive('user', mockEnv)).toBe('alice');
      expect(getEnvCaseInsensitive('MIXEDCASE_VAR', mockEnv)).toBe('value');
      expect(getEnvCaseInsensitive('NONEXISTENT', mockEnv)).toBeUndefined();
    });
  });

  describe('sanitizeChildEnvironment', () => {
    it('preserves essential environment variables regardless of casing', () => {
      const originalEnv = process.env;
      try {
        process.env = {
          Path: '/bin:/usr/bin',
          SystemRoot: 'C:\\Windows',
          SECRET_API_KEY: 'sensitive123',
          NODE_ENV: 'test',
        };

        const sanitized = sanitizeChildEnvironment();
        expect(sanitized.Path || sanitized.PATH).toBeDefined();
        expect(sanitized.SystemRoot || sanitized.SYSTEMROOT).toBeDefined();
        expect(sanitized.NODE_ENV).toBe('test');
        expect(sanitized.SECRET_API_KEY).toBeUndefined();
      } finally {
        process.env = originalEnv;
      }
    });

    it('includes extra variables provided', () => {
      const sanitized = sanitizeChildEnvironment({ CUSTOM_FLAG: '1' });
      expect(sanitized.CUSTOM_FLAG).toBe('1');
    });
  });

  describe('resolveExecutable and isExecutableOnPath', () => {
    it('resolves node executable on path', () => {
      const resolved = resolveExecutable('node');
      expect(resolved).toBeDefined();
      expect(typeof resolved).toBe('string');
      expect(isExecutableOnPath('node')).toBe(true);
    });

    it('returns undefined for nonexistent binary', () => {
      expect(resolveExecutable('nonexistent-binary-xyz-12345')).toBeUndefined();
      expect(isExecutableOnPath('nonexistent-binary-xyz-12345')).toBe(false);
    });
  });

  describe('git constants', () => {
    it('defines GIT_NULL_DEVICE and GIT_NO_HOOKS appropriately', () => {
      expect(GIT_NULL_DEVICE).toBe(process.platform === 'win32' ? 'NUL' : '/dev/null');
      expect(GIT_NO_HOOKS).toContain(`core.hooksPath=${GIT_NULL_DEVICE}`);
    });
  });

  describe('getSpawnCommand and isBatchScript', () => {
    it('detects batch scripts on Windows and prepares spawn command', () => {
      expect(isBatchScript('test.cmd')).toBe(process.platform === 'win32');
      expect(isBatchScript('test.bat')).toBe(process.platform === 'win32');
      expect(isBatchScript('test.exe')).toBe(false);
      expect(isBatchScript('test.sh')).toBe(false);

      const spawnCmd = getSpawnCommand('node', ['--version']);
      expect(spawnCmd.command).toBeDefined();
      expect(spawnCmd.args).toEqual(['--version']);
    });
  });

  describe('isWindowsReservedName', () => {
    it('detects Windows reserved device names and invalid trailing chars', () => {
      if (process.platform === 'win32') {
        expect(isWindowsReservedName('CON')).toBe(true);
        expect(isWindowsReservedName('prn.txt')).toBe(true);
        expect(isWindowsReservedName('aux')).toBe(true);
        expect(isWindowsReservedName('NUL')).toBe(true);
        expect(isWindowsReservedName('com1')).toBe(true);
        expect(isWindowsReservedName('lpt3')).toBe(true);
        expect(isWindowsReservedName('trailing.')).toBe(true);
        expect(isWindowsReservedName('trailing ')).toBe(true);
        expect(isWindowsReservedName('normal_file')).toBe(false);
      } else {
        expect(isWindowsReservedName('CON')).toBe(false);
      }
    });
  });

  describe('quoteWindowsArg and quotePosixArg', () => {
    it('quotes arguments safely for Windows and POSIX shells', () => {
      expect(quoteWindowsArg('')).toBe('""');
      expect(quoteWindowsArg('simple')).toBe('simple');
      expect(quoteWindowsArg('with spaces')).toBe('"with spaces"');
      expect(quoteWindowsArg('with"quotes')).toBe('"with\\"quotes"');

      expect(quotePosixArg('')).toBe("''");
      expect(quotePosixArg('simple')).toBe('simple');
      expect(quotePosixArg('with spaces')).toBe("'with spaces'");
      expect(quotePosixArg("it's")).toBe("'it'\\''s'");
    });
  });
});

