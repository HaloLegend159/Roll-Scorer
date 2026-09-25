# Roll Scorer

Pick the perks on a Destiny 2 weapon and get a 0–100 score based on community recommended rolls.

Weapons and perks come from the Bungie API manifest. Roll data comes from the
[DIM community wish list](https://github.com/48klocs/dim-wish-list-sources) (voltron.txt),
the same data DIM uses for its thumbs-up icons. A GitHub Action rebuilds the data twice a week.

## Setup

1. Push this folder to a new GitHub repo.
2. Get a free Bungie API key at https://www.bungie.net/en/Application (create an app; OAuth type "Not applicable" is fine).
3. In the repo: **Settings → Secrets and variables → Actions → New repository secret**, name it `BUNGIE_API_KEY`.
4. **Actions tab → Update roll data → Run workflow.** It takes a few minutes and commits the `data/` folder.
5. **Settings → Pages →** Source: *Deploy from a branch*, Branch: `main`, folder `/ (root)`.

Your site will be at `https://<username>.github.io/<repo>/`.

## How the score works

For the chosen activity (All / PvE / PvP):

- **Closeness (55%)**: how many perks you share with the nearest recommended roll in the wish list.
  Matching a recommended roll exactly gives full marks here.
- **Perk strength (45%)**: for each column, how often your perk shows up in recommended rolls
  compared with the most popular perk in that column. Trait columns count 3×, barrel and magazine 1×,
  origin traits 0.5×.

Grades: 90+ God roll, 75+ Keeper, 55+ Solid, 35+ Situational, below that Shard it.

Tweak the weights in `score()` in `app.js` and the column weights in `columnWeight()` in `scripts/build-data.mjs`.

## Running the data build locally

```
set BUNGIE_API_KEY=your-key-here
node scripts/build-data.mjs
py -m http.server 8000
```

Then open http://localhost:8000. Node 20+ is required.

## Files

- `index.html`, `style.css`, `app.js`: the site (no build step)
- `scripts/build-data.mjs`: pulls the manifest + wish list and writes `data/`
- `.github/workflows/update-data.yml`: runs the build on a schedule and commits the result
