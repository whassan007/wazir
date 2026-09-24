import { lookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
import { WebError, type WebPolicy } from '../types/web.js';

export function domainMatches(host: string, domain: string): boolean {
  const d = domain.toLowerCase().replace(/\.$/, '');
  return host === d || host.endsWith(`.${d}`);
}
export function parseWebUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new WebError('WEB_URL_BLOCKED'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || value.length > 4096)
    throw new WebError('WEB_URL_BLOCKED');
  // Signed URLs and credential-bearing query parameters are not accepted into evidence.
  for (const key of url.searchParams.keys()) if (/token|secret|password|api.?key|signature|credential|authorization/i.test(key)) throw new WebError('WEB_URL_BLOCKED');
  url.hash = '';
  return url;
}
export function publicAddress(address: string): boolean {
  try {
    const parsed = ipaddr.process(address);
    return parsed.range() === 'unicast';
  } catch { return false; }
}
export function checkWebDestination(url: URL, policy: WebPolicy): void {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (policy.deniedDomains?.some(d => domainMatches(host, d)) ||
      (policy.allowedDomains?.length && !policy.allowedDomains.some(d => domainMatches(host, d)))) throw new WebError('WEB_POLICY_DENIED');
  if (!policy.allowInternal && (host === 'localhost' || !host.includes('.') && !ipaddr.isValid(host) ||
      /\.(localhost|local|internal|lan|home|test|invalid)$/.test(host) ||
      ipaddr.isValid(host) && !publicAddress(host))) throw new WebError('WEB_URL_BLOCKED');
}
export type WebResolver = (hostname: string) => Promise<{ address: string; family: number }[]>;
export const resolveWebHost: WebResolver = hostname => lookup(hostname, { all: true, verbatim: true });
export async function validateWebUrl(value: string, policy: WebPolicy, resolver: WebResolver = resolveWebHost) {
  const url = parseWebUrl(value);
  checkWebDestination(url, policy);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses: { address: string; family: number }[];
  try { addresses = ipaddr.isValid(host) ? [{ address: host, family: ipaddr.parse(host).kind() === 'ipv4' ? 4 : 6 }] : await resolver(host); }
  catch { throw new WebError('WEB_DNS_FAILED'); }
  if (!addresses.length) throw new WebError('WEB_DNS_FAILED');
  if (!policy.allowInternal && addresses.some(a => !publicAddress(a.address))) throw new WebError('WEB_URL_BLOCKED');
  return { url, addresses };
}
