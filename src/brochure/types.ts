/**
 * Brochure generation types.
 */

// ─── Input types (what the LLM agent sends) ───

export interface BrochureSection {
  heading?: string;
  body: string;
  image?: string;        // URL or base64 data URI
  imageCaption?: string;
}

export interface ContactInfo {
  companyName?: string;
  email?: string;
  phone?: string;
  website?: string;
  address?: string;
  logo?: string;         // URL or base64
}

export interface ProductItem {
  name: string;
  description: string;
  image?: string;
  price?: string;
  specs?: Record<string, string>;
}

export interface EventDetails {
  name: string;
  date: string;
  time?: string;
  location?: string;
  description: string;
  speakers?: Array<{
    name: string;
    title?: string;
    image?: string;
    bio?: string;
  }>;
  rsvpUrl?: string;
  rsvpEmail?: string;
}

export interface ChartData {
  type: 'bar' | 'pie' | 'line';
  title?: string;
  labels: string[];
  values: number[];
  colors?: string[];
}

/** Content payload — varies by template but shares common fields */
export interface BrochureContent {
  // Common fields
  title: string;
  subtitle?: string;
  brandColor?: string;      // hex color, default #1a3b5c
  accentColor?: string;     // hex color, default derived from brandColor
  coverImage?: string;      // URL or base64
  logo?: string;            // URL or base64
  contactInfo?: ContactInfo;
  footer?: string;

  // Corporate overview
  sections?: BrochureSection[];

  // Product showcase
  products?: ProductItem[];
  catalogTitle?: string;

  // Event invitation
  event?: EventDetails;

  // Data/charts
  charts?: ChartData[];
}

export interface BrochureOptions {
  pageSize?: 'A4' | 'LETTER';
  orientation?: 'portrait' | 'landscape';
  expiresIn?: '7d' | '14d' | '30d';
}

export interface GenerateRequest {
  template: string;
  content: BrochureContent;
  options?: BrochureOptions;
}

export interface UpdateRequest {
  content: Partial<BrochureContent>;
  options?: Partial<BrochureOptions>;
}

// ─── Storage types ───

export interface BrochureRecord {
  id: string;
  wallet: string;
  template: string;
  source_json: string;
  file_path: string;
  page_count: number;
  size_bytes: number;
  created_at: string;
  expires_at: string;
}

// ─── Response types ───

export interface BrochureResponse {
  ok: true;
  brochureId: string;
  downloadUrl: string;
  pageCount: number;
  sizeBytes: number;
  expiresAt: string;
  template: string;
}