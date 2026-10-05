'use strict';

// Provincias del filtro de busqueda de InfoJobs (parametro provinceIds).
//
// Los ids NO son un orden alfabetico deducible: salen del propio filtro
// "Provincia" de la web (capturado con `npm run recon:infojobs`, octubre 2026).
// Solo se listan ids verificados; uno inventado filtraria por otra provincia
// sin que nadie lo note. Sin provincia, InfoJobs busca en toda España.
//
// Modulo PURO.

const PROVINCES = Object.freeze([
  { id: '28', name: 'A Coruña', aliases: ['a coruña', 'a coruna', 'la coruña', 'coruña', 'coruna'] },
  { id: '4', name: 'Alicante/Alacant', aliases: ['alicante', 'alacant'] },
  { id: '5', name: 'Almería', aliases: ['almería', 'almeria'] },
  { id: '9', name: 'Barcelona', aliases: ['barcelona'] },
  { id: '17', name: 'Córdoba', aliases: ['córdoba', 'cordoba'] },
  { id: '19', name: 'Girona', aliases: ['girona', 'gerona'] },
  { id: '21', name: 'Granada', aliases: ['granada'] },
  { id: '23', name: 'Guipúzcoa/Gipuzkoa', aliases: ['guipúzcoa', 'guipuzcoa', 'gipuzkoa', 'san sebastián', 'san sebastian', 'donostia'] },
  { id: '26', name: 'Islas Baleares/Illes Balears', aliases: ['islas baleares', 'illes balears', 'baleares', 'mallorca', 'palma'] },
  { id: '29', name: 'La Rioja', aliases: ['la rioja', 'logroño', 'logrono'] },
  { id: '20', name: 'Las Palmas', aliases: ['las palmas', 'gran canaria'] },
  { id: '30', name: 'León', aliases: ['león', 'leon'] },
  { id: '31', name: 'Lleida', aliases: ['lleida', 'lérida', 'lerida'] },
  { id: '33', name: 'Madrid', aliases: ['madrid'] },
  { id: '34', name: 'Málaga', aliases: ['málaga', 'malaga'] },
  { id: '36', name: 'Murcia', aliases: ['murcia'] },
  { id: '37', name: 'Navarra', aliases: ['navarra', 'pamplona'] },
  { id: '43', name: 'Sevilla', aliases: ['sevilla'] },
  { id: '45', name: 'Tarragona', aliases: ['tarragona'] },
  { id: '49', name: 'Valencia/València', aliases: ['valencia', 'valència'] },
  { id: '50', name: 'Valladolid', aliases: ['valladolid'] },
  { id: '51', name: 'Vizcaya/Bizkaia', aliases: ['vizcaya', 'bizkaia', 'bilbao'] },
]);

const BY_ID = new Map(PROVINCES.map((p) => [p.id, p]));

function isKnownProvinceId(id) {
  return BY_ID.has(String(id));
}

function provinceById(id) {
  return BY_ID.get(String(id)) || null;
}

// "Barcelona, Cataluña, España" -> Barcelona. Compara el primer tramo de la
// ubicacion (antes de la coma) y despues la ubicacion completa. null si no hay
// una provincia verificada que coincida.
function provinceForLocation(location) {
  const text = String(location || '').trim().toLowerCase();
  if (!text) return null;
  const head = text.split(',')[0].trim();
  for (const candidate of [head, text]) {
    const hit = PROVINCES.find((p) => p.aliases.includes(candidate));
    if (hit) return hit;
  }
  return null;
}

// Provincia efectiva de la busqueda en InfoJobs a partir de lo guardado:
//   null / ausente -> automatica: la de la ubicacion principal, si es una conocida;
//   'all'          -> toda España (sin filtro);
//   '<id>'         -> esa provincia.
// Devuelve { mode, provinceId, name }; provinceId null = sin filtro de provincia.
function resolveInfoJobsProvince(setting, locations = []) {
  if (setting === 'all') return { mode: 'all', provinceId: null, name: null };
  if (setting != null && setting !== '') {
    const chosen = provinceById(setting);
    // Un id que ya no esta verificado no se usa a ciegas: se busca en toda España.
    return chosen ? { mode: 'manual', provinceId: chosen.id, name: chosen.name } : { mode: 'all', provinceId: null, name: null };
  }
  const primary = Array.isArray(locations) ? locations[0] : null;
  const auto = provinceForLocation(primary);
  return auto ? { mode: 'auto', provinceId: auto.id, name: auto.name } : { mode: 'auto', provinceId: null, name: null };
}

module.exports = { PROVINCES, isKnownProvinceId, provinceById, provinceForLocation, resolveInfoJobsProvince };
