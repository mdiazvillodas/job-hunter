'use strict';

// Extractores que corren DENTRO de la pagina (page.evaluate). Cada funcion es
// AUTOCONTENIDA: no puede usar nada de fuera de su propio cuerpo.
//
// Estrategia para que sobrevivan a cambios de diseño de InfoJobs:
//  - Tarjetas: se parte de los LINKS a ofertas (/of-<id>), que son la parte mas
//    estable de la web, y se sube hasta el contenedor que solo contiene esa oferta.
//    Las clases CSS son un extra, no un requisito.
//  - Detalle: primero el JSON-LD JobPosting (datos estructurados que InfoJobs
//    publica para Google for Jobs); si falta, bloques de descripcion del DOM.

function extractSearchCardsDom() {
  const OFFER_RE = /\/of-([a-z0-9]{10,})(?:[/?#]|$)/i;
  const norm = (v) => {
    const s = (v || '').replace(/\s+/g, ' ').trim();
    return s || null;
  };
  const offerIdOf = (a) => {
    const m = (a.getAttribute('href') || '').match(OFFER_RE);
    return m ? m[1].toLowerCase() : null;
  };

  const anchors = Array.from(document.querySelectorAll('a[href]')).filter((a) => offerIdOf(a));
  const byId = new Map();
  for (const a of anchors) {
    const id = offerIdOf(a);
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(a);
  }

  // Sube mientras el ancestro siga conteniendo UNA sola oferta: ese es la tarjeta.
  const cardOf = (a) => {
    let card = a;
    for (let e = a.parentElement; e && e !== document.body; e = e.parentElement) {
      const ids = new Set(Array.from(e.querySelectorAll('a[href]')).map(offerIdOf).filter(Boolean));
      if (ids.size > 1) break;
      card = e;
    }
    return card;
  };

  const pickByClass = (card, patterns, exclude) => {
    for (const p of patterns) {
      for (const e of Array.from(card.querySelectorAll(p))) {
        const t = norm(e.innerText || e.textContent);
        if (t && !exclude.includes(t)) return t;
      }
    }
    return null;
  };

  const jobs = [];
  const diagnostics = [];
  for (const [id, links] of byId) {
    const card = cardOf(links[0]);
    const lines = (card.innerText || '').split('\n').map(norm).filter(Boolean);

    const headingLink = links.find((a) => a.closest('h1, h2, h3, h4'));
    const linkTexts = links.map((a) => norm(a.innerText || a.textContent)).filter(Boolean);
    const title = (headingLink && norm(headingLink.innerText))
      || linkTexts.sort((x, y) => y.length - x.length)[0]
      || null;

    const company = pickByClass(card, ['[class*="company" i]', '[class*="subtitle" i]', 'a[href*="/empresa" i]'], [title])
      || (() => {
        const i = lines.indexOf(title);
        return i >= 0 && lines[i + 1] ? lines[i + 1] : null;
      })();

    const location = pickByClass(card, ['[class*="location" i]', '[class*="city" i]', '[class*="province" i]'], [title, company])
      || (() => {
        const i = company ? lines.indexOf(company) : -1;
        return i >= 0 && lines[i + 1] ? lines[i + 1] : null;
      })();

    const text = lines.join(' | ');
    const href = (headingLink || links[0]).href;
    const reasons = [];
    if (!title) reasons.push('missing_title');
    if (!company) reasons.push('missing_company');
    if (!location) reasons.push('missing_location');
    if (reasons.length) diagnostics.push({ offerId: id, reasons, textPreview: text.slice(0, 240) });

    jobs.push({
      offerId: id,
      href,
      title,
      company,
      location,
      // Jornada parcial explicita en la tarjeta: no es "jornada completa".
      partTime: /jornada parcial|media jornada|part[- ]time/i.test(text),
      text: text.slice(0, 600),
    });
  }

  return { jobs, diagnostics, linkCount: anchors.length };
}

function extractOfferDetailDom() {
  const norm = (v) => {
    const s = (v || '').replace(/[ \t ]+/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    return s || null;
  };
  // DOMParser: el HTML del JSON-LD no ejecuta scripts ni handlers ni carga imagenes.
  const htmlToText = (html) => {
    if (!html) return null;
    const doc = new DOMParser().parseFromString(String(html), 'text/html');
    doc.querySelectorAll('br').forEach((b) => b.replaceWith('\n'));
    doc.querySelectorAll('p, li, div, h1, h2, h3, h4, ul, ol').forEach((e) => e.append('\n'));
    doc.querySelectorAll('li').forEach((e) => e.prepend('- '));
    return norm(doc.body ? doc.body.textContent : '');
  };
  const isType = (node, type) => {
    const t = node && node['@type'];
    return Array.isArray(t) ? t.includes(type) : t === type;
  };

  let posting = null;
  for (const s of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
    let data;
    try { data = JSON.parse(s.textContent); } catch (e) { continue; }
    const items = Array.isArray(data) ? data : (data && Array.isArray(data['@graph']) ? data['@graph'] : [data]);
    posting = items.find((x) => isType(x, 'JobPosting')) || null;
    if (posting) break;
  }

  const result = {
    method: null,
    description: null,
    title: null,
    company: null,
    location: null,
    employmentType: null,
    salary: null,
    datePosted: null,
    expired: false,
  };

  if (posting) {
    result.method = 'json_ld';
    result.description = htmlToText(posting.description);
    result.title = norm(posting.title);
    const org = posting.hiringOrganization;
    result.company = norm(org && (typeof org === 'string' ? org : org.name));
    const locs = Array.isArray(posting.jobLocation) ? posting.jobLocation : (posting.jobLocation ? [posting.jobLocation] : []);
    const addr = locs[0] && locs[0].address;
    if (addr) result.location = norm([addr.addressLocality, addr.addressRegion].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(', '));
    const et = Array.isArray(posting.employmentType) ? posting.employmentType[0] : posting.employmentType;
    const ET = { FULL_TIME: 'Full-time', PART_TIME: 'Part-time', CONTRACTOR: 'Contract', TEMPORARY: 'Temporary', INTERN: 'Internship' };
    result.employmentType = et ? (ET[String(et).toUpperCase()] || String(et)) : null;
    const bs = posting.baseSalary;
    const v = bs && bs.value;
    if (v && (v.minValue || v.maxValue || v.value)) {
      const fmt = (n) => Number(n).toLocaleString('es-ES');
      const range = v.minValue && v.maxValue ? `${fmt(v.minValue)} - ${fmt(v.maxValue)}` : fmt(v.minValue || v.maxValue || v.value);
      const unit = { YEAR: 'año', MONTH: 'mes', HOUR: 'hora', DAY: 'día', WEEK: 'semana' }[String(v.unitText || '').toUpperCase()];
      result.salary = `${range} ${bs.currency || ''}${unit ? ' / ' + unit : ''}`.replace(/\s+/g, ' ').trim();
    }
    result.datePosted = posting.datePosted || null;
  }

  // Fallback / complemento desde el DOM.
  if (!result.description) {
    const selectors = ['#prefijoDescripcion1', '[class*="offer-description" i]', '[class*="OfferDescription"]', '[class*="description" i]', '[itemprop="description"]'];
    let best = null;
    for (const sel of selectors) {
      for (const e of Array.from(document.querySelectorAll(sel))) {
        if (!e.getClientRects().length) continue;
        const t = norm(e.innerText);
        if (t && (!best || t.length > best.length)) best = t;
      }
    }
    if (best) {
      result.description = best;
      result.method = result.method ? result.method + '+dom' : 'dom';
    }
  }
  if (!result.title) result.title = norm(document.querySelector('h1') && document.querySelector('h1').innerText);

  const bodyText = (document.body && document.body.innerText) || '';
  result.expired = /esta oferta (?:ya )?no est[aá] disponible|oferta (?:ha )?caducad[ao]|ya no acepta inscripciones|proceso de selecci[oó]n (?:ha )?finalizado/i.test(bodyText.slice(0, 4000));
  if (!result.salary) {
    const m = bodyText.match(/Salario\s*:?\s*\n?\s*([^\n]{3,80})/i);
    if (m && /\d/.test(m[1])) result.salary = norm(m[1]);
  }
  const exp = bodyText.match(/Experiencia m[ií]nima\s*:?\s*\n?\s*([^\n]{2,60})/i);
  result.experienceMin = exp ? norm(exp[1]) : null;
  return result;
}

module.exports = {
  extractSearchCardsDom,
  extractOfferDetailDom,
};
