import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'kamai — headless browser API for LLM agents',
  description: 'Browse the web programmatically. Pay per request with USDC on Celo.',
  icons: { icon: '/favicon.svg' },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}