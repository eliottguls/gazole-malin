// Accès aux données : prix des carburants, géocodage, itinéraires.
import { haversineKm } from './cost.js?v=__V__';

const PRICES_API =
  'https://data.economie.gouv.fr/api/explore/v2.1/catalog/datasets/prix-des-carburants-en-france-flux-instantane-v2';
const FALLBACK_URL = 'data/stations.json'; // généré par la GitHub Action (toutes les heures)
const OSRM = 'https://router.project-osrm.org';
const MAX_AGE_DAYS = 8; // on ignore les prix plus vieux que ça
const MAX_OUT_DAYS = 30; // ruptures plus anciennes = la station ne vend plus ce carburant

export const FUELS = {
  gazole: 'Gazole',
  e10: 'SP95-E10',
  sp95: 'SP95',
  sp98: 'SP98',
  e85: 'E85',
  gplc: 'GPLc',
};

const daysSince = (iso) => (Date.now() - new Date(iso).getTime()) / 86400000;

function normalize(r, fuel) {
  const lat = r.geom?.lat ?? (r.latitude ? Number(r.latitude) / 100000 : null);
  const lon = r.geom?.lon ?? (r.longitude ? Number(r.longitude) / 100000 : null);
  const outSince = r[`${fuel}_rupture_type`] === 'temporaire' ? r[`${fuel}_rupture_debut`] : null;
  return {
    id: String(r.id),
    adresse: r.adresse ?? '',
    ville: r.ville ?? '',
    cp: r.cp ?? '',
    lat,
    lon,
    price: r[`${fuel}_prix`] != null ? Number(r[`${fuel}_prix`]) : null,
    updatedAt: r[`${fuel}_maj`] ?? null,
    outSince,
  };
}

function split(raw, fuel) {
  const all = raw.map((r) => normalize(r, fuel)).filter((s) => s.lat != null && s.lon != null);
  const stations = all.filter((s) => !s.outSince && s.price > 0 && (!s.updatedAt || daysSince(s.updatedAt) <= MAX_AGE_DAYS));
  const unavailable = all.filter((s) => s.outSince && daysSince(s.outSince) <= MAX_OUT_DAYS);
  return { stations, unavailable };
}

/** Export complet (sans pagination) des stations qui correspondent à `zone`. */
async function fetchLive(zone, fuel) {
  const where = `${zone} and (${fuel}_prix is not null or ${fuel}_rupture_type = "temporaire")`;
  const select = `id,adresse,ville,cp,geom,${fuel}_prix,${fuel}_maj,${fuel}_rupture_debut,${fuel}_rupture_type`;
  const res = await fetch(`${PRICES_API}/exports/json?${new URLSearchParams({ where, select })}`);
  if (!res.ok) throw new Error(`API prix : HTTP ${res.status}`);
  return res.json();
}

let fallbackCache;
async function fetchFallback(keep) {
  fallbackCache ??= fetch(FALLBACK_URL, { cache: 'no-cache' }).then((res) => {
    if (!res.ok) throw new Error(`Fichier de secours : HTTP ${res.status}`);
    return res.json();
  });
  const all = await fallbackCache;
  return all.filter((r) => r.geom?.lat != null && keep({ lat: r.geom.lat, lon: r.geom.lon }));
}

async function fetchZone(zone, keep, fuel) {
  try {
    return { ...split(await fetchLive(zone, fuel), fuel), source: 'live' };
  } catch (err) {
    console.warn('API temps réel indisponible, bascule sur le fichier de secours', err);
    fallbackCache = undefined;
    return { ...split(await fetchFallback(keep), fuel), source: 'fallback' };
  }
}

/** Stations dans un rayon autour de `center`. */
export function fetchStationsAround(center, radiusKm, fuel) {
  const zone = `within_distance(geom, geom'POINT(${center.lon} ${center.lat})', ${radiusKm}km)`;
  return fetchZone(zone, (p) => haversineKm(center, p) <= radiusKm, fuel);
}

/** Stations dans un rectangle {minLat, minLon, maxLat, maxLon} (le tri fin se fait ensuite). */
export function fetchStationsInBox(box, fuel) {
  const zone = `in_bbox(geom, ${box.minLat}, ${box.minLon}, ${box.maxLat}, ${box.maxLon})`;
  return fetchZone(zone, (p) => p.lat >= box.minLat && p.lat <= box.maxLat && p.lon >= box.minLon && p.lon <= box.maxLon, fuel);
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

async function osrm(path, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${OSRM}${path}`, { signal: ctrl.signal });
    if (!res.ok) return null;
    const json = await res.json();
    return json.code === 'Ok' ? json : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
const coord = (p) => `${p.lon.toFixed(5)},${p.lat.toFixed(5)}`;

/** Itinéraire A → B : { km, minutes, line: [[lon, lat], ...] } ou null. */
export async function fetchRoute(a, b) {
  const json = await osrm(`/route/v1/driving/${coord(a)};${coord(b)}?overview=full&geometries=geojson`, 15000);
  if (!json) return null;
  const r = json.routes[0];
  return { km: r.distance / 1000, minutes: r.duration / 60, line: r.geometry.coordinates };
}

/**
 * Distances routières (km) depuis `origin` vers chaque destination.
 * Tableau aligné sur `dests` (null si inconnu), ou null si le service ne répond pas.
 */
export async function roadDistancesKm(origin, dests) {
  if (!dests.length) return [];
  const coords = [origin, ...dests].map(coord).join(';');
  const json = await osrm(`/table/v1/driving/${coords}?sources=0&annotations=distance`);
  return json ? json.distances[0].slice(1).map((m) => (m == null ? null : m / 1000)) : null;
}

/**
 * Détour réel (km) pour passer par chaque station sur le trajet A → B :
 * (A → station) + (station → B) − (A → B). Tableau aligné sur `stations`, ou null.
 */
export async function detoursKm(a, b, directKm, stations) {
  if (!stations.length) return [];
  const coords = [a, b, ...stations].map(coord).join(';');
  const idx = stations.map((_, i) => i + 2).join(';');
  const json = await osrm(`/table/v1/driving/${coords}?sources=0;${idx}&destinations=1;${idx}&annotations=distance`);
  if (!json) return null;
  const d = json.distances; // lignes = [A, S1..Sn], colonnes = [B, S1..Sn]
  return stations.map((_, i) => {
    const aToS = d[0][i + 1];
    const sToB = d[i + 1][0];
    if (aToS == null || sToB == null) return null;
    return Math.max(0, (aToS + sToB) / 1000 - directKm);
  });
}
