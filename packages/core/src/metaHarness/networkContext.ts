import type {
  ConfiguredSecureTransport,
  EndpointResolutionResult,
  ExecutionWorkerNode,
  InferenceEndpointNode,
  NetworkIdentityNode,
  NetworkVisibilityScope,
} from './types.js';

export interface AuthorizedHostConfig {
  hostId: string;
  machineId?: string;
  hostname?: string;
  aliases?: string[];
  authorizedAddresses?: string[];
  sshTarget?: string;
}

function parseHostnameAndPort(rawUrlOrHost: string): { hostname: string; port?: string; protocol?: string } {
  const trimmed = (rawUrlOrHost ?? '').trim();
  if (!trimmed) return { hostname: '' };

  if (trimmed === '::1' || trimmed === '[::1]') {
    return { hostname: '::1' };
  }

  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    const parsed = new URL(candidate);
    const cleanHost = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return {
      hostname: cleanHost,
      port: parsed.port || undefined,
      protocol: parsed.protocol.replace(/:$/, '').toLowerCase(),
    };
  } catch {
    const noPath = trimmed.split('/')[0] ?? '';
    if (noPath.startsWith('[')) {
      const endBracket = noPath.indexOf(']');
      if (endBracket !== -1) {
        const host = noPath.slice(1, endBracket).toLowerCase();
        const rest = noPath.slice(endBracket + 1);
        const port = rest.startsWith(':') ? rest.slice(1) : undefined;
        return { hostname: host, port };
      }
    }
    const colonParts = noPath.split(':');
    if (colonParts.length === 2 && /^\d+$/.test(colonParts[1])) {
      return { hostname: colonParts[0].toLowerCase(), port: colonParts[1] };
    }
    return { hostname: noPath.toLowerCase() };
  }
}

function parseIpv4Octets(hostname: string): [number, number, number, number] | undefined {
  const match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return undefined;
  const octets = [
    Number.parseInt(match[1], 10),
    Number.parseInt(match[2], 10),
    Number.parseInt(match[3], 10),
    Number.parseInt(match[4], 10),
  ] as [number, number, number, number];
  if (octets.some((o) => !Number.isFinite(o) || o < 0 || o > 255)) {
    return undefined;
  }
  return octets;
}

/**
 * Returns true strictly for loopback addresses (`127.0.0.0/8`, `localhost`, `::1`, `[::1]`).
 */
export function isLoopbackUrl(url: string): boolean {
  const { hostname } = parseHostnameAndPort(url);
  if (!hostname) return false;
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '::1' ||
    hostname === '0:0:0:0:0:0:0:1'
  ) {
    return true;
  }
  const octets = parseIpv4Octets(hostname);
  if (octets && octets[0] === 127) {
    return true;
  }
  return false;
}

function isTailscaleHost(hostname: string): boolean {
  if (!hostname) return false;
  if (hostname.endsWith('.ts.net')) return true;
  if (hostname.startsWith('fd7a:115c:a1e0:')) return true;
  const octets = parseIpv4Octets(hostname);
  if (octets) {
    // CGNAT 100.64.0.0/10 -> 100.64.0.0 .. 100.127.255.255
    return octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
  }
  return false;
}

function isRfc1918OrLocalLanHost(hostname: string): boolean {
  if (!hostname) return false;
  if (hostname.endsWith('.local') || hostname.endsWith('.lan') || hostname.endsWith('.home.arpa')) {
    return true;
  }
  if (hostname.startsWith('fe80:') || hostname.startsWith('fc00:') || hostname.startsWith('fd00:')) {
    return true;
  }
  const octets = parseIpv4Octets(hostname);
  if (octets) {
    const [a, b] = octets;
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }
  // Single-label hostname without dots (e.g. 'studio', 'dgx-spark') on local network/SSH config
  if (!hostname.includes('.') && !hostname.includes(':')) {
    return true;
  }
  return false;
}

/**
 * Classifies an endpoint URL's network visibility scope without guessing or mutating its host.
 */
export function classifyUrlVisibility(url: string, hasTunnelTarget = false): NetworkVisibilityScope {
  if (isLoopbackUrl(url)) {
    return hasTunnelTarget ? 'ssh_tunnel_forwarded' : 'loopback_only';
  }
  const { hostname } = parseHostnameAndPort(url);
  if (isTailscaleHost(hostname)) {
    return 'tailscale';
  }
  if (isRfc1918OrLocalLanHost(hostname)) {
    return 'lan';
  }
  return 'cloud_api';
}

function portsCompatible(remoteLoopbackUrl: string, endpointRawUrl: string): boolean {
  const tunnelParsed = parseHostnameAndPort(remoteLoopbackUrl);
  const endpointParsed = parseHostnameAndPort(endpointRawUrl);
  if (tunnelParsed.port && endpointParsed.port) {
    return tunnelParsed.port === endpointParsed.port;
  }
  return true;
}

/**
 * Resolves an `InferenceEndpointNode` strictly relative to `callerHostId`.
 *
 * Critical Networking Invariant:
 * - `127.0.0.1` / `localhost` ALWAYS refers to `endpoint.originContextHostId`.
 * - Remote `loopback_only` endpoints are ONLY usable via a verified `ssh_tunnel`
 *   originating on `callerHostId` or an `online` `ExecutionWorkerNode` running on `endpoint.hostId`.
 * - NEVER rewrites `127.0.0.1` to a guessed LAN or Tailscale IP.
 */
export function resolveEndpointForExecutionContext(params: {
  endpoint: InferenceEndpointNode;
  callerHostId: string;
  transports: ConfiguredSecureTransport[];
  workers: ExecutionWorkerNode[];
}): EndpointResolutionResult {
  const { endpoint, callerHostId, transports, workers } = params;
  const targetHostId = endpoint.hostId;

  if (endpoint.acceptanceState === 'DISABLED_BY_POLICY') {
    return {
      usable: false,
      callerHostId,
      targetHostId,
      routeVia: 'unreachable_loopback',
      reason: `Endpoint '${endpoint.endpointId}' is disabled by policy`,
    };
  }

  // Cloud APIs are globally addressable over HTTPS from authorized hosts
  if (endpoint.visibility === 'cloud_api') {
    return {
      usable: true,
      callerHostId,
      targetHostId,
      resolvedUrl: endpoint.rawUrl,
      routeVia: 'cloud_api',
      reason: `Cloud API endpoint '${endpoint.endpointId}' reachable from '${callerHostId}'`,
    };
  }

  // Pre-forwarded SSH tunnel endpoint whose local listener lives on originContextHostId
  if (endpoint.visibility === 'ssh_tunnel_forwarded' && endpoint.originContextHostId === callerHostId) {
    if (endpoint.tunnelTransportId) {
      const boundTunnel = transports.find((t) => t.transportId === endpoint.tunnelTransportId);
      if (boundTunnel && !boundTunnel.verifiedActive) {
        const fallbackWorker = workers.find((w) => w.hostId === targetHostId && w.status === 'online');
        if (fallbackWorker) {
          return {
            usable: true,
            callerHostId,
            targetHostId,
            resolvedUrl: boundTunnel.remoteLoopbackUrl,
            routeVia: 'remote_worker',
            reason: `SSH tunnel '${boundTunnel.transportId}' is inactive; routing via online remote worker '${fallbackWorker.workerId}' on '${targetHostId}'`,
          };
        }
        return {
          usable: false,
          callerHostId,
          targetHostId,
          routeVia: 'unreachable_loopback',
          reason: `SSH tunnel '${boundTunnel.transportId}' from '${callerHostId}' to '${targetHostId}' is not verified active`,
        };
      }
    }
    return {
      usable: true,
      callerHostId,
      targetHostId,
      resolvedUrl: endpoint.rawUrl,
      routeVia: 'ssh_tunnel',
      reason: `Endpoint '${endpoint.endpointId}' uses verified local SSH tunnel forward on '${callerHostId}' -> '${targetHostId}'`,
    };
  }

  const rawIsLoopback = isLoopbackUrl(endpoint.rawUrl) || endpoint.visibility === 'loopback_only';

  // Caller IS the origin context host of rawUrl
  if (endpoint.originContextHostId === callerHostId) {
    return {
      usable: true,
      callerHostId,
      targetHostId,
      resolvedUrl: endpoint.rawUrl,
      routeVia: rawIsLoopback ? 'local_loopback' : 'direct',
      reason: rawIsLoopback
        ? `Loopback endpoint '${endpoint.rawUrl}' belongs to caller host '${callerHostId}'`
        : `Direct endpoint '${endpoint.rawUrl}' originates on caller host '${callerHostId}'`,
    };
  }

  // Remote loopback endpoint: NEVER rewrite 127.0.0.1 to a LAN or Tailscale IP!
  if (rawIsLoopback) {
    const matchingTunnel = transports.find(
      (t) =>
        t.type === 'ssh_tunnel' &&
        t.verifiedActive &&
        t.originHostId === callerHostId &&
        t.targetHostId === targetHostId &&
        portsCompatible(t.remoteLoopbackUrl, endpoint.rawUrl),
    );
    if (matchingTunnel) {
      return {
        usable: true,
        callerHostId,
        targetHostId,
        resolvedUrl: matchingTunnel.localEndpointUrl,
        routeVia: 'ssh_tunnel',
        reason: `Remote loopback '${endpoint.rawUrl}' on '${targetHostId}' resolved via verified SSH tunnel '${matchingTunnel.transportId}' (${matchingTunnel.localEndpointUrl})`,
      };
    }

    const onlineWorker = workers.find((w) => w.hostId === targetHostId && w.status === 'online');
    if (onlineWorker) {
      return {
        usable: true,
        callerHostId,
        targetHostId,
        resolvedUrl: endpoint.rawUrl,
        routeVia: 'remote_worker',
        reason: `Remote loopback '${endpoint.rawUrl}' on '${targetHostId}' delegated to online worker '${onlineWorker.workerId}'`,
      };
    }

    return {
      usable: false,
      callerHostId,
      targetHostId,
      routeVia: 'unreachable_loopback',
      reason: `Remote loopback '${endpoint.rawUrl}' is bound to '${endpoint.originContextHostId}' and has no verified SSH tunnel or online worker from '${callerHostId}'`,
    };
  }

  // Non-loopback LAN or Tailscale endpoint explicitly bound on target host
  return {
    usable: true,
    callerHostId,
    targetHostId,
    resolvedUrl: endpoint.rawUrl,
    routeVia: 'direct',
    reason: `Addressable ${endpoint.visibility} endpoint '${endpoint.rawUrl}' reachable from '${callerHostId}'`,
  };
}

/**
 * Registry of explicitly authorized hosts, network identities, endpoints, and secure transports.
 * Strictly prohibits unconfigured subnet sweeps or wildcard CIDR scanning.
 */
export class AuthorizedHostRegistry {
  private readonly hosts = new Map<string, AuthorizedHostConfig>();
  private readonly authorizedAddresses = new Set<string>(['127.0.0.1', 'localhost', '::1']);
  private readonly networkIdentities = new Map<string, NetworkIdentityNode>();
  private readonly transports = new Map<string, ConfiguredSecureTransport>();
  private readonly endpoints = new Map<string, InferenceEndpointNode>();

  constructor(initial?: {
    hosts?: AuthorizedHostConfig[];
    transports?: ConfiguredSecureTransport[];
    endpoints?: InferenceEndpointNode[];
  }) {
    for (const host of initial?.hosts ?? []) {
      this.authorizeHost(host);
    }
    for (const transport of initial?.transports ?? []) {
      this.registerTransport(transport);
    }
    for (const endpoint of initial?.endpoints ?? []) {
      this.registerEndpoint(endpoint);
    }
  }

  /**
   * Rejects CIDR blocks, wildcard IP ranges, or arbitrary subnet scan targets.
   */
  assertNoArbitrarySubnetScan(target: string): void {
    const trimmed = (target ?? '').trim();
    if (!trimmed) {
      throw new Error('SUBNET_SCAN_FORBIDDEN: empty network target');
    }
    // Reject CIDR notation on host/IP (e.g. 192.168.1.0/24 or 10.0.0.0/8) unless it's an HTTP URL path
    const withoutScheme = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
    if (/^\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}$/.test(withoutScheme) || /^[0-9a-f:]+\/\d{1,3}$/i.test(withoutScheme)) {
      throw new Error(`SUBNET_SCAN_FORBIDDEN: arbitrary CIDR subnet scanning is prohibited ('${trimmed}')`);
    }
    if (withoutScheme.includes('*') || /\d+-\d+/.test(withoutScheme.split('/')[0] ?? '') && /^\d+\.\d+\.\d+\.\d+-\d+$/.test(withoutScheme)) {
      throw new Error(`SUBNET_SCAN_FORBIDDEN: wildcard or IP range scanning is prohibited ('${trimmed}')`);
    }
  }

  authorizeHost(config: AuthorizedHostConfig): void {
    if (config.sshTarget) {
      this.assertNoArbitrarySubnetScan(config.sshTarget);
    }
    for (const addr of config.authorizedAddresses ?? []) {
      this.assertNoArbitrarySubnetScan(addr);
      const { hostname } = parseHostnameAndPort(addr);
      if (hostname) this.authorizedAddresses.add(hostname);
    }
    if (config.hostname) {
      this.authorizedAddresses.add(config.hostname.toLowerCase());
    }
    for (const alias of config.aliases ?? []) {
      this.authorizedAddresses.add(alias.toLowerCase());
    }
    if (config.sshTarget) {
      const sshHost = config.sshTarget.includes('@') ? config.sshTarget.split('@')[1] : config.sshTarget;
      if (sshHost) this.authorizedAddresses.add(sshHost.toLowerCase());
    }
    this.authorizedAddresses.add(config.hostId.toLowerCase());
    this.hosts.set(config.hostId, {
      ...config,
      aliases: config.aliases ? [...config.aliases] : [],
      authorizedAddresses: config.authorizedAddresses ? [...config.authorizedAddresses] : [],
    });
  }

  isHostAuthorized(hostIdOrUrl: string): boolean {
    this.assertNoArbitrarySubnetScan(hostIdOrUrl);
    if (this.hosts.has(hostIdOrUrl)) return true;
    if (isLoopbackUrl(hostIdOrUrl)) return true;
    const { hostname } = parseHostnameAndPort(hostIdOrUrl);
    return Boolean(hostname && this.authorizedAddresses.has(hostname));
  }

  assertAuthorizedTarget(hostIdOrUrl: string): void {
    if (!this.isHostAuthorized(hostIdOrUrl)) {
      throw new Error(`UNAUTHORIZED_NETWORK_TARGET: '${hostIdOrUrl}' is not in the authorized host registry`);
    }
  }

  registerNetworkIdentity(identity: NetworkIdentityNode): NetworkIdentityNode {
    this.assertNoArbitrarySubnetScan(identity.address);
    const authorized = identity.authorized && (this.hosts.has(identity.hostId) || this.isHostAuthorized(identity.address));
    const normalized: NetworkIdentityNode = { ...identity, authorized };
    this.networkIdentities.set(normalized.networkId, normalized);
    if (authorized) {
      const { hostname } = parseHostnameAndPort(identity.address);
      if (hostname) this.authorizedAddresses.add(hostname);
    }
    return normalized;
  }

  registerTransport(transport: ConfiguredSecureTransport): ConfiguredSecureTransport {
    this.assertNoArbitrarySubnetScan(transport.localEndpointUrl);
    this.assertNoArbitrarySubnetScan(transport.remoteLoopbackUrl);
    this.transports.set(transport.transportId, { ...transport });
    return transport;
  }

  setTransportVerified(transportId: string, verifiedActive: boolean): void {
    const existing = this.transports.get(transportId);
    if (existing) {
      existing.verifiedActive = verifiedActive;
    }
  }

  registerEndpoint(endpoint: InferenceEndpointNode): InferenceEndpointNode {
    this.assertNoArbitrarySubnetScan(endpoint.rawUrl);
    if (endpoint.visibility !== 'cloud_api' && this.hosts.size > 0 && !this.hosts.has(endpoint.hostId) && !this.isHostAuthorized(endpoint.rawUrl)) {
      throw new Error(
        `UNAUTHORIZED_ENDPOINT: endpoint '${endpoint.endpointId}' (${endpoint.rawUrl}) belongs to unconfigured host '${endpoint.hostId}'`,
      );
    }
    this.endpoints.set(endpoint.endpointId, { ...endpoint });
    return endpoint;
  }

  getHost(hostId: string): AuthorizedHostConfig | undefined {
    return this.hosts.get(hostId);
  }

  listAuthorizedHosts(): AuthorizedHostConfig[] {
    return [...this.hosts.values()];
  }

  listNetworkIdentities(): NetworkIdentityNode[] {
    return [...this.networkIdentities.values()];
  }

  listTransports(): ConfiguredSecureTransport[] {
    return [...this.transports.values()];
  }

  listEndpoints(): InferenceEndpointNode[] {
    return [...this.endpoints.values()];
  }

  resolveEndpoint(
    endpointOrId: string | InferenceEndpointNode,
    callerHostId: string,
    workers: ExecutionWorkerNode[] = [],
  ): EndpointResolutionResult {
    const endpoint = typeof endpointOrId === 'string' ? this.endpoints.get(endpointOrId) : endpointOrId;
    if (!endpoint) {
      return {
        usable: false,
        callerHostId,
        targetHostId: 'unknown',
        routeVia: 'unreachable_loopback',
        reason: `Endpoint '${String(endpointOrId)}' is not registered`,
      };
    }
    return resolveEndpointForExecutionContext({
      endpoint,
      callerHostId,
      transports: this.listTransports(),
      workers,
    });
  }
}
