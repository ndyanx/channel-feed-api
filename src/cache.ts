/**
 * Cache en memoria de listados de canal.
 *
 * Una entrada = un `ChannelListing` (canal + seccion + orden + filtro de miembros).
 * Todo lo demas (max, offset, reverse, limit_id, output) se aplica DESPUES sobre
 * la lista cacheada, sin volver a llamar a YouTube.
 *
 * Frescura (TTL, por defecto 10 min, medido desde la primera pagina descargada):
 *   - fresca  -> "hit".
 *   - vencida, `fresh: false` -> se sirve la vieja ("stale") y se refresca por
 *     detras; si el refresco falla se sigue sirviendo la vieja (con espera de
 *     `refreshBackoffMs` antes de reintentar).
 *   - vencida, `fresh: true`  -> se espera a una descarga nueva ("refresh").
 *   - `force`                 -> siempre descarga nueva ("refresh").
 *
 * Limites de edad:
 *   - `maxStaleMs`: pasada esta edad ya no se sirve la lista vieja "al instante";
 *     se espera a una descarga nueva aunque la peticion acepte stale.
 *   - `staleIfErrorMs`: si esa descarga nueva falla (YouTube bloquea, cola llena...),
 *     se sigue sirviendo la vieja mientras no supere esta edad (status "stale").
 *     Un canal que ya no existe NO se sirve de cache: da 404.
 *
 * `changedAt`: al refrescar, si el principio de la lista nueva es igual al de la vieja,
 * la nueva hereda el `changedAt` de la vieja. Asi `updated_at` solo cambia cuando la
 * lista cambio de verdad (el frontend lo usa para avisar de que hay que recargar).
 *
 * Memoria: ademas de `maxEntries`, el total de items en memoria se limita con
 * `maxItems` (se expulsa lo menos usado; la lista que se esta sirviendo nunca).
 *
 * El refresco solo vuelve a descargar un prefijo (`refreshPrefix` items como
 * maximo): lo que haya mas alla se completa bajo demanda en la lista nueva.
 *
 * Proteccion frente a abuso:
 *   - Cache negativo (`negativeTtlMs`): un canal/seccion que NO existe
 *     (ChannelError) se recuerda un rato y se responde sin tocar YouTube.
 *     Los fallos de red / sobrecarga nunca se recuerdan.
 *   - Cooldown de `force` (`refreshCooldownMs`): `refresh=true` solo descarga de
 *     nuevo si la lista tiene al menos esa edad; si no, se sirve la que hay.
 *     Evita que N clientes con `refresh=true` en secuencia martilleen a YouTube.
 *   - Los refrescos en segundo plano salen con prioridad "background".
 */

import { ChannelError, type ChannelListing, type Members, type Section, type SortBy } from "./extractor.js";
import type { Priority } from "./gate.js";

export type CacheStatus = "miss" | "hit" | "stale" | "refresh";

export interface ListingKey {
  /** Ruta ya normalizada por `parseChannel`: "@handle" o "channel/UC...". */
  channel: string;
  section: Section;
  sortBy: SortBy;
  members: Members;
}

export interface CacheOptions {
  factory: (key: ListingKey) => ChannelListing;
  ttlMs?: number;
  maxEntries?: number;
  refreshPrefix?: number;
  refreshBackoffMs?: number;
  /** Edad maxima para servir lo vencido sin esperar (default 6 h). */
  maxStaleMs?: number;
  /** Edad maxima para servir lo vencido cuando la descarga nueva falla (default 24 h). */
  staleIfErrorMs?: number;
  /** Maximo de items sumando todas las listas en memoria (default 30000). */
  maxItems?: number;
  /** ms que se recuerda un canal inexistente (default 0 = no se recuerda). */
  negativeTtlMs?: number;
  /** Maximo de errores recordados (default 500). */
  negativeMaxEntries?: number;
  /** Edad minima de una lista para aceptar `force` (default 0 = siempre). */
  refreshCooldownMs?: number;
  now?: () => number;
  log?: (msg: string) => void;
}

export interface Acquired {
  listing: ChannelListing;
  status: CacheStatus;
}

interface Slot {
  key: ListingKey;
  listing: ChannelListing;
  starting?: Promise<void>;
  refreshing?: Promise<void>;
  backoffUntil: number;
}

/** Los @handle no distinguen mayusculas; los ids UC... si. */
export function keyString(k: ListingKey): string {
  const channel = k.channel.startsWith("@") ? k.channel.toLowerCase() : k.channel;
  return [channel, k.section, k.sortBy, k.members].join("|");
}

/**
 * true si `b` (lista nueva) es, a efectos del usuario, la misma lista que `a`: mismo principio
 * (hasta `limit` items) y sin items nuevos ni desaparecidos en los extremos ya conocidos.
 */
export function sameContent(a: ChannelListing, b: ChannelListing, limit: number): boolean {
  const n = Math.min(a.entries.length, b.entries.length, limit);
  for (let i = 0; i < n; i++) {
    if (a.entries[i]!.id !== b.entries[i]!.id) return false;
  }
  if (a.complete && b.entries.length > a.entries.length) return false;
  if (b.complete && a.entries.length > b.entries.length) return false;
  return n > 0 || (a.entries.length === 0 && b.entries.length === 0);
}

export class ListingCache {
  private readonly slots = new Map<string, Slot>(); // orden de insercion = LRU
  private readonly pending = new Set<Promise<unknown>>();

  private readonly factory: (key: ListingKey) => ChannelListing;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly refreshPrefix: number;
  private readonly backoffMs: number;
  private readonly maxStaleMs: number;
  private readonly staleIfErrorMs: number;
  private readonly maxItems: number;
  private readonly negativeTtlMs: number;
  private readonly negativeMax: number;
  private readonly refreshCooldownMs: number;
  private readonly negatives = new Map<string, { error: ChannelError; until: number }>();
  private readonly now: () => number;
  private readonly log: (msg: string) => void;

  constructor(opts: CacheOptions) {
    this.factory = opts.factory;
    this.ttlMs = opts.ttlMs ?? 10 * 60_000;
    this.maxEntries = opts.maxEntries ?? 50;
    this.refreshPrefix = opts.refreshPrefix ?? 300;
    this.backoffMs = opts.refreshBackoffMs ?? 30_000;
    this.maxStaleMs = opts.maxStaleMs ?? 6 * 3_600_000;
    this.staleIfErrorMs = opts.staleIfErrorMs ?? 24 * 3_600_000;
    this.maxItems = opts.maxItems ?? 30_000;
    this.negativeTtlMs = opts.negativeTtlMs ?? 0;
    this.negativeMax = opts.negativeMaxEntries ?? 500;
    this.refreshCooldownMs = opts.refreshCooldownMs ?? 0;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
  }

  get size(): number {
    return this.slots.size;
  }

  /** Items en memoria sumando todas las listas (para /v1/stats y para el limite `maxItems`). */
  get itemCount(): number {
    let n = 0;
    for (const s of this.slots.values()) n += s.listing.entries.length;
    return n;
  }

  /**
   * Devuelve un listado con su primera pagina ya descargada.
   * @param opts.fresh exigir datos dentro del TTL (esperando si hace falta)
   * @param opts.force ignorar el cache y descargar de nuevo
   */
  async acquire(key: ListingKey, opts: { fresh?: boolean; force?: boolean } = {}): Promise<Acquired> {
    const id = keyString(key);
    let slot = this.slots.get(id);

    const known = this.negatives.get(id);
    if (known) {
      if (known.until > this.now()) throw known.error;
      this.negatives.delete(id);
    }

    if (!slot) {
      slot = this.open(id, key);
      await slot.starting; // si falla, open() ya quito la entrada
      return { listing: slot.listing, status: "miss" };
    }

    // LRU: la entrada usada pasa al final.
    this.slots.delete(id);
    this.slots.set(id, slot);

    if (slot.starting) await slot.starting; // otra peticion la esta creando: compartir
    this.evictOverLimit(slot);

    if (opts.force && (slot.refreshing || this.cooledDown(slot))) {
      await this.refresh(slot, 1);
      return { listing: slot.listing, status: "refresh" };
    }
    if (!this.isExpired(slot)) return { listing: slot.listing, status: "hit" };
    const age = this.ageOf(slot);
    if (!opts.fresh && age < this.maxStaleMs) {
      this.refreshInBackground(slot);
      return { listing: slot.listing, status: "stale" };
    }
    return this.refreshOrServeOld(id, slot, age);
  }

  /** Registra trabajo en segundo plano (p. ej. prefetch) para `whenIdle`. Nunca rechaza. */
  background(work: Promise<unknown>): void {
    const safe = work.catch(() => {}).finally(() => this.pending.delete(safe));
    this.pending.add(safe);
  }

  /** Espera a que terminen los refrescos y prefetch en curso. */
  async whenIdle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  // ----------------------------------------------------------------------- //

  /**
   * Hay que esperar a una lista nueva (vencida y sin permiso para servir stale, o demasiado
   * vieja). Si la descarga falla y la vieja aun no supera `staleIfErrorMs`, se sirve la vieja.
   */
  private async refreshOrServeOld(id: string, slot: Slot, age: number): Promise<Acquired> {
    const canServeOld = age < this.staleIfErrorMs;
    // Un fallo reciente: no hacer esperar a cada peticion a que vuelva a fallar.
    if (canServeOld && !slot.refreshing && this.now() < slot.backoffUntil) {
      return { listing: slot.listing, status: "stale" };
    }
    try {
      await this.refresh(slot, 1);
      return { listing: slot.listing, status: "refresh" };
    } catch (err) {
      if (err instanceof ChannelError) {
        // El canal ya no existe: no servir una lista que YouTube ya no confirma.
        if (this.slots.get(id) === slot) this.slots.delete(id);
        this.remember(id, err);
        throw err;
      }
      if (!canServeOld) throw err;
      slot.backoffUntil = this.now() + this.backoffMs;
      this.log(`refresco fallido, se sirve la lista vieja (${keyString(slot.key)}): ${(err as Error).message}`);
      return { listing: slot.listing, status: "stale" };
    }
  }

  /** Expulsa lo menos usado hasta que el total de items cabe en `maxItems` (nunca `keep`). */
  private evictOverLimit(keep: Slot): void {
    let total = this.itemCount;
    if (total <= this.maxItems) return;
    for (const [id, s] of this.slots) {
      if (total <= this.maxItems) break;
      if (s === keep) continue;
      this.slots.delete(id);
      total -= s.listing.entries.length;
      this.log(`cache: expulsada ${id} (${s.listing.entries.length} items) por limite de memoria`);
    }
  }

  private open(id: string, key: ListingKey): Slot {
    const listing = this.factory(key);
    const slot: Slot = { key, listing, backoffUntil: 0 };
    this.slots.set(id, slot);
    while (this.slots.size > this.maxEntries) {
      this.slots.delete(this.slots.keys().next().value!);
    }
    this.evictOverLimit(slot);
    // Un canal inexistente o un fallo de red NO se guardan en cache.
    slot.starting = listing.extend(() => true).then(
      () => {
        slot.starting = undefined;
      },
      (err) => {
        slot.starting = undefined;
        if (this.slots.get(id) === slot) this.slots.delete(id);
        if (err instanceof ChannelError) this.remember(id, err);
        throw err;
      },
    );
    return slot;
  }

  private remember(id: string, error: ChannelError): void {
    if (this.negativeTtlMs <= 0) return;
    this.negatives.delete(id);
    this.negatives.set(id, { error, until: this.now() + this.negativeTtlMs });
    while (this.negatives.size > this.negativeMax) {
      this.negatives.delete(this.negatives.keys().next().value!);
    }
  }

  /** `force` solo se acepta si la lista tiene edad suficiente (o si ya hay un refresco en curso: se comparte). */
  private cooledDown(slot: Slot): boolean {
    const t = slot.listing.fetchedAt;
    return t === undefined || this.now() - t >= this.refreshCooldownMs;
  }

  private isExpired(slot: Slot): boolean {
    const t = slot.listing.fetchedAt;
    return t !== undefined && this.now() - t >= this.ttlMs;
  }

  private ageOf(slot: Slot): number {
    const t = slot.listing.fetchedAt;
    return t === undefined ? 0 : this.now() - t;
  }

  /** Descarga una lista nueva (al menos `target` items) y reemplaza la actual. Compartido entre peticiones. */
  private refresh(slot: Slot, target: number, priority: Priority = "interactive"): Promise<void> {
    if (!slot.refreshing) {
      const fresh = this.factory(slot.key);
      const work = fresh
        .extend(() => fresh.entries.length >= target, { priority })
        .then(() => {
          if (sameContent(slot.listing, fresh, Math.max(this.refreshPrefix, 1))) fresh.changedAt = slot.listing.changedAt;
          slot.listing = fresh;
        });
      slot.refreshing = work.finally(() => {
        slot.refreshing = undefined;
      });
    }
    return slot.refreshing;
  }

  private refreshInBackground(slot: Slot): void {
    if (slot.refreshing || this.now() < slot.backoffUntil) return;
    const target = Math.min(Math.max(slot.listing.entries.length, 1), this.refreshPrefix);
    this.background(
      this.refresh(slot, target, "background").catch((err: Error) => {
        slot.backoffUntil = this.now() + this.backoffMs;
        this.log(`refresco fallido (${keyString(slot.key)}): ${err.message}`);
      }),
    );
  }
}
