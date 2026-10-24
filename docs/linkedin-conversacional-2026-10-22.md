# LinkedIn: adaptación conversacional — 22/10/2026

Parche preparado en copia y aplicado al Hunter original con autorización expresa del usuario, después de pruebas locales. No se ejecutaron búsquedas reales, llamadas OpenAI ni envíos ntfy durante la corrección.

## Cambio

- Detecta el campo conversacional observado `input[componentkey="semanticSearchBox"][data-testid="typeahead-input"]` y la ruta `/jobs/search-results/`. Conserva el flujo clásico y su ubicación por control independiente.
- En flujo conversacional envía el cargo y la ubicación como texto: `Head of Operations in Barcelona`. **La ubicación es orientativa, no un filtro geográfico estricto**; se indica en diagnósticos y en la notificación ntfy de cierre.
- Aplica fecha y jornada usando nombres y roles accesibles, no IDs variables. Confirma el estado de las opciones después de aplicar y vuelve a aplicarlas al cambiar la consulta, por si LinkedIn las reinicia. No continúa si falta un control solicitado, hay ambigüedad o no puede comprobar los filtros.
- Exige keyword confirmado en URL y cambio de la firma de resultados al cambiar consulta. No basta cambiar el texto del input o la URL con tarjetas viejas. Si dos consultas devuelven exactamente las mismas tarjetas, se puede omitir una por precaución; no se inventa una confirmación.
- No modifica la selección de perfiles, Analyzer, prompts, scoring, persistencia ni credenciales. InfoJobs mantiene su flujo; solo se transporta un aviso de ubicación en los resúmenes de LinkedIn conversacional.

## Pruebas

611 comprobaciones existentes y 14 regresiones nuevas aprobadas en copia aislada, con fixtures locales de navegador y peticiones externas de Node bloqueadas. Casos: interfaz clásica/conversacional, redirección, query con ubicación, filtros que se reinician, controles nativos y ARIA, acciones con contador, filtros ausentes o contradictorios, resultados/URL obsoletos y propagación del aviso hasta ntfy sin enviar notificaciones reales.

## Alcance y límites

El HTML del campo y los nombres de filtros proceden de la inspección manual aportada por el usuario. El contenedor modal y los controles se comprobaron en fixtures, no contra una sesión real durante este trabajo. El parche no declara el scraping de producción validado: si LinkedIn expone otra estructura, fallará de forma explícita y habrá que revisar ese error/HTML.

No sustituye ubicación por una falsa garantía. LinkedIn puede devolver resultados fuera de Barcelona; revisar la ubicación de cada oferta. Los extractores de tarjetas, detalle y paginación no se rediseñaron y pueden requerir una adaptación adicional si cambió su DOM.

## Activación y recuperación

El trigger original inicia un proceso nuevo de `src/hunt.js` para cada `/hunt`; el siguiente comando utiliza el parche sin reiniciar Telegram. No se lanzó un hunt de prueba ni se modificó la programación existente.

Copia de trabajo, respaldo previo y manifiesto de aplicación: `C:\dev\job-hunter-v02\linkedin-conversational-fix-20261022`. El respaldo permite restaurar solo los archivos del parche, manteniendo datos y sesiones. No se copiaron perfiles de navegador. Las instancias de Simple y Oracle no se actualizaron ni desplegaron en esta corrección.


## Corrección de jornada — 23/10/2026

La sesión inspeccionada no ofrece Full-time en All filters ni en Employment type. Si falta esa casilla, se aplican los demás filtros y la jornada queda pendiente de comprobar por oferta. Antes del Analyzer, el adaptador conversacional exige una etiqueta explícita de jornada en la ficha de esa misma oferta (chip de metadatos o campo Employment type / Tipo de empleo), no una mención en prosa.

Solo Full-time / Jornada completa inequívoco permite analizar cuando esa es la preferencia. Part-time, Contract u otras jornadas se omiten; falta de evidencia o contradicción quedan pendientes sin llamadas a OpenAI ni notificaciones de recomendación. Se conserva el registro descubierto, sin cambiar scoring, decisiones anteriores o feedback. El resumen ntfy informa cantidades omitidas/pendientes. Si ya había descripción útil pero faltaba evidencia de jornada, se consulta la ficha para verificarla. Las comprobaciones consumen el límite existente de candidatos: no se amplía el volumen del hunt para compensar exclusiones.

La comprobación se limita a metadatos explícitos y puede dejar ofertas válidas pendientes si LinkedIn oculta o cambia esas etiquetas. No se garantiza cobertura total. El flujo clásico y InfoJobs conservan su comportamiento. La versión clásica y las versiones anteriores del parche permanecen respaldadas. La batería local usa HTML simulado y transportes falsos: no equivale a una validación de extremo a extremo contra LinkedIn.


## Corrección de extracción de tarjetas — 23/10/2026

El run run_mvl8i3kk1c05f22c completó 14 consultas con cero tarjetas. Inspección manual posterior: 24 botones main [role="button"][componentkey^="job-card-component-ref-"] y cero li[data-occludable-job-id]. Se añade extracción por el componentkey observado y los tres párrafos iniciales (título, empresa, ubicación), con título visible separado de la copia accesible. Se conservan selectores clásicos y URLs canónicas por jobId. Se reconoce paginación por data-testid pagination-controls-next-button-visible e indicador aria-current. La firma de cambio de consulta incluye tarjetas nuevas, no solo el enlace de la oferta seleccionada.

Si hay tarjetas incompletas o la pantalla anuncia resultados positivos pero el extractor no reconoce tarjetas, se produce error explícito en lugar de éxito vacío. Límites: esta estructura puede cambiar; los mensajes de resultados en otros idiomas aún no se usan para la comprobación de pantalla no reconocida. La inspección no envió consultas ni aplicó filtros. Pruebas de extracción y dos páginas con HTML local que reproduce los atributos observados; no se ejecutó hunt ni OpenAI real.
