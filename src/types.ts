export const CHANNELS = ['email', 'sms', 'push'] as const;
export type Channel = (typeof CHANNELS)[number];

export const CONSENT_STATUSES = ['granted', 'revoked'] as const;
export type ConsentStatus = (typeof CONSENT_STATUSES)[number];

/** Lawful bases we accept. There is deliberately no "purchased" or "scraped". */
export const CONSENT_BASES = ['opt_in', 'referral', 'existing_customer'] as const;
export type ConsentBasis = (typeof CONSENT_BASES)[number];

export const LIFECYCLE_STAGES = ['lead', 'trial', 'active', 'churned'] as const;
export type LifecycleStage = (typeof LIFECYCLE_STAGES)[number];

export const SUPPRESSION_REASONS = ['unsubscribe', 'bounce', 'complaint', 'manual'] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

export const EVENT_TYPES = [
  'visit',
  'signup',
  'trial_start',
  'subscribe',
  'cancel',
  'open',
  'click',
  'referral_sent',
  'referral_converted',
  'video_call_used',
  'chat_used',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const SKIP_REASONS = [
  'skipped_no_consent',
  'skipped_suppressed',
  'skipped_quiet_hours',
  'skipped_frequency_cap',
  'skipped_rate_limit',
  'skipped_no_address',
  'skipped_region_requires_opt_in',
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

export const MESSAGE_STATUSES = [
  'queued',
  'sent',
  'delivered',
  'opened',
  'clicked',
  'bounced',
  'failed',
  ...SKIP_REASONS,
] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

export const CAMPAIGN_STATUSES = [
  'draft',
  'scheduled',
  'sending',
  'paused',
  'sent',
  'failed',
] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export interface Contact {
  id: string;
  email: string | null;
  phone: string | null;
  push_token: string | null;
  name: string | null;
  source: string | null;
  locale: string | null;
  country: string | null;
  timezone: string | null;
  tags: string[];
  lifecycle_stage: LifecycleStage;
  rc_app_user_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface ConsentRecord {
  channel: Channel;
  status: ConsentStatus;
  basis: ConsentBasis;
  ts: Date | string;
}

export interface Template {
  id: string;
  channel: Channel;
  name: string;
  subject: string | null;
  body: string;
  variables: string[];
  created_at: Date;
}

export interface Campaign {
  id: string;
  name: string;
  channel: Channel;
  template_id: string | null;
  segment_id: string | null;
  status: CampaignStatus;
  scheduled_at: Date | null;
  dry_run: boolean;
  pause_reason: string | null;
  created_by: string | null;
  created_at: Date;
}
