export default function Home() {
  return (
    <div className="min-h-screen flex flex-col">
      {/* Nav */}
      <nav className="flex items-center justify-between px-6 py-4 border-b border-[var(--color-border)]">
        <div className="flex items-center gap-2">
          <span className="text-2xl font-bold text-[var(--color-primary)]">kamAI</span>
          <span className="text-sm text-[var(--color-text-muted)]">headless browser API</span>
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
        <div className="inline-block px-3 py-1 mb-6 text-xs font-medium rounded-full bg-[var(--color-surface)] border border-[var(--color-border)] text-[var(--color-primary)]">
          open source &middot; pay-per-request &middot; built on Celo
        </div>
        <h1 className="text-5xl sm:text-6xl font-bold tracking-tight leading-tight mb-6">
          give your AI agent<br />
          <span className="text-[var(--color-primary)]">a real browser</span>
        </h1>
        <p className="text-lg text-[var(--color-text-muted)] max-w-2xl mb-10 leading-relaxed">
          kamAI is a headless browser API that lets LLM agents navigate the web, fill forms,
          click buttons, and extract content — even from legacy ASPX sites and JavaScript-heavy
          pages that simple HTTP fetches can&apos;t handle.
        </p>
        <div className="flex gap-4 items-center">
          <a
            href="https://github.com/helloluis/kamai"
            className="px-6 py-3 bg-[var(--color-primary)] text-black font-semibold rounded-lg hover:bg-[var(--color-primary-dark)] transition-colors"
          >
            Get started
          </a>
          <a
            href="/skill.md"
            className="px-6 py-3 border border-[var(--color-border)] rounded-lg text-[var(--color-text-muted)] hover:text-white hover:border-[var(--color-primary)] transition-colors"
          >
            Download skill.md
          </a>
        </div>
      </section>

      {/* Code example */}
      <section className="px-6 py-16 border-t border-[var(--color-border)]">
        <div className="max-w-3xl mx-auto">
          <h2 className="text-2xl font-bold mb-2 text-center">one API call. full browser power.</h2>
          <p className="text-[var(--color-text-muted)] text-center mb-8">
            Navigate, interact, and extract — all in a single request.
          </p>
          <pre className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl p-6 overflow-x-auto text-sm leading-relaxed">
            <code className="text-[var(--color-text)]">{`POST /api/v1/browse
x-api-key: your-key
x-payment-tx: 0xabc...def

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
            description="Type into fields, click buttons, submit forms, select dropdowns, run JavaScript — chain multiple actions in a single request."
            icon="⚡"
          />
          <FeatureCard
            title="session persistence"
            description="Create isolated browser sessions with persistent cookies and state. Navigate multi-step workflows across requests."
            icon="🔒"
          />
          <FeatureCard
            title="pay with USDC"
            description="x402-compatible micropayments on Celo. $0.02 per request. No subscriptions, no credit card — just send USDC."
            icon="💰"
          />
          <FeatureCard
            title="LLM-ready"
            description="Download skill.md and give it to any LLM agent. Returns clean text, links, and form fields — designed for AI consumption."
            icon="🤖"
          />
          <FeatureCard
            title="open source"
            description="MIT licensed. Self-host for free, or use our hosted API. Fork it, extend it, make it yours."
            icon="📖"
          />
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="px-6 py-16 border-t border-[var(--color-border)]">
        <div className="max-w-3xl mx-auto text-center">
          <h2 className="text-2xl font-bold mb-2">simple pricing</h2>
          <p className="text-[var(--color-text-muted)] mb-10">
            Pay only for what you use. No tiers, no commitments.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 max-w-xl mx-auto">
            <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl p-6">
              <div className="text-3xl font-bold text-[var(--color-primary)] mb-1">$0.02</div>
              <div className="text-sm text-[var(--color-text-muted)] mb-4">per browse request</div>
              <ul className="text-sm text-left space-y-2 text-[var(--color-text-muted)]">
                <li>✓ Full page rendering</li>
                <li>✓ Up to 20 actions</li>
                <li>✓ Text + links + forms</li>
                <li>✓ 30s timeout</li>
              </ul>
            </div>
            <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl p-6">
              <div className="text-3xl font-bold mb-1">free</div>
              <div className="text-sm text-[var(--color-text-muted)] mb-4">self-hosted</div>
              <ul className="text-sm text-left space-y-2 text-[var(--color-text-muted)]">
                <li>✓ Everything above</li>
                <li>✓ MIT licensed</li>
                <li>✓ Your own server</li>
                <li>✓ No rate limits</li>
              </ul>
            </div>
          </div>
        </div>
      </section>

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