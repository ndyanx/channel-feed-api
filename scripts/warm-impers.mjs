// Descarga libcurl-impersonate durante el BUILD (no en el primer request).
// Sin ella, `impers` cae a la libcurl del sistema y YouTube detecta que no es un navegador.
// Falla el build si no se pudo bajar, para enterarte en el deploy y no en produccion.
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";

// Misma ruta que usa src/server.ts: dentro del proyecto, para que sobreviva del build al runtime
// sin depender de variables del dashboard.
process.env.IMPER_CACHE_DIR ??= fileURLToPath(new URL("../.cache/impers", import.meta.url));
if (process.env.IMPER_SKIP_WARM === "1") {
  console.log("[warm-impers] omitido (IMPER_SKIP_WARM=1)");
  process.exit(0);
}

const loader = pathToFileURL(resolve("node_modules/impers/dist/ffi/loader.js")).href;
const { resolveLibrary } = await import(loader);
const lib = await resolveLibrary();
console.log(`[warm-impers] ${lib.path} (impersonate=${lib.isImpersonate})`);
if (!lib.isImpersonate) {
  console.error("[warm-impers] No se pudo obtener libcurl-impersonate (revisa red / GitHub).");
  process.exit(1);
}
