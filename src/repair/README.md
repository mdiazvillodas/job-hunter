# Repair de descripciones

`npm run repair:descriptions` hace inventario (dry-run) por defecto: no abre browser
ni modifica registros. Selecciona descripciones que no cumplen el P0 (`trim().length >= 300`).

```powershell
npm run repair:descriptions -- --dry-run
npm run repair:descriptions -- --dry-run --analyzed-only
npm run repair:descriptions -- --limit 10 --analyzed-only
npm run repair:descriptions -- --job-id 4460720693
```

- `--dry-run`: solo seleccion y validacion de URLs, cero escrituras/red.
- `--limit N`: maximo de candidatos; entero positivo. Habilita ejecucion real salvo dry-run.
- `--job-id ID`: restringe a un ID; se puede repetir para un lote explicito.
- `--analyzed-only`: restringe a registros que ya tienen aiAnalysis.
- Sin limite ni IDs, siempre es dry-run. La seleccion es estable por jobId.

Usa directamente la URL persistida, validando dominio LinkedIn e ID. No ejecuta
Discovery ni SEARCH_QUERIES, ni importa/llama al analyzer/OpenAI. Usa HEADLESS y
el mismo browser-profile y lock que hunt. No deben ejecutarse simultaneamente.

Solo reemplaza description/descriptionLength si recupera texto utilizable. Guarda
detailExtraction y un historial descriptionRepair.attempts. En fracaso conserva
descripcion y todos los campos existentes, agregando el diagnostico del intento.
Nunca borra ni recalcula aiAnalysis, scores o feedback. Si reemplaza una descripcion
insuficiente por una utilizable y ya habia analisis, marca analysisStatus=stale,
analysisStaleReason=description_repaired y analysisStaleAt. Conserva las fechas
historicas existentes. La UI no presenta ese score como vigente.

Los diagnosticos del extractor son description_extracted, description_too_short,
description_not_found (ausencia explicita), detail_load_timeout (no llega contenido),
auth_or_challenge y detail_fetch_error. Un timeout sin texto tambien incluye
description_not_found en errors. Auth/challenge detiene el lote, cierra el contexto
y libera el lock; no intenta resolverlo. Un fallo individual queda en el resumen
y en descriptionRepair.attempts, aunque el comando complete con codigo 0.

El pipeline normal conserva detailExtraction en el job y detailDiagnostics y
analysis.detailExtractionCounts en el resumen. La calidad sigue definida por P0:
300 caracteres no garantizan una descripcion completa o semantica correcta.

## Reanalisis separado

```powershell
npm run reanalyze:repaired -- --dry-run
npm run reanalyze:repaired -- --dry-run --limit 10
npm run reanalyze:repaired -- --dry-run --job-id 4460720693
```

Selecciona exclusivamente stale por description_repaired con descripcion utilizable.
Sin argumentos es dry-run. --limit N o --job-id ID habilitan ejecucion real si se
omite --dry-run; --job-id es repetible. Un dry-run no escribe ni llama OpenAI.
La ejecucion real usa el analyzer normal y el perfil de matching actual, sin
Discovery, LinkedIn o detail fetch, y comparte el lock del hunt/repair.

Exito: reemplaza aiAnalysis, pasa a completed, limpia analysisStaleReason y agrega
analysisStaleResolvedAt y analysisReanalysisHistory (motivo, staleAt, fecha del
analisis anterior y fecha del nuevo). Error: conserva el analisis anterior como
stale y guarda analysisError, permitiendo reintentar. P0 sigue vigente.

shouldAnalyzeJob tambien considera stale elegible en un futuro hunt normal, si el
job reaparece y entra en el limite. Este comando permite no depender de Discovery.
La migracion inicial se limita a los IDs del informe repair_sample_2026-09-09.json
y valida metadata de repair antes de modificar sus estados; no reanaliza.
