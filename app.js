'use strict';

// Data is pre-built by scripts/build_data.py into data/index.json + data/tiles/<i>_<j>.json.
// Categories (labels, emoji, minimum stop length) come from categories.json, shared with the build.

const WALK_M_PER_MIN = 80;            // ~4.8 km/h
const MAX_RESULTS = 25;

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
async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

async function loadMeta() {
  const cats = await fetchJson('categories.json');
  CATEGORIES = cats.categories;
  ACTIVITIES = CATEGORIES.filter((c) => !c.facility);
  try {
    INDEX = await fetchJson('data/index.json');
  } catch {
    INDEX = null;
  }
}

function loadTile(key) {
  if (!tileCache.has(key)) {
    const p = fetchJson(`data/tiles/${key}.json`).then((tile) => {
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
// Ranking
// ---------------------------------------------------------------------------
function rankChargers(chargers, opts) {
  const { walkM, dwell, selectedKeys, rapidOnly, needToilets } = opts;
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
    score /= 1 + ch.distFromYou / 20000; // gentle penalty for detours

    scored.push({ ...ch, activities, perCat, hasToilets, score });
  }

  return scored.sort((a, b) => b.score - a.score).slice(0, MAX_RESULTS);
}

// ---------------------------------------------------------------------------
// Map + UI
// ---------------------------------------------------------------------------
const map = L.map('map').setView([54.5, -3], 6);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);
const chargerLayer = L.layerGroup().addTo(map);
const placeLayer = L.layerGroup().addTo(map);
let originMarker = null;
let currentOrigin = null;
let results = [];
let lastWalkM = 0;

function renderChips() {
  $('activities').innerHTML = ACTIVITIES.map((c, i) => `
    <label class="chip"><input type="checkbox" value="${c.key}" ${i < 2 ? 'checked' : ''}>
    <span>${c.emoji} ${escapeHtml(c.label)}</span></label>`).join('');
}

function setStatus(msg, isError = false) {
  $('status').textContent = msg;
  $('status').className = isError ? 'error' : '';
}

function renderResults(dwell) {
  chargerLayer.clearLayers();
  placeLayer.clearLayers();
  const list = $('results');
  list.innerHTML = '';
  const cap = INDEX.perCatCap;

  results.forEach((ch, i) => {
    const title = ch.name || 'EV charger';
    const kwh = ch.kw ? Math.round(ch.kw * dwell / 60) : null;
    const slow = ch.kw && ch.kw < 22 && dwell <= 60;
    const counts = Object.entries(ch.perCat)
      .map(([k, n]) => `${CATEGORIES.find((x) => x.key === k).emoji} ${n >= cap ? `${cap}+` : n}`)
      .join(' &nbsp; ');
    const named = ch.activities.filter((p) => p.name).slice(0, 4);
    const metaBits = [
      `${(ch.distFromYou / 1000).toFixed(1)} km away`,
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

    L.circleMarker([ch.lat, ch.lon], {
      radius: 9, color: '#0b8a5f', weight: 2, fillColor: '#2fbf87', fillOpacity: 0.85,
    })
      .bindTooltip(`${i + 1}. ${escapeHtml(title)}`)
      .on('click', () => focusCharger(i))
      .addTo(chargerLayer);
  });

  if (results.length) {
    const bounds = L.latLngBounds(results.map((c) => [c.lat, c.lon]));
    bounds.extend([currentOrigin.lat, currentOrigin.lon]);
    map.fitBounds(bounds, { padding: [30, 30] });
  }
}

function focusCharger(i) {
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
  if (originMarker) originMarker.remove();
  originMarker = L.marker([origin.lat, origin.lon]).bindTooltip('You').addTo(map);
}

async function search(e) {
  e?.preventDefault();
  if (!INDEX) return setStatus('No charger data found. Build it first: python3 scripts/build_data.py <file.osm.pbf> data', true);

  const selectedKeys = new Set([...document.querySelectorAll('#activities input:checked')].map((el) => el.value));
  if (!selectedKeys.size) return setStatus('Pick at least one activity.', true);

  const dwell = +$('dwell').value;
  const radius = +$('radius').value;
  const walkM = walkRadiusMeters(dwell);
  $('go').disabled = true;

  try {
    const placeText = $('place').value.trim();
    if (placeText && placeText !== 'My location') {
      setStatus('Finding place…');
      setOrigin(await geocode(placeText));
    }
    if (!currentOrigin) throw new Error('Enter a place or tap 📍 to use your location.');

    setStatus('Loading chargers…');
    const chargers = await chargersNear(currentOrigin, radius);
    results = rankChargers(chargers, {
      walkM, dwell, selectedKeys, rapidOnly: $('rapid').checked, needToilets: $('toilets').checked,
    });
    lastWalkM = walkM;
    renderResults(dwell);

    const labels = ACTIVITIES.filter((c) => selectedKeys.has(c.key)).map((c) => c.label.toLowerCase());
    setStatus(results.length
      ? `Top ${results.length} of ${chargers.length} chargers nearby with ${labels.join(' / ')} within a ${walkMins(walkM)}-min walk.`
      : chargers.length
        ? `${chargers.length} chargers nearby, but none with that within a ${walkMins(walkM)}-min walk. Try a longer stop or more activities.`
        : 'No chargers found in this area. Try a bigger search area.');
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    $('go').disabled = false;
  }
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
$('place').addEventListener('input', () => { if ($('place').value !== 'My location') currentOrigin = null; });
$('search').addEventListener('submit', search);

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
