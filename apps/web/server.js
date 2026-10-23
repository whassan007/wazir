#!/usr/bin/env node
/* Static file server for the Wazir dashboard.
 * Serves ./public, manages server-side host instance targets, serves isolated
 * sandboxed artifact previews, and proxies /api/* + /health to the Wazir API server
 * with startup retry resilience (eliminating cold-boot 502 Bad Gateway errors). */
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = Number(process.env.PORT ?? 4801);
const HOST = process.env.WAZIR_WEB_HOST ?? '127.0.0.1';
const WAZIR_HOME = process.env.WAZIR_HOME ?? path.join(os.homedir(), '.wazir');

function normalizeApiUrl(rawUrl) {
  const cleaned = String(rawUrl || 'http://127.0.0.1:4800').trim().replace(/\/+$/, '');
  return cleaned.replace(/^http:\/\/localhost(?=:|\/|$)/i, 'http://127.0.0.1');
}

const DEFAULT_API = normalizeApiUrl(process.env.WAZIR_API ?? 'http://127.0.0.1:4800');
const PUBLIC = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

function readLocalOperatorToken() {
  const tokenPath = path.join(WAZIR_HOME, 'local-operator.token');
  try {
    if (fs.existsSync(tokenPath)) {
      const diskToken = fs.readFileSync(tokenPath, 'utf8').trim();
      if (diskToken.length >= 16) return diskToken;
    }
  } catch {
    // Ignore read error
  }
  return process.env.WAZIR_API_TOKEN?.trim() || undefined;
}

function getEffectiveLocalToken(preferDisk = false) {
  if (preferDisk) {
    return readLocalOperatorToken() || process.env.WAZIR_API_TOKEN?.trim() || undefined;
  }
  return process.env.WAZIR_API_TOKEN?.trim() || readLocalOperatorToken() || undefined;
}

function loadSavedHosts() {
  const hostsPath = path.join(WAZIR_HOME, 'hosts.json');
  try {
    if (fs.existsSync(hostsPath)) {
      const parsed = JSON.parse(fs.readFileSync(hostsPath, 'utf8'));
      if (Array.isArray(parsed.hosts)) {
        return {
          activeHostId: parsed.activeHostId || 'local',
          hosts: parsed.hosts,
        };
      }
    }
  } catch {
    // Fall back to default local entry
  }
  return { activeHostId: 'local', hosts: [] };
}

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function isLoopbackAddress(address) {
  if (typeof address !== 'string') return false;
  const a = address.replace(/^::ffff:/i, '');
  return a === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}

function isLoopbackHostHeader(hostHeader) {
  if (typeof hostHeader !== 'string' || !hostHeader) return false;
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(`http://${hostHeader}`).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Decides whether a request may borrow host-held credentials (the local operator
 * token and saved remote-host tokens). All three must hold:
 *  - the TCP peer is loopback (LAN, tunnel, and reverse-proxy peers are not),
 *  - the Host header names loopback (defeats DNS rebinding to 127.0.0.1),
 *  - any Origin header is this proxy's own origin (defeats cross-site forgery).
 * Untrusted requests are still proxied, but only with the caller's own
 * Authorization header, so the API enforces auth for them.
 */
function evaluateTrust(req) {
  const loopbackPeer = isLoopbackAddress(req.socket?.remoteAddress);
  const loopbackHost = isLoopbackHostHeader(req.headers.host);
  const origin = req.headers.origin;
  const secFetchSite = req.headers['sec-fetch-site'];
  const expectedOrigin = req.headers.host ? `http://${req.headers.host}` : undefined;
  let sameOrigin = origin === undefined
    || (typeof origin === 'string' && origin === expectedOrigin);
  if (secFetchSite === 'cross-site') {
    sameOrigin = false;
  }
  if (
    sameOrigin &&
    origin === undefined &&
    req.method !== 'GET' &&
    req.method !== 'HEAD' &&
    typeof req.headers.referer === 'string'
  ) {
    try {
      if (new URL(req.headers.referer).origin !== expectedOrigin) {
        sameOrigin = false;
      }
    } catch {
      sameOrigin = false;
    }
  }
  return { trusted: loopbackPeer && loopbackHost && sameOrigin, crossOrigin: !sameOrigin };
}

function resolveUpstreamTarget(req, trusted) {
  // Only trusted callers may steer the proxy toward a saved remote host: the
  // proxy attaches that host's stored token, so an untrusted selector would
  // gain operator access to every saved host.
  const requestedHostId = trusted ? req.headers['x-wazir-target-host'] : undefined;
  const saved = loadSavedHosts();
  const targetId = !trusted
    ? 'local'
    : (typeof requestedHostId === 'string' && requestedHostId.trim())
      ? requestedHostId.trim()
      : saved.activeHostId || 'local';

  if (targetId !== 'local') {
    const remote = saved.hosts.find((h) => h && h.id === targetId && h.url);
    if (remote) {
      return {
        id: remote.id,
        isLocal: false,
        apiUrl: normalizeApiUrl(remote.url),
        token: remote.accessToken || remote.token || undefined,
      };
    }
  }
  return {
    id: 'local',
    isLocal: true,
    apiUrl: DEFAULT_API,
    token: getEffectiveLocalToken(false),
  };
}

function collectRequestBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function proxy(req, res) {
  const { trusted, crossOrigin } = evaluateTrust(req);
  if (crossOrigin) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'cross-origin request refused' }));
    return;
  }

  let bodyBuffer = Buffer.alloc(0);
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    try {
      bodyBuffer = await collectRequestBody(req);
    } catch (err) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
      return;
    }
  }

  const maxAttempts = 20;
  const retryDelayMs = 250;

  const attemptRequest = (attempt, preferDiskToken) => {
    if (res.writableEnded || res.destroyed) return;
    const target = resolveUpstreamTarget(req, trusted);
    const token = !trusted
      ? undefined
      : target.isLocal ? getEffectiveLocalToken(preferDiskToken) : target.token;

    let url;
    try {
      url = new URL(target.apiUrl);
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Invalid upstream API URL: ${target.apiUrl}` }));
      return;
    }

    const lib = url.protocol === 'https:' ? https : http;
    const headers = {
      ...req.headers,
      host: url.host,
    };
    delete headers['x-wazir-target-host'];
    if (!trusted) {
      headers['x-wazir-untrusted-proxy'] = '1';
    } else {
      delete headers['x-wazir-untrusted-proxy'];
    }
    if (token && !req.headers.authorization) {
      headers.authorization = `Bearer ${token}`;
    }
    if (bodyBuffer.length > 0) {
      headers['content-length'] = String(bodyBuffer.length);
    }

    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: req.url,
      method: req.method,
      headers,
    };

    const upstream = lib.request(options, (upstreamRes) => {
      // If local API rejected our cached env token with 401 because local-operator.token
      // on disk belongs to a pre-existing API process, retry once using the disk token.
      if (upstreamRes.statusCode === 401 && trusted && target.isLocal && !preferDiskToken && !req.headers.authorization) {
        const diskToken = readLocalOperatorToken();
        if (diskToken && diskToken !== token) {
          upstreamRes.resume();
          attemptRequest(attempt, true);
          return;
        }
      }
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    });

    upstream.on('error', (error) => {
      const code = error && error.code;
      const isTransientStartupError =
        code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EPIPE';
      if (isTransientStartupError && attempt < maxAttempts && !res.headersSent) {
        setTimeout(() => attemptRequest(attempt + 1, preferDiskToken), retryDelayMs);
        return;
      }
      if (res.headersSent) {
        res.destroy(error);
        return;
      }
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `api unreachable: ${error.message}` }));
    });

    upstream.setTimeout(30_000, () => upstream.destroy(new Error('API request timed out')));
    res.on('close', () => {
      if (!res.writableEnded) upstream.destroy();
    });

    if (bodyBuffer.length > 0) {
      upstream.end(bodyBuffer);
    } else {
      upstream.end();
    }
  };

  attemptRequest(1, false);
}

const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
  const pathname = parsedUrl.pathname;

  // Strictly isolated cross-context sandbox preview endpoint
  if (pathname === '/sandbox/preview') {
    const content = parsedUrl.searchParams.get('html') || '<div style="font-family:monospace;padding:12px;">No preview content</div>';
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "sandbox allow-scripts; default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:;",
      'X-Frame-Options': 'SAMEORIGIN',
    });
    res.end(content);
    return;
  }

  if (
    pathname.startsWith('/api/') ||
    pathname === '/health' ||
    pathname === '/ready' ||
    pathname === '/executions' ||
    pathname.startsWith('/ap/') ||
    pathname.startsWith('/mcp')
  ) {
    proxy(req, res);
    return;
  }

  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('bad request');
    return;
  }
  if (decodedPath.includes('\0')) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('forbidden');
    return;
  }

  let publicReal;
  try {
    publicReal = fs.realpathSync(PUBLIC);
  } catch {
    publicReal = path.resolve(PUBLIC);
  }

  let relativeTarget = (decodedPath === '/' ? 'index.html' : decodedPath).replace(/^[/\\]+/, '');
  let candidatePath = path.resolve(publicReal, relativeTarget);
  const relToPublic = path.relative(publicReal, candidatePath);
  if (relToPublic.startsWith('..') || path.isAbsolute(relToPublic)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('forbidden');
    return;
  }

  try {
    if (fs.existsSync(candidatePath) && fs.statSync(candidatePath).isDirectory()) {
      const indexCandidate = path.join(candidatePath, 'index.html');
      if (fs.existsSync(indexCandidate) && fs.statSync(indexCandidate).isFile()) {
        candidatePath = indexCandidate;
      }
    }
  } catch {
    // Let realpath/stat handling below respond appropriately
  }

  fs.realpath(candidatePath, (realErr, realFilePath) => {
    if (realErr) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    const realRel = path.relative(publicReal, realFilePath);
    if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('forbidden');
      return;
    }
    fs.stat(realFilePath, (statErr, stats) => {
      if (statErr || !stats.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found');
        return;
      }
      fs.readFile(realFilePath, (error, data) => {
        if (error) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('not found');
          return;
        }
        const ext = path.extname(realFilePath).toLowerCase();
        res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
        res.end(data);
      });
    });
  });
});

server.listen(PORT, HOST, () => {
  console.log(`wazir-web listening on http://${HOST}:${server.address().port}`);
  console.log(`  proxying /api and /health → ${DEFAULT_API}`);
  if (!LOOPBACK_HOSTNAMES.has(String(HOST).toLowerCase())) {
    console.log('  non-loopback bind: host credentials are attached only for loopback, same-origin');
    console.log('  requests; remote clients must send their own Authorization bearer token.');
  }
});
