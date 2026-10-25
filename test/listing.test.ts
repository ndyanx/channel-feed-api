import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ChannelError,
  ChannelListing,
  InputError,
  UpstreamError,
  listChannel,
  materialize,
} from "../src/extractor.js";
import { FakeYouTube, vid, vids } from "./fakeYoutube.js";

const make = (yt: FakeYouTube, extra: Record<string, unknown> = {}) =>
  new ChannelListing({ channel: "@canal", section: yt.section as "videos", sessionFactory: yt.session, ...extra });

const ids = (l: ChannelListing) => l.entries.map((e) => e.id);

describe("ChannelListing", () => {
  it("baja solo las paginas necesarias y se puede reanudar", async () => {
    const yt = new FakeYouTube({ ids: vids(1, 12), pageSize: 5 });
    const l = make(yt);

    await l.extend(() => l.entries.length >= 3);
    assert.equal(l.entries.length, 5); // pagina completa
    assert.equal(l.complete, false);
    assert.deepEqual(yt.calls, ["resolve", "tab"]);

    await l.extend(() => l.entries.length >= 7);
    assert.equal(l.entries.length, 10);
    assert.deepEqual(yt.calls, ["resolve", "tab", "cont:5"]);

    await l.extend(() => false); // hasta el final
    assert.equal(l.complete, true);
    assert.deepEqual(ids(l), vids(1, 12));
    assert.deepEqual(yt.calls, ["resolve", "tab", "cont:5", "cont:10"]);

    const before = yt.calls.length;
    await l.extend(() => false); // ya completo: no hace nada
    assert.equal(yt.calls.length, before);
  });

  it("quita duplicados entre paginas conservando la primera aparicion", async () => {
    const yt = new FakeYouTube({ ids: [...vids(1, 5), vid(3), vid(6), vid(1), vid(7)], pageSize: 5 });
    const l = make(yt);
    await l.extend(() => false);
    assert.deepEqual(ids(l), [1, 2, 3, 4, 5, 6, 7].map(vid));
  });

  it("si una pagina falla no pierde el estado y se puede reintentar", async () => {
    const yt = new FakeYouTube({ ids: vids(1, 12), pageSize: 5 });
    const l = make(yt);
    await l.extend(() => true);

    yt.failContinuations = 1;
    await assert.rejects(l.extend(() => false), UpstreamError);
    assert.equal(l.entries.length, 5);
    assert.equal(l.complete, false);

    await l.extend(() => false);
    assert.deepEqual(ids(l), vids(1, 12));
  });

  it("reutiliza el visitorData entre rafagas y cierra cada sesion", async () => {
    const yt = new FakeYouTube({ ids: vids(1, 12), pageSize: 5 });
    const l = make(yt);
    await l.extend(() => true);
    await l.extend(() => l.entries.length >= 10);
    assert.equal(yt.visitorHeaders[0], undefined); // primera rafaga: aun no hay visitante
    assert.equal(yt.visitorHeaders.at(-1), "VISITOR-1"); // la segunda ya lo manda
    assert.equal(yt.sessionsOpened, 2);
    assert.equal(yt.sessionsClosed, 2);
  });

  it("dos extend simultaneos no piden la misma pagina dos veces", async () => {
    const yt = new FakeYouTube({ ids: vids(1, 12), pageSize: 5 });
    yt.delayMs = 5;
    const l = make(yt);
    await Promise.all([l.extend(() => l.entries.length >= 10), l.extend(() => l.entries.length >= 10)]);
    assert.deepEqual(yt.calls, ["resolve", "tab", "cont:5"]);
  });

  it("canal inexistente -> ChannelError; members en streams -> InputError", async () => {
    const yt = new FakeYouTube({ ids: [] });
    yt.channelExists = false;
    await assert.rejects(make(yt).extend(() => true), ChannelError);
    assert.throws(() => new ChannelListing({ channel: "@abc", section: "streams", members: "only" }), InputError);
  });

  it("shorts: cada tamaño trae oardefault, oar1, oar2 y oar3", async () => {
    const yt = new FakeYouTube({ ids: vids(1, 2), section: "shorts" });
    const l = make(yt);
    await l.extend(() => true);
    const t = l.entries[0]!.thumbnails;
    assert.equal(t.length, 8);
    assert.deepEqual(
      t.filter((x) => x.height === 720).map((x) => x.url.match(/\/(oar\w+)\.jpg/)![1]),
      ["oardefault", "oar1", "oar2", "oar3"],
    );
    assert.ok(l.entries[0]!.url.startsWith("https://www.youtube.com/shorts/"));
  });

  it("shorts: solo la que mando YouTube es original; cover y frames del tamaño mayor", async () => {
    const yt = new FakeYouTube({ ids: vids(1, 1), section: "shorts", variant: "oar3" });
    const l = make(yt);
    await l.extend(() => true);
    const e = l.entries[0]!;

    // 2 originales (una por tamaño) y 6 inferidas
    assert.equal(e.thumbnails.filter((x) => x.original).length, 2);
    assert.ok(e.thumbnails.filter((x) => x.original).every((x) => x.url.includes("/oar3.jpg")));

    // cover = la mayor original (405x720), y existe seguro
    assert.equal(e.cover?.width, 405);
    assert.equal(e.cover?.height, 720);
    assert.ok(e.cover!.url.includes("/oar3.jpg"));
    assert.ok(e.thumbnails.find((x) => x.url === e.cover!.url)!.original);

    // frames = mismo tamaño, cover primero y luego el resto en orden fijo
    const names = e.frames.map((u) => u.match(/\/(oar\w+)\.jpg/)![1]);
    assert.deepEqual(names, ["oar3", "oardefault", "oar1", "oar2"]);
    assert.ok(e.frames.every((u) => u.includes("rs=SIG720")));
  });

  it("shorts: si YouTube manda oardefault, frames empieza por ahi", async () => {
    const yt = new FakeYouTube({ ids: vids(1, 1), section: "shorts", variant: "oardefault" });
    const l = make(yt);
    await l.extend(() => true);
    const names = l.entries[0]!.frames.map((u) => u.match(/\/(oar\w+|oardefault)\.jpg/)![1]);
    assert.deepEqual(names, ["oardefault", "oar1", "oar2", "oar3"]);
  });

  it("shorts con una sola miniatura (hq720): se deja tal cual, sin frames", async () => {
    const yt = new FakeYouTube({ ids: vids(1, 1), section: "shorts", shortStyle: "single" });
    const l = make(yt);
    await l.extend(() => true);
    const e = l.entries[0]!;
    assert.equal(e.thumbnails.length, 1);
    assert.equal(e.thumbnails[0]!.original, true);
    assert.ok(e.thumbnails[0]!.url.includes("/hq720.jpg"));
    assert.deepEqual(e.cover, { url: e.thumbnails[0]!.url, width: 405, height: 720 });
    assert.deepEqual(e.frames, []);
  });

  it("videos: todas original, cover = la mas grande, sin frames", async () => {
    const yt = new FakeYouTube({ ids: vids(1, 1) });
    const l = make(yt);
    await l.extend(() => true);
    const e = l.entries[0]!;
    assert.equal(e.thumbnails.length, 2);
    assert.ok(e.thumbnails.every((x) => x.original));
    assert.deepEqual(e.thumbnails.map((x) => x.width), [320, 480]); // de menor a mayor
    assert.equal(e.cover?.width, 480);
    assert.deepEqual(e.frames, []);
  });
});

describe("materialize / listChannel", () => {
  it("limit_id corta (inclusive) y descarga solo hasta encontrarlo", async () => {
    const yt = new FakeYouTube({ ids: vids(1, 12), pageSize: 5 });
    const l = make(yt);
    const v = await materialize(l, { limitId: vid(3) });
    assert.deepEqual(v.items.map((e) => e.id), vids(1, 3));
    assert.equal(v.complete, false);
    assert.equal(yt.continuationCalls, 0);
  });

  it("cap + reverse = los N primeros, de mas antiguo a mas nuevo", async () => {
    const yt = new FakeYouTube({ ids: vids(1, 12), pageSize: 5 });
    const v = await materialize(make(yt), { cap: 4, reverse: true });
    assert.deepEqual(v.items.map((e) => e.id), [4, 3, 2, 1].map(vid));
  });

  it("sin limites devuelve todo y marca complete", async () => {
    const yt = new FakeYouTube({ ids: vids(1, 12), pageSize: 5 });
    const v = await materialize(make(yt), {});
    assert.equal(v.items.length, 12);
    assert.equal(v.complete, true);
  });

  it("limit_id inexistente devuelve todo (como el script original)", async () => {
    const yt = new FakeYouTube({ ids: vids(1, 7), pageSize: 5 });
    const v = await materialize(make(yt), { limitId: "zzzzzzzzzzz" });
    assert.equal(v.items.length, 7);
    assert.equal(v.complete, true);
  });

  it("listChannel (atajo): reverse es false por defecto", async () => {
    const yt = new FakeYouTube({ ids: vids(1, 7), pageSize: 5 });
    const items = await listChannel({ channel: "@canal", sessionFactory: yt.session });
    assert.deepEqual(items.map((e) => e.id), vids(1, 7));
    const rev = await listChannel({ channel: "@canal", sessionFactory: yt.session, reverse: true });
    assert.deepEqual(rev.map((e) => e.id), vids(1, 7).reverse());
  });
});
