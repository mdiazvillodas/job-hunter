# Job Hunter Trigger (n8n → Windows) — asíncrono

Servicio HTTP mínimo (Node nativo, **sin dependencias**) que deja a **n8n en Docker** disparar
`npm run hunt` en el **host Windows**. Diseño **asíncrono**: `POST /run` responde `202` en
milisegundos y el hunt sigue en background; el estado se consulta por `GET /run/:runId`. Así n8n
nunca mantiene una conexión HTTP abierta 8–25 min. Playwright, Chromium y `browser-profile` siguen
en Windows — el contenedor solo *pide* y *consulta*.

## Arranque

```powershell
$env:HUNT_TRIGGER_TOKEN="<token-fuerte>"     # obligatorio; sin esto el servicio NO arranca
$env:HUNT_TRIGGER_PORT=8787                    # opcional (default 8787)
$env:HUNT_TRIGGER_HOST="0.0.0.0"               # opcional (default 0.0.0.0, alcanzable desde Docker)
npm run trigger
```

Comando disparado **fijo**: `node src/hunt.js` (== `npm run hunt`), sin shell ni args del request.

## Variables de entorno

| Variable | Default | Uso |
| --- | --- | --- |
| `HUNT_TRIGGER_TOKEN` | (obligatoria) | Bearer token. Falta ⇒ no arranca. Nunca se imprime. |
| `HUNT_TRIGGER_PORT` | `8787` | Puerto (80/443/5678/4173 ocupados en este host). |
| `HUNT_TRIGGER_HOST` | `0.0.0.0` | Bind. `0.0.0.0` para que Docker llegue por `host.docker.internal`. |

El resto del entorno se hereda al hunt (`OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_PRICE_*`,
`COLLECT_DETAILS`, `USE_MATCHING_PROFILE`, `MAX_RESULTS_PER_SEARCH`, `MAX_PAGES_PER_SEARCH`,
`ANALYZE_LIMIT`, …). **`OPENAI_API_KEY` vive solo en el env del proceso Windows** — nunca cruza HTTP,
ni en body/stdout/stderr/respuesta/logs (se redacta defensivamente).

## Endpoints

| Método · ruta | Auth | Respuesta |
| --- | --- | --- |
| `GET /health` | no | `200 {ok, service, version, huntRunning, currentRunId}` |
| `POST /run` | Bearer | `202 {ok, runId, status:"started", startedAt}` · `401` · `409` |
| `GET /run/:runId` | Bearer | `200` estado · `404` (id inválido/inexistente) |
| `GET /runs` | Bearer | `200 {runs:[…]}` historial compacto (máx 20, desc) |
| otro método / ruta | — | `405` / `404` |

### Estados de un run

`starting → running → success | failed`. (`stale:true` si el archivo quedó en running/starting pero
el proceso ya no es el run vivo — p.ej. tras reiniciar el trigger; ver Recovery.)

`GET /run/:runId` mientras corre:

```json
{ "ok": true, "runId": "run_…", "status": "running", "startedAt": "…", "finishedAt": null, "durationMs": null, "exitCode": null }
```

Terminado con éxito:

```json
{ "ok": true, "runId": "run_…", "status": "success", "startedAt": "…", "finishedAt": "…",
  "durationMs": 566842, "exitCode": 0, "summary": { "discovery": {…}, "analysis": {…} } }
```

Fallido:

```json
{ "ok": false, "runId": "run_…", "status": "failed", "exitCode": 1, "error": "…", "summary": null, "stderrTail": "…" }
```

## Polling desde n8n (workflow de prueba)

```
Manual/Schedule Trigger
  → HTTP Request  POST http://host.docker.internal:8787/run   (credencial Bearer)   → 202 {runId}
  → Wait (p.ej. 20s)
  → HTTP Request  GET http://host.docker.internal:8787/run/{{$json.runId}}          (Bearer)
  → IF  status == "running"  → Wait → (volver al GET)
      status == "success"    → Success branch
      status == "failed"     → Error branch
  (POST devolvió 409 → Already-running branch)
```

Cada request es **corta** (ms). n8n nunca mantiene una conexión abierta durante el hunt.
Configurá el **timeout del nodo HTTP Request** normal (segundos), no minutos.

## Concurrencia (lock compartido)

`JOB_HUNTER_DATA_DIR/hunt.lock` (`{pid, startedAt, hostname}`) se adquiere al inicio de `hunt.js` y se libera en
`finally`. Lo respetan **`npm run hunt` manual y el trigger**. Nunca dos Chromium sobre el mismo
`browser-profile`. PID vivo → `409`/rechazo; PID muerto → stale recuperable; corrupto/indeterminado
→ conservador (ocupado).

## Recovery / reinicio del trigger

El estado en memoria se pierde si el trigger se reinicia, pero `JOB_HUNTER_DATA_DIR/runs/<runId>.json` persiste. Tras un
reinicio, el servicio **no** inicia nada solo; el lock impide duplicar; `GET /run/:runId` lee el
archivo y marca `stale:true` si había quedado en `running/starting` sin proceso vivo. **Limitación:**
Node no puede reconectar stdout/stderr de un hijo previo, así que un run interrumpido no pasa solo a
`failed`; queda como `stale`. No se implementa recuperación que Node no garantice.

## Logs / seguridad

- Auditoría en `JOB_HUNTER_DATA_DIR/runs/<runId>.json` (progresivo). Sin secretos. La raíz de runtime está en `.gitignore`.
- Comando fijo, sin args del request → sin injection. Token bearer (timing-safe). `runId` validado
  contra `^run_[A-Za-z0-9]+$` y anclado dentro del directorio de runs → **sin path traversal**. Endpoint no público
  (bind + firewall). `browser-profile` nunca cruza HTTP.

## Firewall / Windows startup

Ver el README principal (regla scoped a la subred de Docker Desktop; y notas de Task Scheduler para
arranque con Windows — diferido).
