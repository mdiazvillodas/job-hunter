'use strict';

const { isDescriptionUsable } = require('../domain/descriptionQuality');
const { detectSecurityChallenge } = require('./session');
const { AuthenticationError } = require('./errors');

// Funcion autocontenida: se ejecuta en el DOM tanto para inspeccionar como para esperar.
function inspectDescriptionDOM({ jobId, waitFor, beforeText, beforeHeight, pinnedRoot, control, resolveControl } = {}) {
  const visible = element => {
    if (!element || !element.getClientRects().length) return false;
    for (let e = element; e; e = e.parentElement) {
      const style = getComputedStyle(e);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0') return false;
    }
    return true;
  };
  const moreLabel = /^(?:(?:…|\.\.\.)\s*more|more|(?:(?:click|tap) to )?(?:see more|show more|ver m[aá]s|mostrar m[aá]s)(?:\s.*)?)$/i;
  const moreSuffix = /(?:…\s*more|\.\.\.\s*more|\bshow more|\bsee more|\bver m[aá]s|\bmostrar m[aá]s)\s*$/i;
  const clean = text => (text || '').replace(/\s+/g, ' ').trim()
    .replace(/^(About the job|Acerca del empleo|Sobre el empleo)\s*/i, '')
    .replace(/\s*(?:(?:…|\.\.\.)\s*more|see more|show more|see less|show less|ver m[aá]s|mostrar m[aá]s|ver menos|mostrar menos)\s*$/i, '').trim();
  const selectors = [
    '[id^="JobDetails_AboutTheJob_"]',
    '[data-sdui-component*="aboutTheJob"]',
    '.jobs-description__content',
    '.jobs-description-content__text',
    '.jobs-description .jobs-box__html-content',
    '#job-details',
    '.description__text .show-more-less-html__markup',
  ];
  const candidates = [];
  const seen = new Set();
  for (const selector of selectors) {
    Array.from(document.querySelectorAll(selector)).forEach((root, index) => {
      if (pinnedRoot && (!pinnedRoot.isConnected || !pinnedRoot.contains(root))) return;
      // No extraer el panel de otra oferta si LinkedIn conserva varios detalles.
      const identified = root.closest('[id^="JobDetails_AboutTheJob_"]');
      if (jobId && identified && identified.id !== `JobDetails_AboutTheJob_${jobId}`) return;
      const boxes = root.querySelectorAll('[data-testid="expandable-text-box"], .jobs-box__html-content, .show-more-less-html__markup');
      for (const box of boxes.length ? boxes : [root]) {
        if (seen.has(box)) continue;
        seen.add(box);
        const isVisible = visible(box);
        const text = isVisible ? clean(box.innerText) : '';
        candidates.push({ root, box, selector, index, visible: isVisible, text });
      }
    });
  }
  // Solo texto visible; entre candidatos del detalle, preferir el mas completo.
  const best = candidates.filter(c => c.visible && c.text).sort((a, b) => b.text.length - a.text.length)[0];
  const scope = pinnedRoot || (best && (best.root.closest('[id^="JobDetails_AboutTheJob_"], [data-sdui-component*="aboutTheJob"], .jobs-description__content, .jobs-description, .description__text') || best.root));
  let clipped = false;
  if (best) {
    for (let e = best.box; e && scope.contains(e); e = e.parentElement) {
      if (e.clientHeight > 0 && e.scrollHeight > e.clientHeight + 1 && /hidden|clip/.test(getComputedStyle(e).overflowY)) clipped = true;
      if (e === scope) break;
    }
  }
  const usableControl = button => {
    if (!scope || !scope.isConnected || !button.isConnected || !scope.contains(button) || !visible(button) || button.disabled || button.getAttribute('aria-disabled') === 'true' || button.getAttribute('aria-expanded') === 'true') return false;
    // Un enlace a otra pagina no es un control local de expansion.
    const href = button.getAttribute('href');
    if (href && !href.startsWith('#')) return false;
    const labels = [button.innerText, button.getAttribute('aria-label')].filter(Boolean);
    return labels.some(label => moreLabel.test(label.trim()));
  };
  const buttons = scope ? Array.from(scope.querySelectorAll('button, a, [role="button"]')).filter(usableControl) : [];
  if (resolveControl) return { root: scope, button: buttons[0] || null };
  if (waitFor === 'controlValid') return !!control && usableControl(control);
  if (waitFor === 'guardClick') {
    const guard = event => {
      if (!usableControl(control) || !control.contains(event.target)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    document.addEventListener('click', guard, true);
    return () => document.removeEventListener('click', guard, true);
  }
  const expansion = buttons.map(button => ({ text: (button.innerText || button.getAttribute('aria-label') || '').trim() }));
  const auth = /\/(?:login|signup|checkpoint|challenge|captcha)(?:\/|\?|$)/i.test(location.href)
    || Array.from(document.querySelectorAll('input[name="session_password"], #login-password')).some(visible);
  const unavailable = Array.from(document.querySelectorAll('.jobs-unavailable, .jobs-details-top-card__error, .artdeco-empty-state, [role="alert"]'))
    .some(e => visible(e) && /(?:job.*(?:no longer available|not available|not found)|empleo.*(?:no disponible|ya no)|oferta.*(?:no disponible|ya no))/i.test(e.innerText || ''));
  const state = {
    description: best ? best.text : null,
    selectedSelector: best ? best.selector : null,
    candidateCount: candidates.length,
    visibleCandidateCount: candidates.filter(c => c.visible).length,
    contentHeight: best ? best.box.getBoundingClientRect().height : 0,
    clipped,
    hasMoreSuffix: !!best && moreSuffix.test(best.box.innerText.trim()),
    expansion,
    auth,
    unavailable,
  };
  if (waitFor === 'content') return state.description || auth || unavailable ? state : false;
  if (waitFor === 'expansionControl') return auth || unavailable || expansion.length || !clipped ? state : false;
  if (waitFor === 'textChange') return auth || unavailable || (state.description && state.description !== beforeText) ? state : false;
  if (waitFor === 'expansion') {
    const controlExpanded = control && scope && scope.contains(control) && control.getAttribute('aria-expanded') === 'true';
    const controlGone = control && (!control.isConnected || !visible(control));
    const controlShowsLess = control && scope.contains(control) && [control.innerText, control.getAttribute('aria-label')]
      .some(label => /^(?:show less|see less|ver menos|mostrar menos)$/i.test((label || '').trim()));
    // Una raiz reemplazada/navegacion no cuenta como desaparicion exitosa.
    return !auth && !unavailable && best && scope.isConnected && state.description &&
      (state.description.length > beforeText.length || state.contentHeight > beforeHeight || controlExpanded || controlGone || controlShowsLess) ? state : false;
  }
  return state;
}

async function checkDetailAccess(page, state) {
  await detectSecurityChallenge(page);
  if (state.auth) throw new AuthenticationError('LinkedIn requiere autenticacion para acceder al detalle.');
}

async function readJobDescription(page, jobId, { detailTimeoutMs = 30000, expansionTimeoutMs = 5000, shortTextWaitMs = 1500 } = {}) {
  let timedOut = false;
  let state;
  try {
    try {
      const ready = await page.waitForFunction(inspectDescriptionDOM, { jobId, waitFor: 'content' }, { timeout: detailTimeoutMs });
      state = await ready.jsonValue();
      await ready.dispose();
    } catch (error) {
      if (error.name !== 'TimeoutError') throw error;
      timedOut = true;
      state = await page.evaluate(inspectDescriptionDOM, { jobId });
    }
    await checkDetailAccess(page, state);
    if (state.clipped && !state.expansion.length) {
      // En SDUI el boton puede hidratarse despues del texto ya recortado.
      try {
        const control = await page.waitForFunction(inspectDescriptionDOM, { jobId, waitFor: 'expansionControl' }, { timeout: expansionTimeoutMs });
        await control.dispose();
      } catch (error) { if (error.name !== 'TimeoutError') throw error; }
      state = await page.evaluate(inspectDescriptionDOM, { jobId });
      await checkDetailAccess(page, state);
    }
    // Un texto inicial corto puede ser una carga parcial. Esperar un cambio acotado
    // antes de clasificarlo; no depender de networkidle ni ampliar el timeout global.
    if (state.description && !isDescriptionUsable(state.description) && !state.expansion.length) {
      try {
        const updated = await page.waitForFunction(inspectDescriptionDOM, {
          jobId, waitFor: 'textChange', beforeText: state.description,
        }, { timeout: Math.min(shortTextWaitMs, detailTimeoutMs) });
        await updated.dispose();
      } catch (error) { if (error.name !== 'TimeoutError') throw error; }
      state = await page.evaluate(inspectDescriptionDOM, { jobId });
      await checkDetailAccess(page, state);
    }
    const expansion = { found: state.expansion.length > 0, attempted: false, clicked: false, confirmed: false, text: null };
    const hadMoreSuffix = state.hasMoreSuffix;
    // Retener los nodos reales: una mutacion global nunca cambia el destino del click.
    const resolved = await page.evaluateHandle(inspectDescriptionDOM, { jobId, resolveControl: true });
    const root = await resolved.getProperty('root');
    const control = await resolved.getProperty('button');
    const button = control.asElement();
    let guard;
    try {
      if (button) {
        expansion.found = true;
        expansion.attempted = true;
        const before = await page.evaluate(inspectDescriptionDOM, { jobId, pinnedRoot: root });
        expansion.text = before.expansion[0]?.text || null;
        try {
          await button.click({ trial: true, timeout: Math.min(expansionTimeoutMs, 1500) });
          const valid = await page.evaluate(inspectDescriptionDOM, { jobId, pinnedRoot: root, control, waitFor: 'controlValid' });
          if (valid) {
            guard = await page.evaluateHandle(inspectDescriptionDOM, { jobId, pinnedRoot: root, control, waitFor: 'guardClick' });
            await button.click({ timeout: expansionTimeoutMs });
            expansion.clicked = true;
            const expanded = await page.waitForFunction(inspectDescriptionDOM, {
              jobId, pinnedRoot: root, control, waitFor: 'expansion',
              beforeText: before.description || '', beforeHeight: before.contentHeight,
            }, { timeout: expansionTimeoutMs });
            await expanded.dispose();
            expansion.confirmed = true;
          }
        } catch (error) {
          if (error.name !== 'TimeoutError' && !/not attached|detached/i.test(error.message)) throw error;
        }
      }
      state = await page.evaluate(inspectDescriptionDOM, { jobId, ...(button ? { pinnedRoot: root } : {}) });
    } finally {
      if (guard) {
        try { await guard.evaluate(remove => remove()); } finally { await guard.dispose(); }
      }
      await control.dispose();
      await root.dispose();
      await resolved.dispose();
    }
    await checkDetailAccess(page, state);
    const description = state.unavailable ? null : state.description;
    const descriptionCompleteness = !description || state.clipped || state.hasMoreSuffix || state.expansion.length ||
      (!expansion.confirmed && (hadMoreSuffix || expansion.found)) ? 'unconfirmed' : 'full';
    const completenessStatus = expansion.attempted && !expansion.confirmed ? 'description_expansion_failed'
      : descriptionCompleteness === 'full' ? 'description_full' : 'description_unexpanded';
    const status = isDescriptionUsable(description) ? 'description_extracted'
      : description ? 'description_too_short'
        : state.unavailable ? 'description_not_found'
          : timedOut ? 'detail_load_timeout' : 'description_not_found';
    return {
      description,
      diagnostics: {
        status, jobId, url: page.url(), fetchedAt: new Date().toISOString(),
        descriptionLength: description ? description.length : 0,
        selectedSelector: state.selectedSelector,
        candidateCount: state.candidateCount, visibleCandidateCount: state.visibleCandidateCount,
        expansion, descriptionCompleteness, completenessStatus,
        expansionSuffixDetected: hadMoreSuffix || state.hasMoreSuffix,
        unavailable: state.unavailable,
        clippedAfterExpansion: state.clipped,
        errors: [...new Set([
          ...(status === 'description_extracted' ? [] : [status, ...(!description ? ['description_not_found'] : [])]),
          ...(expansion.found && !expansion.confirmed ? ['description_expansion_unconfirmed'] : []),
          ...(state.clipped ? ['description_content_clipped'] : []),
        ])],
      },
    };
  } catch (error) {
    if (['AuthenticationError', 'SecurityChallengeError'].includes(error.name)) {
      error.detailDiagnostics = { status: 'auth_or_challenge', jobId, url: page.url(), fetchedAt: new Date().toISOString(), error: error.message };
    }
    throw error;
  }
}

module.exports = { readJobDescription, inspectDescriptionDOM };
