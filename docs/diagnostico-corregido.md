# Corrección acotada del diagnóstico

Se corrigió exclusivamente el diagnóstico de perfiles nuevos y la presentación de sus preguntas. No cambian el Analyzer, scoring, scraping, filtros ni perfiles JSON originales. El archivo Markdown del candidato no se modifica al diagnosticarlo.

La presencia de encabezados solo permite localizar información. Para considerar documentado el perfil se buscan indicios concretos: especialidad o ámbito, una tarea realizada sobre un entregable identificable, una herramienta/técnica/método con contexto de uso, preferencias y objetivo concreto. Por ejemplo, «preparé planos de viviendas con AutoCAD durante prácticas» aporta más información que «lideré proyectos estratégicos». Una tarea de estudios o prácticas sirve; no se exige antigüedad laboral.

Las reglas son locales, deterministas y están concentradas en `src/ai/profileDiagnosis.js`. No llaman a un modelo ni puntúan a la persona. No usan número de palabras, cifras, resultados cuantificados, presupuestos o liderazgo. Si falta evidencia profesional básica se informa insuficiencia; con base utilizable y datos pendientes se muestra el estado intermedio. Cada carencia incluye una pregunta concreta en la página Perfil.

La evaluación es orientativa para el texto en español: los patrones reconocen ejemplos, no verifican su verdad ni entienden toda formulación o profesión posible. Una descripción válida que no se reconozca puede requerir aclaración. No es una certificación de competencia ni una garantía de matching. No se otorga suficiencia por rellenar todos los encabezados. Repetir prosa genérica no mejora el diagnóstico.

## Regresiones

| Perfil | Resultado esperado y comprobado |
|---|---|
| Encabezados vacíos | Insuficiente; cinco carencias y sus preguntas |
| Superficial con todos los encabezados (A8) | Insuficiente; pide tareas, herramientas contextualizadas, preferencias y objetivos |
| Junior con prácticas documentadas | Suficientemente documentado; sin exigir dirección |
| Senior con descripciones genéricas | Insuficiente; el título y liderazgo no sustituyen las tareas |
| Arquitectura edilicia con responsabilidades concretas | Suficientemente documentado |
| Perfil profesional suficiente sin cifras | Suficientemente documentado, sin métricas ni presupuestos |

También se probaron repetición de texto, comentarios Markdown, capacidades sin contexto, negaciones, otro ámbito profesional, preguntas visibles, guardado y lectura de texto superficial, y discovery/análisis/persistencia con dependencias simuladas. El diagnóstico no bloquea la búsqueda ni el guardado.

Pruebas: 13 regresiones de diagnóstico, suite original de 611 comprobaciones, smoke HTTP local y verificación offline del paquete corregido. La comparación de las entradas y prompts de Mariano conserva la referencia de 783 ofertas históricas. No se ejecutaron llamadas pagas ni scraping real.

El paquete anterior se conserva. El protocolo y su preflight apuntan al ZIP corregido y mantienen el máximo de 22 llamadas y tres recorridos de scraping **todavía no autorizados**. L3/A8 local está corregido; la respuesta del modelo A8 sigue pendiente, al igual que cargar un perfil real de Mariana. No se aprueba el uso real por esta corrección aislada.
