/**
 * YouTube strategy — uses yt-dlp for transcript/metadata extraction.
 * Much faster and more reliable than Playwright for YouTube content.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const MAX_TEXT = 30_000;

interface BrowseResult {
  ok: boolean;
  url: string;
  title: string;
  text: string;
  length: number;
  links: { text: string; href: string }[];
  strategy_used: string;
  error?: string;
}

/**
 * Extract video info + subtitles/transcript from a YouTube URL.
 */
export async function browseYouTube(url: string): Promise<BrowseResult> {
  const videoId = extractVideoId(url);
  if (!videoId) {
    return { ok: false, url, title: '', text: '', length: 0, links: [], strategy_used: 'yt-dlp', error: 'Could not extract YouTube video ID' };
  }

  const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`;

  try {
    // Get video metadata
    const { stdout: metaJson } = await exec('yt-dlp', [
      '--dump-json',
      '--no-download',
      '--no-warnings',
      canonicalUrl,
    ], { timeout: 20_000, maxBuffer: 5 * 1024 * 1024 });

    const meta = JSON.parse(metaJson);

    // Try to get subtitles/transcript
    let transcript = '';
    try {
      const { stdout: subText } = await exec('yt-dlp', [
        '--skip-download',
        '--write-subs',
        '--write-auto-subs',
        '--sub-langs', 'en.*,en',
        '--sub-format', 'vtt',
        '--print-to-file', '%(subtitles)s', '-',
        '--no-warnings',
        '-o', '-',
        canonicalUrl,
      ], { timeout: 15_000, maxBuffer: 5 * 1024 * 1024 });

      // Clean VTT: remove timestamps and formatting
      transcript = cleanVttTranscript(subText);
    } catch {
      // No subtitles available — fall back to description
    }

    // Build the text output
    const parts: string[] = [];
    parts.push(`Title: ${meta.title || 'Unknown'}`);
    parts.push(`Channel: ${meta.uploader || meta.channel || 'Unknown'}`);
    parts.push(`Duration: ${formatDuration(meta.duration || 0)}`);
    parts.push(`Views: ${(meta.view_count || 0).toLocaleString()}`);
    parts.push(`Published: ${meta.upload_date ? formatDate(meta.upload_date) : 'Unknown'}`);

    if (meta.like_count) parts.push(`Likes: ${meta.like_count.toLocaleString()}`);
    if (meta.tags?.length) parts.push(`Tags: ${meta.tags.slice(0, 10).join(', ')}`);

    parts.push('');

    if (meta.description) {
      parts.push('--- Description ---');
      parts.push(meta.description.slice(0, 3000));
      parts.push('');
    }

    if (transcript) {
      parts.push('--- Transcript ---');
      parts.push(transcript);
    } else {
      parts.push('(No transcript/subtitles available for this video)');
    }

    const text = parts.join('\n').slice(0, MAX_TEXT);

    // Related links from description
    const links: { text: string; href: string }[] = [];
    const urlRegex = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/g;
    const descUrls = (meta.description || '').match(urlRegex) || [];
    for (const u of descUrls.slice(0, 15)) {
      links.push({ text: u.slice(0, 80), href: u });
    }

    // Channel link
    if (meta.channel_url) {
      links.push({ text: `Channel: ${meta.uploader || meta.channel}`, href: meta.channel_url });
    }

    return {
      ok: true,
      url: canonicalUrl,
      title: meta.title || '',
      text,
      length: text.length,
      links,
      strategy_used: 'yt-dlp',
    };
  } catch (err: any) {
    return {
      ok: false,
      url: canonicalUrl,
      title: '',
      text: '',
      length: 0,
      links: [],
      strategy_used: 'yt-dlp',
      error: `yt-dlp failed: ${err.message}`,
    };
  }
}

function extractVideoId(url: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?.*v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/, // bare video ID
  ];
  for (const pat of patterns) {
    const m = url.match(pat);
    if (m) return m[1];
  }
  return null;
}

function cleanVttTranscript(vtt: string): string {
  return vtt
    .replace(/^WEBVTT[\s\S]*?\n\n/, '') // remove header
    .replace(/\d{2}:\d{2}:\d{2}\.\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}\.\d{3}.*\n/g, '') // timestamps
    .replace(/<[^>]+>/g, '') // HTML tags
    .replace(/\n{3,}/g, '\n\n') // collapse blank lines
    .trim();
}

function formatDuration(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  return `${m}m ${s}s`;
}

function formatDate(yyyymmdd: string): string {
  if (yyyymmdd.length !== 8) return yyyymmdd;
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}