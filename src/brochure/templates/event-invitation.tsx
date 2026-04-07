/**
 * Event Invitation brochure template.
 *
 * Pages: Cover with event hero → Details + speakers → RSVP / contact
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
  eventTitle: {
    fontSize: 36,
    fontFamily: 'Helvetica-Bold',
    color: '#ffffff',
    marginBottom: 10,
  },
  eventMeta: {
    fontSize: 14,
    color: '#ffffffdd',
    marginBottom: 4,
  },

  // Details page
  detailBlock: {
    padding: 20,
    borderRadius: 6,
    marginBottom: 16,
  },
  detailLabel: {
    fontSize: 9,
    fontFamily: 'Helvetica-Bold',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 4,
  },
  detailValue: {
    fontSize: 13,
    lineHeight: 1.5,
  },

  // Speakers
  speakerGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 16,
    marginTop: 16,
  },
  speakerCard: {
    width: '47%',
    flexDirection: 'row',
    borderRadius: 6,
    overflow: 'hidden',
    border: '1 solid #e5e5e5',
  },
  speakerImage: {
    width: 70,
    height: 80,
    objectFit: 'cover' as any,
  },
  speakerImagePlaceholder: {
    width: 70,
    height: 80,
    justifyContent: 'center',
    alignItems: 'center',
  },
  speakerInfo: {
    flex: 1,
    padding: 10,
    justifyContent: 'center',
  },
  speakerName: {
    fontSize: 11,
    fontFamily: 'Helvetica-Bold',
    marginBottom: 2,
  },
  speakerTitle: {
    fontSize: 8,
    color: '#666',
    marginBottom: 4,
  },
  speakerBio: {
    fontSize: 8,
    color: '#4a4a6a',
    lineHeight: 1.4,
  },

  // RSVP page
  rsvpBox: {
    padding: 30,
    borderRadius: 8,
    alignItems: 'center',
  },
  rsvpTitle: {
    fontSize: 28,
    fontFamily: 'Helvetica-Bold',
    color: '#ffffff',
    marginBottom: 12,
  },
  rsvpText: {
    fontSize: 13,
    color: '#ffffffcc',
    textAlign: 'center',
    marginBottom: 6,
  },
});

export default function EventInvitation({
  content,
  options,
}: {
  content: BrochureContent;
  options?: BrochureOptions;
}) {
  const brand = content.brandColor || '#1a3b5c';
  const accent = content.accentColor || lighten(brand, 0.4);
  const pageSize = options?.pageSize || 'A4';
  const event = content.event;
  const charts = content.charts || [];

  if (!event) {
    return (
      <Document>
        <Page size={pageSize} style={baseStyles.contentPage}>
          <Text style={baseStyles.h1}>Missing event details</Text>
          <Text style={baseStyles.body}>Please provide event data in the content.event field.</Text>
        </Page>
      </Document>
    );
  }

  const speakers = event.speakers || [];

  return (
    <Document>
      {/* ─── Cover Page ─── */}
      <Page size={pageSize} style={baseStyles.page}>
        <View style={s.coverBg}>
          {content.coverImage && <Image src={content.coverImage} style={s.coverImage} />}
          <View style={[s.coverOverlay, { backgroundColor: brand + 'bb' }]} />
          <View style={{ zIndex: 1 }}>
            {content.logo && (
              <Image src={content.logo} style={{ width: 100, height: 40, objectFit: 'contain' as any, marginBottom: 20 }} />
            )}
            <Text style={s.eventTitle}>{event.name}</Text>
            <Text style={s.eventMeta}>📅  {event.date}{event.time ? `  ·  ${event.time}` : ''}</Text>
            {event.location && <Text style={s.eventMeta}>📍  {event.location}</Text>}
          </View>
        </View>
      </Page>

      {/* ─── Details + Speakers Page ─── */}
      <Page size={pageSize} style={baseStyles.contentPage}>
        <HeaderBar brandColor={brand} logo={content.logo} title={event.name} />
        <View style={{ paddingTop: 20 }}>
          {/* About */}
          <View style={[s.detailBlock, { backgroundColor: lighten(brand, 0.92) }]}>
            <Text style={[s.detailLabel, { color: brand }]}>About This Event</Text>
            <Text style={s.detailValue}>{event.description}</Text>
          </View>

          {/* Details grid */}
          <View style={{ flexDirection: 'row', gap: 16, marginBottom: 16 }}>
            <View style={[s.detailBlock, { flex: 1, backgroundColor: lighten(brand, 0.92) }]}>
              <Text style={[s.detailLabel, { color: brand }]}>Date & Time</Text>
              <Text style={s.detailValue}>{event.date}</Text>
              {event.time && <Text style={s.detailValue}>{event.time}</Text>}
            </View>
            {event.location && (
              <View style={[s.detailBlock, { flex: 1, backgroundColor: lighten(brand, 0.92) }]}>
                <Text style={[s.detailLabel, { color: brand }]}>Location</Text>
                <Text style={s.detailValue}>{event.location}</Text>
              </View>
            )}
          </View>

          {/* Speakers */}
          {speakers.length > 0 && (
            <>
              <Text style={[baseStyles.h2, { color: brand }]}>Speakers</Text>
              <View style={s.speakerGrid}>
                {speakers.map((sp, i) => (
                  <View key={i} style={s.speakerCard}>
                    {sp.image ? (
                      <Image src={sp.image} style={s.speakerImage} />
                    ) : (
                      <View style={[s.speakerImagePlaceholder, { backgroundColor: accent + '30' }]}>
                        <Text style={{ fontSize: 20 }}>🎤</Text>
                      </View>
                    )}
                    <View style={s.speakerInfo}>
                      <Text style={s.speakerName}>{sp.name}</Text>
                      {sp.title && <Text style={s.speakerTitle}>{sp.title}</Text>}
                      {sp.bio && <Text style={s.speakerBio}>{sp.bio}</Text>}
                    </View>
                  </View>
                ))}
              </View>
            </>
          )}

          {charts[0] && <SimpleBarChart chart={charts[0]} brandColor={brand} />}
        </View>
        <Text style={baseStyles.pageNumber}>2</Text>
      </Page>

      {/* ─── RSVP / Contact Page ─── */}
      <Page size={pageSize} style={baseStyles.contentPage}>
        <View style={{ flex: 1, justifyContent: 'center', padding: 30 }}>
          <View style={[s.rsvpBox, { backgroundColor: brand }]}>
            <Text style={s.rsvpTitle}>Join Us</Text>
            {event.rsvpUrl && <Text style={s.rsvpText}>Register: {event.rsvpUrl}</Text>}
            {event.rsvpEmail && <Text style={s.rsvpText}>RSVP: {event.rsvpEmail}</Text>}
            {!event.rsvpUrl && !event.rsvpEmail && (
              <Text style={s.rsvpText}>Contact us for registration details</Text>
            )}
          </View>
          {content.contactInfo && (
            <View style={{ marginTop: 30 }}>
              <ContactBlock info={content.contactInfo} brandColor={brand} />
            </View>
          )}
        </View>
      </Page>
    </Document>
  );
}
