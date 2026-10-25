import { fileURLToPath } from "node:url";
import { buildApp } from "./app.js";
import { ListingCache } from "./cache.js";
import { ChannelListing, isUpstreamFailure } from "./extractor.js";
import { UpstreamGate } from "./gate.js";
import { ChannelResolver } from "./resolver.js";
import { ChannelService } from "./service.js";

// libcurl-impersonate se descarga en el build (scripts/warm-impers.mjs) a esta carpeta del proyecto.
// dist/server.js -> ../.cache/impers. Si IMPER_CACHE_DIR ya viene definida, se respeta.
process.env.IMPER_CACHE_DIR ??= fileURLToPath(new URL("../.cache/impers", import.meta.url));

// --------------------------------------------------------------------------- //
// Configuracion (variables de entorno)
// --------------------------------------------------------------------------- //

const int = (name: string, def: number) => {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : def;
};

// En Render (variable RENDER=true) hay que escuchar en 0.0.0.0; en local, solo 127.0.0.1.
const host = process.env.HOST ?? (process.env.RENDER ? "0.0.0.0" : "127.0.0.1");
const port = int("PORT", 3000);

// Cola unica hacia YouTube: todo lo que salga de este proceso pasa por aqui.
const gate = new UpstreamGate({
  concurrency: int("UPSTREAM_CONCURRENCY", 2),
  minIntervalMs: int("UPSTREAM_MIN_INTERVAL_MS", 150),
  maxQueue: int("UPSTREAM_MAX_QUEUE", 100),
  maxWaitMs: int("UPSTREAM_MAX_WAIT_SEC", 30) * 1000,
  breakerThreshold: int("BREAKER_THRESHOLD", 5),
  breakerCooldownMs: int("BREAKER_COOLDOWN_SEC", 30) * 1000,
  isFailure: isUpstreamFailure,
});
const resolver = new ChannelResolver({
  ttlMs: int("RESOLVE_TTL_SEC", 86_400) * 1000,
  negativeTtlMs: int("NEGATIVE_TTL_SEC", 120) * 1000,
});

const cache = new ListingCache({
  factory: (k) => new ChannelListing({ ...k, gate, resolver, log: (msg) => app.log.debug(msg) }),
  ttlMs: int("CACHE_TTL_SEC", 600) * 1000,
  maxEntries: int("CACHE_MAX_ENTRIES", 50),
  refreshPrefix: int("REFRESH_PREFIX", 300),
  negativeTtlMs: int("NEGATIVE_TTL_SEC", 120) * 1000,
  refreshCooldownMs: int("REFRESH_COOLDOWN_SEC", 30) * 1000,
  log: (msg) => app.log.warn(msg),
});
const service = new ChannelService(cache, { prefetchAhead: int("PREFETCH_AHEAD", 60) });

// Limite por IP (0 = sin limite). Detras de un proxy inverso, activa TRUST_PROXY.
const perMin = (name: string, def: number) => ({ max: int(name, def), windowMs: 60_000 });
const limits = { page: perMin("RATE_PAGE_PER_MIN", 120), all: perMin("RATE_ALL_PER_MIN", 6) };
const trust = process.env.TRUST_PROXY;
// Origenes del frontend permitidos por CORS, separados por comas. Ej:
//   CORS_ORIGINS=https://mosaico.pages.dev,https://*.mosaico.pages.dev
const corsOrigins = (process.env.CORS_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean);
const app = buildApp({
  service,
  gate,
  limits,
  corsOrigins,
  trustProxy: trust === undefined ? undefined : trust === "true" ? true : trust === "false" ? false : trust,
});

// --------------------------------------------------------------------------- //
// Arranque (solo local por defecto: 127.0.0.1)
// --------------------------------------------------------------------------- //

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    app.close().finally(() => process.exit(0));
  });
}

try {
  await app.listen({ host, port });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
