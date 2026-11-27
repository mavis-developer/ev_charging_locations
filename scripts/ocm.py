"""Fetch UK charging sites from the Open Charge Map API and convert them to the build's charger records.

API docs: https://github.com/openchargemap/ocm-docs (Model/schema/ocm-openapi-spec.yaml).
A free API key comes from https://openchargemap.org/profile -> My Apps -> Register an application.
"""
import json
import os
import re
import time
import urllib.parse
import urllib.request

API = 'https://api.openchargemap.io/v3'
USER_AGENT = 'charge-and-do-build/1.0 (weekly UK data build)'
PAGE_SIZE = 1000

# Usage types (from /referencedata): 2 = Private - Restricted Access, 3 = Privately Owned - Notice Required.
EXCLUDED_USAGE = {2, 3}
CUSTOMERS_USAGE = {6}       # Private - For Staff, Visitors or Customers
MEMBERSHIP_USAGE = {4}      # Public - Membership Required
# Status types: 100 Not Operational, 150 Planned, 200 Removed, 210 Removed (duplicate).
EXCLUDED_STATUS = {100, 150, 200, 210}

CONNECTOR_NAMES = {
    25: 'Type 2', 1036: 'Type 2 (tethered)', 33: 'CCS', 32: 'CCS1', 2: 'CHAdeMO',
    1: 'Type 1', 3: '3-pin plug', 27: 'Tesla', 30: 'Tesla', 8: 'Tesla',
}


def _get(path, key, params, retries=4):
    url = '%s/%s?%s' % (API, path, urllib.parse.urlencode(params))
    req = urllib.request.Request(url, headers={'X-API-Key': key, 'User-Agent': USER_AGENT})
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=120) as res:
                return json.load(res)
        except Exception as e:  # network errors, 5xx, rate limiting
            if attempt == retries - 1:
                raise RuntimeError('Open Charge Map request failed: %s (%s)' % (e, path))
            time.sleep(5 * 2 ** attempt)


def fetch_gb(key, log=print):
    """Return (pois, referencedata) for all open-licensed UK sites, paging by ID."""
    ref = _get('referencedata/', key, {'output': 'json'})
    pois, last_id = [], 0
    while True:
        page = _get('poi/', key, {
            'output': 'json', 'countrycode': 'GB', 'opendata': 'true',
            'compact': 'true', 'verbose': 'false', 'includecomments': 'false',
            'sortby': 'id_asc', 'greaterthanid': last_id, 'maxresults': PAGE_SIZE,
        })
        if not page:
            break
        pois.extend(page)
        last_id = max(p['ID'] for p in page)
        log('  Open Charge Map: %d sites so far' % len(pois))
        if len(page) < PAGE_SIZE:
            break
        time.sleep(1)  # be gentle with a free service
    return pois, ref


def load_or_fetch(key, cache_path=None, max_age_h=24, log=print):
    """Fetch from the API, or reuse a recent local copy (handy when re-running the build locally)."""
    if cache_path and os.path.exists(cache_path) and time.time() - os.path.getmtime(cache_path) < max_age_h * 3600:
        log('  Using cached Open Charge Map data from %s' % cache_path)
        with open(cache_path, encoding='utf-8') as f:
            data = json.load(f)
        return data['pois'], data['ref']
    pois, ref = fetch_gb(key, log)
    if cache_path:
        with open(cache_path, 'w', encoding='utf-8') as f:
            json.dump({'pois': pois, 'ref': ref}, f)
    return pois, ref


def to_chargers(pois, ref):
    """Convert OCM POIs to charger records; returns (chargers, data providers used)."""
    operators = {o['ID']: o['Title'] for o in ref.get('Operators', [])}
    conn_titles = {c['ID']: c['Title'].strip() for c in ref.get('ConnectionTypes', [])}
    providers = {d['ID']: d for d in ref.get('DataProviders', [])}

    out, used_providers = [], set()
    for p in pois:
        a = p.get('AddressInfo') or {}
        lat, lon = a.get('Latitude'), a.get('Longitude')
        if lat is None or lon is None:
            continue
        if p.get('StatusTypeID') in EXCLUDED_STATUS or p.get('UsageTypeID') in EXCLUDED_USAGE:
            continue

        conns = [c for c in (p.get('Connections') or []) if c.get('StatusTypeID') not in EXCLUDED_STATUS]
        kw = max((c.get('PowerKW') or 0 for c in conns), default=0)
        cx = {}  # connector name -> highest kW seen for it at this site
        for c in conns:
            name = CONNECTOR_NAMES.get(c.get('ConnectionTypeID')) or conn_titles.get(c.get('ConnectionTypeID'))
            if not name or name.startswith('Unknown'):
                continue
            ckw = round(c['PowerKW'], 1) if c.get('PowerKW') else None
            prev = cx.get(name)
            cx[name] = ckw if prev is None else (max(prev, ckw) if ckw else prev)
        points = p.get('NumberOfPoints') or sum(c.get('Quantity') or 1 for c in conns) or None

        op = operators.get(p.get('OperatorID'))
        if op and op.startswith('('):  # "(Unknown Operator)", "(Business Owner at Location)"
            op = None
        cost = (p.get('UsageCost') or '').strip() or None
        if cost and len(cost) > 80:
            cost = cost[:77] + '…'

        used_providers.add(p.get('DataProviderID'))
        out.append({
            'id': 'ocm%d' % p['ID'],
            'src': 'ocm',
            'lat': lat, 'lon': lon,
            'name': a.get('Title') or op,
            'op': op,
            'kw': round(kw, 1) if kw else None,
            'cx': [[n, k] for n, k in cx.items()],
            'pts': points,
            'cost': cost,
            'fee': 'no' if cost and re.match(r'^\s*free\b', cost, re.I) else None,
            'acc': 'customers' if p.get('UsageTypeID') in CUSTOMERS_USAGE else None,
            'mem': p.get('UsageTypeID') in MEMBERSHIP_USAGE,
            'wc': False,
        })

    attribution = []
    for pid in sorted(x for x in used_providers if x is not None):
        d = providers.get(pid, {})
        attribution.append({'name': d.get('Title', 'Provider %s' % pid), 'licence': (d.get('License') or '').strip()})
    return out, attribution
