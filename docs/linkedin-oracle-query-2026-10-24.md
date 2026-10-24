# LinkedIn Oracle: consulta normalizada y ventana remota

En la comprobación manual, una consulta escrita como `Head of Operations in Barcelona` quedó en la URL de LinkedIn como `keywords=head%20of%20operations%20in%20barcelona`. La comparación anterior exigía igualdad sensible a mayúsculas y devolvía falso incluso si LinkedIn había aceptado la consulta.

La comparación ahora normaliza únicamente mayúsculas, espacios y representación Unicode NFC, tanto en la URL como en el campo visible al reutilizar una consulta. Se conservan palabras, ubicación y acentos. No se elimina la exigencia de tarjetas nuevas después de un envío: resultados viejos o una ubicación diferente siguen rechazados. No se cambian filtros, Analyzer, scoring ni decisiones.

En Linux con DISPLAY, Chromium abre una ventana de 1440×900, igual que el escritorio virtual de Oracle. Windows y Linux sin display conservan su comportamiento. El escalado del visor depende del tamaño de pantalla del cliente; no se aumenta el escritorio ni se crean recursos adicionales.

Validación sin LinkedIn/OpenAI: 26 pruebas del flujo conversacional, incluyendo URL en minúsculas con resultados nuevos, rechazo de tarjetas viejas y conservación de términos/ubicación/acentos; tres pruebas de conexión/ventana. La sesión real de Mariano fue comprobada manualmente en el visor; esto no acredita una nueva búsqueda completa automatizada. InfoJobs y su desafío anti-bot quedan fuera de este cambio.
