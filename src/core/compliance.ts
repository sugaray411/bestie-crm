import type { Channel, ConsentBasis } from '../types.js';

/**
 * Compliance rules expressed as code, not as prompt text. Everything here is
 * pure so the guardrails can be tested exhaustively without a network or a DB.
 */

// ---------------------------------------------------------------------------
// Quiet hours (§7.6)
// ---------------------------------------------------------------------------

export interface QuietHourResult {
  quiet: boolean;
  localHour: number;
  timezone: string;
}

/**
 * Resolves the contact's local hour with Intl rather than a fixed offset, so DST
 * is handled by the platform's tz database instead of by us.
 */
export function isQuietHour(
  now: Date,
  timezone: string | null | undefined,
  startHour: number,
  endHour: number,
): QuietHourResult {
  const tz = timezone && timezone.trim() !== '' ? timezone : 'UTC';
  const localHour = hourInTimezone(now, tz);
  // The sending window is [start, end): 09:00-20:00 means a 20:15 send is quiet.
  const inWindow =
    startHour <= endHour
      ? localHour >= startHour && localHour < endHour
      : localHour >= startHour || localHour < endHour; // window wrapping midnight
  return { quiet: !inWindow, localHour, timezone: tz };
}

export function hourInTimezone(now: Date, timezone: string): number {
  try {
    const formatted = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      hour12: false,
    }).format(now);
    const hour = Number.parseInt(formatted, 10);
    // Some ICU builds render midnight as "24".
    return Number.isFinite(hour) ? hour % 24 : now.getUTCHours();
  } catch {
    // An unknown tz string must not become a licence to send at any hour.
    return now.getUTCHours();
  }
}

// ---------------------------------------------------------------------------
// CAN-SPAM / TCPA message furniture (§7.3)
// ---------------------------------------------------------------------------

export interface EmailComplianceInput {
  body: string;
  unsubscribeUrl: string;
  physicalAddress: string;
}

export interface ComplianceCheck {
  ok: boolean;
  issues: string[];
}

export function checkEmailCompliance(input: EmailComplianceInput): ComplianceCheck {
  const issues: string[] = [];
  if (!input.unsubscribeUrl || !/^https?:\/\//i.test(input.unsubscribeUrl)) {
    issues.push('Email requires a working unsubscribe URL (CAN-SPAM). Set UNSUBSCRIBE_BASE_URL.');
  } else if (!input.body.includes(input.unsubscribeUrl)) {
    issues.push('Rendered email body does not contain the unsubscribe link.');
  }
  if (!input.physicalAddress.trim()) {
    issues.push('Email requires a physical mailing address (CAN-SPAM). Set SENDER_PHYSICAL_ADDRESS.');
  } else if (!input.body.includes(input.physicalAddress.trim())) {
    issues.push('Rendered email body does not contain the sender physical address.');
  }
  return { ok: issues.length === 0, issues };
}

/** Appends the legally required footer unless the template already carries it. */
export function ensureEmailFooter(
  body: string,
  unsubscribeUrl: string,
  physicalAddress: string,
): string {
  let out = body;
  if (unsubscribeUrl && !out.includes(unsubscribeUrl)) {
    out += `\n\n---\nDon't want these? Unsubscribe: ${unsubscribeUrl}`;
  }
  const address = physicalAddress.trim();
  if (address && !out.includes(address)) {
    out += `\n${address}`;
  }
  return out;
}

const STOP_NOTICE = 'Reply STOP to opt out.';
const STOP_PRESENT = /\bstop\b/i;

export function ensureSmsStopNotice(body: string): string {
  return STOP_PRESENT.test(body) ? body : `${body.trimEnd()} ${STOP_NOTICE}`;
}

export function checkSmsCompliance(body: string): ComplianceCheck {
  const issues: string[] = [];
  if (!STOP_PRESENT.test(body)) {
    issues.push('SMS must tell the recipient how to opt out ("Reply STOP to opt out").');
  }
  return { ok: issues.length === 0, issues };
}

/** Inbound keywords that must revoke consent immediately (TCPA). */
const STOP_KEYWORDS = new Set([
  'stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'stop all', 'optout', 'opt out',
]);

export function isStopKeyword(inbound: string): boolean {
  return STOP_KEYWORDS.has(inbound.trim().toLowerCase().replace(/[.!]+$/, ''));
}

export function applyChannelFurniture(
  channel: Channel,
  body: string,
  opts: { unsubscribeUrl: string; physicalAddress: string },
): string {
  if (channel === 'email') return ensureEmailFooter(body, opts.unsubscribeUrl, opts.physicalAddress);
  if (channel === 'sms') return ensureSmsStopNotice(body);
  return body;
}

// ---------------------------------------------------------------------------
// Truthful advertising (§7.10 / §1b)
// ---------------------------------------------------------------------------

export interface CopyViolation {
  rule: string;
  detail: string;
  match: string;
}

/**
 * The claims AI Bestie cannot make. These encode §1b: chat really is free and
 * unlimited, video/voice really are metered on the free tier, and Bestie is not
 * a licensed professional. Copy that gets any of that wrong is a legal problem,
 * not a style problem -- so this rejects rather than rewrites.
 */
const COPY_RULES: Array<{ rule: string; pattern: RegExp; detail: string }> = [
  {
    rule: 'no-unlimited-free-video',
    pattern: /\b(unlimited|endless|no\s*limits?\s*(on|to)?)\s+(free\s+)?(video|camera)\b|\b(free)\s+(unlimited\s+)?(video|camera)\s+call(s)?\s+(forever|always|unlimited)\b/i,
    detail:
      'Free video/camera time is capped at 10 minutes per day (voice at 5). Say "try it free", never "unlimited free video".',
  },
  {
    rule: 'no-unlimited-free-voice',
    pattern: /\bunlimited\s+(free\s+)?voice\s+call/i,
    detail: 'Free voice calling is a 5-minute daily budget; Pro removes the limit.',
  },
  {
    rule: 'no-fabricated-testimonials',
    pattern: /\b(\d[\d,]*\s+(five[- ]star|5[- ]star)\s+reviews?|rated\s+#?1\b|award[- ]winning|voted\s+best)\b/i,
    detail: 'No social proof we have not actually earned and cannot substantiate.',
  },
  {
    rule: 'no-fake-scarcity',
    pattern: /\b(only\s+\d+\s+(spots?|seats?|licen[cs]es?)\s+(left|remaining)|offer\s+ends\s+in\s+\d+\s+minutes?|last\s+chance\s+ever|while\s+supplies\s+last)\b/i,
    detail: 'No invented deadlines or scarcity. A real, dated promotion is fine; a fake one is not.',
  },
  {
    rule: 'no-professional-claims',
    pattern: /\b(medical|legal|financial)\s+advice\b|\b(diagnos(e|es|is)|cures?|treats?)\s+(your|any|the)\b|\bdoctor[- ]approved\b|\breplaces?\s+(your\s+)?(doctor|lawyer|therapist)\b/i,
    detail:
      'Bestie assists; she is not a licensed professional. No diagnostic, curative, legal or financial-advice claims.',
  },
  {
    rule: 'no-guarantees',
    pattern: /\b(guaranteed|100%\s+(accurate|correct|effective)|never\s+wrong|always\s+right)\b/i,
    detail: 'No accuracy or outcome guarantees for an AI assistant.',
  },
  {
    rule: 'no-privacy-contradiction',
    pattern: /\b(we\s+(sell|share|monetize)\s+your\s+data|sell\s+your\s+(data|information))\b/i,
    detail: 'Contradicts the product promise: we do not collect or sell user data.',
  },
];

export function checkCopyTruthfulness(copy: string): { ok: boolean; violations: CopyViolation[] } {
  const violations: CopyViolation[] = [];
  for (const rule of COPY_RULES) {
    const match = rule.pattern.exec(copy);
    if (match) {
      violations.push({ rule: rule.rule, detail: rule.detail, match: match[0] });
    }
  }
  return { ok: violations.length === 0, violations };
}

// ---------------------------------------------------------------------------
// Import lawfulness (§7.4)
// ---------------------------------------------------------------------------

export interface ImportBasisInput {
  basis: ConsentBasis;
  source: string;
  contactCount: number;
  /** Free-text attestation of where the consent came from. */
  attestation?: string;
}

export interface ImportBasisResult {
  ok: boolean;
  needsHumanReview: boolean;
  reasons: string[];
}

/** Sources that are never lawful for us, regardless of what basis is claimed. */
const FORBIDDEN_SOURCE = /\b(purchas|bought|buy|scrap|crawl|harvest|list\s*brok|lead\s*vendor|data\s*brok|rented\s*list|appended)\w*/i;

export function validateImportBasis(input: ImportBasisInput): ImportBasisResult {
  const reasons: string[] = [];
  const haystack = `${input.source} ${input.attestation ?? ''}`;

  const forbidden = FORBIDDEN_SOURCE.exec(haystack);
  if (forbidden) {
    return {
      ok: false,
      needsHumanReview: false,
      reasons: [
        `Rejected: the stated source describes a purchased, rented, scraped or appended list ("${forbidden[0]}"). ` +
          'Only contacts who gave us consent directly may enter the CRM (§7.4, §11).',
      ],
    };
  }

  if (!input.source.trim()) {
    reasons.push('A concrete source is required (e.g. "website signup form", "in-app opt-in").');
  }
  if (!input.attestation || input.attestation.trim().length < 12) {
    reasons.push('An attestation describing how and when consent was collected is required.');
  }

  if (reasons.length > 0) {
    return { ok: false, needsHumanReview: false, reasons };
  }

  // A large import on anything weaker than a direct opt-in is exactly the shape
  // a bought list takes when it is described politely, so a human looks at it.
  const needsHumanReview = input.contactCount > 500 && input.basis !== 'opt_in';
  return {
    ok: true,
    needsHumanReview,
    reasons: needsHumanReview
      ? [
          `${input.contactCount} contacts on basis "${input.basis}" rather than a direct opt-in. ` +
            'Flagged for human review before any send.',
        ]
      : [],
  };
}

// ---------------------------------------------------------------------------
// Instruction-override refusal (§7 closing paragraph)
// ---------------------------------------------------------------------------

const OVERRIDE_PATTERNS: Array<{ rule: string; pattern: RegExp }> = [
  { rule: 'bypass-consent', pattern: /\b(ignore|skip|bypass|disable|turn\s+off|override)\b[^.]{0,40}\b(consent|opt[- ]?in|permission)/i },
  { rule: 'bypass-suppression', pattern: /\b(ignore|skip|bypass|disable|remove\s+from|clear)\b[^.]{0,40}\b(suppression|unsubscrib\w*|do[- ]not[- ]contact)/i },
  { rule: 'bypass-unsubscribe', pattern: /\b(without|no|omit|remove|drop)\b[^.]{0,30}\bunsubscribe\s+(link|footer)/i },
  { rule: 'bypass-quiet-hours', pattern: /\b(ignore|bypass|regardless\s+of|disable)\b[^.]{0,30}\bquiet\s+hours/i },
  { rule: 'bypass-approval', pattern: /\b(skip|bypass|without)\b[^.]{0,30}\b(human\s+)?(approval|review|confirmation)/i },
  { rule: 'fabricate-proof', pattern: /\b(make\s+up|fabricate|invent|generate\s+fake)\b[^.]{0,30}\b(testimonial|review|quote|statistic|scarcity)/i },
];

/**
 * Detects an attempt -- from a user prompt or from data that came back out of a
 * record -- to talk the server out of its guardrails. Callers refuse and surface
 * the conflict rather than silently complying.
 */
export function detectGuardrailOverride(text: string): { attempted: boolean; rules: string[] } {
  const rules = OVERRIDE_PATTERNS.filter((p) => p.pattern.test(text)).map((p) => p.rule);
  return { attempted: rules.length > 0, rules };
}
