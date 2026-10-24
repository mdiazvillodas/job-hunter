# Piloto final acotado — Job Hunter 0.2 Simple

> Los informes de pilotos con información profesional se conservan localmente y no se publican en la rama de entrega.

> Las correcciones posteriores y sus límites están documentados en correcciones-minimas.md y scripts/oracle/README.md. Una autorización de un piloto ejecutado no se reutiliza para otra ronda.

Preparado el 18 de octubre de 2026; actualizado tras la corrección autorizada exclusivamente del diagnóstico. **API y scraping todavía no autorizados.** El instalable anterior se conserva; el piloto usará la revisión corregida. No se modifica el Hunter original. Sin push ni merge.

## Decisión que buscamos

Decidir por separado si Mariano puede empezar a usar Simple sin una pérdida práctica relevante y si Mariana puede recibir recomendaciones comprensibles de arquitectura edilicia. Un resultado aprobado para Mariano no aprueba automáticamente a Mariana. No se evalúa rentabilidad laboral ni se certifica un mercado completo con esta muestra.

Duración prevista tras autorización: una sesión de 60–90 minutos, más unos 10 minutos de revisión de las comparaciones. Una sola ronda; no se amplía la muestra para buscar resultados favorables. Cualquier prueba pagada que no llegue a ejecutarse conserva estado PENDIENTE, nunca PASS.

## Material congelado y protección

- Candidato: base `193426a` de `v0.2-simple`, más revisión `diagnostico-contenido-v1`. Se usa `Job-Hunter-0.2-simple-Diagnostico-Windows.zip`. Sus hashes de ZIP y módulo de diagnóstico están en `preflight.json`; el ZIP previo permanece disponible para recuperación. No hay cambios de Analyzer, scoring o scraping.
- Referencia: código del Analyzer del original activo y matching profile de Mariano congelados en `private-baseline/validation-pilot`. El código original se lee y copia; no se ejecuta su hunt, UI ni instalador.
- Seis ofertas históricas completas, sus análisis previos y sus decisiones de uso se congelaron localmente, con hashes. Se preserva la misma descripción en ambos lados. No se mezclan ofertas actualizadas con las históricas.
- Índice privado: `private-baseline/validation-pilot/case-index.json`. Contiene IDs, decisiones históricas y feedback. No se incluye en el instalable ni se publica.
- Los ocho casos de arquitectura y sus perfiles se fijan en `fixtures.json`. Los perfiles con capacidades concretas son ficticios y se identifican como tales. No se importan en la instancia personal de Mariana.
- Instancias de validación nuevas, extraídas del ZIP en una carpeta de pruebas. No se usan las carpetas activas de Mariano o Mariana. Programación y notificaciones desactivadas durante todo el piloto. Sesiones de navegador independientes. Sin postulaciones ni mensajes.

## Etapa 0 — comprobaciones locales, cero llamadas

Preparar y contrastar el material con `scripts/prepare-validation-pilot.js`; este script no contiene transporte HTTP, lanzamiento de navegador ni ejecución de hunts. Ya se ejecutó. Compara también el diagnóstico del código fuente con el del instalable. No es un ejecutor de la etapa paga.

Tras la autorización de ejecución del piloto, extraer una copia nueva del ZIP y completar estos pasos desde el instalable, documentando pantallas y resultados:

| Caso | Acción concreta | Aprobar si |
|---|---|---|
| L1 | Instalar dos instancias de prueba con puertos distintos y abrir ambas | Arrancan desde el runtime incluido; no exigen editar archivos ni instalar dependencias |
| L2 | En la instancia de Mariana de prueba: perfil vacío, luego importar el mínimo A1 | Comunica perfil insuficiente, enumera responsabilidades, capacidades/herramientas, preferencias y objetivos pendientes; permite guardar y corregir |
| L3 | Importar A8, superficial con todos los encabezados | Advierte que faltan ejemplos de tareas, proyectos, herramientas y condiciones concretas; no declara suficiente confianza solo por encabezados |
| L4 | Importar A7, perfil junior ficticio | No exige dirección ni trata falta de experiencia gerencial como carencia por sí misma |
| L5 | Guardar una oferta sintética distinta y feedback en cada instancia usando los servicios existentes; cerrar y reabrir | Mantiene perfil, datos y feedback; la otra instancia no ve esos registros. Claves y cookies no se mezclan. Una clave sintética del entorno global no se hereda |
| L6 | Reiniciar con programación desactivada y sin clave real | No inicia búsquedas ni análisis; los errores locales son visibles y no destruyen datos |

**Resultado local actualizado:** el perfil vacío, el mínimo y A8 superficial muestran insuficiencia y preguntas específicas. A8 ya no aparece como suficientemente documentado. Pasaron 13 regresiones locales, incluidos junior, senior genérico, arquitectura con tareas concretas, ausencia de métricas, presentación de preguntas y procesamiento con perfil superficial. El diagnóstico reconoce tareas/entregables y herramientas o métodos contextualizados; no cuenta palabras ni exige liderazgo. **El defecto local L3 está corregido**, también verificado en la nueva copia instalada. La respuesta semántica paga A8 y las demás etapas siguen PENDIENTES: esta corrección no es aprobación del piloto real.

La instancia personal de Mariana está vacía. Confirmar únicamente «arquitecta de construcciones» no acredita AutoCAD, Revit, idiomas, antigüedad, ciudad, experiencia ni preferencias. Antes de aprobar uso personalizado necesita un documento real confirmado. El mínimo A1 sirve para comprobar honestidad sobre carencias, no para dar por aprobado un perfil completo.

## Etapa 1 — calidad práctica de Mariano: 6 pares, 12 llamadas

| Caso | Oferta histórica congelada | Razón de inclusión |
|---|---|---|
| M1 | Product Operations Manager (Senior / Staff) | Buen encaje con postulación real; conservar una oportunidad útil |
| M2 | Senior Deployment Manager | Transferencia entre funciones; no convertirla en un gap inexistente |
| M3 | Director of Operations | Frontera MAYBE que llevó a postularse; conservar la utilidad del matiz |
| M4 | Senior Project Manager, Business Integration | Interés documentado; distinguir límites de escala de incapacidad |
| M5 | Product Manager | Se descartó pese a una evaluación previa relativamente alta; comprobar límites y preferencias, no solo scores |
| M6 | Head of Talent & People Operations – DTC Brand | Descarte por tipo de rol; no confundir People Operations con el objetivo profesional de Mariano |

Por cada oferta: una llamada con el Analyzer original congelado y otra con el Analyzer del instalable, **mismo matching profile, texto, modelo, temperatura 0.2 y schema**. Sin CV extra ni cambios de preferencias entre lados. Alternar el orden original/Simple para reducir sesgo temporal. Guardar respuestas crudas, modelo efectivo, usage, errores y timestamp en privado. No enviar al modelo el análisis histórico ni el feedback humano como respuesta esperada.

Revisar pares presentados como A/B, sin indicar cuál proviene de Simple. Las etiquetas históricas son indicios de utilidad, no una verdad automática: postularse no demuestra encaje perfecto y descartar no prueba incapacidad. Las razones originales de feedback, cuando existan, sirven a la revisión local.

**Criterio por oferta:** decisión útil para decidir si leer/postularse, capacidades y límites sustentados, preferencias relevantes consideradas, explicación comprensible y ausencia de hechos inventados. Registrar «igual», «mejor», «pérdida material» o «indeterminado» con cita de la evidencia del perfil y de la oferta. No usar otro juez API.

**Aprobar Mariano:** 6/6 pares sin pérdida material ni invención nueva en Simple; M1–M4 siguen siendo oportunidades al menos revisables (YES/MAYBE con razones fieles); M6 no se promociona como buen encaje sin evidencia; M5 explica la tensión con el interés del candidato sin imponer un veto por título. Si ambos Analyzers reproducen el mismo error importante, registrar fallo de calidad compartido: la igualdad no lo vuelve aceptable. Un resultado indeterminado no cuenta como aprobado.

Una diferencia de más de 10 puntos de score es una señal para revisar el razonamiento, no una regla nueva de scoring ni un fallo automático. Una bajada menor con una razón falsa sí puede ser pérdida material. No repetir llamadas para elegir la mejor respuesta; una inconsistencia deja el caso pendiente.

## Etapa 2 — arquitectura y carencias: 8 llamadas

| Caso | Perfil / oferta | Aprobar si |
|---|---|---|
| A1 | Profesión mínima conocida / arquitecta junior de viviendas | Reconoce el sector correcto y explica qué no sabe; no inventa experiencia ni recomienda con confianza firme |
| A2 | Mínimo / Software Architect, Java y AWS | No YES ni recomendación por compartir «arquitecta»; explica falta de evidencia sin atribuir incapacidad |
| A3 | Mínimo / BIM Coordinator, Revit avanzado | No presupone Revit, Navisworks o coordinación BIM; identifica los requisitos esenciales desconocidos |
| A4 | Mínimo / título «Architect», descripción de backend | La descripción prevalece sobre el título ambiguo; no lo recomienda como arquitectura edilicia |
| A5 | Vacío / arquitectura de viviendas | Reconoce insuficiencia y no inventa profesión; conserva la posibilidad de cargar una mejora |
| A6 | Ficticio con transición demostrada a Java/AWS / software | Reconoce la evidencia transferible y directa; no rechaza automáticamente por el pasado en construcción |
| A7 | Junior ficticia con prácticas y AutoCAD / vivienda junior | YES o MAYBE razonado; no exige liderazgo; no convierte Revit introductorio en dominio profesional |
| A8 | Superficial con todos los encabezados / vivienda | UI y análisis comunican falta de información concreta; no generan seguridad injustificada |

**Aprobar esta etapa:** 8/8 sin confusión profesional, capacidades inventadas ni confianza injustificada; además L2 y L3 aprobados. Los resultados de A6/A7 validan controles del sistema con fixtures, no las capacidades reales de Mariana. Una salida honesta MAYBE con carencias puede aprobar A1; recomendar Software Architect por coincidencia de título rechaza la etapa aunque el resto pase.

Para aprobar recomendaciones personales de Mariana, además se requiere su perfil real confirmado. Si se aporta antes de ejecutar, registrar un nuevo hash y una nueva versión de este protocolo; no sustituir silenciosamente los fixtures ni agregar llamadas.

## Etapa 3 — scraping acotado y dos ofertas frescas, solo con autorización

Tres recorridos, sin paralelismo, **una búsqueda por recorrido, primera página, hasta tres fichas y hasta tres detalles por recorrido: nueve ofertas como máximo**. Sesiones independientes; no reutilizar cookies del Hunter original. Las cargas auxiliares que hace cada web no son nueve peticiones HTTP: el límite se refiere a búsquedas y fichas, con un tiempo total máximo de 15 minutos para esta etapa.

| Recorrido | Fuente que se consultaría | Consulta y filtros |
|---|---|---|
| S1 | LinkedIn Jobs (`www.linkedin.com/jobs`) | Mariano: Head of Operations, Barcelona, jornada completa, última semana |
| S2 | LinkedIn Jobs (`www.linkedin.com/jobs`) | Mariana de prueba: Arquitecta de construcciones, Barcelona, jornada completa, última semana |
| S3 | InfoJobs (`www.infojobs.net`) | Mariano: Director de Operaciones, Barcelona, jornada completa, última semana |

Barcelona se toma de la configuración existente para probar el scraper; **no confirma la ubicación deseada de Mariana**. No consultar otras fuentes ni seguir enlaces a postulaciones o sistemas externos. Solo dominios de autenticación y recursos necesarios de esas plataformas. No usar las búsquedas completas habituales de Mariano: en la copia de prueba se limita la configuración a la consulta de este cuadro, usando las opciones existentes. Si no puede garantizarse ese límite con el código actual, no lanzar el hunt completo y dejar scraping PENDIENTE; no construir un nuevo scraper.

Recolectar con `ANALYZE_LIMIT=0` e `INFOJOBS_ANALYZE_LIMIT=0`, sin clave API en el proceso de scraping y sin notificaciones. Las llamadas de matching se ejecutan después, separadas del recolector: **F1, una oferta nueva de Mariano; F2, una oferta nueva de arquitectura edilicia para el perfil mínimo de Mariana**, dos llamadas en total. Elegir antes de ver el score, siguiendo el orden de aparición y exigiendo descripción utilizable (al menos 300 caracteres). Si no se encuentra una oferta edilicia adecuada o no hay resultados, registrar «sin muestra», sin ampliar consultas ni fabricar un aprobado. No se consumen sus llamadas no utilizadas.

Comparar visualmente cada ficha con sus campos persistidos: título, empresa, URL, ubicación, descripción y requisitos. Aprobar si no hay requisitos inventados o texto truncado que altere el sentido, se respetan límites y filtros, se deduplica la misma ficha al reprocesar el dato local y los resultados se ven tras reiniciar. Reprocesar el dato guardado no significa volver a raspar la web. Captcha, challenge, login pendiente, 403/429 o estructura inesperada: detener esa fuente, sin evasión ni reintentos automáticos. Una fuente pendiente queda excluida de la aprobación de uso para esa fuente.

Persistir F1/F2 con el repositorio y servicios existentes de sus respectivas instancias; verlos en la UI, marcar feedback, reiniciar y verificar aislamiento. No se reemplazan registros activos. F2 aprueba honestidad y pertinencia de dominio con información escasa; no habilita por sí sola recomendaciones personales confiables.

## Llamadas y presupuesto

| Bloque | Máximo de llamadas OpenAI |
|---|---:|
| 6 ofertas × original y Simple | 12 |
| 8 casos de arquitectura | 8 |
| F1 y F2 después del scraping | 2 |
| Reintentos, juez adicional, embeddings y extracción | 0 |
| **Total máximo** | **22** |

Modelo del candidato: `gpt-4.1-mini`, en ambas versiones, sin migración. Antes de gastar confirmar disponibilidad y tarifa; la página oficial consultada lo marca como deprecated. Si no está disponible o cambian modelo/precio, detenerse: no sustituirlo automáticamente.

Tarifa consultada: **USD 0.40 por millón de tokens de entrada y USD 1.60 de salida**, sin descontar caché. Fuente: [OpenAI Docs — GPT-4.1 mini](https://developers.openai.com/api/docs/models/gpt-4.1-mini), consultada el 18 de octubre de 2026.

Presupuesto conservador por llamada: hasta 65.536 tokens de entrada y el máximo publicado del modelo, 32.768 de salida. Se conserva el transporte del producto, que no tiene un límite menor de salida; no se promete un tope de 4.096 que el instalable no impone. Antes de cada llamada se revisará el tamaño del request completo —mensajes y schema—: bytes UTF-8 más un margen de 2.048 para encuadre deben caber en 65.536. Es una estimación conservadora, no un contador oficial. Una oferta que exceda el margen no se trunca silenciosamente ni se envía; queda pendiente. Los seis requests históricos caben: el mayor tiene 59.863 bytes antes del margen.

**Máximo estimado: 22 × [(65.536 × 0.40 + 32.768 × 1.60) / 1.000.000] = USD 1.7301504; redondeado USD 1.74. Techo propuesto de autorización: USD 2.00 de consumo API, antes de impuestos o cambio de moneda.** La ejecución llevará contador de llamadas y reserva previa del coste máximo de cada una; no confiar únicamente en ANALYZE_LIMIT, porque rige por plataforma y corrida. Sin reintentos; un timeout también consume una posición de las 22. Registrar usage real cuando exista y tratar gasto desconocido como la reserva máxima. No se afirma que el tope sea una restricción bancaria o del proveedor.

Hoy: **0 llamadas pagas y 0 recorridos de scraping ejecutados**. La consulta de documentación oficial de precios no es scraping de ofertas ni una llamada a la API de modelos.

## Datos que saldrían del equipo

**A OpenAI:** en las 12 llamadas pareadas, el matching profile completo congelado de Mariano, incluido su nombre, trayectoria, empleadores y proyectos descritos, capacidades, formación, idiomas, preferencias, restricciones y preferencias aprendidas que estén dentro del JSON. También el contenido laboral seleccionado por `pickJobData` (título, empresa, descripción y campos profesionales presentes). No se cambia ni anonimiza ese perfil entre lados porque se pretende probar su comportamiento habitual. El payload exacto se revisará localmente antes de la autorización; el career context completo y el CV PDF no se envían. F1 vuelve a enviar ese mismo perfil una vez.

En A1–A4 y F2 se envía únicamente el documento mínimo: «Arquitecta de construcciones, arquitectura edilicia. No arquitectura de software». A5 envía un documento vacío. A6/A7 y A8 usan datos ficticios o genéricos etiquetados como pruebas. **No se envían capacidades reales desconocidas de Mariana.** Ninguna llamada mezcla ambos candidatos.

El análisis histórico y los estados applied/interested/discarded quedan en el expediente privado de revisión: no se agregan al prompt de validación. No enviar `.env`, cookies, credenciales de portales, tokens de Telegram/ntfy, otras ofertas del historial ni notas privadas no incluidas en el perfil. La clave OpenAI se usa solo para autenticar la petición al proveedor, no como texto del prompt. Si el propio perfil u oferta contiene contacto personal u otro dato no previsto, detener el envío y revisar el consentimiento; no prometer una anonimización que alteraría la comparación.

**A LinkedIn/InfoJobs:** consultas, filtros y la sesión de la cuenta propia de prueba, junto con los datos normales de conexión que registra la plataforma. No se sube el perfil profesional, CV ni análisis. Si falta autenticación, se registra el bloqueo y se deja que el usuario autorice el acceso de cuenta; nunca se solicita copiar contraseñas al informe. Recursos y cookies se conservan solamente dentro de la carpeta privada de esa instancia.

## Decisión final y recuperación

Entregar una tabla por caso con resultado, evidencia, respuesta original/Simple cuando corresponda, consumo real y pendiente. Sin promediar un fallo crítico con aciertos. No declarar estable por pasar checks técnicos.

- **Mariano apto para uso inicial supervisado:** etapa 1 completa, instalable/persistencia/aislamiento aprobados y al menos su fuente de scraping aprobada; sin pérdida material ni error importante compartido. Mantener accesible el original y revisar las primeras recomendaciones. InfoJobs queda fuera si S3 no se pudo validar.
- **Mariana apta para uso inicial supervisado:** L2/L3, etapa 2 y S2/F2 aprobados, más un perfil real suficiente confirmado. Con el estado actual, queda **NO APTO todavía**: el defecto local A8 está corregido, pero falta su perfil real y no se ejecutaron las etapas semánticas ni el scraping.
- **Rechazo inmediato:** contaminación de datos o credenciales, modificación del original, invención relevante, recomendación software por título, ocultar carencias, pérdida de historial, consumo fuera del límite o cualquier búsqueda no prevista.
- **Pendiente:** fuente sin resultados, challenge, modelo no disponible, timeout o juicio semántico indeterminado. No equivale a rechazo permanente de la arquitectura ni a aprobación.

Antes de ejecutar, copia privada íntegra de cada instancia de prueba y hashes del ZIP, perfiles y fixtures. Ante fallo: detener navegador y procesos de prueba, confirmar programación desactivada, conservar logs y respuestas redactando secretos, marcar la oferta fallida, no sobrescribir la referencia y no repetir llamadas automáticamente. Si se pierde persistencia, restaurar solamente la copia de esa instancia en otra carpeta y verificar sus hashes; jamás restaurar encima del Hunter original. El software activo original sigue disponible porque no se modifica. Las cookies nuevas pueden descartarse más adelante solo con autorización; no se borran repositorios ni ramas.

Si falla el matching o el diagnóstico, informar el caso y decidir después una corrección puntual; este protocolo no autoriza agregar funcionalidades, rediseñar ni reparar el producto. Una repetición paga, otra muestra, un perfil real diferente o más scraping requieren una nueva autorización acotada. No hay push ni merge.
