// Accès aux données : prix des carburants, géocodage, distances routières.
import { haversineKm } from './cost.js';

const PRICES_API =
  'https://data.economie.gouv.fr/api/explore/v2.1/catalog/datasets/prix-des-carburants-en-france-flux-instantane-v2/records';
const FALLBACK_URL = 'data/stations.json'; // généré par la GitHub Action (toutes les heures)
const MAX_AGE_DAYS = 8; // on ignore les prix plus vieux que ça

export const FUELS = {
  gazole: 'Gazole',
  e10: 'SP95-E10',
  sp95: 'SP95',
  sp98: 'SP98',
  e85: 'E85',
  gplc: 'GPLc',
};

function normalize(r, fuel) {
  const lat = r.geom?.lat ?? (r.latitude ? Number(r.latitude) / 100000 : null);
  const lon = r.geom?.lon ?? (r.longitude ? Number(r.longitude) / 100000 : null);
  return {
    id: String(r.id),
    adresse: r.adresse ?? '',
    ville: r.ville ?? '',
    cp: r.cp ?? '',
    lat,
    lon,
    price: r[`${fuel}_prix`] != null ? Number(r[`${fuel}_prix`]) : null,
    updatedAt: r[`${fuel}_maj`] ?? null,
  };
}

function isUsable(s) {
  if (s.lat == null || s.lon == null || !(s.price > 0)) return false;
  if (!s.updatedAt) return true;
  const ageDays = (Date.now() - new Date(s.updatedAt).getTime()) / 86400000;
  return ageDays <= MAX_AGE_DAYS;
}

/** Stations dans un rayon, via l'API temps réel (pagination par 100). */
async function fetchLive(center, radiusKm, fuel) {
  const where = `within_distance(geom, geom'POINT(${center.lon} ${center.lat})', ${radiusKm}km) and ${fuel}_prix is not null`;
  const select = `id,adresse,ville,cp,geom,latitude,longitude,${fuel}_prix,${fuel}_maj`;
  const out = [];
  for (let offset = 0; offset < 2000; offset += 100) {
    const url = `${PRICES_API}?${new URLSearchParams({ where, select, limit: '100', offset: String(offset) })}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`API prix : HTTP ${res.status}`);
    const json = await res.json();
    out.push(...json.results);
    if (offset + 100 >= json.total_count) break;
  }
  return out;
}

/** Stations dans un rayon, via le fichier de secours publié avec le site. */
async function fetchFallback(center, radiusKm) {
  const res = await fetch(FALLBACK_URL, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Fichier de secours : HTTP ${res.status}`);
  const all = await res.json();
  return all.filter((r) => {
    const lat = r.geom?.lat;
    const lon = r.geom?.lon;
    return lat != null && haversineKm(center, { lat, lon }) <= radiusKm;
  });
}

/**
 * Renvoie { stations, source } où source vaut 'live' ou 'fallback'.
 */
export async function fetchStations(center, radiusKm, fuel) {
  let raw;
  let source = 'live';
  try {
    raw = await fetchLive(center, radiusKm, fuel);
  } catch (err) {
    console.warn('API temps réel indisponible, bascule sur le fichier de secours', err);
    raw = await fetchFallback(center, radiusKm);
    source = 'fallback';
  }
  const stations = raw.map((r) => normalize(r, fuel)).filter(isUsable);
  return { stations, source };
}

/** Suggestions d'adresses (Géoplateforme IGN, repli sur l'ancienne API Adresse). */
export async function searchAddress(q, signal) {
  const params = new URLSearchParams({ q, limit: '5' });
  const urls = [
    `https://data.geopf.fr/geocodage/search?${params}`,
    `https://api-adresse.data.gouv.fr/search/?${params}`,
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url, { signal });
      if (!res.ok) continue;
      const json = await res.json();
      return json.features.map((f) => ({
        label: f.properties.label,
        lon: f.geometry.coordinates[0],
        lat: f.geometry.coordinates[1],
      }));
    } catch (err) {
      if (err.name === 'AbortError') throw err;
    }
  }
  return [];
}

/**
 * Distances routières (km) depuis `origin` vers chaque destination, via le serveur public OSRM.
 * Renvoie un tableau aligné sur `dests` (null si inconnu), ou null si le service ne répond pas.
 */
export async function roadDistancesKm(origin, dests) {
  if (!dests.length) return [];
  const coords = [origin, ...dests].map((p) => `${p.lon.toFixed(5)},${p.lat.toFixed(5)}`).join(';');
  const url = `https://router.project-osrm.org/table/v1/driving/${coords}?sources=0&annotations=distance`;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const json = await res.json();
    if (json.code !== 'Ok') return null;
    return json.distances[0].slice(1).map((m) => (m == null ? null : m / 1000));
  } catch {
    return null;
  }
}
