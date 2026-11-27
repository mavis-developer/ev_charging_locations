# Charge & Do

Find a UK EV charger with something worth doing while the car charges.

Most charger apps start from the charger and leave you to check what's nearby. This one starts from the activity:
you say how long you'll stop and what you want to do (coffee, food, a walk, shopping, culture, entertainment),
and it ranks nearby chargers by what's within a short walk.

## How it works

There's no live server. A GitHub Action rebuilds the data every week and publishes it with the site on GitHub Pages:

```
Open Charge Map API (UK, open-licensed)  ─┐
Geofabrik UK extract (.osm.pbf, ~2.3 GB) ─┤
  └─ scripts/build_data.py (+ scripts/ocm.py)
       ├─ chargers: Open Charge Map is the main source (removed / planned / private sites skipped);
       │   OSM chargers within 50 m of an OCM site fill its gaps, the rest are added as extra sites
       ├─ places (cafés, parks, museums… per categories.json) from OSM
       ├─ for each charger, keeps the 10 nearest places per category within 1.2 km
       └─ writes data/index.json + data/tiles/<i>_<j>.json  (0.5° squares)
  └─ GitHub Pages serves index.html, app.js, categories.json and data/
```

Open Charge Map needs a free API key (openchargemap.org → sign in → My profile → My Apps → Register an application).
It's stored as the repo secret `OPEN_CHARGE_MAP_NOV_2026` (the workflow passes it to the build as `OCM_API_KEY`). Without it, the build falls back to OpenStreetMap chargers only.

In the browser, the app loads only the 1–4 tiles that overlap your search area, then filters and ranks locally,
so a search takes well under a second.

- **Walking radius from stop length.** One-way walk = 20% of the stop, clamped to 4–15 min (at 80 m/min).
  A 20-min top-up looks ~320 m around the charger; a 3-hour stop looks ~1.2 km.
- **Ranking** (`rankChargers` in `app.js`): each place within the walk adds points. Closer and named places add more,
  and so does a mix of categories. Activities that don't suit the stop length (e.g. a cinema on a 20-min stop) count
  less. Chargers further from you get a small penalty.
- **Distance to parks** is measured to the nearest point of the park's outline, not its centre.
- **Place search** uses postcodes.io for UK postcodes and Nominatim (limited to the UK) for anything else.
- **Journey mode** ("On a journey"): gets a driving route from a free OSRM server (routing.openstreetmap.de, with
  router.project-osrm.org as backup), samples a point every ~400 m, and keeps chargers within 1/3/8 km of it in the
  part of the trip you choose (around halfway by default). Detours count as there-and-back and are penalised harder
  than in "Near a place". "Rapid only" switches on by default, since a slow charger adds little range on a trip.

Activity categories live in `categories.json`, which both the build script and the app read. Adding a category
there and rebuilding is all it takes.

## Run it locally

```sh
python3 -m venv .venv && .venv/bin/pip install osmium

# Small test area (~50 MB, builds in seconds). Use united-kingdom-latest.osm.pbf for everything.
curl -L -o somerset.osm.pbf https://download.geofabrik.de/europe/united-kingdom/england/somerset-latest.osm.pbf
export OCM_API_KEY=your-key   # optional; --ocm-cache avoids re-downloading on repeat runs
.venv/bin/python scripts/build_data.py somerset.osm.pbf data --ocm-cache ocm-gb.json

python3 -m http.server 8000   # open http://localhost:8000
```

## Deploying

The workflow in `.github/workflows/deploy.yml` runs on every push to `main`, every Monday at 04:00 UTC, and on demand
(Actions tab → "Build data and deploy" → Run workflow). One-time setup: repo **Settings → Pages → Source: GitHub Actions**.

## Known limitations

- **No live availability.** Open Charge Map and OSM say where chargers are, not whether they're free right now.
- **Some records are old.** Open Charge Map entries can be years since last verified; the build skips ones marked
  removed or not operational, but can't catch everything.
- **Licensing:** the build requests `opendata=true` from Open Charge Map, and the page shows each data provider's
  attribution as its licence requires.
- **Data is up to a week old.** Fine for chargers and cafés, which rarely move.
- **No opening hours check.** A café that's closed at 7pm still counts.
- **UK only** for now. Other countries need their Geofabrik extract added to the workflow.

## Next steps

- Filter places by `opening_hours` at the planned arrival time.
- Live availability from operators' open data feeds (UK Public Charge Point Regulations 2023 require them).
- Journey mode: tell apart motorway services for each direction (e.g. Reading Eastbound vs Westbound) so only the
  side you can reach is shown.
- Car profile (max charge rate, connector) for accurate time-to-80% estimates.
