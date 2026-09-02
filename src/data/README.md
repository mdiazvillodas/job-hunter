# Job State + Feedback Learning Foundation (Milestone 7)

Sistema local (sin PostgreSQL/n8n/UI/OpenAI) para el **estado de usuario** de una oferta,
el **feedback** de Mariano y una **foundation de learned preferences**.

## Separación conceptual (clave)

Una oferta tiene DOS cosas independientes:

- **`aiAnalysis`** — decisión del OpenAI Job Analyzer (`YES/MAYBE/NO` + scores). No se toca al cambiar el estado del usuario.
- **`userState` + `feedback`** — decisiones/acciones de Mariano.

Los desacuerdos se conservan (ej. AI=`YES`, user=`discarded`) porque son útiles para calibración.

## Arquitectura (capas)

```
domain/feedbackConfig.js   estados, motivos (+dimensión), thresholds de learning (centralizado)
domain/jobRecord.js        modelo de Job + transiciones puras (no persisten)
domain/calibration.js      AI decision vs user decision -> calibrationSignal
data/jobRepository.js      LocalRepository (1 JSON por job)  ← reemplazable por PostgresRepository
services/jobService.js     repo + transiciones (markAsRead(jobId), ...)
ai/learnedPreferences.js   agregación determinista de feedback -> preferencias candidatas
```

El `jobService` depende del **contrato** del repository (`save/get/has/getAll/delete`), no de la
implementación, por lo que se puede pasar de `LocalRepository` a `PostgresRepository` sin cambiar
la lógica de negocio.

## Job record

```
{ jobId, title, company, location, url, employmentType, workplaceType, seniority, easyApply,
  description, matchedQueries[], matchedFamilies[],
  aiAnalysis,                              // resultado del analyzer (opaco aquí)
  userState: { status, firstSeenAt, lastSeenAt, readAt, interestedAt, appliedAt, discardedAt, priorityAt },
  feedback:  { reasons[], comment, createdAt },   // último descarte (resumen)
  feedbackEvents: [ { type, reasons?, comment?, createdAt } ]   // historial COMPLETO, no se sobreescribe
}
```

## Estados (decisiones de Mariano)

`new · read · interested · discarded · applied · priority`

`read` (vio la oferta) ≠ `interested` (vale la pena seguirla) ≠ `applied` (aplicó). Se guardan como
eventos independientes; ninguno se interpreta automáticamente como positivo/negativo. Las
re-transiciones están permitidas.

## Motivos de descarte + dimensión

Motivos controlados (ver `feedbackConfig.js`), cada uno con `dimension` para separar
**no puedo** (`professional_fit`) de **no quiero** (`interest`); `both`/`unknown` cuando es ambiguo.
Se admiten múltiples `reasons` + un `comment` libre (se guarda exactamente lo indicado, sin interpretarlo).

## Learned preferences (foundation)

Agregación determinista de los descartes (sin ML, sin OpenAI):

- 1 evento → `signal` (confidence low)
- 2–3 → `emerging` (medium)
- 4+ → `established` (high)

Thresholds centralizados en `feedbackConfig.js`. **No** se conecta todavía al analyzer: solo genera el reporte.

## Calibration signals

`ai_overestimated_interest · ai_underestimated_interest · ai_overestimated_professional_fit ·
ai_underestimated_professional_fit · ai_correct · unknown` (conservador: `unknown` si no hay info suficiente).

## Uso

```js
const { createLocalRepository } = require('./src/data/jobRepository');
const { createJobService } = require('./src/services/jobService');

const svc = createJobService(createLocalRepository());       // dir por defecto: src/data/jobs
svc.createJob(job);                                          // job con aiAnalysis del analyzer
svc.markAsRead(jobId);
svc.markAsInterested(jobId, { comment: '...' });
svc.markAsDiscarded(jobId, { reasons: ['too_product'], comment: '...' });
const signal = svc.getCalibration(jobId);

const { computeLearnedPreferences } = require('./src/ai/learnedPreferences');
const report = computeLearnedPreferences(svc.getAllJobs());
```

## Comandos

```powershell
npm run feedback:test    # CLI demo del flujo completo (9 pasos + learned preference)
npm run test:feedback    # tests automatizados
```
