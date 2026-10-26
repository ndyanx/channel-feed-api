/**
 * Casos de uso sobre el cache, uno por endpoint:
 *
 *   page -> GET /v1/channel      una pagina (offset + max), descargando solo lo necesario
 *   all  -> GET /v1/channel/all  la lista completa (o hasta limit_id / max)
 */

import { materialize, type ChannelListing, type VideoEntry } from "./extractor.js";
import type { CacheStatus, ListingCache, ListingKey } from "./cache.js";

export interface PageParams {
  offset: number;
  max: number;
  reverse: boolean;
  limitId?: string;
}

export interface PageResult {
  items: VideoEntry[];
  /** Total real; null mientras el canal no se haya descargado entero. */
  total: number | null;
  hasMore: boolean;
  cache: CacheStatus;
  updatedAt: number;
}

export interface AllParams {
  max?: number;
  reverse: boolean;
  limitId?: string;
  /** Ignorar el cache y descargar de nuevo. */
  refresh: boolean;
  /** Aceptar datos vencidos (se refrescan por detras) en vez de esperar. */
  staleOk: boolean;
}

export interface AllResult {
  items: VideoEntry[];
  /** true si `items` cubre el canal entero (sin cortes por max / limit_id). */
  complete: boolean;
  cache: CacheStatus;
  updatedAt: number;
}

export interface ServiceOptions {
  /** Items extra que se descargan en segundo plano tras responder una pagina (0 = nada). */
  prefetchAhead?: number;
}

/** Momento en que la lista cambio por ultima vez (no el de la ultima descarga). */
const stamp = (l: ChannelListing): number => l.changedAt ?? l.fetchedAt ?? Date.now();

export class ChannelService {
  private readonly prefetchAhead: number;

  constructor(
    private readonly cache: ListingCache,
    opts: ServiceOptions = {},
  ) {
    this.prefetchAhead = opts.prefetchAhead ?? 60;
  }

  /** Listados en memoria (para /v1/stats). */
  get cacheSize(): number {
    return this.cache.size;
  }

  /** Items en memoria sumando todos los listados (para /v1/stats). */
  get cacheItems(): number {
    return this.cache.itemCount;
  }

  async page(key: ListingKey, p: PageParams): Promise<PageResult> {
    const { listing, status } = await this.cache.acquire(key);
    const end = p.offset + p.max;

    // Camino normal: orden de YouTube, solo se baja hasta offset + max.
    if (!p.reverse && p.limitId === undefined) {
      await listing.extend(() => listing.entries.length >= end);
      const items = listing.entries.slice(p.offset, end);
      const result: PageResult = {
        items,
        total: listing.complete ? listing.entries.length : null,
        hasMore: !listing.complete || end < listing.entries.length,
        cache: status,
        updatedAt: stamp(listing),
      };
      if (this.prefetchAhead > 0 && !listing.complete) {
        const target = end + this.prefetchAhead;
        this.cache.background(
          listing.extend(() => listing.entries.length >= target, { priority: "background" }),
        );
      }
      return result;
    }

    // reverse / limit_id necesitan conocer el extremo de la lista (o su corte).
    const view = await materialize(listing, { limitId: p.limitId, reverse: p.reverse });
    return {
      items: view.items.slice(p.offset, end),
      total: view.items.length,
      hasMore: end < view.items.length,
      cache: status,
      updatedAt: stamp(listing),
    };
  }

  async all(key: ListingKey, p: AllParams): Promise<AllResult> {
    const { listing, status } = await this.cache.acquire(key, { fresh: !p.staleOk, force: p.refresh });
    const view = await materialize(listing, { limitId: p.limitId, cap: p.max, reverse: p.reverse });
    return {
      items: view.items,
      complete: view.complete,
      cache: status,
      updatedAt: stamp(listing),
    };
  }
}
