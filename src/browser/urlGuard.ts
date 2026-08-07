/**
 * SSRF guard shared by /browse and /screenshot.
 *
 * A lexical hostname check is NOT sufficient and this module used to be one.
 * Three bypasses were found against that version, all verified live:
 *   - `http://[::ffff:169.254.169.254]/` — Node normalizes IPv4-mapped IPv6 to
 *     hex (`::ffff:a9fe:a9fe`), so a dotted-decimal pattern never matched.
 *   - `http://localhost./admin` — a trailing dot is a valid FQDN root label and
 *     defeated every exact-host and suffix comparison.
 *   - `http://169.254.169.254.nip.io/` — an ordinary public DNS name whose A
 *     record is a private address. No string test can catch this class.
 *
 * So there are now two layers:
 *   1. `checkUrl` — cheap lexical reject (scheme, literal IPs, known hosts).
 *   2. `checkUrlResolved` — resolves DNS and rejects if ANY answer is private.
 *
 * Neither closes subresource SSRF (an allowed page embedding an <iframe> that
 * points at the metadata service) or DNS rebinding, because those happen after
 * the check. `installSsrfGuard` handles that at the network layer by vetting
 * every request Chromium makes, which is the only durable control.
 *
 * This matters more here than on a typical scraper: a screenshot of the
 * metadata endpoint is written to disk and served from a PUBLIC unauthenticated
 * URL.
 */
import { lookup } from 'node:dns/promises';
import type { BrowserContext } from 'playwright';

const BLOCKED_HOSTS = new Set([
  'localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback',
  'metadata.google.internal', 'metadata.goog',
]);

const BLOCKED_SCHEMES = /^(file|data|blob|javascript|about|chrome|chrome-extension|view-source|ftp|ws|wss):/i;

function isPrivateIPv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const octets = [m[1], m[2], m[3], m[4]].map((o) => parseInt(o, 10));
  if (octets.some((o) => o > 255)) return true; // malformed → refuse
  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;           // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16/12
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true;             // 192.0.0/24 + 192.0.2/24
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true;                         // multicast + reserved
  return false;
}

function isPrivateIPv6(raw: string): boolean {
  const h = raw.replace(/[[\]]/g, '').toLowerCase().split('%')[0];
  if (h === '::' || h === '::1') return true;
  if (/^fe[89ab]/.test(h)) return true;   // link-local fe80::/10
  if (/^f[cd]/.test(h)) return true;      // unique-local fc00::/7
  if (h.startsWith('::ffff:')) {
    const tail = h.slice(7);
    // Dotted form (::ffff:169.254.169.254) and the hex form Node actually
    // produces (::ffff:a9fe:a9fe) are the same address — check both.
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(tail)) return isPrivateIPv4(tail);
    const hex = tail.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const n = (parseInt(hex[1], 16) << 16) | parseInt(hex[2], 16);
      return isPrivateIPv4([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'));
    }
  }
  return false;
}

/** True when a bare address literal (v4 or v6) points somewhere private. */
export function isPrivateAddress(addr: string): boolean {
  return isPrivateIPv4(addr) || isPrivateIPv6(addr);
}

/** Strip the FQDN root dot so `localhost.` cannot slip past host comparisons. */
function canonicalHost(hostname: string): string {
  return hostname.toLowerCase().replace(/\.+$/, '');
}

/**
 * Cheap lexical check. Returns an error string when the URL must not be
 * fetched, else null. Does no DNS — pair with checkUrlResolved.
 */
export function checkUrl(raw: string): string | null {
  if (!raw || typeof raw !== 'string') return 'Missing url';
  if (BLOCKED_SCHEMES.test(raw.trim())) return `Blocked URL scheme: ${raw.slice(0, 60)}`;

  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return `Malformed URL: ${raw.slice(0, 60)}`;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return `Blocked URL scheme: ${u.protocol}`;

  const host = canonicalHost(u.hostname);
  if (!host) return 'Malformed URL: empty host';
  if (BLOCKED_HOSTS.has(host)) return `Blocked host: ${host}`;
  if (host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    return `Blocked host: ${host}`;
  }
  if (isPrivateAddress(host)) return `Blocked private address: ${host}`;
  return null;
}

/**
 * Lexical check plus DNS resolution. Rejects when any resolved address is
 * private — this is what stops `169.254.169.254.nip.io` and friends.
 */
export async function checkUrlResolved(raw: string): Promise<string | null> {
  const lexical = checkUrl(raw);
  if (lexical) return lexical;

  const u = new URL(normalizeUrl(raw));
  const host = canonicalHost(u.hostname);
  if (isPrivateAddress(host)) return `Blocked private address: ${host}`;
  // A literal address needs no resolution and lookup() on one just echoes it.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) return null;

  try {
    const addrs = await lookup(host, { all: true });
    for (const a of addrs) {
      if (isPrivateAddress(a.address)) {
        return `Blocked: ${host} resolves to private address ${a.address}`;
      }
    }
  } catch {
    return `Could not resolve host: ${host}`;
  }
  return null;
}

/**
 * Block private-address requests at the network layer for every request the
 * page makes — documents, subresources, iframes, redirects, XHR.
 *
 * This is the only control that covers a public page embedding
 * `<iframe src="http://169.254.169.254/...">`, and because the check runs per
 * request it also defeats DNS rebinding, where the name resolves public at
 * validation time and private at fetch time.
 */
export async function installSsrfGuard(context: BrowserContext): Promise<void> {
  await context.route('**/*', async (route) => {
    const url = route.request().url();
    try {
      if (BLOCKED_SCHEMES.test(url)) return await route.abort('blockedbyclient');
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        return await route.abort('blockedbyclient');
      }
      const host = canonicalHost(u.hostname);
      if (BLOCKED_HOSTS.has(host) || isPrivateAddress(host)) {
        return await route.abort('blockedbyclient');
      }
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host) && !host.includes(':')) {
        const addrs = await lookup(host, { all: true });
        if (addrs.some((a) => isPrivateAddress(a.address))) {
          console.warn(`[SSRF] blocked ${host} → private address`);
          return await route.abort('blockedbyclient');
        }
      }
      await route.continue();
    } catch {
      await route.abort('blockedbyclient').catch(() => {});
    }
  });
}

/** Normalize to an absolute URL. Call only after checkUrl passes. */
export function normalizeUrl(raw: string): string {
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}
