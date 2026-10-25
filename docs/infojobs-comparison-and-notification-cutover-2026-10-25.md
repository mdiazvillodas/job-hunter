# InfoJobs: comparación Windows/Oracle y traslado de notificaciones

## Evidencia

El original de Windows completó InfoJobs el 24/10/2026 a las 08:42 de Madrid (`run_mvm16yjkd05fd106.json`): 22 consultas, 177 ofertas únicas, tres nuevas y tres análisis, sin desafío. Una prueba mínima nueva el 25/10, con su configuración original efectiva (`headless=true`), también completó una página de `Operations Manager`, Barcelona, últimos siete días: 15 tarjetas detectadas, cinco ofertas devueltas y cero llamadas pagas/persistencias. No se modificó su código ni el historial de ofertas.

En Oracle, con el perfil habitual y el lanzador actual también en headless, esa búsqueda produjo una pantalla real «¿Eres humano o un robot?» y un control GeeTest visible. No era un falso positivo. El login manual posterior funcionó, pero una nueva búsqueda automática volvió a detenerse por desafío. Un ensayo anterior con Chrome visible, perfil nuevo y otras opciones había completado cinco ofertas: no permite atribuir la diferencia únicamente a la red de Oracle ni al modo headless.

Chrome real es 156.0.8078.47 en ambos equipos; Playwright es 1.62.1. `collector.js`, `challenge.js`, `detail.js`, `extract.js` y `urls.js` son idénticos, normalizando finales de línea. La detención ocurre antes del Analyzer. La selección de navegador, sistema operativo, perfil, red y dimensiones son diferencias de entorno.

## Diferencia concreta introducida al adaptar Linux

En la adaptación registrada en `cd71141`, el User-Agent fijo heredado quedó condicionado a Windows. Mediciones nuevas en `about:blank`, con el script de inicialización existente aplicado y sin navegación externa:

| Propiedad | Windows original | Oracle actual |
| --- | --- | --- |
| Modo | headless | headless |
| User-Agent | Windows NT 10.0; Chrome/128.0.0.0 | X11; Linux x86_64; HeadlessChrome/156.0.0.0 |
| `navigator.platform` | Win32 | Linux x86_64 |
| `navigator.webdriver` | undefined | undefined |
| Idioma | es-ES | es-ES |
| Viewport observado | 784×497 | 1440×813 |

La arquitectura física de Oracle es ARM64 aunque los valores observados del navegador declaren Linux x86_64. El identificador del original tampoco representa su Chrome real 156. El script que modifica webdriver se conserva; afirmar que toda la identificación del navegador era equivalente resultó demasiado general. La presencia de `HeadlessChrome` es una diferencia verificable, no una prueba de la decisión interna de GeeTest. No se cambió el User-Agent ni se agregaron técnicas para eludir el desafío. Tampoco se propone declarar Windows en un navegador Linux como garantía de funcionamiento.

## Telegram y ntfy

Por autorización expresa, Mariano pasa a utilizar en Oracle su bot existente `@mariano_job_hunter_bot`, cuenta autorizada y destino ntfy anteriores. No se trasladaron sesiones de navegador, claves administrativas ni credenciales de Mariana. La clave OpenAI ya existente en Oracle no cambió. El bot fue validado con getMe; no se enviaron mensajes de prueba. ntfy queda habilitado con su destino previo y umbral 90. El bot/listener y el runner de Oracle están activos, conservando límites de análisis y ejecución solo ante órdenes explícitas.

Antes de activar Oracle se detuvieron el consumidor Telegram y el trigger de Windows. Los accesos `JobHunterTelegram.lnk` y `JobHunterTrigger.lnk` se movieron a un respaldo privado; no se desinstaló software. En Windows se vació el token activo del bot en `.env`, se deshabilitó ntfy allí y en la variable de usuario. Se respaldaron configuración y estado; se migró el offset y se descartaron comandos pendientes antes de activar el nuevo listener. Esto evita consumidores simultáneos y hunts disparados por mensajes viejos. El historial profesional sigue intacto y la UI local puede conservarse para consulta hasta la limpieza solicitada por separado.

Mariana permanece independiente y sin tokens/destinos prestados. Los respaldos y archivos temporales con secretos están fuera de Git y tienen permisos privados. No se ejecutó un hunt completo ni se consumió OpenAI durante este trabajo. La entrega efectiva de Telegram puede comprobarse enviando `/status` al bot: es una consulta, no inicia una búsqueda.

## Recuperación

Detener primero Telegram de Oracle antes de reactivar Windows con el mismo bot. Restaurar el `.env`, la variable de usuario ntfy y los accesos de inicio desde el respaldo privado; conservar el offset más reciente o descartar backlog al reiniciar. No ejecutar dos consumidores del bot ni restaurar un historial antiguo sobre el actual. La desinstalación de Windows no se ha realizado.
