import Anthropic from '@anthropic-ai/sdk';
import type { Channel } from '../types.js';
import { checkCopyTruthfulness, detectGuardrailOverride, type CopyViolation } from './compliance.js';

/**
 * The copy engine. Everything the model is told about AI Bestie lives here, and
 * whatever it produces is run back through the same truthfulness checker that
 * guards hand-written templates -- the prompt is guidance, the checker is the
 * guarantee.
 */

export const BRAND_BRIEF = `You write marketing copy for **AI Bestie**, a privacy-first mobile AI companion (iOS + Android).

LEAD WITH THIS — the flagship feature:
- **Live video call, "Bestie's eye".** On a call the user points their camera at a real problem and Bestie
  SEES it and talks them through solving it in real time: a leaking pipe, a form to fill out, a recipe,
  homework, a rash, an error on a screen, "what is this plant", "which cable goes where".
  This is the differentiator against text-only assistants. It belongs in the first line, not the third.

SECOND HOOK — the top-of-funnel offer:
- **Text chat with Bestie is free and unlimited, forever.** Only paid-API extras are Pro: premium voices,
  image generation, live web browsing.

SUPPORTING:
- Voice calls, and a warm memory that remembers what matters to the user.
- Privacy-first: we do not collect or sell user data.
- Bestie Pro is $9.99/month.
- There is a refer-a-friend program: the referrer earns 1 month of Pro when their friend actually subscribes.

TRUTH CONSTRAINTS — these are legal requirements, not style preferences:
- Chat: free and unlimited. TRUE, say it plainly.
- Video/camera-during-calls: free users get 10 minutes PER DAY. Voice calls: 5 minutes per day free.
  Pro removes both limits. You may write "try it free" or "free to try every day".
  You may NEVER write "unlimited free video", "unlimited free calls", or anything implying the free
  video/voice tiers are uncapped.
- Never invent testimonials, review counts, ratings, awards, or user numbers.
- Never invent scarcity or deadlines ("only 3 spots left", "offer ends in 10 minutes").
- Bestie assists; she is NOT a licensed professional. No medical, legal or financial advice claims,
  no diagnosing, curing or treating, no "doctor approved", no guarantees of accuracy.
- Never contradict the privacy promise.

VOICE: warm, direct, like a friend who is genuinely useful. Specific over clever. Short sentences.
No emoji spam, no ALL CAPS, no exclamation-mark pileups.

A suggested angle: "Show your AI bestie the problem — she'll see it and walk you through it. Free to chat, always."`;

const CHANNEL_SHAPE: Record<Channel, string> = {
  email: 'An email. Return a subject line under 60 characters, then a blank line, then a body of 80-150 words. Do not add an unsubscribe footer -- the system appends the legally required one.',
  sms: 'A single SMS under 140 characters so the STOP notice fits in one segment. No subject line. Do not add "Reply STOP" -- the system appends it.',
  push: 'A push notification: a title under 40 characters, then a blank line, then a body under 120 characters.',
};

export interface CopyRequest {
  channel: Channel;
  goal: string;
  audience?: string;
  tone?: string;
  variables?: string[];
  variantCount?: number;
}

export interface CopyResult {
  subject?: string;
  body: string;
  variants: Array<{ subject?: string; body: string }>;
  model: string;
  violations: CopyViolation[];
  regenerated: boolean;
}

export class CopyGenerationError extends Error {
  constructor(
    message: string,
    readonly violations: CopyViolation[] = [],
  ) {
    super(message);
    this.name = 'CopyGenerationError';
  }
}

export interface CopyEngineDeps {
  apiKey: string | undefined;
  model: string;
}

export class CopyEngine {
  private client: Anthropic | undefined;

  constructor(private readonly deps: CopyEngineDeps) {}

  get available(): boolean {
    return Boolean(this.deps.apiKey);
  }

  private get anthropic(): Anthropic {
    if (!this.deps.apiKey) {
      throw new CopyGenerationError('ANTHROPIC_API_KEY is not set, so copy cannot be generated.');
    }
    this.client ??= new Anthropic({ apiKey: this.deps.apiKey });
    return this.client;
  }

  async generate(request: CopyRequest): Promise<CopyResult> {
    // A "goal" arriving from a prompt or a stored record is untrusted input; it
    // does not get to talk the engine out of the truth constraints.
    const override = detectGuardrailOverride(`${request.goal} ${request.audience ?? ''} ${request.tone ?? ''}`);
    if (override.attempted) {
      throw new CopyGenerationError(
        `Refused: the brief asks the copy engine to break a guardrail (${override.rules.join(', ')}). ` +
          'Compliance rules are enforced in code and cannot be waived by a prompt.',
      );
    }

    const first = await this.callModel(request);
    let parsed = parseCopy(request.channel, first);
    let check = checkCopyTruthfulness(`${parsed.subject ?? ''}\n${parsed.body}`);
    let regenerated = false;

    if (!check.ok) {
      // One correction pass with the specific violations quoted back. If the
      // model repeats them we fail loudly rather than shipping the claim.
      regenerated = true;
      const retry = await this.callModel(request, check.violations);
      parsed = parseCopy(request.channel, retry);
      check = checkCopyTruthfulness(`${parsed.subject ?? ''}\n${parsed.body}`);
      if (!check.ok) {
        throw new CopyGenerationError(
          'Generated copy made claims AI Bestie cannot support, twice. Nothing was saved.',
          check.violations,
        );
      }
    }

    return {
      subject: parsed.subject,
      body: parsed.body,
      variants: parsed.variants,
      model: this.deps.model,
      violations: [],
      regenerated,
    };
  }

  private async callModel(request: CopyRequest, corrections: CopyViolation[] = []): Promise<string> {
    const variantCount = Math.min(Math.max(request.variantCount ?? 1, 1), 3);
    const parts = [
      `Goal: ${request.goal}`,
      request.audience ? `Audience: ${request.audience}` : null,
      request.tone ? `Tone: ${request.tone}` : null,
      request.variables?.length
        ? `You may use these personalization placeholders verbatim: ${request.variables.map((v) => `{{${v}}}`).join(', ')}`
        : null,
      `Format: ${CHANNEL_SHAPE[request.channel]}`,
      variantCount > 1
        ? `Produce ${variantCount} variants separated by a line containing only "---".`
        : 'Produce exactly one version. No preamble, no commentary, no options.',
      corrections.length > 0
        ? `Your previous attempt violated these rules and was rejected. Fix them:\n${corrections
            .map((v) => `- ${v.rule}: you wrote "${v.match}". ${v.detail}`)
            .join('\n')}`
        : null,
    ].filter((p): p is string => p !== null);

    const response = await this.anthropic.messages.create({
      model: this.deps.model,
      // Generous headroom deliberately: on current models thinking is on by
      // default and max_tokens caps thinking + response text together, so a
      // budget sized to the copy alone truncates the copy. Marketing copy is
      // short, so we are billed for what it actually writes, not for this cap.
      max_tokens: 8000,
      system: BRAND_BRIEF,
      messages: [{ role: 'user', content: parts.join('\n\n') }],
    });

    return response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();
  }
}

interface ParsedCopy {
  subject?: string;
  body: string;
  variants: Array<{ subject?: string; body: string }>;
}

/** Exported for tests: splits variants and lifts the subject/title line. */
export function parseCopy(channel: Channel, raw: string): ParsedCopy {
  const chunks = raw
    .split(/^\s*---\s*$/m)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);

  const variants = (chunks.length > 0 ? chunks : ['']).map((chunk) => {
    if (channel === 'sms') return { body: chunk };
    const [head, ...rest] = chunk.split(/\n\s*\n/);
    if (rest.length === 0) return { body: chunk };
    return {
      subject: (head ?? '').replace(/^(subject|title)\s*:\s*/i, '').trim(),
      body: rest.join('\n\n').trim(),
    };
  });

  const first = variants[0] ?? { body: '' };
  return { subject: first.subject, body: first.body, variants };
}
