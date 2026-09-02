# Mariano Job Hunting Profile (Milestone 6A)

Perfil profesional estructurado de **Mariano Díaz Villodas**, optimizado para *job matching*.
Sera consumido mas adelante por OpenAI para evaluar ofertas de LinkedIn.

> Este milestone **no** llama a OpenAI, ni implementa n8n / PostgreSQL / UI.
> Solo produce el perfil como dato estructurado + una funcion para obtenerlo.

## Archivos

- `marianoProfile.json` — fuente unica de la verdad (JSON, listo para enviar a OpenAI).
- `marianoProfile.js` — modulo que carga el JSON y expone las funciones.
- `README.md` — este documento.

## Fuente y politica de grounding

- Fuente: documento profesional **"Resumen Profesional / CV – Mariano Díaz Villodas"**.
- **No se inventa informacion.** Cada capability/experiencia incluye un campo `evidence`
  que cita o parafrasea el documento. Los enunciados de posicionamiento y las reglas de
  evaluacion aportados explicitamente por el proyecto estan marcados como configuracion.

## Estructura del perfil

Claves principales: `positioning`, `targetRoles`, `coreStrengths`, `experience`,
`businessCapabilities`, `technologyCapabilities`, `leadership`, `operationalCapabilities`,
`commercialCapabilities`, `strategicCapabilities`, `transferableSkills`, `seniority`,
`workEnvironmentFit`, `roleTypesToAvoid`, `evaluationPrinciples`.

Extras (respaldados por el documento / proyecto): `meta`, `matchingFramework`,
`education`, `toolsAndTechnologies`.

`matchingFramework.classificationLevels` permite al analisis futuro distinguir los cuatro casos:
`literal_compliance`, `transferable_experience`, `real_gap`, `critical_requirement_unmet`.

## Uso desde Node

```js
const { getMarianoProfile, getMarianoProfileSummary } = require('./src/ai/marianoProfile');

const profile = getMarianoProfile();       // objeto completo (copia profunda)
console.log(profile.positioning.headline); // "Strategic Tech & Business Operations Leader"

const summary = getMarianoProfileSummary(); // resumen compacto para logs/prompt breve
console.log(summary.targetFamilies);
```

Tambien se puede importar el JSON directamente (p.ej. para enviarlo a OpenAI):

```js
const profile = require('./src/ai/marianoProfile.json');
```

`getMarianoProfile()` devuelve una **copia profunda**, por lo que se puede modificar el
objeto devuelto sin alterar el perfil base.

## Matching profile condensado (Milestone 6A.1)

`marianoMatchingProfile.json` es el perfil condensado que se envia a OpenAI. Los hechos
profesionales se destilan de `marianoProfile.json`; las senales de direccion/interes de carrera
(`careerPreferences`, `decisionPhilosophy`, `positioning.professionalArchetype/notPositionedAs`,
roles secundarios/exploratorios) estan grounded en `marianoCareerContext.json`. Secciones:
`positioning` (con archetype, notPositionedAs, careerThread), `targetRoles` (`primary` +
`secondaryExploratory`), `experience` (Zoega + JPH), `capabilities` (operations, business,
technology, delivery, strategyTransformation, product, leadership, commercial —con caveat—,
financialBusinessJudgment), `seniority`, `careerPreferences`, `transferability`,
`workEnvironmentFit`, `roleTypesToAvoid`, `decisionPhilosophy` (canDo/wantsToDo/canSell →
professionalFit/interestFit/cvFit), `interestFit`, `evaluationPrinciples`, y
`learnedPreferences: []` (vacio, se poblara con feedback real).

```js
const { getMarianoMatchingProfile } = require('./src/ai/marianoProfile');
const matching = getMarianoMatchingProfile(); // copia profunda, no mutable
```

Comparar tamanos y validar copias no mutables:

```powershell
node src/ai/compareProfiles.js
```

## Jerarquia de fuentes (oficial)

1. **`marianoCareerContext.json`** — contexto profesional amplio / **fuente maestra** (creada
   manualmente, AUTORIZADA). Es la verdad conceptual **detras** del matching profile.
   **NO se envia completa a OpenAI.** Loader: `getMarianoCareerContext()` (solo lectura).
2. **`marianoProfile.json`** — perfil profesional estructurado completo (`getMarianoProfile()`).
3. **`marianoMatchingProfile.json`** — representacion condensada que **si** se envia a OpenAI
   (`getMarianoMatchingProfile()`).
4. **learnedPreferences** — futuras, desde feedback real (hoy `[]`).
5. **CV** — documento de candidatura, no la definicion completa del perfil.

Arquitectura objetivo del analyzer: `matchingProfile + learnedPreferences + CV relevante + job → OpenAI`.
Hoy: `matchingProfile + job`. El analyzer:

- usa el matching profile por defecto (`USE_MATCHING_PROFILE=false` → completo);
- tiene una **salvaguarda** (`isCareerContext`) que RECHAZA recibir el career context, para que
  nunca se cargue completo en el prompt;
- deja preparados `options.learnedPreferences` y `options.cv` (inactivos por ahora; el CV, cuando
  se pase, se trata como documento de candidatura, no como perfil completo).

Validar toda la arquitectura (sin llamar a OpenAI):

```powershell
node src/ai/validateArchitecture.js
```

---

# OpenAI Job Analyzer (Milestone 6B)

`jobAnalyzer.js` evalua una oferta laboral para Mariano usando la API oficial de OpenAI
(Structured Outputs / `json_schema` strict) y devuelve un analisis JSON validado.

## Diseno y seguridad

- **SYSTEM prompt**: reglas de evaluacion + Mariano Profile + matching framework (lo confiable).
- **USER prompt**: los datos de la oferta como **DATA no confiable**, dentro de `<job_data>`.
  El system instruye explicitamente a NO obedecer instrucciones incrustadas en la descripcion
  (anti prompt-injection).
- La **API key nunca se hardcodea ni se imprime**. Se lee de `process.env.OPENAI_API_KEY`.
- Si el output no es JSON valido o no cumple el schema, se lanza `AnalyzerError` (no se parsea
  texto arbitrario).

## Variables de entorno

| Variable         | Default          | Uso                                             |
| ---------------- | ---------------- | ----------------------------------------------- |
| `OPENAI_API_KEY` | (requerida)      | Credencial. Sin ella, error claro (no fallback).|
| `OPENAI_MODEL`   | `gpt-4.1-mini`   | Modelo. Errores de API se reportan claramente.  |
| `ANALYZE_LIMIT`  | `5`              | Cuantas ofertas analiza la prueba de calibracion.|

## Uso desde Node

```js
const { getMarianoProfile } = require('./src/ai/marianoProfile');
const { analyzeJob } = require('./src/ai/jobAnalyzer');

const profile = getMarianoProfile();
const result = await analyzeJob(profile, job); // job con: title, company, location,
// employmentType, workplaceType, seniority, easyApply, description, matchedQueries,
// matchedFamilies, url, jobId
console.log(result.analysis.decision, result.analysis.overallMatchScore, result.usage);
```

Un transporte inyectable permite testear sin API real: `analyzeJob(profile, job, { transport })`.

## Prueba de calibracion (5 ofertas reales)

```powershell
$env:OPENAI_API_KEY="..."; $env:ANALYZE_LIMIT=5; npm run analyze:linkedin -- --debug
```

Sin API key, para validar el pipeline (collector -> descripcion -> analyzer) con un mock:

```powershell
npm run analyze:linkedin -- --debug --dry-run
```

La prueba: ejecuta la busqueda actual con filtros, toma 5 ofertas, abre sus detalles,
obtiene la descripcion completa, pasa cada una al analyzer e imprime el resultado
estructurado + un JSON final. No procesa mas de `ANALYZE_LIMIT`. No modifica el default del
collector (usa una unica busqueda y limita el detalle a `ANALYZE_LIMIT`).

## Preparado para el futuro

`learnedPreferences` puede incorporarse al perfil sin cambiar la arquitectura: el system prompt
ya lo contempla (si existe, lo usa; si no, no inventa preferencias).
