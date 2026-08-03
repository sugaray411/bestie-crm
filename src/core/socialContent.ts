import { checkCopyTruthfulness, type CopyViolation } from './compliance.js';

/**
 * Platform rules for social posts. Pure, so every limit is testable without
 * touching a network or a platform SDK.
 *
 * Note what is deliberately absent: consent, suppression and quiet hours. Those
 * govern messages sent to an identified person. A social post is a broadcast to
 * whoever chose to follow the account, so applying them would be theatre.
 * Truthfulness is the guardrail that does carry over, unchanged.
 */

export const SOCIAL_PLATFORMS = [
  'x',
  'instagram',
  'tiktok',
  'linkedin',
  'facebook',
  'threads',
  'youtube',
] as const;
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];

export const SOCIAL_POST_STATUSES = [
  'draft',
  'scheduled',
  'approved',
  'published',
  'failed',
  'cancelled',
] as const;
export type SocialPostStatus = (typeof SOCIAL_POST_STATUSES)[number];

export interface PlatformRules {
  /** Maximum body length the platform accepts. */
  maxLength: number;
  /** Posting without media is impossible on some platforms. */
  requiresMedia: boolean;
  maxMedia: number;
  /** Above this, hashtag stuffing starts reading as spam to both people and ranking. */
  softHashtagLimit: number;
  label: string;
}

export const PLATFORM_RULES: Record<SocialPlatform, PlatformRules> = {
  x: { maxLength: 280, requiresMedia: false, maxMedia: 4, softHashtagLimit: 3, label: 'X' },
  instagram: { maxLength: 2200, requiresMedia: true, maxMedia: 10, softHashtagLimit: 15, label: 'Instagram' },
  tiktok: { maxLength: 2200, requiresMedia: true, maxMedia: 1, softHashtagLimit: 8, label: 'TikTok' },
  linkedin: { maxLength: 3000, requiresMedia: false, maxMedia: 9, softHashtagLimit: 5, label: 'LinkedIn' },
  facebook: { maxLength: 63206, requiresMedia: false, maxMedia: 10, softHashtagLimit: 5, label: 'Facebook' },
  threads: { maxLength: 500, requiresMedia: false, maxMedia: 10, softHashtagLimit: 3, label: 'Threads' },
  youtube: { maxLength: 5000, requiresMedia: true, maxMedia: 1, softHashtagLimit: 8, label: 'YouTube' },
};

export interface SocialPostInput {
  platform: SocialPlatform;
  body: string;
  mediaUrls?: readonly string[];
}

export interface SocialValidation {
  ok: boolean;
  /** Hard problems: the post cannot be published as-is. */
  errors: string[];
  /** Worth a human's attention, but not blocking. */
  warnings: string[];
  truthfulnessViolations: CopyViolation[];
  characterCount: number;
  hashtagCount: number;
}

const HASHTAG = /(^|\s)#[\p{L}\p{N}_]+/gu;

export function countHashtags(body: string): number {
  return [...body.matchAll(HASHTAG)].length;
}

/**
 * Validates a post against its platform's rules and the brand truth rules.
 * Untruthful copy is an error, not a warning -- a claim the product cannot
 * back is a legal problem whether it goes out by email or by tweet.
 */
export function validateSocialPost(input: SocialPostInput): SocialValidation {
  const rules = PLATFORM_RULES[input.platform];
  const errors: string[] = [];
  const warnings: string[] = [];
  const media = input.mediaUrls ?? [];

  const characterCount = [...input.body].length;
  if (input.body.trim().length === 0) {
    errors.push('Post body is empty.');
  }
  if (characterCount > rules.maxLength) {
    errors.push(
      `${rules.label} allows ${rules.maxLength} characters; this post is ${characterCount}.`,
    );
  }

  if (rules.requiresMedia && media.length === 0) {
    errors.push(`${rules.label} cannot publish a text-only post — attach at least one image or video.`);
  }
  if (media.length > rules.maxMedia) {
    errors.push(`${rules.label} accepts at most ${rules.maxMedia} media item(s); this post has ${media.length}.`);
  }
  for (const url of media) {
    if (!/^https?:\/\//i.test(url)) {
      errors.push(`Media URL must be http(s): "${url.slice(0, 60)}".`);
    }
  }

  const hashtagCount = countHashtags(input.body);
  if (hashtagCount > rules.softHashtagLimit) {
    warnings.push(
      `${hashtagCount} hashtags is above the ${rules.softHashtagLimit} that reads naturally on ${rules.label}.`,
    );
  }

  // Near the limit, platforms truncate in the feed rather than rejecting.
  if (characterCount > rules.maxLength * 0.9 && characterCount <= rules.maxLength) {
    warnings.push(`Close to the ${rules.label} limit — the feed may truncate the tail.`);
  }

  const truthfulness = checkCopyTruthfulness(input.body);

  return {
    ok: errors.length === 0 && truthfulness.ok,
    errors,
    warnings,
    truthfulnessViolations: truthfulness.violations,
    characterCount,
    hashtagCount,
  };
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

export interface SchedulablePost {
  id: string;
  status: SocialPostStatus;
  scheduled_at: Date | string | null;
}

/**
 * A post publishes only when it is approved AND its time has come. Scheduling
 * alone is not authorization: a draft that was scheduled but never approved
 * stays put, which is the same human-in-the-loop posture bulk sends use.
 */
export function isDue(post: SchedulablePost, now: Date): boolean {
  if (post.status !== 'approved') return false;
  if (post.scheduled_at === null) return false;
  const at = post.scheduled_at instanceof Date ? post.scheduled_at : new Date(post.scheduled_at);
  if (Number.isNaN(at.getTime())) return false;
  return at.getTime() <= now.getTime();
}

export function selectDuePosts<T extends SchedulablePost>(posts: readonly T[], now: Date): T[] {
  return posts.filter((p) => isDue(p, now));
}

/** Scheduling into the past would publish immediately, which is never intended. */
export function validateScheduleTime(
  scheduledAt: string,
  now: Date,
): { ok: boolean; reason?: string } {
  const at = new Date(scheduledAt);
  if (Number.isNaN(at.getTime())) return { ok: false, reason: `"${scheduledAt}" is not a valid timestamp.` };
  if (at.getTime() <= now.getTime()) {
    return { ok: false, reason: 'Scheduled time is in the past. Publish now explicitly if that is the intent.' };
  }
  const twoYears = now.getTime() + 730 * 24 * 60 * 60 * 1000;
  if (at.getTime() > twoYears) {
    return { ok: false, reason: 'Scheduled time is more than two years out; that is almost always a typo.' };
  }
  return { ok: true };
}
