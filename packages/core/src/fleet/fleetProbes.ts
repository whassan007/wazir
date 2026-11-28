export interface TailscalePeerRecord {
  hostName: string;
  dnsName?: string;
  ips: string[];
  online: boolean;
  lastSeen?: string;
  os?: string;
  isSelf: boolean;
}

export interface HostGpuMetric {
  name: string;
  utilizationPercent?: number;
  memoryUsedMB?: number;
  memoryTotalMB?: number;
  temperatureC?: number;
}

export interface ParsedHostMetrics {
  osVersion?: string;
  chip?: string;
  load1?: number;
  load5?: number;
  load15?: number;
  cpuCount?: number;
  memTotalBytes?: number;
  memAvailableBytes?: number;
  uptimeSeconds?: number;
  gpus: HostGpuMetric[];
}

export function parseTailscaleStatusJson(rawJson: string): TailscalePeerRecord[] {
  const parsed = JSON.parse(rawJson) as {
    Self?: { HostName?: string; DNSName?: string; TailscaleIPs?: string[]; Online?: boolean; LastSeen?: string; OS?: string };
    Peer?: Record<string, { HostName?: string; DNSName?: string; TailscaleIPs?: string[]; Online?: boolean; LastSeen?: string; OS?: string }>;
  };

  const toPeer = (
    node: { HostName?: string; DNSName?: string; TailscaleIPs?: string[]; Online?: boolean; LastSeen?: string; OS?: string },
    isSelf: boolean,
  ): TailscalePeerRecord => ({
    hostName: node.HostName ?? '?',
    dnsName: node.DNSName,
    ips: node.TailscaleIPs ?? [],
    online: isSelf ? true : Boolean(node.Online),
    lastSeen: node.LastSeen,
    os: node.OS,
    isSelf,
  });

  const out: TailscalePeerRecord[] = Object.values(parsed.Peer ?? {}).map((p) => toPeer(p, false));
  if (parsed.Self) out.push(toPeer(parsed.Self, true));
  return out.sort((a, b) => a.hostName.localeCompare(b.hostName));
}

function parseOptionalMetricNumber(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith('[')) return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : undefined;
}

export function parseHostMetricsOutput(output: string): ParsedHostMetrics {
  const metrics: ParsedHostMetrics = { gpus: [] };
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const eqIdx = line.indexOf('=');
    let key = '';
    let value = line;
    if (eqIdx > 0) {
      key = line.slice(0, eqIdx).trim();
      value = line.slice(eqIdx + 1).trim();
    } else if (line.split(',').length === 5) {
      key = 'gpu';
    }

    if (key === 'os') metrics.osVersion = value;
    else if (key === 'chip') metrics.chip = value;
    else if (key === 'load') {
      const parts = value.split(/\s+/).map(parseOptionalMetricNumber).filter((n): n is number => n !== undefined);
      if (parts.length >= 3) {
        metrics.load1 = parts[0];
        metrics.load5 = parts[1];
        metrics.load15 = parts[2];
      }
    } else if (key === 'cpus') {
      metrics.cpuCount = parseOptionalMetricNumber(value);
    } else if (key === 'memTotalKB') {
      const kb = parseOptionalMetricNumber(value);
      if (kb !== undefined) metrics.memTotalBytes = kb * 1024;
    } else if (key === 'memAvailKB') {
      const kb = parseOptionalMetricNumber(value);
      if (kb !== undefined) metrics.memAvailableBytes = kb * 1024;
    } else if (key === 'memTotalBytes') {
      metrics.memTotalBytes = parseOptionalMetricNumber(value);
    } else if (key === 'memAvailBytes') {
      metrics.memAvailableBytes = parseOptionalMetricNumber(value);
    } else if (key === 'uptime') {
      metrics.uptimeSeconds = parseOptionalMetricNumber(value);
    } else if (key === 'gpu') {
      const fields = value.split(',');
      if (fields.length >= 5) {
        metrics.gpus.push({
          name: fields[0]!.trim(),
          utilizationPercent: parseOptionalMetricNumber(fields[1]),
          memoryUsedMB: parseOptionalMetricNumber(fields[2]),
          memoryTotalMB: parseOptionalMetricNumber(fields[3]),
          temperatureC: parseOptionalMetricNumber(fields[4]),
        });
      }
    }
  }
  return metrics;
}

export function extractProgressPercent(line: string): number | undefined {
  const matches = Array.from(line.matchAll(/(\d{1,3}(?:\.\d+)?)%/g));
  const last = matches.at(-1);
  if (!last) return undefined;
  const value = Number(last[1]);
  if (!Number.isFinite(value) || value > 100) return undefined;
  return value / 100;
}
