import type { HttpSession } from "../src/extractor.js";

/** Id de canal valido (UC + 22): cid(1) = "UC00000000000000000000001" no, son 24 caracteres en total. */
export const cid = (n: number) => `UC${String(n).padStart(22, "0")}`;

export interface FakeChannel {
  n: number;
  title?: string;
  /** Texto de @handle que YouTube pone en `subscriberCountText` (los campos vienen cruzados). */
  handle?: string | null;
  /** Texto que YouTube pone en `videoCountText` (en realidad: suscriptores). null = canal sin dato. */
  subs?: string | null;
  description?: string;
  noThumb?: boolean;
}

/** channelRenderer con la forma REAL de YouTube (recortado): subscriberCountText = @handle, videoCountText = suscriptores. */
export function channelRenderer(c: FakeChannel): unknown {
  const id = cid(c.n);
  const handle = c.handle === undefined ? `@canal${c.n}` : c.handle;
  const title = c.title ?? `Canal ${c.n}`;
  const subs = c.subs === undefined ? `${c.n} subscribers` : c.subs;
  const base = `//yt3.ggpht.com/AVATAR${c.n}`;
  return {
    channelRenderer: {
      channelId: id,
      title: { simpleText: title },
      navigationEndpoint: {
        browseEndpoint: { browseId: id, ...(handle ? { canonicalBaseUrl: `/${handle}` } : { canonicalBaseUrl: `/channel/${id}` }) },
      },
      ...(c.noThumb
        ? {}
        : {
            thumbnail: {
              thumbnails: [
                { url: `${base}=s176-c-k-c0x00ffffff-no-rj-mo`, width: 176, height: 176 },
                { url: `${base}=s88-c-k-c0x00ffffff-no-rj-mo`, width: 88, height: 88 },
              ],
            },
          }),
      ...(c.description ? { descriptionSnippet: { runs: [{ text: c.description }] } } : {}),
      ...(subs ? { videoCountText: { simpleText: subs } } : {}),
      ...(handle ? { subscriberCountText: { simpleText: handle } } : {}),
      subscribeButton: { buttonRenderer: { text: { runs: [{ text: "Subscribe" }] } } },
    },
  };
}

export interface FakeSearchOptions {
  channels: FakeChannel[];
  pageSize?: number;
  estimated?: string;
  /** Cuantos canales del inicio de cada pagina siguiente repiten a los del final de la anterior. */
  overlap?: number;
}

/**
 * YouTube de mentira para `youtubei/v1/search`. Tokens: "stok:<offset>". La respuesta incluye
 * un `continuationCommand` de relleno en la cabecera (chips de filtros) que NO debe usarse para paginar.
 */
export class FakeSearchYouTube {
  channels: FakeChannel[];
  pageSize: number;
  estimated: string;
  overlap: number;
  failAll = false;
  delayMs = 0;

  calls: string[] = [];
  bodies: Record<string, unknown>[] = [];
  sessionsClosed = 0;

  constructor(o: FakeSearchOptions) {
    this.channels = o.channels;
    this.pageSize = o.pageSize ?? 5;
    this.estimated = o.estimated ?? "59193";
    this.overlap = o.overlap ?? 0;
  }

  get continuationCalls(): number {
    return this.calls.filter((c) => c.startsWith("cont:")).length;
  }

  session = (): HttpSession => ({
    post: async (url, options) => {
      if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
      const endpoint = url.split("/v1/")[1]!;
      const body = (options as { json: Record<string, unknown> }).json;
      this.bodies.push(body);
      const ok = (json: unknown) => ({ status: 200, json: <T>() => json as T });
      if (this.failAll) return { status: 500, json: <T>() => ({}) as T };
      if (endpoint !== "search") return { status: 404, json: <T>() => ({}) as T };

      if (typeof body.continuation === "string") {
        const offset = Number(body.continuation.split(":")[1]);
        this.calls.push(`cont:${offset}`);
        return ok({
          responseContext: { visitorData: "VISITOR-S" },
          onResponseReceivedCommands: [
            { appendContinuationItemsAction: { continuationItems: this.items(offset) } },
          ],
        });
      }
      this.calls.push(`first:${String(body.query)}`);
      return ok({
        responseContext: { visitorData: "VISITOR-S" },
        estimatedResults: this.estimated,
        header: {
          searchHeaderRenderer: {
            chipBar: { chipCloudChipRenderer: { navigationEndpoint: { clickTrackingParams: "decoy", continuationCommand: { token: "DECOY" } } } },
          },
        },
        contents: {
          twoColumnSearchResultsRenderer: {
            primaryContents: { sectionListRenderer: { contents: this.items(0) } },
          },
        },
      });
    },
    close: async () => {
      this.sessionsClosed++;
    },
  });

  private items(offset: number): unknown[] {
    const from = Math.max(0, offset > 0 ? offset - this.overlap : offset);
    const slice = this.channels.slice(from, offset + this.pageSize);
    const out: unknown[] = [{ itemSectionRenderer: { contents: slice.map(channelRenderer) } }];
    const next = offset + this.pageSize;
    if (next < this.channels.length) {
      out.push({
        continuationItemRenderer: {
          continuationEndpoint: { clickTrackingParams: "ctp", continuationCommand: { token: `stok:${next}` } },
        },
      });
    }
    return out;
  }
}

export const channels = (from: number, to: number): FakeChannel[] =>
  Array.from({ length: to - from + 1 }, (_, i) => ({ n: from + i }));
