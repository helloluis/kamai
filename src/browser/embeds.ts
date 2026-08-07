/**
 * Social post → official embed mapping.
 *
 * Pointing a headless browser at a raw social permalink is the worst option on
 * most platforms: you capture a login interstitial, not the post. Every one of
 * these platforms publishes an embed surface intended to be called by
 * arbitrary third-party servers, and those render the post clean with no auth.
 *
 * Verified live from the production Vultr datacenter IP on 2026-08-07 (the IP
 * matters — a residential IP is not a valid test, since that is exactly where
 * these platforms differ). instagram/x/linkedin/facebook/threads/bluesky all
 * returned HTTP 200 with real content. Reddit returns 403 to this IP on every
 * surface including oauth.reddit.com, so it routes to Apify instead — see
 * redditPostShot() in src/api/apifySearch.ts.
 *
 * Two wait-strategy landmines are encoded below: 'networkidle' never settles on
 * LinkedIn and Instagram embeds (they hold open connections), so those use
 * 'load' plus a fixed settle instead.
 */

export interface EmbedSpec {
  platform: string;
  /** Navigate here (most platforms). */
  url?: string;
  /** Or set this HTML directly and let the platform's widget script hydrate it. */
  html?: string;
  /** Candidate selectors for the post's bounding box; first match wins. */
  selectors: string[];
  /** Extra settle after load — fonts, avatars, and widget hydration. */
  settleMs: number;
  waitUntil: 'load' | 'domcontentloaded' | 'networkidle';
  viewport: { width: number; height: number };
}

const UA_JSON = { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; kamai/0.1)' };

/** X/Twitter: oEmbed gives a blockquote that widgets.js upgrades into an iframe. */
async function xEmbed(id: string): Promise<EmbedSpec | null> {
  // maxwidth pins the widget at X's maximum embed width. Without it the widget
  // sizes to its container, and a shrink-to-fit container yields a cramped card
  // with truncated action labels ("Copy link" -> "Cop...").
  const api = `https://publish.twitter.com/oembed?url=${encodeURIComponent(
    `https://twitter.com/i/status/${id}`,
  )}&omit_script=0&dnt=true&hide_thread=false&maxwidth=550`;
  try {
    const r = await fetch(api, { headers: UA_JSON, signal: AbortSignal.timeout(12_000) });
    if (!r.ok) return null;
    const data = (await r.json()) as { html?: string };
    if (!data?.html) return null;
    return {
      platform: 'x',
      html: `<!doctype html><html><head><meta charset="utf-8"></head>
        <body style="margin:0;background:#fff">
          <div style="width:550px">${data.html}</div>
        </body></html>`,
      // widgets.js replaces the blockquote with an iframe; that iframe IS the post.
      selectors: ['iframe.twitter-tweet-rendered', 'iframe[id^=twitter-widget]', 'blockquote.twitter-tweet'],
      settleMs: 2500,
      waitUntil: 'networkidle',
      viewport: { width: 620, height: 900 },
    };
  } catch {
    return null;
  }
}

/**
 * Resolve a social URL to its embed. Returns null for non-social URLs and for
 * Reddit (handled by the Apify tier).
 */
export async function resolveEmbed(rawUrl: string): Promise<EmbedSpec | null> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^(www|m|mobile)\./, '');
  const path = u.pathname;

  // ── X / Twitter ──
  if (host === 'x.com' || host === 'twitter.com') {
    const m = path.match(/\/status(?:es)?\/(\d+)/);
    return m ? xEmbed(m[1]) : null;
  }

  // ── Instagram — posts and reels. /embed/captioned includes the caption text,
  //    which is usually the substance of the post. ──
  if (host === 'instagram.com') {
    const m = path.match(/\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
    if (!m) return null;
    return {
      platform: 'instagram',
      url: `https://www.instagram.com/p/${m[1]}/embed/captioned/`,
      selectors: ['.EmbedFrame', '.Embed', 'article', 'body > div'],
      settleMs: 2200,
      waitUntil: 'load', // networkidle never settles here
      viewport: { width: 560, height: 1200 },
    };
  }

  // ── LinkedIn — public post URLs carry the activity id in the slug.
  //    The embed route accepts activity/share/ugcPost URNs; the numeric id is
  //    what matters, and each id is valid in exactly one namespace. ──
  if (host === 'linkedin.com') {
    const m =
      path.match(/activity[-:](\d+)/) ||
      path.match(/urn:li:(?:activity|share|ugcPost):(\d+)/) ||
      u.search.match(/urn%3Ali%3A(?:activity|share|ugcPost)%3A(\d+)/);
    if (!m) return null;
    return {
      platform: 'linkedin',
      url: `https://www.linkedin.com/embed/feed/update/urn:li:activity:${m[1]}`,
      selectors: ['.feed-shared-update-v2', 'article', 'main', 'body > div'],
      settleMs: 2500,
      waitUntil: 'load', // networkidle times out on LinkedIn
      viewport: { width: 620, height: 1200 },
    };
  }

  // ── Facebook — the post plugin takes the permalink verbatim. ──
  if (host === 'facebook.com' || host === 'fb.watch') {
    if (!/\/(posts|permalink|photo|videos|watch|story\.php|share)/.test(path) && !u.search.includes('v=')) {
      return null;
    }
    return {
      platform: 'facebook',
      url: `https://www.facebook.com/plugins/post.php?href=${encodeURIComponent(
        u.toString(),
      )}&show_text=true&width=500`,
      selectors: ['._1dwg', '[data-testid]', 'body > div'],
      settleMs: 2500,
      waitUntil: 'load',
      viewport: { width: 540, height: 1200 },
    };
  }

  // ── Threads (both the legacy .net and current .com domains). ──
  if (host === 'threads.net' || host === 'threads.com') {
    const m = path.match(/\/(@[^/]+)\/post\/([A-Za-z0-9_-]+)/);
    if (!m) return null;
    return {
      platform: 'threads',
      url: `https://www.threads.net/${m[1]}/post/${m[2]}/embed`,
      selectors: ['[data-testid]', 'article', 'body > div'],
      settleMs: 2200,
      waitUntil: 'load',
      viewport: { width: 560, height: 1000 },
    };
  }

  // ── Bluesky — the embed route takes a DID, but share URLs carry a handle.
  //    Passing the handle through yields "Invalid DID: DID syntax didn't
  //    validate via regex" rendered as a perfectly valid image, so resolve the
  //    handle first via the free public identity endpoint. ──
  if (host === 'bsky.app') {
    const m = path.match(/\/profile\/([^/]+)\/post\/([A-Za-z0-9]+)/);
    if (!m) return null;
    let actor = m[1];
    if (!actor.startsWith('did:')) {
      try {
        const r = await fetch(
          `https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(actor)}`,
          { headers: UA_JSON, signal: AbortSignal.timeout(8000) },
        );
        if (!r.ok) return null;
        const j = (await r.json()) as { did?: string };
        if (!j?.did) return null;
        actor = j.did;
      } catch {
        return null;
      }
    }
    return {
      platform: 'bluesky',
      url: `https://embed.bsky.app/embed/${actor}/app.bsky.feed.post/${m[2]}`,
      selectors: ['[data-testid]', 'article', 'blockquote', 'body > div'],
      settleMs: 2000,
      waitUntil: 'load',
      viewport: { width: 600, height: 900 },
    };
  }

  // ── TikTok — the card (author, caption, counts) renders; the video poster
  //    frame often does not. Partial capture is still proof the post exists. ──
  if (host === 'tiktok.com') {
    const m = path.match(/\/video\/(\d+)/);
    if (!m) return null;
    return {
      platform: 'tiktok',
      url: `https://www.tiktok.com/embed/v2/${m[1]}`,
      selectors: ['[data-e2e]', 'article', 'body > div'],
      settleMs: 3000,
      waitUntil: 'load',
      viewport: { width: 480, height: 900 },
    };
  }

  return null;
}

/** True when the URL is a Reddit permalink — routed to Apify, not embeds. */
export function isReddit(rawUrl: string): boolean {
  try {
    const h = new URL(rawUrl).hostname.toLowerCase().replace(/^(www|old|new|m)\./, '');
    return h === 'reddit.com' || h === 'redd.it' || h === 'redditmedia.com';
  } catch {
    return false;
  }
}
