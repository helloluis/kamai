import { renderBrochure } from './dist/brochure/renderer.js';
import { writeFileSync, readFileSync } from 'fs';

const logoBuffer = readFileSync('C:/Users/User/Desktop/talino brand assets/Talino Foundry Logo-Black.png');
const logoBase64 = `data:image/png;base64,${logoBuffer.toString('base64')}`;

const content = {
  title: 'Talino Fintech Foundry',
  subtitle: 'Your customers want to pay you in stablecoins. But you don\'t want to deal with the added complexity.',
  brandColor: '#2e9e3e',
  logo: logoBase64,

  sections: [
    {
      heading: 'Stablecoin Acceptance Infrastructure',
      body: `Talino's stablecoin acceptance infrastructure supports multiple stablecoins (USDC, USDT, etc) and multiple blockchains, and terminates directly as a USD deposit in your nominated US bank account.

No added complexity. No added processing time.

Volume Pricing:
• $5M+ per month — 25 bps (0.25%) per transaction
• $2–5M/month — 35 bps (0.35%)
• $1–2M/month — 45 bps (0.45%)
• Below $1M/month — 50 bps (0.5%)`,
    },
    {
      heading: 'Multi-Stablecoin, Multi-Chain Support',
      body: `Accept USDC, USDT, and other major stablecoins across multiple blockchain networks. If you don't know what that means, you are the exact business customer we built this for!

You never touch crypto — we handle the entire acceptance, gas fee payment, stablecoin conversion, and USD settlement pipeline.`,
    },
    {
      heading: 'White-Labeled Customer Experience',
      body: `Each of your customers is assigned a unique, fully trackable blockchain wallet address. We provide white-labeled payment guides and reference material, customized to match your corporate branding.

Your customers see your brand, not ours — "Powered by Talino".`,
    },
    {
      heading: 'Automatic USD Settlement',
      body: `All stablecoins received are automatically converted to USD and transferred via ACH to your nominated US bank account(s).

Same-day or next-day settlement with no crypto holding period. Transaction information pushed via email or API, integrating with your existing accounting software. Full transaction reporting and reconciliation included.`,
    },
    {
      heading: 'Why Talino?',
      body: `For Financial Institutions:
• No crypto infrastructure to build
• No regulatory complexity
• USD settlement only
• As low as 25 bps vs. 2–3% card fees
• No balance sheet risk

For Their Customers:
• Pay in their preferred currency
• Fast, transparent settlement
• Trackable, auditable payments
• Lower cost than wire transfers
• White-labeled experience`,
    },
  ],

  charts: [
    {
      type: 'bar',
      title: 'Cost Comparison: Stablecoin vs Traditional',
      labels: ['Talino (25 bps)', 'Wire Transfer', 'Credit Card', 'SWIFT'],
      values: [0.25, 1.5, 2.9, 3.5],
      colors: ['#2e9e3e', '#999', '#999', '#999'],
    },
  ],

  contactInfo: {
    companyName: 'Talino Fintech Foundry',
    email: 'info@talino.com',
    website: 'https://talino.com',
  },

  footer: '© 2026 Talino Fintech Foundry. All rights reserved.',
};

const result = await renderBrochure('corporate-overview', content, { pageSize: 'A4' });
const outPath = './data/brochures/talino-test.pdf';
writeFileSync(outPath, result.buffer);
console.log(`Generated: ${outPath}`);
console.log(`Pages: ${result.pageCount}`);
console.log(`Size: ${(result.buffer.length / 1024).toFixed(1)} KB`);