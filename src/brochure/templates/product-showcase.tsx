/**
 * Product Showcase brochure template.
 *
 * Pages: Cover → Product grid pages (2 per page) → Contact back page
 */
import React from 'react';
import { Document, Page, View, Text, Image, StyleSheet } from '@react-pdf/renderer';
import type { BrochureContent, BrochureOptions } from '../types.js';
import { baseStyles, lighten } from './shared/styles.js';
import { HeaderBar, Divider, ContactBlock, SimpleBarChart } from './shared/components.js';

const s = StyleSheet.create({
  // Cover
  coverBg: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 60,
  },
  coverTitle: {
    fontSize: 36,
    fontFamily: 'Helvetica-Bold',
    color: '#ffffff',
    textAlign: 'center',
    marginBottom: 8,
  },
  coverSubtitle: {
    fontSize: 16,
    color: '#ffffffcc',
    textAlign: 'center',
  },
  coverLogo: {
    width: 140,
    height: 60,
    objectFit: 'contain' as any,
    marginBottom: 30,
  },

  // Product cards
  productGrid: {
    flexDirection: 'column',
    gap: 20,
    paddingTop: 20,
  },
  productCard: {
    flexDirection: 'row',
    borderRadius: 6,
    overflow: 'hidden',
    border: '1 solid #e5e5e5',
  },
  productImage: {
    width: 180,
    minHeight: 140,
    objectFit: 'cover' as any,
  },
  productImagePlaceholder: {
    width: 180,
    minHeight: 140,
    justifyContent: 'center',
    alignItems: 'center',
  },
  productInfo: {
    flex: 1,
    padding: 16,
    justifyContent: 'center',
  },
  productName: {
    fontSize: 16,
    fontFamily: 'Helvetica-Bold',
    marginBottom: 6,
  },
  productDesc: {
    fontSize: 10,
    lineHeight: 1.5,
    color: '#4a4a6a',
    marginBottom: 8,
  },
  productPrice: {
    fontSize: 14,
    fontFamily: 'Helvetica-Bold',
  },
  specRow: {
    flexDirection: 'row',
    marginBottom: 2,
  },
  specLabel: {
    fontSize: 8,
    fontFamily: 'Helvetica-Bold',
    width: 70,
    color: '#666',
  },
  specValue: {
    fontSize: 8,
    color: '#444',
  },
});

export default function ProductShowcase({
  content,
  options,
}: {
  content: BrochureContent;
  options?: BrochureOptions;
}) {
  const brand = content.brandColor || '#1a3b5c';
  const accent = content.accentColor || lighten(brand, 0.4);
  const pageSize = options?.pageSize || 'A4';
  const products = content.products || [];
  const charts = content.charts || [];

  // Group products: 2 per page
  const pages: typeof products[] = [];
  for (let i = 0; i < products.length; i += 2) {
    pages.push(products.slice(i, i + 2));
  }

  return (
    <Document>
      {/* ─── Cover Page ─── */}
      <Page size={pageSize} style={[baseStyles.page, { backgroundColor: brand }]}>
        <View style={s.coverBg}>
          {content.logo && <Image src={content.logo} style={s.coverLogo} />}
          <Text style={s.coverTitle}>{content.catalogTitle || content.title}</Text>
          {content.subtitle && <Text style={s.coverSubtitle}>{content.subtitle}</Text>}
        </View>
      </Page>

      {/* ─── Product Pages ─── */}
      {pages.map((pageProducts, pi) => (
        <Page key={pi} size={pageSize} style={baseStyles.contentPage}>
          <HeaderBar brandColor={brand} logo={content.logo} title={content.catalogTitle || content.title} />
          <View style={s.productGrid}>
            {pageProducts.map((product, i) => (
              <View key={i} style={s.productCard}>
                {product.image ? (
                  <Image src={product.image} style={s.productImage} />
                ) : (
                  <View style={[s.productImagePlaceholder, { backgroundColor: accent + '30' }]}>
                    <Text style={{ fontSize: 24, color: brand }}>📦</Text>
                  </View>
                )}
                <View style={s.productInfo}>
                  <Text style={[s.productName, { color: brand }]}>{product.name}</Text>
                  <Text style={s.productDesc}>{product.description}</Text>
                  {product.price && <Text style={[s.productPrice, { color: brand }]}>{product.price}</Text>}
                  {product.specs && Object.entries(product.specs).map(([k, v], si) => (
                    <View key={si} style={s.specRow}>
                      <Text style={s.specLabel}>{k}</Text>
                      <Text style={s.specValue}>{v}</Text>
                    </View>
                  ))}
                </View>
              </View>
            ))}
          </View>
          {charts[pi] && <SimpleBarChart chart={charts[pi]} brandColor={brand} />}
          <Text style={baseStyles.pageNumber}>{pi + 2}</Text>
          {content.footer && <Text style={baseStyles.footer}>{content.footer}</Text>}
        </Page>
      ))}

      {/* ─── Back Page ─── */}
      {content.contactInfo && (
        <Page size={pageSize} style={baseStyles.contentPage}>
          <View style={{ flex: 1, justifyContent: 'center', padding: 40 }}>
            <Text style={{ fontSize: 24, fontFamily: 'Helvetica-Bold', color: brand, textAlign: 'center', marginBottom: 20 }}>
              Order & Inquiries
            </Text>
            <ContactBlock info={content.contactInfo} brandColor={brand} />
          </View>
        </Page>
      )}
    </Document>
  );
}
