// Calcul de rentabilité : fonctions pures, testables avec `node test/cost.test.mjs`.

const R = 6371; // rayon terrestre en km

/** Distance à vol d'oiseau entre deux points {lat, lon}, en km. */
export function haversineKm(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Facteur moyen route / vol d'oiseau, utilisé tant qu'on n'a pas la vraie distance routière. */
export const ROAD_FACTOR = 1.3;

/**
 * Coût total d'un plein dans une station :
 *   plein   = prix × litres
 *   trajet  = prix × conso/100 × km supplémentaires
 * km supplémentaires = aller-retour (mode autour de moi) ou détour (mode trajet).
 * Le carburant brûlé pour y aller est valorisé au prix de la station
 * (c'est lui qu'on remet dans le réservoir).
 */
export function fillCost({ price, extraKm, liters, consumption }) {
  const tripLiters = (consumption / 100) * extraKm;
  const fill = price * liters;
  const trip = price * tripLiters;
  return { fill, trip, total: fill + trip, tripLiters };
}

/** Km supplémentaires pour une station : `extraKm` (détour) sinon aller-retour 2 × `oneWayKm`. */
export const extraKmOf = (s) => s.extraKm ?? s.oneWayKm * 2;

/**
 * Classe les stations par coût total croissant.
 * Chaque station doit avoir `price` et `extraKm` (ou `oneWayKm`).
 * Ajoute `cost` et `savingVsNearest` (positif = moins cher que la plus proche / le plus petit détour).
 */
export function rankStations(stations, { liters, consumption }) {
  if (!stations.length) return [];
  const withCost = stations.map((s) => ({
    ...s,
    cost: fillCost({ price: s.price, extraKm: extraKmOf(s), liters, consumption }),
  }));
  const nearest = withCost.reduce((a, b) => (extraKmOf(b) < extraKmOf(a) ? b : a));
  return withCost
    .map((s) => ({ ...s, savingVsNearest: nearest.cost.total - s.cost.total, isNearest: s === nearest }))
    .sort((a, b) => a.cost.total - b.cost.total);
}

/**
 * Distance maximale (aller simple) qu'il vaut la peine de parcourir pour gagner
 * `deltaPrice` €/L par rapport à une station à 0 km : au-delà, le trajet coûte plus que l'économie.
 */
export function breakEvenKm({ deltaPrice, price, liters, consumption }) {
  if (deltaPrice <= 0) return 0;
  return (deltaPrice * liters) / (2 * price * (consumption / 100));
}

/**
 * Distance (km) d'un point au tracé `line` ([[lon, lat], ...]), en projection locale.
 * Suffisant pour quelques km de précision sur un trajet en France.
 */
export function distanceToLineKm(p, line) {
  const kx = 111.32 * Math.cos((p.lat * Math.PI) / 180);
  const ky = 110.57;
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const ax = (line[i - 1][0] - p.lon) * kx, ay = (line[i - 1][1] - p.lat) * ky;
    const bx = (line[i][0] - p.lon) * kx, by = (line[i][1] - p.lat) * ky;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    const d = Math.hypot(ax + t * dx, ay + t * dy);
    if (d < best) best = d;
  }
  return best;
}
