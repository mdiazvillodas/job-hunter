# InfoJobs: entrada por portada — 25/10/2026

Cambio b93687e: Chrome abre https://www.infojobs.net/ antes de la primera consulta de cada página de recolección. Comprueba CAPTCHA antes y después de cookies; conserva búsquedas, filtros, launcher y parada ante challenge. No completa todavía el formulario de búsqueda: continúa mediante las URLs existentes después de la portada.

Pruebas locales: 13 unitarias y 9 de navegador con fixtures aprobadas. Dos regresiones nuevas verifican orden de navegación/entrada única y parada por CAPTCHA en portada. Se actualizó una expectativa antigua de Chromium Linux a Chrome oficial.

Desplegado desde Git en ambas instancias, con respaldo en migration-final/backup/infojobs-homepage-20261025-171706. Sin cambios al Hunter de Windows, perfiles, scoring ni credenciales.

Prueba real única: perfil nuevo autenticado browser-profile-infojobs-fresh-20261025, Chrome oficial visible, Operations Manager, una página/hasta cinco ofertas. Falló ANTES de buscar: GeeTest visible en https://www.infojobs.net/, etapa homepage, 2026-10-25T16:17:19.190Z. Cero llamadas OpenAI y cero ofertas persistidas. Contexto cerrado y lock liberado por finally.

Conclusión: entrar por portada no basta en el estado actual. El CAPTCHA ya aparece al reabrir la portada con el launcher habitual; no puede atribuirse exclusivamente a la URL de resultados. No se intentó resolver ni eludir la verificación. Tampoco se afirma que la sesión manual anterior fuera inválida: fue observada autenticada.

## Nueva prueba headless después de verificación manual

El usuario completó el CAPTCHA y se observó la cuenta abierta en Chrome visible. Se cerró la ventana correctamente y se relanzó el mismo perfil fresh-20261025 con HEADLESS=true, sin borrar cookies ni alterar opciones.

Resultado: una búsqueda Operations Manager, Barcelona/últimos 7 días, una página, 16 tarjetas, cinco ofertas devueltas, filtros comprobados. Sin CAPTCHA, cero llamadas OpenAI y cero ofertas persistidas.

Limitación: la visita previa a la cuenta redirigió a candidate-login. El script privado usó inicialmente includes para comprobar la URL y tomó erróneamente el parámetro goesTo por la página autenticada; corregido a pathname exacto para futuras pruebas. No se confirma persistencia del login. La búsqueda pública sí completó. Este éxito aislado no demuestra que futuras ejecuciones queden libres de verificación; tampoco cambia el perfil habitual de producción.
