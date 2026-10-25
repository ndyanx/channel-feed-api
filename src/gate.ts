/**
 * Compuerta de salida hacia YouTube (la "cola").
 *
 * TODA peticion HTTP a YouTube pasa por `run()`. La unidad es la PETICION, no el
 * listado: un /all de 200 paginas son 200 turnos en la cola, no un puesto
 * ocupado durante minutos. Asi, otras peticiones se intercalan y nadie se muere
 * de hambre detras de un canal grande.
 *
 * Que hace:
 *   - Concurrencia maxima (`concurrency`) y separacion minima entre inicios
 *     (`minIntervalMs`): limita la tasa global, que es lo que le importa a YouTube.
 *   - Cola FIFO con dos carriles: "interactive" (alguien esta esperando la
 *     respuesta) pasa siempre antes que "background" (prefetch, refrescos).
 *   - Cola acotada: si esta llena, rechaza ya (503) en vez de acumular sin fin.
 *     "background" solo se admite hasta la mitad de la cola y, si no hay sitio,
 *     simplemente se descarta (es trabajo opcional).
 *   - Espera maxima en cola (`maxWaitMs`): mejor un 503 rapido que un cliente
 *     colgado minutos.
 *   - Circuit breaker: tras `breakerThreshold` fallos seguidos de YouTube
 *     (red, 403, 429, 5xx) deja de llamarle `breakerCooldownMs`, vacia la cola
 *     (fallar rapido) y luego prueba con UNA peticion antes de reabrir.
 *
 * Lo que NO hace: deduplicar. Eso ya lo hace `ListingCache` (una descarga por
 * clave) y `ChannelListing.extend` (nunca pide la misma pagina dos veces).
 */

export type Priority = "interactive" | "background";

export type OverloadReason = "queue_full" | "queue_timeout" | "circuit_open";

/** El servidor (o YouTube) no puede atender ahora: 503 con Retry-After. */
export class OverloadedError extends Error {
  constructor(
    message: string,
    readonly reason: OverloadReason,
    readonly retryAfterSec: number,
  ) {
    super(message);
    this.name = "OverloadedError";
  }
}

export interface GateOptions {
  /** Peticiones simultaneas a YouTube (default 2). */
  concurrency?: number;
  /** ms minimos entre el INICIO de dos peticiones (default 0 = sin espaciado). */
  minIntervalMs?: number;
  /** Peticiones esperando como maximo (default 100). */
  maxQueue?: number;
  /** ms maximos esperando turno (default 30000). */
  maxWaitMs?: number;
  /** Fallos seguidos que abren el breaker (default 0 = breaker desactivado). */
  breakerThreshold?: number;
  /** ms que el breaker permanece abierto (default 30000). */
  breakerCooldownMs?: number;
  /** Que errores cuentan como "YouTube esta mal" (default: todos). */
  isFailure?: (err: unknown) => boolean;
  now?: () => number;
}

export interface GateStats {
  running: number;
  queued: { interactive: number; background: number };
  concurrency: number;
  maxQueue: number;
  circuit: "closed" | "open" | "half-open";
  started: number;
  rejected: Record<OverloadReason, number>;
}

interface Waiter {
  priority: Priority;
  probe: boolean;
  start: () => void;
  reject: (err: Error) => void;
  timer?: NodeJS.Timeout;
}

export class UpstreamGate {
  private readonly concurrency: number;
  private readonly minIntervalMs: number;
  private readonly maxQueue: number;
  private readonly maxWaitMs: number;
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly isFailure: (err: unknown) => boolean;
  private readonly now: () => number;

  private readonly queues: Record<Priority, Waiter[]> = { interactive: [], background: [] };
  private running = 0;
  private lastStart = Number.NEGATIVE_INFINITY;
  private pumpTimer: NodeJS.Timeout | undefined;
  private avgMs = 300; // media movil de la duracion de una peticion (para Retry-After)

  private failures = 0;
  private openUntil = 0;
  private probing = false;

  private startedCount = 0;
  private readonly rejectedCount: Record<OverloadReason, number> = {
    queue_full: 0,
    queue_timeout: 0,
    circuit_open: 0,
  };

  constructor(opts: GateOptions = {}) {
    this.concurrency = Math.max(1, opts.concurrency ?? 2);
    this.minIntervalMs = Math.max(0, opts.minIntervalMs ?? 0);
    this.maxQueue = Math.max(1, opts.maxQueue ?? 100);
    this.maxWaitMs = Math.max(1, opts.maxWaitMs ?? 30_000);
    this.threshold = Math.max(0, opts.breakerThreshold ?? 0);
    this.cooldownMs = Math.max(0, opts.breakerCooldownMs ?? 30_000);
    this.isFailure = opts.isFailure ?? (() => true);
    this.now = opts.now ?? Date.now;
  }

  /** Ejecuta `fn` cuando le toque el turno. Rechaza con `OverloadedError` si no hay sitio. */
  run<T>(priority: Priority, fn: () => Promise<T>): Promise<T> {
    let probe = false;

    if (this.threshold > 0 && this.failures >= this.threshold) {
      const remaining = this.openUntil - this.now();
      if (remaining > 0 || this.probing) {
        return Promise.reject(this.reject("circuit_open", "YouTube no responde; reintenta en unos segundos", Math.max(1, Math.ceil(remaining / 1000))));
      }
      probe = this.probing = true; // semiabierto: esta peticion decide si se reabre
    }

    const queued = this.queued();
    const limit = priority === "background" ? Math.max(1, Math.floor(this.maxQueue / 2)) : this.maxQueue;
    if (queued >= limit) {
      if (probe) this.probing = false;
      return Promise.reject(this.reject("queue_full", "servidor saturado; reintenta en unos segundos", this.retryAfter(queued)));
    }

    return new Promise<T>((resolve, reject) => {
      const waiter: Waiter = {
        priority,
        probe,
        reject,
        start: () => this.execute(waiter, fn, resolve, reject),
      };
      waiter.timer = setTimeout(() => {
        const q = this.queues[priority];
        const i = q.indexOf(waiter);
        if (i < 0) return;
        q.splice(i, 1);
        if (waiter.probe) this.probing = false;
        reject(this.reject("queue_timeout", "demasiado tiempo en cola; reintenta en unos segundos", this.retryAfter(this.queued())));
      }, this.maxWaitMs);
      this.queues[priority].push(waiter);
      this.pump();
    });
  }

  stats(): GateStats {
    const open = this.threshold > 0 && this.failures >= this.threshold;
    return {
      running: this.running,
      queued: { interactive: this.queues.interactive.length, background: this.queues.background.length },
      concurrency: this.concurrency,
      maxQueue: this.maxQueue,
      circuit: !open ? "closed" : this.now() < this.openUntil ? "open" : "half-open",
      started: this.startedCount,
      rejected: { ...this.rejectedCount },
    };
  }

  // ----------------------------------------------------------------------- //

  private queued(): number {
    return this.queues.interactive.length + this.queues.background.length;
  }

  private reject(reason: OverloadReason, message: string, retryAfterSec: number): OverloadedError {
    this.rejectedCount[reason]++;
    return new OverloadedError(message, reason, retryAfterSec);
  }

  private retryAfter(queued: number): number {
    const perItem = Math.max(this.avgMs, this.minIntervalMs);
    return Math.min(60, Math.max(1, Math.ceil(((queued + 1) / this.concurrency) * perItem / 1000)));
  }

  /** Arranca todo lo que quepa respetando concurrencia y espaciado. */
  private pump(): void {
    while (this.running < this.concurrency) {
      const q = this.queues.interactive.length ? this.queues.interactive : this.queues.background;
      if (!q.length) return;

      const wait = this.lastStart + this.minIntervalMs - this.now();
      if (wait > 0) {
        if (!this.pumpTimer) {
          this.pumpTimer = setTimeout(() => {
            this.pumpTimer = undefined;
            this.pump();
          }, wait);
        }
        return;
      }

      const waiter = q.shift()!;
      clearTimeout(waiter.timer);
      this.running++;
      this.lastStart = this.now();
      this.startedCount++;
      waiter.start();
    }
  }

  private execute<T>(
    waiter: Waiter,
    fn: () => Promise<T>,
    resolve: (v: T) => void,
    reject: (e: Error) => void,
  ): void {
    const t0 = this.now();
    Promise.resolve()
      .then(fn)
      .then(
        (value) => {
          this.avgMs = this.avgMs * 0.8 + (this.now() - t0) * 0.2;
          this.failures = 0;
          resolve(value);
        },
        (err) => {
          if (this.isFailure(err)) this.onFailure();
          reject(err as Error);
        },
      )
      .finally(() => {
        if (waiter.probe) this.probing = false;
        this.running--;
        this.pump();
      });
  }

  private onFailure(): void {
    if (this.threshold === 0) return;
    this.failures++;
    if (this.failures < this.threshold) return;
    this.openUntil = this.now() + this.cooldownMs;
    // Fallar rapido: lo que esta esperando iba a fallar igual.
    for (const priority of ["interactive", "background"] as const) {
      const q = this.queues[priority];
      for (const w of q.splice(0)) {
        clearTimeout(w.timer);
        if (w.probe) this.probing = false;
        w.reject(this.reject("circuit_open", "YouTube no responde; reintenta en unos segundos", Math.max(1, Math.ceil(this.cooldownMs / 1000))));
      }
    }
  }
}
