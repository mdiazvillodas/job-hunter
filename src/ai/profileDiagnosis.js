'use strict';

// Conservative Spanish-language evidence cues, not a semantic verifier or score.
// One concrete task can suffice, including study/practice; seniority and numbers
// never participate. Keep examples and unrecognized phrasing in regression tests.
const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const GENERIC = /\b(?:soy|somos|un|una|el|la|los|las|de|del|en|y|o|con|al|a|para|por|mi|mis|he|tengo|uso|utilizo|manejo|busco|quiero|trabajo|trabajar|trabaje|experiencia|profesional|profesionales|profesionalmente|senior|junior|amplia|amplio|mucha|muchas|muchos|variada|solida|importante|importantes|estrategico|estrategicos|diversos|diversas|proyectos|proyecto|equipos|equipo|herramientas|herramienta|sector|soluciones|solucion|responsable|responsabilidades|lider|liderazgo|gestion|desarrollarme|desarrollo|crecer|crecimiento|progresar|buenas|buenos|condiciones|oportunidades|resultados|excelentes|alto|alta|rendimiento|gran|capacidad|capacidades|competencias|tareas|puesto|puestos|rol|roles|pendiente|completar|definir|especificar|habituales|necesarias|adecuadas|relevantes|varios|varias)\b/g;
const DOMAIN = /\b(?:edilici\w*|construccion\w*|edificacion|vivienda\w*|residencial\w*|industrial\w*|software|backend|frontend|financier\w*|contab\w*|logistic\w*|manufactura|educacion|docencia|sanitari\w*|clinica|comercio|marketing|diseno|recursos humanos|atencion al cliente)\b/;
const ACTION = /\b(?:prepar|elabor|dibuj|model|registr|actualiz|revis|disen|implement|desarroll|program|analiz|concili|atend|repar|instal|verific|document|coordin|calcul|redact|traduc|ensen|impart|investig|organiz|gestion|resolv|proces|realiz|manten|mantuv|supervis|administr|apoy|colabor)\w*\b/;
// Objects denote an identifiable task/deliverable, not "projects" or "results".
const WORK = /\b(?:planos|plantas|secciones|mediciones|modelos bim|interferencias|documentacion de obra|visitas de obra|presupuestos de obra|proyectos de (?:vivienda|reforma|construccion)|facturas|balances|conciliaciones|asientos contables|inventario|pedidos|rutas de reparto|servicios (?:rest|java|backend)|apis?|bases de datos|pruebas automatizadas|interfaces|integracion de (?:servicios|sistemas)|diseno de servicios|despliegues|incidentes de produccion|prototipos|entrevistas|campanas|lecciones|clases|material didactico|medicacion|curas|averias|circuitos|instalaciones electricas|contratos|expedientes|informes (?:financieros|tecnicos)|consultas de clientes)\b/;

function meaningful(text) {
  return /[a-z]/.test(normalize(text).replace(GENERIC, '').replace(/\b(?:no|sin|se|lo|que|sepa|sabe)\b/g, ''));
}
function statements(text) {
  return normalize(text).split(/[.!?;\n]+/).map(s => s.replace(/^\s*[-*+]\s*/, '').trim()
    .replace(/^sin experiencia(?: laboral| previa| profesional)?\s*[,:]\s*/, ''))
    .filter(s => s && !/^(?:no\b|nunca\b|sin\b|pendiente\b|por completar\b)/.test(s));
}
function specialty(text) {
  return statements(text).some(s => DOMAIN.test(s) ||
    /(?:especialidad|especializacion|sector)\s*:\s*(.+)/.test(s) && meaningful(s.split(':').slice(1).join(':')) ||
    /\b(?:en|de|del)\s+(.+)/.test(s) && meaningful(s.match(/\b(?:en|de|del)\s+(.+)/)[1]));
}
function responsibilities(text) {
  return statements(text).some(s => ACTION.test(s) && WORK.test(s));
}
function contextualCapabilities(text, experience) {
  const tasks = statements(experience).filter(s => ACTION.test(s) && WORK.test(s));
  return statements(text).some(s => {
    // "AutoCAD para planos", "Excel: conciliaciones", "mediciones con cinta".
    const relation = /\b(?:para|con|mediante)\b|:/.exec(s);
    if (relation && WORK.test(s)) {
      const before = s.slice(0, relation.index), after = s.slice(relation.index + relation[0].length);
      const method = relation[0] === 'con' || relation[0] === 'mediante' ? after : before;
      if (meaningful(method)) return true;
    }
    // A named method/tool list is contextual when the same item is used in a
    // documented task elsewhere. No closed list of software brands is required.
    return s.split(/[,/:]+/).some(item => {
      const name = item.trim();
      return meaningful(name) && tasks.some(task => task.includes(name));
    });
  });
}
function preferences(text) {
  if (/\b(?:sin preferencias|sin restricciones|no (?:tengo|hay) restricciones|cualquier modalidad)\b/.test(normalize(text))) return true;
  return statements(text).some(s => /\b(?:presencial|remot\w*|hibrid\w*|jornada|horario|disponibilidad|traslad\w*|salario|viajar|turno\w*|sin preferencias|cualquier modalidad|sin restricciones)\b/.test(s) ||
    /\b(?:ubicacion|ciudad|residencia)\s*:\s*(.+)/.test(s) && meaningful(s.split(':').slice(1).join(':')));
}
function goals(text) {
  return statements(text).some(s => meaningful(s) && (DOMAIN.test(s) || /\b(?:puesto|rol|como|busco|objetivo)\b/.test(s)));
}
const QUESTIONS = [
  '¿Cuál es tu profesión y especialidad? Indicá el sector o tipo de trabajo (por ejemplo, arquitectura edilicia o software).',
  'Contá una tarea que hiciste y sobre qué entregable o situación: ¿qué preparaste, revisaste o resolviste? Sirven estudios, proyectos personales y prácticas bajo supervisión.',
  '¿Qué herramienta, técnica o método usaste y para qué tarea? Puede ser manual o digital; diferenciá aprendizaje de uso profesional.',
  '¿Qué modalidad, jornada, ubicación o disponibilidad necesitás? Podés indicar que no tenés restricciones o qué sigue pendiente.',
  '¿Qué puesto o tipo de trabajo querés buscar? Nombrá un rol o ámbito concreto, aunque sea junior o de prácticas.'
];
function diagnose(content, sections) {
  const documented = [specialty(content[0]), responsibilities(content[1]), contextualCapabilities(content[2], content[1]), preferences(content[3]), goals(content[4])];
  const missing = sections.filter((_, index) => !documented[index]);
  const questions = sections.flatMap((name, index) => documented[index] ? [] : [{ section: name, question: QUESTIONS[index] }]);
  const usable = documented[0] && (documented[1] || documented[2]);
  return {
    status: missing.length === 0 ? 'Perfil suficientemente documentado' : usable ? 'Perfil utilizable con información pendiente' : 'Perfil insuficiente para recomendaciones confiables',
    missing, questions,
    advice: 'Podés seguir buscando y editar el perfil. Este diagnóstico orientativo reconoce ejemplos concretos; no verifica su veracidad ni evalúa tu capacidad. Si no reconoce una descripción, aclarala con un ejemplo. No exige métricas, liderazgo ni experiencia laboral previa.'
  };
}
module.exports = { diagnose };
