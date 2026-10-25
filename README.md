# channel-feed-api

API (Fastify + TypeScript + `impers`) para listar videos / shorts / directos de un
canal de YouTube. Es el port del flujo JSON de `youtube_channel.py`, con caché en memoria y
paginación.

## Arrancar (PowerShell)

```powershell
pnpm install
pnpm dev        # recarga al guardar
pnpm build && pnpm start   # version compilada (la que corre en produccion)
pnpm test       # tests (sin red: usan un YouTube falso)
pnpm typecheck
```

Escucha en `http://127.0.0.1:3000` (solo tu máquina). Variables de entorno:

| Variable            | Default     | Qué hace                                                        |
|---------------------|-------------|-----------------------------------------------------------------|
| `HOST` / `PORT`     | 127.0.0.1 / 3000 |                                                            |
| `LOG_LEVEL`         | `info`      |                                                                 |
| `CACHE_TTL_SEC`     | `600`       | Vigencia de una lista en caché (10 min)                         |
| `CACHE_MAX_ENTRIES` | `50`        | Listas en memoria (se expulsa la menos usada)                   |
| `REFRESH_PREFIX`    | `300`       | Items que se vuelven a bajar en un refresco en segundo plano    |
| `PREFETCH_AHEAD`    | `60`        | Items extra que se bajan en segundo plano tras responder una página (`0` = nada) |

Protección (ver [Protección contra sobrecarga](#protección-contra-sobrecarga)):

| Variable                    | Default | Qué hace                                                              |
|-----------------------------|---------|-----------------------------------------------------------------------|
| `UPSTREAM_CONCURRENCY`      | `2`     | Peticiones simultáneas a YouTube (toda la API, todos los clientes)    |
| `UPSTREAM_MIN_INTERVAL_MS`  | `150`   | Separación mínima entre el inicio de dos peticiones a YouTube         |
| `UPSTREAM_MAX_QUEUE`        | `100`   | Peticiones esperando turno; si se llena: 503                          |
| `UPSTREAM_MAX_WAIT_SEC`     | `30`    | Espera máxima en cola; pasado esto: 503                               |
| `BREAKER_THRESHOLD`         | `5`     | Fallos seguidos de YouTube que abren el breaker (`0` = desactivado)   |
| `BREAKER_COOLDOWN_SEC`      | `30`    | Tiempo que el breaker deja de llamar a YouTube                        |
| `RESOLVE_TTL_SEC`           | `86400` | Cuánto se recuerda `@handle` -> id de canal                           |
| `NEGATIVE_TTL_SEC`          | `120`   | Cuánto se recuerda que un canal/sección NO existe (`0` = no)          |
| `REFRESH_COOLDOWN_SEC`      | `30`    | Edad mínima de una lista para aceptar `refresh=true`                  |
| `RATE_PAGE_PER_MIN`         | `120`   | Peticiones/min por IP a `/v1/channel` (`0` = sin límite)              |
| `RATE_ALL_PER_MIN`          | `6`     | Peticiones/min por IP a `/v1/channel/all` (`0` = sin límite)          |
| `TRUST_PROXY`               | -       | `true` o lista de IP/CIDR del proxy inverso, para ver la IP real      |

Ejemplo: `$env:PORT=4000; $env:CACHE_TTL_SEC=300; pnpm dev`

## Desplegar en Render

El repo incluye `render.yaml` (Blueprint), así que casi no hay nada que configurar.

1. Sube el proyecto a GitHub (no se suben `node_modules`, `dist` ni `.cache`: están en `.gitignore`).
2. En Render: **New > Blueprint**, elige el repo y confirma. Render lee `render.yaml`.
3. Cuando termine el deploy, prueba `https://TU-SERVICIO.onrender.com/health` (debe dar `{"ok":true}`).

Qué hace el despliegue:

- **Build**: `pnpm install --frozen-lockfile --prod=false && pnpm build && pnpm warm`. `pnpm warm`
  descarga `libcurl-impersonate` (la librería nativa que usa `impers`) y **falla el build** si no
  puede, para no enterarte en producción de que YouTube recibe tráfico "no navegador".
- **Start**: `node dist/server.js` (TypeScript ya compilado, menos memoria que `tsx`).
- `HOST=0.0.0.0` y `TRUST_PROXY=true`: Render usa un proxy, y sin esto el límite por IP vería a
  todos los clientes como uno solo.
- Plan `free`: el servicio se duerme tras ~15 min sin tráfico (el primer request tarda ~30-60 s)
  y el caché en memoria se pierde al dormirse. Para evitarlo, usa un plan de pago.

Si no usas Blueprint, crea un *Web Service* manual con esos mismos Build/Start Command, y las
variables `NODE_VERSION=22`, `HOST=0.0.0.0`, `TRUST_PROXY=true` e
`IMPER_CACHE_DIR=/opt/render/project/src/.cache/impers`.

Aviso: YouTube puede bloquear o limitar las IP de centros de datos (Render incluido). Si ves
`502`/`503` con `circuit_open` en producción pero funciona en tu PC, es eso.

## Cómo funciona el caché

Una lista = **canal + section + sort_by + members**. Todo lo demás (`max`, `offset`, `reverse`,
`limit_id`, `output`) se aplica sobre la lista cacheada sin volver a llamar a YouTube.

- La lista se descarga **bajo demanda**, página a página (≈30 items por página de YouTube) y
  se conserva: pedir los primeros 60 y luego hasta el final solo descarga lo que falta.
- **Vigencia 10 min** desde que se bajó la primera página.
- Pasados los 10 min, `/v1/channel` responde **al instante con lo viejo** (`cache: "stale"`) y
  refresca por detrás; si el refresco falla sigue sirviendo lo viejo y espera 30 s antes de
  reintentar. `/v1/channel/all` **espera datos frescos** (o usa lo viejo con `stale=ok`).
- Peticiones simultáneas de la misma lista comparten una sola descarga.
- Los errores (canal inexistente, red) **no** se guardan en caché.
- Es memoria del proceso: al reiniciar el servidor se pierde.

El campo `cache` de la respuesta indica qué pasó: `miss` (no había nada), `hit` (dentro del
TTL), `stale` (se sirvió lo vencido y se refresca por detrás) o `refresh` (se esperó una
descarga nueva). `updated_at` es el momento en que se bajó la primera página.

## Protección contra sobrecarga

Hay cuatro capas, de fuera hacia dentro. Las dos primeras evitan trabajo; las dos últimas
limitan el que no se pudo evitar.

**1. Limite por IP** (`@fastify/rate-limit`, 429 + `Retry-After`). Cuota propia para
`/v1/channel` y otra, más estricta, para `/v1/channel/all`. Las peticiones inválidas también
cuentan. Detrás de un proxy (o del proxy de Vite) todos los clientes comparten IP: configura
`TRUST_PROXY` o este límite no distinguirá a nadie. `/health` y `/v1/stats` no cuentan.

**2. No repetir trabajo** (qué pasa según qué se repita):

| Escenario | Qué ocurre |
|-----------|------------|
| Dos usuarios, mismos parámetros, a la vez | Una sola descarga; el resto espera y comparte (`ListingCache` + `ChannelListing.extend`) |
| Mismo canal escrito distinto (`@Canal`, `canal`, URL) | Se normaliza a la misma clave |
| Mismo canal, distinto `max`, `offset`, `reverse`, `output`, `limit_id` | Mismo listado; solo se descarga lo que falte, nunca una página dos veces |
| Mismo canal, distinta `section` / `sort_by` / `members` | Listados distintos (son datos distintos), pero el `@handle` se resuelve **una vez** (`ChannelResolver`) |
| Canal o sección que no existe, repetido | `404` desde el caché negativo, sin llamar a YouTube |
| `refresh=true` en bucle | Dentro de `REFRESH_COOLDOWN_SEC` se sirve el caché (`cache: "hit"`); simultáneos comparten una descarga |
| Respuestas ya cacheadas con la cola saturada | No pasan por la cola: siguen respondiendo al instante |

**3. Cola hacia YouTube** (`src/gate.ts`). *Toda* petición HTTP a YouTube pasa por una cola
global con concurrencia y separación mínima. La unidad es la **petición**, no el listado: un
`/all` de 200 páginas ocupa 200 turnos sueltos, y otras peticiones se intercalan en vez de
esperar a que termine. Dos carriles: `interactive` (alguien espera la respuesta) siempre pasa
antes que `background` (prefetch y refrescos), que solo se admite hasta la mitad de la cola y
se descarta si no hay sitio. Cola llena o espera excesiva => **503** con `Retry-After`.
Si una descarga se corta a mitad por esto, lo ya bajado se conserva y el reintento continúa
desde ahí.

**4. Circuit breaker** (dentro de la cola). Tras `BREAKER_THRESHOLD` fallos seguidos de YouTube
(red, 403, 429, 5xx; un 404 no cuenta) deja de llamarle `BREAKER_COOLDOWN_SEC`, responde 503
al instante (`reason: "circuit_open"`) y vacía la cola. Después deja pasar **una** petición de
prueba: si sale bien se cierra, si falla vuelve a abrir.

Límites conocidos: la protección es por proceso (con varias instancias cada una tiene su cola
y su caché); un refresco en segundo plano al que se une una petición interactiva sigue con
prioridad de fondo; y la memoria depende de `CACHE_MAX_ENTRIES` x tamaño de canal (no hay tope
por items).

## Endpoints

Parámetros comunes a los dos:

| Parámetro  | Valores                                  | Default  |
|------------|------------------------------------------|----------|
| `channel`  | `@handle`, `UC...` o URL de canal        | requerido |
| `section`  | `videos`, `shorts`, `streams` (alias: `video`, `short`, `live`, `stream`) | `videos` |
| `sort_by`  | `newest`, `popular`, `oldest`            | `newest` |
| `members`  | `all`, `public`, `only` (solo videos y shorts) | `all` |
| `output`   | `full`, `urls`, `ids`                    | `full` |
| `limit_id` | videoId donde cortar (inclusive)         | - |
| `reverse`  | `true` = invertir el resultado (con `newest`: del más antiguo al más nuevo) | **`false`** |

### `GET /v1/channel` — una página (para el masonry)

| Parámetro | Valores | Default |
|-----------|---------|---------|
| `max`     | 1 a 10000: **tamaño de página** | 100 |
| `offset`  | ≥ 0: cuántos items saltar        | 0 |

```powershell
curl.exe "http://127.0.0.1:3000/v1/channel?channel=@ASMRKittyKlaw&section=shorts&max=60"
curl.exe "http://127.0.0.1:3000/v1/channel?channel=@ASMRKittyKlaw&section=shorts&max=60&offset=60"
```

Respuesta:

```json
{ "channel": "@asmrkittyklaw", "section": "shorts", "offset": 60, "count": 60,
  "total": null, "has_more": true, "cache": "hit", "updated_at": "2026-10-24T...Z", "items": [] }
```

- `total` es `null` hasta que el canal se ha descargado entero. `has_more` es `true` mientras
  no se llegue al final (YouTube no avisa de antemano: la última página puede salir vacía).
- Una página nunca baja más de lo necesario; tras responder, en segundo plano baja
  `PREFETCH_AHEAD` items más para que la siguiente salga del caché.
- Con `reverse=true` o `limit_id` hace falta conocer el extremo de la lista: baja hasta
  `limit_id`, o **todo el canal** si solo hay `reverse`; `total` es entonces exacto.
- Si entra un video nuevo mientras paginas, los offsets se corren en 1 y puede repetirse un
  item entre páginas: deduplica por `id` en el cliente (y compara `updated_at`).

### `GET /v1/channel/all` — la lista completa (para scripts y otros proyectos)

| Parámetro | Valores | Default |
|-----------|---------|---------|
| `max`     | ≥ 1: tope de items (opcional, **sin tope por defecto**) | - |
| `refresh` | `true` = ignorar el caché y descargar de nuevo | `false` |
| `stale`   | `ok` = aceptar datos vencidos (se refrescan por detrás) en vez de esperar | - |

```powershell
curl.exe "http://127.0.0.1:3000/v1/channel/all?channel=@ASMRKittyKlaw&output=ids"
curl.exe "http://127.0.0.1:3000/v1/channel/all?channel=@ASMRKittyKlaw&refresh=true"
curl.exe "http://127.0.0.1:3000/v1/channel/all?channel=@ASMRKittyKlaw&limit_id=cjFZfyjyADE&reverse=true"
```

Respuesta: `{ channel, section, count, complete, cache, updated_at, items }`. `complete` es
`true` solo si `items` cubre el canal entero (no hubo corte por `max` ni `limit_id`).

Un canal grande puede tardar minutos: sube el timeout de tu cliente. Si el cliente se
desconecta, la descarga sigue y queda en caché.

(Comillas siempre: en PowerShell `&` rompe la URL. Y `curl.exe`, no `curl`, que es un alias.)

### Items

Con `output=full`, cada item es:

```json
{
  "id": "cjFZfyjyADE",
  "url": "https://www.youtube.com/shorts/cjFZfyjyADE",
  "thumbnails": [ { "url": "...", "width": 405, "height": 720, "original": true }, ... ],
  "cover":  { "url": "...", "width": 405, "height": 720 },
  "frames": [ "...oar3.jpg?...", "...oardefault.jpg?...", "...oar1.jpg?...", "...oar2.jpg?..." ],
  "animated": [],
  "params": {}
}
```

Con `output=urls` / `ids`, son strings.

| Campo        | Qué es |
|--------------|--------|
| `thumbnails` | Todas las miniaturas, de menor a mayor ancho (en shorts, agrupadas por tamaño). |
| `original`   | `true` = la mandó YouTube (existe seguro). `false` = variante inferida: **puede no existir**, hay que validarla en el cliente (`onerror`). |
| `cover`      | Miniatura base para la card: la **mayor entre las `original`** (en empate, la primera). Es la que usa el masonry para calcular el alto (`width`/`height`) y para mostrar la card. `null` si no hay ninguna. |
| `frames`     | Solo shorts: urls del **mismo tamaño que `cover`** para animar el hover. La primera es `cover` (existe seguro); el resto, en orden `oardefault, oar1, oar2, oar3`, pueden no existir. `[]` si no hay al menos 2. |
| `animated`   | Vista previa animada (webp) del hover; solo en videos públicos y directos pasados. |

**Shorts:** YouTube manda una sola variante de miniatura por tamaño (a veces `oardefault`,
otras `oar1`, `oar2` u `oar3`). La API completa las cuatro para cada tamaño (405x720 y
405x608), con el mismo `sqp` y `rs`: 8 miniaturas por short. Los dos tamaños son **recortes
distintos** (9:16 y 2:3), no dos resoluciones de la misma imagen; por eso `cover` y `frames`
usan siempre un solo tamaño. Si un short solo trae una miniatura sin variantes (p. ej.
`hq720.jpg`), se deja tal cual: `thumbnails` tiene 1 item, `cover` es ese item y `frames` es `[]`.

El backend **no comprueba** si las variantes inferidas existen (serían 8 peticiones por short);
eso lo valida el frontend al precargarlas. Videos y streams no se tocan: todas sus miniaturas
son `original`.

### Errores

`{ "error": { "type", "message" } }`

| Código | Cuándo |
|--------|--------|
| 400 | parámetros inválidos (`issues` indica cuál) |
| 404 | canal o sección inexistente, sin contenido de miembros, orden no disponible |
| 429 | demasiadas peticiones desde tu IP (`Retry-After` en segundos) |
| 502 | falló la comunicación con YouTube (red, 4xx/5xx, cambio de formato) |
| 503 | cola saturada, espera excesiva o breaker abierto; `error.reason` = `queue_full` / `queue_timeout` / `circuit_open`, y `Retry-After` en segundos |
| 500 | error interno |

`GET /health` -> `{ "ok": true }`

`GET /v1/stats` -> estado de la cola y del caché (para ver si hay saturación):

```json
{ "upstream": { "running": 2, "queued": { "interactive": 3, "background": 0 },
                "concurrency": 2, "maxQueue": 100, "circuit": "closed", "started": 412,
                "rejected": { "queue_full": 0, "queue_timeout": 0, "circuit_open": 0 } },
  "cache": { "entries": 7 } }
```

## Estructura

- `src/extractor.ts`: lógica de YouTube (sin Fastify). `ChannelListing` es el listado
  reanudable; `materialize` aplica `limit_id` / `max` / `reverse`; `listChannel` es el atajo
  de un solo uso.
- `src/cache.ts`: caché (TTL, refresco en segundo plano, una descarga por clave, LRU, caché negativo, cooldown de `refresh`).
- `src/gate.ts`: cola global hacia YouTube (concurrencia, espaciado, prioridades, cola acotada, circuit breaker).
- `src/resolver.ts`: `@handle` -> id de canal, compartido entre listados.
- `src/service.ts`: casos de uso `page` y `all`.
- `src/app.ts`: validación (zod), rutas y mapeo de errores. `src/server.ts`: configuración y arranque.
- `test/`: tests con `node:test` y un YouTube falso (`fakeYoutube.ts`). `gate.test.ts` prueba la cola
  aislada; `protection.test.ts` recorre los escenarios de la tabla de protección de punta a punta.

## Cambios respecto a la versión anterior

- `GET /v1/channel` ahora pagina (`offset`, `total`, `has_more`, `cache`, `updated_at`).
- **`reverse` por defecto es `false`** (antes `true`).
- `max` en `/v1/channel` es el tamaño de página; ya no existe un tope de "máximo de la
  consulta": para la lista completa usa `/v1/channel/all`.
- Nuevo `GET /v1/channel/all`.
- Shorts: 8 miniaturas por item (4 variantes × 2 tamaños).
- Items nuevos: `thumbnails[].original`, `cover` y `frames`.

## Diferencias con el script Python

- **Sin respaldo por HTML.** Si el flujo JSON falla, responde 502.
- La respuesta va envuelta en un objeto en vez de ser un array suelto.

## Notas

- `esbuild` y `koffi` están en `allowBuilds: false` (`pnpm-workspace.yaml`); no hacen falta.
- Si `impers` falla con "Impersonating ... is not supported", la descarga automática de
  libcurl-impersonate falló en silencio: ver el README del spike (`LIBCURL_PATH`).
- Versiones fijadas exactas (sin `^`), porque `impers` es alfa.
- Los tests cubren la lógica con respuestas simuladas; el formato real de YouTube (y que los
  tokens de continuación sigan válidos) solo se comprueba en vivo.
