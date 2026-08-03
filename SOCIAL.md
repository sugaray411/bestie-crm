# Social content

The CRM can **write, validate, schedule and approve** social posts. It **cannot
publish them to any platform** — no adapter is implemented. This document says
exactly where that line is and what it would take to cross it.

## What works today

| Capability | Status |
| --- | --- |
| Generate on-brand copy per platform (`crm_generate_social_post`) | ✅ |
| Save hand-written copy (`crm_create_social_post`) | ✅ |
| Platform validation — length, media, hashtags | ✅ |
| Truthfulness check on every write | ✅ |
| Schedule (`crm_schedule_social_post`) | ✅ |
| Human approval gate (`crm_approve_social_post`) | ✅ |
| Find what is due (`crm_publish_due_posts`, dry run) | ✅ |
| **Actually post to X / Instagram / TikTok / …** | ❌ **not implemented** |

The practical workflow today: the agent drafts and schedules, a human approves,
then `crm_publish_due_posts` as a dry run hands back the approved copy for
whoever posts it — by hand or by pasting into an existing scheduler.

## Why publishing stops here

Every platform gates write access behind an application review, and some behind
a paid tier. These are procurement decisions with real cost and lead time
attached, not implementation details, so the seam is built and the choice is
left open.

| Platform | What write access requires |
| --- | --- |
| X | A paid API tier for posting |
| Instagram | Business account + Meta app review for `instagram_content_publish` |
| Facebook | Meta app review for `pages_manage_posts` |
| Threads | Meta app review for the Threads API |
| TikTok | Content Posting API approval |
| LinkedIn | Marketing Developer Platform approval |
| YouTube | Google Cloud project, Data API, OAuth consent screen review |

Approvals commonly take weeks — the same shape of delay as A2P 10DLC for SMS.
Start the one you want early.

## Adding a platform

The interface is in `src/channels/social.ts`:

```ts
export interface SocialAdapter {
  readonly platform: SocialPlatform;
  readonly configured: boolean;
  publish(input: SocialPublishInput): Promise<SocialPublishResult>;
}
```

Implement it, return the real adapter from `createSocialAdapters()` instead of
`UnimplementedSocialAdapter`, and everything upstream — drafting, validation,
scheduling, approval, the due query — already works. Nothing else changes.

Credentials belong in `src/config.ts` alongside the other providers, never in
the database.

## Design notes

**Consent does not apply here, and pretending it did would be theatre.**
Consent, suppression and quiet hours govern messages sent to an identified
person. A social post is a broadcast to whoever chose to follow the account.
There is nobody to check consent *for*.

**Truthfulness does apply, unchanged.** `checkCopyTruthfulness` runs on
generated and hand-written posts alike, and a violation is an error rather than
a warning. A claim the product cannot support is a legal problem whether it goes
out by email or by tweet — arguably worse in public.

**Approval is separate from scheduling.** Scheduling a post is not authorization
to publish it. A post publishes only when it is *both* approved and past its
scheduled time, which is the same human-in-the-loop posture bulk sends use. The
reasoning is stronger here: a post is public and effectively permanent.

**Re-validation happens at approval**, not just at creation, because copy may
have been edited in between.

**A post that cannot be published stays `approved` and due**, rather than being
marked `failed`. Missing capability is not a rejected post, and burying
ready-to-go content under a failure status would lose it.
