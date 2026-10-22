import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { ServiceManager } from '../../apps/cli/src/serviceManager.js';

const rootDir = path.resolve(__dirname, '../..');
const pkg = JSON.parse(readFileSync(path.resolve(rootDir, 'package.json'), 'utf8'));
const currentVersion = pkg.version;

describe('Server Distribution & Containerization', () => {
  describe('1. Docker & OCI Images', () => {
    const dockerfilePath = path.resolve(rootDir, 'Dockerfile');
    const composePath = path.resolve(rootDir, 'docker-compose.yml');
    const entrypointPath = path.resolve(rootDir, 'docker/entrypoint.sh');

    it('Dockerfile adheres to OCI standards and security best practices', () => {
      expect(existsSync(dockerfilePath)).toBe(true);
      const content = readFileSync(dockerfilePath, 'utf8');

      // Multi-stage builder & runtime
      expect(content).toContain('FROM node:22-bookworm-slim AS builder');
      expect(content).toContain('FROM node:22-bookworm-slim AS runtime');

      // Non-root user setup
      expect(content).toContain('useradd -u 1000 -g wazir');
      expect(content).toContain('USER wazir');

      // Persistence and ports
      expect(content).toContain('VOLUME ["/home/wazir/.wazir"]');
      expect(content).toContain('EXPOSE 3000 3001');

      // OCI annotations
      expect(content).toContain('org.opencontainers.image.title="Wazir"');
      expect(content).toContain('org.opencontainers.image.licenses="AGPL-3.0-or-later"');

      // Healthcheck
      expect(content).toContain('HEALTHCHECK');
      expect(content).toContain('ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]');
    });

    it('docker-compose.yml orchestrates controller and worker fleet with persistence', () => {
      expect(existsSync(composePath)).toBe(true);
      const content = readFileSync(composePath, 'utf8');

      // Controller and Worker services
      expect(content).toContain('wazir-api:');
      expect(content).toContain('wazir-worker:');
      expect(content).toContain('wazir-net:');

      // Persistence volumes
      expect(content).toContain('wazir-controller-data:');
      expect(content).toContain('wazir-worker-data:');

      // DGX Spark / NVIDIA GPU options
      expect(content).toContain('driver: nvidia');
    });

    it('docker entrypoint script supports controller, worker, and CLI modes', () => {
      expect(existsSync(entrypointPath)).toBe(true);
      const content = readFileSync(entrypointPath, 'utf8');

      expect(content).toContain('api|controller)');
      expect(content).toContain('exec wa api start');
      expect(content).toContain('worker)');
      expect(content).toContain('exec wa worker start');
    });
  });

  describe('2. Debian / Ubuntu (.deb) Packaging', () => {
    it('Debian control file and maintainer scripts are properly configured', () => {
      const controlPath = path.resolve(rootDir, 'packaging/deb/debian/control');
      const postinstPath = path.resolve(rootDir, 'packaging/deb/debian/postinst');
      const prermPath = path.resolve(rootDir, 'packaging/deb/debian/prerm');
      const postrmPath = path.resolve(rootDir, 'packaging/deb/debian/postrm');

      expect(existsSync(controlPath)).toBe(true);
      const control = readFileSync(controlPath, 'utf8');
      expect(control).toContain('Package: wazir');
      expect(control).toContain(`Version: ${currentVersion}`);
      expect(control).toContain('Depends: nodejs (>= 22.13.0)');

      // Postinst creates user and reloads systemd
      const postinst = readFileSync(postinstPath, 'utf8');
      expect(postinst).toContain('useradd --system --gid wazir');
      expect(postinst).toContain('systemctl daemon-reload');

      // Prerm stops services cleanly
      const prerm = readFileSync(prermPath, 'utf8');
      expect(prerm).toContain('systemctl stop wazir-api.service');
      expect(prerm).toContain('systemctl stop wazir-worker.service');

      // Postrm preserves data on remove and only deletes on purge
      const postrm = readFileSync(postrmPath, 'utf8');
      expect(postrm).toContain('purge)');
      expect(postrm).toContain('rm -rf /var/lib/wazir');
      expect(postrm).toContain('remove|upgrade');
    });
  });

  describe('3. Fedora / RHEL (.rpm) Packaging', () => {
    it('RPM spec file complies with RPM packaging guidelines', () => {
      const specPath = path.resolve(rootDir, 'packaging/rpm/wazir.spec');
      expect(existsSync(specPath)).toBe(true);
      const spec = readFileSync(specPath, 'utf8');

      expect(spec).toContain('Name:           wazir');
      expect(spec).toContain(`Version:        ${currentVersion}`);
      expect(spec).toContain('License:        AGPL-3.0-only');
      expect(spec).toContain('Requires:       nodejs >= 22.13.0');
      expect(spec).toContain('%pre');
      expect(spec).toContain('useradd -r -g wazir');
      expect(spec).toContain('%systemd_post wazir-api.service wazir-worker.service');
      expect(spec).toContain('%systemd_preun wazir-api.service wazir-worker.service');
    });
  });

  describe('4. Cross-Platform System Services (wa service)', () => {
    it('ServiceManager resolves correct backend for operating system', () => {
      const sm = new ServiceManager();
      const backend = sm.getBackend();

      if (process.platform === 'linux') {
        expect(backend).toBe('systemd');
      } else if (process.platform === 'darwin') {
        expect(backend).toBe('launchd');
      } else if (process.platform === 'win32') {
        expect(backend).toBe('windows');
      }
    });

    it('wa service --help and status execute cleanly via CLI bundle', () => {
      const waBin = path.resolve(rootDir, 'bin/wa.js');
      expect(existsSync(waBin)).toBe(true);

      const helpOut = execSync(`node "${waBin}" service --help`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      expect(helpOut).toContain('Manage Wazir background daemon services');
      expect(helpOut).toContain('install');
      expect(helpOut).toContain('start');
      expect(helpOut).toContain('stop');
      expect(helpOut).toContain('status');
      expect(helpOut).toContain('uninstall');

      const statusOut = execSync(`node "${waBin}" service status --json`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      const parsed = JSON.parse(statusOut);
      expect(parsed.platform).toBe(process.platform);
      expect(parsed.serviceName).toBe('wazir');
      expect(typeof parsed.installed).toBe('boolean');
    });
  });
});
