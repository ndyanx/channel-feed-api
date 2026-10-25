/**
 * Resolucion @handle -> browseId (UC...), compartida por todos los listados.
 *
 * Un canal tiene hasta 27 listados distintos (3 secciones x 3 ordenes x 3 filtros
 * de miembros) y cada uno empezaba con su propio `resolve_url`. Aqui se hace una
 * sola vez por handle:
 *   - positivo: el handle -> id casi nunca cambia, TTL largo (default 24 h).
 *   - negativo: un handle inexistente se recuerda poco tiempo (default 2 min),
 *     para que repetirlo (o probarlo en 27 combinaciones) no cueste llamadas.
 *   - single-flight: resoluciones simultaneas del mismo handle comparten una.
 *   - los fallos de red / YouTube NO se guardan.
 */

import { ChannelError } from "./extractor.js";

export interface ResolverOptions {
  ttlMs?: number;
  negativeTtlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

type Entry = { id: string; until: number } | { error: ChannelError; until: number };

export class ChannelResolver {
  private readonly known = new Map<string, Entry>(); // orden de insercion = LRU
  private readonly inflight = new Map<string, Promise<string>>();
  private readonly ttlMs: number;
  private readonly negativeTtlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(opts: ResolverOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 24 * 60 * 60_000;
    this.negativeTtlMs = opts.negativeTtlMs ?? 2 * 60_000;
    this.maxEntries = opts.maxEntries ?? 2000;
    this.now = opts.now ?? Date.now;
  }

  /** `lookup` hace la llamada real; solo se ejecuta si no hay respuesta vigente ni otra en vuelo. */
  resolve(path: string, lookup: () => Promise<string>): Promise<string> {
    const key = path.toLowerCase(); // los @handle no distinguen mayusculas
    const hit = this.known.get(key);
    if (hit && hit.until > this.now()) {
      this.known.delete(key);
      this.known.set(key, hit);
      return "error" in hit ? Promise.reject(hit.error) : Promise.resolve(hit.id);
    }

    const pending = this.inflight.get(key);
    if (pending) return pending;

    const work = lookup()
      .then(
        (id) => {
          this.store(key, { id, until: this.now() + this.ttlMs });
          return id;
        },
        (err) => {
          if (err instanceof ChannelError && this.negativeTtlMs > 0) {
            this.store(key, { error: err, until: this.now() + this.negativeTtlMs });
          }
          throw err;
        },
      )
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, work);
    return work;
  }

  get size(): number {
    return this.known.size;
  }

  private store(key: string, entry: Entry): void {
    this.known.delete(key);
    this.known.set(key, entry);
    while (this.known.size > this.maxEntries) this.known.delete(this.known.keys().next().value!);
  }
}
