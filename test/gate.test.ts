import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OverloadedError, UpstreamGate } from "../src/gate.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Tarea que dura `ms` y registra cuantas hay en vuelo a la vez. */
function probe() {
  let cur = 0;
  let max = 0;
  const order: string[] = [];
  const task = (name: string, ms = 10) => async () => {
    cur++;
    max = Math.max(max, cur);
    order.push(name);
    await sleep(ms);
    cur--;
    return name;
  };
  return { task, order, get max() { return max; } };
}

const reason = (e: unknown) => (e instanceof OverloadedError ? e.reason : String(e));

describe("UpstreamGate", () => {
  it("nunca supera la concurrencia", async () => {
    const gate = new UpstreamGate({ concurrency: 2 });
    const p = probe();
    const res = await Promise.all(Array.from({ length: 8 }, (_, i) => gate.run("interactive", p.task(`t${i}`))));
    assert.equal(res.length, 8);
    assert.equal(p.max, 2);
  });

  it("interactive pasa antes que background aunque llegue despues", async () => {
    const gate = new UpstreamGate({ concurrency: 1 });
    const p = probe();
    const all = [
      gate.run("interactive", p.task("primera", 30)), // ocupa el unico hueco
      gate.run("background", p.task("bg1")),
      gate.run("background", p.task("bg2")),
      gate.run("interactive", p.task("fg1")),
      gate.run("interactive", p.task("fg2")),
    ];
    await Promise.all(all);
    assert.deepEqual(p.order, ["primera", "fg1", "fg2", "bg1", "bg2"]);
  });

  it("separa el inicio de dos peticiones al menos minIntervalMs", async () => {
    const gate = new UpstreamGate({ concurrency: 5, minIntervalMs: 40 });
    const starts: number[] = [];
    await Promise.all(
      Array.from({ length: 4 }, () =>
        gate.run("interactive", async () => {
          starts.push(Date.now());
        }),
      ),
    );
    for (let i = 1; i < starts.length; i++) {
      assert.ok(starts[i]! - starts[i - 1]! >= 35, `hueco ${starts[i]! - starts[i - 1]!} ms`);
    }
  });

  it("cola llena: rechaza con queue_full y Retry-After >= 1", async () => {
    const gate = new UpstreamGate({ concurrency: 1, maxQueue: 2 });
    const p = probe();
    const ok = [1, 2, 3].map((i) => gate.run("interactive", p.task(`t${i}`, 30))); // 1 corre + 2 esperan
    const err = await gate.run("interactive", p.task("sobra")).catch((e) => e);
    assert.ok(err instanceof OverloadedError);
    assert.equal(err.reason, "queue_full");
    assert.ok(err.retryAfterSec >= 1);
    await Promise.all(ok);
    assert.equal(gate.stats().rejected.queue_full, 1);
  });

  it("background solo se admite hasta la mitad de la cola", async () => {
    const gate = new UpstreamGate({ concurrency: 1, maxQueue: 4 });
    const p = probe();
    const first = gate.run("interactive", p.task("corre", 30));
    const bg = [1, 2, 3].map((i) => gate.run("background", p.task(`bg${i}`)).then(() => "ok", reason));
    assert.deepEqual(await Promise.all(bg), ["ok", "ok", "queue_full"]);
    await first;
  });

  it("espera maxima: sale de la cola con queue_timeout", async () => {
    const gate = new UpstreamGate({ concurrency: 1, maxWaitMs: 20 });
    const p = probe();
    const slow = gate.run("interactive", p.task("lenta", 80));
    const err = await gate.run("interactive", p.task("impaciente")).catch((e) => e);
    assert.equal(reason(err), "queue_timeout");
    assert.deepEqual(p.order, ["lenta"]); // la impaciente nunca llego a ejecutarse
    await slow;
  });

  describe("circuit breaker", () => {
    const boom = async () => {
      throw new Error("red");
    };

    it("abre tras N fallos seguidos, falla rapido y vacia la cola", async () => {
      let t = 0;
      const gate = new UpstreamGate({ concurrency: 1, breakerThreshold: 2, breakerCooldownMs: 1000, now: () => t });
      const p = probe();
      const a = gate.run("interactive", boom).catch((e) => e);
      const b = gate.run("interactive", boom).catch((e) => e);
      const waiting = gate.run("interactive", p.task("en_cola")).catch((e) => e); // espera tras b
      await Promise.all([a, b]);
      assert.equal(reason(await waiting), "circuit_open");
      assert.equal(p.order.length, 0);
      assert.equal(gate.stats().circuit, "open");

      const next = await gate.run("interactive", p.task("nueva")).catch((e) => e);
      assert.equal(reason(next), "circuit_open");
      assert.ok((next as OverloadedError).retryAfterSec >= 1);
    });

    it("tras el cooldown deja pasar UNA prueba; si sale bien, se cierra", async () => {
      let t = 0;
      const gate = new UpstreamGate({ concurrency: 3, breakerThreshold: 1, breakerCooldownMs: 1000, now: () => t });
      await gate.run("interactive", boom).catch(() => {});
      assert.equal(gate.stats().circuit, "open");

      t = 1500;
      assert.equal(gate.stats().circuit, "half-open");
      const p = probe();
      const results = await Promise.all([
        gate.run("interactive", p.task("prueba", 20)).catch(reason),
        gate.run("interactive", p.task("otra", 20)).catch(reason), // mientras se prueba, no pasa
      ]);
      assert.deepEqual(results, ["prueba", "circuit_open"]);
      assert.equal(gate.stats().circuit, "closed");
      assert.equal(await gate.run("interactive", p.task("normal")), "normal");
    });

    it("si la prueba falla, vuelve a abrir", async () => {
      let t = 0;
      const gate = new UpstreamGate({ concurrency: 1, breakerThreshold: 1, breakerCooldownMs: 1000, now: () => t });
      await gate.run("interactive", boom).catch(() => {});
      t = 1500;
      await gate.run("interactive", boom).catch(() => {});
      assert.equal(gate.stats().circuit, "open");
    });

    it("los errores que isFailure descarta (p. ej. un 404) no cuentan", async () => {
      const gate = new UpstreamGate({
        concurrency: 1,
        breakerThreshold: 2,
        isFailure: (e) => (e as Error).message !== "no existe",
      });
      for (let i = 0; i < 5; i++) {
        await gate.run("interactive", async () => {
          throw new Error("no existe");
        }).catch(() => {});
      }
      assert.equal(gate.stats().circuit, "closed");
    });

    it("un exito reinicia la cuenta de fallos", async () => {
      const gate = new UpstreamGate({ concurrency: 1, breakerThreshold: 2 });
      await gate.run("interactive", boom).catch(() => {});
      await gate.run("interactive", async () => "ok");
      await gate.run("interactive", boom).catch(() => {});
      assert.equal(gate.stats().circuit, "closed");
    });
  });
});
