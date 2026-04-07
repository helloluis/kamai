/**
 * Brochure API — generate, update, download, and list PDF brochures.
 */
import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import {
  renderBrochure,
  listTemplates,
  savePdf,
  readPdf,
  insertBrochure,
  getBrochure,
  updateBrochure as updateBrochureRecord,
  getFilePath,
} from '../../brochure/index.js';
import type { GenerateRequest, UpdateRequest, BrochureContent } from '../../brochure/types.js';

const router = Router();

/** Compute expiry date from option string */
function expiresAt(expiresIn?: string): string {
  const days = expiresIn === '7d' ? 7 : expiresIn === '14d' ? 14 : 30;
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

// ─── GET /templates — list available templates ───

router.get('/templates', (_req, res) => {
  res.json({ ok: true, templates: listTemplates() });
});

// ─── POST /generate — create a new brochure ───

router.post('/generate', async (req, res) => {
  const body = req.body as GenerateRequest;

  if (!body.template) {
    res.status(400).json({ ok: false, error: 'Missing required field: template' });
    return;
  }
  if (!body.content?.title) {
    res.status(400).json({ ok: false, error: 'Missing required field: content.title' });
    return;
  }

  try {
    const id = uuid();
    const { buffer, pageCount } = await renderBrochure(body.template, body.content, body.options);
    const filePath = savePdf(id, buffer);
    const expires = expiresAt(body.options?.expiresIn);

    // Resolve wallet for ownership (set by middleware or sister bypass)
    const wallet = (req.headers['x-wallet-address'] as string)
      || (req.headers['x-api-key'] as string)
      || 'anonymous';

    insertBrochure({
      id,
      wallet,
      template: body.template,
      source_json: JSON.stringify({ template: body.template, content: body.content, options: body.options }),
      file_path: filePath,
      page_count: pageCount,
      size_bytes: buffer.length,
      expires_at: expires,
    });

    console.log(`[Brochure] Generated "${body.template}" (${pageCount} pages, ${(buffer.length / 1024).toFixed(1)}KB) → ${id}`);

    res.json({
      ok: true,
      brochureId: id,
      downloadUrl: `/api/v1/brochure/${id}/download`,
      pageCount,
      sizeBytes: buffer.length,
      expiresAt: expires,
      template: body.template,
    });
  } catch (err) {
    console.error('[Brochure] Generate error:', err);
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ ok: false, error: message });
  }
});

// ─── PATCH /:id — update an existing brochure ───

router.patch('/:id', async (req, res) => {
  const { id } = req.params;
  const body = req.body as UpdateRequest;

  const existing = getBrochure(id);
  if (!existing) {
    res.status(404).json({ ok: false, error: `Brochure "${id}" not found or expired.` });
    return;
  }

  try {
    // Deep-merge content updates into stored source
    const source = JSON.parse(existing.source_json) as GenerateRequest;
    const mergedContent: BrochureContent = { ...source.content, ...body.content };

    // Merge arrays by replacement (sections, products, etc.)
    if (body.content?.sections) mergedContent.sections = body.content.sections;
    if (body.content?.products) mergedContent.products = body.content.products;
    if (body.content?.charts) mergedContent.charts = body.content.charts;
    if (body.content?.contactInfo) {
      mergedContent.contactInfo = { ...source.content.contactInfo, ...body.content.contactInfo };
    }
    if (body.content?.event) {
      mergedContent.event = { ...source.content.event, ...body.content.event } as any;
    }

    const mergedOptions = { ...source.options, ...body.options };
    const { buffer, pageCount } = await renderBrochure(source.template, mergedContent, mergedOptions);
    const filePath = savePdf(id, buffer);
    const expires = expiresAt(mergedOptions.expiresIn);

    updateBrochureRecord(
      id,
      JSON.stringify({ template: source.template, content: mergedContent, options: mergedOptions }),
      filePath,
      pageCount,
      buffer.length,
      expires,
    );

    console.log(`[Brochure] Updated "${id}" (${pageCount} pages, ${(buffer.length / 1024).toFixed(1)}KB)`);

    res.json({
      ok: true,
      brochureId: id,
      downloadUrl: `/api/v1/brochure/${id}/download`,
      pageCount,
      sizeBytes: buffer.length,
      expiresAt: expires,
      template: source.template,
    });
  } catch (err) {
    console.error('[Brochure] Update error:', err);
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ ok: false, error: message });
  }
});

// ─── GET /:id/download — serve the PDF ───

router.get('/:id/download', (req, res) => {
  const { id } = req.params;
  const record = getBrochure(id);
  if (!record) {
    res.status(404).json({ ok: false, error: 'Brochure not found or expired.' });
    return;
  }

  const buffer = readPdf(id);
  if (!buffer) {
    res.status(404).json({ ok: false, error: 'PDF file not found on disk.' });
    return;
  }

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="brochure-${id.slice(0, 8)}.pdf"`);
  res.setHeader('Content-Length', buffer.length);
  res.send(buffer);
});

export default router;