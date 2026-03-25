/**
 * Session manager — maintains isolated browser contexts per user.
 * Each session has its own cookies, localStorage, and proxy assignment.
 */
import { v4 as uuid } from 'uuid';
import { getBrowser } from './engine.js';
import type { BrowserContext } from 'playwright';

export interface BrowserSession {
  sessionId: string;
  userId: string;
  context: BrowserContext;
  createdAt: Date;
  lastActivity: Date;
  status: 'active' | 'idle' | 'expired';
}

const SESSION_TIMEOUT_MIN = 30;

export class SessionManager {
  private sessions = new Map<string, BrowserSession>();
  private cleanupInterval: ReturnType<typeof setInterval>;

  constructor() {
    // Auto-cleanup idle sessions every minute
    this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
  }

  async create(userId: string): Promise<string> {
    const browser = await getBrowser();
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 720 },
    });

    const sessionId = uuid();
    this.sessions.set(sessionId, {
      sessionId,
      userId,
      context,
      createdAt: new Date(),
      lastActivity: new Date(),
      status: 'active',
    });

    console.log(`[Session] Created ${sessionId} for user ${userId} (total: ${this.sessions.size})`);
    return sessionId;
  }

  get(sessionId: string): BrowserSession | undefined {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastActivity = new Date();
      session.status = 'active';
    }
    return session;
  }

  async destroy(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      await session.context.close().catch(() => {});
      this.sessions.delete(sessionId);
      console.log(`[Session] Destroyed ${sessionId} (total: ${this.sessions.size})`);
    }
  }

  private async cleanup(): Promise<void> {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.lastActivity.getTime() > SESSION_TIMEOUT_MIN * 60_000) {
        console.log(`[Session] Expiring idle session ${id}`);
        await this.destroy(id);
      }
    }
  }

  async shutdownAll(): Promise<void> {
    clearInterval(this.cleanupInterval);
    for (const [id] of this.sessions) {
      await this.destroy(id);
    }
  }
}