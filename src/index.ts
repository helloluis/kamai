/**
 * kamai — Headless browser API with micropayments on Celo.
 *
 * Open-source browser automation service that lets LLM agents
 * browse the web, fill forms, and extract content.
 */
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { rateLimit } from './api/middleware/rate-limit.js';
import { creditPayment } from './payment/middleware.js';
import browseRouter from './api/routes/browse.js';
import sessionRouter from './api/routes/session.js';
import depositRouter from './api/routes/deposit.js';
import accountRouter from './api/routes/account.js';
import healthRouter from './api/routes/health.js';
import memoriesRouter, { closeMemoriesDb } from './api/routes/memories.js';
import { shutdown } from './browser/index.js';
import { closeCreditsDb } from './payment/credits.js';
import { validateSeed, getMasterAddress } from './payment/wallet.js';
import { PAYMENT_RECIPIENT } from './payment/config.js';

const PORT = parseInt(process.env.PORT ?? '3100', 10);
const HOST = process.env.HOST ?? '0.0.0.0';

const app = express();

// Global middleware
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Public routes
app.use('/health', healthRouter);

// Account & credit management
app.use('/api/v1/account', rateLimit, accountRouter);
app.use('/api/v1/deposit', rateLimit, depositRouter);

// Protected routes — credit-based payment (identity via wallet or API key)
app.use('/api/v1/browse', rateLimit, creditPayment(), browseRouter);
app.use('/api/v1/session', rateLimit, sessionRouter);

// Legacy routes — backward compatibility with minai/beanie browse-service
// These bypass payment (sister apps call directly from their backends)
app.use('/browse/memories', memoriesRouter);
app.use('/browse', browseRouter);

// Skill file — downloadable LLM integration spec
app.get('/skill.md', (_req, res) => {
  res.sendFile('skill.md', { root: '.' });
});

// 404
app.use((_req, res) => {
  res.status(404).json({ ok: false, error: 'Not found' });
});

// Validate wallet seed at startup
if (process.env.WALLET_SEED) {
  if (PAYMENT_RECIPIENT && !validateSeed(PAYMENT_RECIPIENT)) {
    console.warn(`[kamai] WARNING: WALLET_SEED master address does not match PAYMENT_RECIPIENT_ADDRESS`);
    console.warn(`[kamai] Master derived: ${getMasterAddress()}, expected: ${PAYMENT_RECIPIENT}`);
  } else {
    console.log(`[kamai] Wallet seed verified — master: ${getMasterAddress()}`);
  }
}

// Start
app.listen(PORT, HOST, () => {
  console.log(`[kamai] API server listening on ${HOST}:${PORT}`);
  console.log(`[kamai] Pricing: $0.009/browse, $0.013/actions (first daily request free)`);
  console.log(`[kamai] Docs: /skill.md  Health: /health`);
});

// Graceful shutdown
const graceful = async () => {
  console.log('[kamai] Shutting down...');
  closeCreditsDb();
  closeMemoriesDb();
  await shutdown();
  process.exit(0);
};
process.on('SIGINT', graceful);
process.on('SIGTERM', graceful);