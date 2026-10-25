/**
 * Extractor de canales de YouTube (port del flujo JSON de youtube_channel.py).
 *
 *   1. resolve_url   @handle -> browseId        (se omite si ya es un id UC...)
 *   2. browse        browseId + params de pestaña
 *   3. browse        filtro Solo miembros / Público   (si se pidio)
 *   4. browse        orden Popular / Más antiguos     (si se pidio)
 *   5. browse        continuaciones, de una en una, bajo demanda
 *
 * El listado es REANUDABLE: `ChannelListing` conserva lo ya descargado y el
 * token de la siguiente pagina, asi que se puede pedir "los primeros 60", y mas
 * tarde "hasta el final", sin repetir nada. `listChannel` queda como atajo de un
 * solo uso.
 *
 * Diferencia con el script Python: NO hay respaldo por HTML. Si el flujo JSON
 * falla, se lanza UpstreamError.
 */

import { Session } from "impers";
import { OverloadedError, type Priority, type UpstreamGate } from "./gate.js";
import type { ChannelResolver } from "./resolver.js";

// El JSON de YouTube es enorme y cambia: se navega de forma defensiva.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

// --------------------------------------------------------------------------- //
// Tipos publicos
// --------------------------------------------------------------------------- //

export const SECTIONS = ["videos", "shorts", "streams"] as const;
export const SORTS = ["newest", "popular", "oldest"] as const;
export const MEMBERS = ["all", "public", "only"] as const;

export type Section = (typeof SECTIONS)[number];
export type SortBy = (typeof SORTS)[number];
export type Members = (typeof MEMBERS)[number];

/** Una imagen tal como la manda YouTube. */
export interface ImageSource {
  url: string;
  width: number | null;
  height: number | null;
}

export interface Thumbnail extends ImageSource {
  /**
   * true  = url enviada por YouTube (existe seguro).
   * false = variante inferida (oardefault / oar1 / oar2 / oar3 de un short): puede no existir.
   */
  original: boolean;
}

export interface VideoEntry {
  id: string;
  url: string;
  /** Todas las miniaturas, de menor a mayor ancho (en shorts, agrupadas por tamaño). */
  thumbnails: Thumbnail[];
  /** Miniatura base para la card: la mayor entre las `original`. null si no hay ninguna. */
  cover: ImageSource | null;
  /**
   * Shorts: urls del MISMO tamaño que `cover` para animar el hover. La primera es `cover`
   * (existe seguro); el resto son variantes que pueden no existir. Vacio si no hay 2 o mas.
   */
  frames: string[];
  /** Vista previa animada (webp) del hover; solo en videos publicos y directos pasados. */
  animated: ImageSource[];
  params: Record<string, never>;
}

/** Lo minimo que se usa de `Session`; permite inyectar uno falso en pruebas. */
export interface HttpSession {
  post(
    url: string,
    options: Json,
  ): Promise<{ status: number; json<T = unknown>(): T }>;
  close(): Promise<void>;
}

export interface ListingOptions {
  /** "@handle", id "UC...", "channel/UC..." o una URL de canal. */
  channel: string;
  section?: Section;
  sortBy?: SortBy;
  members?: Members;
  impersonate?: string;
  timeoutSec?: number;
  log?: (msg: string) => void;
  /** Crea una sesion HTTP por rafaga de peticiones (se cierra al terminar). Solo para pruebas. */
  sessionFactory?: () => HttpSession;
  /** Reloj en ms (inyectable en pruebas). */
  now?: () => number;
  /** Cola global hacia YouTube. Sin ella, las peticiones salen directamente. */
  gate?: UpstreamGate;
  /** Cache de @handle -> id compartida entre listados. Sin ella, se resuelve cada vez. */
  resolver?: ChannelResolver;
}

export interface ListOptions extends ListingOptions {
  /** Detenerse al encontrar este videoId (inclusive). */
  limitId?: string;
  /** Maximo de items. */
  max?: number;
  /** true => del mas antiguo al mas nuevo. Por defecto false (orden de YouTube). */
  reverse?: boolean;
}

// --------------------------------------------------------------------------- //
// Errores
// --------------------------------------------------------------------------- //

/** Entrada invalida (canal mal escrito, combinacion no permitida). */
export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}

/** Error "de negocio": canal/seccion/orden inexistente. No se reintenta. */
export class ChannelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChannelError";
  }
}

/** Fallo hablando con YouTube (red, 4xx/5xx, formato inesperado). */
export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "UpstreamError";
  }
}

/**
 * Que errores indican que YouTube esta mal (y alimentan el circuit breaker).
 * Un 404 o un 400 son respuestas validas ("no existe"), no una caida.
 */
export function isUpstreamFailure(err: unknown): boolean {
  if (err instanceof UpstreamError) {
    const s = err.status;
    return s === undefined || s === 403 || s === 429 || s >= 500;
  }
  return !(err instanceof ChannelError || err instanceof InputError || err instanceof OverloadedError);
}

// --------------------------------------------------------------------------- //
// Utilidades
// --------------------------------------------------------------------------- //

/** traverse_obj: devuelve undefined si algun paso falla. */
function at(obj: Json, ...path: (string | number)[]): Json {
  let cur = obj;
  for (const key of path) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[key];
  }
  return cur;
}

/** search_dict: busqueda en anchura; no desciende dentro de un valor que coincide. */
function* searchKey(root: Json, key: string): Generator<Json> {
  const queue: Json[] = [root];
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head];
    if (Array.isArray(cur)) {
      queue.push(...cur);
    } else if (cur && typeof cur === "object") {
      for (const [k, v] of Object.entries(cur)) {
        if (k === key) yield v;
        else queue.push(v);
      }
    }
  }
}

const firstOf = (gen: Generator<Json>): Json => {
  const r = gen.next();
  return r.done ? undefined : r.value;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --------------------------------------------------------------------------- //
// Constantes (copiadas del script Python)
// --------------------------------------------------------------------------- //

const API = "https://www.youtube.com/youtubei/v1/";

// Si YouTube deja de aceptar esta version, basta con actualizarla.
const WEB_CLIENT = {
  clientName: "WEB",
  clientVersion: "2.20261023.01.00",
  hl: "en",
  gl: "US",
  platform: "DESKTOP",
};

const SECTION_PARAMS: Record<Section, string> = {
  videos: "EgZ2aWRlb3PyBgQKAjoA",
  shorts: "EgZzaG9ydHPyBgUKA5oBAA%3D%3D",
  streams: "EgdzdHJlYW1z8gYECgJ6AA%3D%3D",
};

const SORT_INDEX: Record<SortBy, number> = { newest: 0, popular: 1, oldest: 2 };
const MEMBERS_SECTIONS: readonly Section[] = ["videos", "shorts"];

const THUMB_PATH_VIDEO = ["lockupViewModel", "contentImage", "thumbnailViewModel", "image", "sources"];
const THUMB_PATHS_SHORTS = [
  ["shortsLockupViewModel", "thumbnailViewModel", "thumbnailViewModel", "image", "sources"],
  ["shortsLockupViewModel", "thumbnailViewModel", "image", "sources"],
  ["shortsLockupViewModel", "thumbnail", "sources"],
];

const UC_ID = /^UC[\w-]{22}$/;

type Cont = [ctp: string, token: string];

// --------------------------------------------------------------------------- //
// Entrada
// --------------------------------------------------------------------------- //

/** Devuelve la ruta del canal: '@handle' o 'channel/UCxxxxxxxxxxxxxxxxxxxxxx'. */
export function parseChannel(channel: string): string {
  let c = (channel ?? "").trim();
  const m = c.match(/youtube\.com\/(@[^/?#\s]+|channel\/UC[\w-]{22})/);
  if (m) return m[1]!; // tolera que peguen una URL
  c = c.replace(/^\/+|\/+$/g, "");
  if (UC_ID.test(c)) return `channel/${c}`;
  if (c.startsWith("channel/") && UC_ID.test(c.slice(8))) return c;
  if (/^@?[\w.\-]{3,}$/.test(c)) return c.startsWith("@") ? c : `@${c}`;
  throw new InputError("channel invalid, use: @handle or channel id (UC...)");
}

// --------------------------------------------------------------------------- //
// Cliente innertube
// --------------------------------------------------------------------------- //

class Innertube {
  private client: Record<string, unknown> = { ...WEB_CLIENT };
  private headers: Record<string, string>;

  constructor(
    private readonly session: HttpSession,
    private readonly timeoutSec: number,
    readonly log: (msg: string) => void,
    visitorData?: string,
    private readonly gate?: UpstreamGate,
    private readonly priority: Priority = "interactive",
  ) {
    this.headers = {
      accept: "*/*",
      "content-type": "application/json",
      origin: "https://www.youtube.com",
      referer: "https://www.youtube.com/",
      "x-youtube-bootstrap-logged-in": "false",
      "x-youtube-client-name": "1",
      "x-youtube-client-version": WEB_CLIENT.clientVersion,
    };
    // Al reanudar un listado se reutiliza el visitante de la rafaga anterior.
    if (visitorData) {
      this.client.visitorData = visitorData;
      this.headers["x-goog-visitor-id"] = visitorData;
    }
  }

  get visitorData(): string | undefined {
    return this.client.visitorData as string | undefined;
  }

  private context(ctp?: string): Json {
    return {
      client: this.client,
      user: { lockedSafetyMode: false },
      request: { useSsl: true, internalExperimentFlags: [], consistencyTokenJars: [] },
      ...(ctp ? { clickTracking: { clickTrackingParams: ctp } } : {}),
    };
  }

  async post(endpoint: string, extra: Json, ctp?: string): Promise<Json> {
    const send = async () => {
      const resp = await this.session.post(API + endpoint, {
        headers: this.headers,
        params: { prettyPrint: "false" },
        json: { context: this.context(ctp), ...extra },
        timeout: this.timeoutSec,
      });
      if (resp.status >= 400) {
        throw new UpstreamError(`YouTube respondio ${resp.status} en ${endpoint}`, resp.status);
      }
      return resp;
    };
    // Cada peticion a YouTube espera su turno en la cola global (si hay).
    const resp = this.gate ? await this.gate.run(this.priority, send) : await send();
    const data = resp.json<Json>();

    // Si no mandamos visitorData, YouTube suele devolver uno: lo reutilizamos.
    const visitor = at(data, "responseContext", "visitorData");
    if (visitor && !this.client.visitorData) {
      this.client.visitorData = visitor;
      this.headers["x-goog-visitor-id"] = visitor;
    }
    return data;
  }
}

// --------------------------------------------------------------------------- //
// Pestaña, chips (orden / miembros) y listado inicial
// --------------------------------------------------------------------------- //

async function openTab(
  yt: Innertube,
  path: string,
  section: Section,
  resolver?: ChannelResolver,
): Promise<Json> {
  let browseId: string;
  if (path.startsWith("channel/")) {
    browseId = path.split("/")[1]!;
  } else {
    const lookup = async (): Promise<string> => {
      yt.log(`resolve_url ${path}`);
      let res: Json;
      try {
        res = await yt.post("navigation/resolve_url", { url: `https://www.youtube.com/${path}` });
      } catch (err) {
        if (err instanceof UpstreamError && err.status === 404) {
          throw new ChannelError(`Channel '${path}' not found`);
        }
        throw err;
      }
      const id = at(res, "endpoint", "browseEndpoint", "browseId");
      if (!id) throw new ChannelError(`Channel '${path}' not found`);
      return id;
    };
    browseId = resolver ? await resolver.resolve(path, lookup) : await lookup();
  }
  yt.log(`browse ${browseId} [${section}]`);
  const data = await yt.post("browse", { browseId, params: SECTION_PARAMS[section] });
  if (!Array.isArray(at(data, "contents", "twoColumnBrowseResultsRenderer", "tabs"))) {
    throw new UpstreamError("respuesta de YouTube sin pestañas (¿cambio de formato?)");
  }
  return data;
}

function findTab(tabs: Json[], section: Section): Json | undefined {
  // Se busca por la URL del endpoint (el titulo esta localizado).
  return tabs.find((tab) => {
    const url = at(tab, "tabRenderer", "endpoint", "commandMetadata", "webCommandMetadata", "url");
    return typeof url === "string" && url.replace(/\/+$/, "").split("/").pop() === section;
  });
}

function initialContents(data: Json, section: Section): Json[] {
  const tabs = at(data, "contents", "twoColumnBrowseResultsRenderer", "tabs") as Json[];
  const tab = findTab(tabs, section);
  const content = tab && at(tab, "tabRenderer", "content");
  if (!content?.richGridRenderer) {
    throw new ChannelError(`This channel has no section ${section}`);
  }
  return at(content, "richGridRenderer", "contents") ?? [];
}

function getChips(source: Json): Json[] {
  const bar = firstOf(searchKey(source, "chipBarViewModel"));
  return at(bar, "chips") ?? [];
}

/** Opciones del desplegable de orden de un chip, o undefined si no es desplegable. */
function chipOptions(chip: Json): Json[] | undefined {
  return at(
    chip,
    "chipViewModel", "tapCommand", "innertubeCommand", "showSheetCommand",
    "panelLoadingStrategy", "inlineContent", "sheetViewModel", "content",
    "listViewModel", "listItems",
  );
}

/** (clickTrackingParams, token) de un endpoint de continuacion. */
function parseEndpoint(endpoint: Json): Cont | undefined {
  if (!endpoint) return undefined;
  const ctp = endpoint.clickTrackingParams;
  const token = at(endpoint, "continuationCommand", "token");
  return ctp && token ? [ctp, token] : undefined;
}

/** Busca recursivamente (clickTrackingParams, token) dentro de `node`. */
function findContinuation(node: Json): Cont | undefined {
  const stack: Json[] = [node];
  while (stack.length) {
    const cur = stack.pop();
    if (Array.isArray(cur)) {
      stack.push(...cur);
    } else if (cur && typeof cur === "object") {
      const token = at(cur, "continuationCommand", "token");
      if (token && cur.clickTrackingParams) return [cur.clickTrackingParams, token];
      stack.push(...Object.values(cur));
    }
  }
  return undefined;
}

/**
 * Filtro de miembros. La barra es [desplegable de orden, "Solo miembros",
 * "Público"]; los textos estan localizados, asi que se usa la posicion.
 */
function filterContinuation(mode: "only" | "public", chips: Json[]): Cont | undefined {
  if (!chips.some((c) => chipOptions(c)?.length)) return undefined; // canal sin miembros
  const filters = chips.filter((c) => !chipOptions(c)?.length);
  const pos = mode === "only" ? 0 : 1;
  if (filters.length <= pos) return undefined;
  return parseEndpoint(at(filters[pos], "chipViewModel", "tapCommand", "innertubeCommand"));
}

/**
 * Orden [newest, popular, oldest] por indice (textos localizados).
 *   1) Canal con miembros: el primer chip es un desplegable con los ordenes.
 *   2) Sin miembros: los chips son directamente los ordenes.
 *   3) Formato antiguo (feedFilterChipBarRenderer) como ultimo recurso.
 */
function sortContinuation(sortBy: SortBy, chips: Json[], data: Json): Cont | undefined {
  const idx = SORT_INDEX[sortBy];

  for (const chip of chips) {
    const options = chipOptions(chip);
    if (options?.length) return findContinuation(options[idx]);
  }

  const direct = parseEndpoint(at(chips, idx, "chipViewModel", "tapCommand", "innertubeCommand"));
  if (direct) return direct;

  const legacy = firstOf(searchKey(data, "feedFilterChipBarRenderer"));
  return parseEndpoint(at(legacy, "contents", idx, "chipCloudChipRenderer", "navigationEndpoint"));
}

/** Separa una respuesta en {header, body}: el header trae la barra de chips actualizada. */
function splitResponse(data: Json): { header: Json[]; body: Json[] } {
  let header: Json[] = [];
  let body: Json[] = [];
  for (const action of data?.onResponseReceivedActions ?? []) {
    const items: Json[] | undefined =
      at(action, "reloadContinuationItemsCommand", "continuationItems") ||
      at(action, "appendContinuationItemsAction", "continuationItems");
    if (!items?.length) continue;
    const objs = items.filter((i) => i && typeof i === "object");
    if (objs.some((i) => "richItemRenderer" in i || "continuationItemRenderer" in i)) body = items;
    else if (objs.some((i) => "chipBarViewModel" in i)) header = items;
  }
  return { header, body };
}

/** (items iniciales, continuacion inicial) para la combinacion pedida. */
async function getListing(
  yt: Innertube,
  data: Json,
  section: Section,
  sortBy: SortBy,
  members: Members,
): Promise<{ contents: Json[]; next?: Cont }> {
  let contents = initialContents(data, section);
  let chips = getChips(data);

  if (members !== "all") {
    const fcont = filterContinuation(members, chips);
    if (fcont) {
      yt.log(`filtro miembros: ${members}`);
      const { header, body } = splitResponse(await yt.post("browse", { continuation: fcont[1] }, fcont[0]));
      contents = body;
      const newChips = getChips(header);
      if (newChips.length) chips = newChips;
    } else if (members === "only") {
      throw new ChannelError(`This channel has no members-only content in ${section}`);
    }
    // public sin filtros => canal sin miembros: no hay nada que excluir
  }

  if (sortBy !== "newest") {
    yt.log(`orden: ${sortBy}`);
    const cont = sortContinuation(sortBy, chips, data);
    if (!cont) throw new ChannelError(`Sort option unavailable (${sortBy}) in ${section}`);
    return { contents: [], next: cont };
  }
  return { contents };
}

// --------------------------------------------------------------------------- //
// Recoleccion
// --------------------------------------------------------------------------- //

function extractVideoId(item: Json, section: Section): string | undefined {
  const content = at(item, "richItemRenderer", "content") ?? {};

  const lockup = content.lockupViewModel;
  if (lockup && typeof lockup === "object") {
    const ctype: string = lockup.contentType ?? "";
    if (ctype && ctype !== "LOCKUP_CONTENT_TYPE_VIDEO") return undefined;
    const raw = JSON.stringify(lockup);
    if (raw.includes("BADGE_STYLE_LIVE") || raw.includes("UPCOMING")) return undefined; // en vivo / estreno
    return lockup.contentId;
  }

  const vd = content.videoRenderer; // formato antiguo
  if (vd && typeof vd === "object") {
    if (vd.upcomingEventData) return undefined;
    if (section !== "shorts" && !vd.publishedTimeText) return undefined;
    return vd.videoId;
  }

  const short = at(content, "shortsLockupViewModel", "onTap", "innertubeCommand", "reelWatchEndpoint");
  if (short?.videoId) return short.videoId;
  if (section === "shorts") return firstOf(searchKey(content, "videoId"));
  return undefined;
}

/** Normaliza a [{url, width, height}], sin duplicados, de menor a mayor. */
function cleanThumbs(sources: Json): ImageSource[] {
  const out: ImageSource[] = [];
  const seen = new Set<string>();
  for (const src of Array.isArray(sources) ? sources : []) {
    const url = src?.url;
    if (typeof url !== "string" || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, width: src.width ?? null, height: src.height ?? null });
  }
  return out.sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
}

/**
 * Variantes de la miniatura de un short. YouTube solo manda una por tamaño
 * (a veces oardefault, otras oar1 / oar2 / oar3), pero las demas existen casi
 * siempre con el mismo `sqp` y `rs`, asi que basta con cambiar el nombre del archivo.
 */
const SHORT_THUMB_VARIANTS = ["oardefault", "oar1", "oar2", "oar3"] as const;
const SHORT_THUMB_VARIANT_RE = /\/(oardefault|oar[123])\.jpg(?=[?#]|$)/;

const variantOf = (url: string): string | undefined => url.match(SHORT_THUMB_VARIANT_RE)?.[1];
const area = (t: ImageSource) => (t.width ?? 0) * (t.height ?? 0);

/**
 * Completa las variantes que faltan, agrupadas por medida: cada tamaño original
 * (p. ej. 405x720 y 405x608) pasa a tener oardefault, oar1, oar2 y oar3.
 * La que mando YouTube queda con `original: true`; las inferidas, con `false`.
 * Las urls que no siguen ese patron se dejan intactas (original: true).
 */
function expandShortThumbs(thumbs: ImageSource[]): Thumbnail[] {
  const out: Thumbnail[] = [];
  const seen = new Set<string>();
  const push = (t: Thumbnail) => {
    if (seen.has(t.url)) return;
    seen.add(t.url);
    out.push(t);
  };
  for (const t of thumbs) {
    if (!variantOf(t.url)) {
      push({ ...t, original: true });
      continue;
    }
    for (const variant of SHORT_THUMB_VARIANTS) {
      const url = t.url.replace(SHORT_THUMB_VARIANT_RE, `/${variant}.jpg`);
      push({ ...t, url, original: url === t.url });
    }
  }
  return out;
}

/**
 * `cover`: la mayor miniatura original (en empate, la primera).
 * `frames`: las variantes del tamaño de `cover`, con `cover` primero.
 */
function describeThumbnails(thumbs: Thumbnail[]): { cover: ImageSource | null; frames: string[] } {
  let best: Thumbnail | undefined;
  for (const t of thumbs) if (t.original && (!best || area(t) > area(best))) best = t;
  if (!best) return { cover: null, frames: [] };
  const cover: ImageSource = { url: best.url, width: best.width, height: best.height };
  if (!variantOf(best.url)) return { cover, frames: [] };

  const sameSize = thumbs.filter((t) => t.width === best.width && t.height === best.height);
  const frames = [best.url];
  for (const variant of SHORT_THUMB_VARIANTS) {
    const t = sameSize.find((x) => variantOf(x.url) === variant);
    if (t && t.url !== best.url) frames.push(t.url);
  }
  return { cover, frames: frames.length >= 2 ? frames : [] };
}

function extractThumbnails(item: Json, section: Section): Thumbnail[] {
  const content = at(item, "richItemRenderer", "content") ?? {};
  if (section === "shorts") {
    for (const path of THUMB_PATHS_SHORTS) {
      const thumbs = cleanThumbs(at(content, ...path));
      if (thumbs.length) return expandShortThumbs(thumbs);
    }
    // respaldo: primer `sources` con urls dentro del short
    for (const sources of searchKey(content.shortsLockupViewModel || content, "sources")) {
      const thumbs = cleanThumbs(sources);
      if (thumbs.length) return expandShortThumbs(thumbs);
    }
    return [];
  }
  let thumbs = cleanThumbs(at(content, ...THUMB_PATH_VIDEO));
  if (!thumbs.length) thumbs = cleanThumbs(at(content, "videoRenderer", "thumbnail", "thumbnails")); // formato antiguo
  return thumbs.map((t) => ({ ...t, original: true }));
}

/** Vista previa animada (webp) del hover; solo en videos publicos y directos pasados. */
function extractAnimated(item: Json): ImageSource[] {
  const content = at(item, "richItemRenderer", "content") ?? {};
  for (const node of searchKey(content, "animatedThumbnailOverlayViewModel")) {
    const thumbs = cleanThumbs(at(node, "thumbnail", "sources"));
    if (thumbs.length) return thumbs;
  }
  return [];
}

async function nextPage(yt: Innertube, [ctp, token]: Cont, retries = 3): Promise<Json[]> {
  for (let i = 0; i < retries; i++) {
    const { body } = splitResponse(await yt.post("browse", { continuation: token }, ctp));
    if (body.length) return body;
    await sleep(1000);
  }
  return [];
}

// --------------------------------------------------------------------------- //
// Listado reanudable
// --------------------------------------------------------------------------- //

function asKnownError(err: unknown): Error {
  if (
    err instanceof ChannelError ||
    err instanceof UpstreamError ||
    err instanceof InputError ||
    err instanceof OverloadedError
  ) {
    return err;
  }
  return new UpstreamError(`fallo al consultar YouTube: ${(err as Error).message}`, undefined, { cause: err });
}

/**
 * Listado de un canal/seccion/orden/filtro que se descarga pagina a pagina.
 *
 * - `entries` crece en el orden de YouTube, sin duplicados (primera aparicion).
 * - `extend(enough)` descarga paginas COMPLETAS hasta que `enough()` sea true o
 *   se acaben. Las llamadas se encolan: dos `extend` simultaneos nunca piden la
 *   misma pagina dos veces.
 * - Si una peticion falla, el estado no cambia: se puede reintentar.
 */
export class ChannelListing {
  readonly entries: VideoEntry[] = [];
  /** true cuando YouTube no tiene mas paginas. */
  complete = false;
  /** ms en que se descargo la primera pagina; undefined mientras no empiece. */
  fetchedAt: number | undefined;

  private readonly ids = new Set<string>();
  private readonly path: string;
  private readonly section: Section;
  private readonly sortBy: SortBy;
  private readonly members: Members;
  private readonly timeoutSec: number;
  private readonly log: (msg: string) => void;
  private readonly now: () => number;
  private readonly makeSession: () => HttpSession;
  private readonly urlBase: string;
  private readonly gate: UpstreamGate | undefined;
  private readonly resolver: ChannelResolver | undefined;

  private next: Cont | undefined;
  private started = false;
  private visitorData: string | undefined;
  private lock: Promise<unknown> = Promise.resolve();

  constructor(opts: ListingOptions) {
    this.path = parseChannel(opts.channel);
    this.section = opts.section ?? "videos";
    this.sortBy = opts.sortBy ?? "newest";
    this.members = opts.members ?? "all";
    this.timeoutSec = opts.timeoutSec ?? 30;
    this.log = opts.log ?? (() => {});
    this.now = opts.now ?? Date.now;
    this.gate = opts.gate;
    this.resolver = opts.resolver;
    if (this.members !== "all" && !MEMBERS_SECTIONS.includes(this.section)) {
      throw new InputError("members only applies to sections 'videos' and 'shorts'");
    }
    const impersonate = opts.impersonate ?? "chrome";
    const timeout = this.timeoutSec;
    this.makeSession = opts.sessionFactory ?? (() => new Session({ impersonate, timeout }) as HttpSession);
    this.urlBase =
      this.section === "shorts" ? "https://www.youtube.com/shorts/" : "https://www.youtube.com/watch?v=";
  }

  has(id: string): boolean {
    return this.ids.has(id);
  }

  /**
   * Descarga paginas hasta que `enough()` sea true o no queden. `() => true` solo asegura la primera.
   * `priority: "background"` (prefetch, refrescos) cede el turno a quien esta esperando una respuesta.
   */
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
        const data = await openTab(yt, this.path, this.section, this.resolver);
        const first = await getListing(yt, data, this.section, this.sortBy, this.members);
        this.absorb(first.contents, first.next);
        this.started = true;
        this.fetchedAt = this.now();
      }
      while (!this.complete && !enough()) {
        const body = await nextPage(yt, this.next!);
        if (!body.length) {
          this.next = undefined;
          this.complete = true;
          break;
        }
        this.absorb(body);
      }
    } catch (err) {
      throw asKnownError(err);
    } finally {
      this.visitorData = yt.visitorData ?? this.visitorData;
      await session.close().catch(() => {});
    }
  }

  /** Procesa una pagina completa y deja listo el token de la siguiente. */
  private absorb(contents: Json[], fallbackNext?: Cont): void {
    let next = fallbackNext;
    for (const item of contents) {
      if (item?.richItemRenderer) {
        if (this.section === "videos" && this.members !== "all") {
          const isMember = JSON.stringify(item).includes("MEMBERS_ONLY");
          if ((this.members === "public" && isMember) || (this.members === "only" && !isMember)) continue;
        }
        const id = extractVideoId(item, this.section);
        if (!id || this.ids.has(id)) continue;
        this.ids.add(id);
        const thumbnails = extractThumbnails(item, this.section);
        this.entries.push({
          id,
          url: `${this.urlBase}${id}`,
          thumbnails,
          ...describeThumbnails(thumbnails),
          animated: extractAnimated(item),
          params: {},
        });
      } else if (item?.continuationItemRenderer) {
        next = parseEndpoint(at(item, "continuationItemRenderer", "continuationEndpoint"));
      }
    }
    this.next = next;
    if (!next) this.complete = true;
  }
}

// --------------------------------------------------------------------------- //
// Vista sobre un listado (limit_id / max / reverse)
// --------------------------------------------------------------------------- //

export interface ViewOptions {
  /** Cortar al encontrar este videoId (inclusive). */
  limitId?: string;
  /** Maximo de items (se toman los primeros, en orden de YouTube). */
  cap?: number;
  /** Invertir el resultado (del mas antiguo al mas nuevo si el orden es `newest`). */
  reverse?: boolean;
}

/**
 * Descarga lo justo para cumplir `limitId` / `cap` (o todo si no hay ninguno) y
 * devuelve la vista. `complete` indica si la vista cubre el canal entero.
 */
export async function materialize(
  listing: ChannelListing,
  { limitId, cap, reverse }: ViewOptions,
): Promise<{ items: VideoEntry[]; complete: boolean }> {
  await listing.extend(
    () =>
      (limitId !== undefined && listing.has(limitId)) ||
      (cap !== undefined && listing.entries.length >= cap),
  );

  let list = listing.entries;
  if (limitId !== undefined) {
    const i = list.findIndex((e) => e.id === limitId);
    if (i >= 0) list = list.slice(0, i + 1);
  }
  if (cap !== undefined && list.length > cap) list = list.slice(0, cap);

  const complete = listing.complete && list.length === listing.entries.length;
  const items = list === listing.entries ? list.slice() : list;
  return { items: reverse ? items.reverse() : items, complete };
}

// --------------------------------------------------------------------------- //
// API publica (un solo uso)
// --------------------------------------------------------------------------- //

export async function listChannel(opts: ListOptions): Promise<VideoEntry[]> {
  const listing = new ChannelListing(opts);
  const { items } = await materialize(listing, {
    limitId: opts.limitId,
    cap: opts.max,
    reverse: opts.reverse ?? false,
  });
  return items;
}
