# Correcciones mínimas posteriores al piloto — 18/10/2026

Se corrigió Simple sin modificar el Hunter original, sus perfiles, preferencias o historial. No se ejecutaron llamadas pagas, scraping real, push ni merge.

| Defecto | Cambio exacto | Regresión local |
|---|---|---|
| M3 — experiencia inventada | El SYSTEM prohíbe convertir requisitos o ejemplos exclusivos de la oferta en experiencia pasada, incluso al parafrasear fortalezas. Pide identificar la responsabilidad documentada que fundamenta la transferencia. | Oferta y hechos del candidato permanecen separados; instrucciones explícitas contra atribución y a favor de transferencia entre cargos, sectores y profesiones. |
| M4 — brechas sin evidencia | Una copia del perfil destinada al prompt sustituye exclusivamente la regla heredada conflictiva conocida. `NOT_EVIDENCED` para información desconocida; `CLEAR_GAP`, `CRITICAL_GAP` y cobertura `ABSENT` requieren evidencia concreta. La taxonomía de seis niveles prevalece. | La regla contradictoria desaparece del payload; hechos, otras reglas y objeto recibido permanecen intactos. No cambia el scoring ni el esquema. |
| A8 — herramientas inferidas | El Markdown importado ya no se presenta como framework completo. La transferencia exige tareas, responsabilidades, métodos o experiencias concretos. Una afirmación genérica sobre herramientas no demuestra AutoCAD ni otra herramienta específica. | Markdown superficial conserva su incertidumbre y no presupone un framework. Se preservan hechos de un junior con AutoCAD contextualizado, sin exigir métricas ni liderazgo. La búsqueda sigue permitida. |
| LinkedIn — sesión | Nuevo `Conectar LinkedIn.cmd` por instancia abre `src/connect-linkedin.js`, exclusivamente para autenticación manual en navegador visible y persistente. Reutiliza `browser-profile` y el bloqueo de búsqueda existentes. No inspecciona ni copia cookies/credenciales, no automatiza login, no recolecta ofertas y no ejecuta Analyzer. | Ventana abierta hasta cierre humano, incluso ante error de navegación; bloqueo entre conexión y búsqueda de la misma instancia; otra instancia independiente; liberación ante cierre o fallo de lanzamiento. |

La interfaz Configuración y LEEME explican cómo abrir el comando y cerrar la ventana al terminar. No se añadió una nueva API de autenticación ni automatización del navegador para completar formularios. Si LinkedIn pide verificaciones, el usuario las resuelve manualmente o cierra la ventana.

## Verificación ejecutada

- `npm test`: **611 comprobaciones aprobadas**, incluyendo fixtures locales de scraping y navegación; ninguna búsqueda real.
- `npm run test:simple`: **6 regresiones nuevas y 13 del diagnóstico aprobadas**, equivalencia de entradas de 783 ofertas históricas y del contrato de salida, hechos íntegros del perfil salvo la sustitución normativa indicada, aislamiento, persistencia, scheduler simulado e interfaz HTTP local. Ya no se afirma igualdad del SYSTEM con el original: las instrucciones cambiaron de forma autorizada.
- Instalación desde el paquete con su Node y Chromium incluidos: sin perfiles personales ni secretos, diagnóstico superficial/junior correcto, acceso de conexión presente e instrucciones actualizadas. El helper empaquetado abrió un navegador visible con toda navegación interceptada localmente; permaneció pendiente hasta el cierre. Una cookie **sintética** persistió al reabrir su perfil y estuvo ausente en otro perfil. No se accedió a LinkedIn.
- Integridad del original: hashes iguales para los tres JSON profesionales, `.env` y los **783** registros frente a la referencia privada anterior. No se tocaron sesiones originales.
- Costo de esta revisión: **USD 0; 0 llamadas reales y 0 scraping real**.

Las regresiones de M3/M4/A8 comprueban construcción del prompt, separación de fuentes e inmutabilidad. No simulan que el modelo obedece: la corrección semántica real queda pendiente de una revalidación autorizada. Tampoco prueban que LinkedIn acepte una sesión o que no la expire. No se declara estable ni aprobado para uso cotidiano por estos resultados locales.

## Entrega y recuperación

Paquete separado: `dist/Job-Hunter-0.2-simple-correcciones-minimas` y ZIP Windows del mismo nombre. Los instalables anteriores permanecen disponibles. Crear una instancia nueva con Instalar.cmd; no se actualizan ni sobrescriben instancias anteriores automáticamente. Para conservar una sesión propia, mantener completa su carpeta de instancia, sin copiar nada del Hunter original.

Si falla la apertura, cerrar la ventana y revisar el mensaje de la consola; no hay reintentos automáticos. Si la sesión expira, repetir Conectar LinkedIn.cmd manualmente. Si aparece un bloqueo ocupado, terminar primero la búsqueda/conexión de esa instancia. Para volver a la versión previa, cerrar Simple y abrir la instalación previa conservada; no mezclar perfiles de navegador ni sobrescribir el historial. Los resultados históricos del piloto no se reescribieron.
