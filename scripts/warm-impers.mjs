// Descarga libcurl-impersonate durante el BUILD (no en el primer request).
// Sin ella, `impers` cae a la libcurl del sistema y YouTube detecta que no es un navegador.
// Falla el build si no se pudo bajar, para enterarte en el deploy y no en produccion.
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const loader = pathToFileURL(resolve("node_modules/impers/dist/ffi/loader.js")).href;
const { resolveLibrary } = await import(loader);
const lib = await resolveLibrary();
console.log(`[warm-impers] ${lib.path} (impersonate=${lib.isImpersonate})`);
if (!lib.isImpersonate) {
  console.error("[warm-impers] No se pudo obtener libcurl-impersonate (revisa red / GitHub).");
  process.exit(1);
}
