/**
 * Simple in-memory rate limiter per IP.
 */
import type { Request, Response, NextFunction } from 'express';

const WINDOW_MS = 60_000; // 1 minute
const MAX_REQUESTS = parseInt(process.env.RATE_LIMIT_RPM ?? '60', 10);

const hits = new Map<string, { count: number; resetAt: number }>();

// Clean up expired entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of hits) {
    if (now > entry.resetAt) hits.delete(ip);
  }
}, 300_000);

export function rateLimit(req: Request, res: Response, next: NextFunction): void {
  const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || 'unknown';
  const now = Date.now();

  let entry = hits.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + WINDOW_MS };
    hits.set(ip, entry);
  }

  entry.count++;

  res.setHeader('X-RateLimit-Limit', MAX_REQUESTS);
  res.setHeader('X-RateLimit-Remaining', Math.max(0, MAX_REQUESTS - entry.count));
  res.setHeader('X-RateLimit-Reset', Math.ceil(entry.resetAt / 1000));

  if (entry.count > MAX_REQUESTS) {
    res.status(429).json({ ok: false, error: 'Rate limit exceeded. Try again later.' });
    return;
  }

  next();
}