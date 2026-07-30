import { createHmac } from 'node:crypto';
import type { Channel, Contact } from '../types.js';
import { applyChannelFurniture, checkCopyTruthfulness, checkEmailCompliance, checkSmsCompliance } from './compliance.js';

/** Template rendering plus the compliance furniture every rendered message needs. */

const VARIABLE = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

export interface RenderVars {
  [key: string]: string | number | null | undefined;
}

export interface RenderResult {
  text: string;
  missingVariables: string[];
}

/**
 * Substitutes {{name}} placeholders. An unresolved variable is replaced with an
 * empty string and reported -- leaving a literal "{{first_name}}" in a sent
 * message is worse than an awkward gap, and callers surface the list.
 */
export function renderTemplate(body: string, vars: RenderVars): RenderResult {
  const missing = new Set<string>();
  const text = body.replace(VARIABLE, (_match, name: string) => {
    const value = vars[name];
    if (value === undefined || value === null || value === '') {
      missing.add(name);
      return '';
    }
    return String(value);
  });
  return { text, missingVariables: [...missing] };
}

export function templateVariables(body: string): string[] {
  const found = new Set<string>();
  for (const match of body.matchAll(VARIABLE)) {
    if (match[1]) found.add(match[1]);
  }
  return [...found];
}

export function contactVars(contact: Contact, extra: RenderVars = {}): RenderVars {
  return {
    name: contact.name ?? 'there',
    first_name: contact.name?.split(/\s+/)[0] ?? 'there',
    email: contact.email ?? '',
    country: contact.country ?? '',
    locale: contact.locale ?? '',
    lifecycle_stage: contact.lifecycle_stage,
    ...extra,
  };
}

/**
 * A per-contact unsubscribe URL. The token is an HMAC rather than the raw id so
 * the link cannot be used to enumerate contacts, and it stays stable so an old
 * email keeps working.
 */
export function unsubscribeUrl(baseUrl: string, contactId: string, secret: string | undefined): string {
  if (!baseUrl) return '';
  const token = createHmac('sha256', secret ?? 'crm-unsubscribe')
    .update(contactId)
    .digest('hex')
    .slice(0, 32);
  const base = baseUrl.replace(/\/+$/, '');
  return `${base}/${contactId}?t=${token}`;
}

export function verifyUnsubscribeToken(
  contactId: string,
  token: string,
  secret: string | undefined,
): boolean {
  const expected = createHmac('sha256', secret ?? 'crm-unsubscribe')
    .update(contactId)
    .digest('hex')
    .slice(0, 32);
  return expected === token;
}

export interface PreparedMessage {
  subject?: string;
  body: string;
  missingVariables: string[];
  complianceIssues: string[];
  truthfulnessViolations: string[];
}

/**
 * The single path from template to sendable message: render, attach the
 * channel's legal furniture, then verify. Sending code must use this rather
 * than rendering by hand, so no route to a provider skips the checks.
 */
export function prepareMessage(input: {
  channel: Channel;
  subject?: string | null;
  body: string;
  vars: RenderVars;
  unsubscribeUrl: string;
  physicalAddress: string;
}): PreparedMessage {
  const rendered = renderTemplate(input.body, input.vars);
  const withFurniture = applyChannelFurniture(input.channel, rendered.text, {
    unsubscribeUrl: input.unsubscribeUrl,
    physicalAddress: input.physicalAddress,
  });

  const complianceIssues: string[] = [];
  if (input.channel === 'email') {
    complianceIssues.push(
      ...checkEmailCompliance({
        body: withFurniture,
        unsubscribeUrl: input.unsubscribeUrl,
        physicalAddress: input.physicalAddress,
      }).issues,
    );
  } else if (input.channel === 'sms') {
    complianceIssues.push(...checkSmsCompliance(withFurniture).issues);
  }

  const subjectRendered = input.subject ? renderTemplate(input.subject, input.vars) : undefined;
  const truthfulness = checkCopyTruthfulness(`${subjectRendered?.text ?? ''}\n${withFurniture}`);

  return {
    subject: subjectRendered?.text,
    body: withFurniture,
    missingVariables: [
      ...new Set([...rendered.missingVariables, ...(subjectRendered?.missingVariables ?? [])]),
    ],
    complianceIssues,
    truthfulnessViolations: truthfulness.violations.map((v) => `${v.rule}: "${v.match}" -- ${v.detail}`),
  };
}
