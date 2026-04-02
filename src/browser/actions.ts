/**
 * Browser actions — interact with a page before extracting content.
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

export async function executeActions(page: Page, actions: BrowseAction[]): Promise<string[]> {
  const log: string[] = [];

  for (const step of actions.slice(0, MAX_ACTIONS)) {
    const { action, selector, text, value, timeout: waitTimeout, ms } = step;
    try {
      switch (action) {
        case 'type':
          if (!selector || !text) throw new Error('type requires "selector" and "text"');
          await page.waitForSelector(selector, { timeout: 5000 });
          await page.fill(selector, text);
          log.push(`typed "${text}" into ${selector}`);
          break;

        case 'click':
          if (!selector) throw new Error('click requires "selector"');
          await page.waitForSelector(selector, { timeout: 5000 });
          await page.click(selector);
          await page.waitForTimeout(500);
          log.push(`clicked ${selector}`);
          break;

        case 'click_and_wait':
          if (!selector) throw new Error('click_and_wait requires "selector"');
          await page.waitForSelector(selector, { timeout: 5000 });
          try {
            await Promise.all([
              page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: waitTimeout || 10000 }),
              page.click(selector),
            ]);
            log.push(`clicked ${selector} → navigated to ${page.url()}`);
          } catch (navErr: any) {
            log.push(`clicked ${selector} (no navigation: ${navErr.message})`);
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
          await page.waitForSelector(selector, { timeout: 5000 });
          await page.selectOption(selector, value);
          log.push(`selected "${value}" in ${selector}`);
          break;

        case 'wait':
          if (!selector) throw new Error('wait requires "selector"');
          await page.waitForSelector(selector, { timeout: waitTimeout || 10000 });
          log.push(`found ${selector}`);
          break;

        case 'wait_ms':
          await page.waitForTimeout(Math.min(ms || 1000, 5000));
          log.push(`waited ${Math.min(ms || 1000, 5000)}ms`);
          break;

        case 'scroll_to':
          if (!selector) throw new Error('scroll_to requires "selector"');
          await page.evaluate((sel) => {
            const el = document.querySelector(sel);
            if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }, selector);
          await page.waitForTimeout(500);
          log.push(`scrolled to ${selector}`);
          break;

        case 'js_click':
          // Force-click via JavaScript — bypasses overlays, viewport checks, and pointer interception
          if (!selector) throw new Error('js_click requires "selector"');
          await page.evaluate((sel) => {
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

        default:
          log.push(`unknown action: ${action}`);
      }
    } catch (err: any) {
      log.push(`${action} ${selector || ''} failed: ${err.message}`);
    }
  }

  return log;
}