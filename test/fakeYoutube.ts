import type { HttpSession } from "../src/extractor.js";

/** Id de 11 caracteres valido para limit_id: vid(1) = "v0000000001". */
export const vid = (n: number) => `v${String(n).padStart(10, "0")}`;
export const vids = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => vid(from + i));
/** Titulo que el YouTube falso asigna a un id (salvo que se pase `titles`). */
export const titleOf = (id: string) => `Título de ${id}`;

export interface FakeOptions {
  ids: string[];
  pageSize?: number;
  section?: "videos" | "shorts" | "streams";
  /** Shorts: "variants" (oar*, por defecto) o "single" (una sola hq720, sin variantes). */
  shortStyle?: "variants" | "single";
  /** Shorts con variantes: cual manda YouTube (por defecto oar3). */
  variant?: string;
  /** Titulo por id (por defecto `titleOf(id)`). */
  titles?: Record<string, string>;
  /**
   * Forma en que YouTube manda el titulo:
   *   "primary"  (defecto) lockupMetadataViewModel / overlayMetadata.primaryText
   *   "a11y"     shorts: solo accessibilityText ("<titulo>, 1.2M views - play Short")
   *   "legacy"   videos: videoRenderer.title.runs (formato antiguo)
   *   "none"     sin titulo en ninguna parte
   */
  titleStyle?: "primary" | "a11y" | "legacy" | "none";
}

/**
 * YouTube de mentira: sirve resolve_url, la pestaña y las continuaciones con el
 * mismo formato JSON que espera el extractor. Los tokens son "tok:<offset>".
 */
export class FakeYouTube {
  ids: string[];
  pageSize: number;
  section: string;
  shortStyle: "variants" | "single";
  variant: string;
  titles: Record<string, string>;
  titleStyle: "primary" | "a11y" | "legacy" | "none";
  channelExists = true;
  /** Cuantas continuaciones siguientes responderan 500. */
  failContinuations = 0;
  /** Si es true, TODA peticion responde 500. */
  failAll = false;
  /** Pausa (ms) antes de responder, para probar concurrencia. */
  delayMs = 0;

  calls: string[] = [];
  visitorHeaders: (string | undefined)[] = [];
  sessionsOpened = 0;
  sessionsClosed = 0;

  constructor(o: FakeOptions) {
    this.ids = [...o.ids];
    this.pageSize = o.pageSize ?? 5;
    this.section = o.section ?? "videos";
    this.shortStyle = o.shortStyle ?? "variants";
    this.variant = o.variant ?? "oar3";
    this.titles = o.titles ?? {};
    this.titleStyle = o.titleStyle ?? "primary";
  }

  get continuationCalls(): number {
    return this.calls.filter((c) => c.startsWith("cont:")).length;
  }

  reset(): void {
    this.calls = [];
  }

  session = (): HttpSession => {
    this.sessionsOpened++;
    return {
      post: async (url, options) => {
        if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
        const endpoint = url.split("/v1/")[1]!;
        const body = (options as { json: Record<string, unknown> }).json;
        this.visitorHeaders.push(
          (options as { headers: Record<string, string> }).headers["x-goog-visitor-id"],
        );
        const ok = (json: unknown) => ({ status: 200, json: <T>() => json as T });
        const fail = (status: number) => ({ status, json: <T>() => ({}) as T });

        if (this.failAll) return fail(500);

        if (endpoint.startsWith("navigation/resolve_url")) {
          this.calls.push("resolve");
          if (!this.channelExists) return fail(404);
          return ok({
            responseContext: { visitorData: "VISITOR-1" },
            endpoint: { browseEndpoint: { browseId: `UC${"a".repeat(22)}` } },
          });
        }

        if (typeof body.continuation === "string") {
          const offset = Number(body.continuation.split(":")[1]);
          this.calls.push(`cont:${offset}`);
          if (this.failContinuations > 0) {
            this.failContinuations--;
            return fail(500);
          }
          return ok({
            responseContext: { visitorData: "VISITOR-1" },
            onResponseReceivedActions: [
              { appendContinuationItemsAction: { continuationItems: this.page(offset) } },
            ],
          });
        }

        this.calls.push("tab");
        return ok({
          responseContext: { visitorData: "VISITOR-1" },
          contents: {
            twoColumnBrowseResultsRenderer: {
              tabs: [
                {
                  tabRenderer: {
                    endpoint: {
                      commandMetadata: { webCommandMetadata: { url: `/@canal/${this.section}` } },
                    },
                    content: { richGridRenderer: { contents: this.page(0) } },
                  },
                },
              ],
            },
          },
        });
      },
      close: async () => {
        this.sessionsClosed++;
      },
    };
  };

  private page(offset: number): unknown[] {
    const slice = this.ids.slice(offset, offset + this.pageSize);
    const items: unknown[] = slice.map((id) => this.item(id));
    const next = offset + this.pageSize;
    if (next < this.ids.length) {
      items.push({
        continuationItemRenderer: {
          continuationEndpoint: {
            clickTrackingParams: "ctp",
            continuationCommand: { token: `tok:${next}` },
          },
        },
      });
    }
    return items;
  }

  private titleFor(id: string): string {
    return this.titles[id] ?? titleOf(id);
  }

  private shortTitle(id: string): Record<string, unknown> {
    if (this.titleStyle === "none" || this.titleStyle === "legacy") return {};
    if (this.titleStyle === "a11y") return { accessibilityText: `${this.titleFor(id)}, 1.2M views - play Short` };
    return { overlayMetadata: { primaryText: { content: this.titleFor(id) } } };
  }

  private item(id: string): unknown {
    if (this.section === "shorts") {
      const file = this.shortStyle === "single" ? "hq720" : this.variant;
      const src = (h: number, sqp: string) => ({
        url: `https://i.ytimg.com/vi/${id}/${file}.jpg?sqp=${sqp}&rs=SIG${h}`,
        width: 405,
        height: h,
      });
      const sources = this.shortStyle === "single" ? [src(720, "AAA")] : [src(720, "AAA"), src(608, "BBB")];
      return {
        richItemRenderer: {
          content: {
            shortsLockupViewModel: {
              ...this.shortTitle(id),
              onTap: { innertubeCommand: { reelWatchEndpoint: { videoId: id } } },
              thumbnailViewModel: {
                thumbnailViewModel: { image: { sources } },
              },
            },
          },
        },
      };
    }
    if (this.titleStyle === "legacy") {
      return {
        richItemRenderer: {
          content: {
            videoRenderer: {
              videoId: id,
              publishedTimeText: { simpleText: "hace 1 día" },
              title: { runs: [{ text: this.titleFor(id) }] },
              thumbnail: {
                thumbnails: [{ url: `https://i.ytimg.com/vi/${id}/hq720.jpg`, width: 480, height: 270 }],
              },
            },
          },
        },
      };
    }
    return {
      richItemRenderer: {
        content: {
          lockupViewModel: {
            contentType: "LOCKUP_CONTENT_TYPE_VIDEO",
            contentId: id,
            ...(this.titleStyle === "none"
              ? {}
              : { metadata: { lockupMetadataViewModel: { title: { content: this.titleFor(id) } } } }),
            contentImage: {
              thumbnailViewModel: {
                image: {
                  sources: [
                    { url: `https://i.ytimg.com/vi/${id}/hq720.jpg`, width: 480, height: 270 },
                    { url: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`, width: 320, height: 180 },
                  ],
                },
              },
            },
          },
        },
      },
    };
  }
}
