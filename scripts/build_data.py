#!/usr/bin/env python3
"""Pre-compute EV chargers and the things to do near each one.

Chargers come from Open Charge Map (main source, needs OCM_API_KEY) plus OpenStreetMap
(fills gaps). Places to visit come from OpenStreetMap. Writes small JSON "tiles"
(TILE_DEG x TILE_DEG squares) so the web app loads just the area around the user.

Usage:
    OCM_API_KEY=... python scripts/build_data.py united-kingdom-latest.osm.pbf data/
    (without OCM_API_KEY the build uses OpenStreetMap chargers only)

Output:
    data/index.json            build date, settings, list of tiles
    data/tiles/<i>_<j>.json    chargers in that square + the places near them
"""
import argparse
import datetime
import json
import math
import os
import re
import sys
import time
from collections import defaultdict

import osmium

import ocm

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

MAX_WALK_M = 1200     # longest one-way walk the app uses (walkRadiusMeters in app.js)
PER_CAT_CAP = 10      # nearest N places kept per activity category per charger
FACILITY_CAP = 3      # nearest N toilets kept per charger
TILE_DEG = 0.5        # output tile size (~55 km north-south)
GRID_DEG = 0.01       # spatial index cell size (~1 km)
DEDUPE_M = 25         # OSM charger points closer than this are merged into one site
OCM_DEDUPE_M = 30     # Open Charge Map entries closer than this are one site (often listed per operator/floor)
MERGE_M = 50          # an OSM charger this close to an Open Charge Map site is the same site
AREA_SAMPLES = 24     # outline points kept for big areas (parks), so distance is to the edge
SMALL_AREA_M = 150    # areas smaller than this are treated as a single point


def load_categories():
    with open(os.path.join(ROOT, 'categories.json'), encoding='utf-8') as f:
        cats = json.load(f)['categories']
    lookup = {}
    for i, c in enumerate(cats):
        for k, values in c['tags'].items():
            for v in values:
                lookup[(k, v)] = i
    keys = sorted({k for k, _ in lookup})
    return cats, lookup, keys


def haversine(lat1, lon1, lat2, lon2):
    r = math.pi / 180
    dlat, dlon = (lat2 - lat1) * r, (lon2 - lon1) * r
    s = math.sin(dlat / 2) ** 2 + math.cos(lat1 * r) * math.cos(lat2 * r) * math.sin(dlon / 2) ** 2
    return 2 * 6371000 * math.asin(math.sqrt(s))


OUTPUT_KEY = re.compile(r'^(socket:.+:output|charging_station:output)$')
SOCKET_KEY = re.compile(r'^socket:([a-z0-9_]+)$')
# Display names for OSM socket:* keys. The app's connector filter groups on these names
# (Type 2, CCS, CHAdeMO, Tesla, 3-pin plug), so keep them in step with CONNECTOR_GROUPS in app.js.
SOCKET_NAMES = {
    'type2': 'Type 2', 'type2_combo': 'CCS', 'chademo': 'CHAdeMO', 'type1': 'Type 1',
    'type1_combo': 'CCS1', 'tesla_supercharger': 'Tesla', 'nacs': 'NACS',
    'tesla_supercharger_ccs': 'CCS', 'ccs': 'CCS',
    'type2_cable': 'Type 2 (tethered)', 'bs1363': '3-pin plug', 'type3c': 'Type 3C',
    'schuko': 'Schuko', 'cee_blue': 'Blue Commando',
}


def parse_output_kw(value):
    """Highest power in an OSM *:output value such as '22 kW', '7;22 kW' or '50000'."""
    best = 0.0
    for part in re.split(r'[;,]', value):
        m = re.match(r'^([\d.]+)\s*(kw|w|kva)?$', part.strip(), re.I)
        if not m:
            continue
        try:
            kw = float(m.group(1))
        except ValueError:
            continue
        unit = (m.group(2) or '').lower()
        if unit == 'w' or (not unit and kw > 1000):
            kw /= 1000
        if best < kw < 1000:
            best = kw
    return round(best, 1) if best else None


def max_power_kw(tags):
    outs = [parse_output_kw(v) for k, v in tags.items() if OUTPUT_KEY.match(k)]
    outs = [x for x in outs if x]
    return max(outs) if outs else None


def connectors(tags):
    """[[name, kW or None], …] from OSM socket:<type> and socket:<type>:output tags."""
    cx = {}
    for k, v in tags.items():
        m = SOCKET_KEY.match(k)
        if not m or v in ('no', '0'):
            continue
        name = SOCKET_NAMES.get(m.group(1), m.group(1).replace('_', ' ').capitalize())
        out = tags.get('socket:%s:output' % m.group(1))
        cx[name] = max_kw(cx.get(name), parse_output_kw(out) if out else None)
    return [[n, kw] for n, kw in cx.items()]


def max_kw(a, b):
    return max(x for x in (a, b) if x is not None) if (a is not None or b is not None) else None


def merge_connectors(a, b):
    """Union of two connector lists, keeping the higher power for a connector on both."""
    cx = {n: kw for n, kw in a}
    for n, kw in b:
        cx[n] = max_kw(cx.get(n), kw) if n in cx else kw
    return [[n, kw] for n, kw in cx.items()]


def area_points(obj):
    """Outline points of an area's outer rings (thinned), or None if geometry is broken."""
    pts = []
    try:
        for ring in obj.outer_rings():
            pts.extend((n.lat, n.lon) for n in ring)
    except Exception:
        return None
    return pts or None


def summarise_points(pts):
    """Return (centroid, representative points) for a shape."""
    lat = sum(p[0] for p in pts) / len(pts)
    lon = sum(p[1] for p in pts) / len(pts)
    lats, lons = [p[0] for p in pts], [p[1] for p in pts]
    size = haversine(min(lats), min(lons), max(lats), max(lons))
    if size < SMALL_AREA_M:
        return (lat, lon), [(lat, lon)]
    step = max(1, len(pts) // AREA_SAMPLES)
    return (lat, lon), [(lat, lon)] + pts[::step]


def read_osm(path, cat_lookup, keys):
    chargers, places = [], []
    key_filter = osmium.filter.KeyFilter(*keys)
    fp = (osmium.FileProcessor(path)
          .with_locations()
          .with_areas(key_filter)
          .with_filter(key_filter))
    for obj in fp:
        if obj.is_node():
            if not obj.location.valid():
                continue
            pts = [(obj.location.lat, obj.location.lon)]
            oid = 'n%d' % obj.id
        elif obj.is_area():
            pts = area_points(obj)
            if not pts:
                continue
            oid = ('w%d' if obj.from_way() else 'r%d') % obj.orig_id()
        else:
            continue  # plain ways/relations; closed ones come through again as areas

        tags = obj.tags
        if tags.get('access') in ('private', 'no', 'employees'):
            continue

        if tags.get('amenity') == 'charging_station':
            t = {tag.k: tag.v for tag in tags}
            (lat, lon), _ = summarise_points(pts)
            chargers.append({
                'id': oid, 'src': 'osm', 'lat': lat, 'lon': lon,
                'name': t.get('name') or t.get('operator') or t.get('network') or t.get('brand'),
                'op': t.get('operator') or t.get('network') or t.get('brand'),
                'kw': max_power_kw(t),
                'cx': connectors(t),
                'fee': t.get('fee'),
                'acc': t.get('access') if t.get('access') == 'customers' else None,
                'wc': t.get('toilets') == 'yes',
            })
            continue

        cat = None
        for k in keys:
            v = tags.get(k)
            if v is not None and (k, v) in cat_lookup:
                cat = cat_lookup[(k, v)]
                break
        if cat is None:
            continue
        centroid, rep = summarise_points(pts)
        places.append({'lat': centroid[0], 'lon': centroid[1], 'pts': rep, 'cat': cat, 'name': tags.get('name')})
    return chargers, places


def cell(lat, lon):
    return (math.floor(lat / GRID_DEG), math.floor(lon / GRID_DEG))


def dedupe_chargers(chargers, radius=DEDUPE_M):
    """Merge charger points within DEDUPE_M of each other (OSM often maps one site several times)."""
    # Prefer entries with more information as the surviving record.
    chargers.sort(key=lambda c: (c['kw'] is None, c['name'] is None, -len(c['cx'])))
    grid = defaultdict(list)
    kept = []
    for c in chargers:
        ci, cj = cell(c['lat'], c['lon'])
        match = None
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                for k in grid[(ci + di, cj + dj)]:
                    if haversine(c['lat'], c['lon'], k['lat'], k['lon']) <= radius:
                        match = k
                        break
                if match:
                    break
            if match:
                break
        if match:
            if c['kw'] and (not match['kw'] or c['kw'] > match['kw']):
                match['kw'] = c['kw']
            match['cx'] = merge_connectors(match['cx'], c['cx'])
            match['name'] = match['name'] or c['name']
            match['wc'] = match['wc'] or c['wc']
            # Several operators at one site (e.g. Tesla + InstaVolt at services): list them all.
            if c.get('op') and c['op'] not in (match.get('op') or ''):
                match['op'] = '%s, %s' % (match['op'], c['op']) if match.get('op') else c['op']
            if c.get('pts'):
                match['pts'] = (match.get('pts') or 0) + c['pts']
            match['cost'] = match.get('cost') or c.get('cost')
            # The site is open to everyone if any entry there is.
            if not c.get('acc'):
                match['acc'] = None
            if not c.get('mem'):
                match['mem'] = False
            if match.get('fee') == 'no' and c.get('fee') != 'no':
                match['fee'] = c.get('fee')  # only "free" if every entry there is free
        else:
            grid[(ci, cj)].append(c)
            kept.append(c)
    return kept


def merge_sources(ocm_chargers, osm_chargers):
    """Open Charge Map sites win; an OSM charger within MERGE_M of one fills in its gaps,
    otherwise it's kept as an extra site OCM doesn't know about."""
    grid = defaultdict(list)
    for c in ocm_chargers:
        grid[cell(c['lat'], c['lon'])].append(c)
    extra, merged = [], 0
    for o in osm_chargers:
        ci, cj = cell(o['lat'], o['lon'])
        best, best_d = None, MERGE_M
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                for c in grid.get((ci + di, cj + dj), ()):
                    d = haversine(o['lat'], o['lon'], c['lat'], c['lon'])
                    if d <= best_d:
                        best, best_d = c, d
        if best is None:
            extra.append(o)
            continue
        merged += 1
        for k in ('kw', 'name', 'op', 'fee'):
            if not best.get(k) and o.get(k):
                best[k] = o[k]
        best['cx'] = merge_connectors(best['cx'], o['cx'])
        best['wc'] = best['wc'] or o['wc']
    return ocm_chargers + extra, merged, len(extra)


def attach_nearby(chargers, places, cats):
    """For each charger, find the nearest places per category within MAX_WALK_M."""
    grid = defaultdict(list)
    for pi, p in enumerate(places):
        seen = set()
        for lat, lon in p['pts']:
            key = cell(lat, lon)
            if key not in seen:
                seen.add(key)
                grid[key].append(pi)

    dlat_cells = math.ceil(MAX_WALK_M / (111320 * GRID_DEG))
    for c in chargers:
        dlon_cells = math.ceil(MAX_WALK_M / (111320 * math.cos(math.radians(c['lat'])) * GRID_DEG))
        ci, cj = cell(c['lat'], c['lon'])
        best = {}
        for i in range(ci - dlat_cells, ci + dlat_cells + 1):
            for j in range(cj - dlon_cells, cj + dlon_cells + 1):
                for pi in grid.get((i, j), ()):
                    if pi in best:
                        continue
                    d = min(haversine(c['lat'], c['lon'], lat, lon) for lat, lon in places[pi]['pts'])
                    if d <= MAX_WALK_M:
                        best[pi] = d
        by_cat = defaultdict(list)
        for pi, d in best.items():
            by_cat[places[pi]['cat']].append((d, pi))
        near = []
        for cat, items in by_cat.items():
            cap = FACILITY_CAP if cats[cat].get('facility') else PER_CAT_CAP
            items.sort()
            near.extend((pi, round(d)) for d, pi in items[:cap])
        c['near'] = near


def write_tiles(chargers, places, out_dir, source, sources, attribution):
    tiles = defaultdict(list)
    for c in chargers:
        tiles['%d_%d' % (math.floor(c['lat'] / TILE_DEG), math.floor(c['lon'] / TILE_DEG))].append(c)

    tile_dir = os.path.join(out_dir, 'tiles')
    os.makedirs(tile_dir, exist_ok=True)
    total_bytes = 0
    for key, items in tiles.items():
        local = {}
        out_places = []
        out_chargers = []
        for c in items:
            near = []
            for pi, d in c['near']:
                if pi not in local:
                    p = places[pi]
                    local[pi] = len(out_places)
                    out_places.append([round(p['lat'], 5), round(p['lon'], 5), p['cat'], p['name']])
                near.append([local[pi], d])
            rec = {'id': c['id'], 'lat': round(c['lat'], 5), 'lon': round(c['lon'], 5), 'near': near}
            if c.get('op') == c.get('name'):
                c['op'] = None
            if c.get('cx'):
                # Connector power can be higher than an unset site power; keep the site figure honest.
                c['kw'] = max_kw(c.get('kw'), max((kw for _, kw in c['cx'] if kw), default=None))
            for k in ('src', 'name', 'op', 'kw', 'cx', 'pts', 'cost', 'fee', 'acc', 'mem', 'wc'):
                if c.get(k):
                    rec[k] = c[k]
            out_chargers.append(rec)
        path = os.path.join(tile_dir, key + '.json')
        with open(path, 'w', encoding='utf-8') as f:
            json.dump({'places': out_places, 'chargers': out_chargers}, f, ensure_ascii=False, separators=(',', ':'))
        total_bytes += os.path.getsize(path)

    index = {
        'built': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%MZ'),
        'source': source,
        'tileDeg': TILE_DEG,
        'maxWalkM': MAX_WALK_M,
        'perCatCap': PER_CAT_CAP,
        'chargers': len(chargers),
        'sources': sources,
        'attribution': attribution,
        'tiles': {k: len(v) for k, v in sorted(tiles.items())},
    }
    with open(os.path.join(out_dir, 'index.json'), 'w', encoding='utf-8') as f:
        json.dump(index, f, separators=(',', ':'))
    return len(tiles), total_bytes


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('pbf', help='OpenStreetMap extract (.osm.pbf), e.g. from download.geofabrik.de')
    ap.add_argument('out_dir', help='output directory, e.g. data/')
    ap.add_argument('--source', default=None, help='source label stored in index.json')
    ap.add_argument('--ocm-cache', default=None,
                    help='save/reuse Open Charge Map data here (reused if under 24h old), for local re-runs')
    args = ap.parse_args()

    t0 = time.time()
    cats, lookup, keys = load_categories()
    print('Reading %s …' % args.pbf, flush=True)
    osm_chargers, places = read_osm(args.pbf, lookup, keys)
    print('  %d OSM charger points, %d places (%.0fs)' % (len(osm_chargers), len(places), time.time() - t0), flush=True)

    osm_chargers = dedupe_chargers(osm_chargers)
    print('  %d OSM charger sites after merging duplicates' % len(osm_chargers), flush=True)

    attribution = [{'name': 'OpenStreetMap contributors', 'licence': 'ODbL 1.0'}]
    key = os.environ.get('OCM_API_KEY', '').strip()
    if key:
        print('Fetching Open Charge Map UK data …', flush=True)
        pois, ref = ocm.load_or_fetch(key, args.ocm_cache)
        ocm_chargers, ocm_attr = ocm.to_chargers(pois, ref)
        usable = len(ocm_chargers)
        ocm_chargers = dedupe_chargers(ocm_chargers, OCM_DEDUPE_M)
        print('  %d Open Charge Map entries usable (of %d) -> %d sites after merging same-site entries'
              % (usable, len(pois), len(ocm_chargers)), flush=True)
        chargers, merged, extra = merge_sources(ocm_chargers, osm_chargers)
        print('  %d OSM sites matched an OCM site; %d OSM-only sites added; %d total' % (merged, extra, len(chargers)), flush=True)
        sources = {'ocm': len(ocm_chargers), 'osmOnly': extra}
        attribution = [{'name': 'Open Charge Map: ' + a['name'], 'licence': a['licence']} for a in ocm_attr] + attribution
    else:
        print('OCM_API_KEY not set: using OpenStreetMap chargers only', flush=True)
        chargers = osm_chargers
        sources = {'ocm': 0, 'osmOnly': len(chargers)}

    attach_nearby(chargers, places, cats)
    with_any = sum(1 for c in chargers if c['near'])
    print('  %d sites have something within %d m (%.0fs)' % (with_any, MAX_WALK_M, time.time() - t0), flush=True)

    n_tiles, size = write_tiles(chargers, places, args.out_dir, args.source or os.path.basename(args.pbf),
                                sources, attribution)
    print('Wrote %d tiles, %.1f MB total, to %s (%.0fs)' % (n_tiles, size / 1e6, args.out_dir, time.time() - t0))


if __name__ == '__main__':
    sys.exit(main())
