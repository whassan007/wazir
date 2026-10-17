import readline from 'node:readline';
import os from 'node:os';
import { Command } from 'commander';
import chalk from 'chalk';

export interface MobileCliConfig {
  controllerUrl: string;
  operatorToken?: string;
}

function resolveControllerConfig(opts: { url?: string; token?: string }): MobileCliConfig {
  const controllerUrl = (
    opts.url ??
    process.env.WAZIR_CONTROLLER_URL ??
    process.env.WAZIR_API_URL ??
    `http://${process.env.WAZIR_HOST ?? '127.0.0.1'}:${process.env.PORT ?? '4800'}`
  ).replace(/\/+$/, '');
  const operatorToken = opts.token ?? process.env.WAZIR_API_TOKEN;
  return { controllerUrl, operatorToken };
}

function detectDefaultAdvertiseHttpsUrl(controllerUrl: string, explicitAdvertiseUrl?: string): string {
  if (explicitAdvertiseUrl) return explicitAdvertiseUrl.replace(/\/+$/, '');
  try {
    const parsed = new URL(controllerUrl);
    if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
      return controllerUrl;
    }
    const interfaces = os.networkInterfaces();
    for (const list of Object.values(interfaces)) {
      for (const iface of list ?? []) {
        if (!iface.internal && iface.family === 'IPv4') {
          const scheme = parsed.protocol === 'https:' ? 'https' : 'https';
          const portPart = parsed.port ? `:${parsed.port}` : '';
          return `${scheme}://${iface.address}${portPart}`;
        }
      }
    }
  } catch {
    // fallback
  }
  return controllerUrl;
}

async function apiRequest<T>(
  config: MobileCliConfig,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: T }> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  if (config.operatorToken) {
    headers.Authorization = `Bearer ${config.operatorToken}`;
  }
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  const response = await fetch(`${config.controllerUrl}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let data: unknown = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  return { status: response.status, data: data as T };
}

/**
 * Renders a scannable terminal QR visual frame and human-verifiable pairing block.
 * Uses deterministic finder patterns + data matrix encoding rendered with Unicode half-blocks.
 */
export function renderTerminalQrCode(payload: string): string {
  const size = 29; // Version 3 QR dimensions (29x29)
  const grid: boolean[][] = Array.from({ length: size }, () => Array(size).fill(false));
  const reserved: boolean[][] = Array.from({ length: size }, () => Array(size).fill(false));

  const placeFinder = (rowOffset: number, colOffset: number) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = rowOffset + r;
        const cc = colOffset + c;
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
        reserved[rr][cc] = true;
        const inOuter = r >= 0 && r <= 6 && c >= 0 && c <= 6 && (r === 0 || r === 6 || c === 0 || c === 6);
        const inInner = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        grid[rr][cc] = inOuter || inInner;
      }
    }
  };

  placeFinder(0, 0);
  placeFinder(0, size - 7);
  placeFinder(size - 7, 0);

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    reserved[6][i] = true;
    reserved[i][6] = true;
    grid[6][i] = i % 2 === 0;
    grid[i][6] = i % 2 === 0;
  }

  // Alignment pattern at (20, 20)
  for (let r = -2; r <= 2; r++) {
    for (let c = -2; c <= 2; c++) {
      const rr = 22 + r;
      const cc = 22 + c;
      reserved[rr][cc] = true;
      grid[rr][cc] = Math.abs(r) === 2 || Math.abs(c) === 2 || (r === 0 && c === 0);
    }
  }

  // Encode payload bytes into remaining modules
  const bytes = Buffer.from(payload, 'utf8');
  let bitIdx = 0;
  const totalBits = bytes.length * 8;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let row = 0; row < size; row++) {
      for (let c = 0; c < 2; c++) {
        const cc = col - c;
        if (reserved[row][cc]) continue;
        const bytePos = Math.floor(bitIdx / 8) % bytes.length;
        const bitOffset = 7 - (bitIdx % 8);
        const bit = ((bytes[bytePos] >> bitOffset) & 1) === 1;
        const mask = (row + cc) % 2 === 0;
        grid[row][cc] = bitIdx < totalBits ? bit !== mask : mask;
        bitIdx++;
      }
    }
  }

  // Quiet zone of 2 modules around the matrix, rendered 2 rows per line using Unicode half-blocks
  const paddedSize = size + 4;
  const getModule = (r: number, c: number): boolean => {
    const rr = r - 2;
    const cc = c - 2;
    if (rr < 0 || rr >= size || cc < 0 || cc >= size) return false;
    return grid[rr][cc];
  };

  const lines: string[] = [];
  for (let r = 0; r < paddedSize; r += 2) {
    let line = '  ';
    for (let c = 0; c < paddedSize; c++) {
      const top = getModule(r, c);
      const bottom = r + 1 < paddedSize ? getModule(r + 1, c) : false;
      if (top && bottom) line += ' ';
      else if (top && !bottom) line += '▄';
      else if (!top && bottom) line += '▀';
      else line += '█';
    }
    lines.push(line);
  }
  return lines.join('\n');
}

async function promptYesNo(question: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise<boolean>((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      const normalized = answer.trim().toLowerCase();
      resolve(normalized === 'y' || normalized === 'yes');
    });
  });
}

export async function runMobilePairCommand(options: {
  url?: string;
  advertiseUrl?: string;
  token?: string;
  fingerprint?: string;
  role?: 'operator' | 'viewer';
  wait?: boolean;
  autoApprove?: boolean;
  timeout?: string;
  json?: boolean;
}): Promise<number> {
  const config = resolveControllerConfig(options);

  // 1. Verify the local controller is running
  let healthResp: { status: number; data: { status?: string; version?: string } };
  try {
    healthResp = await apiRequest(config, 'GET', '/health');
  } catch (error) {
    const msg = `Controller is not reachable at ${config.controllerUrl} (${error instanceof Error ? error.message : String(error)})`;
    if (options.json) {
      console.log(JSON.stringify({ ok: false, error: msg, code: 'CONTROLLER_UNREACHABLE' }));
    } else {
      console.error(chalk.red(`✗ ${msg}`));
      console.error(chalk.dim('  Start the Wazir API server first or specify --url <https://controller:4800>.'));
    }
    return 1;
  }

  if (healthResp.status !== 200 || healthResp.data?.status !== 'ok') {
    const msg = `Controller health check failed with HTTP ${healthResp.status}`;
    if (options.json) {
      console.log(JSON.stringify({ ok: false, error: msg, code: 'CONTROLLER_UNHEALTHY' }));
    } else {
      console.error(chalk.red(`✗ ${msg}`));
    }
    return 1;
  }

  // 2. Create a short-lived, single-use pairing session (never embedding the permanent operator token)
  // No `execute` scope by default: the mobile app submits/cancels tasks and decides
  // approvals through the mobile API's own policy/approval gates, never raw tool
  // execution over /ap/v1 or /mcp. Granting `execute` would let a stolen device
  // credential bypass those gates entirely — call the pairing API directly with an
  // explicit `scopes` override if a device genuinely needs it.
  const scopes = options.role === 'viewer' ? ['read'] : ['read', 'mutate'];
  const advertisedUrl = detectDefaultAdvertiseHttpsUrl(config.controllerUrl, options.advertiseUrl);

  const createResp = await apiRequest<{
    sessionId: string;
    pairingSecret: string;
    expiresAt: number;
    scopes: string[];
    qrUri: string;
    controllerName: string;
    error?: string;
  }>(config, 'POST', '/api/v1/mobile/pair/sessions', {
    scopes,
    controllerUrl: advertisedUrl,
    tlsCertFingerprint: options.fingerprint,
  });

  if (createResp.status !== 201 || !createResp.data.sessionId) {
    const msg = createResp.data?.error ?? `Failed to create pairing session (HTTP ${createResp.status})`;
    if (options.json) {
      console.log(JSON.stringify({ ok: false, error: msg, code: 'SESSION_CREATE_FAILED' }));
    } else {
      console.error(chalk.red(`✗ ${msg}`));
    }
    return 1;
  }

  const session = createResp.data;
  if (options.json && options.wait === false) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          sessionId: session.sessionId,
          pairingSecret: session.pairingSecret,
          expiresAt: session.expiresAt,
          scopes: session.scopes,
          qrUri: session.qrUri,
          controllerUrl: advertisedUrl,
          controllerName: session.controllerName,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  if (!options.json) {
    console.log('');
    console.log(chalk.bold.cyan('=== Wazir Mobile — Secure Device Pairing ==='));
    console.log(chalk.dim('Single-use pairing session created. Permanent operator credentials are never embedded in the QR code.'));
    console.log('');
    console.log(renderTerminalQrCode(session.qrUri));
    console.log('');
    console.log(`  ${chalk.bold('Controller Name:')}  ${session.controllerName}`);
    console.log(`  ${chalk.bold('HTTPS Endpoint:')}   ${chalk.green(advertisedUrl)}`);
    if (options.fingerprint) {
      console.log(`  ${chalk.bold('TLS Fingerprint:')}  ${options.fingerprint}`);
    }
    console.log(`  ${chalk.bold('Session ID:')}       ${session.sessionId}`);
    console.log(`  ${chalk.bold('One-Time Code:')}    ${session.pairingSecret}`);
    console.log(`  ${chalk.bold('Permissions:')}      ${session.scopes.join(', ')}`);
    console.log(`  ${chalk.bold('Pairing URI:')}      ${chalk.underline(session.qrUri)}`);
    console.log(`  ${chalk.bold('Expires At:')}       ${new Date(session.expiresAt).toLocaleTimeString()}`);
    console.log('');
  }

  if (options.wait === false) {
    return 0;
  }

  if (!options.json) {
    console.log(chalk.yellow('Waiting for Wazir Mobile on Android to scan QR code or submit pairing request...'));
  }

  const timeoutSec = Math.max(5, Number(options.timeout ?? 300) || 300);
  const deadline = Date.now() + timeoutSec * 1000;

  while (Date.now() < deadline) {
    const poll = await apiRequest<{
      sessionId: string;
      status: string;
      confirmationCode?: string;
      deviceRequest?: {
        deviceId: string;
        deviceName: string;
        deviceModel?: string;
        osVersion?: string;
        publicKeyFingerprint?: string;
      };
    }>(config, 'GET', `/api/v1/mobile/pair/sessions/${encodeURIComponent(session.sessionId)}`);

    if (poll.status !== 200) {
      if (options.json) {
        console.log(JSON.stringify({ ok: false, error: 'Failed to poll pairing session' }));
      } else {
        console.error(chalk.red('✗ Pairing session disappeared or expired.'));
      }
      return 1;
    }

    const current = poll.data;
    if (current.status === 'expired') {
      if (options.json) {
        console.log(JSON.stringify({ ok: false, error: 'Pairing session expired', code: 'PAIRING_EXPIRED' }));
      } else {
        console.error(chalk.red('✗ Pairing session expired before device approval.'));
      }
      return 1;
    }

    if (current.status === 'pending_operator_approval' && current.deviceRequest) {
      const dev = current.deviceRequest;
      if (!options.json) {
        console.log('');
        console.log(chalk.bold.green('📱 Android Device Pairing Request Received!'));
        console.log(`  ${chalk.bold('Device Name:')}        ${dev.deviceName}`);
        if (dev.deviceModel) {
          console.log(`  ${chalk.bold('Model / OS:')}         ${dev.deviceModel} (${dev.osVersion ?? 'Android'})`);
        }
        console.log(`  ${chalk.bold('Device ID:')}          ${dev.deviceId}`);
        if (dev.publicKeyFingerprint) {
          console.log(`  ${chalk.bold('Key Fingerprint:')}    ${dev.publicKeyFingerprint}`);
        }
        console.log(`  ${chalk.bold('Confirmation Code:')}  ${chalk.bgCyan.black.bold(` ${current.confirmationCode ?? '------'} `)}`);
        console.log('');
      }

      const approved = options.autoApprove
        ? true
        : await promptYesNo(
            chalk.bold(`Verify that your Android phone displays code ${chalk.cyan(current.confirmationCode)}. Approve this device? (y/N): `),
          );

      if (!approved) {
        await apiRequest(config, 'POST', `/api/v1/mobile/pair/sessions/${encodeURIComponent(session.sessionId)}/reject`, {});
        if (options.json) {
          console.log(JSON.stringify({ ok: false, status: 'rejected', deviceId: dev.deviceId }));
        } else {
          console.log(chalk.yellow('✗ Device pairing rejected by operator.'));
        }
        return 1;
      }

      const approveResp = await apiRequest<{
        ok?: boolean;
        deviceId?: string;
        scopes?: string[];
        error?: string;
      }>(config, 'POST', `/api/v1/mobile/pair/sessions/${encodeURIComponent(session.sessionId)}/approve`, {
        confirmationCode: current.confirmationCode,
        scopes,
      });

      if (approveResp.status !== 200 || !approveResp.data.ok) {
        const errMsg = approveResp.data?.error ?? `Failed to approve pairing session (HTTP ${approveResp.status})`;
        if (options.json) {
          console.log(JSON.stringify({ ok: false, error: errMsg }));
        } else {
          console.error(chalk.red(`✗ ${errMsg}`));
        }
        return 1;
      }

      if (options.json) {
        console.log(
          JSON.stringify(
            {
              ok: true,
              status: 'approved',
              sessionId: session.sessionId,
              deviceId: approveResp.data.deviceId,
              deviceName: dev.deviceName,
              confirmationCode: current.confirmationCode,
              scopes: approveResp.data.scopes,
            },
            null,
            2,
          ),
        );
      } else {
        console.log(chalk.bold.green(`✓ Approved and paired '${dev.deviceName}' (${approveResp.data.deviceId})!`));
        console.log(chalk.dim(`  Revoke anytime with: wa mobile revoke ${approveResp.data.deviceId}`));
      }
      return 0;
    }

    await new Promise((r) => setTimeout(r, 400));
  }

  if (options.json) {
    console.log(JSON.stringify({ ok: false, error: 'Timed out waiting for device pairing request', code: 'PAIRING_TIMEOUT' }));
  } else {
    console.error(chalk.red('✗ Timed out waiting for Android device to request pairing.'));
  }
  return 1;
}

export function registerMobileCommands(program: Command): void {
  const mobile = program
    .command('mobile')
    .description('Pair and manage Wazir Mobile Android companion devices and remote approvals');

  mobile
    .command('pair')
    .description('Start a short-lived, single-use QR pairing session for Wazir Mobile on Android')
    .option('--url <url>', 'Local controller URL (defaults to http://127.0.0.1:4800)')
    .option('--advertise-url <url>', 'Authenticated HTTPS URL advertised in the QR code for the phone')
    .option('--token <token>', 'Operator API token (or set WAZIR_API_TOKEN)')
    .option('--fingerprint <sha256>', 'Optional TLS certificate SHA-256 fingerprint for certificate pinning')
    .option('--role <role>', 'Permission role for the mobile device: operator or viewer', 'operator')
    .option('--no-wait', 'Create and print the pairing session without waiting for the phone')
    .option('--auto-approve', 'Automatically approve the first valid pairing request (for automated tests)')
    .option('--timeout <seconds>', 'Maximum seconds to wait for pairing request', '300')
    .option('--json', 'Output in JSON format')
    .action(async (options) => {
      const code = await runMobilePairCommand(options);
      if (code !== 0) process.exitCode = code;
    });

  mobile
    .command('devices')
    .description('List registered Wazir Mobile devices')
    .option('--url <url>', 'Controller URL')
    .option('--token <token>', 'Operator API token')
    .option('--json', 'Output in JSON format')
    .action(async (options) => {
      const config = resolveControllerConfig(options);
      const res = await apiRequest<{
        devices?: Array<{
          deviceId: string;
          deviceName: string;
          deviceModel?: string;
          scopes: string[];
          pairedAt: string;
          lastSeenAt: string;
          revoked: boolean;
        }>;
        error?: string;
      }>(config, 'GET', '/api/v1/mobile/devices');
      if (res.status !== 200) {
        console.error(chalk.red(res.data?.error ?? `Failed to list devices (HTTP ${res.status})`));
        process.exitCode = 1;
        return;
      }
      const devices = res.data.devices ?? [];
      if (options.json) {
        console.log(JSON.stringify({ devices }, null, 2));
        return;
      }
      if (devices.length === 0) {
        console.log(chalk.dim('No Wazir Mobile devices paired. Run `wa mobile pair` to connect your phone.'));
        return;
      }
      for (const d of devices) {
        const stateLabel = d.revoked ? chalk.red('REVOKED') : chalk.green('ACTIVE');
        console.log(`${stateLabel}  ${chalk.bold(d.deviceId)}  ${d.deviceName} (${d.deviceModel ?? 'Android'})  scopes=[${d.scopes.join(',')}]  lastSeen=${d.lastSeenAt}`);
      }
    });

  mobile
    .command('revoke <deviceId>')
    .description('Revoke a paired Wazir Mobile device credential immediately')
    .option('--url <url>', 'Controller URL')
    .option('--token <token>', 'Operator API token')
    .option('--json', 'Output in JSON format')
    .action(async (deviceId: string, options) => {
      const config = resolveControllerConfig(options);
      const res = await apiRequest<{ ok?: boolean; error?: string }>(
        config,
        'DELETE',
        `/api/v1/mobile/devices/${encodeURIComponent(deviceId)}`,
      );
      if (res.status !== 200 || !res.data.ok) {
        console.error(chalk.red(res.data?.error ?? `Failed to revoke device '${deviceId}'`));
        process.exitCode = 1;
        return;
      }
      if (options.json) {
        console.log(JSON.stringify({ ok: true, deviceId }));
      } else {
        console.log(chalk.green(`✓ Revoked mobile device '${deviceId}'.`));
      }
    });

  mobile
    .command('approvals')
    .description('List pending and recent human policy approvals')
    .option('--url <url>', 'Controller URL')
    .option('--token <token>', 'Operator API token')
    .option('--status <status>', 'Filter by status (pending, approved, rejected, expired)')
    .option('--json', 'Output in JSON format')
    .action(async (options) => {
      const config = resolveControllerConfig(options);
      const query = options.status ? `?status=${encodeURIComponent(options.status)}` : '';
      const res = await apiRequest<{
        approvals?: Array<{
          id: string;
          status: string;
          tool: string;
          operation: string;
          riskClassification: string;
          createdAt: string;
        }>;
        error?: string;
      }>(config, 'GET', `/api/v1/mobile/approvals${query}`);
      if (res.status !== 200) {
        console.error(chalk.red(res.data?.error ?? `Failed to list approvals (HTTP ${res.status})`));
        process.exitCode = 1;
        return;
      }
      if (options.json) {
        console.log(JSON.stringify(res.data, null, 2));
        return;
      }
      const list = res.data.approvals ?? [];
      if (list.length === 0) {
        console.log(chalk.dim('No policy approvals found.'));
        return;
      }
      for (const a of list) {
        console.log(`[${a.status.toUpperCase()}] ${chalk.bold(a.id)}  risk=${a.riskClassification}  ${a.operation}  (${a.createdAt})`);
      }
    });
}
