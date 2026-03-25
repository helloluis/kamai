/**
 * Page extraction — pull text, links, and form fields from a rendered page.
 */
import type { Page } from 'playwright';

const MAX_TEXT_LENGTH = parseInt(process.env.MAX_TEXT_LENGTH ?? '30000', 10);

export interface ExtractedPage {
  title: string;
  text: string;
  links: { text: string; href: string }[];
  forms: Record<string, any>[];
  length: number;
}

export async function extractPage(page: Page, selector?: string | null): Promise<ExtractedPage> {
  let text: string;
  if (selector) {
    try {
      await page.waitForSelector(selector, { timeout: 5000 });
      text = await page.$eval(selector, (el: any) => el.innerText || el.textContent || '');
    } catch {
      text = await page.evaluate(() => document.body?.innerText || document.body?.textContent || '');
    }
  } else {
    text = await page.evaluate(() => document.body?.innerText || document.body?.textContent || '');
  }

  const title = await page.title().catch(() => '');

  const links = await page
    .evaluate(() =>
      Array.from(document.querySelectorAll('a[href]'))
        .slice(0, 50)
        .map((a) => ({ text: (a.textContent || '').trim().slice(0, 100), href: (a as HTMLAnchorElement).href }))
        .filter((l) => l.href && l.text),
    )
    .catch(() => []);

  const forms = await page
    .evaluate(() => {
      const inputs = Array.from(
        document.querySelectorAll('input, textarea, select, button[type="submit"], input[type="submit"]'),
      );
      return inputs
        .slice(0, 40)
        .map((el) => {
          const tag = el.tagName.toLowerCase();
          const type = el.getAttribute('type') || '';
          const name = el.getAttribute('name') || '';
          const id = el.getAttribute('id') || '';
          const placeholder = el.getAttribute('placeholder') || '';
          const label = id ? document.querySelector(`label[for="${id}"]`)?.textContent?.trim() : '';
          const value =
            tag === 'select'
              ? Array.from((el as HTMLSelectElement).options || [])
                  .map((o) => `${o.value}:${o.text.trim()}`)
                  .join(', ')
              : '';
          const selectorStr = id ? `#${id}` : name ? `${tag}[name="${name}"]` : tag;
          return {
            tag,
            type: type || undefined,
            name: name || undefined,
            id: id || undefined,
            placeholder: placeholder || undefined,
            label: label || undefined,
            value: value || undefined,
            selector: selectorStr,
          };
        })
        .filter((f) => f.type !== 'hidden');
    })
    .catch(() => []);

  const trimmed = (text || '').trim();
  const truncated =
    trimmed.length > MAX_TEXT_LENGTH
      ? trimmed.slice(0, MAX_TEXT_LENGTH) + `\n\n[Truncated — ${trimmed.length} chars total]`
      : trimmed;

  return { title, text: truncated, links: links.slice(0, 30), forms, length: trimmed.length };
}