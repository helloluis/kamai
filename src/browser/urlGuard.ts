/**
 * SSRF guard shared by /browse and /screenshot.
 *
 * browse.ts historically checked only the URL the caller supplied. That is a
 * hole once a capture is written to a PUBLIC download URL: a redirect into
 * cloud metadata (169.254.169.254) would render credentials into an image
 * anyone with the link could read. So the guard runs twice — once on the
 * input, once on page.url() after navigation settles.
 */

/** Literal hosts that are never legitimate targets. */
const BLOCKED_HOSTS = new Set([
  'localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback',
  // Cloud instance metadata — the payoff target for an SSRF via redirect.
  'metadata.google.internal', 'metadata.goog',
]);

/** Non-http(s) schemes that can read local state. */
const BLOCKED_SCHEMES = /^(file|data|blob|javascript|about|chrome|chrome-extension|view-source|ftp):/i;

/**
 * Private, loopback, link-local and carrier-grade-NAT ranges.
 * 169.254.0.0/16 covers the AWS/GCP/Azure metadata endpoint — it was absent
 * from the original browse.ts blocklist entirely.
 */
function isPrivateIPv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [parseInt(m[1], 10), parseInt(m[2], 10)];
  if (m.slice(1).some((o) => parseInt(o, 10) > 255)) return true; // malformed → refuse
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;          // link-local + metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a >= 224) return true;                         // multicast + reserved
  return false;
}

function isPrivateIPv6(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === '::' || h === '::1') return true;
  if (h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;
  // IPv4-mapped (::ffff:169.254.169.254) — unwrap and re-check.
  const mapped = h.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return isPrivateIPv4(mapped[1]);
  return false;
}

/** Returns an error string when the URL must not be fetched, else null. */
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

  const host = u.hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(host)) return `Blocked host: ${host}`;
  if (host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    return `Blocked host: ${host}`;
  }
  if (isPrivateIPv4(host) || isPrivateIPv6(host)) return `Blocked private address: ${host}`;
  return null;
}

/** Normalize to an absolute https URL. Call only after checkUrl passes. */
export function normalizeUrl(raw: string): string {
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}
