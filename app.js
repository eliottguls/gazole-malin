import { haversineKm, rankStations, extraKmOf, distanceToLineKm, ROAD_FACTOR } from './cost.js?v=__V__';
import {
  FUELS, fetchStationsAround, fetchStationsInBox, searchAddress, roadDistancesKm, fetchRoute, detoursKm,
} from './data.js?v=__V__';

const DEFAULTS = { mode: 'around', fuel: 'gazole', consumption: 5.8, liters: 40, radius: 15, corridor: 5 };
const ROAD_CANDIDATES = 25; // nb de stations pour lesquelles on calcule la vraie distance routière
const LIST_SIZE = 30;
const LIST_COLLAPSED = 10; // lignes visibles avant « voir plus »
const LABELLED_PINS = 10; // nb de marqueurs numérotés sur la carte
const STORE_KEY = 'gazole-malin:v1';

const $ = (id) => document.getElementById(id);
const fr = (n, opts) => n.toLocaleString('fr-FR', opts);
const euro = (n) => fr(n, { style: 'currency', currency: 'EUR' });
const perLiter = (n) => `${fr(n, { minimumFractionDigits: 3, maximumFractionDigits: 3 })} €/L`;
const priceShort = (n) => fr(n, { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const km = (n, estimated) => `${estimated ? '~' : ''}${fr(n, { maximumFractionDigits: n < 10 ? 1 : 0 })} km`;
const esc = (str) => String(str).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

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
let dest = store.dest ?? null;

for (const [value, label] of Object.entries(FUELS)) {
  $('fuel').append(new Option(label, value, false, value === settings.fuel));
}
for (const k of ['consumption', 'liters', 'radius', 'corridor']) $(k).value = settings[k];
document.querySelector(`input[name="mode"][value="${settings.mode}"]`).checked = true;
if (origin) $('address').value = origin.label;
if (dest) $('dest').value = dest.label;

function readSettings() {
  const num = (id, fallback, max) => {
    const v = parseFloat(String($(id).value).replace(',', '.'));
    return Number.isFinite(v) && v > 0 ? Math.min(max, v) : fallback;
  };
  settings.mode = document.querySelector('input[name="mode"]:checked').value;
  settings.fuel = $('fuel').value;
  settings.consumption = num('consumption', DEFAULTS.consumption, 30);
  settings.liters = num('liters', DEFAULTS.liters, 150);
  settings.radius = num('radius', DEFAULTS.radius, 50);
  settings.corridor = num('corridor', DEFAULTS.corridor, 20);
  saveStore({ settings });
  renderChips();
}

function renderChips() {
  const trip = settings.mode === 'trip';
  const chips = [
    FUELS[settings.fuel],
    `${fr(settings.consumption)} L/100 km`,
    `${fr(settings.liters)} L par plein`,
    trip ? `détour ≤ ${fr(settings.corridor)} km` : `rayon ${fr(settings.radius)} km`,
  ];
  $('chips').replaceChildren(...chips.map((c) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = c;
    b.title = 'Modifier les réglages';
    b.addEventListener('click', () => { $('settings').open = true; $('fuel').focus(); });
    return b;
  }));
}

function applyMode() {
  const trip = settings.mode === 'trip';
  $('dest-field').hidden = !trip;
  $('radius-field').hidden = trip;
  $('corridor-field').hidden = !trip;
  $('go').textContent = trip ? 'Où m’arrêter ?' : 'Trouver';
  renderChips();
}

$('settings').addEventListener('change', () => { readSettings(); if (ready()) run(); });
for (const r of document.querySelectorAll('input[name="mode"]')) {
  r.addEventListener('change', () => {
    readSettings();
    applyMode();
    $('results').hidden = true;
    clearMap();
    setStatus('');
    if (ready()) run();
    else (settings.mode === 'trip' && origin ? $('dest') : $('address')).focus();
  });
}
const ready = () => origin && (settings.mode === 'around' || dest);

// ---------- Autocomplétion d'adresse ----------
function attachAutocomplete(input, list, { onPick, onEdit }) {
  let items = [];
  let active = -1;
  let abort;
  let timer;
  const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); active = -1; };
  const draw = () => {
    list.replaceChildren(...items.map((s, i) => {
      const li = document.createElement('li');
      li.setAttribute('role', 'option');
      li.id = `${list.id}-${i}`;
      li.textContent = s.label;
      li.setAttribute('aria-selected', String(i === active));
      li.addEventListener('mousedown', (e) => { e.preventDefault(); pick(i); });
      return li;
    }));
    list.hidden = items.length === 0;
    input.setAttribute('aria-expanded', String(!list.hidden));
    if (active >= 0) input.setAttribute('aria-activedescendant', `${list.id}-${active}`);
    else input.removeAttribute('aria-activedescendant');
  };
  const pick = (i) => {
    const s = items[i];
    if (!s) return;
    input.value = s.label;
    close();
    onPick(s);
  };
  input.addEventListener('input', () => {
    onEdit();
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 3) { items = []; close(); return; }
    timer = setTimeout(async () => {
      abort?.abort();
      abort = new AbortController();
      try { items = await searchAddress(q, abort.signal); active = -1; draw(); } catch { /* annulée */ }
    }, 250);
  });
  input.addEventListener('keydown', (e) => {
    if (list.hidden) return;
    if (e.key === 'ArrowDown') { active = (active + 1) % items.length; draw(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { active = (active - 1 + items.length) % items.length; draw(); e.preventDefault(); }
    else if (e.key === 'Enter' && active >= 0) { pick(active); e.preventDefault(); }
    else if (e.key === 'Escape') close();
  });
  input.addEventListener('blur', () => setTimeout(close, 100));
}

attachAutocomplete($('address'), $('suggestions'), {
  onEdit: () => { origin = null; },
  onPick: (s) => {
    origin = s;
    saveStore({ origin });
    if (ready()) run(); else $('dest').focus();
  },
});
attachAutocomplete($('dest'), $('dest-suggestions'), {
  onEdit: () => { dest = null; },
  onPick: (s) => { dest = s; saveStore({ dest }); if (ready()) run(); },
});

async function resolveTyped(inputId, current) {
  if (current) return current;
  const q = $(inputId).value.trim();
  if (!q) return null;
  const found = await searchAddress(q).catch(() => []);
  if (!found.length) return null;
  $(inputId).value = found[0].label;
  return found[0];
}

$('search').addEventListener('submit', async (e) => {
  e.preventDefault();
  readSettings();
  origin = await resolveTyped('address', origin);
  if (!origin) {
    setStatus($('address').value.trim() ? 'Adresse de départ introuvable. Essaie avec la ville ou le code postal.' : 'Tape une adresse ou utilise ta position.', true);
    $('address').focus();
    return;
  }
  saveStore({ origin });
  if (settings.mode === 'trip') {
    dest = await resolveTyped('dest', dest);
    if (!dest) {
      setStatus($('dest').value.trim() ? 'Destination introuvable. Essaie avec la ville ou le code postal.' : 'Indique ta destination.', true);
      $('dest').focus();
      return;
    }
    saveStore({ dest });
  }
  run();
});

// ---------- Position actuelle ----------
$('locate').addEventListener('click', () => {
  if (!navigator.geolocation) { setStatus('Ton navigateur ne donne pas accès à la position. Tape une adresse.', true); return; }
  setStatus('Localisation en cours…', false, true);
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      origin = { lat: pos.coords.latitude, lon: pos.coords.longitude, label: 'Ma position' };
      $('address').value = origin.label;
      saveStore({ origin });
      if (ready()) run();
      else { setStatus(''); $('dest').focus(); }
    },
    () => setStatus('Position refusée ou indisponible. Autorise la localisation, ou tape une adresse.', true),
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
  );
});

// ---------- Recherche et classement ----------
function setStatus(msg, isError = false, loading = false) {
  $('status').textContent = msg;
  $('status').classList.toggle('error', isError);
  $('status').classList.toggle('loading', loading && !isError);
}

let runId = 0;
async function run() {
  readSettings();
  const id = ++runId;
  $('go').disabled = true;
  try {
    const result = settings.mode === 'trip' ? await searchTrip(id) : await searchAround(id);
    if (!result || id !== runId) return;
    render(result);
    setStatus('');
  } catch (err) {
    console.error(err);
    if (id === runId) setStatus(err.userMessage ?? 'Impossible de récupérer les prix pour le moment. Réessaie dans un instant.', true);
  } finally {
    if (id === runId) $('go').disabled = false;
  }
}

function userError(msg) { const e = new Error(msg); e.userMessage = msg; return e; }

async function searchAround(id) {
  const { fuel, consumption, liters, radius } = settings;
  setStatus(`Recherche des stations à moins de ${fr(radius)} km…`, false, true);
  const { stations, unavailable, source } = await fetchStationsAround(origin, radius, fuel);
  if (id !== runId) return null;
  if (!stations.length) throw userError(`Aucune station avec du ${FUELS[fuel]} à moins de ${fr(radius)} km. Augmente le rayon dans les réglages.`);

  for (const s of stations) { s.oneWayKm = haversineKm(origin, s) * ROAD_FACTOR; s.estimated = true; }
  let ranked = rankStations(stations, { liters, consumption });

  setStatus('Calcul des distances par la route…', false, true);
  const candidates = pickCandidates(ranked);
  const road = await roadDistancesKm(origin, candidates);
  if (id !== runId) return null;
  if (road) {
    const byId = new Map(candidates.map((s, i) => [s.id, road[i]]));
    for (const s of stations) {
      const d = byId.get(s.id);
      if (d != null) { s.oneWayKm = d; s.estimated = false; }
    }
    ranked = rankStations(stations, { liters, consumption });
  }
  return { mode: 'around', ranked, unavailable, source, roadOk: Boolean(road) };
}

async function searchTrip(id) {
  const { fuel, consumption, liters, corridor } = settings;
  setStatus('Calcul de l’itinéraire…', false, true);
  const route = await fetchRoute(origin, dest);
  if (id !== runId) return null;
  if (!route) throw userError('Impossible de calculer l’itinéraire pour le moment. Réessaie dans un instant.');

  // Rectangle englobant le trajet, élargi du détour max
  const lats = route.line.map((c) => c[1]);
  const lons = route.line.map((c) => c[0]);
  const padLat = corridor / 110.57;
  const padLon = corridor / (111.32 * Math.cos((origin.lat * Math.PI) / 180));
  const box = {
    minLat: Math.min(...lats) - padLat, maxLat: Math.max(...lats) + padLat,
    minLon: Math.min(...lons) - padLon, maxLon: Math.max(...lons) + padLon,
  };
  setStatus(`Recherche des stations le long des ${fr(Math.round(route.km))} km du trajet…`, false, true);
  const res = await fetchStationsInBox(box, fuel);
  if (id !== runId) return null;

  const step = Math.max(1, Math.floor(route.line.length / 1500));
  const coarse = route.line.filter((_, i) => i % step === 0 || i === route.line.length - 1);
  const near = (s) => { s.offRouteKm = distanceToLineKm(s, coarse); return s.offRouteKm <= corridor; };
  const stations = res.stations.filter(near);
  const unavailable = res.unavailable.filter(near);
  if (!stations.length) throw userError(`Aucune station avec du ${FUELS[fuel]} à moins de ${fr(corridor)} km du trajet. Augmente le détour max dans les réglages.`);

  for (const s of stations) { s.extraKm = 2 * s.offRouteKm * ROAD_FACTOR; s.estimated = true; }
  let ranked = rankStations(stations, { liters, consumption });

  setStatus('Calcul des détours par la route…', false, true);
  const candidates = pickCandidates(ranked);
  const detours = await detoursKm(origin, dest, route.km, candidates);
  if (id !== runId) return null;
  if (detours) {
    const byId = new Map(candidates.map((s, i) => [s.id, detours[i]]));
    for (const s of stations) {
      const d = byId.get(s.id);
      if (d != null) { s.extraKm = d; s.estimated = false; }
    }
    ranked = rankStations(stations, { liters, consumption });
  }
  return { mode: 'trip', ranked, unavailable, source: res.source, roadOk: Boolean(detours), route };
}

function pickCandidates(ranked) {
  const candidates = ranked.slice(0, ROAD_CANDIDATES);
  const nearest = ranked.find((s) => s.isNearest);
  if (!candidates.includes(nearest)) candidates.push(nearest);
  return candidates;
}

// ---------- Affichage ----------
const navLinks = (s) => `
  <a class="primary" href="https://waze.com/ul?ll=${s.lat},${s.lon}&navigate=yes" target="_blank" rel="noopener">Waze</a>
  <a href="https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lon}" target="_blank" rel="noopener">Google Maps</a>`;
const title = (s) => esc(s.adresse || 'Station');
const where = (s) => esc([s.cp, s.ville].filter(Boolean).join(' '));
const dateFr = (iso) => new Date(iso).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const updated = (s) => (s.updatedAt ? `maj ${dateFr(s.updatedAt)}` : '');
const distLabel = (s, mode) => (mode === 'trip'
  ? (extraKmOf(s) < 0.3 && !s.estimated ? 'sur le trajet' : `détour ${s.estimated ? '~' : ''}+${km(extraKmOf(s), false)}`)
  : km(s.oneWayKm, s.estimated));

let current = null; // dernier résultat affiché

function render(result) {
  current = result;
  const { mode, ranked, unavailable, source, roadOk, route } = result;
  const best = ranked[0];
  const nearest = ranked.find((s) => s.isNearest);
  const { liters, consumption } = settings;
  const trip = mode === 'trip';
  const ref = trip ? 'le plus petit détour' : 'la plus proche';

  const savingLine = best.isNearest
    ? (trip ? 'C’est aussi celle qui fait le moins dévier.' : 'C’est aussi la plus proche : pas besoin d’aller plus loin.')
    : `${euro(best.savingVsNearest)} d’économie par rapport à ${ref} (${title(nearest)}, ${perLiter(nearest.price)}, ${distLabel(nearest, mode)})`;

  $('best').innerHTML = `
    ${trip ? `<p class="trip-summary">${esc(origin.label)} → ${esc(dest.label)} · ${fr(Math.round(route.km))} km · ${Math.floor(route.minutes / 60)} h ${String(Math.round(route.minutes % 60)).padStart(2, '0')}</p>` : ''}
    <p class="eyebrow">${trip ? 'Le meilleur arrêt' : 'La plus rentable'}</p>
    <h2>${title(best)}</h2>
    <div class="where">${where(best)} · ${distLabel(best, mode)} · ${perLiter(best.price)}</div>
    <div class="figures">
      <span class="total">${euro(best.cost.total)}</span>
      <span class="breakdown">${fr(liters)} L ${euro(best.cost.fill)} + ${trip ? 'détour' : 'trajet'} ${euro(best.cost.trip)}</span>
    </div>
    <p class="saving">${savingLine}</p>
    <div class="links">${navLinks(best)}</div>`;

  $('list-title').textContent = `Classement par coût total (${ranked.length} station${ranked.length > 1 ? 's' : ''})`;
  $('list').replaceChildren(...ranked.slice(0, LIST_SIZE).map((s, i) => {
    const li = document.createElement('li');
    li.tabIndex = 0;
    li.dataset.id = s.id;
    if (i === 0) li.classList.add('is-best');
    const delta = s.cost.total - best.cost.total;
    li.innerHTML = `
      <span class="rank">${i + 1}</span>
      <span class="body">
        <span class="name">${title(s)}${s.isNearest ? `<span class="tag">${trip ? 'plus petit détour' : 'la plus proche'}</span>` : ''}</span>
        <span class="meta">${where(s)} · ${distLabel(s, mode)} · ${perLiter(s.price)}</span>
      </span>
      <span class="cost"><strong>${euro(s.cost.total)}</strong>
        <span class="delta ${i === 0 ? 'good' : 'bad'}">${i === 0 ? 'meilleur' : `+${euro(delta)}`}</span></span>`;
    li.title = updated(s);
    if (i >= LIST_COLLAPSED) li.classList.add('extra');
    li.addEventListener('click', () => focusStation(s.id));
    li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); focusStation(s.id); } });
    li.addEventListener('mouseenter', () => highlight(s.id, true));
    li.addEventListener('mouseleave', () => highlight(s.id, false));
    return li;
  }));

  const shown = Math.min(ranked.length, LIST_SIZE);
  $('list').classList.add('collapsed');
  $('more').hidden = shown <= LIST_COLLAPSED;
  $('more').textContent = `Voir les ${shown - LIST_COLLAPSED} suivantes`;

  $('unavailable-wrap').hidden = !unavailable.length;
  $('unavailable-title').textContent = `${unavailable.length} station${unavailable.length > 1 ? 's' : ''} en rupture de ${FUELS[settings.fuel]} ${trip ? 'sur le trajet' : 'dans le rayon'}`;
  $('unavailable').replaceChildren(...unavailable.map((s) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="body"><span class="name">${title(s)}</span><span class="meta">${where(s)}</span></span>
      <span class="meta">plus de ${FUELS[settings.fuel]} depuis le ${dateFr(s.outSince)}</span>`;
    li.addEventListener('click', () => focusStation(`out-${s.id}`));
    return li;
  }));

  const notes = [
    trip
      ? `Coût total = ${fr(liters)} L + carburant brûlé pour le détour (${fr(consumption)} L/100 km).`
      : `Coût total = ${fr(liters)} L + carburant brûlé pour l’aller-retour (${fr(consumption)} L/100 km).`,
    roadOk ? 'Distances par la route pour les meilleures stations ; « ~ » = estimation à vol d’oiseau × 1,3.' : 'Service de routage indisponible : distances estimées à vol d’oiseau × 1,3.',
    source === 'fallback' ? 'Prix issus de la copie horaire (API temps réel indisponible).' : 'Prix en temps réel.',
  ];
  $('footnote').textContent = notes.join(' ');

  $('results').hidden = false;
  $('intro').hidden = true;
  placeMap();
  drawMap(result);
}

// ---------- Carte ----------
const desktop = window.matchMedia('(min-width: 960px)');
function placeMap() {
  const slot = desktop.matches ? $('map-slot-desktop') : $('map-slot-mobile');
  if ($('map-wrap').parentElement !== slot) slot.append($('map-wrap'));
  if (map) setTimeout(() => map.invalidateSize(), 0);
}
desktop.addEventListener('change', () => { placeMap(); if (current) fitCurrent(); });

let map;
let layer;
let fitBoundsCache;
const markers = new Map();

function ensureMap() {
  if (map || !window.L) return Boolean(map);
  map = L.map('map', { zoomControl: false, zoomSnap: 0.25, scrollWheelZoom: desktop.matches }).setView([46.6, 2.4], 6);
  L.control.zoom({ position: 'topright' }).addTo(map);
  // Tuiles OpenStreetMap standard (sans clé) ; en mode sombre, inversées en CSS
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    className: 'osm-tiles',
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  layer = L.layerGroup().addTo(map);
  return true;
}
function clearMap() {
  layer?.clearLayers();
  markers.clear();
  $('legend').hidden = true;
}

const pinIcon = (html, cls) => L.divIcon({ className: `pin ${cls}`, html: `<span>${html}</span>`, iconSize: [0, 0], iconAnchor: [0, 0] });
const endIcon = (label) => L.divIcon({ className: 'origin-pin', html: `<i title="${esc(label)}"></i>`, iconSize: [18, 18], iconAnchor: [9, 9] });

function drawMap({ mode, ranked, unavailable, route }) {
  if (!ensureMap()) { $('map-wrap').hidden = true; return; }
  clearMap();
  const bounds = [];
  const best = ranked[0];

  if (mode === 'trip') {
    L.polyline(route.line.map(([lon, lat]) => [lat, lon]), { color: '#2563eb', weight: 5, opacity: 0.7 }).addTo(layer);
    L.marker([dest.lat, dest.lon], { icon: endIcon(dest.label), keyboard: false }).bindTooltip(esc(dest.label)).addTo(layer);
    for (const [lon, lat] of route.line) bounds.push([lat, lon]);
  } else {
    L.circle([origin.lat, origin.lon], {
      radius: settings.radius * 1000, color: '#0f766e', weight: 1, fillOpacity: 0.04, dashArray: '4 6', interactive: false,
    }).addTo(layer);
  }
  L.marker([origin.lat, origin.lon], { icon: endIcon(origin.label), keyboard: false }).bindTooltip(esc(origin.label)).addTo(layer);
  bounds.push([origin.lat, origin.lon]);

  for (const s of unavailable) {
    const m = L.circleMarker([s.lat, s.lon], { radius: 5, color: '#6b7280', weight: 1.5, fillColor: '#d1d5db', fillOpacity: 1 })
      .bindTooltip(`En rupture de ${FUELS[settings.fuel]}`)
      .bindPopup(`<strong>${title(s)}</strong><br>${where(s)}<br>Plus de ${FUELS[settings.fuel]} depuis le ${dateFr(s.outSince)}`);
    m.addTo(layer);
    markers.set(`out-${s.id}`, m);
  }

  ranked.slice(0, LIST_SIZE).reverse().forEach((s) => {
    const rank = ranked.indexOf(s) + 1;
    const isBest = s === best;
    const popup = `
      <strong>${rank}. ${title(s)}</strong><br>${where(s)}<br>
      ${perLiter(s.price)} · ${distLabel(s, mode)}<br>
      <strong>${euro(s.cost.total)}</strong> ${rank > 1 ? `(+${euro(s.cost.total - best.cost.total)})` : '· le meilleur'}<br>
      <small>${updated(s)}</small>
      <div class="links">${navLinks(s)}</div>`;
    // Les 10 premières : étiquette avec rang et prix ; les suivantes : simple point
    const m = rank <= LABELLED_PINS
      ? L.marker([s.lat, s.lon], {
        icon: pinIcon(`<b>${rank}</b>${priceShort(s.price)}`, isBest ? 'best' : ''),
        zIndexOffset: isBest ? 2000 : 1000 - rank,
        title: `${rank}. ${s.adresse}`,
      })
      : L.circleMarker([s.lat, s.lon], { radius: 5, color: '#0f766e', weight: 1.5, fillColor: '#ffffff', fillOpacity: 1 })
        .bindTooltip(`${rank}. ${priceShort(s.price)} €/L · ${euro(s.cost.total)}`);
    m.bindPopup(popup);
    m.on('mouseover', () => highlight(s.id, true));
    m.on('mouseout', () => highlight(s.id, false));
    m.on('click', () => {
      expandFor(s.id);
      const li = document.querySelector(`#list li[data-id="${s.id}"]`);
      if (li && desktop.matches) li.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
    m.addTo(layer);
    markers.set(s.id, m);
    if (rank <= 10) bounds.push([s.lat, s.lon]);
  });

  $('legend').hidden = false;
  fitBoundsCache = bounds;
  fitCurrent();
}
function fitCurrent() {
  if (!map || !fitBoundsCache) return;
  map.invalidateSize();
  map.fitBounds(fitBoundsCache, { padding: [40, 40], maxZoom: 14 });
}

function highlight(id, on) {
  const m = markers.get(id);
  if (m?.setStyle) { m.setStyle({ radius: on ? 8 : 5, weight: on ? 3 : 1.5 }); if (on) m.bringToFront(); }
  else m?.getElement()?.classList.toggle('hl', on);
  document.querySelector(`#list li[data-id="${id}"]`)?.classList.toggle('hl', on);
}
function focusStation(id) {
  const m = markers.get(id);
  if (!m) return;
  if (!desktop.matches) $('map-wrap').scrollIntoView({ behavior: 'smooth', block: 'center' });
  map.setView(m.getLatLng(), Math.max(map.getZoom(), 14));
  m.openPopup();
}

$('more').addEventListener('click', () => {
  $('list').classList.remove('collapsed');
  $('more').hidden = true;
});
function expandFor(id) {
  if (document.querySelector(`#list li[data-id="${id}"].extra`)) { $('list').classList.remove('collapsed'); $('more').hidden = true; }
}

// ---------- Démarrage ----------
applyMode();
if (desktop.matches) { placeMap(); ensureMap(); }
if (ready() && origin.label !== 'Ma position') run();
