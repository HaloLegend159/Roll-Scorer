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

## Where the data comes from

- **Bungie manifest**: every weapon, which perks each can roll, descriptions and icons.
- **DIM community wish list** (voltron.txt): recommended rolls and curator notes.
- **Real matches** (`scripts/collect-usage.mjs`): each run samples a few hundred recent matches,
  reads the equipped weapons of the players in them, and adds their perks to a running tally in
  `data/usage/`. Old counts fade about 3% per run so it follows the current meta.
- **Your inventory** (My inventory page): read live from Bungie when you sign in.

The workflow runs daily. If a build looks broken (weapon or roll counts drop sharply) it refuses to
publish and keeps the old data; GitHub emails you about the failed run. To publish anyway, run it by
hand with **force** ticked.

## Pages

- **Score a roll**: pick perks on any weapon. Craftable weapons are labeled.
- **My inventory**: sign in with Bungie to score everything you own.
- **Compare**: put up to three guns side by side (best roll, stats, usage rank), and see every gun
  of a type ranked by how often it shows up in sampled matches. The ☆ next to any weapon saves it
  as a favorite in your browser; favorites are quick picks here and a filter in My inventory.
- **Apply perks in game**: with `allowPerkChanges: true` in `config.js` and the "Move or equip
  Destiny gear" scope ticked on the Bungie app, signed-in players get an Apply button that switches
  a weapon between the perks it already has (`apply.js`). Bungie only allows this in orbit, in a
  social space, or offline. Crafted weapons and Postmaster items aren't covered.
- **Xûr**: the random-roll weapons Xûr is selling, scored. The daily update saves his list from
  Bungie's public data (`scripts/collect-xur.mjs`, plus an extra run Fridays after he arrives).
  If Bungie doesn't share the exact rolls publicly, signed-in players still see their own.

## Stats and usage over time

- **Stats**: the Score a roll page shows each weapon's stats and how the picked perks change them,
  worked out from Bungie's game data. Masterworks, mods and conditional bonuses aren't included.
- **Usage over time**: `collect-usage.mjs` also keeps a day-by-day tally in `data/usage/history.json`
  (120 days). The chart shows a gun's share of all weapons seen, which only moves when players
  switch guns, not when more or fewer people are playing.

## How the score works

For the chosen activity (All / PvE / PvP):

- **Closeness (55%)**: how many perks you share with the nearest recommended roll.
- **Perk strength (45%)**: how often each of your perks appears in recommended rolls that go with
  your other picks, compared with the best option in that column. Traits count 3×, barrel and
  magazine 1×, origin traits 0.5×.
- **Real usage**: once at least 30 copies of a gun have been seen in matches, how often players run
  your perks is blended in at 20%, but only when that raises the score. A rare god roll that few
  people own is still a god roll. For guns whose roll data is only an estimate, usage counts for
  60% either way.

Grades: 90+ God roll, 75+ Keeper, 55+ Solid, 35+ Situational, below that Shard it.

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
