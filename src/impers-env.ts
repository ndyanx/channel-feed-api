// DEBE ser el primer import de server.ts. `impers` elige la libcurl al ser importado (await de nivel
// superior), asi que IMPER_CACHE_DIR tiene que estar definida antes de que se evalue cualquier modulo
// que lo importe. dist/impers-env.js -> ../.cache/impers (la misma carpeta que llena scripts/warm-impers.mjs).
import { fileURLToPath } from "node:url";

process.env.IMPER_CACHE_DIR ??= fileURLToPath(new URL("../.cache/impers", import.meta.url));
