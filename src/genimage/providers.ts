/**
 * Image-generation providers — thin proxies with measured upstream cost.
 *
 * kamai holds the provider keys; sister apps (adman) send one request here and
 * get back an image plus the marked-up price. Failover across providers is the
 * CALLER's job (the caller knows its own placement/aspect constraints); each
 * call here targets exactly one provider/model and either succeeds or throws.
 */

const OPENAI_KEY = () => process.env.OPENAI_API_KEY || '';
const IDEOGRAM_KEY = () => process.env.IDEOGRAM_API_KEY || '';
const DASHSCOPE_KEY = () => process.env.DASHSCOPE_API_KEY || '';

export interface GenResult {
  buffer: Buffer;
  /** What this generation actually cost kamai, in USD. */
  upstreamUsd: number;
  provider: 'openai' | 'ideogram' | 'dashscope';
  model: string;
  detail?: string;
}

export interface GenRequest {
  provider: string;
  model: string;
  prompt: string;
  /** openai: "1536x1024" | "1024x1536" | "1024x1024"; dashscope: "1664*928" etc. */
  size?: string;
  /** openai only: low | medium | high */
  quality?: string;
  /** ideogram only: e.g. "2560x1440", "3072x1024" */
  resolution?: string;
  /** ideogram only: FLASH | TURBO | BALANCED | DEFAULT | QUALITY */
  rendering_speed?: string;
}

export function providerConfigured(provider: string): boolean {
  if (provider === 'openai') return Boolean(OPENAI_KEY());
  if (provider === 'ideogram') return Boolean(IDEOGRAM_KEY());
  if (provider === 'dashscope') return Boolean(DASHSCOPE_KEY());
  return false;
}

export async function generateImage(req: GenRequest): Promise<GenResult> {
  switch (req.provider) {
    case 'openai': return openaiGenerate(req);
    case 'ideogram': return ideogramGenerate(req);
    case 'dashscope': return dashscopeGenerate(req);
    default: throw new Error(`Unknown provider "${req.provider}"`);
  }
}

/** OpenAI Images API. Upstream priced from actual usage tokens ($30/M output
 * image tokens, $5/M input text tokens — gpt-image-2 rate card). */
async function openaiGenerate(req: GenRequest): Promise<GenResult> {
  const resp = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_KEY()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: req.model,
      prompt: req.prompt,
      size: req.size || '1536x1024',
      quality: req.quality || 'medium',
      n: 1,
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const data: any = await resp.json();
  if (!resp.ok) throw new Error(`openai ${resp.status}: ${JSON.stringify(data).slice(0, 300)}`);
  const b64 = data?.data?.[0]?.b64_json;
  if (!b64) throw new Error('openai: no image in response');
  const outTok = data?.usage?.output_tokens ?? 1400;
  const inTok = data?.usage?.input_tokens ?? 0;
  const upstreamUsd = (outTok / 1e6) * 30 + (inTok / 1e6) * 5;
  return {
    buffer: Buffer.from(b64, 'base64'),
    upstreamUsd,
    provider: 'openai',
    model: req.model,
    detail: `${req.size || '1536x1024'} ${req.quality || 'medium'} (${outTok} out tok)`,
  };
}

/** Ideogram v4. Upstream from the `credits` field ($0.001/credit), falling
 * back to the published per-speed rate card. */
const IDEOGRAM_SPEED_USD: Record<string, number> = {
  FLASH: 0.02, TURBO: 0.03, BALANCED: 0.05, DEFAULT: 0.06, QUALITY: 0.10,
};

async function ideogramGenerate(req: GenRequest): Promise<GenResult> {
  const speed = (req.rendering_speed || 'DEFAULT').toUpperCase();
  const resp = await fetch('https://api.ideogram.ai/v1/ideogram-v4/generate', {
    method: 'POST',
    headers: { 'Api-Key': IDEOGRAM_KEY(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text_prompt: req.prompt,
      resolution: req.resolution || '2560x1440',
      rendering_speed: speed,
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const data: any = await resp.json();
  if (!resp.ok) throw new Error(`ideogram ${resp.status}: ${JSON.stringify(data).slice(0, 300)}`);
  const url = data?.data?.[0]?.url;
  if (!url) throw new Error('ideogram: no image in response');
  const img = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!img.ok) throw new Error(`ideogram download ${img.status}`);
  const upstreamUsd = typeof data?.credits === 'number'
    ? data.credits * 0.001
    : (IDEOGRAM_SPEED_USD[speed] ?? 0.06);
  return {
    buffer: Buffer.from(await img.arrayBuffer()),
    upstreamUsd,
    provider: 'ideogram',
    model: req.model || 'ideogram-v4',
    detail: `${req.resolution || '2560x1440'} ${speed}`,
  };
}

/** DashScope qwen-image family (sync multimodal-generation endpoint).
 * Flat per-image rate card — DashScope reports no usage for image gen. */
const DASHSCOPE_IMAGE_USD: Record<string, number> = {
  'qwen-image-3.0-pro': 0.04,
  'qwen-image-3.0': 0.03,
  'qwen-image': 0.03,
};

async function dashscopeGenerate(req: GenRequest): Promise<GenResult> {
  const resp = await fetch(
    'https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${DASHSCOPE_KEY()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: req.model,
        input: { messages: [{ role: 'user', content: [{ text: req.prompt }] }] },
        parameters: { size: req.size || '1664*928', n: 1, watermark: false, prompt_extend: true },
      }),
      signal: AbortSignal.timeout(120_000),
    },
  );
  const data: any = await resp.json();
  if (!resp.ok) throw new Error(`dashscope ${resp.status}: ${JSON.stringify(data).slice(0, 300)}`);
  const content = data?.output?.choices?.[0]?.message?.content;
  const url = Array.isArray(content) ? content.find((c: any) => c.image)?.image : undefined;
  if (!url) throw new Error('dashscope: no image in response');
  const img = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!img.ok) throw new Error(`dashscope download ${img.status}`);
  return {
    buffer: Buffer.from(await img.arrayBuffer()),
    upstreamUsd: DASHSCOPE_IMAGE_USD[req.model] ?? 0.03,
    provider: 'dashscope',
    model: req.model,
    detail: req.size || '1664*928',
  };
}
