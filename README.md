# Job Hunter

## Datos locales y configuracion

Los datos privados se guardan bajo `JOB_HUNTER_DATA_DIR`. Por defecto se usa
`runtime-data/` dentro del proyecto; las rutas relativas configuradas se resuelven tambien
desde la raiz del proyecto. Se puede copiar `.env.example` como `.env` para definir esta
ruta y otras variables locales sin versionar secretos.

Un clon limpio no contiene perfiles reales. Antes de ejecutar un hunt deben existir
`profile/profile.json`, `profile/matchingProfile.json` y `profile/careerContext.json`
dentro de `JOB_HUNTER_DATA_DIR`; si faltan, la aplicacion informa de forma controlada que
Job Hunter todavia no esta configurado.

La pantalla local `/setup` incluye un Profile Builder: la persona pega texto de su CV,
LinkedIn o experiencia profesional y OpenAI genera un borrador de los tres perfiles. El
borrador se muestra para revisión y sólo reemplaza los perfiles vigentes cuando el usuario
lo confirma. El texto original no se persiste. Esta primera versión no admite PDF ni DOCX.
El modelo se configura con `OPENAI_PROFILE_MODEL`; si falta, usa `OPENAI_MODEL` y finalmente
el default `gpt-4.1-mini`.

La configuracion no secreta del usuario vive en `JOB_HUNTER_DATA_DIR/config/user.json`;
`src/config/user.example.json` documenta su estructura (`identity` y `search`). La API key
continua exclusivamente en `.env`/`process.env`. Aunque `search.locations` admite varias
ubicaciones para evolucion futura, en esta version el collector consume solamente la primera
como ubicacion primaria. `search.modalities` se guarda pero aun no altera los filtros del collector.

Aplicacion local para automatizar, por etapas, la busqueda laboral. Implementado con Playwright sobre un perfil de Chromium persistente.

## LinkedIn Collector

El collector:

- abre Chromium visible con el perfil persistente `./browser-profile`;
- verifica que exista una sesion autenticada de LinkedIn;
- entra a LinkedIn Jobs;
- ejecuta la busqueda configurada en `src/config.js`;
- aplica los filtros (Location, Employment type, Date posted) usando la UI real de LinkedIn;
- recorre TODAS las paginas de resultados dentro de los limites configurados;
- deduplica por `jobId`;
- imprime un JSON con metadata + jobs por consola;
- deja el navegador abierto para inspeccion manual.

No automatiza login, no usa el Chrome personal y no intenta resolver CAPTCHAs, checkpoints ni verificaciones (si aparece un challenge, se detiene y registra el motivo).

## Milestone actual: Multiple searches + global deduplication

Ejecuta varias busquedas laborales reutilizando exactamente los mismos filtros y
paginacion del milestone anterior, y combina todo deduplicando globalmente por `jobId`
sin perder de que busqueda/familia vino cada oferta.

**Optimizacion (flujo actual):** los filtros se aplican por UI **una sola vez** (en la
primera query). Para las siguientes solo se cambia el keyword desde el buscador; los
filtros activos (location, employment type, date posted) se conservan y siguen siendo
verificables por query. Verificado contra el comportamiento real de LinkedIn: el `geoId`,
`f_JT` y `f_TPR` persisten al cambiar el keyword. Esto reduce el tiempo total ~3x.
`searchScope` expone para esto: `initializeSearchWithFilters()`, `changeSearchQuery()` y
`collectCurrentSearch()`.

Filtros aplicados a TODAS las busquedas (por UI real de LinkedIn):

- Location: `Barcelona` (LinkedIn lo resuelve a `geoId=107025191`)
- Employment type: `Full-time`
- Date posted: `Past week`

### Busquedas (`SEARCH_QUERIES` en `src/config.js`)

Agrupadas por familia, con flags `enabled` (familia y query) y `priority` para poder
activar/desactivar y priorizar mas adelante:

- **operations**: Head of Operations, Operations Lead, Business Operations, Business Operations Lead, Operations Manager
- **delivery**: Head of Delivery, Delivery Lead, Delivery Manager
- **strategy**: Strategy & Operations, Business Transformation, Digital Transformation
- **product**: Head of Product Operations, Product Operations, Product Operations Manager

### Configuracion de limites

| Variable                 | Default | Significado                                                    |
| ------------------------ | ------- | ------------------------------------------------------------- |
| `MAX_RESULTS_PER_SEARCH` | `25`    | Limite de **jobs unicos por busqueda**. `0` = sin limite.     |
| `MAX_PAGES_PER_SEARCH`   | `2`     | Safety limit de paginas por busqueda. `0` = sin limite.       |
| `MAX_RESULTS` / `MAX_PAGES` | `100` / `0` | (Compat.) limites del flujo de busqueda unica anterior. |

### Deduplicacion global

Cada oferta se conserva una sola vez (por `jobId`) y acumula:

- `matchedQueries`: todas las queries que la encontraron;
- `matchedFamilies`: todas las familias correspondientes.

## Ejecutar

```powershell
npm run collect:linkedin
```

Con diagnostico (cabecera por query, por pagina resultados/nuevos/acumulado, y un SEARCH SUMMARY final):

```powershell
npm run collect:linkedin -- --debug
```

Limites de desarrollo (recomendado para pruebas):

```powershell
$env:MAX_RESULTS_PER_SEARCH=25; $env:MAX_PAGES_PER_SEARCH=2; npm run collect:linkedin -- --debug
```

Sin limite (recorre todo lo que LinkedIn permita):

```powershell
$env:MAX_RESULTS_PER_SEARCH=0; $env:MAX_PAGES_PER_SEARCH=0; npm run collect:linkedin -- --debug
```

El JSON principal se imprime por `stdout`. Los diagnosticos de `--debug` se imprimen por `stderr`.
Al terminar, el navegador queda abierto hasta que cierres la ventana manualmente.

### Salida

```json
{
  "filters": { "location": "Barcelona", "employmentType": "Full-time", "datePosted": "Past week" },
  "searches": { "total": 14, "completed": 14 },
  "results": { "rawResults": 350, "uniqueResults": 127, "duplicatesRemoved": 223 },
  "perQuery": [
    { "query": "Head of Operations", "family": "operations", "rawResults": 25, "uniqueResults": 25, "pagesVisited": 1, "stopReason": "max_results_reached" }
  ],
  "jobs": [
    {
      "jobId": "...", "title": "...", "company": "...", "location": "...", "url": "...", "easyApply": true,
      "matchedQueries": ["Head of Operations", "Operations Lead"],
      "matchedFamilies": ["operations"]
    }
  ]
}
```

## Milestone previo: detalle individual (desactivado por defecto)

La extraccion de detalle de cada oferta (`src/linkedin/detailCollector.js`) sigue disponible pero **no** se ejecuta en el milestone actual. Para activarla puntualmente:

```powershell
$env:COLLECT_DETAILS=1; $env:DETAIL_LIMIT=3; npm run collect:linkedin -- --debug
```

## Perfil de matching y OpenAI Analyzer

Ver [`src/ai/README.md`](src/ai/README.md): perfil de Mariano (career context / full / matching v1.1.0)
y el Job Analyzer (`npm run analyze:linkedin -- --debug`, requiere `OPENAI_API_KEY`).

## Job State + Feedback (Milestone 7)

Estado de usuario, feedback y foundation de learned preferences (local, sin PostgreSQL/UI/OpenAI).
Ver [`src/data/README.md`](src/data/README.md).

```powershell
npm run feedback:test    # demo del flujo completo
npm run test:feedback    # tests automatizados
```

## UI local (Milestone 8)

Interfaz web local tipo cliente de email para revisar, filtrar y gestionar las ofertas
almacenadas. **Sin dependencias nuevas** (Node `http` nativo + HTML/CSS/JS vanilla).

### Instalar y ejecutar

```powershell
npm install            # instala playwright (única dependencia; no requerida por la UI en sí)
npm run ui             # levanta el servidor
```

Abrir: **http://localhost:4173** (puerto configurable con `$env:UI_PORT`).

### Arquitectura

```
Browser (SPA vanilla)  ──HTTP──▶  src/ui/server.js  ──▶  jobService  ──▶  jobRepository (LocalRepository)
   src/ui/public/*                 (API JSON fina)        (dominio)         src/data/jobs/*.json
```

La UI **nunca** toca los JSON de jobs directamente: todo pasa por `/api` → `jobService` →
repository. La lógica de lista (filtro/orden/búsqueda) vive en `src/ui/jobListLogic.js`
(compartida con los tests). El repository sigue siendo intercambiable (Local → Postgres) sin
tocar la UI.

### Qué se puede hacer

- Ver la lista de ofertas reales (sidebar) con score, AI decision, estado y Easy Apply.
- Ordenar (Overall / Newest / Oldest / Title / Company) y filtrar (estado con contadores,
  AI decision, Easy Apply, score, role families, query, empresa) + búsqueda textual global.
- Abrir el detalle: header, 5 scores, análisis de OpenAI (whyItFits, gaps, critical, red flags,
  reasoning…), matched queries/families, descripción completa, botón *Open on LinkedIn*.
- Acciones (vía `jobService`): **Me interesa · Descartar · Marcar leída · Apliqué · Prioridad**.
- Al abrir una oferta `new` se marca `read` automáticamente (solo entonces; no pisa otros estados).
- **Descartar** abre un modal con los motivos controlados de `feedbackConfig.js` (multi-select) +
  comentario libre → `markAsDiscarded(jobId, {reasons, comment})`.
- Ver el **feedback history** y la discrepancia **AI vs Mariano** (p.ej. "AI recommended this
  opportunity (YES), but you discarded it").
- **Diagnostics** (solo lectura): learned preferences y señales de calibración. No modifica
  preferencias, scoring ni el análisis de OpenAI.

### Tests

```powershell
npm run test:ui         # lógica de lista + integración con el service
npm run test:feedback   # Milestone 7 (garantiza que la UI no lo rompe)
```

Los cambios de estado/feedback se persisten en `JOB_HUNTER_DATA_DIR/jobs/` y sobreviven al recargar.

### Sesión de LinkedIn y búsqueda desde la UI

La pantalla principal permite abrir LinkedIn en Chromium con el perfil persistente local
`JOB_HUNTER_DATA_DIR/browser-profile`. El inicio de sesión, 2FA y cualquier verificación son
siempre manuales: Job Hunter no solicita ni guarda usuario, contraseña o códigos, y no intenta
resolver CAPTCHA/checkpoints. Cerrá la ventana manual antes de iniciar una búsqueda para evitar
dos procesos usando el mismo perfil.

Con setup completo y sesión verificada, **Buscar oportunidades ahora** inicia el motor existente
de forma asíncrona; la UI consulta su estado y muestra el resumen real al finalizar. Chromium de
Playwright debe estar disponible en el equipo. Si falta, se informa un error controlado; su
instalación automática queda para Fase 4.

Limitación técnica de v0.2: si el proceso de la UI termina abruptamente mientras la ventana
manual de Chromium continúa viva, cerrá esa ventana manualmente antes de volver a usar Job
Hunter. El manejo integral de procesos huérfanos se abordará en Fase 4.

## Pipeline end-to-end — `npm run hunt` (Milestone 9)

Conecta todo el sistema en un solo comando:

```
LinkedIn → Multi Search + Global Dedup → Details → OpenAI Analyzer → LocalRepository → UI
```

```powershell
# Prueba de desarrollo (recomendada): descubre poco, analiza 2
$env:MAX_RESULTS_PER_SEARCH=5; $env:MAX_PAGES_PER_SEARCH=1; $env:ANALYZE_LIMIT=2
$env:OPENAI_API_KEY="tu-key"        # si falta: hace discovery+detalle+persistencia, análisis queda pending
npm run hunt -- --debug

npm run hunt -- --dry-run            # sin OpenAI (mock) para validar el pipeline
npm run ui                           # ver los jobs persistidos por el pipeline
```

**Arquitectura:** `src/hunt.js` (entry: cablea browser+multiSearch, collectJobDetails, analyzeJob) →
`src/pipeline/pipeline.js` (orquestador **puro**, dependencias inyectables) → `jobService` →
`LocalRepository`. Reutiliza collector, search scope, multi-search+dedup, detail extraction y el
analyzer sin duplicar lógica.

**Idempotencia y límites:**
- Identidad por `jobId`. Si un job ya existe: no se duplica, se **unifican** `matchedQueries`/`matchedFamilies`,
  se actualiza `lastSeenAt` (nunca `firstSeenAt`) y se **preservan** `userState`, `feedback`, `feedbackEvents` y `aiAnalysis`.
- `MAX_RESULTS_PER_SEARCH` / `MAX_PAGES_PER_SEARCH` limitan el **discovery**; `ANALYZE_LIMIT` limita cuántos
  jobs nuevos se envían a OpenAI por run (separa *discovery* de *analysis*). Los no analizados quedan `analysisStatus: pending`.
- `shouldAnalyzeJob(job)` (en `domain/jobRecord.js`) centraliza la decisión: se analiza solo si `aiAnalysis == null`.
- **Resumable:** los jobs persistidos no se pierden ante challenge/error; en el siguiente run los `pending`/`failed`
  continúan y los `completed` no se re-analizan (no se re-cobra OpenAI).
- **Fallo de OpenAI:** el job se conserva con `analysisStatus: failed` + `analysisError` (reintentable).
- **Seguridad:** ante CAPTCHA/checkpoint/challenge el pipeline se detiene (no se evade); lo persistido se conserva.

**Estados de análisis** (independientes de `userState`): `pending · processing · completed · failed`.

**Output:** JSON por stdout (`runId`, `discovery`, `analysis`, `persistence`, `usageTotals`, `durations`,
`jobs` compactos — sin descripciones gigantes; los jobs completos viven en el repository). Con `--debug`,
un reporte legible por stderr. Nunca imprime la API key.

**Tests:** `npm run test:pipeline` (+ `test:feedback`, `test:ui`).

## Trigger n8n → Windows — asíncrono (Milestone 10C)

Permite que **n8n (Docker)** dispare `npm run hunt` en el **host Windows**. **Asíncrono**: `POST /run`
devuelve `202` en ms y el hunt sigue en background; el estado se consulta por `GET /run/:runId`. Así
n8n nunca mantiene una conexión abierta durante los 8–25 min del hunt. Detalle en
[`src/trigger/README.md`](src/trigger/README.md).

```powershell
$env:HUNT_TRIGGER_TOKEN="<token-fuerte>"      # obligatorio (sin esto no arranca)
npm run trigger                                # escucha en :8787
```

Endpoints (auth `Authorization: Bearer <token>` salvo `/health`):
- `GET /health` → `{ok, huntRunning, currentRunId}` (sin auth)
- `POST /run` → **`202`** `{runId, status:"started"}` · `401` token · `409` ya corriendo
- `GET /run/:runId` → estado `starting|running|success|failed` (+`summary`/`stderrTail` al terminar)
- `GET /runs` → historial compacto (máx 20, desc)

Polling en n8n: **HTTP Request POST /run → Wait → GET /run/:runId → IF status==running → Wait → …**;
`success`/`failed`/`409` = ramas. Cada request es corta (ms). Verificado: el contenedor n8n hace
`POST /run` y recibe `202` en ~80ms, y consulta el estado con requests cortas.

- Comando **fijo** (`node src/hunt.js`), sin args del request → sin injection. `runId` validado (`^run_[A-Za-z0-9]+$`, anclado en `runs/`) → **sin path traversal**.
- **Lock compartido** (`JOB_HUNTER_DATA_DIR/hunt.lock`): dos hunts nunca corren juntos (manual + trigger). `OPENAI_API_KEY`/`browser-profile` nunca cruzan HTTP. Auditoría progresiva en `JOB_HUNTER_DATA_DIR/runs/<runId>.json`.
- **`ANALYZE_LIMIT` semántica** (fijada en 10C): `0` = **no analizar** (solo discovery); `N>0` = máximo N jobs nuevos a OpenAI. (Distinto de `MAX_*_PER_SEARCH`, donde `0`=sin límite.)

**Firewall (Windows, opcional — acotar el puerto a la red de Docker):** en este host Docker Desktop
(WSL2) usa `vEthernet (WSL)` con subred **172.31.0.0/20**. Regla scoped (ejecutar manualmente como
admin; el rango WSL puede cambiar entre reinicios, verificalo):

```powershell
New-NetFirewallRule -DisplayName "JobHunter Trigger (Docker only)" -Direction Inbound `
  -Action Allow -Protocol TCP -LocalPort 8787 -RemoteAddress 172.31.0.0/20
```

No crear reglas Any/Any ni exponer el puerto a Internet. La seguridad primaria es el **token**.

**Tests:** `npm run test:trigger`.

### Operativa n8n + auto-start (Milestone 10D)

**Workflow n8n** — `n8n/job-hunter-daily-hunt.json` (versionado, **sin token**). Ya importado y
persistido en el volumen `n8n_data` (id `jobhunterdaily01`, **inactivo**). Nodos:
`Schedule (daily 08:00)` / `Manual test` → `Start hunt (POST /run)` → `Started? (202)` →
`Wait 30s` → `Poll status (GET /run/:id)` → `success? / failed? / stale/timeout?` (loop mientras
`running`); rama `409 → ALREADY RUNNING`. Re-importar con:
`docker cp n8n/job-hunter-daily-hunt.json n8n:/tmp/wf.json; docker exec n8n n8n import:workflow --input=/tmp/wf.json`.

**Token (variable de usuario, fuera del repo).** Setealo una vez y recuperalo para n8n:
```powershell
setx HUNT_TRIGGER_TOKEN "<token-fuerte>"
[Environment]::GetEnvironmentVariable('HUNT_TRIGGER_TOKEN','User')   # para pegarlo en la credencial n8n
```

**Pasos manuales en la UI de n8n** (no automatizables sin las credenciales de n8n):
1. **Credencial** → *Header Auth* llamada `JobHunter Trigger Token`: Name `Authorization`, Value `Bearer <token>`. Asignala a los 2 nodos HTTP Request.
2. **Probar** → abrir el workflow → *Execute workflow* (usa `Manual test`): verás `POST → 202 → polling → success`.
3. **Activar** → toggle *Active* cuando quieras que corra el Schedule.

**Schedule** — corre a las **08:00** (cron `0 8 * * *`). Cambiar hora: editar la expresión cron del
nodo. **Timezone:** n8n usa su zona de instancia (sin `GENERIC_TIMEZONE` → default `America/New_York`);
para Barcelona, seteá la timezone del workflow en *Workflow → Settings → Timezone = Europe/Madrid*
(no requiere recrear el contenedor). **Desactivar:** toggle *Active* off.

**Arranque automático del Trigger en Windows** (sin abrir VS Code): acceso directo en la carpeta
**Startup** (`shell:startup`) → `scripts/start-trigger.cmd` (lee el token del entorno de usuario y hace
`npm run trigger`). Ya creado y validado (`/health` responde tras el arranque, sin correr hunt). Corre
al **iniciar sesión** en la sesión interactiva (necesario para Chromium visible).
*Alternativa Task Scheduler* (requiere **admin**, no se creó):
```
schtasks /Create /TN JobHunterTrigger /SC ONLOGON /IT /RL LIMITED /TR "C:\Users\maria\job-hunter\scripts\start-trigger.cmd"
```

**Recovery / reinicio del trigger:** el lock (`JOB_HUNTER_DATA_DIR/hunt.lock`) y los archivos de `JOB_HUNTER_DATA_DIR/runs/` sobreviven;
tras reiniciar el trigger no se inicia nada solo, y un run interrumpido queda `stale:true` (limitación
de 10C — Node no reconecta el stdout de un hijo previo).
