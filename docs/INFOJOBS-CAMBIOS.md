# InfoJobs en Job Hunter: qué cambió y cómo portarlo a la versión instalable

Referencia de todos los cambios hechos en `master` para agregar InfoJobs, con el estado
**antes** y **después** de cada uno. Está pensada para usarla al portar InfoJobs a la
rama `installer-v0.2`.

> **Estado al 2026-10-06:** la rama `installer-v0.2` **no tiene InfoJobs**. Su último commit
> sigue siendo `cfacb06` (2026-09-21). El porteo **sí existe**, pero está en otra rama de GitHub,
> **`claude/vibrant-bohr-rfddof`**: un único commit `00c0f83` sobre `cfacb06`, sin mergear en
> `installer-v0.2`. Ver la sección 6.

---

## 1. Commits involucrados (en orden)

| Commit | Autor | Qué hizo |
|---|---|---|
| `fa5ac62` | Claude | Script de reconocimiento `npm run recon:infojobs` (`src/infojobs/recon.js`). |
| `26557db` | Claude | InfoJobs como segunda plataforma: collector, detalle, extracción, challenge, URLs, sources, combinación de resúmenes, UI, ntfy, config. |
| `243a862` | Claude | Ajuste de la extracción del detalle a la estructura real de la web. |
| `fefa0e4` | Mariano / Claude | El hunt abre **un navegador por plataforma** (antes: uno compartido). Perfil propio para InfoJobs. |
| `a84448a` | Mariano | Launcher propio de InfoJobs `src/infojobs/browser.js` + dependencias nuevas en `package.json`. |
| `a335353` | Mariano / Claude | `.gitignore` de los perfiles de prueba `perfil_prueba_*/`. |
| `c86bf20` | rama `recon-infojobs` | Captura del recon + corrección de la detección de CAPTCHA en `recon.js` (**no está en master**). |

Para ver el diff completo de todo lo de InfoJobs: `git diff 705b4d0 a335353`.

---

## 2. Tecnología de navegador (Playwright)

| | Antes (hasta `705b4d0`) | Después (`master` actual) |
|---|---|---|
| Librería | `playwright` `^1.62.1` (devDependency), instalada 1.62.1 | Igual para LinkedIn. `package.json` además declara `playwright-extra` `^4.3.6` y `puppeteer-extra-plugin-stealth` `^2.11.2` en `dependencies`, pero **ningún archivo de `src/` los usa hoy**. |
| API | `chromium.launchPersistentContext(profileDir, …)` | Igual en ambas plataformas. |
| Navegador LinkedIn | `channel: 'chromium'` (el Chromium que descarga Playwright) | **Sin cambios.** `src/linkedin/browser.js` no se tocó. |
| Navegador InfoJobs | No existía. | `channel: 'chrome'`: el **Google Chrome instalado en Windows**, no el Chromium de Playwright. |
| Perfil LinkedIn | `browser-profile/` | **Sin cambios.** |
| Perfil InfoJobs | No existía. | `browser-profile-infojobs/` (constante `INFOJOBS_BROWSER_PROFILE_DIR`). |
| Cuántos navegadores por hunt | Uno solo, abierto antes del loop y compartido. | Uno **por plataforma**, abierto y cerrado dentro del loop, en secuencia. |
| Recon (`recon.js`) | No existía. | Lanza su propio Chromium (`channel: 'chromium'`) con `browser-profile/`, el de LinkedIn. No usa el launcher de InfoJobs. |

### Launcher de InfoJobs (`src/infojobs/browser.js`, commit `a84448a`)

Exporta `launchInfoJobsBrowser(profileDir)`. Usa `require('playwright')` (no `playwright-extra`),
`channel: 'chrome'`, `headless: HEADLESS`, `viewport: null`, `locale: 'es-ES'`,
`timezoneId: 'Europe/Madrid'`, y además opciones de lanzamiento y un init script propios que
escribió el usuario. Ver el archivo para el detalle.

---

## 3. Cambios por archivo: antes → después

### Archivos nuevos

| Archivo | Para qué |
|---|---|
| `src/infojobs/browser.js` | Launcher de InfoJobs (ver arriba). |
| `src/infojobs/collector.js` | Recorre las búsquedas en InfoJobs (`collectInfoJobsSearches`) y junta las ofertas de la lista de resultados. |
| `src/infojobs/detail.js` | Abre cada oferta y extrae el detalle (`fetchInfoJobsDetail`). |
| `src/infojobs/extract.js` | Lee el HTML: tarjetas de resultados (`a.ij-OfferCardContent-description-link`) y ficha de oferta (título, empresa, ubicación, modalidad, contrato, experiencia, salario, descripción + "Requisitos:"). InfoJobs no tiene JSON-LD; todo sale del HTML. |
| `src/infojobs/urls.js` | Arma la URL de búsqueda: `/jobsearch/search-results/list.xhtml?keyword=…&provinceIds=9&sinceDate=_7_DAYS`. |
| `src/infojobs/challenge.js` | Detecta CAPTCHA o bloqueo (pantalla "¿Eres humano o un robot?", GeeTest, `distil/captcha.xhtml`) y lanza `SecurityChallengeError`. **No** intenta resolverlo. |
| `src/infojobs/recon.js` | Script de un solo uso para capturar páginas reales en `recon/infojobs/<fecha>/`. |
| `src/domain/sources.js` | Constantes `SOURCES` (`linkedin`, `infojobs`), `sourceLabel`, `parseSources`. |
| `src/pipeline/combineSummaries.js` | Junta los resúmenes de cada plataforma en un solo JSON (`sources.linkedin`, `sources.infojobs`). |
| `src/tests/infojobs.test.js` | 12 tests unitarios (`npm run test:infojobs`). |
| `src/tests/infojobs-browser.test.js` | 7 tests con navegador headless sobre HTML fijo, incluido el corte por CAPTCHA (`npm run test:infojobs-browser`). |

### Archivos modificados

| Archivo | Antes | Después |
|---|---|---|
| `src/hunt.js` | Solo LinkedIn. `launchLinkedInBrowser(BROWSER_PROFILE_DIR)` una vez, antes de todo, y `context.close()` al final. | Acepta `--source=linkedin\|infojobs`. Recorre `SOURCES` en un `for` con `await` (**en secuencia, nunca en paralelo**). Para cada plataforma: abre su navegador (`launchInfoJobsBrowser(INFOJOBS_BROWSER_PROFILE_DIR)` o `launchLinkedInBrowser(BROWSER_PROFILE_DIR)`), arma los adaptadores con `buildSourceAdapters(source, context, options)`, corre `runPipeline` y cierra el navegador en un `finally`. Un error o CAPTCHA en una plataforma no corta la otra. El JSON final sale de `combineSummaries`. |
| `src/config.js` | Queries y filtros solo de LinkedIn. | Queries con `sources: ['infojobs']` (ocho en castellano, solo para InfoJobs). `getActiveSearchQueries(groups, source)` filtra por plataforma. Constantes nuevas: `INFOJOBS_FILTERS` (Barcelona, `provinceId` 9, jornada completa, última semana), `SOURCES`, `INFOJOBS_ANALYZE_LIMIT`, `INFOJOBS_BROWSER_PROFILE_DIR`. |
| `src/domain/jobRecord.js` | Sin campo de plataforma. | Campo `source` (`linkedin` \| `infojobs`) y campos `salary`, `experienceMin`, `contractType` (null si la plataforma no los publica). Los IDs de InfoJobs llevan prefijo `ij_` (`src/domain/sources.js`), así que se guardan como `src/data/jobs/ij_*.json`. |
| `src/ai/jobAnalyzer.js` | El prompt decía que los datos venían "from LinkedIn". | Dice "LinkedIn or InfoJobs, see the `source` field" y manda `source`. `salary`, `experienceMin` y `contractType` se mandan solo si vienen informados, así el prompt de LinkedIn no cambia. |
| `src/notifications/ntfy.js`, `src/notifications/runOutcome.js` | Solo LinkedIn. | El aviso identifica la plataforma. Para InfoJobs, el clic abre la URL guardada de la oferta, validada (https, `infojobs.net`, `/of-<id>`). El cierre del run informa por plataforma. |
| `src/repair/descriptionRepair.js` | Reparaba cualquier oferta con descripción inutilizable. | Repara solo ofertas de LinkedIn (`sourceOf(job) === SOURCES.LINKEDIN`). |
| `src/ui/jobListLogic.js`, `src/ui/public/app.js`, `index.html`, `styles.css` | Solo LinkedIn. | Indicador de plataforma, filtro "Plataforma" y botón "Abrir en InfoJobs" / "Abrir en LinkedIn". |
| `src/linkedin/browser.js` | — | **Sin cambios** (verificado: `git diff 705b4d0 a335353 -- src/linkedin/` vacío). |
| `package.json` | — | Scripts `recon:infojobs`, `test:infojobs` y `test:infojobs-browser` (sumados a `npm test`). `dependencies`: `playwright-extra`, `puppeteer-extra-plugin-stealth`. |
| `.env.example` | — | `SOURCES`, `INFOJOBS_PROVINCE_ID` e `INFOJOBS_ANALYZE_LIMIT` (comentados). |
| `.gitignore` | — | `browser-profile-infojobs/`, `browser-profile-chrome/`, `browser-profile-firefox/`, `perfil_prueba_*/` y `recon/`. |
| `README.md` | — | Sección "InfoJobs". |

### Variables de entorno nuevas

| Variable | Valor por defecto | Efecto |
|---|---|---|
| `SOURCES` | `linkedin,infojobs` | Qué plataformas corre `npm run hunt`, en orden. |
| `INFOJOBS_PROVINCE_ID` | `9` (Barcelona) | Provincia en la URL de búsqueda. |
| `INFOJOBS_ANALYZE_LIMIT` | igual a `ANALYZE_LIMIT` (50) | Cupo de análisis OpenAI por run para InfoJobs. |

---

## 4. Diferencias con `installer-v0.2` que afectan el porteo

Estas son las diferencias que más probablemente rompan un porteo directo:

1. **`channel: 'chrome'` y el Chromium administrado del instalador.** El instalador fija
   `PLAYWRIGHT_BROWSERS_PATH` a `runtime-managed/playwright-browsers` (`src/runtime.js`) e
   instala **solo `chromium`** (`src/install/browserInstallManager.js`, `playwright install chromium`).
   `channel: 'chrome'` **no usa ese Chromium**: necesita Google Chrome instalado en la máquina
   del usuario. Si Chrome no está, el lanzamiento falla.
2. **Ruta de los perfiles.** En `master`, `INFOJOBS_BROWSER_PROFILE_DIR` cuelga de `PROJECT_ROOT`.
   En el instalador, los perfiles van en la carpeta de datos (`BROWSER_PROFILE_DIR` viene de
   `src/runtime.js` como `path.join(dataDir, 'browser-profile')`). El perfil de InfoJobs tiene
   que definirse ahí mismo (`path.join(dataDir, 'browser-profile-infojobs')`), no en `config.js`.
3. **`src/hunt.js` es muy distinto.** En el instalador, `hunt.js` abre el navegador en la línea 168
   y hay otro lanzamiento en `src/run/marketDiscoveryRunManager.js:102` y en
   `src/session/linkedinSessionService.js`. El cambio de "un navegador por plataforma" no se puede
   copiar tal cual: hay que aplicarlo a mano sobre la versión del instalador.
4. **Dependencias.** En el instalador, `playwright` está en `dependencies`, no en
   `devDependencies`. Si se copia el `package.json` de `master`, entran `playwright-extra` y
   `puppeteer-extra-plugin-stealth`, que hoy nadie usa y que el empaquetado
   (`scripts/package-windows.js`) va a incluir igual.
5. **Corrección del recon.** La detección de la pantalla "¿Eres humano o un robot?" en
   `recon.js` está solo en la rama `recon-infojobs` (`c86bf20`), no en `master`.

---

## 5. Cómo quedó verificado en `master`

- Tests: `test:infojobs` 12/12, `test:infojobs-browser` 7/7, `test:pipeline` 35/35,
  `test:notifications` 21/21, `test:ui` 45/45, `test:headless`, `test:trigger` OK.
- Hunt solo LinkedIn (`--source=linkedin`, 2026-10-04): `completed`, 14 queries, 34 únicas,
  3 analizadas, 0 fallidas. LinkedIn funciona igual que antes de la separación.
- Hunt solo InfoJobs con el launcher de `a84448a` (2026-10-04, corrido por el usuario):
  `completed`, 22 queries, 90 resultados, 66 únicos y nuevos, 3 analizadas (límite de prueba),
  0 fallidas. Las 66 ofertas tienen `source`, título, empresa, ubicación y URL. El detalle completo
  (descripción, contrato, salario) solo está en las analizadas: las demás quedan pendientes hasta
  que les toque análisis.
- Con el launcher anterior (`channel: 'chromium'`), InfoJobs mostraba CAPTCHA en la primera
  búsqueda y el hunt se cortaba solo con `SecurityChallengeError`.

---

## 6. El porteo a la versión instalable (commit `00c0f83`)

| | |
|---|---|
| Rama | `origin/claude/vibrant-bohr-rfddof` (solo en GitHub; no hay copia local) |
| Commit | `00c0f83` "Add InfoJobs as an optional second job source" |
| Fecha | 2026-10-05 14:32 UTC, sesión de Claude en la nube (`session_01A66vSrAuPBvvLM8VGsgo7n`) |
| Base | `cfacb06`, el último commit de `installer-v0.2` |
| Mergeado en `installer-v0.2` | **No** |
| Copia local `C:\dev\job-hunter-v02` | Está en `installer-v0.2` pero **atrasada**, en `29c6e68` (Phase 13), y sin cambios pendientes. No tiene ni `cfacb06` ni el porteo. |

Para traerlo: `git fetch origin` y después `git checkout claude/vibrant-bohr-rfddof`, o mergearlo
en `installer-v0.2` después de revisarlo.

### Cómo estaba en `installer-v0.2` y cómo lo dejó el porteo

| Tema | Antes (`cfacb06`) | Después (`00c0f83`) |
|---|---|---|
| Navegador | `src/linkedin/browser.js`: `launchLinkedInBrowser()` → `chromium.launchPersistentContext(profileDir, { headless: false, channel: 'chromium', viewport: null })`. | Se extrajo `launchManagedBrowser(profileDir, extra)`, el **único** punto que abre Playwright, con las mismas opciones más `...extra`. `launchLinkedInBrowser()` lo llama sin extras, así que LinkedIn queda igual. |
| Navegador InfoJobs | No existía. | `src/infojobs/browser.js` → `launchManagedBrowser(profileDir, { locale: 'es-ES', timezoneId: 'Europe/Madrid' })`. Es **el mismo Chromium administrado del instalador** (`channel: 'chromium'`, `PLAYWRIGHT_BROWSERS_PATH`), visible. **No** usa `channel: 'chrome'` ni el launcher de `master` (`a84448a`). |
| Perfil InfoJobs | No existía. | `INFOJOBS_BROWSER_PROFILE_DIR = path.join(dataDir, 'browser-profile-infojobs')` en `src/runtime.js`, en la carpeta de datos, junto al de LinkedIn. |
| Activación | — | **Apagado por defecto.** Se prende en Configuración → InfoJobs, que guarda `sources.infojobs.enabled` y `provinceId` en `user.json` (`src/config/userConfig.js`, `validateSources` / `getInfoJobsSettings`). Un `user.json` viejo sin ese bloque deja InfoJobs apagado. |
| Provincia | Fija en 9 (Barcelona) en `master`. | `src/infojobs/provinces.js`, con IDs reales de InfoJobs: automática según la ubicación principal, toda España (`all`) o una provincia elegida. |
| Hunt | Solo LinkedIn. | `src/hunt.js` y `src/run/huntRunManager.js`: LinkedIn primero, después InfoJobs, con las mismas queries y su propio cupo de análisis. Un CAPTCHA o error en InfoJobs corta solo InfoJobs: el hunt termina, los resultados de LinkedIn se conservan y el resumen informa en `sources.infojobs`. |
| Extracción y detección | — | `collector.js`, `detail.js`, `extract.js`, `challenge.js` y `urls.js` portados y adaptados a las etapas de challenge, la cancelación y el progreso del instalador. |
| Datos | — | `source`, IDs `ij_`, `salary`, `experienceMin` y `contractType` en `src/domain/jobRecord.js`. |
| UI y servidor | — | Sección InfoJobs en Configuración (`index.html`, `app.js`, `src/ui/server.js`) y marca de InfoJobs en la lista. |
| Tests | — | `src/tests/infojobs.test.js`, sumado a `npm test`. **No** se portó `infojobs-browser.test.js`. |
| Dependencias | `playwright ^1.62.1` en `dependencies`. | Sin dependencias nuevas. `playwright-extra` y el plugin stealth **no** están en el porteo. |

### Diferencia clave entre el porteo y `master`

El porteo abre InfoJobs con **el Chromium administrado de Playwright**, es decir, la misma configuración
con la que en `master` InfoJobs mostraba CAPTCHA en la primera búsqueda (sección 5). Por diseño, el hunt
del instalador lo detecta, corta solo InfoJobs y lo informa en `sources.infojobs`. LinkedIn sigue
funcionando.

En `master`, en cambio, InfoJobs usa el launcher de `a84448a` (`channel: 'chrome'` y las opciones del
usuario), que es con el que el hunt completó las 22 búsquedas. Ese launcher **no** forma parte del porteo.
