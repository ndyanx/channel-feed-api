# channel-feed-api

API (Fastify + TypeScript + `impers`) para listar videos / shorts / directos de un
canal de YouTube y para buscar canales por texto. Es el port del flujo JSON de `youtube_channel.py`, con caché en memoria y
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
| `CACHE_MAX_ITEMS`   | `30000`     | Tope de items sumando todas las listas en memoria (se expulsa la menos usada; la que se sirve nunca) |
| `CACHE_MAX_STALE_SEC` | `21600`   | Edad máxima (6 h) para servir una lista vencida sin esperar; pasada, se espera una descarga nueva |
| `CACHE_STALE_IF_ERROR_SEC` | `86400` | Si esa descarga nueva falla, se sirve la vieja mientras tenga menos de esta edad (24 h) |
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
| `RATE_SEARCH_PER_MIN`       | `60`    | Peticiones/min por IP a `/v1/search/channels` (`0` = sin límite)      |
| `SEARCH_TTL_SEC`            | `300`   | Vigencia de una búsqueda de canales en caché (5 min)                  |
| `SEARCH_MAX_ENTRIES`        | `100`   | Búsquedas en memoria (se expulsa la menos usada)                      |
| `TRUST_PROXY`               | -       | `true` o lista de IP/CIDR del proxy inverso, para ver la IP real      |
| `CORS_ORIGINS`              | -       | Origen(es) del frontend, separados por comas. Vacío = sin CORS (solo mismo origen / proxy). Admite `*` en el host: `https://*.mosaico.pages.dev` |

Ejemplo: `$env:PORT=4000; $env:CACHE_TTL_SEC=300; pnpm dev`

## Desplegar en Render

El repo incluye `render.yaml` (Blueprint), así que casi no hay nada que configurar.

1. Sube el proyecto a GitHub (no se suben `node_modules`, `dist` ni `.cache`: están en `.gitignore`).
2. En Render: **New > Blueprint**, elige el repo y confirma. Render lee `render.yaml`.
3. Cuando termine el deploy, prueba `https://TU-SERVICIO.onrender.com/health` (debe dar `{"ok":true}`; `/` también).

Qué hace el despliegue:

- **Build**: `pnpm install --frozen-lockfile --prod=false && pnpm build`. `pnpm build` compila y
  luego ejecuta `scripts/warm-impers.mjs`, que descarga `libcurl-impersonate` (la librería nativa que usa `impers`) y **falla el build** si no
  puede, para no enterarte en producción de que YouTube recibe tráfico "no navegador".
- **Start**: `node dist/server.js` (TypeScript ya compilado, menos memoria que `tsx`).
- `HOST=0.0.0.0` y `TRUST_PROXY=true`: Render usa un proxy, y sin esto el límite por IP vería a
  todos los clientes como uno solo.
- Plan `free`: el servicio se duerme tras ~15 min sin tráfico (el primer request tarda ~30-60 s)
  y el caché en memoria se pierde al dormirse. Para evitarlo, usa un plan de pago.

### Mantenerlo despierto con UptimeRobot

Render (plan free) duerme el servicio tras 15 min sin tráfico entrante. Un monitor que lo
consulte cada 5 min cuenta como tráfico y evita que se duerma (y te avisa si se cae).

1. Crea una cuenta gratis en [uptimerobot.com](https://uptimerobot.com).
2. **+ Add New Monitor** > tipo **HTTP(s)**.
3. URL: `https://TU-SERVICIO.onrender.com/health`
4. Intervalo: **5 minutos** (el mínimo del plan gratis). Método **HEAD** o **GET**: ambos responden 200.

Detalles:

- Usa `/health` (o `/`). **No** apuntes el monitor a `/v1/channel`: cada chequeo gastaría peticiones a YouTube.
- `/health` y `/` no tocan YouTube, ni el caché, ni cuentan para el límite por IP.
- Un servicio free activo 24/7 usa ~720 de las 750 horas gratis del mes: alcanza para **uno** solo.
- El plan gratis de UptimeRobot es solo para uso personal / no comercial (según sus términos).
- Si el proyecto pasa a ser un servicio serio, el plan Starter de Render no se duerme y no necesita monitor.

**Importante: `CORS_ORIGINS`.** Si el frontend está en otro dominio (p. ej. Cloudflare Pages), el
navegador bloquea las respuestas salvo que el backend las autorice. Render te pedirá este valor al
crear el Blueprint; pon la URL de tu sitio, sin barra final:
`https://mosaico.pages.dev,https://*.mosaico.pages.dev` (el segundo cubre los previews de Pages).
Se cambia sin redeploy de código: Render > Environment > editar > guardar.

Si no usas Blueprint, crea un *Web Service* manual con esos mismos Build/Start Command, y las
variables `NODE_VERSION=22`, `HOST=0.0.0.0`, `TRUST_PROXY=true` y `CORS_ORIGINS=...`.
La librería se guarda en `.cache/impers` dentro del proyecto sin configurar nada más
(`IMPER_CACHE_DIR` solo si quieres otra ruta; `IMPER_SKIP_WARM=1` omite la descarga en local).

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
- **Tope de edad del stale** (`CACHE_MAX_STALE_SEC`, 6 h): una lista más vieja que eso ya no se
  sirve al instante; se espera a una descarga nueva. Si esa descarga falla y la lista tiene menos
  de `CACHE_STALE_IF_ERROR_SEC` (24 h), se sirve la vieja (`cache: "stale"`) en vez de dar 502/503.
  Un canal que ya no existe da 404 (no se sirve de caché).
- **Tope de memoria**: además de `CACHE_MAX_ENTRIES`, el total de items de todas las listas se
  limita con `CACHE_MAX_ITEMS`. Una sola lista mayor que el tope se conserva mientras se usa.
- Peticiones simultáneas de la misma lista comparten una sola descarga.
- Los errores (canal inexistente, red) **no** se guardan en caché.
- Es memoria del proceso: al reiniciar el servidor se pierde.

El campo `cache` de la respuesta indica qué pasó: `miss` (no había nada), `hit` (dentro del
TTL), `stale` (se sirvió lo vencido y se refresca por detrás) o `refresh` (se esperó una
descarga nueva). `updated_at` es el momento en que **la lista cambió por última vez**: al refrescar, si el
principio de la lista nueva es igual al de la vieja (y no aparecen ni desaparecen items en los
extremos conocidos), `updated_at` se conserva. Así solo cambia cuando hay videos nuevos o
borrados, y el frontend puede usarlo para avisar de que conviene recargar sin falsas alarmas.

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

### `GET /v1/search/channels` — buscar canales por texto

Es el buscador de YouTube con el filtro «Tipo: Canal». Sirve para que el frontend ofrezca
sugerencias mientras se escribe y una página de resultados con scroll infinito.

| Parámetro | Valores | Default |
|-----------|---------|---------|
| `q`       | 2 a 100 caracteres (se normaliza: minúsculas y espacios colapsados) | requerido |
| `max`     | 1 a 50: tamaño de página | 20 |
| `offset`  | ≥ 0: cuántos canales saltar | 0 |

```powershell
curl.exe "http://127.0.0.1:3000/v1/search/channels?q=calming+corner&max=8"
curl.exe "http://127.0.0.1:3000/v1/search/channels?q=calming+corner&max=20&offset=20"
```

Respuesta:

```json
{ "query": "calming corner", "offset": 0, "count": 8, "total_estimate": 59193,
  "has_more": true, "cache": "miss", "updated_at": "2026-10-25T...Z", "items": [] }
```

- `total_estimate` es lo que dice YouTube (aproximado); `null` si no lo manda. No es exacto: usa
  `has_more` para saber si hay más.
- La primera página de YouTube trae ~20 canales y cada continuación otros ~20. El token de
  continuación (más de 1000 caracteres) se guarda en el servidor: el cliente solo manda `offset`.
- YouTube repite algunos canales entre páginas: se deduplican por `id`.
- Misma búsqueda (aunque cambien mayúsculas o espacios) = misma entrada de caché; peticiones
  simultáneas comparten una sola descarga. Los errores no se guardan. Tope de 500 canales por búsqueda.
- Pasa por la misma cola global y el mismo circuit breaker que los listados, y tiene su propio
  límite por IP (`RATE_SEARCH_PER_MIN`).

Cada item:

```json
{
  "id": "UCviaNX80vacpLyFUNSDLzZQ",
  "url": "https://www.youtube.com/@calming_cornerASMR",
  "handle": "@calming_cornerASMR",
  "title": "calming corner ASMR",
  "description": "Just a random Russian woman helping you get tingles...",
  "subscribers_text": "36.3K subscribers",
  "subscribers": 36300,
  "thumbnails": [
    { "url": "https://yt3.ggpht.com/ABBf...=s88-c-k-c0x00ffffff-no-rj-mo", "width": 88, "height": 88 },
    { "url": "https://yt3.ggpht.com/ABBf...=s176-c-k-c0x00ffffff-no-rj-mo", "width": 176, "height": 176 }
  ]
}
```

| Campo              | Qué es |
|--------------------|--------|
| `thumbnails`       | Avatar del canal, de menor a mayor ancho (YouTube manda 88 y 176 px). Las URL vienen de YouTube como `//yt3.ggpht.com/...`; la API les pone `https:`. `[]` si no hay. |
| `handle`           | `@handle`, o `null` si el canal no tiene. Con él (o con `id`) se abre el canal en `/v1/channel`. |
| `subscribers_text` | Texto de YouTube tal cual (idioma `hl: "en"`); `null` si el canal oculta sus suscriptores. |
| `subscribers`      | Número aproximado leído de `subscribers_text` (`36.3K` -> 36300); `null` si no se pudo. |
| `description`      | Extracto de la descripción; `""` si no hay. |

Ojo: en el JSON de YouTube los nombres están cruzados (`videoCountText` trae los suscriptores y
`subscriberCountText` trae el @handle). La API lo lee por contenido, no por nombre.

### Items

Con `output=full`, cada item es:

```json
{
  "id": "cjFZfyjyADE",
  "url": "https://www.youtube.com/shorts/cjFZfyjyADE",
  "title": "Título del short",
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
| `title`      | Título tal como lo muestra YouTube (idioma `hl: "en"` del cliente; no es traducible por petición). `""` si no se pudo leer: el item se lista igual. Con `output=urls` / `ids` no se incluye. |
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
  "cache": { "entries": 7, "items": 1840 } }
```

## Estructura

- `src/extractor.ts`: lógica de YouTube (sin Fastify). `extractTitle` lee el título (videos/streams: `lockupMetadataViewModel.title.content`; shorts: `overlayMetadata.primaryText.content`, con `accessibilityText` y formatos antiguos de respaldo). `ChannelListing` es el listado
  reanudable; `materialize` aplica `limit_id` / `max` / `reverse`; `listChannel` es el atajo
  de un solo uso.
- `src/cache.ts`: caché (TTL, refresco en segundo plano, una descarga por clave, LRU, caché negativo, cooldown de `refresh`).
- `src/gate.ts`: cola global hacia YouTube (concurrencia, espaciado, prioridades, cola acotada, circuit breaker).
- `src/resolver.ts`: `@handle` -> id de canal, compartido entre listados.
- `src/service.ts`: casos de uso `page` y `all`.
- `src/search.ts`: búsqueda de canales (`ChannelSearch` reanudable, `SearchCache`, `SearchService`) y las
  funciones puras que leen el JSON de YouTube (`parseChannelRenderer`, `parseSearchPage`, `parseSubscribers`).
- `src/app.ts`: validación (zod), rutas y mapeo de errores. `src/server.ts`: configuración y arranque.
- `test/`: tests con `node:test` y un YouTube falso (`fakeYoutube.ts`; `fakeSearch.ts` para la búsqueda de canales,
  con `channelRenderer` en la forma real de YouTube). `gate.test.ts` prueba la cola
  aislada; `protection.test.ts` recorre los escenarios de la tabla de protección de punta a punta.

## Cambios respecto a la versión anterior

- Caché: `updated_at` ahora marca el último cambio real de la lista (antes, la última descarga);
  tope de edad del stale (`CACHE_MAX_STALE_SEC`) y stale-if-error (`CACHE_STALE_IF_ERROR_SEC`);
  tope de items en memoria (`CACHE_MAX_ITEMS`). `GET /v1/stats` añade `cache.items`.
  Sin cambios en el formato de las respuestas ni en el frontend.

- Nuevo `GET /v1/search/channels` (búsqueda de canales con avatar, handle, suscriptores y descripción).
  Variables nuevas: `RATE_SEARCH_PER_MIN`, `SEARCH_TTL_SEC`, `SEARCH_MAX_ENTRIES`. `GET /v1/stats` añade
  `search.entries`. Sin cambios en los demás endpoints.

- Items: nuevo campo `title` (string, `""` si YouTube no lo mandó en una ruta conocida).

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
