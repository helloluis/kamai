/**
 * Brochure service — public API.
 */
export { renderBrochure } from './renderer.js';
export { getTemplate, listTemplates } from './registry.js';
export {
  savePdf,
  readPdf,
  getFilePath,
  insertBrochure,
  getBrochure,
  updateBrochure,
  listBrochures,
  cleanupExpired,
  closeBrochureDb,
} from './storage.js';
export type {
  BrochureContent,
  BrochureOptions,
  GenerateRequest,
  UpdateRequest,
  BrochureRecord,
  BrochureResponse,
} from './types.js';