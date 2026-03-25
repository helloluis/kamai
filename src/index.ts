/**
 * kamAI — Headless browser API with x402 micropayments on Celo.
 *
 * Open-source browser automation service that lets LLM agents
 * browse the web, fill forms, and extract content.
 */
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { apiKeyAuth } from './api/middleware/auth.js';
import { rateLimit } from './api/middleware/rate-limit.js';
import { paymentRequired } from './payment/index.js';
import browseRouter from './api/routes/browse.js';
import sessionRouter from './api/routes/session.js';
import healthRouter from './api/routes/health.js';
import { shutdown } from './browser/index.js';

const PORT = parseInt(process.env.PORT ?? '3100', 10);
const HOST = process.env.HOST ?? '0.0.0.0';

const app = express();

// Global middleware
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Public routes
app.use('/health', healthRouter);

// Protected routes — payment required when PAYMENT_RECIPIENT_ADDRESS is set
app.use('/api/v1/browse', rateLimit, apiKeyAuth, paymentRequired(), browseRouter);
app.use('/api/v1/session', rateLimit, apiKeyAuth, sessionRouter);

// Skill file — downloadable LLM integration spec
app.get('/skill.md', (_req, res) => {
  res.sendFile('skill.md', { root: '.' });
});

// 404
app.use((_req, res) => {
  res.status(404).json({ ok: false, error: 'Not found' });
});

// Start
app.listen(PORT, HOST, () => {
  console.log(`[kamAI] API server listening on ${HOST}:${PORT}`);
  console.log(`[kamAI] Docs: /skill.md  Health: /health`);
});

// Graceful shutdown
const graceful = async () => {
  console.log('[kamAI] Shutting down...');
  await shutdown();
  process.exit(0);
};
process.on('SIGINT', graceful);
process.on('SIGTERM', graceful);