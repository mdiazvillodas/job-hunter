# LinkedIn Oracle: consulta normalizada y ventana remota

## Seguimiento: carga asíncrona de filtros

La prueba real posterior completó 11 de 14 consultas (25 tarjetas por consulta) y abortó en `Head of Product Operations` con `filtro no disponible o ambiguo: Past week`. El mensaje anterior no distinguía ausencia de duplicación y no se capturó el DOM del fallo: no permite afirmar su causa exacta.

Se corrigió una carrera reproducible: el panel visible no garantiza que sus controles estén montados. El control solicitado espera hasta 10 segundos, sin reenviar búsquedas ni escoger otro filtro. Los controles ausentes o duplicados siguen deteniendo el recorrido y el mensaje incluye la cantidad visible. No se cambian scoring, perfiles ni filtros solicitados.

Regresiones locales: 28 pruebas aprobadas, incluyendo fecha montada tarde tras un cambio de consulta, rechazo de dos controles visibles con el mismo nombre y rechazo de fecha ausente. La ejecución real anterior no persistió resultados parciales; conserva las 650 ofertas previas. OpenAI estuvo desactivado.

La comprobación real dirigida posterior identificó un diálogo visible ajeno al panel: `role=dialog`, `aria-label="Modal Window"`, clases `vjs-error-display vjs-modal-dialog`. El localizador genérico con `.first()` podía cambiar de identidad al ocultar los filtros, o seleccionar ese diálogo en lugar de ellos. Se restringe el alcance al aside con encabezado Jobs filters o a un modal con controles de fecha/jornada; no se selecciona arbitrariamente el primero. Una regresión mantiene el error de vídeo visible antes y después de inicializar/verificar filtros. No se ignoran errores ni se omite la verificación de fecha.

En la comprobación manual, una consulta escrita como `Head of Operations in Barcelona` quedó en la URL de LinkedIn como `keywords=head%20of%20operations%20in%20barcelona`. La comparación anterior exigía igualdad sensible a mayúsculas y devolvía falso incluso si LinkedIn había aceptado la consulta.

La comparación ahora normaliza únicamente mayúsculas, espacios y representación Unicode NFC, tanto en la URL como en el campo visible al reutilizar una consulta. Se conservan palabras, ubicación y acentos. No se elimina la exigencia de tarjetas nuevas después de un envío: resultados viejos o una ubicación diferente siguen rechazados. No se cambian filtros, Analyzer, scoring ni decisiones.

En Linux con DISPLAY, Chromium abre una ventana de 1440×900, igual que el escritorio virtual de Oracle. Windows y Linux sin display conservan su comportamiento. El escalado del visor depende del tamaño de pantalla del cliente; no se aumenta el escritorio ni se crean recursos adicionales.

Validación sin LinkedIn/OpenAI: 26 pruebas del flujo conversacional, incluyendo URL en minúsculas con resultados nuevos, rechazo de tarjetas viejas y conservación de términos/ubicación/acentos; tres pruebas de conexión/ventana. La sesión real de Mariano fue comprobada manualmente en el visor; esto no acredita una nueva búsqueda completa automatizada. InfoJobs y su desafío anti-bot quedan fuera de este cambio.
