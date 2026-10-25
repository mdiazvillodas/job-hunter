# Incorporación de InfoJobs por instancia — 25/10/2026

Código común: configuración explícita de fuentes por instancia, perfil persistente InfoJobs configurable y modo headless independiente del usado por LinkedIn. Guardar preferencias conserva los campos adicionales, incluidas las fuentes. Sin cambios de Analyzer, scoring, detección de CAPTCHA ni opciones de ocultación existentes.

Mariana: LinkedIn e InfoJobs habilitados, sesión InfoJobs propia por defecto, perfil profesional migrado y verificado (127 archivos originales preservados). Clave OpenAI copiada con autorización expresa, límites de análisis de ambas plataformas en 0. Programación desactivada. ntfy conserva destino y umbral 80; Telegram pendiente de token. Consulta activa Arquitecto retail; las 12 consultas anteriores permanecen en el archivo privado y no se presentan como activas.

Mariano: incorporación del perfil local de su propia instancia browser-profile-infojobs-fresh-20261025, probado previamente con una página/cinco ofertas en headless. El perfil anterior se conserva. Despliegue protegido por el lock: espera que termine la búsqueda activa antes de cambiar archivos y reiniciar. No copia cookies entre personas.

Validación local: 13 pruebas InfoJobs, 3 de aislamiento/configuración y 7 de conexiones aprobadas (hay una prueba de Chrome común a las suites). Verifica conservación de fuentes al guardar, rutas separadas, modo InfoJobs independiente, exclusión mutua y conexiones. La operación no ejecuta nuevas búsquedas ni llamadas OpenAI. Una prueba pública exitosa no garantiza ausencia futura de CAPTCHA.

Cierre del despliegue: ambas instancias verificadas por HTTP, libres, con fuentes linkedin/infojobs e InfoJobs headless=true. Mariano usa /data/browser-profile-infojobs-fresh-20261025; Mariana usa su /data/browser-profile-infojobs separado. La búsqueda de Mariano que estaba activa terminó antes del reinicio; completó LinkedIn y encontró CAPTCHA en InfoJobs con la configuración anterior. No se presenta como prueba del nuevo perfil integrado. No se lanzó un hunt adicional como parte del despliegue.

También pasó npm run test:simple completo (procedencia, diagnóstico, persistencia, aislamiento, interfaz, programación y empaquetado simulado). Respaldo de Mariano en migration-final/backup/infojobs-instances-20261025-201035; respaldo adicional atómico infojobs-next-run-20261025-201140. Mariana respaldada en infojobs-instances-20261025-200152. Mantener perfiles previos y paquetes originales para recuperación. No hubo merge a main.
