/* Logica pura de lista (filtro/orden/busqueda/contadores). UMD: funciona en Node (require)
 * y en el navegador (window.JobListLogic). NO contiene reglas de dominio (transiciones/feedback):
 * eso vive en domain/service. Aqui solo hay presentacion de la lista. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.JobListLogic = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function ai(job) {
    return job && job.aiAnalysis ? job.aiAnalysis : null;
  }
  function overall(job) {
    const a = ai(job);
    return a && typeof a.overallMatchScore === 'number' ? a.overallMatchScore : null;
  }
  function decision(job) {
    const a = ai(job);
    return a && a.decision ? a.decision : null;
  }
  function status(job) {
    return job && job.userState ? job.userState.status : 'new';
  }
  // Estados que representan una DECISION definitiva del usuario: sacan la oferta del Inbox.
  const DECIDED_STATUSES = ['interested', 'applied', 'discarded'];
  // Una oferta esta "pending" (en el Inbox) mientras el usuario no haya tomado una decision.
  // new, read y priority siguen pendientes: priority es una marca, no una decision terminal.
  function isPending(job) {
    return !DECIDED_STATUSES.includes(status(job));
  }
  function lower(s) {
    return (s == null ? '' : String(s)).toLowerCase();
  }

  function listItemView(job) {
    return {
      jobId: job.jobId,
      title: job.title || null,
      company: job.company || null,
      location: job.location || null,
      overall: overall(job),
      aiDecision: decision(job),
      status: status(job),
      easyApply: job.easyApply === true,
      firstSeenAt: job.userState ? job.userState.firstSeenAt : null,
    };
  }

  function matchesSearch(job, term) {
    if (!term) return true;
    const t = lower(term);
    return [job.title, job.company, job.location, job.description].some((f) => lower(f).includes(t));
  }

  function searchJobs(jobs, term) {
    return jobs.filter((j) => matchesSearch(j, term));
  }

  // filters: { status, aiDecision, easyApply('all'|'yes'|'no'), families:[], minScore:Number,
  //            company:String, matchedQuery:String, search:String }
  function filterJobs(jobs, filters) {
    const f = filters || {};
    return jobs.filter((job) => {
      if (f.status && f.status !== 'all') {
        // 'inbox' = bandeja de pendientes (excluye interested/applied/discarded).
        if (f.status === 'inbox') {
          if (!isPending(job)) return false;
        } else if (status(job) !== f.status) return false;
      }
      if (f.aiDecision && f.aiDecision !== 'all' && decision(job) !== f.aiDecision) return false;
      if (f.easyApply === 'yes' && job.easyApply !== true) return false;
      if (f.easyApply === 'no' && job.easyApply === true) return false;
      if (f.families && f.families.length) {
        const fam = job.matchedFamilies || [];
        if (!f.families.some((x) => fam.includes(x))) return false;
      }
      if (f.minScore && f.minScore > 0) {
        const o = overall(job);
        if (o == null || o < f.minScore) return false;
      }
      if (f.company) {
        if (!lower(job.company).includes(lower(f.company))) return false;
      }
      if (f.matchedQuery) {
        if (!(job.matchedQueries || []).includes(f.matchedQuery)) return false;
      }
      if (f.search && !matchesSearch(job, f.search)) return false;
      return true;
    });
  }

  function sortJobs(jobs, key) {
    const arr = jobs.slice();
    const byNum = (get, dir) => (a, b) => {
      const va = get(a);
      const vb = get(b);
      const na = va == null ? -Infinity : va;
      const nb = vb == null ? -Infinity : vb;
      return dir * (nb - na);
    };
    const byStr = (get) => (a, b) => lower(get(a)).localeCompare(lower(get(b)));
    switch (key) {
      case 'newest':
        return arr.sort((a, b) => new Date(b.userState.firstSeenAt) - new Date(a.userState.firstSeenAt));
      case 'oldest':
        return arr.sort((a, b) => new Date(a.userState.firstSeenAt) - new Date(b.userState.firstSeenAt));
      case 'title':
        return arr.sort(byStr((j) => j.title));
      case 'company':
        return arr.sort(byStr((j) => j.company));
      case 'overall':
      default:
        return arr.sort(byNum(overall, 1)); // desc, missing al final
    }
  }

  function countByStatus(jobs) {
    const counts = { all: jobs.length, inbox: 0, new: 0, read: 0, interested: 0, discarded: 0, applied: 0, priority: 0 };
    for (const j of jobs) {
      const s = status(j);
      if (counts[s] != null) counts[s] += 1;
      if (isPending(j)) counts.inbox += 1;
    }
    return counts;
  }

  function deriveFamilies(jobs) {
    const set = new Set();
    jobs.forEach((j) => (j.matchedFamilies || []).forEach((f) => set.add(f)));
    return Array.from(set).sort();
  }

  function deriveQueries(jobs) {
    const set = new Set();
    jobs.forEach((j) => (j.matchedQueries || []).forEach((q) => set.add(q)));
    return Array.from(set).sort();
  }

  return {
    listItemView,
    matchesSearch,
    searchJobs,
    filterJobs,
    sortJobs,
    countByStatus,
    deriveFamilies,
    deriveQueries,
    isPending,
    helpers: { overall, decision, status, isPending },
  };
});
