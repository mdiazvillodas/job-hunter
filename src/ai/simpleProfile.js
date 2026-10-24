'use strict';
const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, 'candidate.md');
const sections = ['Profesión y especialidad', 'Experiencia y responsabilidades', 'Capacidades y herramientas', 'Preferencias y restricciones', 'Objetivos'];
function diagnose(text) {
  return require('./profileDiagnosis').diagnose(sections.map(name => section(text, name)), sections);
}
function section(text, name) {
  const lines = String(text || '').replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/);
  const result = [];
  let active = false;
  for (const line of lines) {
    const heading = /^(#{1,6})[\t ]+(.+?)\s*#*\s*$/.exec(line);
    if (heading && heading[1].length <= 2) active = heading[1] === '##' && heading[2].trim().toLowerCase() === name.toLowerCase();
    else if (active) result.push(line);
  }
  return result.join('\n').trim();
}
function read() { return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''; }
function save(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 200000) throw new Error('Perfil inválido o demasiado grande');
  fs.writeFileSync(file + '.tmp', text, { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
  return diagnose(text);
}
function profile() {
  const text = read();
  return { candidateDocument: text, informationQuality: diagnose(text),
    profession: section(text, sections[0]), experience: section(text, sections[1]),
    capabilities: section(text, sections[2]), preferences: section(text, sections[3]), targetRoles: section(text, sections[4]) };
}
module.exports = { read, save, profile, diagnose, sections, section };
