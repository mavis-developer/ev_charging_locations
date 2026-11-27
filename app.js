'use strict';

// Data is pre-built by scripts/build_data.py into data/index.json + data/tiles/<i>_<j>.json.
// Categories (labels, emoji, minimum stop length) come from categories.json, shared with the build.

const WALK_M_PER_MIN = 80;            // ~4.8 km/h
const PAGE_SIZE = 25;                 // chargers listed at a time ("Show more" adds another page)

let CATEGORIES = [];                  // all categories, index = category id used in tiles
let ACTIVITIES = [];                  // categories offered as activities (not facilities)
let INDEX = null;                     // data/index.json
const tileCache = new Map();          // tile key -> Promise<chargers[]>

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);

function haversine(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Longest one-way walk that leaves time to actually do something (max must match MAX_WALK_M in the build). */
function walkRadiusMeters(dwellMin) {
  const walkMin = Math.min(15, Math.max(4, dwellMin * 0.2));
  return Math.round(walkMin * WALK_M_PER_MIN);
}

const walkMins = (m) => Math.max(1, Math.round(m / WALK_M_PER_MIN));

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------
async function fetchJson(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

async function loadMeta() {
  // 'no-cache' = always check with the server for a newer copy (small files, so cheap).
  const cats = await fetchJson('categories.json', { cache: 'no-cache' });
  CATEGORIES = cats.categories;
  ACTIVITIES = CATEGORIES.filter((c) => !c.facility);
  try {
    INDEX = await fetchJson('data/index.json', { cache: 'no-cache' });
  } catch {
    INDEX = null;
  }
}

function loadTile(key) {
  if (!tileCache.has(key)) {
    // ?v=<build time> so a new weekly build never mixes with cached tiles from the last one.
    const p = fetchJson(`data/tiles/${key}.json?v=${encodeURIComponent(INDEX.built)}`).then((tile) => {
      const places = tile.places.map(([lat, lon, ci, name]) => ({ lat, lon, cat: CATEGORIES[ci], name }));
      return tile.chargers.map((c) => ({
        ...c,
        nearby: c.near.map(([pi, dist]) => ({ ...places[pi], dist })),
      }));
    });
    p.catch(() => tileCache.delete(key)); // allow retry after a network error
    tileCache.set(key, p);
  }
  return tileCache.get(key);
}

/** All chargers within `radius` metres of `origin`, loading only the tiles that overlap. */
async function chargersNear(origin, radius) {
  const deg = INDEX.tileDeg;
  const dLat = radius / 111320;
  const dLon = radius / (111320 * Math.cos(origin.lat * Math.PI / 180));
  const keys = [];
  for (let i = Math.floor((origin.lat - dLat) / deg); i <= Math.floor((origin.lat + dLat) / deg); i++) {
    for (let j = Math.floor((origin.lon - dLon) / deg); j <= Math.floor((origin.lon + dLon) / deg); j++) {
      if (INDEX.tiles[`${i}_${j}`]) keys.push(`${i}_${j}`);
    }
  }
  const tiles = await Promise.all(keys.map(loadTile));
  return tiles.flat()
    .map((c) => ({ ...c, distFromYou: haversine(origin, c) }))
    .filter((c) => c.distFromYou <= radius);
}

async function geocode(query) {
  // UK postcodes: postcodes.io is fast and exact.
  const pc = query.replace(/\s+/g, '').toUpperCase();
  if (/^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/.test(pc)) {
    try {
      const r = await fetchJson(`https://api.postcodes.io/postcodes/${pc}`);
      if (r.result) return { lat: r.result.latitude, lon: r.result.longitude };
    } catch { /* fall through to Nominatim */ }
  }
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=gb&q=${encodeURIComponent(query)}`;
  const data = await fetchJson(url);
  if (!data.length) throw new Error(`Couldn't find "${query}" in the UK`);
  return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) };
}

// ---------------------------------------------------------------------------
// Journeys
// ---------------------------------------------------------------------------
// Free OSRM driving-route servers (no key). Tried in order.
const ROUTERS = [
  'https://routing.openstreetmap.de/routed-car/route/v1/driving',
  'https://router.project-osrm.org/route/v1/driving',
];
const ROUTE_SAMPLE_M = 400;           // check chargers against a point every ~400 m of the route

/** Driving route as { coords: [[lat, lon], …], distM, durS }. */
async function getRoute(a, b) {
  let lastErr;
  for (const base of ROUTERS) {
    try {
      const r = await fetchJson(`${base}/${a.lon},${a.lat};${b.lon},${b.lat}?overview=full&geometries=geojson`);
      if (r.code !== 'Ok' || !r.routes?.length) throw new Error(r.message || 'no route');
      const rt = r.routes[0];
      return { coords: rt.geometry.coordinates.map(([lon, lat]) => [lat, lon]), distM: rt.distance, durS: rt.duration };
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`Couldn't plan a driving route between those places (${lastErr.message}).`);
}

/** Points roughly every ROUTE_SAMPLE_M along the route, each with its distance from the start. */
function sampleRoute(coords) {
  const out = [{ lat: coords[0][0], lon: coords[0][1], m: 0 }];
  let total = 0, sinceLast = 0;
  for (let i = 1; i < coords.length; i++) {
    const a = { lat: coords[i - 1][0], lon: coords[i - 1][1] };
    const b = { lat: coords[i][0], lon: coords[i][1] };
    const d = haversine(a, b);
    total += d;
    sinceLast += d;
    if (sinceLast >= ROUTE_SAMPLE_M || i === coords.length - 1) {
      out.push({ ...b, m: total });
      sinceLast = 0;
    }
  }
  return out;
}

/** Chargers within `corridorM` of the route, each with offRouteM and alongM (distance into the journey). */
async function chargersAlongRoute(samples, corridorM) {
  const deg = INDEX.tileDeg;
  const pad = corridorM / 111320 * 1.7; // generous in longitude at UK latitudes
  const keys = new Set();
  for (const s of samples) {
    for (let i = Math.floor((s.lat - pad) / deg); i <= Math.floor((s.lat + pad) / deg); i++) {
      for (let j = Math.floor((s.lon - pad) / deg); j <= Math.floor((s.lon + pad) / deg); j++) {
        if (INDEX.tiles[`${i}_${j}`]) keys.add(`${i}_${j}`);
      }
    }
  }
  const tiles = await Promise.all([...keys].map(loadTile));

  // Bucket route samples on a grid so each charger only checks the route points near it.
  const CELL = 0.05; // degrees (~5.5 km north-south)
  const cellKey = (lat, lon) => `${Math.floor(lat / CELL)}:${Math.floor(lon / CELL)}`;
  const grid = new Map();
  for (const s of samples) {
    const k = cellKey(s.lat, s.lon);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(s);
  }
  const reach = Math.ceil(corridorM / 111320 / CELL * 1.7) + 1;

  const out = [];
  for (const c of tiles.flat()) {
    const ci = Math.floor(c.lat / CELL), cj = Math.floor(c.lon / CELL);
    let best = null, bestD = Infinity;
    for (let di = -reach; di <= reach; di++) {
      for (let dj = -reach; dj <= reach; dj++) {
        for (const s of grid.get(`${ci + di}:${cj + dj}`) || []) {
          const d = haversine(c, s);
          if (d < bestD) { bestD = d; best = s; }
        }
      }
    }
    if (best && bestD <= corridorM) out.push({ ...c, offRouteM: bestD, alongM: best.m });
  }
  return out;
}

function formatDuration(s) {
  const mins = Math.round(s / 60);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60), m = mins % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------
/**
 * Each charger needs `detourM`: how far out of your way it is (distance from you, or there-and-back
 * off the route). `detourScale` sets how hard detours are penalised.
 */
function rankChargers(chargers, opts) {
  const { walkM, dwell, selectedKeys, rapidOnly, needToilets, detourScale } = opts;
  const scored = [];

  for (const ch of chargers) {
    if (rapidOnly && !(ch.kw >= 50)) continue;

    const nearby = ch.nearby.filter((p) => p.dist <= walkM).sort((a, b) => a.dist - b.dist);
    const hasToilets = ch.wc || nearby.some((p) => p.cat.key === 'toilets');
    if (needToilets && !hasToilets) continue;

    const activities = nearby.filter((p) => selectedKeys.has(p.cat.key));
    if (!activities.length) continue;

    // Closer places count more, named places count more, a mix of categories counts more,
    // activities that don't suit the stop length count less, with diminishing returns per category.
    const perCat = {};
    let score = 0;
    for (const p of activities) {
      const n = (perCat[p.cat.key] = (perCat[p.cat.key] || 0) + 1);
      const closeness = 1 - p.dist / walkM;
      const fit = dwell >= p.cat.minDwell ? 1 : 0.35;
      score += (0.4 + closeness) * (p.name ? 1 : 0.5) * fit / Math.sqrt(n);
    }
    score *= 1 + 0.25 * (Object.keys(perCat).length - 1);
    score /= 1 + ch.detourM / detourScale;

    scored.push({ ...ch, activities, perCat, hasToilets, score });
  }

  return scored.sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------------------
// Map + UI
// ---------------------------------------------------------------------------
const map = L.map('map', { preferCanvas: true }).setView([54.5, -3], 6); // canvas copes with thousands of dots
// Base maps: Esri tiles (no key needed; checked Nov 2026 by looking at the actual tiles; CARTO
// started returning "API key required" images) plus the standard OSM style.
// The grey "Canvas" styles carry no labels, so each is paired with its matching label layer.
const OSM_CREDIT = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const ESRI_CREDIT = 'Powered by <a href="https://www.esri.com">Esri</a> | Sources: Esri, HERE, Garmin, USGS, ' + OSM_CREDIT;
const esri = (service, opts = {}) => L.tileLayer(
  `https://server.arcgisonline.com/ArcGIS/rest/services/${service}/MapServer/tile/{z}/{y}/{x}`,
  { maxZoom: 19, maxNativeZoom: 19, attribution: ESRI_CREDIT, ...opts },
);
const baseMaps = {
  'Light grey': L.layerGroup([
    esri('Canvas/World_Light_Gray_Base', { maxNativeZoom: 16 }),
    esri('Canvas/World_Light_Gray_Reference', { maxNativeZoom: 16 }),
  ]),
  Streets: esri('World_Street_Map'),
  'Dark grey': L.layerGroup([
    esri('Canvas/World_Dark_Gray_Base', { maxNativeZoom: 16 }),
    esri('Canvas/World_Dark_Gray_Reference', { maxNativeZoom: 16 }),
  ]),
  Satellite: L.layerGroup([
    esri('World_Imagery', { attribution: 'Imagery: Esri, Maxar, Earthstar Geographics' }),
    esri('Reference/World_Boundaries_and_Places'),
  ]),
  OpenStreetMap: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: OSM_CREDIT }),
};
// Default: Light grey (Dark grey on devices in dark mode). A style the viewer picks is remembered;
// the key was renamed to 'basemap2' so earlier saved picks (e.g. the broken CARTO ones) are ignored.
let savedBase = null;
try { savedBase = localStorage.getItem('basemap2'); } catch { /* storage blocked */ }
const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
(baseMaps[savedBase] || (prefersDark ? baseMaps['Dark grey'] : baseMaps['Light grey'])).addTo(map);
L.control.layers(baseMaps, null, { position: 'topright' }).addTo(map);
map.on('baselayerchange', (e) => { try { localStorage.setItem('basemap2', e.name); } catch { /* ignore */ } });
const routeLayer = L.layerGroup().addTo(map);
const chargerLayer = L.layerGroup().addTo(map);
const placeLayer = L.layerGroup().addTo(map);
const pinLayer = L.layerGroup().addTo(map);     // "You" / start / end markers
let mode = 'near';                    // 'near' = around a place, 'route' = along a journey
let currentOrigin = null;             // near mode: where you are
let fromPoint = null;                 // route mode: start, when set from "My location"
let lastRoute = null;                 // route mode: { coords, distM, durS }
let results = [];                     // every matching charger, in the current sort order
let shownCount = 0;                   // how many are listed (and drawn large) so far
let lastWalkM = 0;
let lastDwell = 0;

function renderChips() {
  $('activities').innerHTML = ACTIVITIES.map((c, i) => `
    <label class="chip"><input type="checkbox" value="${c.key}" ${i < 2 ? 'checked' : ''}>
    <span>${c.emoji} ${escapeHtml(c.label)}</span></label>`).join('');
}

function setStatus(msg, isError = false) {
  $('status').textContent = msg;
  $('status').className = isError ? 'error' : '';
}

const chargerTitle = (ch) => ch.name || 'EV charger';

/** Every matching charger goes on the map; the ones listed so far are big, the rest small dots. */
function renderMap() {
  chargerLayer.clearLayers();
  // Draw the unlisted dots first so the listed (bigger) markers sit on top.
  for (let i = results.length - 1; i >= 0; i--) {
    const ch = results[i];
    const listed = i < shownCount;
    L.circleMarker([ch.lat, ch.lon], listed
      ? { radius: 9, color: '#0b8a5f', weight: 2, fillColor: '#2fbf87', fillOpacity: 0.9 }
      : { radius: 5, color: '#0b8a5f', weight: 1, fillColor: '#2fbf87', fillOpacity: 0.45 })
      .bindTooltip(`${i + 1}. ${escapeHtml(chargerTitle(ch))}`)
      .on('click', () => focusCharger(i))
      .addTo(chargerLayer);
  }
}

function renderResults(dwell, fit = true) {
  placeLayer.clearLayers();
  const list = $('results');
  list.innerHTML = '';
  const cap = INDEX.perCatCap;

  results.slice(0, shownCount).forEach((ch, i) => {
    const title = chargerTitle(ch);
    const kwh = ch.kw ? Math.round(ch.kw * dwell / 60) : null;
    const slow = ch.kw && ch.kw < 22 && dwell <= 60;
    const counts = Object.entries(ch.perCat)
      .map(([k, n]) => `${CATEGORIES.find((x) => x.key === k).emoji} ${n >= cap ? `${cap}+` : n}`)
      .join(' &nbsp; ');
    const named = ch.activities.filter((p) => p.name).slice(0, 4);
    const where = mode === 'route'
      ? `${Math.round(ch.alongM / 1000)} km into the journey (about ${formatDuration(lastRoute.durS * ch.alongM / lastRoute.distM)} of driving) · ${(ch.offRouteM / 1000).toFixed(1)} km off the route`
      : `${(ch.distFromYou / 1000).toFixed(1)} km away`;
    const metaBits = [
      mode === 'route' ? null : where,
      ch.op,
      ch.kw ? `${ch.kw} kW` : 'power unknown',
      ch.pts ? `${ch.pts} ${ch.pts === 1 ? 'point' : 'points'}` : null,
      (ch.sk || []).join(', '),
      ch.fee === 'no' ? 'free' : null,
      ch.acc === 'customers' ? 'customers only' : null,
      ch.mem ? 'membership / app needed' : null,
    ].filter(Boolean);
    const sourceLink = ch.src === 'ocm'
      ? `<a href="https://openchargemap.org/site/poi/details/${ch.id.slice(3)}" target="_blank" rel="noopener">Charger details ↗</a>`
      : `<a href="https://www.openstreetmap.org/${{ n: 'node', w: 'way', r: 'relation' }[ch.id[0]]}/${ch.id.slice(1)}" target="_blank" rel="noopener">Charger details ↗</a>`;

    const li = document.createElement('li');
    li.className = 'card';
    li.innerHTML = `
      <h3>${i + 1}. ${escapeHtml(title)}</h3>
      ${mode === 'route' ? `<div class="journey">${escapeHtml(where)}</div>` : ''}
      <div class="meta">${escapeHtml(metaBits.join(' · '))}</div>
      ${ch.cost && ch.fee !== 'no' ? `<div class="meta">Cost: ${escapeHtml(ch.cost)}</div>` : ''}
      ${kwh ? `<div class="meta">Up to ~${kwh} kWh in ${dwell} min (car's own limit may be lower)</div>` : ''}
      ${slow ? `<div class="warn">Slow charger: you won't get much range in this time.</div>` : ''}
      <div class="counts">${counts}${ch.hasToilets ? ' &nbsp; 🚻' : ''}</div>
      ${named.length ? `<ul class="places">${named.map((p) =>
        `<li>${p.cat.emoji} ${escapeHtml(p.name)} <span class="meta">· ${walkMins(p.dist)} min walk</span></li>`).join('')}</ul>` : ''}
      <div class="links">
        <a href="https://www.google.com/maps/dir/?api=1&destination=${ch.lat},${ch.lon}" target="_blank" rel="noopener">Directions ↗</a>
        ${sourceLink}
      </div>`;
    li.addEventListener('click', (e) => { if (e.target.tagName !== 'A') focusCharger(i); });
    list.appendChild(li);
  });

  const more = $('more');
  const left = results.length - shownCount;
  more.hidden = left <= 0;
  more.textContent = `Show ${Math.min(PAGE_SIZE, left)} more (${left} left)`;

  renderMap();
  if (!fit) return;
  if (mode === 'route' && lastRoute) {
    map.fitBounds(L.latLngBounds(lastRoute.coords), { padding: [30, 30] });
  } else if (results.length) {
    const bounds = L.latLngBounds(results.map((c) => [c.lat, c.lon]));
    bounds.extend([currentOrigin.lat, currentOrigin.lon]);
    map.fitBounds(bounds, { padding: [30, 30] });
  }
}

function applySort() {
  const by = mode === 'route' ? $('sort').value : 'best';
  results.sort(by === 'journey' ? (a, b) => a.alongM - b.alongM : (a, b) => b.score - a.score);
}

function focusCharger(i) {
  if (i >= shownCount) {               // clicked a small dot: extend the list down to it
    shownCount = Math.ceil((i + 1) / PAGE_SIZE) * PAGE_SIZE;
    renderResults(lastDwell, false);
  }
  const ch = results[i];
  const cards = document.querySelectorAll('.card');
  cards.forEach((el, j) => el.classList.toggle('active', i === j));
  cards[i].scrollIntoView({ block: 'nearest', behavior: 'smooth' });

  placeLayer.clearLayers();
  L.circle([ch.lat, ch.lon], { radius: lastWalkM, color: '#0b8a5f', weight: 1, fillOpacity: 0.05 }).addTo(placeLayer);
  for (const p of ch.activities) {
    L.marker([p.lat, p.lon], {
      icon: L.divIcon({ className: '', html: `<div style="font-size:18px">${p.cat.emoji}</div>`, iconSize: [20, 20], iconAnchor: [10, 10] }),
    })
      .bindTooltip(`${escapeHtml(p.name || p.cat.label)} · ${walkMins(p.dist)} min walk`)
      .addTo(placeLayer);
  }
  map.setView([ch.lat, ch.lon], 16);
}

function setOrigin(origin) {
  currentOrigin = origin;
  pinLayer.clearLayers();
  L.marker([origin.lat, origin.lon]).bindTooltip('You').addTo(pinLayer);
}

let rapidBeforeRoute = false;

function setMode(m) {
  if (m === mode) return;
  // On a journey you need range, so default to rapid chargers; restore the old choice on the way back.
  if (m === 'route') {
    rapidBeforeRoute = $('rapid').checked;
    $('rapid').checked = true;
  } else {
    $('rapid').checked = rapidBeforeRoute;
  }
  mode = m;
  $('mode-near').setAttribute('aria-selected', String(m === 'near'));
  $('mode-route').setAttribute('aria-selected', String(m === 'route'));
  $('near-fields').hidden = m !== 'near';
  $('radius-field').hidden = m !== 'near';
  $('route-fields').hidden = m !== 'route';
  $('corridor-field').hidden = m !== 'route';
  $('sort-field').hidden = true;     // shown once there are journey results
  // Clear the other mode's results so the map never mixes the two.
  results = [];
  shownCount = 0;
  lastRoute = null;
  routeLayer.clearLayers();
  chargerLayer.clearLayers();
  placeLayer.clearLayers();
  pinLayer.clearLayers();
  $('results').innerHTML = '';
  $('more').hidden = true;
  setStatus('');
  if (m === 'near' && currentOrigin) setOrigin(currentOrigin);
}

async function search(e) {
  e?.preventDefault();
  if (!INDEX) return setStatus('No charger data found. Build it first: python3 scripts/build_data.py <file.osm.pbf> data', true);

  const selectedKeys = new Set([...document.querySelectorAll('#activities input:checked')].map((el) => el.value));
  if (!selectedKeys.size) return setStatus('Pick at least one activity.', true);

  const dwell = +$('dwell').value;
  const walkM = walkRadiusMeters(dwell);
  const filters = { walkM, dwell, selectedKeys, rapidOnly: $('rapid').checked, needToilets: $('toilets').checked };
  const labels = ACTIVITIES.filter((c) => selectedKeys.has(c.key)).map((c) => c.label.toLowerCase()).join(' / ');
  $('go').disabled = true;

  try {
    if (mode === 'route') {
      await searchRoute(filters, labels);
    } else {
      await searchNear(filters, labels);
    }
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    $('go').disabled = false;
  }
}

async function searchNear(filters, labels) {
  const placeText = $('place').value.trim();
  if (placeText && placeText !== 'My location') {
    setStatus('Finding place…');
    setOrigin(await geocode(placeText));
  }
  if (!currentOrigin) throw new Error('Enter a place or tap 📍 to use your location.');

  setStatus('Loading chargers…');
  const chargers = (await chargersNear(currentOrigin, +$('radius').value))
    .map((c) => ({ ...c, detourM: c.distFromYou }));
  results = rankChargers(chargers, { ...filters, detourScale: 20000 }); // gentle penalty for distance from you
  lastWalkM = filters.walkM;
  lastDwell = filters.dwell;
  shownCount = PAGE_SIZE;
  renderResults(filters.dwell);

  const walk = walkMins(filters.walkM);
  setStatus(results.length
    ? `${results.length} of ${chargers.length} chargers nearby have ${labels} within a ${walk}-min walk. Best first; all are on the map.`
    : chargers.length
      ? `${chargers.length} chargers nearby, but none with that within a ${walk}-min walk. Try a longer stop or more activities.`
      : 'No chargers found in this area. Try a bigger search area.');
}

async function searchRoute(filters, labels) {
  const fromText = $('from').value.trim();
  const toText = $('to').value.trim();
  if (!fromText && !fromPoint) throw new Error('Enter where you\'re starting from, or tap 📍 to use your location.');
  if (!toText) throw new Error('Enter where you\'re going.');

  setStatus('Finding places…');
  const [from, to] = await Promise.all([
    fromPoint && fromText === 'My location' ? fromPoint : geocode(fromText),
    geocode(toText),
  ]);

  setStatus('Planning the route…');
  lastRoute = await getRoute(from, to);
  routeLayer.clearLayers();
  L.polyline(lastRoute.coords, { color: '#2563eb', weight: 5, opacity: 0.7 }).addTo(routeLayer);
  pinLayer.clearLayers();
  L.marker([from.lat, from.lon]).bindTooltip('Start').addTo(pinLayer);
  L.marker([to.lat, to.lon]).bindTooltip('Destination').addTo(pinLayer);

  setStatus('Loading chargers along the route…');
  const corridorM = +$('corridor').value;
  // Only the part of the journey where you want to stop (as fractions of the route's length).
  const [startFrac, endFrac] = $('stop-at').value.split('-').map(Number);
  const fromM = startFrac * lastRoute.distM, toM = endFrac * lastRoute.distM;
  const stopWhen = $('stop-at').selectedOptions[0].textContent.toLowerCase();
  const chargers = (await chargersAlongRoute(sampleRoute(lastRoute.coords), corridorM))
    .filter((c) => c.alongM >= fromM && c.alongM <= toM)
    .map((c) => ({ ...c, detourM: 2 * c.offRouteM })); // there and back
  results = rankChargers(chargers, { ...filters, detourScale: 4000 }); // detours matter more on a journey
  applySort();
  lastWalkM = filters.walkM;
  lastDwell = filters.dwell;
  shownCount = PAGE_SIZE;
  $('sort-field').hidden = !results.length;
  renderResults(filters.dwell);

  const trip = `${Math.round(lastRoute.distM / 1000)} km, about ${formatDuration(lastRoute.durS)} of driving`;
  const span = endFrac - startFrac < 1
    ? ` between ${Math.round(fromM / 1000)} and ${Math.round(toM / 1000)} km (${stopWhen})`
    : '';
  const walk = walkMins(filters.walkM);
  setStatus(results.length
    ? `Your route: ${trip}. ${results.length} of ${chargers.length} chargers within ${corridorM / 1000} km of it${span} have ${labels} within a ${walk}-min walk. All are on the map.`
    : chargers.length
      ? `Your route: ${trip}. ${chargers.length} chargers within ${corridorM / 1000} km of it${span}, but none match. Try a longer stop, more activities, a wider detour${filters.rapidOnly ? ' or unticking Rapid only' : ''}.`
      : `Your route: ${trip}. No chargers within ${corridorM / 1000} km of it${span}. Try a wider detour or a different stopping point.`);
}

$('locate').addEventListener('click', () => {
  if (!navigator.geolocation) return setStatus('Location is not available in this browser.', true);
  setStatus('Getting your location…');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      setOrigin({ lat: pos.coords.latitude, lon: pos.coords.longitude });
      $('place').value = 'My location';
      map.setView([pos.coords.latitude, pos.coords.longitude], 13);
      search();
    },
    (err) => setStatus(`Couldn't get your location: ${err.message}`, true),
    { enableHighAccuracy: false, timeout: 10000 },
  );
});
$('locate-from').addEventListener('click', () => {
  if (!navigator.geolocation) return setStatus('Location is not available in this browser.', true);
  setStatus('Getting your location…');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      fromPoint = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      $('from').value = 'My location';
      setStatus($('to').value.trim() ? '' : 'Now enter where you\'re going.');
      if ($('to').value.trim()) search();
    },
    (err) => setStatus(`Couldn't get your location: ${err.message}`, true),
    { enableHighAccuracy: false, timeout: 10000 },
  );
});
$('place').addEventListener('input', () => { if ($('place').value !== 'My location') currentOrigin = null; });
$('from').addEventListener('input', () => { if ($('from').value !== 'My location') fromPoint = null; });
$('mode-near').addEventListener('click', () => setMode('near'));
$('mode-route').addEventListener('click', () => setMode('route'));
$('sort').addEventListener('change', () => {
  applySort();
  renderResults(lastDwell, false);
});
$('search').addEventListener('submit', search);
$('more').addEventListener('click', () => {
  shownCount += PAGE_SIZE;
  renderResults(lastDwell, false);
});

loadMeta()
  .then(() => {
    renderChips();
    if (INDEX) {
      const credits = (INDEX.attribution || [{ name: 'OpenStreetMap contributors', licence: 'ODbL 1.0' }])
        .map((a) => `${a.name}${a.licence ? ` (${a.licence.length > 60 ? `${a.licence.slice(0, 57)}…` : a.licence})` : ''}`);
      $('updated').textContent = `${INDEX.chargers.toLocaleString()} UK charger sites, updated ${INDEX.built.slice(0, 10)}. `
        + `Data: ${credits.join('; ')}. Places: OpenStreetMap contributors.`;
    }
  })
  .catch((err) => setStatus(`Couldn't load the app data: ${err.message}`, true));
