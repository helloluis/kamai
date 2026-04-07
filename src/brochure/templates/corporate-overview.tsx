/**
 * Corporate Overview brochure template.
 *
 * Pages: Cover → Content sections (1 per page) → Contact back page
 */
import React from 'react';
import { Document, Page, View, Text, Image, StyleSheet } from '@react-pdf/renderer';
import type { BrochureContent, BrochureOptions } from '../types.js';
import { baseStyles, lighten } from './shared/styles.js';
import { HeaderBar, Divider, ContactBlock, ImageFrame, SimpleBarChart } from './shared/components.js';

const s = StyleSheet.create({
  // Cover page
  coverBg: {
    flex: 1,
    justifyContent: 'flex-end',
    padding: 50,
  },
  coverImage: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    objectFit: 'cover' as any,
  },
  coverOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  coverTitle: {
    fontSize: 38,
    fontFamily: 'Helvetica-Bold',
    color: '#ffffff',
    marginBottom: 8,
  },
  coverSubtitle: {
    fontSize: 18,
    color: '#ffffffcc',
    marginBottom: 20,
  },
  coverLogo: {
    width: 120,
    height: 50,
    objectFit: 'contain' as any,
    marginBottom: 20,
  },

  // Content section
  sectionHeading: {
    fontSize: 22,
    fontFamily: 'Helvetica-Bold',
    marginBottom: 10,
  },
  sectionBody: {
    fontSize: 11,
    lineHeight: 1.7,
    color: '#4a4a6a',
    marginBottom: 12,
  },
  sectionImage: {
    width: '100%',
    maxHeight: 220,
    objectFit: 'cover' as any,
    borderRadius: 4,
    marginBottom: 8,
  },

  // Back page
  backPage: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 60,
  },
  backTitle: {
    fontSize: 28,
    fontFamily: 'Helvetica-Bold',
    marginBottom: 20,
    textAlign: 'center',
  },
  backTagline: {
    fontSize: 14,
    color: '#4a4a6a',
    textAlign: 'center',
    marginBottom: 30,
  },
});

export default function CorporateOverview({
  content,
  options,
}: {
  content: BrochureContent;
  options?: BrochureOptions;
}) {
  const brand = content.brandColor || '#1a3b5c';
  const accent = content.accentColor || lighten(brand, 0.4);
  const pageSize = options?.pageSize || 'A4';
  const sections = content.sections || [];
  const charts = content.charts || [];

  return (
    <Document>
      {/* ─── Cover Page ─── */}
      <Page size={pageSize} style={baseStyles.page}>
        <View style={s.coverBg}>
          {content.coverImage && <Image src={content.coverImage} style={s.coverImage} />}
          <View style={[s.coverOverlay, { backgroundColor: brand + 'cc' }]} />
          <View style={{ zIndex: 1 }}>
            {content.logo && <Image src={content.logo} style={s.coverLogo} />}
            <Text style={s.coverTitle}>{content.title}</Text>
            {content.subtitle && <Text style={s.coverSubtitle}>{content.subtitle}</Text>}
          </View>
        </View>
      </Page>

      {/* ─── Content Pages ─── */}
      {sections.map((section, i) => (
        <Page key={i} size={pageSize} style={baseStyles.contentPage}>
          <HeaderBar brandColor={brand} logo={content.logo} title={content.title} />
          <View style={{ paddingHorizontal: 0, paddingTop: 20 }}>
            {section.heading && (
              <Text style={[s.sectionHeading, { color: brand }]}>{section.heading}</Text>
            )}
            <Divider color={accent} />
            <Text style={s.sectionBody}>{section.body}</Text>
            {section.image && (
              <ImageFrame src={section.image} caption={section.imageCaption} />
            )}
            {/* Show a chart on this page if we have one at the same index */}
            {charts[i] && <SimpleBarChart chart={charts[i]} brandColor={brand} />}
          </View>
          <Text style={baseStyles.pageNumber}>{i + 2}</Text>
          {content.footer && <Text style={baseStyles.footer}>{content.footer}</Text>}
        </Page>
      ))}

      {/* Extra chart pages if there are more charts than sections */}
      {charts.slice(sections.length).map((chart, i) => (
        <Page key={`chart-${i}`} size={pageSize} style={baseStyles.contentPage}>
          <HeaderBar brandColor={brand} logo={content.logo} title={content.title} />
          <View style={{ paddingTop: 20 }}>
            <SimpleBarChart chart={chart} brandColor={brand} />
          </View>
          <Text style={baseStyles.pageNumber}>{sections.length + i + 2}</Text>
        </Page>
      ))}

      {/* ─── Back Page (Contact) ─── */}
      {content.contactInfo && (
        <Page size={pageSize} style={baseStyles.contentPage}>
          <View style={s.backPage}>
            <Text style={[s.backTitle, { color: brand }]}>Get In Touch</Text>
            {content.subtitle && <Text style={s.backTagline}>{content.subtitle}</Text>}
            <ContactBlock info={content.contactInfo} brandColor={brand} />
          </View>
        </Page>
      )}
    </Document>
  );
}
