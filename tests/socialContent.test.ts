import { describe, expect, it } from 'vitest';
import {
  countHashtags,
  isDue,
  PLATFORM_RULES,
  selectDuePosts,
  validateScheduleTime,
  validateSocialPost,
} from '../src/core/socialContent.js';

const NOW = new Date('2026-03-10T12:00:00Z');

describe('validateSocialPost', () => {
  it('accepts an honest, in-limit post', () => {
    const result = validateSocialPost({
      platform: 'x',
      body: 'Point your camera at the leaking pipe and Bestie talks you through the fix. Chat is free, always.',
    });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects a post over the platform limit', () => {
    const result = validateSocialPost({ platform: 'x', body: 'a'.repeat(281) });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/280 characters; this post is 281/);
  });

  it('counts characters by code point, not UTF-16 unit', () => {
    // Emoji are surrogate pairs: .length would double-count them.
    const body = '🎥'.repeat(100);
    expect(validateSocialPost({ platform: 'x', body }).characterCount).toBe(100);
  });

  it('rejects an empty post', () => {
    expect(validateSocialPost({ platform: 'x', body: '   ' }).errors).toContain('Post body is empty.');
  });

  it('requires media on Instagram and TikTok', () => {
    for (const platform of ['instagram', 'tiktok'] as const) {
      const result = validateSocialPost({ platform, body: 'A caption with no image.' });
      expect(result.ok).toBe(false);
      expect(result.errors.join(' ')).toMatch(/cannot publish a text-only post/);
    }
  });

  it('accepts Instagram once media is attached', () => {
    const result = validateSocialPost({
      platform: 'instagram',
      body: 'Show her the problem.',
      mediaUrls: ['https://cdn.example.com/a.jpg'],
    });
    expect(result.ok).toBe(true);
  });

  it('does not require media on text-first platforms', () => {
    expect(validateSocialPost({ platform: 'x', body: 'Just text.' }).ok).toBe(true);
    expect(validateSocialPost({ platform: 'linkedin', body: 'Just text.' }).ok).toBe(true);
  });

  it('enforces the per-platform media cap', () => {
    const media = Array.from({ length: 5 }, (_, i) => `https://cdn.example.com/${i}.jpg`);
    const result = validateSocialPost({ platform: 'x', body: 'Four max.', mediaUrls: media });
    expect(result.errors.join(' ')).toMatch(/at most 4 media/);
  });

  it('rejects a non-http media URL', () => {
    const result = validateSocialPost({
      platform: 'instagram',
      body: 'Caption',
      mediaUrls: ['javascript:alert(1)'],
    });
    expect(result.errors.join(' ')).toMatch(/must be http/);
  });

  it('rejects untruthful copy as an error, not a warning', () => {
    const result = validateSocialPost({
      platform: 'x',
      body: 'Unlimited free video calls with your AI bestie, forever!',
    });
    expect(result.ok).toBe(false);
    expect(result.truthfulnessViolations.map((v) => v.rule)).toContain('no-unlimited-free-video');
  });

  it('still allows the true unlimited-chat claim', () => {
    const result = validateSocialPost({ platform: 'x', body: 'Unlimited free chat with Bestie, forever.' });
    expect(result.ok).toBe(true);
  });

  it('warns about hashtag stuffing without blocking', () => {
    const result = validateSocialPost({
      platform: 'x',
      body: 'Bestie helps #ai #aiassistant #help #tech #app #mobile',
    });
    expect(result.ok).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/hashtags/);
  });

  it('warns when close to the limit', () => {
    const result = validateSocialPost({ platform: 'x', body: 'a'.repeat(275) });
    expect(result.ok).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/truncate/);
  });
});

describe('countHashtags', () => {
  it('counts hashtags at the start and after whitespace', () => {
    expect(countHashtags('#one and #two')).toBe(2);
  });

  it('does not count a mid-word hash', () => {
    expect(countHashtags('issue#123 filed')).toBe(0);
  });

  it('counts non-latin hashtags', () => {
    expect(countHashtags('#日本語 #ok')).toBe(2);
  });
});

describe('isDue', () => {
  const base = { id: 'p1', scheduled_at: '2026-03-10T11:00:00Z' };

  it('is due when approved and the time has passed', () => {
    expect(isDue({ ...base, status: 'approved' }, NOW)).toBe(true);
  });

  it('is not due when merely scheduled — approval is a separate gate', () => {
    expect(isDue({ ...base, status: 'scheduled' }, NOW)).toBe(false);
    expect(isDue({ ...base, status: 'draft' }, NOW)).toBe(false);
  });

  it('is not due before its time', () => {
    expect(isDue({ id: 'p', status: 'approved', scheduled_at: '2026-03-10T13:00:00Z' }, NOW)).toBe(false);
  });

  it('is not due with no scheduled time', () => {
    expect(isDue({ id: 'p', status: 'approved', scheduled_at: null }, NOW)).toBe(false);
  });

  it('never republishes something already published', () => {
    expect(isDue({ ...base, status: 'published' }, NOW)).toBe(false);
  });

  it('ignores a cancelled post whose time has passed', () => {
    expect(isDue({ ...base, status: 'cancelled' }, NOW)).toBe(false);
  });

  it('treats an unparseable timestamp as not due rather than publishing it', () => {
    expect(isDue({ id: 'p', status: 'approved', scheduled_at: 'soon' }, NOW)).toBe(false);
  });
});

describe('selectDuePosts', () => {
  it('returns only the approved, past-due posts', () => {
    const posts = [
      { id: 'a', status: 'approved' as const, scheduled_at: '2026-03-10T11:00:00Z' },
      { id: 'b', status: 'scheduled' as const, scheduled_at: '2026-03-10T11:00:00Z' },
      { id: 'c', status: 'approved' as const, scheduled_at: '2026-03-11T11:00:00Z' },
      { id: 'd', status: 'approved' as const, scheduled_at: '2026-03-09T11:00:00Z' },
    ];
    expect(selectDuePosts(posts, NOW).map((p) => p.id)).toEqual(['a', 'd']);
  });
});

describe('validateScheduleTime', () => {
  it('accepts a near-future time', () => {
    expect(validateScheduleTime('2026-03-10T18:00:00Z', NOW).ok).toBe(true);
  });

  it('rejects a past time', () => {
    const result = validateScheduleTime('2026-03-09T18:00:00Z', NOW);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/in the past/);
  });

  it('rejects an implausibly distant time', () => {
    const result = validateScheduleTime('2035-01-01T00:00:00Z', NOW);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/two years/);
  });

  it('rejects an unparseable time', () => {
    expect(validateScheduleTime('next tuesday', NOW).ok).toBe(false);
  });
});

describe('PLATFORM_RULES', () => {
  it('gives every platform a positive length limit and media cap', () => {
    for (const [platform, rules] of Object.entries(PLATFORM_RULES)) {
      expect(rules.maxLength, platform).toBeGreaterThan(0);
      expect(rules.maxMedia, platform).toBeGreaterThan(0);
      expect(rules.label, platform).toBeTruthy();
    }
  });
});
