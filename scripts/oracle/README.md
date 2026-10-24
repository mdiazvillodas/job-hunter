# Puesta en marcha privada en Oracle

El código es Linux/ARM64 compatible. No se despliega el ZIP Windows en Linux: se clona la rama revisada y se instalan sus dependencias nativas. Las instancias, secretos, cookies e historiales permanecen fuera del repositorio.

## Acceso

La capa común usa Authelia 4.39.28 y Caddy 2.11.7, sin autenticación casera en el Analyzer. Una cuenta `mariano` y otra `mariana` entran por el mismo hostname; después de autenticar, Caddy selecciona el backend exclusivamente por la identidad verificada. Rutas y APIs completas quedan protegidas. Los puertos de aplicaciones y autenticación se mantienen en loopback.

Se eliminan cabeceras de identidad aportadas por el cliente antes de consultar Authelia. Solo se aceptan operaciones de escritura cuyo Origin sea el portal HTTPS; únicamente después de validarlo se adapta Origin al backend HTTP local, preservando su protección existente.

Cinco fallos en quince minutos producen un bloqueo de quince minutos por usuario e IP. Es temporal, no permanente ni exponencial. Una IP compartida (incluido un túnel SSH) puede bloquear temporalmente a ambos usuarios: es un límite conocido. La sesión caduca a las ocho horas y tras quince minutos de inactividad; no se ofrece recordar sesión. El restablecimiento por correo y el cambio de contraseña están desactivados hasta configurar un canal seguro de administración. Las contraseñas se guardan como hashes Argon2id.

`access-config.js` genera configuración privada, base de usuarios con hashes y secretos aleatorios en un directorio **nuevo**. No sobrescribe una instalación existente ni resetea sesiones silenciosamente:

```sh
node scripts/oracle/access-config.js /srv/job-hunter-private/access hunter.tudominio.com auth.hunter.tudominio.com /ruta/privada/users-with-hashes.json
```

El archivo de entrada tiene únicamente los usuarios `mariano` y `mariana`, cada uno con `displayname` y `password` (hash `$argon2id$...`). Crear las claves en una terminal privada, nunca en commits, argumentos de scripts versionados ni chats. Authelia proporciona la orden interactiva `authelia crypto hash generate argon2`.

El directorio generado contiene secretos y una base SQLite: permisos restrictivos, copia de seguridad privada y exclusión de Git. Reiniciar Authelia conserva los bloqueos en SQLite, pero las sesiones en memoria requieren volver a entrar. No se necesita Redis para dos usuarios y un servidor.

## HTTPS y túnel

Para finalizar faltan nombres de acceso y confianza HTTPS. No hace falta mover ahora los DNS del dominio principal ni exponer las aplicaciones: el túnel puede reenviar el HTTPS privado de Caddy y resolver ambos nombres localmente. Authelia requiere hostnames apropiados y HTTPS; no funciona simplemente cambiándolos por una IP o `localhost`.

La CA interna se permite **solo en las pruebas sintéticas**. Para el uso personal se necesita un certificado confiable: certificado de dominio obtenido con validación DNS, o una CA privada que el usuario acepte instalar explícitamente en sus dispositivos. No se instala confianza ni se desactiva la validación de certificados automáticamente. Si se publica más adelante, usar un subdominio dedicado, HTTPS válido y revisar segundo factor, no abrir los puertos de los backends.

## Instancias y ejecución

Cada persona necesita su propia carpeta persistente, `.env`, `src/data/jobs`, perfil profesional, `browser-profile`, navegador de InfoJobs y puertos. No copiar sesiones de Windows ni compartir cookies entre candidatos.

`Dockerfile` prepara Node/Playwright y las herramientas de acceso gráfico manual. `start.sh` inicia únicamente UI y visor gráfico restringido a loopback, protegido por contraseña; no inicia scheduler, Telegram ni el trigger como servicio separado. El botón **Buscar ofertas** reutiliza el runner existente dentro de la UI. Un GET nunca inicia un hunt; POST exige origen correcto y respeta el bloqueo compartido, incluida la autenticación manual de LinkedIn. La clave OpenAI y los límites se recargan desde el `.env` de esa instancia antes de cada proceso.

El contenedor de aplicación usa `pwuser`, no root. Al preparar cada volumen hay que asignarle el UID/GID correspondiente a ese usuario en la imagen y permisos privados; no cambiar propietarios de carpetas de otros servicios. Los secretos de Authelia y el acceso gráfico no se guardan en la imagen.

Mariano: modo manual, sin programación, ntfy ni Telegram hasta validar calidad. Copiar íntegros los tres JSON profesionales, restricciones, configuración pertinente e historial actual del original, con manifiesto de hashes y respaldo. Las preferencias de visualización guardadas solo en localStorage del navegador no viajan con la copia de archivos; el feedback y las preferencias profesionales derivados de los registros sí se conservan al copiar el historial. No cargar tokens de Telegram/ntfy durante esta etapa.

Mariana: carpeta separada y perfil editable progresivo, sin heredar clave, preferencias, historial ni sesiones de Mariano. La migración de datos personales y la autenticación manual real no se ejecutan como parte de las pruebas de acceso.

## Comprobación antes de activar

- `npm run test:access`: generador y runner manual con procesos simulados, sin OpenAI.
- `test-access.sh`: en un directorio nuevo, junto con `access-config.js` y `verify-access.cjs`, verifica los contenedores reales con usuarios y backends sintéticos. Usa solo puertos privados 18443, 19091, 19073 y 19083. Elimina sus dos contenedores al terminar; conserva evidencia privada en `verification.json`.
- Verifica acceso anónimo denegado, aislamiento de ambas cuentas y APIs, cabeceras falsas, Origin ajeno, cookies Secure/HttpOnly y bloqueo tras cinco fallos.
- No prueba todavía LinkedIn real, calidad del modelo, importación de perfiles ni un hunt real. No enviar búsquedas durante instalación. Preservar el Hunter Windows como respaldo y evitar programación simultánea.

Fuentes: [Authelia/Caddy](https://www.authelia.com/integration/proxies/caddy/), [regulación](https://www.authelia.com/configuration/security/regulation/), [sesiones](https://www.authelia.com/configuration/session/introduction/).
