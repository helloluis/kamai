'use client';

import { useState, useEffect, useRef, useCallback } from 'react';

const CAROUSEL_PHRASES = [
  'search Google Scholar',
  'read government portals',
  'view single-page apps',
  'fill out search forms',
  'scrape dynamic tables',
  'navigate web archives',
  'extract data from PDFs online',
  'browse ASPX legacy sites',
];

// Warm amber — complementary to our green palette
const CAROUSEL_COLOR = '#f59e0b';

function VerticalCarousel() {
  const [index, setIndex] = useState(0);
  const longestPhrase = CAROUSEL_PHRASES.reduce((a, b) => a.length > b.length ? a : b, '');

  useEffect(() => {
    const interval = setInterval(() => {
      setIndex((i) => (i + 1) % CAROUSEL_PHRASES.length);
    }, 2200);
    return () => clearInterval(interval);
  }, []);

  return (
    <span className="inline-block relative overflow-hidden align-bottom" style={{ height: '1.3em' }}>
      {/* Invisible sizer so the container fits the longest phrase */}
      <span className="invisible whitespace-nowrap">{longestPhrase}</span>
      {CAROUSEL_PHRASES.map((phrase, i) => (
        <span
          key={phrase}
          className="absolute left-0 right-0 transition-all duration-500 ease-in-out whitespace-nowrap"
          style={{
            color: CAROUSEL_COLOR,
            transform: i === index ? 'translateY(0)' : i === (index - 1 + CAROUSEL_PHRASES.length) % CAROUSEL_PHRASES.length ? 'translateY(-120%)' : 'translateY(120%)',
            opacity: i === index ? 1 : 0,
          }}
        >
          {phrase}
        </span>
      ))}
    </span>
  );
}

// ─── URL validation ───

const BLOCKED_PATTERNS = [
  /^https?:\/\/(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|localhost|0\.0\.0\.0)/i,
  /^file:/i,
  /^data:/i,
  /^javascript:/i,
  /^ftp:/i,
];

function sanitizeUrl(input: string): string | null {
  let url = input.trim();
  if (!url) return null;
  if (/<script|javascript:|data:|on\w+=/i.test(url)) return null;
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    for (const pat of BLOCKED_PATTERNS) {
      if (pat.test(url)) return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}

// ─── Session-level request lock ───
let globalRequestInFlight = false;

// ─── Demo section ───

function DemoSection() {
  const [input, setInput] = useState('https://defillama.com/chain/Celo');
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [lastRequest, setLastRequest] = useState(0);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!result) return;
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => setResult(null), 60000);
    return () => { if (timeoutRef.current) clearTimeout(timeoutRef.current); };
  }, [result]);

  const handleSubmit = useCallback(async () => {
    // Block concurrent requests from the same session (multiple tabs)
    if (globalRequestInFlight) {
      setError('A request is already in progress');
      return;
    }

    const url = sanitizeUrl(input);
    if (!url) {
      setError('Please enter a valid URL (e.g. x.com/celo)');
      return;
    }

    const now = Date.now();
    if (now - lastRequest < 3000) {
      const wait = Math.ceil((3000 - (now - lastRequest)) / 1000);
      setError(`Please wait ${wait}s before trying again`);
      return;
    }

    setError('');
    setLoading(true);
    setLastRequest(now);
    globalRequestInFlight = true;

    try {
      const res = await fetch('https://kamai.minai.work/api/v1/browse', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-wallet-address': '0x0000000000000000000000000000000000000000',
        },
        body: JSON.stringify({ url, timeout: 15000 }),
      });
      const data = await res.json();
      setResult(data);
    } catch (err: any) {
      setError('Request failed: ' + (err.message || 'Network error'));
    } finally {
      setLoading(false);
      globalRequestInFlight = false;
    }
  }, [input, lastRequest]);

  return (
    <section className="px-6 py-16 border-t border-[var(--color-border)]">
      <div className="max-w-3xl mx-auto">
        <h2 className="text-2xl font-bold mb-2 text-center">humans, try it here</h2>
        <p className="text-[var(--color-text-muted)] text-center mb-8">
          Enter a URL and see what kamai extracts. Free to try — one request every 3 seconds.
        </p>

        <div className="flex gap-2 mb-6">
          <input
            type="url"
            value={input}
            onChange={(e) => { setInput(e.target.value); setError(''); }}
            onKeyDown={(e) => e.key === 'Enter' && !loading && handleSubmit()}
            placeholder="https://defillama.com/chain/Celo"
            className="flex-1 px-4 py-3 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg text-[var(--color-text)] placeholder-[var(--color-text-muted)] focus:outline-none focus:border-[var(--color-primary)] transition-colors font-mono text-sm"
            disabled={loading}
          />
          <button
            onClick={handleSubmit}
            disabled={loading || !input.trim()}
            className="px-5 py-3 bg-[var(--color-primary)] text-black font-semibold rounded-lg hover:bg-[var(--color-primary-dark)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed min-w-[52px] flex items-center justify-center"
          >
            {loading ? (
              <svg className="w-5 h-5 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeDasharray="50 20" />
              </svg>
            ) : (
              <span className="text-lg">→</span>
            )}
          </button>
        </div>

        {error && (
          <div className="text-red-400 text-sm mb-4 text-center">{error}</div>
        )}

        {result && (
          <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${result.ok ? 'bg-green-500' : 'bg-red-500'}`} />
                <span className="text-sm font-mono text-[var(--color-text-muted)] truncate max-w-md">
                  {result.url || 'Error'}
                </span>
              </div>
              <div className="flex items-center gap-3 text-xs text-[var(--color-text-muted)]">
                {result.length > 0 && <span>{result.length.toLocaleString()} chars</span>}
                <button onClick={() => setResult(null)} className="hover:text-white transition-colors">✕</button>
              </div>
            </div>

            <div className="max-h-96 overflow-y-auto">
              {result.ok ? (
                <div className="p-4">
                  {result.title && (
                    <h3 className="font-semibold mb-3 text-[var(--color-primary)]">{result.title}</h3>
                  )}
                  <pre className="text-sm text-[var(--color-text-muted)] whitespace-pre-wrap break-words leading-relaxed mb-4">
                    {(result.text || '').slice(0, 3000)}
                    {(result.text || '').length > 3000 && '\n\n...'}
                  </pre>

                  {result.forms?.length > 0 && (
                    <div className="mt-4 pt-4 border-t border-[var(--color-border)]">
                      <h4 className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)] mb-2">
                        Form fields ({result.forms.length})
                      </h4>
                      <div className="flex flex-wrap gap-2">
                        {result.forms.slice(0, 10).map((f: any, i: number) => (
                          <span key={i} className="text-xs px-2 py-1 rounded bg-[var(--color-bg)] text-[var(--color-text-muted)] font-mono">
                            {f.selector}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {result.links?.length > 0 && (
                    <div className="mt-4 pt-4 border-t border-[var(--color-border)]">
                      <h4 className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)] mb-2">
                        Links ({result.links.length})
                      </h4>
                      <div className="space-y-1">
                        {result.links.slice(0, 8).map((l: any, i: number) => (
                          <div key={i} className="text-xs text-[var(--color-text-muted)] truncate">
                            <span className="text-[var(--color-primary)]">{l.text}</span>
                            <span className="ml-2 opacity-50">{l.href}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="p-4 text-red-400 text-sm">{result.error || 'Unknown error'}</div>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

// ─── Main page ───

export default function Home() {
  return (
    <div className="min-h-screen flex flex-col">
      {/* Nav */}
      <nav className="flex items-center justify-between px-6 py-4 border-b border-[var(--color-border)]">
        <div className="flex items-center gap-2">
          <span className="text-2xl font-bold text-[var(--color-primary)]">kamai</span>
        </div>
        <div className="flex items-center gap-4">
          <a href="/skill.md" className="text-sm text-[var(--color-text-muted)] hover:text-white transition-colors">
            skill.md
          </a>
          <a href="https://github.com/helloluis/kamai" className="text-sm text-[var(--color-text-muted)] hover:text-white transition-colors">
            GitHub
          </a>
          <a href="#pricing" className="text-sm text-[var(--color-text-muted)] hover:text-white transition-colors">
            Pricing
          </a>
        </div>
      </nav>

      {/* Hero */}
      <section className="flex-1 flex flex-col items-center justify-center px-6 py-24 text-center max-w-4xl mx-auto">
        <div className="inline-block px-3 py-1 mb-8 text-xs font-medium rounded-full bg-[var(--color-surface)] border border-[var(--color-border)] text-[var(--color-primary)]">
          open source &middot; pay-per-request &middot; built on Celo
        </div>

        <h1 className="text-5xl sm:text-6xl md:text-7xl font-bold tracking-tight leading-none mb-0">
          your AI agent can&apos;t
        </h1>
        <div className="text-5xl sm:text-6xl md:text-7xl font-bold tracking-tight leading-none mb-8">
          <VerticalCarousel />
        </div>

        <h2 className="text-2xl sm:text-3xl font-bold tracking-tight leading-snug mb-8 max-w-3xl">
          kamai lets your agent run a real Chromium browser for as little as{' '}
          <span className="text-[var(--color-primary)]">$0.009</span> per page load.
        </h2>

        <p className="text-lg text-[var(--color-text-muted)] max-w-2xl mb-10 leading-relaxed">
          Navigate JavaScript-heavy sites, fill forms, click buttons, and extract clean data
          — even from legacy portals that simple HTTP fetches can&apos;t handle.
        </p>

        <div className="flex gap-4 items-center flex-wrap justify-center">
          <a
            href="/skill.md"
            className="px-6 py-3 border border-[var(--color-border)] rounded-lg text-[var(--color-text-muted)] hover:text-white hover:border-[var(--color-primary)] transition-colors"
          >
            Download skill.md
          </a>
          <a
            href="#demo"
            className="px-6 py-3 bg-[var(--color-primary)] text-black font-semibold rounded-lg hover:bg-[var(--color-primary-dark)] transition-colors"
          >
            Try it live ↓
          </a>
        </div>
      </section>

      {/* Code example */}
      <section className="px-6 py-16 border-t border-[var(--color-border)]">
        <div className="max-w-3xl mx-auto">
          <h2 className="text-2xl font-bold mb-2 text-center">one API call, one x402 deposit, full browser power.</h2>
          <p className="text-[var(--color-text-muted)] text-center mb-8">
            Navigate, interact, and extract — all in a single request.
          </p>
          <pre className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl p-6 overflow-x-auto text-sm leading-relaxed">
            <code className="text-[var(--color-text)]">{`POST /api/v1/browse
x-wallet-address: 0xYourCeloWallet

{
  "url": "https://philgeps.gov.ph/Indexes/index",
  "actions": [
    { "action": "type", "selector": "#txtKeyword", "text": "AI" },
    { "action": "click_and_wait", "selector": "#btnSearch" }
  ],
  "selector": ".search-results"
}`}</code>
          </pre>
        </div>
      </section>

      {/* Features */}
      <section className="px-6 py-16 border-t border-[var(--color-border)]">
        <div className="max-w-5xl mx-auto grid grid-cols-1 md:grid-cols-3 gap-8">
          <FeatureCard
            title="full browser engine"
            description="Powered by Playwright + Chromium. Handles JavaScript rendering, ASPX postbacks, SPAs, and any site a real browser can load."
            icon="🌐"
          />
          <FeatureCard
            title="actions & forms"
            description="Type into fields, click buttons, submit forms, select dropdowns, run JavaScript — chain up to 20 actions per request."
            icon="⚡"
          />
          <FeatureCard
            title="session persistence"
            description="Create isolated browser sessions with persistent cookies. Navigate multi-step workflows across requests."
            icon="🔒"
          />
          <FeatureCard
            title="pay with USDC on Celo"
            description="Deposit credits with USDC, deducted per request. First request each day is free. No subscriptions needed."
            icon="💰"
          />
          <FeatureCard
            title="LLM-ready responses"
            description="Returns clean text, links, and form fields. Download skill.md to integrate any LLM agent in minutes."
            icon="🤖"
          />
          <FeatureCard
            title="open source"
            description="MIT licensed. Self-host for free, or use our hosted API with the self-improving domain memory layer."
            icon="📖"
          />
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="px-6 py-16 border-t border-[var(--color-border)]">
        <div className="max-w-4xl mx-auto text-center">
          <h2 className="text-2xl font-bold mb-2">simple pricing</h2>
          <p className="text-[var(--color-text-muted)] mb-10">
            Pay only for what you use. First request each day is free.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 max-w-2xl mx-auto mb-12">
            <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl p-6">
              <div className="text-3xl font-bold text-[var(--color-primary)] mb-1">$0.009</div>
              <div className="text-sm text-[var(--color-text-muted)] mb-4">per page request</div>
              <ul className="text-sm text-left space-y-2 text-[var(--color-text-muted)]">
                <li>✓ Navigate to any URL</li>
                <li>✓ Full JavaScript rendering</li>
                <li>✓ Extract text, links, forms</li>
                <li>✓ Up to 30k chars returned</li>
                <li>✓ 15s default timeout</li>
              </ul>
            </div>
            <div className="bg-[var(--color-surface)] border border-[var(--color-primary)] rounded-xl p-6">
              <div className="text-3xl font-bold text-[var(--color-primary)] mb-1">$0.013</div>
              <div className="text-sm text-[var(--color-text-muted)] mb-4">per page with actions</div>
              <ul className="text-sm text-left space-y-2 text-[var(--color-text-muted)]">
                <li>✓ Everything above, plus:</li>
                <li>✓ Type into form fields</li>
                <li>✓ Click buttons & links</li>
                <li>✓ Submit forms (incl. ASPX)</li>
                <li>✓ Run JavaScript on page</li>
                <li>✓ Wait for elements to load</li>
                <li>✓ Up to 20 actions/request</li>
              </ul>
            </div>
          </div>

          <div className="max-w-2xl mx-auto text-sm text-[var(--color-text-muted)] space-y-2">
            <p><strong className="text-[var(--color-text)]">Rate limits:</strong> 60 requests/min per IP. Responses include <code className="text-xs bg-[var(--color-surface)] px-1.5 py-0.5 rounded">X-RateLimit-Remaining</code> header.</p>
            <p><strong className="text-[var(--color-text)]">Timeouts:</strong> Default 15s, configurable up to 30s per request.</p>
            <p><strong className="text-[var(--color-text)]">Minimum deposit:</strong> $0.10 USDC on Celo. Your wallet address is your account.</p>
            <p><strong className="text-[var(--color-text)]">Sister discount:</strong> <a href="https://minai.work" className="text-[var(--color-primary)]">minai</a> and registered partners get 50% off all requests.</p>
          </div>
        </div>
      </section>

      {/* Demo */}
      <div id="demo">
        <DemoSection />
      </div>

      {/* Footer */}
      <footer className="px-6 py-8 border-t border-[var(--color-border)] text-center text-sm text-[var(--color-text-muted)]">
        <div className="flex items-center justify-center gap-1 mb-2">
          <span>built by</span>
          <a href="https://minai.work" className="text-[var(--color-primary)] hover:underline">minai</a>
          <span>on</span>
          <span className="text-yellow-400">Celo</span>
        </div>
        <div>
          <a href="https://github.com/helloluis/kamai" className="hover:text-white transition-colors">GitHub</a>
          {' · '}
          <a href="/skill.md" className="hover:text-white transition-colors">skill.md</a>
          {' · '}
          <a href="https://minai.work/terms" className="hover:text-white transition-colors">Terms</a>
          {' · '}
          <a href="https://minai.work/privacy" className="hover:text-white transition-colors">Privacy</a>
        </div>
      </footer>
    </div>
  );
}

function FeatureCard({ title, description, icon }: { title: string; description: string; icon: string }) {
  return (
    <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl p-6 hover:border-[var(--color-primary)] transition-colors">
      <div className="text-2xl mb-3">{icon}</div>
      <h3 className="font-semibold mb-2">{title}</h3>
      <p className="text-sm text-[var(--color-text-muted)] leading-relaxed">{description}</p>
    </div>
  );
}