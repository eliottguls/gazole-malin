import assert from 'node:assert/strict';
import { haversineKm, fillCost, rankStations, breakEvenKm } from '../cost.js';

// Rennes -> Nantes ≈ 98 km à vol d'oiseau
const d = haversineKm({ lat: 48.1173, lon: -1.6778 }, { lat: 47.2184, lon: -1.5536 });
assert.ok(d > 95 && d < 102, `haversine ${d}`);

// 40 L à 1,70 €, station à 10 km, 5,8 L/100 : trajet = 1,16 L → 1,972 €
const c = fillCost({ price: 1.7, oneWayKm: 10, liters: 40, consumption: 5.8 });
assert.equal(c.fill.toFixed(2), '68.00');
assert.equal(c.tripLiters.toFixed(2), '1.16');
assert.equal(c.total.toFixed(3), '69.972');

// La moins chère au litre mais loin perd face à une proche un peu plus chère
const ranked = rankStations(
  [
    { id: 'proche', price: 1.75, oneWayKm: 1 },
    { id: 'loin-pas-cher', price: 1.7, oneWayKm: 25 },
    { id: 'moyen', price: 1.72, oneWayKm: 4 },
  ],
  { liters: 40, consumption: 5.8 },
);
assert.deepEqual(ranked.map((s) => s.id), ['moyen', 'proche', 'loin-pas-cher']);
assert.ok(ranked.find((s) => s.id === 'proche').isNearest);
assert.ok(ranked[0].savingVsNearest > 0);

// 5 cts/L d'écart sur 40 L = 2 € → rentable jusqu'à ~10 km aller
const be = breakEvenKm({ deltaPrice: 0.05, price: 1.7, liters: 40, consumption: 5.8 });
assert.ok(be > 10 && be < 10.3, `breakEven ${be}`);

console.log('cost tests OK');
