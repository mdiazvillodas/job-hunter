# Presentación extractiva — implementación local

Se mantiene el matching de Simple, sus instrucciones SYSTEM/USER, clasificaciones, scores y decisiones. El contrato de respuesta incorpora un único campo `profileReference` por requisito, dentro de la misma llamada. No se agregan llamadas, scoring, frameworks ni comprobaciones semánticas.

## Cambios

- `src/ai/profileProvenance.js` resuelve referencias exclusivamente contra el perfil recibido. Admite experiencias completas; objetos completos de capacidades, idiomas y educación; conjuntos completos de valores simples; y secciones completas del Markdown profesional. No admite campos internos, fragmentos de frases, metas ni contenido de la oferta. Un índice inexistente o una referencia inválida no producen cita.
- El modelo señala una ubicación, nunca redacta la cita. Simple recupera el contenido completo con sus condiciones, negaciones y campos vecinos. Para Markdown vuelve a extraer la sección del documento recibido, sin confiar en una copia derivada alterada.
- La fuente seleccionada y el hash del perfil se guardan con el análisis. Una edición posterior no sustituye silenciosamente esa fuente histórica. La persistencia conserva el análisis y todos sus textos libres originales; `result.raw` sigue siendo la respuesta original íntegra.
- La interfaz distingue texto del perfil (verde, desplegable), interpretación profesional (inferencia) y experiencia no documentada (ámbar). Una referencia auténtica no cambia una clasificación ni convierte la relación propuesta en equivalencia comprobada. Incluso DIRECT_MATCH se presenta como una propuesta de encaje, no una certificación.
- RESUMEN, POR QUÉ ENCAJA, EXPERIENCIA TRANSFERIBLE, BRECHAS y RAZONAMIENTO libres dejan de publicarse como explicaciones acreditadas. Las notas libres de requisitos/cobertura tampoco se muestran. La recomendación SÍ/QUIZÁS/NO y los puntajes permanecen visibles con su carácter orientativo. Las respuestas completas siguen en los datos locales para auditoría. La salida habitual del analizador por consola utiliza las mismas plantillas; el texto de auditoría se identifica como no verificado.
- Análisis anteriores sin procedencia: no se inventan referencias ni se releen contra el perfil actual. Conservan recomendación y puntajes, con “Sin referencia verificable al perfil”. No se reanalizan automáticamente ni se bloquean búsquedas.

## Ejemplos de la nueva presentación

Los tres primeros son reproducciones de las respuestas reales guardadas, sin nuevas llamadas ni referencias agregadas retrospectivamente:

| Caso | Lo que ahora ve el usuario |
|---|---|
| M3, OKR | **QUIZÁS, 80.** Para el requisito de cadencias operativas: “La IA propone una posible transferencia profesional. Es una inferencia: no acredita experiencia previa en este requisito.” No se publica “partial OKR cadence experience”. Sin referencia en esa respuesta histórica, se solicita revisar el fundamento. |
| M4, M&A | **QUIZÁS, 70.** “No documentado en el perfil recibido. No implica que no tengas esa experiencia.” No se muestra “No direct M&A ... experience”. |
| A8, AutoCAD | **QUIZÁS, 65.** AutoCAD figura como competencia no documentada. Se elimina de la presentación la afirmación sobre transferencia a su manejo básico. Las otras tareas que el modelo propuso por transferencia se presentan como inferencias sin cita verificable, no como antecedentes. |
| Transferencia legítima M2 | **SÍ, 90.** La transferencia hacia procesos de deployment sigue visible como propuesta. No se transforma una responsabilidad de coordinación o mejora de procesos en un cargo previo de deployment. |

Para verificar además la extracción se usó un fixture explícito: respuesta positiva histórica más referencia seleccionada manualmente `/capabilities/operations/4`. No es una nueva respuesta del modelo. La interfaz muestra completa la fuente real:

> Aspecto: Operating-model and workflow design
>
> Descripción: Designed scalable operating routines and improved cross-functional workflows and ownership clarity.

Separadamente muestra la posible transferencia hacia procesos estandarizados de gestión de proyectos, y aclara: “Texto documentado en el perfil al analizar. Su relación con el requisito no está comprobada.” No atribuye experiencia previa en OKR. El objeto completo se recupera por referencia; el modelo no puede citar solo una palabra de ese objeto.

## Validación y entrega

- 12 regresiones nuevas: M3/M4/A8, transferencia legítima, negaciones y estados incompletos conservados, referencias a oferta/metas/inexistentes rechazadas, frases genéricas sin conversión a herramientas, inmutabilidad de scores y decisión, auditoría, fuente persistente tras edición y reinicio, escape HTML y una única llamada simulada.
- Suite principal: 611 comprobaciones aprobadas. La prueba anterior de UI se adaptó porque ya no debe publicar el razonamiento libre, ni siquiera para un análisis vigente.
- Suite Simple: diagnóstico, aislamiento, persistencia, configuración, scheduler simulado y HTTP local aprobados.
- UI real en Chromium: reproducción de cuatro respuestas históricas y fixture de referencia; sin errores JavaScript, sin prosa inventada publicada. Las instrucciones de matching y mensajes de entrada se compararon con las solicitudes históricas y permanecen iguales.
- Instalación y navegador incluidos: paquete separado `Job-Hunter-0.2-simple-extractivo`, sin perfiles privados ni secretos. Pruebas de fuente, interfaz y sesión sintética offline se ejecutan desde el instalable.
- Cero llamadas pagas, cero scraping real, sin push ni merge. No se modifica ni actualiza ninguna instancia anterior automáticamente. Los paquetes previos permanecen disponibles.

## Límites conocidos

Esta intervención comprueba procedencia, no veracidad ni suficiencia profesional. Una fuente puede ser genérica, incorrecta, contener una aspiración o contradecir otra sección. Se muestra como declaración del perfil, nunca como competencia certificada. Las unidades completas evitan recortes internos; no resuelven contradicciones semánticas entre unidades diferentes.

Una referencia auténtica pero irrelevante puede ser seleccionada por el modelo. Por eso la relación sigue siendo una inferencia visible. No hay coincidencia literal obligatoria entre oferta y perfil: una experiencia bajo otro cargo o sector puede servir de fundamento para una posible transferencia.

Los scores y decisiones pueden seguir reflejando errores del modelo: no se recalculan ni se corrigen aquí. Las respuestas históricas no tienen el campo nuevo; la selección real de referencias en futuras llamadas aún requiere validación autorizada. La revisión local no aprueba por sí sola el uso cotidiano ni la calidad semántica del modelo.

El formato JSON admite solo las ubicaciones completas soportadas; una fuente válida pero no representable por ellas quedará sin cita. Esto reduce cobertura explicativa, sin penalizar el perfil ni bloquear búsquedas. Las fuentes guardadas son datos profesionales locales y deben conservar la misma privacidad que el historial.

Recuperación: cerrar la nueva instalación y abrir la copia anterior conservada. No copiar datos sobre el Hunter original. Para usar la nueva presentación en datos existentes se requiere una copia de esos datos en una instancia nueva; no se realizan migraciones automáticas.
