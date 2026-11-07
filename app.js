import { haversineKm, rankStations, ROAD_FACTOR } from './cost.js';
import { FUELS, fetchStations, searchAddress, roadDistancesKm } from './data.js';

const DEFAULTS = { fuel: 'gazole', consumption: 5.8, liters: 40, radius: 15 };
const ROAD_CANDIDATES = 25; // nb de stations pour lesquelles on calcule la vraie distance routière
const LIST_SIZE = 30;
const STORE_KEY = 'gazole-malin:v1';

const $ = (id) => document.getElementById(id);
const euro = (n) => n.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });
const perLiter = (n) => `${n.toLocaleString('fr-FR', { minimumFractionDigits: 3, maximumFractionDigits: 3 })} €/L`;
const km = (n, estimated) => `${estimated ? '~' : ''}${n.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} km`;

// ---------- Réglages persistés sur l'appareil ----------
function loadStore() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) ?? {}; } catch { return {}; }
}
function saveStore(patch) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify({ ...loadStore(), ...patch })); } catch { /* navigation privée */ }
}

const store = loadStore();
const settings = { ...DEFAULTS, ...store.settings };
let origin = store.origin ?? null; // { lat, lon, label }

for (const [value, label] of Object.entries(FUELS)) {
  $('fuel').append(new Option(label, value, false, value === settings.fuel));
}
$('consumption').value = settings.consumption;
$('liters').value = settings.liters;
$('radius').value = settings.radius;
if (origin) $('address').value = origin.label;

function readSettings() {
  const num = (id, fallback) => {
    const v = parseFloat($(id).value.replace(',', '.'));
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  settings.fuel = $('fuel').value;
  settings.consumption = num('consumption', DEFAULTS.consumption);
  settings.liters = num('liters', DEFAULTS.liters);
  settings.radius = Math.min(50, num('radius', DEFAULTS.radius));
  saveStore({ settings });
}
$('settings').addEventListener('change', () => { readSettings(); if (origin) run(); });

// ---------- Autocomplétion d'adresse ----------
const input = $('address');
const sugList = $('suggestions');
let suggestions = [];
let active = -1;
let sugAbort;
let sugTimer;

function closeSuggestions() {
  sugList.hidden = true;
  input.setAttribute('aria-expanded', 'false');
  active = -1;
}
function renderSuggestions() {
  sugList.replaceChildren(...suggestions.map((s, i) => {
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    li.id = `sug-${i}`;
    li.textContent = s.label;
    li.setAttribute('aria-selected', String(i === active));
    li.addEventListener('mousedown', (e) => { e.preventDefault(); pick(i); });
    return li;
  }));
  sugList.hidden = suggestions.length === 0;
  input.setAttribute('aria-expanded', String(!sugList.hidden));
  if (active >= 0) input.setAttribute('aria-activedescendant', `sug-${active}`);
  else input.removeAttribute('aria-activedescendant');
}
function pick(i) {
  const s = suggestions[i];
  if (!s) return;
  origin = s;
  input.value = s.label;
  saveStore({ origin });
  closeSuggestions();
  run();
}

input.addEventListener('input', () => {
  origin = null;
  clearTimeout(sugTimer);
  const q = input.value.trim();
  if (q.length < 3) { suggestions = []; closeSuggestions(); return; }
  sugTimer = setTimeout(async () => {
    sugAbort?.abort();
    sugAbort = new AbortController();
    try {
      suggestions = await searchAddress(q, sugAbort.signal);
      active = -1;
      renderSuggestions();
    } catch { /* requête annulée */ }
  }, 250);
});
input.addEventListener('keydown', (e) => {
  if (sugList.hidden) return;
  if (e.key === 'ArrowDown') { active = (active + 1) % suggestions.length; renderSuggestions(); e.preventDefault(); }
  else if (e.key === 'ArrowUp') { active = (active - 1 + suggestions.length) % suggestions.length; renderSuggestions(); e.preventDefault(); }
  else if (e.key === 'Enter' && active >= 0) { pick(active); e.preventDefault(); }
  else if (e.key === 'Escape') closeSuggestions();
});
input.addEventListener('blur', () => setTimeout(closeSuggestions, 100));

$('search').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!origin) {
    const q = input.value.trim();
    if (!q) { setStatus('Tape une adresse ou utilise ta position.', true); input.focus(); return; }
    setStatus('Recherche de l’adresse…');
    const found = await searchAddress(q).catch(() => []);
    if (!found.length) { setStatus('Adresse introuvable. Essaie avec la ville ou le code postal.', true); return; }
    origin = found[0];
    input.value = origin.label;
    saveStore({ origin });
  }
  closeSuggestions();
  run();
});

// ---------- Position actuelle ----------
$('locate').addEventListener('click', () => {
  if (!navigator.geolocation) { setStatus('Ton navigateur ne donne pas accès à la position. Tape une adresse.', true); return; }
  setStatus('Localisation en cours…');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      origin = { lat: pos.coords.latitude, lon: pos.coords.longitude, label: 'Ma position' };
      input.value = origin.label;
      saveStore({ origin });
      run();
    },
    () => setStatus('Position refusée ou indisponible. Autorise la localisation, ou tape une adresse.', true),
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
  );
});

// ---------- Recherche et classement ----------
function setStatus(msg, isError = false) {
  $('status').textContent = msg;
  $('status').classList.toggle('error', isError);
}

let runId = 0;
async function run() {
  readSettings();
  const id = ++runId;
  const { fuel, consumption, liters, radius } = settings;
  $('go').disabled = true;
  setStatus(`Recherche des stations à moins de ${radius} km…`);
  try {
    const { stations, source } = await fetchStations(origin, radius, fuel);
    if (id !== runId) return;
    if (!stations.length) {
      $('results').hidden = true;
      setStatus(`Aucune station avec du ${FUELS[fuel]} à moins de ${radius} km. Augmente le rayon dans les réglages.`, true);
      return;
    }

    // 1) estimation à vol d'oiseau × facteur route
    for (const s of stations) {
      s.oneWayKm = haversineKm(origin, s) * ROAD_FACTOR;
      s.estimated = true;
    }
    let ranked = rankStations(stations, { liters, consumption });

    // 2) vraie distance routière pour les meilleures candidates + la plus proche
    setStatus('Calcul des distances par la route…');
    const candidates = ranked.slice(0, ROAD_CANDIDATES);
    const nearest = ranked.find((s) => s.isNearest);
    if (!candidates.includes(nearest)) candidates.push(nearest);
    const road = await roadDistancesKm(origin, candidates);
    if (id !== runId) return;
    if (road) {
      const byId = new Map(candidates.map((s, i) => [s.id, road[i]]));
      for (const s of stations) {
        const d = byId.get(s.id);
        if (d != null) { s.oneWayKm = d; s.estimated = false; }
      }
      ranked = rankStations(stations, { liters, consumption });
    }

    render(ranked, { source, roadOk: Boolean(road) });
    setStatus('');
  } catch (err) {
    console.error(err);
    if (id === runId) setStatus('Impossible de récupérer les prix pour le moment. Réessaie dans un instant.', true);
  } finally {
    if (id === runId) $('go').disabled = false;
  }
}

// ---------- Affichage ----------
const navLinks = (s) => `
  <a href="https://waze.com/ul?ll=${s.lat},${s.lon}&navigate=yes" target="_blank" rel="noopener">Waze</a>
  <a href="https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lon}" target="_blank" rel="noopener">Google Maps</a>`;
const esc = (str) => String(str).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const title = (s) => esc(s.adresse || 'Station');
const where = (s) => esc([s.cp, s.ville].filter(Boolean).join(' '));
const updated = (s) => s.updatedAt
  ? `maj ${new Date(s.updatedAt).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`
  : '';

function render(ranked, { source, roadOk }) {
  const best = ranked[0];
  const nearest = ranked.find((s) => s.isNearest);
  const { liters } = settings;

  const savingLine = best.isNearest
    ? 'C’est aussi la plus proche : pas besoin d’aller plus loin.'
    : `${euro(best.savingVsNearest)} d’économie par rapport à la plus proche (${title(nearest)}, ${perLiter(nearest.price)}, ${km(nearest.oneWayKm, nearest.estimated)})`;

  $('best').innerHTML = `
    <p class="eyebrow">La plus rentable</p>
    <h2>${title(best)}</h2>
    <div>${where(best)} · ${km(best.oneWayKm, best.estimated)} · ${perLiter(best.price)}</div>
    <p class="total">${euro(best.cost.total)}</p>
    <div class="meta">${liters} L : ${euro(best.cost.fill)} + trajet aller-retour : ${euro(best.cost.trip)}</div>
    <p class="saving">${savingLine}</p>
    <div class="links">${navLinks(best)}</div>`;

  $('list').replaceChildren(...ranked.slice(0, LIST_SIZE).map((s, i) => {
    const li = document.createElement('li');
    const delta = s.cost.total - best.cost.total;
    li.innerHTML = `
      <span class="name">${i + 1}. ${title(s)}${s.isNearest ? '<span class="tag">la plus proche</span>' : ''}</span>
      <span class="meta">${where(s)} · ${km(s.oneWayKm, s.estimated)} · ${perLiter(s.price)} · ${updated(s)}</span>
      <span class="cost"><strong>${euro(s.cost.total)}</strong>
        <span class="delta ${i === 0 ? 'good' : 'bad'}">${i === 0 ? 'meilleur' : `+${euro(delta)}`}</span></span>`;
    li.addEventListener('click', () => focusStation(s));
    return li;
  }));

  const notes = [
    `Coût total = ${liters} L + carburant brûlé pour l’aller-retour (${settings.consumption.toLocaleString('fr-FR')} L/100 km).`,
    roadOk ? 'Distances par la route pour les meilleures stations ; « ~ » = estimation à vol d’oiseau.' : 'Service de routage indisponible : distances estimées à vol d’oiseau × 1,3.',
    source === 'fallback' ? 'Prix issus de la copie horaire (API temps réel indisponible).' : 'Prix en temps réel.',
  ];
  $('footnote').textContent = notes.join(' ');

  $('results').hidden = false;
  drawMap(ranked.slice(0, LIST_SIZE), best);
}

let map;
let layer;
const markers = new Map();
function drawMap(stations, best) {
  if (!window.L) { $('map').hidden = true; return; } // Leaflet non chargé : on garde la liste
  if (!map) {
    map = L.map('map', { scrollWheelZoom: false });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '© OpenStreetMap',
    }).addTo(map);
    layer = L.layerGroup().addTo(map);
  }
  layer.clearLayers();
  markers.clear();
  const home = L.circleMarker([origin.lat, origin.lon], { radius: 8, color: '#2563eb', fillOpacity: 1 })
    .bindPopup(esc(origin.label)).addTo(layer);
  for (const s of stations) {
    const isBest = s === best;
    const m = L.circleMarker([s.lat, s.lon], {
      radius: isBest ? 10 : 6,
      color: isBest ? '#15803d' : '#6b7280',
      fillOpacity: isBest ? 0.9 : 0.5,
    }).bindPopup(`<strong>${title(s)}</strong><br>${perLiter(s.price)} · ${euro(s.cost.total)}<br>${navLinks(s)}`);
    m.addTo(layer);
    markers.set(s.id, m);
  }
  const bounds = L.featureGroup([home, ...markers.values()]).getBounds();
  map.fitBounds(bounds, { padding: [24, 24], maxZoom: 14 });
  setTimeout(() => map.invalidateSize(), 0);
}
function focusStation(s) {
  const m = markers.get(s.id);
  if (!m) return;
  $('map').scrollIntoView({ behavior: 'smooth', block: 'center' });
  map.setView(m.getLatLng(), 15);
  m.openPopup();
}

// Relance automatique avec la dernière adresse
if (origin && origin.label !== 'Ma position') run();
