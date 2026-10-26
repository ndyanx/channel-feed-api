/**
 * Busqueda de canales de YouTube.
 *
 *   POST youtubei/v1/search  { query, params: CHANNEL_FILTER }   primera pagina (~20 canales)
 *   POST youtubei/v1/search  { continuation }                     paginas siguientes
 *
 * Igual que `ChannelListing`, el resultado es REANUDABLE: `ChannelSearch` conserva lo ya
 * descargado y el token de la siguiente pagina, asi que "los primeros 8" (dropdown) y mas
 * tarde "hasta el 60" (pagina de resultados) no repiten nada. El token (mas de 1000
 * caracteres) nunca sale del servidor: el cliente solo manda `offset`.
 *
 * Toda peticion pasa por la misma cola global (`UpstreamGate`) que los listados.
 */

import { Session } from "impers";
import {
  Innertube,
  asKnownError,
  at,
  firstOf,
  parseEndpoint,
  searchKey,
  type Cont,
  type HttpSession,
} from "./extractor.js";
import type { Priority, UpstreamGate } from "./gate.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

// --------------------------------------------------------------------------- //
// Tipos publicos
// --------------------------------------------------------------------------- //

export interface AvatarImage {
  /** Siempre absoluta (https://...); YouTube la manda como "//yt3.ggpht.com/...". */
  url: string;
  width: number | null;
  height: number | null;
}

/** Un canal de los resultados. Es tal cual lo que devuelve la API. */
export interface ChannelHit {
  /** Id UC... del canal. */
  id: string;
  /** Enlace al canal en YouTube. */
  url: string;
  /** "@handle", o null si el canal no tiene. */
  handle: string | null;
  title: string;
  /** Extracto de la descripcion ("" si no hay). */
  description: string;
  /** Texto de suscriptores tal como lo manda YouTube ("36.3K subscribers"); null si lo oculta. */
  subscribers_text: string | null;
  /** Suscriptores aproximados, leidos de `subscribers_text`; null si no se pudo. */
  subscribers: number | null;
  /** Avatares, de menor a mayor ancho (YouTube manda 88 y 176 px). */
  thumbnails: AvatarImage[];
}

export interface SearchOptions {
  /** Texto ya normalizado con `normalizeSearchQuery`. */
  query: string;
  impersonate?: string;
  timeoutSec?: number;
  log?: (msg: string) => void;
  /** Crea una sesion HTTP por rafaga de peticiones (se cierra al terminar). Solo para pruebas. */
  sessionFactory?: () => HttpSession;
  now?: () => number;
  gate?: UpstreamGate;
  /** Tope de canales que se guardan por busqueda (default 500). */
  maxEntries?: number;
}

// --------------------------------------------------------------------------- //
// Constantes
// --------------------------------------------------------------------------- //

/** Filtro "Tipo: Canal" del buscador (el `sp=EgIQAg%3D%3D` de la URL de resultados). */
export const CHANNEL_FILTER = "EgIQAg%3D%3D";

export const MIN_QUERY = 2;
export const MAX_QUERY = 100;

// --------------------------------------------------------------------------- //
// Utilidades de lectura (puras, se prueban sin red)
// --------------------------------------------------------------------------- //

/** Minusculas, sin espacios repetidos ni de los extremos. Es la clave de cache y lo que se manda a YouTube. */
export function normalizeSearchQuery(q: string): string {
  return (q ?? "").normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

const absoluteUrl = (u: unknown): string | null => {
  if (typeof u !== "string" || !u) return null;
  const url = u.startsWith("//") ? `https:${u}` : u;
  return /^https?:\/\//i.test(url) ? url : null;
};

const textOf = (node: Json): string => {
  if (!node) return "";
  if (typeof node.simpleText === "string") return node.simpleText;
  if (Array.isArray(node.runs)) return node.runs.map((r: Json) => (typeof r?.text === "string" ? r.text : "")).join("");
  return "";
};

const UNITS: Record<string, number> = {
  k: 1e3,
  mil: 1e3,
  m: 1e6,
  mill: 1e6,
  millones: 1e6,
  b: 1e9,
};

/**
 * "36.3K subscribers" -> 36300 | "1 subscriber" -> 1 | "36.3 k suscriptores" -> 36300 | "1,234" -> 1234.
 * Devuelve null si no empieza con un numero.
 */
export function parseSubscribers(text: string | null | undefined): number | null {
  if (!text) return null;
  const m = text.trim().match(/^(\d[\d.,]*)(?:\s*(millones|mill|mil|k|m|b)(?![a-z\u00c0-\u024f]))?/i);
  if (!m) return null;
  let raw = m[1]!.replace(/[.,]+$/, "");
  if (/^\d{1,3}([.,]\d{3})+$/.test(raw)) raw = raw.replace(/[.,]/g, "");
  else raw = raw.replace(",", ".");
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) return null;
  const mult = m[2] ? (UNITS[m[2].toLowerCase()] ?? 1) : 1;
  return Math.round(n * mult);
}

/** Avatares normalizados (https, de menor a mayor ancho). */
export function extractAvatars(renderer: Json): AvatarImage[] {
  const raw = at(renderer, "thumbnail", "thumbnails");
  if (!Array.isArray(raw)) return [];
  const out: AvatarImage[] = [];
  const seen = new Set<string>();
  for (const t of raw) {
    const url = absoluteUrl(t?.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const w = Number(t?.width);
    const h = Number(t?.height);
    out.push({ url, width: Number.isFinite(w) && w > 0 ? w : null, height: Number.isFinite(h) && h > 0 ? h : null });
  }
  return out.sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
}

/** "@handle" desde la URL canonica ("/@handle"), o desde el texto "@handle" que YouTube pone en otro campo. */
function extractHandle(renderer: Json, fields: string[]): string | null {
  const canonical = at(renderer, "navigationEndpoint", "browseEndpoint", "canonicalBaseUrl");
  if (typeof canonical === "string") {
    const m = canonical.match(/^\/(@[^/?#\s]+)/);
    if (m) return m[1]!;
  }
  const direct = fields.find((f) => /^@[^\s]+$/.test(f));
  return direct ?? null;
}

/**
 * OJO: en `channelRenderer` los nombres de YouTube estan cruzados: `videoCountText` trae los
 * SUSCRIPTORES y `subscriberCountText` trae el @handle. Se miran los dos campos y se decide por
 * el contenido (no por el nombre), asi sobrevive a que YouTube lo arregle.
 */
export function parseChannelRenderer(r: Json): ChannelHit | null {
  const id = r?.channelId;
  if (typeof id !== "string" || !/^UC[\w-]{22}$/.test(id)) return null;

  const title = (textOf(r.title) || textOf(r.longBylineText) || textOf(r.shortBylineText)).trim();
  const fields = [textOf(r.subscriberCountText).trim(), textOf(r.videoCountText).trim()].filter(Boolean);
  const handle = extractHandle(r, fields);
  const subscribersText = fields.find((f) => !f.startsWith("@") && /\d/.test(f) && /(subscri|suscri)/i.test(f)) ?? null;

  return {
    id,
    url: handle ? `https://www.youtube.com/${handle}` : `https://www.youtube.com/channel/${id}`,
    handle,
    title: title || handle || id,
    description: textOf(r.descriptionSnippet).replace(/\s+/g, " ").trim(),
    subscribers_text: subscribersText,
    subscribers: parseSubscribers(subscribersText),
    thumbnails: extractAvatars(r),
  };
}

export interface SearchPageData {
  hits: ChannelHit[];
  next: Cont | undefined;
  /** `estimatedResults` de YouTube (solo viene en la primera pagina). */
  estimated: number | null;
}

/**
 * Lee una pagina de resultados, sea la primera (`contents...sectionListRenderer`) o una continuacion
 * (`onResponseReceivedCommands...`). Solo se toma el `continuationItemRenderer` de la lista: el resto
 * de `continuationCommand` de la respuesta son de chips de filtros y no sirven para paginar.
 */
export function parseSearchPage(data: Json): SearchPageData {
  const hits: ChannelHit[] = [];
  for (const r of searchKey(data, "channelRenderer")) {
    const hit = parseChannelRenderer(r);
    if (hit) hits.push(hit);
  }
  const item = firstOf(searchKey(data, "continuationItemRenderer"));
  const next = parseEndpoint(at(item, "continuationEndpoint"));
  const est = Number(at(data, "estimatedResults"));
  return { hits, next, estimated: Number.isFinite(est) && est >= 0 ? est : null };
}

// --------------------------------------------------------------------------- //
// Busqueda reanudable
// --------------------------------------------------------------------------- //

export class ChannelSearch {
  readonly entries: ChannelHit[] = [];
  /** true cuando YouTube no tiene mas paginas. */
  complete = false;
  /** ms en que se descargo la primera pagina. */
  fetchedAt: number | undefined;
  /** Total aproximado segun YouTube; null si no lo dijo. */
  estimated: number | null = null;

  private readonly ids = new Set<string>();
  private readonly query: string;
  private readonly timeoutSec: number;
  private readonly log: (msg: string) => void;
  private readonly now: () => number;
  private readonly makeSession: () => HttpSession;
  private readonly gate: UpstreamGate | undefined;
  private readonly maxEntries: number;

  private next: Cont | undefined;
  private started = false;
  private visitorData: string | undefined;
  private lock: Promise<unknown> = Promise.resolve();
  /** Paginas seguidas sin ningun canal nuevo (corta el bucle si YouTube solo repite). */
  private emptyStreak = 0;

  constructor(opts: SearchOptions) {
    this.query = normalizeSearchQuery(opts.query);
    this.timeoutSec = opts.timeoutSec ?? 30;
    this.log = opts.log ?? (() => {});
    this.now = opts.now ?? Date.now;
    this.gate = opts.gate;
    this.maxEntries = opts.maxEntries ?? 500;
    const impersonate = opts.impersonate ?? "chrome";
    const timeout = this.timeoutSec;
    this.makeSession = opts.sessionFactory ?? (() => new Session({ impersonate, timeout }) as HttpSession);
  }

  /** Descarga paginas hasta que `enough()` sea true o no queden. Las llamadas se encolan (nunca se repite una pagina). */
  extend(enough: () => boolean, opts: { priority?: Priority } = {}): Promise<void> {
    const run = this.lock.then(() => this.doExtend(enough, opts.priority ?? "interactive"));
    this.lock = run.catch(() => {});
    return run;
  }

  private async doExtend(enough: () => boolean, priority: Priority): Promise<void> {
    if (this.started && (this.complete || enough())) return;

    const session = this.makeSession();
    const yt = new Innertube(session, this.timeoutSec, this.log, this.visitorData, this.gate, priority);
    try {
      if (!this.started) {
        this.log(`search "${this.query}"`);
        const data = await yt.post("search", { query: this.query, params: CHANNEL_FILTER });
        const page = parseSearchPage(data);
        this.estimated = page.estimated;
        this.absorb(page);
        this.started = true;
        this.fetchedAt = this.now();
      }
      while (!this.complete && !enough()) {
        const [ctp, token] = this.next!;
        const data = await yt.post("search", { continuation: token }, ctp);
        this.absorb(parseSearchPage(data));
      }
    } catch (err) {
      throw asKnownError(err);
    } finally {
      this.visitorData = yt.visitorData ?? this.visitorData;
      await session.close().catch(() => {});
    }
  }

  private absorb(page: SearchPageData): void {
    let added = 0;
    for (const hit of page.hits) {
      if (this.ids.has(hit.id)) continue; // YouTube repite canales entre paginas
      this.ids.add(hit.id);
      this.entries.push(hit);
      added++;
    }
    this.emptyStreak = added === 0 ? this.emptyStreak + 1 : 0;
    this.next = page.next;
    if (!page.next || this.emptyStreak >= 3 || this.entries.length >= this.maxEntries) {
      this.next = undefined;
      this.complete = true;
    }
  }
}

// --------------------------------------------------------------------------- //
// Cache
// --------------------------------------------------------------------------- //

export type SearchCacheStatus = "miss" | "hit";

export interface SearchCacheOptions {
  factory: (query: string) => ChannelSearch;
  /** Vigencia de una busqueda (default 5 min, desde la primera pagina). */
  ttlMs?: number;
  /** Busquedas en memoria (default 100; se expulsa la menos usada). */
  maxEntries?: number;
  now?: () => number;
}

interface SearchSlot {
  search: ChannelSearch;
  starting?: Promise<void>;
}

/**
 * Una entrada = un texto normalizado. Peticiones simultaneas del mismo texto comparten una sola
 * descarga; una busqueda vencida se descarta y se vuelve a hacer. Los errores no se guardan.
 */
export class SearchCache {
  private readonly slots = new Map<string, SearchSlot>(); // orden de insercion = LRU
  private readonly factory: (query: string) => ChannelSearch;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(opts: SearchCacheOptions) {
    this.factory = opts.factory;
    this.ttlMs = opts.ttlMs ?? 5 * 60_000;
    this.maxEntries = opts.maxEntries ?? 100;
    this.now = opts.now ?? Date.now;
  }

  get size(): number {
    return this.slots.size;
  }

  async acquire(query: string): Promise<{ search: ChannelSearch; status: SearchCacheStatus }> {
    const key = normalizeSearchQuery(query);
    let slot = this.slots.get(key);

    if (slot && !slot.starting && this.isExpired(slot)) {
      this.slots.delete(key);
      slot = undefined;
    }

    if (!slot) {
      const search = this.factory(key);
      const fresh: SearchSlot = { search };
      this.slots.set(key, fresh);
      while (this.slots.size > this.maxEntries) this.slots.delete(this.slots.keys().next().value!);
      fresh.starting = search.extend(() => true).then(
        () => {
          fresh.starting = undefined;
        },
        (err) => {
          fresh.starting = undefined;
          if (this.slots.get(key) === fresh) this.slots.delete(key);
          throw err;
        },
      );
      await fresh.starting;
      return { search, status: "miss" };
    }

    this.slots.delete(key);
    this.slots.set(key, slot);
    if (slot.starting) await slot.starting;
    return { search: slot.search, status: "hit" };
  }

  private isExpired(slot: SearchSlot): boolean {
    const t = slot.search.fetchedAt;
    return t !== undefined && this.now() - t >= this.ttlMs;
  }
}

// --------------------------------------------------------------------------- //
// Servicio (caso de uso de GET /v1/search/channels)
// --------------------------------------------------------------------------- //

export interface SearchPage {
  items: ChannelHit[];
  hasMore: boolean;
  /** Total aproximado de YouTube; null si no lo mando. */
  estimated: number | null;
  cache: SearchCacheStatus;
  updatedAt: number;
}

export class SearchService {
  constructor(private readonly cache: SearchCache) {}

  /** Busquedas en memoria (para /v1/stats). */
  get cacheSize(): number {
    return this.cache.size;
  }

  async page(query: string, offset: number, max: number): Promise<SearchPage> {
    const { search, status } = await this.cache.acquire(query);
    const end = offset + max;
    await search.extend(() => search.entries.length >= end);
    return {
      items: search.entries.slice(offset, end),
      hasMore: !search.complete || end < search.entries.length,
      estimated: search.estimated,
      cache: status,
      updatedAt: search.fetchedAt ?? Date.now(),
    };
  }
}
