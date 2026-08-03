import type { SocialPlatform } from '../core/socialContent.js';

/**
 * Publishing adapters, one per platform, behind a single interface.
 *
 * None are implemented yet, and that is a deliberate stopping point rather than
 * an oversight: every platform gates write access behind an app review that
 * takes weeks and, on some, a paid API tier. Which platforms to pursue is a
 * business decision with real cost attached, so the seam is here and the
 * decision is not made for you. See SOCIAL.md.
 */

export interface SocialPublishInput {
  platform: SocialPlatform;
  body: string;
  mediaUrls: string[];
  /** The connected account's platform-side identifier. */
  accountExternalId: string | null;
}

export interface SocialPublishResult {
  status: 'published' | 'failed';
  externalPostId?: string;
  externalUrl?: string;
  error?: string;
}

export interface SocialAdapter {
  readonly platform: SocialPlatform;
  /** False until real credentials and a review-approved app exist. */
  readonly configured: boolean;
  publish(input: SocialPublishInput): Promise<SocialPublishResult>;
}

/** What every platform resolves to until an adapter is actually built. */
export class UnimplementedSocialAdapter implements SocialAdapter {
  readonly configured = false;
  constructor(
    readonly platform: SocialPlatform,
    private readonly requirement: string,
  ) {}

  async publish(): Promise<SocialPublishResult> {
    return {
      status: 'failed',
      error:
        `No publishing adapter for ${this.platform}. ${this.requirement} ` +
        'Until then, use crm_publish_due_posts as a dry run to get the approved copy and post it by hand.',
    };
  }
}

const REQUIREMENTS: Record<SocialPlatform, string> = {
  x: 'X requires a paid API tier for write access.',
  instagram: 'Instagram publishing requires a Business account and Meta app review for instagram_content_publish.',
  tiktok: 'TikTok requires Content Posting API approval.',
  linkedin: 'LinkedIn requires Marketing Developer Platform approval.',
  facebook: 'Facebook Page publishing requires Meta app review for pages_manage_posts.',
  threads: 'Threads publishing requires Meta app review for the Threads API.',
  youtube: 'YouTube requires a Google Cloud project with the Data API and OAuth consent screen approval.',
};

export function createSocialAdapters(): Record<SocialPlatform, SocialAdapter> {
  const adapters = {} as Record<SocialPlatform, SocialAdapter>;
  for (const platform of Object.keys(REQUIREMENTS) as SocialPlatform[]) {
    adapters[platform] = new UnimplementedSocialAdapter(platform, REQUIREMENTS[platform]);
  }
  return adapters;
}
