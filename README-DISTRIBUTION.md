# Job Hunter v0.2 — guía rápida

Job Hunter es una aplicación local para preparar búsquedas de empleo y revisar oportunidades.
No requiere instalar Node, npm, Git, n8n ni herramientas de desarrollo.

## Primer inicio

1. Extraé o copiá la carpeta completa en una ubicación donde tengas permisos de escritura.
2. Hacé doble click en `start-job-hunter.cmd`.
3. Completá la configuración inicial en la pantalla de setup.
4. Usá **Preparar navegador de LinkedIn** para instalar el Chromium administrado.
5. Abrí la sesión manual de LinkedIn e iniciá sesión en la ventana visible.
6. Cerrá la ventana manual desde Job Hunter y ejecutá **Buscar oportunidades ahora**.

Los datos, la configuración, la sesión y las oportunidades se guardan localmente en
`runtime-data`. No compartas esa carpeta porque puede contener información privada.

## Búsquedas automáticas

Podés elegir días y hora local desde la pantalla principal. Job Hunter debe permanecer abierto
para ejecutar el horario. Si estaba cerrado a la hora indicada, no ejecuta búsquedas atrasadas:
calcula la siguiente fecha futura.

Chromium se instala sólo cuando lo solicitás desde la UI y queda dentro de
`runtime-managed/playwright-browsers`.
