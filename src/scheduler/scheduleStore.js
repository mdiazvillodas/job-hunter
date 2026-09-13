'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { SCHEDULE_CONFIG_PATH } = require('../runtime');

const DEFAULT_SCHEDULE = Object.freeze({ enabled: false, daysOfWeek: [1, 2, 3, 4, 5], time: '09:00' });

function validateSchedule(value) {
  if (!value || typeof value !== 'object' || typeof value.enabled !== 'boolean') throw invalid('enabled debe ser boolean.');
  if (!Array.isArray(value.daysOfWeek) || value.daysOfWeek.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) throw invalid('daysOfWeek debe contener días 0-6.');
  if (value.enabled && value.daysOfWeek.length === 0) throw invalid('Seleccioná al menos un día.');
  if (typeof value.time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value.time)) throw invalid('time debe usar HH:MM.');
  return { enabled: value.enabled, daysOfWeek: [...new Set(value.daysOfWeek)].sort(), time: value.time };
}
function invalid(message) { const error = new Error(message); error.code = 'INVALID_SCHEDULE'; error.statusCode = 400; error.expose = true; return error; }

function createScheduleStore(options = {}) {
  const filePath = options.filePath || SCHEDULE_CONFIG_PATH;
  const fileSystem = options.fs || fs;
  function get() {
    if (!fileSystem.existsSync(filePath)) return { ...DEFAULT_SCHEDULE, daysOfWeek: [...DEFAULT_SCHEDULE.daysOfWeek] };
    try { return validateSchedule(JSON.parse(fileSystem.readFileSync(filePath, 'utf8'))); }
    catch (error) { if (error.code === 'INVALID_SCHEDULE') throw error; throw invalid('La configuración de schedule está corrupta.'); }
  }
  function save(value) {
    const schedule = validateSchedule(value);
    fileSystem.mkdirSync(path.dirname(filePath), { recursive: true });
    const temp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
    try { fileSystem.writeFileSync(temp, JSON.stringify(schedule, null, 2) + '\n'); fileSystem.renameSync(temp, filePath); }
    finally { if (fileSystem.existsSync(temp)) fileSystem.unlinkSync(temp); }
    return schedule;
  }
  return { get, save, filePath };
}

module.exports = { createScheduleStore, validateSchedule, DEFAULT_SCHEDULE };
