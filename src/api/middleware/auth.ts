/**
 * API key authentication middleware.
 * Keys are configured via API_KEYS env var (comma-separated).
 */
import type { Request, Response, NextFunction } from 'express';

const API_KEYS = new Set(
  (process.env.API_KEYS || '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean),
);

export function apiKeyAuth(req: Request, res: Response, next: NextFunction): void {
  // Skip auth if no keys are configured (open mode for development)
  if (API_KEYS.size === 0) return next();

  const key = req.headers['x-api-key'] as string | undefined;
  if (!key || !API_KEYS.has(key)) {
    res.status(401).json({ ok: false, error: 'Invalid or missing API key' });
    return;
  }
  next();
}