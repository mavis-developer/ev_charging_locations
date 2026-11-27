#!/usr/bin/env python3
"""Pre-compute EV chargers and the things to do near each one from an OpenStreetMap extract.

Writes small JSON "tiles" (TILE_DEG x TILE_DEG squares) so the web app can load just the
area around the user instead of querying a live service.

Usage:
    python scripts/build_data.py united-kingdom-latest.osm.pbf data/

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

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

MAX_WALK_M = 1200     # longest one-way walk the app uses (walkRadiusMeters in app.js)
PER_CAT_CAP = 10      # nearest N places kept per activity category per charger
FACILITY_CAP = 3      # nearest N toilets kept per charger
TILE_DEG = 0.5        # output tile size (~55 km north-south)
GRID_DEG = 0.01       # spatial index cell size (~1 km)
DEDUPE_M = 25         # charger points closer than this are merged into one site
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
SOCKET_NAMES = {
    'type2': 'Type 2', 'type2_combo': 'CCS', 'chademo': 'CHAdeMO', 'type1': 'Type 1',
    'type1_combo': 'CCS1', 'tesla_supercharger': 'Tesla', 'nacs': 'NACS',
    'type2_cable': 'Type 2 (tethered)', 'bs1363': '3-pin plug', 'type3c': 'Type 3C',
}


def max_power_kw(tags):
    best = 0.0
    for k, v in tags.items():
        if not OUTPUT_KEY.match(k):
            continue
        for part in re.split(r'[;,]', v):
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


def socket_types(tags):
    out = []
    for k, v in tags.items():
        m = SOCKET_KEY.match(k)
        if m and v not in ('no', '0'):
            name = SOCKET_NAMES.get(m.group(1), m.group(1))
            if name not in out:
                out.append(name)
    return out


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
                'id': oid, 'lat': lat, 'lon': lon,
                'name': t.get('name') or t.get('operator') or t.get('network') or t.get('brand'),
                'kw': max_power_kw(t),
                'sk': socket_types(t),
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


def dedupe_chargers(chargers):
    """Merge charger points within DEDUPE_M of each other (OSM often maps one site several times)."""
    # Prefer entries with more information as the surviving record.
    chargers.sort(key=lambda c: (c['kw'] is None, c['name'] is None, -len(c['sk'])))
    grid = defaultdict(list)
    kept = []
    for c in chargers:
        ci, cj = cell(c['lat'], c['lon'])
        match = None
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                for k in grid[(ci + di, cj + dj)]:
                    if haversine(c['lat'], c['lon'], k['lat'], k['lon']) <= DEDUPE_M:
                        match = k
                        break
                if match:
                    break
            if match:
                break
        if match:
            if c['kw'] and (not match['kw'] or c['kw'] > match['kw']):
                match['kw'] = c['kw']
            match['sk'] += [s for s in c['sk'] if s not in match['sk']]
            match['name'] = match['name'] or c['name']
            match['wc'] = match['wc'] or c['wc']
        else:
            grid[(ci, cj)].append(c)
            kept.append(c)
    return kept


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


def write_tiles(chargers, places, out_dir, source):
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
            for k in ('name', 'kw', 'sk', 'fee', 'acc', 'wc'):
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
    args = ap.parse_args()

    t0 = time.time()
    cats, lookup, keys = load_categories()
    print('Reading %s …' % args.pbf, flush=True)
    chargers, places = read_osm(args.pbf, lookup, keys)
    print('  %d charger points, %d places (%.0fs)' % (len(chargers), len(places), time.time() - t0), flush=True)

    chargers = dedupe_chargers(chargers)
    print('  %d charger sites after merging duplicates' % len(chargers), flush=True)

    attach_nearby(chargers, places, cats)
    with_any = sum(1 for c in chargers if c['near'])
    print('  %d sites have something within %d m (%.0fs)' % (with_any, MAX_WALK_M, time.time() - t0), flush=True)

    n_tiles, size = write_tiles(chargers, places, args.out_dir, args.source or os.path.basename(args.pbf))
    print('Wrote %d tiles, %.1f MB total, to %s (%.0fs)' % (n_tiles, size / 1e6, args.out_dir, time.time() - t0))


if __name__ == '__main__':
    sys.exit(main())
