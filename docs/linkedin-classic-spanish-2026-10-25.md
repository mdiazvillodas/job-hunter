# LinkedIn clásico de Mariana — 25/10/2026

Causa confirmada: Mariana recibe /jobs/search/ en español con controles clásicos; el código ya elegía ese flujo, pero los selectores exigían etiquetas inglesas. Se observaron Ciudad, provincia/estado o código postal; Busca por cargo, aptitud o empresa; Todos los filtros; y Mostrar 2 resultados (espacio no separable antes de resultados).

Cambios mínimos: alias de etiquetas españolas en searchControls y acciones españolas en searchScope, incluido el contador dinámico. Se conservan inglés, detección automática de clásico/conversacional y controles del conversacional. Sin modificar Analyzer, scoring, cookies, configuración del perfil ni restricciones de filtros.

Pruebas: 20 de controles y 29 conversacionales/clásicas existentes aprobadas; regresión adicional del clásico español aprobada con codificación UTF-8, ubicación, fecha, jornada y cambio de consulta. El primer intento real avanzó hasta Mostrar 2 resultados y reveló el contador, incorporado en bdd3447.

Validación real final de Mariana: una consulta Arquitecto retail, Barcelona, jornada completa, última semana, una página y máximo cinco resultados. Se obtuvieron dos ofertas; ubicación geoId=107025191, f_TPR=r604800 y f_JT=F verificados en la URL. Cero llamadas OpenAI y cero ofertas persistidas. Es validación técnica de recolección, no de la calidad de recomendaciones (LinkedIn devuelve también anuncios no pertinentes).

Desplegado el mismo código en ambas instancias desde Git. Respaldos migration-final/backup/linkedin-classic-es-20261025-223006 y linkedin-classic-es-20261025-223313. InfoJobs no fue modificado por este parche y conserva su problema independiente de CAPTCHA. No hubo merge a main.
