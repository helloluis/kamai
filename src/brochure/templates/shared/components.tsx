/**
 * Reusable PDF components for brochure templates.
 */
import React from 'react';
import { View, Text, Image, StyleSheet } from '@react-pdf/renderer';
import type { ContactInfo, ChartData } from '../../types.js';

const s = StyleSheet.create({
  // Header bar
  headerBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 50,
    paddingVertical: 12,
  },
  headerLogo: {
    width: 80,
    height: 30,
    objectFit: 'contain' as any,
  },
  headerTitle: {
    fontSize: 10,
    fontFamily: 'Helvetica-Bold',
    color: '#ffffff',
  },

  // Divider
  divider: {
    height: 2,
    marginVertical: 16,
  },

  // Contact block
  contactBlock: {
    marginTop: 20,
    padding: 20,
    borderRadius: 4,
  },
  contactRow: {
    flexDirection: 'row',
    marginBottom: 4,
  },
  contactLabel: {
    fontSize: 9,
    fontFamily: 'Helvetica-Bold',
    width: 60,
  },
  contactValue: {
    fontSize: 9,
    flex: 1,
  },

  // Image frame
  imageFrame: {
    marginVertical: 10,
    borderRadius: 4,
    overflow: 'hidden',
  },
  framedImage: {
    width: '100%',
    maxHeight: 250,
    objectFit: 'cover' as any,
  },

  // Simple bar chart
  chartContainer: {
    marginVertical: 12,
    padding: 16,
    backgroundColor: '#f9f9fb',
    borderRadius: 4,
  },
  chartTitle: {
    fontSize: 12,
    fontFamily: 'Helvetica-Bold',
    marginBottom: 10,
    textAlign: 'center',
  },
  chartRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 6,
  },
  chartLabel: {
    width: 80,
    fontSize: 9,
    textAlign: 'right',
    paddingRight: 8,
  },
  chartBar: {
    height: 16,
    borderRadius: 3,
  },
  chartValue: {
    fontSize: 8,
    marginLeft: 6,
    color: '#666',
  },
});

export function HeaderBar({ brandColor, logo, title }: { brandColor: string; logo?: string; title?: string }) {
  return (
    <View style={[s.headerBar, { backgroundColor: brandColor }]}>
      {logo ? <Image src={logo} style={s.headerLogo} /> : <Text style={s.headerTitle}>{title || ''}</Text>}
      {logo && title ? <Text style={s.headerTitle}>{title}</Text> : null}
    </View>
  );
}

export function Divider({ color }: { color: string }) {
  return <View style={[s.divider, { backgroundColor: color }]} />;
}

export function ContactBlock({ info, brandColor }: { info: ContactInfo; brandColor: string }) {
  const rows: Array<[string, string]> = [];
  if (info.companyName) rows.push(['Company', info.companyName]);
  if (info.email) rows.push(['Email', info.email]);
  if (info.phone) rows.push(['Phone', info.phone]);
  if (info.website) rows.push(['Web', info.website]);
  if (info.address) rows.push(['Address', info.address]);

  return (
    <View style={[s.contactBlock, { backgroundColor: brandColor + '10' }]}>
      {info.logo && <Image src={info.logo} style={{ width: 100, height: 40, objectFit: 'contain' as any, marginBottom: 10 }} />}
      {rows.map(([label, value], i) => (
        <View key={i} style={s.contactRow}>
          <Text style={[s.contactLabel, { color: brandColor }]}>{label}</Text>
          <Text style={s.contactValue}>{value}</Text>
        </View>
      ))}
    </View>
  );
}

export function ImageFrame({ src, caption }: { src: string; caption?: string }) {
  return (
    <View style={s.imageFrame}>
      <Image src={src} style={s.framedImage} />
      {caption && <Text style={{ fontSize: 8, color: '#888', marginTop: 4, fontStyle: 'italic' }}>{caption}</Text>}
    </View>
  );
}

export function SimpleBarChart({ chart, brandColor }: { chart: ChartData; brandColor: string }) {
  const maxVal = Math.max(...chart.values, 1);
  return (
    <View style={s.chartContainer}>
      {chart.title && <Text style={s.chartTitle}>{chart.title}</Text>}
      {chart.labels.map((label, i) => {
        const pct = (chart.values[i] / maxVal) * 100;
        const color = chart.colors?.[i] || brandColor;
        return (
          <View key={i} style={s.chartRow}>
            <Text style={s.chartLabel}>{label}</Text>
            <View style={[s.chartBar, { width: `${Math.max(pct, 2)}%`, backgroundColor: color }]} />
            <Text style={s.chartValue}>{chart.values[i]}</Text>
          </View>
        );
      })}
    </View>
  );
}
