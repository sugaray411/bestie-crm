import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express, { type NextFunction, type Request, type Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { createContext, type ServerContext } from './context.js';
import { registerContactTools } from './tools/contacts.js';
import { registerConsentTools } from './tools/consent.js';
import { registerSegmentTools } from './tools/segments.js';
import { registerTemplateTools } from './tools/templates.js';
import { registerCampaignTools } from './tools/campaigns.js';
import { registerSendTools } from './tools/send.js';
import { registerReferralTools } from './tools/referral.js';
import { registerAnalyticsTools } from './tools/analytics.js';
import { registerIngestTools, ingestEvent, ContactRefSchema } from './tools/ingest.js';
import { registerResources } from './resources/index.js';
import { registerPrompts } from './prompts/index.js';
import { EVENT_TYPES, type EventType } from './types.js';

/** stdio logging must go to stderr -- stdout is the JSON-RPC channel. */
const log = (message: string): void => {
  process.stderr.write(`[crm] ${message}\n`);
};

export function buildServer(ctx: ServerContext): McpServer {
  const server = new McpServer(
    { name: 'bestie-growth-crm', version: '0.1.0' },
    {
      instructions:
        'Growth and customer-acquisition operations for AI Bestie. Every outbound message is consent-gated, ' +
        'suppression-checked, quiet-hours aware and rate-limited, and sends are dry runs unless explicitly ' +
        'confirmed. Read crm://compliance/policy before planning a campaign. Copy must lead with the live ' +
        'video call ("show Bestie the problem, she sees it and walks you through it") and free unlimited ' +
        'chat, and must never claim free video or voice is unlimited -- those are capped at 10 and 5 minutes ' +
        'a day on the free tier.',
    },
  );

  registerContactTools(server, ctx);
  registerConsentTools(server, ctx);
  registerSegmentTools(server, ctx);
  registerTemplateTools(server, ctx);
  registerCampaignTools(server, ctx);
  registerSendTools(server, ctx);
  registerReferralTools(server, ctx);
  registerAnalyticsTools(server, ctx);
  registerIngestTools(server, ctx);
  registerResources(server, ctx);
  registerPrompts(server, ctx);

  return server;
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * The HTTP surface: the MCP Streamable HTTP transport plus the /crm/ingest
 * endpoint the app backend calls (§4c, the alternative to granting the app
 * INSERT on crm.events_inbox). Both require the bearer token.
 */
export function createHttpApp(ctx: ServerContext): express.Express {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  const requireBearer = (req: Request, res: Response, next: NextFunction): void => {
    const expected = ctx.config.bearerToken;
    if (!expected) {
      res.status(503).json({ error: 'CRM_MCP_BEARER_TOKEN is not set, so the HTTP transport is disabled.' });
      return;
    }
    const header = req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token || !constantTimeEquals(token, expected)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  };

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', server: 'bestie-growth-crm' });
  });

  app.post('/crm/ingest', requireBearer, (req: Request, res: Response) => {
    void (async () => {
      try {
        const body = req.body as { type?: string; contact_ref?: unknown; value?: number; meta?: unknown };
        if (!body.type || !(EVENT_TYPES as readonly string[]).includes(body.type)) {
          res.status(400).json({ error: `type must be one of: ${EVENT_TYPES.join(', ')}` });
          return;
        }
        const ref = ContactRefSchema.safeParse(body.contact_ref ?? {});
        const result = await ingestEvent(ctx, {
          type: body.type as EventType,
          contact_ref: ref.success ? ref.data : undefined,
          value: typeof body.value === 'number' ? body.value : null,
          meta: (body.meta as Record<string, unknown>) ?? {},
        });
        res.status(202).json(result);
      } catch (err) {
        log(`ingest failed: ${err instanceof Error ? err.message : String(err)}`);
        res.status(500).json({ error: 'ingest failed' });
      }
    })();
  });

  // Stateless: a fresh server and transport per request, so nothing leaks
  // between callers and horizontal scaling needs no sticky sessions.
  app.post('/mcp', requireBearer, (req: Request, res: Response) => {
    void (async () => {
      const server = buildServer(ctx);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (err) {
        log(`mcp request failed: ${err instanceof Error ? err.message : String(err)}`);
        if (!res.headersSent) res.status(500).json({ error: 'internal error' });
      }
    })();
  });

  return app;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config);
  const ctx = createContext(pool, config);

  const shutdown = async (): Promise<void> => {
    await pool.end().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  if (config.transport === 'http' || config.transport === 'both') {
    if (!config.bearerToken) {
      throw new Error('CRM_MCP_BEARER_TOKEN must be set to serve over HTTP.');
    }
    const app = createHttpApp(ctx);
    app.listen(config.httpPort, () => {
      log(`HTTP transport listening on :${config.httpPort} (POST /mcp, POST /crm/ingest)`);
    });
  }

  if (config.transport === 'stdio' || config.transport === 'both') {
    const server = buildServer(ctx);
    await server.connect(new StdioServerTransport());
    log('stdio transport ready');
  }
}

const isEntrypoint = process.argv[1]?.endsWith('index.js') || process.argv[1]?.endsWith('index.ts');
if (isEntrypoint) {
  main().catch((err: unknown) => {
    log(`fatal: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
