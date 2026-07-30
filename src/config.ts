import { z } from 'zod';

/**
 * All configuration lives here so that no other module reads process.env
 * directly. Secrets never leave this module: tools and resources receive the
 * derived, non-secret guardrail values only.
 */

const numberFromEnv = (fallback: number) =>
  z
    .union([z.string(), z.number()])
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : Number(v)))
    .pipe(z.number().finite().nonnegative());

const EnvSchema = z.object({
  CRM_DATABASE_URL: z.string().optional(),
  CRM_DB_POOL_MAX: numberFromEnv(5),

  ANTHROPIC_API_KEY: z.string().optional(),
  COPY_MODEL: z.string().optional(),

  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_FROM_NUMBER: z.string().optional(),
  EXPO_ACCESS_TOKEN: z.string().optional(),

  CRM_MCP_BEARER_TOKEN: z.string().optional(),
  CRM_HTTP_PORT: numberFromEnv(8787),
  CRM_TRANSPORT: z.enum(['stdio', 'http', 'both']).optional(),

  BULK_APPROVAL_THRESHOLD: numberFromEnv(200),
  FREQUENCY_CAP: numberFromEnv(2),
  FREQUENCY_WINDOW_DAYS: numberFromEnv(7),
  DAILY_SPEND_CEILING_USD: numberFromEnv(50),
  SEND_RATE_PER_MINUTE: numberFromEnv(60),
  QUIET_HOURS_START: numberFromEnv(9),
  QUIET_HOURS_END: numberFromEnv(20),

  SENDER_PHYSICAL_ADDRESS: z.string().optional(),
  UNSUBSCRIBE_BASE_URL: z.string().optional(),
  CRM_ACTOR: z.string().optional(),
});

export interface Config {
  databaseUrl: string | undefined;
  dbPoolMax: number;
  anthropicApiKey: string | undefined;
  copyModel: string;
  resendApiKey: string | undefined;
  emailFrom: string;
  twilioAccountSid: string | undefined;
  twilioAuthToken: string | undefined;
  twilioFromNumber: string | undefined;
  expoAccessToken: string | undefined;
  bearerToken: string | undefined;
  httpPort: number;
  transport: 'stdio' | 'http' | 'both';
  guardrails: Guardrails;
  actor: string;
}

/** The non-secret half of the config. Safe to expose via crm://compliance/policy. */
export interface Guardrails {
  bulkApprovalThreshold: number;
  frequencyCap: number;
  frequencyWindowDays: number;
  dailySpendCeilingUsd: number;
  sendRatePerMinute: number;
  quietHoursStart: number;
  quietHoursEnd: number;
  senderPhysicalAddress: string;
  unsubscribeBaseUrl: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.parse(env);
  return {
    databaseUrl: parsed.CRM_DATABASE_URL,
    dbPoolMax: parsed.CRM_DB_POOL_MAX,
    anthropicApiKey: parsed.ANTHROPIC_API_KEY,
    copyModel: parsed.COPY_MODEL ?? 'claude-sonnet-4-5',
    resendApiKey: parsed.RESEND_API_KEY,
    emailFrom: parsed.EMAIL_FROM ?? 'Bestie <hello@bestie.app>',
    twilioAccountSid: parsed.TWILIO_ACCOUNT_SID,
    twilioAuthToken: parsed.TWILIO_AUTH_TOKEN,
    twilioFromNumber: parsed.TWILIO_FROM_NUMBER,
    expoAccessToken: parsed.EXPO_ACCESS_TOKEN,
    bearerToken: parsed.CRM_MCP_BEARER_TOKEN,
    httpPort: parsed.CRM_HTTP_PORT,
    transport: parsed.CRM_TRANSPORT ?? 'stdio',
    actor: parsed.CRM_ACTOR ?? 'mcp-agent',
    guardrails: {
      bulkApprovalThreshold: parsed.BULK_APPROVAL_THRESHOLD,
      frequencyCap: parsed.FREQUENCY_CAP,
      frequencyWindowDays: parsed.FREQUENCY_WINDOW_DAYS,
      dailySpendCeilingUsd: parsed.DAILY_SPEND_CEILING_USD,
      sendRatePerMinute: parsed.SEND_RATE_PER_MINUTE,
      quietHoursStart: parsed.QUIET_HOURS_START,
      quietHoursEnd: parsed.QUIET_HOURS_END,
      senderPhysicalAddress: parsed.SENDER_PHYSICAL_ADDRESS ?? '',
      unsubscribeBaseUrl: parsed.UNSUBSCRIBE_BASE_URL ?? '',
    },
  };
}
