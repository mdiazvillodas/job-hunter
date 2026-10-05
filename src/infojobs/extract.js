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

    const workplace = lines.find((l) => /^(?:solo teletrabajo|teletrabajo|h[ií]brido|presencial)$/i.test(l)) || null;
    jobs.push({
      offerId: id,
      href,
      title,
      company,
      location,
      workplaceType: workplace,
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
    workplaceType: null,
    contractType: null,
    experienceMin: null,
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

  // DOM de la oferta (estructura real, verificada con `npm run recon:infojobs`):
  //   cabecera: .ij-OfferDetailHeader-companyLogo-companyName a  -> empresa
  //             .ij-OfferDetailHeader-detailsList-item           -> ubicacion, modalidad,
  //                                                                 salario, experiencia, contrato
  //   cuerpo:   <article><h3>Requisitos</h3><dl><dt/><dd/>...</dl></article>
  //             <article><h3>Descripción</h3>...</article>
  // La descripcion que se guarda = Descripcion + Requisitos (estudios, idiomas,
  // conocimientos): el analizador necesita ambos para evaluar el encaje.
  const textOf = (e) => norm(e && (e.innerText || e.textContent));
  const companyEl = document.querySelector('.ij-OfferDetailHeader-companyLogo-companyName a, [class*="OfferDetailHeader-companyLogo-companyName"] a');
  if (!result.company) result.company = textOf(companyEl);

  const headerItems = Array.from(document.querySelectorAll('.ij-OfferDetailHeader-detailsList-item, [class*="OfferDetailHeader-detailsList-item"]'))
    .map(textOf).filter(Boolean);
  for (const item of headerItems) {
    const exp = item.match(/^Experiencia m[ií]nima\s*:?\s*(.+)$/i);
    if (exp) { result.experienceMin = exp[1]; continue; }
    if (/^(?:solo teletrabajo|teletrabajo|h[ií]brido|presencial)/i.test(item)) { result.workplaceType = result.workplaceType || item; continue; }
    if (/salario|€|eur\b|bruto|neto/i.test(item)) {
      if (!/no disponible/i.test(item) && !result.salary) result.salary = item;
      continue;
    }
    if (/contrato|jornada/i.test(item)) {
      result.contractType = item;
      if (!result.employmentType) {
        if (/jornada completa/i.test(item)) result.employmentType = 'Full-time';
        else if (/jornada parcial|media jornada/i.test(item)) result.employmentType = 'Part-time';
      }
      continue;
    }
    // "Barcelona (Barcelona)" = ciudad (provincia); si coinciden, una sola vez.
    if (!result.location) result.location = item.replace(/^(.+?)\s*\(\s*\1\s*\)$/i, '$1');
  }

  const sectionByHeading = (re) => {
    const h = Array.from(document.querySelectorAll('h2, h3')).find((x) => re.test(textOf(x) || ''));
    return h ? (h.closest('article, section') || h.parentElement) : null;
  };
  const descSection = sectionByHeading(/^Descripci[oó]n(?: de la oferta)?$/i);
  const descText = descSection ? norm((descSection.innerText || '').replace(/^\s*Descripci[oó]n(?: de la oferta)?\s*/i, '')) : null;
  const reqSection = sectionByHeading(/^Requisitos$/i);
  let reqText = null;
  if (reqSection) {
    const lines = [];
    for (const dt of Array.from(reqSection.querySelectorAll('dt'))) {
      const dd = dt.nextElementSibling;
      if (!dd || dd.tagName !== 'DD') continue;
      const tags = Array.from(dd.querySelectorAll('.sui-AtomTag-label, [class*="Tag-label"]')).map(textOf).filter(Boolean);
      const value = tags.length ? tags.join(', ') : textOf(dd);
      if (value) lines.push(`${textOf(dt)}: ${value}`);
    }
    reqText = lines.length ? lines.join('\n') : norm((reqSection.innerText || '').replace(/^\s*Requisitos\s*/i, ''));
  }
  if (!result.description && (descText || reqText)) {
    result.description = [descText, reqText ? 'Requisitos:\n' + reqText : null].filter(Boolean).join('\n\n');
    result.method = result.method ? result.method + '+dom' : 'dom';
  }

  // Ultimo recurso: bloque de descripcion por id/clase conocida.
  if (!result.description) {
    let best = null;
    for (const e of Array.from(document.querySelectorAll('#prefijoDescripcion1, [class*="OfferDetailPage-mainContent"]'))) {
      if (!e.getClientRects().length) continue;
      const t = textOf(e);
      if (t && (!best || t.length > best.length)) best = t;
    }
    if (best) {
      result.description = best;
      result.method = result.method ? result.method + '+dom_block' : 'dom_block';
    }
  }
  if (!result.title) result.title = textOf(document.querySelector('h1'));

  const bodyText = (document.body && document.body.innerText) || '';
  result.expired = /esta oferta (?:ya )?no est[aá] disponible|oferta (?:ha )?caducad[ao]|ya no acepta inscripciones|proceso de selecci[oó]n (?:ha )?finalizado/i.test(bodyText.slice(0, 4000));
  return result;
}

module.exports = {
  extractSearchCardsDom,
  extractOfferDetailDom,
};
