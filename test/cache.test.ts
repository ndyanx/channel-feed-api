import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { ListingCache, type ListingKey } from "../src/cache.js";
import { ChannelError, ChannelListing, UpstreamError } from "../src/extractor.js";
import { ChannelService } from "../src/service.js";
import { FakeYouTube, vid, vids } from "./fakeYoutube.js";

const MIN = 60_000;
const KEY: ListingKey = { channel: "@canal", section: "videos", sortBy: "newest", members: "all" };
const ID = (items: { id: string }[]) => items.map((e) => e.id);

let t = 0;
const now = () => t;

function setup(opts: { total?: number; prefetchAhead?: number; maxEntries?: number } = {}) {
  t = 0;
  const yt = new FakeYouTube({ ids: vids(1, opts.total ?? 12), pageSize: 5 });
  const cache = new ListingCache({
    factory: (k) => new ChannelListing({ ...k, sessionFactory: yt.session, now }),
    ttlMs: 10 * MIN,
    maxEntries: opts.maxEntries,
    now,
  });
  const service = new ChannelService(cache, { prefetchAhead: opts.prefetchAhead ?? 0 });
  return { yt, cache, service };
}

const pageArgs = { offset: 0, max: 3, reverse: false } as const;
const allArgs = { reverse: false, refresh: false, staleOk: false } as const;

describe("page (GET /v1/channel)", () => {
  it("descarga solo lo necesario y las paginas siguientes salen del cache", async () => {
    const { yt, service } = setup();

    const a = await service.page(KEY, { ...pageArgs, offset: 0, max: 3 });
    assert.deepEqual(ID(a.items), vids(1, 3));
    assert.equal(a.cache, "miss");
    assert.equal(a.total, null);
    assert.equal(a.hasMore, true);
    assert.deepEqual(yt.calls, ["resolve", "tab"]);

    const b = await service.page(KEY, { ...pageArgs, offset: 3, max: 2 }); // dentro de lo ya bajado
    assert.deepEqual(ID(b.items), vids(4, 5));
    assert.equal(b.cache, "hit");
    assert.deepEqual(yt.calls, ["resolve", "tab"]);

    const c = await service.page(KEY, { ...pageArgs, offset: 5, max: 4 }); // pide mas: 1 pagina
    assert.deepEqual(ID(c.items), vids(6, 9));
    assert.deepEqual(yt.calls, ["resolve", "tab", "cont:5"]);
  });

  it("al llegar al final informa total y has_more=false", async () => {
    const { service } = setup();
    const r = await service.page(KEY, { ...pageArgs, offset: 8, max: 10 });
    assert.deepEqual(ID(r.items), vids(9, 12));
    assert.equal(r.total, 12);
    assert.equal(r.hasMore, false);
    const beyond = await service.page(KEY, { ...pageArgs, offset: 50, max: 10 });
    assert.deepEqual(beyond.items, []);
    assert.equal(beyond.hasMore, false);
  });

  it("reverse y limit_id trabajan sobre la lista completa / cortada", async () => {
    const { yt, service } = setup();
    const lim = await service.page(KEY, { offset: 0, max: 100, reverse: true, limitId: vid(5) });
    assert.deepEqual(ID(lim.items), [5, 4, 3, 2, 1].map(vid));
    assert.equal(lim.total, 5);
    assert.equal(yt.continuationCalls, 0);

    const rev = await service.page(KEY, { offset: 0, max: 3, reverse: true });
    assert.deepEqual(ID(rev.items), [12, 11, 10].map(vid));
    assert.equal(rev.total, 12);
    assert.equal(rev.hasMore, true);
  });

  it("prefetch: tras responder baja mas paginas en segundo plano", async () => {
    const { yt, cache, service } = setup({ total: 30, prefetchAhead: 10 });
    await service.page(KEY, { ...pageArgs, offset: 0, max: 3 });
    await cache.whenIdle();
    // pidio 3, mas 10 de colchon => 13 => 3 paginas de 5 (tab + 2 continuaciones)
    assert.equal(yt.continuationCalls, 2);
    yt.reset();
    const r = await service.page(KEY, { ...pageArgs, offset: 3, max: 10 });
    assert.equal(r.items.length, 10);
    assert.equal(r.cache, "hit");
    assert.ok(!yt.calls.includes("cont:10")); // la respuesta salio de lo ya bajado
    await cache.whenIdle();
    assert.deepEqual(yt.calls, ["cont:15", "cont:20"]); // y el colchon sigue avanzando
  });

  it("peticiones simultaneas del mismo canal comparten una sola descarga", async () => {
    const { yt, service } = setup();
    yt.delayMs = 5;
    const rs = await Promise.all([
      service.page(KEY, pageArgs),
      service.page(KEY, pageArgs),
      service.page(KEY, pageArgs),
    ]);
    assert.ok(rs.every((r) => r.items.length === 3));
    assert.deepEqual(yt.calls, ["resolve", "tab"]);
  });

  it("los @handle no distinguen mayusculas", async () => {
    const { yt, service } = setup();
    await service.page({ ...KEY, channel: "@Canal" }, pageArgs);
    const r = await service.page({ ...KEY, channel: "@CANAL" }, pageArgs);
    assert.equal(r.cache, "hit");
    assert.equal(yt.calls.filter((c) => c === "tab").length, 1);
  });
});

describe("cache: frescura", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it("vencido: sirve lo viejo al instante y refresca por detras", async () => {
    const { yt, cache, service } = ctx;
    const first = await service.page(KEY, { ...pageArgs, max: 10 });
    assert.equal(first.items.length, 10);

    yt.ids = [vid(99), ...yt.ids]; // aparece un video nuevo
    t = 11 * MIN;
    yt.reset();

    const stale = await service.page(KEY, { ...pageArgs, max: 3 });
    assert.equal(stale.cache, "stale");
    assert.deepEqual(ID(stale.items), vids(1, 3)); // aun la lista vieja

    await cache.whenIdle();
    const fresh = await service.page(KEY, { ...pageArgs, max: 3 });
    assert.equal(fresh.cache, "hit");
    assert.deepEqual(ID(fresh.items), [vid(99), vid(1), vid(2)]);
    assert.equal(fresh.updatedAt, 11 * MIN);
    assert.equal(yt.calls.filter((c) => c === "tab").length, 1); // un solo refresco
  });

  it("varias peticiones con el cache vencido disparan un unico refresco", async () => {
    const { yt, cache, service } = ctx;
    await service.page(KEY, pageArgs);
    t = 11 * MIN;
    yt.reset();
    yt.delayMs = 5;
    await Promise.all([service.page(KEY, pageArgs), service.page(KEY, pageArgs), service.page(KEY, pageArgs)]);
    await cache.whenIdle();
    assert.equal(yt.calls.filter((c) => c === "tab").length, 1);
  });

  it("si el refresco falla sigue sirviendo lo viejo y espera antes de reintentar", async () => {
    const { yt, cache, service } = ctx;
    await service.page(KEY, pageArgs);
    t = 11 * MIN;
    yt.failAll = true;
    yt.reset();

    const a = await service.page(KEY, pageArgs);
    assert.equal(a.cache, "stale");
    await cache.whenIdle();
    const opened = yt.sessionsOpened; // las peticiones fallidas no se registran: se cuentan sesiones

    const b = await service.page(KEY, pageArgs); // dentro del backoff: no reintenta
    assert.equal(b.cache, "stale");
    assert.deepEqual(ID(b.items), vids(1, 3));
    await cache.whenIdle();
    assert.equal(yt.sessionsOpened, opened);

    t = 11 * MIN + 31_000; // pasado el backoff y con YouTube de vuelta
    yt.failAll = false;
    await service.page(KEY, pageArgs);
    await cache.whenIdle();
    const c = await service.page(KEY, pageArgs);
    assert.equal(c.cache, "hit");
    assert.equal(c.updatedAt, 0); // la lista no cambio: updated_at se conserva
  });

  it("un fallo en la primera descarga no se guarda en cache", async () => {
    const { yt, cache, service } = setup();
    yt.channelExists = false;
    await assert.rejects(service.page(KEY, pageArgs), ChannelError);
    assert.equal(cache.size, 0);
    yt.channelExists = true;
    const r = await service.page(KEY, pageArgs);
    assert.equal(r.cache, "miss");
    assert.equal(r.items.length, 3);
  });

  it("limita las entradas (LRU)", async () => {
    const { yt, cache, service } = setup({ maxEntries: 2 });
    for (const c of ["@uno", "@dos", "@tres"]) await service.page({ ...KEY, channel: c }, pageArgs);
    assert.equal(cache.size, 2);
    yt.reset();
    const again = await service.page({ ...KEY, channel: "@uno" }, pageArgs); // fue expulsado
    assert.equal(again.cache, "miss");
  });
});

describe("all (GET /v1/channel/all)", () => {
  it("devuelve la lista completa y la deja en cache para el resto", async () => {
    const { yt, service } = setup();
    const r = await service.all(KEY, allArgs);
    assert.deepEqual(ID(r.items), vids(1, 12));
    assert.equal(r.complete, true);
    assert.equal(r.cache, "miss");

    yt.reset();
    const p = await service.page(KEY, { ...pageArgs, offset: 10, max: 5 });
    assert.deepEqual(ID(p.items), vids(11, 12));
    assert.equal(p.total, 12);
    assert.deepEqual(yt.calls, []);
  });

  it("aprovecha lo que el masonry ya bajo: solo completa lo que falta", async () => {
    const { yt, service } = setup();
    await service.page(KEY, pageArgs); // resolve + tab
    yt.reset();
    const r = await service.all(KEY, allArgs);
    assert.equal(r.items.length, 12);
    assert.deepEqual(yt.calls, ["cont:5", "cont:10"]);
  });

  it("max y limit_id cortan y marcan complete=false", async () => {
    const { service } = setup();
    const m = await service.all(KEY, { ...allArgs, max: 4 });
    assert.deepEqual(ID(m.items), vids(1, 4));
    assert.equal(m.complete, false);
    const l = await service.all(KEY, { ...allArgs, limitId: vid(7) });
    assert.deepEqual(ID(l.items), vids(1, 7));
    assert.equal(l.complete, false);
  });

  it("vencido: espera datos frescos; con stale=ok responde lo viejo", async () => {
    const { yt, cache, service } = setup();
    await service.all(KEY, allArgs);
    yt.ids = [vid(99), ...yt.ids];
    t = 11 * MIN;

    const old = await service.all(KEY, { ...allArgs, staleOk: true });
    assert.equal(old.cache, "stale");
    assert.equal(old.items[0]!.id, vid(1));
    await cache.whenIdle();

    t = 22 * MIN; // vuelve a vencer
    const fresh = await service.all(KEY, allArgs);
    assert.equal(fresh.cache, "refresh");
    assert.equal(fresh.items[0]!.id, vid(99));
    assert.equal(fresh.items.length, 13);
    assert.equal(fresh.complete, true);
  });

  it("refresh=true ignora el cache aunque este fresco", async () => {
    const { yt, service } = setup();
    await service.all(KEY, allArgs);
    yt.ids = [vid(99), ...yt.ids];
    const r = await service.all(KEY, { ...allArgs, refresh: true });
    assert.equal(r.cache, "refresh");
    assert.equal(r.items[0]!.id, vid(99));
  });

  it("si la descarga fresca falla, sirve lo viejo mientras no pase staleIfError", async () => {
    const { yt, service } = setup();
    await service.all(KEY, allArgs);
    t = 11 * MIN;
    yt.failAll = true;
    const r = await service.all(KEY, allArgs);
    assert.equal(r.cache, "stale");
    assert.equal(r.items.length, 12);
  });

  it("si la descarga fresca falla y lo viejo supera staleIfError, devuelve el error", async () => {
    const { yt, service } = setup();
    await service.all(KEY, allArgs);
    t = 25 * 60 * MIN; // 25 h
    yt.failAll = true;
    await assert.rejects(service.all(KEY, allArgs), UpstreamError);
  });
});

describe("cache: updated_at por contenido", () => {
  it("un refresco con la misma lista conserva updated_at; uno con video nuevo lo cambia", async () => {
    const { yt, cache, service } = setup();
    const first = await service.page(KEY, pageArgs);
    assert.equal(first.updatedAt, 0);

    t = 11 * MIN; // vencida, mismo contenido
    await service.page(KEY, pageArgs);
    await cache.whenIdle();
    const same = await service.page(KEY, pageArgs);
    assert.equal(same.cache, "hit");
    assert.equal(same.updatedAt, 0);

    yt.ids = [vid(99), ...yt.ids]; // video nuevo
    t = 22 * MIN;
    await service.page(KEY, pageArgs);
    await cache.whenIdle();
    const changed = await service.page(KEY, pageArgs);
    assert.equal(changed.updatedAt, 22 * MIN);
    assert.equal(ID(changed.items)[0], vid(99));
  });
});

describe("cache: edad maxima del stale", () => {
  it("pasado maxStaleMs espera datos frescos aunque acepte stale", async () => {
    const { yt, service } = setup();
    await service.all(KEY, { ...allArgs, staleOk: true });
    yt.ids = [vid(99), ...yt.ids];
    t = 7 * 60 * MIN; // 7 h > 6 h
    const r = await service.all(KEY, { ...allArgs, staleOk: true });
    assert.equal(r.cache, "refresh");
    assert.equal(r.items[0]!.id, vid(99));
  });

  it("un canal que ya no existe da 404 en vez de servir lo viejo", async () => {
    const { yt, cache, service } = setup();
    await service.all(KEY, allArgs);
    yt.channelExists = false;
    t = 11 * MIN;
    await assert.rejects(service.all(KEY, allArgs), ChannelError);
    assert.equal(cache.size, 0);
  });
});

describe("cache: limite de items", () => {
  it("expulsa lo menos usado cuando el total supera maxItems", async () => {
    t = 0;
    const yt = new FakeYouTube({ ids: vids(1, 12), pageSize: 5 });
    const cache = new ListingCache({
      factory: (k) => new ChannelListing({ ...k, sessionFactory: yt.session, now }),
      maxItems: 20,
      now,
    });
    const service = new ChannelService(cache, { prefetchAhead: 0 });
    const A: ListingKey = { ...KEY, channel: "@canal_a" };
    const B: ListingKey = { ...KEY, channel: "@canal_b" };
    const C: ListingKey = { ...KEY, channel: "@canal_c" };
    await service.all(A, allArgs); // 12 items
    await service.all(B, allArgs); // 24 > 20, pero B es la que se usa: se expulsa A en el siguiente acquire
    await service.page(B, pageArgs);
    assert.equal(cache.size, 1);
    await service.all(C, allArgs);
    await service.page(C, pageArgs);
    assert.equal(cache.size, 1);
    assert.ok(cache.itemCount <= 20);
  });
});
