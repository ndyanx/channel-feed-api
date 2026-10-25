import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildApp } from "../src/app.js";
import { ListingCache } from "../src/cache.js";
import { ChannelListing } from "../src/extractor.js";
import { ChannelService } from "../src/service.js";
import { FakeYouTube, vid, vids } from "./fakeYoutube.js";

function build(yt = new FakeYouTube({ ids: vids(1, 12), pageSize: 5 })) {
  const cache = new ListingCache({
    factory: (k) => new ChannelListing({ ...k, sessionFactory: yt.session }),
  });
  const app = buildApp({ service: new ChannelService(cache, { prefetchAhead: 0 }), logger: false });
  return { app, yt };
}

const get = async (app: ReturnType<typeof build>["app"], url: string) => {
  const res = await app.inject({ method: "GET", url });
  return { status: res.statusCode, body: res.json() };
};

describe("GET /v1/channel", () => {
  it("devuelve una pagina con total, has_more y estado del cache", async () => {
    const { app } = build();
    const { status, body } = await get(app, "/v1/channel?channel=@canal&max=3&output=ids");
    assert.equal(status, 200);
    assert.deepEqual(body.items, vids(1, 3));
    assert.equal(body.count, 3);
    assert.equal(body.offset, 0);
    assert.equal(body.total, null);
    assert.equal(body.has_more, true);
    assert.equal(body.cache, "miss");
    assert.match(body.updated_at, /^\d{4}-\d{2}-\d{2}T/);

    const next = await get(app, "/v1/channel?channel=@canal&max=3&offset=3&output=ids");
    assert.deepEqual(next.body.items, vids(4, 6));
    assert.equal(next.body.cache, "hit");
  });

  it("output=full trae id, url, thumbnails, cover, frames, animated y params", async () => {
    const { app } = build();
    const { body } = await get(app, "/v1/channel?channel=@canal&max=1");
    assert.deepEqual(
      Object.keys(body.items[0]).sort(),
      ["animated", "cover", "frames", "id", "params", "thumbnails", "url"],
    );
    assert.equal(typeof body.items[0].thumbnails[0].original, "boolean");
  });

  it("shorts: la respuesta expone cover y frames listos para el front", async () => {
    const yt = new FakeYouTube({ ids: vids(1, 2), section: "shorts" });
    const { app } = build(yt);
    const { body } = await get(app, "/v1/channel?channel=@canal&section=shorts&max=1");
    const item = body.items[0];
    assert.equal(item.thumbnails.length, 8);
    assert.equal(item.frames.length, 4);
    assert.equal(item.frames[0], item.cover.url);
  });

  it("reverse=false por defecto; reverse=true invierte", async () => {
    const { app } = build();
    const rev = await get(app, "/v1/channel?channel=@canal&reverse=true&max=2&output=ids");
    assert.deepEqual(rev.body.items, [vid(12), vid(11)]);
    assert.equal(rev.body.total, 12);
  });

  it("valida parametros (400 con detalle)", async () => {
    const { app } = build();
    for (const url of [
      "/v1/channel",
      "/v1/channel?channel=@canal&max=0",
      "/v1/channel?channel=@canal&offset=-1",
      "/v1/channel?channel=@canal&section=nada",
      "/v1/channel?channel=@canal&limit_id=corto",
      "/v1/channel?channel=@canal&section=streams&members=only",
    ]) {
      const { status, body } = await get(app, url);
      assert.equal(status, 400, url);
      assert.equal(body.error.type, "ValidationError");
      assert.ok(body.error.issues.length > 0);
    }
  });

  it("acepta alias de seccion y shorts devuelve urls /shorts/", async () => {
    const yt = new FakeYouTube({ ids: vids(1, 3), section: "shorts" });
    const { app } = build(yt);
    const { status, body } = await get(app, "/v1/channel?channel=@canal&section=short&output=urls");
    assert.equal(status, 200);
    assert.equal(body.section, "shorts");
    assert.equal(body.items[0], `https://www.youtube.com/shorts/${vid(1)}`);
  });

  it("canal inexistente -> 404; YouTube caido -> 502", async () => {
    const { app, yt } = build();
    yt.channelExists = false;
    assert.equal((await get(app, "/v1/channel?channel=@canal")).status, 404);
    yt.channelExists = true;
    yt.failAll = true;
    const r = await get(app, "/v1/channel?channel=@canal");
    assert.equal(r.status, 502);
    assert.equal(r.body.error.type, "UpstreamError");
  });
});

describe("GET /v1/channel/all", () => {
  it("devuelve todo con complete=true", async () => {
    const { app } = build();
    const { status, body } = await get(app, "/v1/channel/all?channel=@canal&output=ids");
    assert.equal(status, 200);
    assert.deepEqual(body.items, vids(1, 12));
    assert.equal(body.count, 12);
    assert.equal(body.complete, true);
    assert.equal(body.cache, "miss");
  });

  it("max y limit_id cortan; refresh=true fuerza descarga nueva; stale=ok se valida", async () => {
    const { app } = build();
    const cut = await get(app, "/v1/channel/all?channel=@canal&max=4&output=ids");
    assert.deepEqual(cut.body.items, vids(1, 4));
    assert.equal(cut.body.complete, false);

    const lim = await get(app, `/v1/channel/all?channel=@canal&limit_id=${vid(2)}&output=ids`);
    assert.deepEqual(lim.body.items, vids(1, 2));

    const forced = await get(app, "/v1/channel/all?channel=@canal&refresh=true&output=ids");
    assert.equal(forced.body.cache, "refresh");

    assert.equal((await get(app, "/v1/channel/all?channel=@canal&stale=ok")).status, 200);
    assert.equal((await get(app, "/v1/channel/all?channel=@canal&stale=no")).status, 400);
  });
});

it("GET /health", async () => {
  const { app } = build();
  assert.deepEqual((await get(app, "/health")).body, { ok: true });
});

describe("health (monitores de uptime)", () => {
  for (const url of ["/health", "/"]) {
    for (const method of ["GET", "HEAD"] as const) {
      it(`${method} ${url} responde 200 sin llamar a YouTube`, async () => {
        const { app, yt } = build();
        const res = await app.inject({ method, url });
        assert.equal(res.statusCode, 200);
        if (method === "HEAD") assert.equal(res.body, "");
        else assert.equal(res.json().ok, true);
        assert.equal(yt.calls.length, 0);
      });
    }
  }
});
