/**
 * Shared style constants for brochure templates.
 */
import { StyleSheet } from '@react-pdf/renderer';

export const COLORS = {
  dark: '#1a1a2e',
  mid: '#4a4a6a',
  light: '#f5f5f7',
  white: '#ffffff',
  accent: '#2563eb',
};

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace('#', '');
  return {
    r: parseInt(h.substring(0, 2), 16),
    g: parseInt(h.substring(2, 4), 16),
    b: parseInt(h.substring(4, 6), 16),
  };
}

/** Lighten a hex color by a percentage (0–1) */
export function lighten(hex: string, amount: number): string {
  const { r, g, b } = hexToRgb(hex);
  const lr = Math.min(255, Math.round(r + (255 - r) * amount));
  const lg = Math.min(255, Math.round(g + (255 - g) * amount));
  const lb = Math.min(255, Math.round(b + (255 - b) * amount));
  return `#${lr.toString(16).padStart(2, '0')}${lg.toString(16).padStart(2, '0')}${lb.toString(16).padStart(2, '0')}`;
}

/** Base styles shared across templates */
export const baseStyles = StyleSheet.create({
  page: {
    fontFamily: 'Helvetica',
    fontSize: 11,
    color: COLORS.dark,
    backgroundColor: COLORS.white,
    padding: 0,
  },
  contentPage: {
    fontFamily: 'Helvetica',
    fontSize: 11,
    color: COLORS.dark,
    backgroundColor: COLORS.white,
    paddingTop: 50,
    paddingBottom: 60,
    paddingHorizontal: 50,
  },
  h1: {
    fontSize: 32,
    fontFamily: 'Helvetica-Bold',
    marginBottom: 8,
  },
  h2: {
    fontSize: 22,
    fontFamily: 'Helvetica-Bold',
    marginBottom: 6,
  },
  h3: {
    fontSize: 16,
    fontFamily: 'Helvetica-Bold',
    marginBottom: 4,
  },
  body: {
    fontSize: 11,
    lineHeight: 1.6,
    color: COLORS.mid,
  },
  caption: {
    fontSize: 9,
    color: COLORS.mid,
    marginTop: 4,
    fontStyle: 'italic',
  },
  pageNumber: {
    position: 'absolute',
    bottom: 25,
    right: 50,
    fontSize: 9,
    color: COLORS.mid,
  },
  footer: {
    position: 'absolute',
    bottom: 25,
    left: 50,
    right: 50,
    fontSize: 8,
    color: COLORS.mid,
    textAlign: 'center',
  },
});
