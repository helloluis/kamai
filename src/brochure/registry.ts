/**
 * Template registry — maps template names to React components.
 */
import type { BrochureContent, BrochureOptions } from './types.js';
import CorporateOverview from './templates/corporate-overview.js';
import ProductShowcase from './templates/product-showcase.js';
import EventInvitation from './templates/event-invitation.js';

export interface TemplateInfo {
  id: string;
  name: string;
  description: string;
  requiredFields: string[];
  optionalFields: string[];
}

type TemplateComponent = (props: {
  content: BrochureContent;
  options?: BrochureOptions;
}) => React.JSX.Element;

const TEMPLATES: Record<string, { component: TemplateComponent; info: TemplateInfo }> = {
  'corporate-overview': {
    component: CorporateOverview,
    info: {
      id: 'corporate-overview',
      name: 'Corporate Overview',
      description: 'Company or product overview. Cover page with hero image, content sections with heading/body/image, and contact back page. Ideal for company capabilities, annual summaries, and project proposals.',
      requiredFields: ['title', 'sections'],
      optionalFields: ['subtitle', 'brandColor', 'accentColor', 'coverImage', 'logo', 'contactInfo', 'footer', 'charts'],
    },
  },
  'product-showcase': {
    component: ProductShowcase,
    info: {
      id: 'product-showcase',
      name: 'Product Showcase',
      description: 'Product catalog with card layout. Each product has a name, description, image, price, and optional specs. 2 products per page. Ideal for product lines, menus, service offerings, and portfolios.',
      requiredFields: ['title', 'products'],
      optionalFields: ['subtitle', 'brandColor', 'accentColor', 'logo', 'catalogTitle', 'contactInfo', 'footer', 'charts'],
    },
  },
  'event-invitation': {
    component: EventInvitation,
    info: {
      id: 'event-invitation',
      name: 'Event Invitation',
      description: 'Event flyer with hero cover, event details, speaker bios, and RSVP page. Ideal for conferences, workshops, product launches, and social events.',
      requiredFields: ['title', 'event'],
      optionalFields: ['subtitle', 'brandColor', 'accentColor', 'coverImage', 'logo', 'contactInfo', 'charts'],
    },
  },
};

export function getTemplate(id: string) {
  return TEMPLATES[id] ?? null;
}

export function listTemplates(): TemplateInfo[] {
  return Object.values(TEMPLATES).map((t) => t.info);
}