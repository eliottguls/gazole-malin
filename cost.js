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
 *   trajet  = prix × conso/100 × distance aller-retour
 * Le carburant brûlé pour l'aller-retour est valorisé au prix de la station
 * (c'est lui qu'on remet dans le réservoir).
 */
export function fillCost({ price, oneWayKm, liters, consumption }) {
  const tripLiters = (consumption / 100) * oneWayKm * 2;
  const fill = price * liters;
  const trip = price * tripLiters;
  return { fill, trip, total: fill + trip, tripLiters };
}

/**
 * Classe les stations par coût total croissant.
 * Chaque station doit avoir `price` et `oneWayKm`.
 * Ajoute `cost` et `savingVsNearest` (positif = moins cher que la plus proche).
 */
export function rankStations(stations, { liters, consumption }) {
  if (!stations.length) return [];
  const withCost = stations.map((s) => ({
    ...s,
    cost: fillCost({ price: s.price, oneWayKm: s.oneWayKm, liters, consumption }),
  }));
  const nearest = withCost.reduce((a, b) => (b.oneWayKm < a.oneWayKm ? b : a));
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
