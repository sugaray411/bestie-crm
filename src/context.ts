import type { Config } from './config.js';
import type { Db } from './db/pool.js';
import type { ChannelAdapter } from './channels/types.js';
import type { Channel } from './types.js';
import { createEmailAdapter } from './channels/email.js';
import { createSmsAdapter } from './channels/sms.js';
import { createPushAdapter } from './channels/push.js';
import { ChannelRateLimiter } from './core/rateLimiter.js';
import { CopyEngine } from './core/copygen.js';
import { createSocialAdapters, type SocialAdapter } from './channels/social.js';
import type { SocialPlatform } from './core/socialContent.js';

/** Everything the tools need, assembled once at boot. */
export interface ServerContext {
  db: Db;
  config: Config;
  adapters: Record<Channel, ChannelAdapter>;
  socialAdapters: Record<SocialPlatform, SocialAdapter>;
  rateLimiter: ChannelRateLimiter;
  copy: CopyEngine;
  /** Injectable so tests can pin time. */
  now: () => Date;
}

export function createContext(db: Db, config: Config, now: () => Date = () => new Date()): ServerContext {
  return {
    db,
    config,
    now,
    adapters: {
      email: createEmailAdapter(config),
      sms: createSmsAdapter(config),
      push: createPushAdapter(config),
    },
    socialAdapters: createSocialAdapters(),
    rateLimiter: new ChannelRateLimiter(config.guardrails.sendRatePerMinute, now),
    copy: new CopyEngine({ apiKey: config.anthropicApiKey, model: config.copyModel }),
  };
}
