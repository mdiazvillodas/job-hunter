'use strict';

const BLOCKED_CODES = new Set([
  'HUNT_ALREADY_RUNNING',
  'SESSION_WINDOW_OPEN',
  'SETUP_REQUIRED',
  'LOGIN_REQUIRED',
  'CHECKPOINT_REQUIRED',
  'APP_SHUTTING_DOWN',
]);

function calculateNextRun(schedule, from = new Date()) {
  if (!schedule.enabled || !schedule.daysOfWeek.length) return null;
  const [hour, minute] = schedule.time.split(':').map(Number);
  for (let offset = 0; offset <= 7; offset += 1) {
    const candidate = new Date(from);
    candidate.setDate(from.getDate() + offset);
    candidate.setHours(hour, minute, 0, 0);
    if (schedule.daysOfWeek.includes(candidate.getDay()) && candidate > from) return candidate;
  }
  return null;
}

function createLocalScheduler(options = {}) {
  const store = options.scheduleStore;
  const huntRunManager = options.huntRunManager;
  const browserInstallManager = options.browserInstallManager;
  const clock = options.clock || (() => new Date());
  const scheduleTimeout = options.setTimeout || setTimeout;
  const cancelTimeout = options.clearTimeout || clearTimeout;
  let timer = null;
  let running = false;
  let started = false;
  let status = { nextRunAt: null, lastRunAt: null, lastStatus: null };

  if (!store || !huntRunManager || typeof huntRunManager.start !== 'function' || typeof huntRunManager.waitForRun !== 'function') {
    throw new TypeError('scheduleStore y huntRunManager son obligatorios.');
  }

  function publicStatus() {
    return { ...store.get(), ...status };
  }

  async function trigger() {
    if (!started || running) return false;
    status.lastRunAt = clock().toISOString();
    if (browserInstallManager && browserInstallManager.getStatus().status === 'RUNNING') {
      status.lastStatus = 'BLOCKED';
      plan();
      return false;
    }
    running = true;
    try {
      const accepted = await huntRunManager.start();
      status.lastStatus = 'RUNNING';
      const final = await huntRunManager.waitForRun(accepted.runId);
      status.lastStatus = final.status === 'COMPLETED' ? 'COMPLETED' : 'FAILED';
      return true;
    } catch (error) {
      status.lastStatus = BLOCKED_CODES.has(error && error.code) ? 'BLOCKED' : 'FAILED';
      return false;
    } finally {
      running = false;
      plan();
    }
  }

  function plan() {
    if (timer) cancelTimeout(timer);
    timer = null;
    if (!started) { status.nextRunAt = null; return publicStatus(); }
    const next = calculateNextRun(store.get(), clock());
    status.nextRunAt = next ? next.toISOString() : null;
    if (next) {
      const delay = Math.min(next.getTime() - clock().getTime(), 2147483647);
      timer = scheduleTimeout(() => { timer = null; trigger(); }, delay);
      if (timer && typeof timer.unref === 'function') timer.unref();
    }
    return publicStatus();
  }

  function start() { started = true; return plan(); }
  function update(value) { store.save(value); return plan(); }
  function stop() { started = false; if (timer) cancelTimeout(timer); timer = null; status.nextRunAt = null; }
  return { start, stop, update, trigger, getStatus: publicStatus, isRunning: () => running };
}

module.exports = { createLocalScheduler, calculateNextRun, BLOCKED_CODES };
