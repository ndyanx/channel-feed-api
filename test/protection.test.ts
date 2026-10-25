/**
 * Escenarios de proteccion de la API, de punta a punta (app + cache + cola + YouTube falso).
 * Cada `describe` es un escenario; el nombre dice que se espera.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildApp, type RateLimitRule } from "../src/app.js";
import { ListingCache } from "../src/cache.js";
import { ChannelListing, isUpstreamFailure, type HttpSession } from "../src/extractor.js";
import { OverloadedError, UpstreamGate, type GateOptions } from "../src/gate.js";
import { ChannelResolver } from "../src/resolver.js";
import { ChannelService } from "../src/service.js";
import { FakeYouTube, vids } from "./fakeYoutube.js";

interface Setup {
  yt?: FakeYouTube;
  gate?: GateOptions | false;
  negativeTtlMs?: number;
  refreshCooldownMs?: number;
  limits?: { page: RateLimitRule; all: RateLimitRule };
  now?: () => number;
}

function build(o: Setup = {}) {
  const yt = o.yt ?? new FakeYouTube({ ids: vids(1, 12), pageSize: 5 });

  // Mide cuantas peticiones a YouTube hay en vuelo a la vez.
  const stat = { inFlight: 0, maxInFlight: 0, posts: 0 };
  const sessionFactory = (): HttpSession => {
    const s = yt.session();
    return {
      post: async (url, options) => {
        stat.posts++;
        stat.inFlight++;
        stat.maxInFlight = Math.max(stat.maxInFlight, stat.inFlight);
        try {
          return await s.post(url, options);
        } finally {
          stat.inFlight--;
        }
      },
      close: () => s.close(),
    };
  };

  const gate = o.gate === false ? undefined : new UpstreamGate({ isFailure: isUpstreamFailure, now: o.now, ...o.gate });
  const resolver = new ChannelResolver({ negativeTtlMs: o.negativeTtlMs ?? 0, now: o.now });
  const cache = new ListingCache({
    factory: (k) => new ChannelListing({ ...k, sessionFactory, gate, resolver, now: o.now }),
    negativeTtlMs: o.negativeTtlMs ?? 0,
    refreshCooldownMs: o.refreshCooldownMs ?? 0,
    now: o.now,
  });
  const app = buildApp({
    service: new ChannelService(cache, { prefetchAhead: 0 }),
    gate,
    limits: o.limits ?? false,
    logger: false,
  });
  return { app, yt, gate, stat };
}

type App = ReturnType<typeof build>["app"];
const get = async (app: App, url: string) => {
  const res = await app.inject({ method: "GET", url });
  return { status: res.statusCode, body: res.json(), headers: res.headers };
};
const count = (yt: FakeYouTube, what: string) => yt.calls.filter((c) => c === what).length;

describe("Escenario: dos usuarios piden lo mismo a la vez", () => {
  it("20 peticiones identicas => una sola descarga a YouTube", async () => {
    const { app, yt } = build({ yt: new FakeYouTube({ ids: vids(1, 12), pageSize: 5 }) });
    yt.delayMs = 15;
    const url = "/v1/channel?channel=@canal&max=5&output=ids";
    const rs = await Promise.all(Array.from({ length: 20 }, () => get(app, url)));

    assert.ok(rs.every((r) => r.status === 200));
    assert.ok(rs.every((r) => JSON.stringify(r.body.items) === JSON.stringify(rs[0]!.body.items)));
    assert.equal(count(yt, "resolve"), 1);
    assert.equal(count(yt, "tab"), 1);
    assert.equal(yt.sessionsOpened, 1);
  });

  it("escrituras distintas del mismo canal (@Canal, canal, URL) comparten listado", async () => {
    const { app, yt } = build();
    yt.delayMs = 10;
    const variants = ["@canal", "canal", "@CANAL", "https://www.youtube.com/@canal"];
    const rs = await Promise.all(
      variants.map((c) => get(app, `/v1/channel?channel=${encodeURIComponent(c)}&max=3&output=ids`)),
    );
    assert.ok(rs.every((r) => r.status === 200));
    assert.equal(count(yt, "tab"), 1);
  });
});

describe("Escenario: mismo canal, distintos parametros", () => {
  it("max / offset / reverse / output / limit_id NO generan descargas extra: todo sale del mismo listado", async () => {
    const { app, yt } = build();
    yt.delayMs = 10;
    const urls = [
      "/v1/channel?channel=@canal&max=2&output=ids",
      "/v1/channel?channel=@canal&max=5&offset=5&output=urls",
      "/v1/channel?channel=@canal&max=3&output=full",
      "/v1/channel?channel=@canal&max=4&reverse=true&output=ids",
      "/v1/channel/all?channel=@canal&output=ids",
      "/v1/channel/all?channel=@canal&max=7&output=ids",
    ];
    const rs = await Promise.all(urls.map((u) => get(app, u)));
    assert.ok(rs.every((r) => r.status === 200), JSON.stringify(rs.map((r) => r.status)));

    assert.equal(count(yt, "resolve"), 1);
    assert.equal(count(yt, "tab"), 1);
    // 12 videos en paginas de 5 => 2 continuaciones, como mucho, pidieran lo que pidieran.
    assert.ok(yt.continuationCalls <= 2, `continuaciones: ${yt.continuationCalls}`);
    assert.equal(new Set(yt.calls.filter((c) => c.startsWith("cont:"))).size, yt.continuationCalls, "ninguna pagina repetida");
  });

  it("members=public vs all son listados distintos (otra clave) pero el handle se resuelve UNA vez", async () => {
    const { app, yt } = build();
    yt.delayMs = 10;
    const rs = await Promise.all([
      get(app, "/v1/channel?channel=@canal&members=all&max=3&output=ids"),
      get(app, "/v1/channel?channel=@canal&members=public&max=3&output=ids"),
    ]);
    assert.ok(rs.every((r) => r.status === 200));
    assert.equal(count(yt, "tab"), 2, "dos listados");
    assert.equal(count(yt, "resolve"), 1, "una sola resolucion de @canal");
  });
});

describe("Escenario: muchos canales distintos a la vez (la cola)", () => {
  it("nunca hay mas peticiones en vuelo a YouTube que la concurrencia configurada", async () => {
    const { app, yt, stat } = build({ gate: { concurrency: 2 } });
    yt.delayMs = 15;
    const rs = await Promise.all(
      Array.from({ length: 8 }, (_, i) => get(app, `/v1/channel?channel=@canal${i}&max=3&output=ids`)),
    );
    assert.ok(rs.every((r) => r.status === 200));
    assert.equal(stat.maxInFlight, 2);
    assert.equal(count(yt, "resolve"), 8);
  });

  it("sin cola (gate desactivado) la misma avalancha satura: 8 en vuelo a la vez", async () => {
    const { app, yt, stat } = build({ gate: false });
    yt.delayMs = 15;
    await Promise.all(Array.from({ length: 8 }, (_, i) => get(app, `/v1/channel?channel=@canal${i}&max=3&output=ids`)));
    assert.equal(stat.maxInFlight, 8);
  });

  it("saturacion: lo que no cabe recibe 503 + Retry-After; lo cacheado sigue respondiendo", async () => {
    const { app, yt } = build({ gate: { concurrency: 1, maxQueue: 1 } });
    // Calienta un canal para tener algo en cache.
    assert.equal((await get(app, "/v1/channel?channel=@caliente&max=3&output=ids")).status, 200);

    yt.delayMs = 60;
    const burst = Array.from({ length: 5 }, (_, i) => get(app, `/v1/channel?channel=@frio${i}&max=3&output=ids`));
    await new Promise((r) => setTimeout(r, 10));

    // En plena saturacion, el canal cacheado responde al instante.
    const t0 = Date.now();
    const hot = await get(app, "/v1/channel?channel=@caliente&max=2&offset=1&output=ids");
    assert.equal(hot.status, 200);
    assert.equal(hot.body.cache, "hit");
    assert.ok(Date.now() - t0 < 40, "el hit no espera a la cola");

    const stats = await get(app, "/v1/stats");
    assert.equal(stats.body.upstream.concurrency, 1);
    assert.ok(stats.body.upstream.running + stats.body.upstream.queued.interactive >= 1);

    const rs = await Promise.all(burst);
    const rejected = rs.filter((r) => r.status === 503);
    assert.ok(rejected.length >= 1, JSON.stringify(rs.map((r) => r.status)));
    assert.ok(rs.some((r) => r.status === 200));
    for (const r of rejected) {
      assert.equal(r.body.error.type, "OverloadedError");
      assert.equal(r.body.error.reason, "queue_full");
      assert.ok(Number(r.headers["retry-after"]) >= 1);
    }
    assert.ok(rs.every((r) => r.status === 200 || r.status === 503));

    // Y despues, el rechazado puede reintentar y funciona (no quedo nada envenenado en cache).
    const retry = await get(app, `/v1/channel?channel=@frio${rs.findIndex((r) => r.status === 503)}&max=3&output=ids`);
    assert.equal(retry.status, 200);
  });

  it("un /all grande no acapara la cola: otra peticion se intercala entre sus paginas", async () => {
    const big = new FakeYouTube({ ids: vids(1, 60), pageSize: 5 }); // 12 paginas
    const { app, yt } = build({ yt: big, gate: { concurrency: 1 } });
    yt.delayMs = 10;
    const long = get(app, "/v1/channel/all?channel=@grande&output=ids");
    await new Promise((r) => setTimeout(r, 5));
    const t0 = Date.now();
    const small = await get(app, "/v1/channel?channel=@pequeno&max=2&output=ids");
    const waited = Date.now() - t0;
    assert.equal(small.status, 200);
    // El /all necesita ~13 turnos de 10 ms; la pequena (2 turnos) NO espera a que acabe.
    assert.ok(waited < 80, `espero ${waited} ms`);
    assert.equal((await long).status, 200);
  });
});

describe("Escenario: una descarga larga se corta a mitad por sobrecarga", () => {
  it("se propaga como OverloadedError (no 502), lo bajado se conserva y el reintento continua", async () => {
    const yt = new FakeYouTube({ ids: vids(1, 30), pageSize: 5 }); // 6 paginas
    let posts = 0;
    let cut = true;
    const sessionFactory = (): HttpSession => {
      const s = yt.session();
      return {
        post: async (url, options) => {
          posts++;
          if (cut && posts === 4) throw new OverloadedError("saturado", "queue_full", 3);
          return s.post(url, options);
        },
        close: () => s.close(),
      };
    };
    const listing = new ChannelListing({ channel: "@canal", sessionFactory });

    const err = await listing.extend(() => false).catch((e) => e);
    assert.ok(err instanceof OverloadedError, String(err));
    assert.equal(listing.entries.length, 10, "resolve + tab(5) + 1 pagina(5) ya estaban absorbidos");

    cut = false;
    yt.reset();
    await listing.extend(() => false);
    assert.equal(listing.entries.length, 30);
    assert.equal(listing.complete, true);
    assert.equal(count(yt, "tab"), 0, "no vuelve a pedir la primera pagina");
    assert.deepEqual(
      yt.calls.filter((c) => c.startsWith("cont:")),
      ["cont:10", "cont:15", "cont:20", "cont:25"],
      "retoma justo donde se corto",
    );
  });
});

describe("Escenario: canales que no existen (spam de handles)", () => {
  it("con cache negativo, repetir un canal inexistente no vuelve a llamar a YouTube", async () => {
    const yt = new FakeYouTube({ ids: [] });
    yt.channelExists = false;
    const { app } = build({ yt, negativeTtlMs: 60_000 });

    const first = await get(app, "/v1/channel?channel=@nada&max=3");
    assert.equal(first.status, 404);
    const callsAfterFirst = yt.calls.length;
    assert.equal(callsAfterFirst, 1);

    for (let i = 0; i < 10; i++) assert.equal((await get(app, "/v1/channel?channel=@nada&max=3")).status, 404);
    assert.equal(yt.calls.length, callsAfterFirst);
  });

  it("el cache negativo tambien colapsa las combinaciones: otra seccion/miembros del mismo handle inexistente", async () => {
    const yt = new FakeYouTube({ ids: [] });
    yt.channelExists = false;
    const { app } = build({ yt, negativeTtlMs: 60_000 });
    await get(app, "/v1/channel?channel=@nada&members=all");
    await get(app, "/v1/channel?channel=@nada&members=public");
    await get(app, "/v1/channel?channel=@NADA&members=only");
    assert.equal(count(yt, "resolve"), 1);
  });

  it("al vencer el TTL negativo se vuelve a preguntar (el canal pudo crearse)", async () => {
    const yt = new FakeYouTube({ ids: vids(1, 3) });
    yt.channelExists = false;
    let t = 1_000_000;
    const { app } = build({ yt, negativeTtlMs: 1000, now: () => t });
    assert.equal((await get(app, "/v1/channel?channel=@luego")).status, 404);
    yt.channelExists = true;
    assert.equal((await get(app, "/v1/channel?channel=@luego")).status, 404, "aun recordado");
    t += 2000;
    assert.equal((await get(app, "/v1/channel?channel=@luego&max=2&output=ids")).status, 200);
  });

  it("los fallos de red NO se recuerdan como inexistentes", async () => {
    const yt = new FakeYouTube({ ids: vids(1, 3) });
    yt.failAll = true;
    const { app } = build({ yt, negativeTtlMs: 60_000, gate: { concurrency: 2 } });
    assert.equal((await get(app, "/v1/channel?channel=@canal")).status, 502);
    yt.failAll = false;
    assert.equal((await get(app, "/v1/channel?channel=@canal&max=2&output=ids")).status, 200);
  });
});

describe("Escenario: refresh=true abusivo", () => {
  it("dentro del cooldown, refresh=true se sirve del cache (no descarga otra vez)", async () => {
    let t = 1_000_000;
    const { app, yt } = build({ refreshCooldownMs: 30_000, now: () => t });
    const first = await get(app, "/v1/channel/all?channel=@canal&output=ids");
    assert.equal(first.body.cache, "miss");
    yt.reset();

    for (let i = 0; i < 5; i++) {
      const r = await get(app, "/v1/channel/all?channel=@canal&output=ids&refresh=true");
      assert.equal(r.status, 200);
      assert.equal(r.body.cache, "hit");
    }
    assert.equal(yt.calls.length, 0);

    t += 31_000; // pasado el cooldown, refresh=true vuelve a funcionar
    const later = await get(app, "/v1/channel/all?channel=@canal&output=ids&refresh=true");
    assert.equal(later.body.cache, "refresh");
    assert.ok(yt.calls.length > 0);
  });

  it("refresh=true simultaneos (ya pasado el cooldown) comparten UNA descarga", async () => {
    let t = 1_000_000;
    const { app, yt } = build({ refreshCooldownMs: 1000, now: () => t });
    await get(app, "/v1/channel/all?channel=@canal&output=ids");
    t += 5000;
    yt.reset();
    yt.delayMs = 15;
    const rs = await Promise.all(
      Array.from({ length: 6 }, () => get(app, "/v1/channel/all?channel=@canal&output=ids&refresh=true")),
    );
    assert.ok(rs.every((r) => r.status === 200 && r.body.cache === "refresh"));
    assert.equal(count(yt, "tab"), 1);
  });
});

describe("Escenario: YouTube se cae o nos bloquea (circuit breaker)", () => {
  it("tras N fallos deja de llamar a YouTube (503 inmediato) y se recupera solo", async () => {
    let t = 1_000_000;
    const yt = new FakeYouTube({ ids: vids(1, 6) });
    const { app, stat } = build({
      yt,
      gate: { concurrency: 1, breakerThreshold: 3, breakerCooldownMs: 10_000 },
      now: () => t,
    });

    yt.failAll = true;
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) statuses.push((await get(app, `/v1/channel?channel=@canal${i}`)).status);
    assert.deepEqual(statuses, [502, 502, 502]);

    const postsBefore = stat.posts;
    const blocked = await get(app, "/v1/channel?channel=@otro");
    assert.equal(blocked.status, 503);
    assert.equal(blocked.body.error.reason, "circuit_open");
    assert.ok(Number(blocked.headers["retry-after"]) >= 1);
    assert.equal(stat.posts, postsBefore, "no se llamo a YouTube");

    yt.failAll = false;
    t += 11_000; // pasa el cooldown: una peticion de prueba y se reabre
    const probe = await get(app, "/v1/channel?channel=@otro&max=2&output=ids");
    assert.equal(probe.status, 200);
    assert.equal((await get(app, "/v1/channel?channel=@mas&max=2&output=ids")).status, 200);
  });

  it("un canal inexistente (404 de YouTube) NO abre el breaker", async () => {
    const yt = new FakeYouTube({ ids: [] });
    yt.channelExists = false;
    const { app } = build({ yt, gate: { concurrency: 1, breakerThreshold: 2 } });
    for (let i = 0; i < 6; i++) assert.equal((await get(app, `/v1/channel?channel=@nada${i}`)).status, 404);
    const stats = await get(app, "/v1/stats");
    assert.equal(stats.body.upstream.circuit, "closed");
  });
});

describe("Escenario: un cliente se pasa de peticiones (rate limit por IP)", () => {
  const limits = { page: { max: 3, windowMs: 60_000 }, all: { max: 1, windowMs: 60_000 } };

  it("la peticion N+1 recibe 429 con Retry-After; /health y /v1/stats no cuentan", async () => {
    const { app } = build({ limits });
    const url = "/v1/channel?channel=@canal&max=2&output=ids";
    for (let i = 0; i < 3; i++) assert.equal((await get(app, url)).status, 200);

    const over = await get(app, url);
    assert.equal(over.status, 429);
    assert.equal(over.body.error.type, "RateLimitError");
    assert.ok(Number(over.headers["retry-after"]) >= 1);

    for (let i = 0; i < 10; i++) {
      assert.equal((await get(app, "/health")).status, 200);
      assert.equal((await get(app, "/v1/stats")).status, 200);
    }
  });

  it("/all tiene su propia cuota, mas estricta", async () => {
    const { app } = build({ limits });
    const url = "/v1/channel/all?channel=@canal&output=ids";
    assert.equal((await get(app, url)).status, 200);
    assert.equal((await get(app, url)).status, 429);
    // la cuota de paginas sigue intacta
    assert.equal((await get(app, "/v1/channel?channel=@canal&max=2&output=ids")).status, 200);
  });

  it("IPs distintas tienen cuotas distintas", async () => {
    const yt = new FakeYouTube({ ids: vids(1, 12), pageSize: 5 });
    const cache = new ListingCache({ factory: (k) => new ChannelListing({ ...k, sessionFactory: yt.session }) });
    const app = buildApp({
      service: new ChannelService(cache, { prefetchAhead: 0 }),
      limits,
      trustProxy: true,
      logger: false,
    });
    const hit = (ip: string) =>
      app.inject({ method: "GET", url: "/v1/channel?channel=@canal&max=2", headers: { "x-forwarded-for": ip } });
    for (let i = 0; i < 3; i++) assert.equal((await hit("10.0.0.1")).statusCode, 200);
    assert.equal((await hit("10.0.0.1")).statusCode, 429);
    assert.equal((await hit("10.0.0.2")).statusCode, 200);
  });
});
