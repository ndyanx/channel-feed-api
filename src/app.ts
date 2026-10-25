import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyReply, type FastifyRequest, type FastifyServerOptions } from "fastify";
import { z } from "zod";
import {
  ChannelError,
  InputError,
  MEMBERS,
  SECTIONS,
  SORTS,
  UpstreamError,
  parseChannel,
  type VideoEntry,
} from "./extractor.js";
import type { ListingKey } from "./cache.js";
import { OverloadedError, type UpstreamGate } from "./gate.js";
import type { ChannelService } from "./service.js";

// --------------------------------------------------------------------------- //
// Validacion de la query
// --------------------------------------------------------------------------- //

const SECTION_ALIASES: Record<string, string> = {
  live: "streams",
  stream: "streams",
  short: "shorts",
  video: "videos",
};

/** "true" | "false" (z.coerce.boolean() trataria "false" como true). */
const bool = (def: boolean) =>
  z
    .enum(["true", "false"])
    .default(def ? "true" : "false")
    .transform((v) => v === "true");

const OUTPUTS = ["full", "urls", "ids"] as const;

/** Parametros comunes a los dos endpoints (identifican el listado). */
const common = {
  channel: z
    .string()
    .min(1, "channel is required")
    .transform((v, ctx) => {
      try {
        return parseChannel(v);
      } catch (err) {
        ctx.addIssue({ code: "custom", message: (err as Error).message });
        return z.NEVER;
      }
    }),
  section: z
    .string()
    .default("videos")
    .transform((v) => v.toLowerCase())
    .transform((v) => SECTION_ALIASES[v] ?? v)
    .pipe(z.enum(SECTIONS)),
  sort_by: z.enum(SORTS).default("newest"),
  members: z.enum(MEMBERS).default("all"),
  output: z.enum(OUTPUTS).default("full"),
  limit_id: z
    .string()
    .regex(/^[\w-]{11}$/, "limit_id must be a YouTube video id")
    .optional(),
  reverse: bool(false),
};

const membersRule = {
  check: (q: { members: string; section: string }) =>
    q.members === "all" || q.section === "videos" || q.section === "shorts",
  params: { path: ["members"], message: "members only applies to sections 'videos' and 'shorts'" },
};

/** GET /v1/channel: una pagina. `max` es el tamaño de pagina. */
const PageQuery = z
  .object({
    ...common,
    max: z.coerce.number().int().min(1).max(10_000).default(100),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .refine(membersRule.check, membersRule.params);

/** GET /v1/channel/all: la lista completa. `max` es opcional (sin tope por defecto). */
const AllQuery = z
  .object({
    ...common,
    max: z.coerce.number().int().min(1).optional(),
    refresh: bool(false),
    stale: z.enum(["ok"]).optional(),
  })
  .refine(membersRule.check, membersRule.params);

// --------------------------------------------------------------------------- //
// Aplicacion
// --------------------------------------------------------------------------- //

const project = (items: VideoEntry[], output: (typeof OUTPUTS)[number]): VideoEntry[] | string[] =>
  output === "ids" ? items.map((e) => e.id) : output === "urls" ? items.map((e) => e.url) : items;

const iso = (ms: number) => new Date(ms).toISOString();

export interface RateLimitRule {
  /** Peticiones permitidas por ventana y por IP (0 = sin limite en esa ruta). */
  max: number;
  windowMs: number;
}

export interface AppOptions {
  service: ChannelService;
  logger?: FastifyServerOptions["logger"];
  /** Cola hacia YouTube; solo se usa para mostrar su estado en GET /v1/stats. */
  gate?: UpstreamGate;
  /** Limite por IP. Sin esto (o con `false`) no hay limite. */
  limits?: { page: RateLimitRule; all: RateLimitRule } | false;
  /** Fastify `trustProxy`: necesario para ver la IP real detras de un proxy inverso. */
  trustProxy?: boolean | string;
  /**
   * Origenes del frontend autorizados por CORS (p. ej. "https://mosaico.pages.dev").
   * Admite un comodin "*" dentro del host ("https://*.mosaico.pages.dev" para los previews).
   * Sin esto (o vacio) no se agregan cabeceras CORS: solo funciona mismo origen / proxy.
   */
  corsOrigins?: string[];
}

/** "https://*.x.pages.dev" -> regex anclada; sin "*" -> texto exacto. */
export function originMatchers(list: string[]): (string | RegExp)[] {
  const escape = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return list
    .map((o) => o.trim().replace(/\/+$/, ""))
    .filter(Boolean)
    .map((o) => (o.includes("*") ? new RegExp(`^${o.split("*").map(escape).join("[a-z0-9-]+")}$`, "i") : o));
}

/** El cliente se paso de su cuota (429). El plugin pone Retry-After. */
class RateLimitError extends Error {
  readonly statusCode = 429;
  constructor(message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}

export function buildApp({ service, logger, gate, limits = false, trustProxy, corsOrigins = [] }: AppOptions) {
  const app = Fastify({
    logger: logger ?? { level: process.env.LOG_LEVEL ?? "info" },
    ...(trustProxy !== undefined ? { trustProxy } : {}),
  });

  const origins = originMatchers(corsOrigins);
  if (origins.length > 0) {
    // Solo GET/HEAD: la API es de lectura. Retry-After se expone para que el frontend lo lea en 429/503.
    app.register(cors, {
      origin: origins,
      methods: ["GET", "HEAD", "OPTIONS"],
      exposedHeaders: ["retry-after"],
      maxAge: 86_400,
    });
  }

  if (limits) {
    // global:false: nada se limita salvo las rutas que usan `limit(...)`.
    app.register(rateLimit, {
      global: false,
      errorResponseBuilder: (_req, ctx) =>
        new RateLimitError(`demasiadas peticiones; reintenta en ${Math.ceil(ctx.ttl / 1000)} s`),
    });
  }
  /**
   * preHandler de limite por IP, con contador propio por ruta. Se crea en la primera
   * peticion porque el plugin se carga de forma diferida (el hook `onRoute` del plugin
   * no ve rutas declaradas antes de que cargue, y asi `buildApp` sigue siendo sincrono).
   */
  const limit = (rule: RateLimitRule | undefined) => {
    if (!limits || !rule || rule.max <= 0) return {};
    let handler: ReturnType<typeof app.rateLimit> | undefined;
    return {
      preHandler: async (req: FastifyRequest, reply: FastifyReply) => {
        handler ??= app.rateLimit({ max: rule.max, timeWindow: rule.windowMs });
        return handler.call(app, req, reply);
      },
    };
  };

  const key = (q: { channel: string; section: ListingKey["section"]; sort_by: ListingKey["sortBy"]; members: ListingKey["members"] }): ListingKey => ({
    channel: q.channel,
    section: q.section,
    sortBy: q.sort_by,
    members: q.members,
  });

  const invalid = (error: z.ZodError) => ({
    error: {
      type: "ValidationError",
      message: "invalid query parameters",
      issues: error.issues.map((i) => ({ param: i.path.join("."), message: i.message })),
    },
  });

  // Para monitores de uptime (UptimeRobot usa HEAD o GET) y el healthcheck de Render.
  // Fastify crea el HEAD de cada GET automaticamente. Ninguna toca YouTube ni el cache.
  app.get("/health", async () => ({ ok: true }));
  app.get("/", async () => ({ ok: true, service: "channel-feed-api" }));

  app.get("/v1/stats", async () => ({
    upstream: gate?.stats() ?? null,
    cache: { entries: service.cacheSize },
  }));

  app.get("/v1/channel", limit(limits ? limits.page : undefined), async (req, reply) => {
    const parsed = PageQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send(invalid(parsed.error));
    const q = parsed.data;

    const r = await service.page(key(q), {
      offset: q.offset,
      max: q.max,
      reverse: q.reverse,
      limitId: q.limit_id,
    });

    return {
      channel: q.channel,
      section: q.section,
      offset: q.offset,
      count: r.items.length,
      total: r.total,
      has_more: r.hasMore,
      cache: r.cache,
      updated_at: iso(r.updatedAt),
      items: project(r.items, q.output),
    };
  });

  app.get("/v1/channel/all", limit(limits ? limits.all : undefined), async (req, reply) => {
    const parsed = AllQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send(invalid(parsed.error));
    const q = parsed.data;

    const r = await service.all(key(q), {
      max: q.max,
      reverse: q.reverse,
      limitId: q.limit_id,
      refresh: q.refresh,
      staleOk: q.stale === "ok",
    });

    return {
      channel: q.channel,
      section: q.section,
      count: r.items.length,
      complete: r.complete,
      cache: r.cache,
      updated_at: iso(r.updatedAt),
      items: project(r.items, q.output),
    };
  });

  app.setErrorHandler((err: Error, req, reply) => {
    if (err instanceof InputError) {
      return reply.code(400).send({ error: { type: err.name, message: err.message } });
    }
    if (err instanceof ChannelError) {
      return reply.code(404).send({ error: { type: err.name, message: err.message } });
    }
    if (err instanceof RateLimitError) {
      return reply.code(429).send({ error: { type: err.name, message: err.message } });
    }
    if (err instanceof OverloadedError) {
      req.log.warn({ reason: err.reason }, "overloaded");
      return reply
        .code(503)
        .header("retry-after", String(err.retryAfterSec))
        .send({ error: { type: err.name, message: err.message, reason: err.reason } });
    }
    if (err instanceof UpstreamError) {
      req.log.warn({ err }, "upstream error");
      return reply.code(502).send({ error: { type: err.name, message: err.message } });
    }
    req.log.error({ err }, "unhandled error");
    return reply.code(500).send({ error: { type: "InternalError", message: "internal error" } });
  });

  return app;
}
