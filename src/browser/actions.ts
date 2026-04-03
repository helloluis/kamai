/**
 * Browser actions — interact with a page before extracting content.
 *
 * All click-based actions auto-scroll the element into view and dismiss
 * common overlays (cookie banners, popups) before interacting.
 */
import type { Page } from 'playwright';

export interface BrowseAction {
  action: string;
  selector?: string;
  text?: string;
  value?: string;
  timeout?: number;
  ms?: number;
}

const MAX_ACTIONS = 20;

// ─── Playwright text selector support ───
// Resolve "text=..." selectors to Playwright locators
function isTextSelector(sel: string): boolean {
  return sel.startsWith('text=') || sel.startsWith('text/');
}

async function resolveSelector(page: Page, sel: string, timeout: number = 5000) {
  if (isTextSelector(sel)) {
    const text = sel.replace(/^text[=/]/, '');
    const locator = page.getByText(text, { exact: false });
    await locator.waitFor({ timeout });
    return locator;
  }
  await page.waitForSelector(sel, { timeout });
  return page.locator(sel).first();
}

async function smartClickResolved(page: Page, selector: string, timeout: number = 5000): Promise<string> {
  if (isTextSelector(selector)) {
    const text = selector.replace(/^text[=/]/, '');
    const locator = page.getByText(text, { exact: false });
    await locator.scrollIntoViewIfNeeded();
    await dismissOverlays(page);
    try {
      await locator.click({ timeout });
      return "clicked " + selector;
    } catch {
      await locator.evaluate((el: any) => {
        el.click();
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      });
      return "clicked " + selector + " (via JS fallback)";
    }
  }
  return smartClick(page, selector, timeout);
}


// ─── Overlay dismissal ───

const OVERLAY_SELECTORS = [
  // Cookie consent banners
  '[data-testid="coi-banner-accept-button"]',
  'button[id*="accept"]',
  'button[id*="Accept"]',
  '[class*="cookie"] button[class*="accept"]',
  '[class*="cookie"] button[class*="Accept"]',
  '[class*="consent"] button[class*="accept"]',
  '[class*="CookieBanner"] button',
  '#onetrust-accept-btn-handler',
  '.cc-accept',
  '.cc-dismiss',
  // Generic popup/modal backdrops
  '[data-popup-backdrop]',
  '.popup-backdrop',
];

let overlaysDismissed = false;

async function dismissOverlays(page: Page): Promise<string | null> {
  if (overlaysDismissed) return null;
  overlaysDismissed = true;

  const dismissed = await page.evaluate((selectors: string[]) => {
    const dismissed: string[] = [];
    for (const sel of selectors) {
      const el = document.querySelector(sel) as HTMLElement;
      if (el && el.offsetParent !== null) { // visible
        el.click();
        dismissed.push(sel);
      }
    }
    return dismissed.length > 0 ? dismissed.join(', ') : null;
  }, OVERLAY_SELECTORS);

  if (dismissed) {
    await page.waitForTimeout(500);
  }
  return dismissed;
}

// ─── Smart click: scroll → dismiss overlays → try Playwright click → fallback to JS click ───

async function smartClick(page: Page, selector: string, timeout: number = 5000): Promise<string> {
  // Scroll into view first
  await page.evaluate((sel: string) => {
    const el = document.querySelector(sel);
    if (el) el.scrollIntoView({ behavior: 'instant', block: 'center' });
  }, selector);
  await page.waitForTimeout(200);

  // Dismiss any overlays
  await dismissOverlays(page);

  // Try Playwright's native click (handles focus, events properly)
  try {
    await page.click(selector, { timeout });
    return `clicked ${selector}`;
  } catch {
    // Fallback: JS click (bypasses overlays, viewport issues)
    await page.evaluate((sel: string) => {
      const el = document.querySelector(sel) as HTMLElement;
      if (!el) throw new Error('Element not found: ' + sel);
      el.click();
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    }, selector);
    return `clicked ${selector} (via JS fallback)`;
  }
}

// ─── Universal date picker ───

async function setDate(page: Page, selector: string, dateStr: string): Promise<string> {
  // Parse the target date
  const [year, month, day] = dateStr.split('-').map(Number);
  if (!year || !month || !day) {
    throw new Error('set_date value must be yyyy-mm-dd format');
  }

  const targetDay = day;

  // Check the input type
  const inputType = await page.evaluate((sel: string) => {
    const el = document.querySelector(sel) as HTMLInputElement;
    return el ? { type: el.type, tagName: el.tagName, readOnly: el.readOnly } : null;
  }, selector);

  if (!inputType) throw new Error(`Date input not found: ${selector}`);

  // Strategy 1: Native date input — set value directly
  if (inputType.type === 'date') {
    await page.evaluate(({ sel, val }: { sel: string; val: string }) => {
      const el = document.querySelector(sel) as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      if (setter) setter.call(el, val);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, { sel: selector, val: dateStr });
    return `set date ${dateStr} on ${selector} (native input)`;
  }

  // Strategy 2: Read-only text input (custom date picker) — click to open, navigate calendar
  if (inputType.readOnly || inputType.type === 'text') {
    // Scroll and click to open the picker
    await page.evaluate((sel: string) => {
      const el = document.querySelector(sel) as HTMLElement;
      if (el) {
        el.scrollIntoView({ block: 'center' });
        el.click();
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      }
    }, selector);
    await page.waitForTimeout(1500);

    // Look for a calendar popup and try to navigate to the right month/day
    const calendarResult = await page.evaluate(({ targetDay }: { targetDay: number }) => {
      // Find calendar-like containers
      const calSelectors = [
        '[class*="calendar"]', '[class*="Calendar"]',
        '[class*="datepick"]', '[class*="DatePick"]',
        '[role="dialog"]', '[role="grid"]',
        '.react-datepicker', '.flatpickr-calendar',
        '.MuiCalendarPicker-root', '.MuiDateCalendar-root',
      ];

      let calendar: Element | null = null;
      for (const sel of calSelectors) {
        calendar = document.querySelector(sel);
        if (calendar) break;
      }

      if (!calendar) return { found: false, error: 'No calendar popup detected' };

      // Try to find and click the target day
      // Common patterns: buttons/divs/spans with the day number as text
      const dayCandidates = Array.from(calendar.querySelectorAll('button, div, span, td, a'));
      for (const el of dayCandidates) {
        const text = el.textContent?.trim();
        if (text === String(targetDay) && el.children.length === 0) {
          // Verify this isn't a header, month name, or year
          const parent = el.parentElement;
          const isHeader = parent?.tagName === 'THEAD' || parent?.classList.toString().includes('header');
          if (!isHeader) {
            (el as HTMLElement).click();
            return { found: true, clicked: true, day: targetDay };
          }
        }
      }

      return { found: true, clicked: false, error: 'Calendar found but could not locate day ' + targetDay };
    }, { targetDay });

    if (calendarResult.clicked) {
      await page.waitForTimeout(500);
      return `set date ${dateStr} on ${selector} (clicked day ${targetDay} in calendar)`;
    }

    // Strategy 3: Calendar found but day click failed — try direct value injection
    if (calendarResult.found) {
      // Close the calendar first by clicking elsewhere
      await page.evaluate(() => document.body.click());
      await page.waitForTimeout(300);
    }
  }

  // Strategy 4: Last resort — force-set the value via JS and trigger events
  await page.evaluate(({ sel, val }: { sel: string; val: string }) => {
    const el = document.querySelector(sel) as HTMLInputElement;
    if (!el) return;
    // Try React-compatible value setting
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(el, val);
    else el.value = val;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }, { sel: selector, val: dateStr });

  return `set date ${dateStr} on ${selector} (JS value injection)`;
}

// ─── Action executor ───

export async function executeActions(page: Page, actions: BrowseAction[]): Promise<string[]> {
  const log: string[] = [];

  // Reset overlay dismissal state for new page interactions
  overlaysDismissed = false;

  for (const step of actions.slice(0, MAX_ACTIONS)) {
    const { action, selector, text, value, timeout: waitTimeout, ms } = step;
    try {
      switch (action) {
        case 'type':
          if (!selector || !text) throw new Error('type requires "selector" and "text"');
          {
            const loc = await resolveSelector(page, selector);
            await loc.scrollIntoViewIfNeeded();
            await dismissOverlays(page);
            await loc.fill(text);
          }
          log.push(`typed "${text}" into ${selector}`);
          break;

        case 'click':
          if (!selector) throw new Error('click requires "selector"');
          log.push(await smartClickResolved(page, selector));
          await page.waitForTimeout(500);
          break;

        case 'click_and_wait':
          if (!selector) throw new Error('click_and_wait requires "selector"');
          {
            const loc = await resolveSelector(page, selector);
            await loc.scrollIntoViewIfNeeded();
            await dismissOverlays(page);
            try {
              await Promise.all([
                page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: waitTimeout || 10000 }),
                loc.click().catch(() => loc.evaluate((el: any) => el.click())),
              ]);
              log.push(`clicked ${selector} → navigated to ${page.url()}`);
            } catch (navErr: any) {
              log.push(`clicked ${selector} (no navigation: ${navErr.message})`);
            }
          }
          break;

        case 'submit': {
          const formSelector = selector || 'form';
          try {
            await page.waitForSelector(formSelector, { timeout: 5000 });
            await Promise.all([
              page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: waitTimeout || 10000 }),
              page.evaluate((sel: string) => {
                const form = document.querySelector(sel) as HTMLFormElement | null;
                if (form?.submit) form.submit();
                else throw new Error('Form not found: ' + sel);
              }, formSelector),
            ]);
            log.push(`submitted ${formSelector} → ${page.url()}`);
          } catch (submitErr: any) {
            log.push(`submit ${formSelector} failed: ${submitErr.message}`);
          }
          break;
        }

        case 'evaluate':
          if (!text) throw new Error('evaluate requires "text" (the JS expression)');
          try {
            const evalResult = await page.evaluate(text);
            log.push(`eval: ${JSON.stringify(evalResult)}`.slice(0, 200));
          } catch (evalErr: any) {
            log.push(`eval failed: ${evalErr.message}`);
          }
          break;

        case 'select':
          if (!selector || value === undefined) throw new Error('select requires "selector" and "value"');
          {
            const loc = await resolveSelector(page, selector);
            await loc.scrollIntoViewIfNeeded();
            await dismissOverlays(page);
            await loc.selectOption(value);
          }
          log.push(`selected "${value}" in ${selector}`);
          break;

        case 'wait':
          if (!selector) throw new Error('wait requires "selector"');
          await resolveSelector(page, selector, waitTimeout || 10000);
          log.push(`found ${selector}`);
          break;

        case 'wait_ms':
          await page.waitForTimeout(Math.min(ms || 1000, 5000));
          log.push(`waited ${Math.min(ms || 1000, 5000)}ms`);
          break;

        case 'scroll_to':
          if (!selector) throw new Error('scroll_to requires "selector"');
          await page.evaluate((sel: string) => {
            const el = document.querySelector(sel);
            if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }, selector);
          await page.waitForTimeout(500);
          log.push(`scrolled to ${selector}`);
          break;

        case 'js_click':
          if (!selector) throw new Error('js_click requires "selector"');
          await page.evaluate((sel: string) => {
            const el = document.querySelector(sel) as HTMLElement;
            if (!el) throw new Error('Element not found: ' + sel);
            el.scrollIntoView({ block: 'center' });
            el.click();
            el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
          }, selector);
          await page.waitForTimeout(300);
          log.push(`js_clicked ${selector}`);
          break;

        case 'set_date':
          if (!selector || !value) throw new Error('set_date requires "selector" and "value" (yyyy-mm-dd)');
          log.push(await setDate(page, selector, value));
          break;

        default:
          log.push(`unknown action: ${action}`);
      }
    } catch (err: any) {
      log.push(`${action} ${selector || ''} failed: ${err.message}`);
    }
  }

  return log;
}