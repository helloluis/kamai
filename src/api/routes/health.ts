/**
 * GET /health — health check endpoint.
 */
import { Router } from 'express';

const router = Router();

router.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'kamai',
    version: process.env.npm_package_version || '0.1.0',
    engine: 'playwright-chromium',
    uptime: Math.floor(process.uptime()),
  });
});

export default router;
