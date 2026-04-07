/**
 * PDF renderer — takes a template + content, returns a PDF buffer.
 */
import React from 'react';
import { renderToBuffer } from '@react-pdf/renderer';
import { getTemplate } from './registry.js';
import type { BrochureContent, BrochureOptions } from './types.js';

/** Concurrency limiter — max 3 concurrent renders to protect memory */
let active = 0;
const MAX_CONCURRENT = 3;
const queue: Array<() => void> = [];

function acquireSlot(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active++;
    return Promise.resolve();
  }
  return new Promise((resolve) => queue.push(() => { active++; resolve(); }));
}

function releaseSlot(): void {
  active--;
  const next = queue.shift();
  if (next) next();
}

export interface RenderResult {
  buffer: Buffer;
  pageCount: number;
}

export async function renderBrochure(
  templateId: string,
  content: BrochureContent,
  options?: BrochureOptions,
): Promise<RenderResult> {
  const entry = getTemplate(templateId);
  if (!entry) {
    throw new Error(`Unknown template: "${templateId}". Use GET /api/v1/brochure/templates to list available templates.`);
  }

  await acquireSlot();
  try {
    const element = React.createElement(entry.component, { content, options });
    const buffer = await renderToBuffer(element as any);

    // Estimate page count from the PDF structure
    // PDF pages are delimited by /Type /Page entries
    const pdfStr = buffer.toString('binary');
    const pageMatches = pdfStr.match(/\/Type\s*\/Page(?!s)/g);
    const pageCount = pageMatches ? pageMatches.length : 1;

    return { buffer: Buffer.from(buffer), pageCount };
  } finally {
    releaseSlot();
  }
}