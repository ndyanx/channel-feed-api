import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildApp } from "../src/app.js";
import { ListingCache } from "../src/cache.js";
import { ChannelListing } from "../src/extractor.js";
import { UpstreamGate } from "../src/gate.js";
import {
  ChannelSearch,
  SearchCache,
  SearchService,
  extractAvatars,
  normalizeSearchQuery,
  parseChannelRenderer,
  parseSearchPage,
  parseSubscribers,
} from "../src/search.js";
import { ChannelService } from "../src/service.js";
import { FakeSearchYouTube, channelRenderer, channels, cid } from "./fakeSearch.js";

function build(yt: FakeSearchYouTube, opts: { now?: () => number; ttlMs?: number } = {}) {
  const cache = new SearchCache({
    factory: (query) => new ChannelSearch({ query, sessionFactory: yt.session, now: opts.now }),
    ttlMs: opts.ttlMs,
    now: opts.now,
  });
  const chan = new ListingCache({ factory: (k) => new ChannelListing({ ...k }) });
  const app = buildApp({
    service: new ChannelService(chan, { prefetchAhead: 0 }),
    search: new SearchService(cache),
    logger: false,
  });
  return { app, yt };
}

const get = async (app: ReturnType<typeof build>["app"], url: string) => {
  const res = await app.inject({ method: "GET", url });
  return { status: res.statusCode, body: res.json() };
};

describe("parseSubscribers", () => {
  it("lee abreviaturas en ingles y espanol", () => {
    assert.equal(parseSubscribers("36.3K subscribers"), 36300);
    assert.equal(parseSubscribers("1.45 K suscriptores"), 1450);
    assert.equal(parseSubscribers("36.3 k suscriptores"), 36300);
    assert.equal(parseSubscribers("2.1M subscribers"), 2_100_000);
    assert.equal(parseSubscribers("1.2B subscribers"), 1_200_000_000);
    assert.equal(parseSubscribers("5 mil suscriptores"), 5000);
  });
  it("numeros sin abreviar y singular", () => {
    assert.equal(parseSubscribers("284 subscribers"), 284);
    assert.equal(parseSubscribers("1 subscriber"), 1);
    assert.equal(parseSubscribers("1 suscriptor"), 1);
    assert.equal(parseSubscribers("1,234 subscribers"), 1234);
    assert.equal(parseSubscribers("1.234 suscriptores"), 1234);
  });
  it("devuelve null si no hay numero", () => {
    assert.equal(parseSubscribers(null), null);
    assert.equal(parseSubscribers(""), null);
    assert.equal(parseSubscribers("@handle"), null);
    assert.equal(parseSubscribers("No subscribers"), null);
  });
});

describe("normalizeSearchQuery", () => {
  it("minusculas y espacios colapsados", () => {
    assert.equal(normalizeSearchQuery("  Calming   CORNER "), "calming corner");
  });
});

describe("parseChannelRenderer (forma real de YouTube)", () => {
  it("los campos cruzados: handle en subscriberCountText, suscriptores en videoCountText", () => {
    const real = {
      channelId: "UCviaNX80vacpLyFUNSDLzZQ",
      title: { simpleText: "calming corner ASMR" },
      navigationEndpoint: { browseEndpoint: { browseId: "UCviaNX80vacpLyFUNSDLzZQ", canonicalBaseUrl: "/@calming_cornerASMR" } },
      thumbnail: {
        thumbnails: [
          { url: "//yt3.ggpht.com/ABBf=s88-c-k-c0x00ffffff-no-rj-mo", width: 88, height: 88 },
          { url: "//yt3.ggpht.com/ABBf=s176-c-k-c0x00ffffff-no-rj-mo", width: 176, height: 176 },
        ],
      },
      descriptionSnippet: { runs: [{ text: "Just a random Russian woman" }, { text: " helping you" }] },
      videoCountText: { accessibility: { accessibilityData: { label: "36.3 mil suscriptores" } }, simpleText: "36.3 k suscriptores" },
      subscriberCountText: { simpleText: "@calming_cornerASMR" },
    };
    const hit = parseChannelRenderer(real)!;
    assert.equal(hit.id, "UCviaNX80vacpLyFUNSDLzZQ");
    assert.equal(hit.handle, "@calming_cornerASMR");
    assert.equal(hit.url, "https://www.youtube.com/@calming_cornerASMR");
    assert.equal(hit.subscribers_text, "36.3 k suscriptores");
    assert.equal(hit.subscribers, 36300);
    assert.equal(hit.description, "Just a random Russian woman helping you");
    assert.deepEqual(hit.thumbnails.map((t) => t.width), [88, 176]);
    assert.ok(hit.thumbnails.every((t) => t.url.startsWith("https://yt3.ggpht.com/")));
  });

  it("tambien funciona si YouTube arregla los nombres (campos en su sitio)", () => {
    const swapped = {
      channelId: cid(1),
      title: { simpleText: "X" },
      videoCountText: { simpleText: "@x_canal" },
      subscriberCountText: { simpleText: "2.5M subscribers" },
    };
    const hit = parseChannelRenderer(swapped)!;
    assert.equal(hit.handle, "@x_canal");
    assert.equal(hit.subscribers, 2_500_000);
  });

  it("canal sin handle, sin suscriptores y sin avatar", () => {
    const hit = parseChannelRenderer({ channelId: cid(7), title: { simpleText: "Sin nada" } })!;
    assert.equal(hit.handle, null);
    assert.equal(hit.url, `https://www.youtube.com/channel/${cid(7)}`);
    assert.equal(hit.subscribers_text, null);
    assert.equal(hit.subscribers, null);
    assert.deepEqual(hit.thumbnails, []);
    assert.equal(hit.description, "");
  });

  it("un videoCountText que no son suscriptores (\"120 videos\") no se toma como tal", () => {
    const hit = parseChannelRenderer({ channelId: cid(8), title: { simpleText: "V" }, videoCountText: { simpleText: "120 videos" } })!;
    assert.equal(hit.subscribers_text, null);
  });

  it("descarta lo que no es un canal valido", () => {
    assert.equal(parseChannelRenderer({ channelId: "nope", title: { simpleText: "x" } }), null);
    assert.equal(parseChannelRenderer(null), null);
  });

  it("extractAvatars ordena por ancho, quita repetidas y normaliza //", () => {
    const r = { thumbnail: { thumbnails: [{ url: "//a/2", width: 176, height: 176 }, { url: "//a/1", width: 88, height: 88 }, { url: "//a/1", width: 88, height: 88 }, { url: "javascript:x" }] } };
    const av = extractAvatars(r);
    assert.deepEqual(av.map((a) => a.url), ["https://a/1", "https://a/2"]);
  });
});

describe("parseSearchPage", () => {
  it("toma el token del continuationItemRenderer, no los de otros chips", () => {
    const yt = new FakeSearchYouTube({ channels: channels(1, 12), pageSize: 5 });
    const data = {
      estimatedResults: "59193",
      header: { chip: { navigationEndpoint: { clickTrackingParams: "decoy", continuationCommand: { token: "DECOY" } } } },
      contents: { sectionListRenderer: { contents: [{ itemSectionRenderer: { contents: [channelRenderer({ n: 1 })] } }, { continuationItemRenderer: { continuationEndpoint: { clickTrackingParams: "c", continuationCommand: { token: "REAL" } } } }] } },
    };
    void yt;
    const p = parseSearchPage(data);
    assert.equal(p.hits.length, 1);
    assert.deepEqual(p.next, ["c", "REAL"]);
    assert.equal(p.estimated, 59193);
  });
});

describe("GET /v1/search/channels", () => {
  it("primera pagina: items, total_estimate, has_more y cache", async () => {
    const { app, yt } = build(new FakeSearchYouTube({ channels: channels(1, 12), pageSize: 5 }));
    const { status, body } = await get(app, "/v1/search/channels?q=Calming%20Corner&max=3");
    assert.equal(status, 200);
    assert.equal(body.query, "calming corner");
    assert.equal(body.count, 3);
    assert.equal(body.offset, 0);
    assert.equal(body.total_estimate, 59193);
    assert.equal(body.has_more, true);
    assert.equal(body.cache, "miss");
    assert.match(body.updated_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(body.items.map((i: { id: string }) => i.id), [cid(1), cid(2), cid(3)]);
    assert.deepEqual(Object.keys(body.items[0]).sort(), ["description", "handle", "id", "subscribers", "subscribers_text", "thumbnails", "title", "url"]);
    assert.equal(body.items[0].handle, "@canal1");
    assert.equal(body.items[0].subscribers, 1);
    assert.deepEqual(body.items[0].thumbnails.map((t: { width: number }) => t.width), [88, 176]);
    assert.ok(body.items[0].thumbnails[0].url.startsWith("https://yt3.ggpht.com/"));
    assert.equal(yt.bodies[0]!.query, "calming corner");
    assert.equal(yt.bodies[0]!.params, "EgIQAg%3D%3D");
  });

  it("pagina siguiente sale del cache y la continuacion solo se pide cuando hace falta", async () => {
    const { app, yt } = build(new FakeSearchYouTube({ channels: channels(1, 12), pageSize: 5 }));
    await get(app, "/v1/search/channels?q=calming&max=3");
    assert.equal(yt.continuationCalls, 0);
    const b = await get(app, "/v1/search/channels?q=calming&max=3&offset=3");
    assert.equal(b.body.cache, "hit");
    assert.deepEqual(b.body.items.map((i: { id: string }) => i.id), [cid(4), cid(5), cid(6)]);
    assert.equal(yt.continuationCalls, 1);
    assert.equal(yt.bodies.at(-1)!.continuation, "stok:5");
    assert.equal((yt.bodies.at(-1)!.context as { clickTracking: { clickTrackingParams: string } }).clickTracking.clickTrackingParams, "ctp");
  });

  it("llega al final: has_more=false y la ultima pagina puede ser corta", async () => {
    const { app } = build(new FakeSearchYouTube({ channels: channels(1, 7), pageSize: 5 }));
    const { body } = await get(app, "/v1/search/channels?q=calming&max=20");
    assert.equal(body.count, 7);
    assert.equal(body.has_more, false);
  });

  it("deduplica los canales que YouTube repite entre paginas", async () => {
    const { app } = build(new FakeSearchYouTube({ channels: channels(1, 12), pageSize: 5, overlap: 2 }));
    const { body } = await get(app, "/v1/search/channels?q=calming&max=50");
    const ids = body.items.map((i: { id: string }) => i.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.deepEqual(ids, channels(1, 12).map((c) => cid(c.n)));
  });

  it("misma busqueda escrita distinto comparte cache; simultaneas comparten una descarga", async () => {
    const yt = new FakeSearchYouTube({ channels: channels(1, 12), pageSize: 5 });
    yt.delayMs = 20;
    const { app } = build(yt);
    const [a, b] = await Promise.all([
      get(app, "/v1/search/channels?q=Calming+Corner&max=3"),
      get(app, "/v1/search/channels?q=%20calming%20%20corner&max=3"),
    ]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(yt.calls.filter((c) => c.startsWith("first:")).length, 1);
  });

  it("una busqueda vencida se vuelve a hacer", async () => {
    let t = 1_000;
    const yt = new FakeSearchYouTube({ channels: channels(1, 4), pageSize: 5 });
    const { app } = build(yt, { now: () => t, ttlMs: 60_000 });
    await get(app, "/v1/search/channels?q=calming");
    t += 30_000;
    assert.equal((await get(app, "/v1/search/channels?q=calming")).body.cache, "hit");
    t += 40_000;
    assert.equal((await get(app, "/v1/search/channels?q=calming")).body.cache, "miss");
    assert.equal(yt.calls.filter((c) => c.startsWith("first:")).length, 2);
  });

  it("sin resultados: items [] y has_more=false", async () => {
    const { app } = build(new FakeSearchYouTube({ channels: [], pageSize: 5 }));
    const { status, body } = await get(app, "/v1/search/channels?q=zzzzzz");
    assert.equal(status, 200);
    assert.deepEqual(body.items, []);
    assert.equal(body.has_more, false);
  });

  it("valida parametros (400 con detalle)", async () => {
    const { app, yt } = build(new FakeSearchYouTube({ channels: channels(1, 4) }));
    for (const url of [
      "/v1/search/channels",
      "/v1/search/channels?q=",
      "/v1/search/channels?q=a",
      "/v1/search/channels?q=%20%20a%20",
      `/v1/search/channels?q=${"x".repeat(101)}`,
      "/v1/search/channels?q=ok&max=0",
      "/v1/search/channels?q=ok&max=51",
      "/v1/search/channels?q=ok&offset=-1",
    ]) {
      const { status, body } = await get(app, url);
      assert.equal(status, 400, url);
      assert.equal(body.error.type, "ValidationError");
    }
    assert.equal(yt.calls.length, 0);
  });

  it("un fallo de YouTube es 502 y no se guarda en cache", async () => {
    const yt = new FakeSearchYouTube({ channels: channels(1, 4) });
    yt.failAll = true;
    const { app } = build(yt);
    const bad = await get(app, "/v1/search/channels?q=calming");
    assert.equal(bad.status, 502);
    yt.failAll = false;
    const good = await get(app, "/v1/search/channels?q=calming");
    assert.equal(good.status, 200);
    assert.equal(good.body.cache, "miss");
  });

  it("canales sin avatar, sin handle y sin suscriptores se listan igual", async () => {
    const { app } = build(
      new FakeSearchYouTube({ channels: [{ n: 1, noThumb: true, handle: null, subs: null }, { n: 2 }] }),
    );
    const { body } = await get(app, "/v1/search/channels?q=calming");
    assert.equal(body.count, 2);
    assert.deepEqual(body.items[0].thumbnails, []);
    assert.equal(body.items[0].handle, null);
    assert.equal(body.items[0].subscribers_text, null);
  });

  it("las peticiones pasan por la cola global hacia YouTube", async () => {
    const yt = new FakeSearchYouTube({ channels: channels(1, 12), pageSize: 5 });
    const gate = new UpstreamGate({ concurrency: 1, minIntervalMs: 0, maxQueue: 10, maxWaitMs: 5000, breakerThreshold: 0, breakerCooldownMs: 0 });
    const cache = new SearchCache({ factory: (query) => new ChannelSearch({ query, sessionFactory: yt.session, gate }) });
    const chan = new ListingCache({ factory: (k) => new ChannelListing({ ...k }) });
    const app = buildApp({ service: new ChannelService(chan), search: new SearchService(cache), gate, logger: false });
    await get(app, "/v1/search/channels?q=calming&max=8");
    const stats = await get(app, "/v1/stats");
    assert.equal(stats.body.upstream.started, 2);
    assert.equal(stats.body.search.entries, 1);
  });

  it("limite por IP propio para la busqueda", async () => {
    const yt = new FakeSearchYouTube({ channels: channels(1, 4) });
    const cache = new SearchCache({ factory: (query) => new ChannelSearch({ query, sessionFactory: yt.session }) });
    const chan = new ListingCache({ factory: (k) => new ChannelListing({ ...k }) });
    const app = buildApp({
      service: new ChannelService(chan),
      search: new SearchService(cache),
      logger: false,
      limits: { page: { max: 0, windowMs: 60_000 }, all: { max: 0, windowMs: 60_000 }, search: { max: 2, windowMs: 60_000 } },
    });
    assert.equal((await get(app, "/v1/search/channels?q=calming")).status, 200);
    assert.equal((await get(app, "/v1/search/channels?q=calming")).status, 200);
    const third = await app.inject({ method: "GET", url: "/v1/search/channels?q=calming" });
    assert.equal(third.statusCode, 429);
    assert.ok(third.headers["retry-after"]);
  });

  it("sin servicio de busqueda la ruta no existe (404)", async () => {
    const chan = new ListingCache({ factory: (k) => new ChannelListing({ ...k }) });
    const app = buildApp({ service: new ChannelService(chan), logger: false });
    assert.equal((await app.inject({ method: "GET", url: "/v1/search/channels?q=calming" })).statusCode, 404);
  });
});
