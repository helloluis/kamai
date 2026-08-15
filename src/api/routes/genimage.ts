/**
 * POST /api/v1/image/generate — proxy image generation (paid, cost-plus).
 * GET  /api/v1/image/:id/file — public image bytes (expiring, unauthenticated).
 *
 * One provider/model per request; failover chains belong to the caller, which
 * knows its own aspect/placement constraints. Unlike the other paid routes,
 * the response body carries `priceUsd` — the settled marked-up price — because
 * image generation is the one endpoint whose consumers must display per-call
 * cost to THEIR users, and the price is computable in-handler before we
 * respond (max(floor, 2 x upstream), same formula the billing hook settles).
 */
import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { generateImage, providerConfigured } from '../../genimage/providers.js';
import {
  saveGenImage, getGenImage, readGenImage, genImageCapacityOk,
} from '../../genimage/storage.js';
import { priceFor, PRICE_FLOORS } from '../../payment/pricing.js';

const router = Router();

/** Public router — image bytes carry no auth so callers can fetch them plainly. */
export const genimagePublic = Router();

const PROVIDERS = ['openai', 'ideogram', 'dashscope'];
const MAX_PROMPT_CHARS = 8_000;
/** Transient hand-off: callers fetch immediately; keep for one day. */
const EXPIRY_HOURS = 24;

function callerIp(req: any): string {
  return (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || '?';
}

function callerOwner(req: any): string {
  return (req.headers['x-api-key'] as string)
    || (req.headers['x-wallet-address'] as string)
    || 'anonymous';
}

router.post('/generate', async (req, res) => {
  const t0 = Date.now();
  const ts = new Date().toISOString();
  const ip = callerIp(req);
  const body = (req.body ?? {}) as Record<string, unknown>;

  const provider = String(body.provider || '').trim().toLowerCase();
  const model = String(body.model || '').trim();
  const prompt = String(body.prompt || '').trim();

  if (!PROVIDERS.includes(provider)) {
    res.status(400).json({ ok: false, error: `"provider" must be one of: ${PROVIDERS.join(', ')}` });
    return;
  }
  if (!model) {
    res.status(400).json({ ok: false, error: 'Missing "model" field' });
    return;
  }
  if (!prompt) {
    res.status(400).json({ ok: false, error: 'Missing "prompt" field' });
    return;
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    res.status(400).json({ ok: false, error: `"prompt" exceeds ${MAX_PROMPT_CHARS} characters` });
    return;
  }
  if (!providerConfigured(provider)) {
    res.locals.chargedUsd = 0;
    res.status(503).json({ ok: false, error: `Provider "${provider}" not configured on kamai server` });
    return;
  }
  if (!genImageCapacityOk()) {
    res.locals.chargedUsd = 0;
    res.status(507).json({ ok: false, error: 'Generated-image store is full. Retry shortly — images expire hourly.' });
    return;
  }

  console.log(`[GenImage] ${ts} | ${ip} | REQ ${provider}/${model} "${prompt.slice(0, 80)}"`);

  try {
    const result = await generateImage({
      provider,
      model,
      prompt,
      size: typeof body.size === 'string' ? body.size : undefined,
      quality: typeof body.quality === 'string' ? body.quality : undefined,
      resolution: typeof body.resolution === 'string' ? body.resolution : undefined,
      rendering_speed: typeof body.rendering_speed === 'string' ? body.rendering_speed : undefined,
    });

    const id = uuid();
    const expiresAt = new Date(Date.now() + EXPIRY_HOURS * 3_600_000).toISOString();
    saveGenImage(
      { id, owner: callerOwner(req), provider: result.provider, model: result.model, size_bytes: result.buffer.length, expires_at: expiresAt },
      result.buffer,
    );

    const priceUsd = priceFor(PRICE_FLOORS.image, result.upstreamUsd);
    const elapsed = Date.now() - t0;
    console.log(`[GenImage] ${ts} | ${ip} | OK ${provider}/${result.model} ${result.buffer.length}b upstream $${result.upstreamUsd.toFixed(4)} price $${priceUsd.toFixed(4)} | ${elapsed}ms`);

    res.locals.usage = {
      source: result.provider,
      results: 1,
      upstream: result.upstreamUsd,
      detail: `${result.model} ${result.detail || ''}`.trim(),
    };
    res.json({
      ok: true,
      imageId: id,
      imageUrl: `/api/v1/image/${id}/file`,
      provider: result.provider,
      model: result.model,
      sizeBytes: result.buffer.length,
      upstreamUsd: +result.upstreamUsd.toFixed(4),
      priceUsd,
      pricing: 'cost-plus:100%',
      expiresAt,
      elapsedMs: elapsed,
    });
  } catch (err: any) {
    // Generation failed — nothing was delivered, so nothing is billed. (If the
    // provider charged us for a failure, that upstream burn is accepted as
    // cost of doing business rather than passed to the caller.)
    res.locals.chargedUsd = 0;
    const elapsed = Date.now() - t0;
    console.warn(`[GenImage] ${ts} | ${ip} | FAIL ${provider}/${model}: ${err.message} | ${elapsed}ms`);
    res.status(502).json({ ok: false, error: `Generation failed: ${err.message}`, provider, model });
  }
});

// ─── GET /:id/file — public image bytes ───

genimagePublic.get('/:id/file', (req, res) => {
  const rec = getGenImage(req.params.id);
  if (!rec) {
    res.status(404).json({ ok: false, error: 'Image not found or expired.' });
    return;
  }
  const buffer = readGenImage(rec);
  if (!buffer) {
    res.status(404).json({ ok: false, error: 'Image file not found on disk.' });
    return;
  }
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(buffer);
});

export default router;
