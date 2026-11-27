# Charge & Do

Find a UK EV charger with something worth doing while the car charges.

Most charger apps start from the charger and leave you to check what's nearby. This one starts from the activity:
you say how long you'll stop and what you want to do (coffee, food, a walk, shopping, culture, entertainment),
and it ranks nearby chargers by what's within a short walk.

## How it works

There's no live server. A GitHub Action rebuilds the data every week and publishes it with the site on GitHub Pages:

```
Geofabrik UK extract (.osm.pbf, ~2.3 GB)
  └─ scripts/build_data.py
       ├─ picks out public chargers + places (cafés, parks, museums… per categories.json)
       ├─ merges duplicate charger points within 25 m
       ├─ for each charger, keeps the 10 nearest places per category within 1.2 km
       └─ writes data/index.json + data/tiles/<i>_<j>.json  (0.5° squares)
  └─ GitHub Pages serves index.html, app.js, categories.json and data/
```

In the browser, the app loads only the 1–4 tiles that overlap your search area, then filters and ranks locally,
so a search takes well under a second.

- **Walking radius from stop length.** One-way walk = 20% of the stop, clamped to 4–15 min (at 80 m/min).
  A 20-min top-up looks ~320 m around the charger; a 3-hour stop looks ~1.2 km.
- **Ranking** (`rankChargers` in `app.js`): each place within the walk adds points. Closer and named places add more,
  and so does a mix of categories. Activities that don't suit the stop length (e.g. a cinema on a 20-min stop) count
  less. Chargers further from you get a small penalty.
- **Distance to parks** is measured to the nearest point of the park's outline, not its centre.
- **Place search** uses postcodes.io for UK postcodes and Nominatim (limited to the UK) for anything else.

Activity categories live in `categories.json`, which both the build script and the app read. Adding a category
there and rebuilding is all it takes.

## Run it locally

```sh
python3 -m venv .venv && .venv/bin/pip install osmium

# Small test area (~50 MB, builds in seconds). Use united-kingdom-latest.osm.pbf for everything.
curl -L -o somerset.osm.pbf https://download.geofabrik.de/europe/united-kingdom/england/somerset-latest.osm.pbf
.venv/bin/python scripts/build_data.py somerset.osm.pbf data

python3 -m http.server 8000   # open http://localhost:8000
```

## Deploying

The workflow in `.github/workflows/deploy.yml` runs on every push to `main`, every Monday at 04:00 UTC, and on demand
(Actions tab → "Build data and deploy" → Run workflow). One-time setup: repo **Settings → Pages → Source: GitHub Actions**.

## Known limitations

- **OSM charger data is incomplete.** Power ratings are often missing, and there's no live availability or pricing.
- **Data is up to a week old.** Fine for chargers and cafés, which rarely move.
- **No opening hours check.** A café that's closed at 7pm still counts.
- **UK only** for now. Other countries need their Geofabrik extract added to the workflow.

## Next steps

- Filter places by `opening_hours` at the planned arrival time.
- Better charger data (power, live availability) from Open Charge Map or a commercial feed, merged in at build time.
- Route mode: "find a stop around 150 km into my journey" instead of "near me".
- Car profile (max charge rate, connector) for accurate time-to-80% estimates.
