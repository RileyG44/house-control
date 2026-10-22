# Launcher Home redesign: brief

Handoff brief, October 22, 2026. Self-contained: everything needed to redesign the TV launcher's
Home screen, plus two unfinished pieces of back-end work the redesign depends on.

## What Riley asked for (verbatim)

> I don't want a because you watched explainer. I just want a beautiful, minimalistic UI that auto
> populates with fresh picks daily (and if I'm watching a show/series, includes those) has menu
> weather info, my date and time, my personal greeting, and if possible, a tile of our 3D house that
> I can use to control the studio from the TV. I want you to take inspiration from the work of
> @rondesignlab (aka @rondesignlabs) on Instagram and redesign the UI for the launcher as if you were
> him. Attempt to copy the aesthetic as closely as possible. Before building, show me a couple images
> of what you're thinking you'd like to make.

Earlier, on the same feature:

> Also can we set it up so that the TV sends a log of everything I watched to the server and then
> have codex on the server run an automation every day at like 3AM to build a recommendation of
> titles and metadata for them that the launcher uses to populate smart recommendations?

> try to make sure we are as integrated with the streaming apps as is possible. Ideally I would like
> to see a nice catalog of recommended tiles for each app, just just a search bar

## Order of work

1. **Mockups first.** Make 2 Home-screen mockups at 1920×1080 (render HTML in Chrome headless, or
   similar) using real posters from the catalog and the 3D studio render. Show them to Riley and
   get a pick **before writing launcher code**.
2. **Smart picks back end** (needed for the "fresh daily picks" row; see below).
3. **Hulu show links** (see below).
4. **Build the chosen Home** in `tv-launcher/`, install on the TV, check it there.
5. Commit and push as you go (Riley prefers no asking for commits/pushes).

## Home screen contents

- Personal greeting ("Good evening, Riley"), the date and a large clock.
- Weather (the launcher already has weather in `glance/Glance.kt` / `ui/GlancePanel.kt`).
- **Fresh picks, refreshed daily**, with shows Riley is in the middle of always included, first.
- **No reason/explainer text anywhere** ("Because you watched…" is out), on TV and phone.
- A **3D studio tile** that controls the house (lights, AC) from the TV. Renders of the 3D studio
  are in `docs/studio.png`, `docs/hero.png`, `docs/island.png`; the hub serves device state and
  control (`hub/house.py`, `/api/...`, events stream). A first version can be a static render with
  focusable hotspots/room chips that toggle lights and show AC temperature; a live 3D view on a
  2 GB Chromecast is probably too heavy.
- Apps row and the per-app catalog rows still need to be reachable (they can move below the fold or
  to a second page).

## Ron Design Lab style notes

From 20 recent Dribbble shots, cached at `~/Library/Caches/ron-ref/d01–d20` (not in git;
`urls.txt` lists the sources). Most representative: d01, d02, d06, d09, d10, d12, d16, d17, d19.

- **Backgrounds:** soft, out-of-focus colour fields, as if shot through frosted glass. One or two
  saturated hues bleeding into near-black or warm grey (deep teal/green, electric blue, orange →
  magenta, olive/yellow). Heavy blur, a little film grain, vignette at the edges.
- **Cards:** big squircle radius (≈ 40–56 px at 1080p), translucent frosted fill (white 6–12 % on
  dark, or tinted glass), a 1 px inner highlight on the top edge, very soft large shadows, no hard
  borders. Cards often pick up the colour of what's behind them. Some hero cards are a full
  gradient (orange-to-pink, lime-to-green) with content laid on top.
- **Type:** a geometric grotesk in **light/regular weight** (Lexend, Urbanist, Manrope look),
  never bold except tiny labels. Huge, thin numerals for the key figure (clock, temperature, 8.574,
  93.420), with a small superscript unit. Dot-matrix numerals appear as an accent (d03, d15). Labels
  are small, low-contrast (white 45–60 %), sentence case. Very little text overall.
- **Controls:** pill-shaped buttons and segmented chips; circular icon buttons; the active one is a
  solid white circle with a dark icon. Thin line icons.
- **3D:** product/object renders sitting inside glass tiles (d11 filters, d02 earbuds, d06 drone map),
  softly lit, with the tile's tint reflecting on them. This is the model for the 3D studio tile.
- **Layout:** one hero object plus a few large cards, generous spacing, nothing dense. Thin line
  graphics (waveforms, orbit lines, sparklines) as decoration. Depth of field: off-focus elements
  blurred.
- **Motion hints:** focus grows the card slightly and brightens its glass; background colour drifts
  to the focused item's colour.

For the TV: the focused poster's backdrop can become the blurred colour field behind everything,
which gives the Ron look for free and changes with focus. Keep blur cheap on the Chromecast
(pre-blurred small bitmaps scaled up, not live RenderEffect on every frame).

## Context

- **Repo:** `~/Developer/house-control`. Launcher is `tv-launcher/` (Kotlin, Compose for TV).
  Main files: `ui/HomeScreen.kt` (595 lines), `ui/CatalogRows.kt`, `ui/GlancePanel.kt`,
  `ui/Theme.kt`, `catalog/Catalog.kt`, `history/HistoryStore.kt`.
- **Git:** push to the `fork` remote (`RileyG44/house-control`, branch `main`, at 14a8cc8 when this
  was written). `origin` is stale; don't push there. `git pull --rebase fork main` before pushing.
- **Docs:** `docs/tv-launcher.md` (launcher plan, API on :8686), `docs/streaming-catalog.md`
  (catalog design and what was built).
- **TV:** Chromecast with Google TV 4K ("sabrina"), Android 14, 32-bit ARM, 2 GB RAM, ~750 MB free.
  LAN 192.168.0.225. Wireless ADB is permanently paired with this Mac (`/opt/homebrew/bin/adb`;
  find the port with `adb mdns services`; if ADB says "No route to host", restart the adb server).
  Install with `tv-launcher/tools/tv-install.sh` (needs JDK 17 at /opt/homebrew/opt/openjdk@17).
  Watch memory with `adb shell dumpsys meminfo com.livingroom.tv`.
- **Hubs:** the Dell (192.168.0.127, port 8766) is primary: systemd `house-hub.service`, plain copy
  of the repo at `~/house-control` (not a git checkout). **Back it up before deploying**, then
  rsync `hub/` and restart. The Mac (192.168.0.188) is the backup hub. The hub's secrets are in
  `~/.house-hub/` (never commit).
- **Catalog API:** `GET http://192.168.0.127:8766/api/tv/catalog` →
  `{apps: [{id, name, pkg, rows: [{key, title, items: [Tile]}]}], forYou: [Tile], updatedAt}`.
  `forYou` currently starts with Continue items (`kind: "continue"`, with `progress`).
- **Slow posters:** the Dell's Wi-Fi is weak, so posters can take 7–40 s on a cold cache. Design
  for art arriving late (placeholders that look intentional, cache aggressively).

## Unfinished: nightly smart picks

Nothing of this was saved before the previous session was stopped; start fresh.

1. The launcher posts each history entry (`HistoryStore`: pkg, title, subtitle, progress,
   timestamps, JustWatch match if known) to the hub at `POST /api/tv/history`, with a retry queue.
   The hub appends to `~/.house-hub/watch-history.jsonl`, de-duplicated by (pkg, title, day), and
   serves `GET /api/tv/history`.
2. On the Dell, check `which codex` and `codex login status`. If missing or signed out, tell Riley
   exactly what to run; don't sign in for them.
3. `hub/smart_recs.py`, run by a systemd timer at 03:00 local on the Dell: `codex exec` with the last
   ~90 days of history plus the installed services, asking for strict JSON
   `[{title, year, kind, app_hint}]`, 20–30 picks, nothing already watched. Resolve each on
   JustWatch (keep only subscription offers on installed apps), add poster/backdrop/links, write
   `~/.house-hub/smart-recs.json` with `generatedAt`. On failure keep the previous file.
4. `/api/tv/catalog` exposes the picks as the first row, with **shows Riley is currently in the
   middle of always first**. No `reason` field in the API or UI.
5. Tests for the history store and the resolver (fake codex output), update
   `docs/streaming-catalog.md`, deploy to both hubs, install the timer, run it once by hand.

## Unfinished: Hulu show links

Hulu movies already open and play. Hulu **shows** land on Hulu's home screen instead of the show.
Test on the TV: `https://www.hulu.com/series/<id>` vs `/watch/<episodeId>` vs JustWatch's
`ANDROID_TV` deep link (and intent extras). Use whichever opens the show page or plays. Only add an
automatic OK press for Hulu if a profile picker really appears after a verified title link; never
on a plain app launch (a blind OK on Hulu's home would play a random item). Commit the fix.
