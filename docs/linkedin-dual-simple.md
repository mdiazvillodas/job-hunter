# LinkedIn clásico y conversacional en Simple — 24/10/2026

Una sola versión detecta los controles presentes. No elige por Premium, no altera la suscripción ni fuerza el retorno a una pantalla que LinkedIn no ofrece.

- Clásica: conserva ubicación y filtros heredados.
- Conversacional: consulta con ubicación, filtros disponibles, tarjetas por componentkey y paginación por atributos observados.
- Jornada: antes de OpenAI exige evidencia explícita en la ficha de la misma oferta; omite incompatibles y deja pendientes desconocidas o contradictorias.
- Resultado ilegible: error si se anuncian ofertas positivas y no se reconocen tarjetas; no se presenta como búsqueda vacía satisfactoria.
- No cambian Analyzer, presentación extractiva, puntuaciones ni decisiones del modelo.

Las sesiones siguen siendo propias de cada instancia. Conectar LinkedIn.cmd permite autenticación manual persistente; no se copian cookies del original.

## Paquete y límites

El paquete actualizado es una nueva carpeta y ZIP, sin sobrescribir el anterior. No modifica automáticamente instancias ya creadas ni el Hunter original. No contiene perfiles de Mariano, datos de candidatos, claves ni sesiones. Las pruebas usan HTML local y respuestas históricas; no prueban de extremo a extremo el LinkedIn actual. Las referencias de DOM observadas pueden cambiar. Las comprobaciones de encabezados de resultados no cubren todos los idiomas.

## Puesta en marcha paralela en Oracle

Servidor inspeccionado: Ubuntu 24.04 ARM64, aproximadamente 12 GB de RAM y Docker disponible. El acceso SSH funciona y la imagen oficial de Playwright incluye Node 24. Se verificó la capa de autenticación con usuarios sintéticos y puertos privados; todavía no se desplegaron las instancias personales. Faltan los nombres de acceso, certificado HTTPS confiable y creación privada de credenciales. La carpeta Windows contiene ejecutables Windows: en Linux se usan los mismos fuentes con dependencias y navegador nativos, no node.exe ni los .cmd.

Preparar dos instancias independientes (Mariano y Mariana), con directorios, configuración, sesiones, puertos e historiales separados. Para Mariano, la puesta en marcha será manual desde la interfaz (botón Buscar). Programación automática, ntfy y Telegram desactivados. Activar ntfy o Telegram requiere una decisión posterior tras validar calidad. No se ejecutan búsquedas durante instalación o despliegue. Para Mariana, no se activan búsquedas ni programación automáticamente. La autenticación de LinkedIn es manual y propia en Oracle; no se presume portabilidad de cookies de Windows.

El Hunter actual de Mariano permanece como respaldo operativo. Durante la validación se evita que ambos ejecuten automáticamente las mismas búsquedas y notificaciones. Una migración final requiere respaldo y reconciliación de los datos generados desde la copia inicial (historial, preferencias, restricciones, configuración pertinente y los tres archivos profesionales), con verificación de integridad. No basta con una copia vieja del historial ni se fusionan cookies.

Tras validar resultados, persistencia, reinicio, aislamiento y autenticación en Oracle, se realiza un corte controlado de programación hacia Oracle y se conserva la recuperación local. Llevar a main cambios de fuente revisados con pruebas y una versión identificada recuperable; no sobrescribir main con el ZIP, node_modules, perfiles, claves o historiales. La publicación de la rama fue autorizada el 24/10/2026; el pase a main y el reemplazo del Hunter original siguen pendientes. Ver scripts/oracle/README.md para acceso y despliegue privado.
