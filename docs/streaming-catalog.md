# Streaming catalog

Design, October 22, 2026. **Status** (same day): build-order steps 2–4 are written, step 4 for
the iPhone app only (see "What was built" at the end). The hub's part has tests; the launcher
and the iPhone app have not been compiled, and nothing has been tried on the TV or the phone.

Riley asked for House Control to be "as integrated with the streaming apps as possible", with a catalog of recommended tiles for each app instead of just a search bar.

## What Riley sees

- **TV launcher (Living Room Home):** under Continue and Apps, one row per installed streaming app: "Netflix: Popular", "Max: New", and so on. Each row is 10 to 20 poster tiles. The focused tile fills the top half with backdrop, title, year, a one-line description and the app's name. OK opens the title in its app, which skips the profile picker (see `RemoteInputService` profile pick) and starts on the title page, or plays it where the app's deep link allows. Hold OK gives Details / Open in app / Hide.
- **Phone (iPhone app TV sheet, and the web panel's TV sheet):** a "Browse" section above search. It has a chip row of apps ("For you", then Netflix, Max and the rest) and a grid of posters under it. Tapping a poster opens a small sheet with art, title, year, runtime, rating, description and "where it's included", plus **Play on TV**. Search stays and searches the same catalog.
- **"For you" row (both):** Continue first, then titles similar to what the TV actually played (from the launcher's history), then each app's popular items.
- **Only Riley's services.** A title is shown under an app only when that app is installed on the TV and the offer is a subscription offer (`FLATRATE`/`FREE`/`ADS`). Rentals and purchases are left out unless Riley asks for them.

## Where the data comes from

1. **JustWatch (hub, already used for search).** `popularTitles` with `filter: {packages: [<app's JustWatch technical names>], monetizationTypes: [FLATRATE, FREE, ADS]}`, for each installed app. The sorts to fetch:
   - `POPULAR`: the default row
   - `TRENDING` (popularity change over 7 days): "Trending"
   - newest additions (`newTitles` / `NEW` sort): "New on <app>"

   Fields to fetch: title, year, objectType, shortDescription, posterUrl, backdrops, runtime, ageCertification, scoring (IMDb), genres, the offer's `standardWebURL`, and `deeplinkURL(platform: ANDROID_TV)`. The hub caches each row for 6 hours (`~/.house-hub/catalog-cache.json`, so a restart doesn't refetch), and art is proxied and cached on disk.
2. **The apps' own Android TV recommendations (launcher, if allowed).** Google TV apps publish "preview channels" and "Watch Next" programs to the system TV provider (`TvContractCompat.PreviewPrograms` / `WatchNextPrograms`). Those are the apps' real personal picks for Riley's profile, e.g. Netflix "Top Picks for Riley" and YouTube recommendations.
   - Reading other apps' channels needs `com.android.providers.tv.permission.READ_EPG_DATA`, and on Google TV the provider may only expose channels to the default launcher (or system apps).
   - **Probe first on the device** over ADB: request the permission, `content query --uri content://android.media.tv/preview_program`, and `content query --uri content://android.media.tv/watch_next_program`, both as the launcher and with `pm grant`.
   - If it works, these rows come first ("Netflix for Riley") and JustWatch fills in the rest. If it only works as the default HOME, that is a reason for the Home takeover (phase 4 in tv-launcher.md), and it gets asked about separately.
3. **Launcher history** (`HistoryStore`, already recorded from media sessions) for Continue and the "similar to" seed. Match a history title to JustWatch with a title search in that app, then take JustWatch's `similarTitles` for the "For you" row.

## Playing a title

- **Hub → launcher `open {url, pkg}`**, using JustWatch's Android TV deep link when there is one, otherwise the offer's web URL (the launcher sends ACTION_VIEW restricted to the package). `validate_link` keeps checking that the host belongs to the app.
- The profile pick runs after the open. A title deep link usually lands on the title page; where the app supports it (YouTube, Netflix `/watch/ID`), the link starts playback.
- Record which app and link shapes actually start playback, per app, in this doc after testing on the TV.

## API (hub)

- `GET /api/tv/catalog` → `{apps: [{id, name, rows: [{key, title, items: [Tile]}]}], forYou: [Tile], updatedAt}`. Only installed apps are included, using the launcher's `apps` list.
- `GET /api/tv/catalog/{app}?row=popular|trending|new&page=n` → more tiles.
- `GET /api/tv/title/{jwId}` → details plus offers (in the installed apps only).
- `Tile = {id, title, year, kind: movie|show, poster, backdrop, app, link, tvLink, blurb, runtime, rating}`. The poster and backdrop are hub-proxied URLs.
- The launcher gets the same JSON from the hub (`hub.url` stored at pairing, or pushed with `/api/settings {hub}`). That way the TV never talks to JustWatch itself, and its storage stays small: a bounded art cache of about 40 MB, with LRU eviction.

## Build order

1. Probe the Android TV recommendation provider on the device (it decides source 2).
2. Hub catalog endpoints, the cache and tests (fake JustWatch responses like `hub/tests/justwatch_search.json`).
3. Launcher rows: the app rows, the hero for a focused tile, opening a title, and Hide.
4. Phone Browse: the iPhone app first (it's the one Riley uses), then the web panel's TV sheet.
5. Test playback per app on the real TV, and write down what each app does.

## Open questions

- Whether Google TV lets a non-default launcher read the apps' preview channels. This decides whether the "for Riley" rows are possible without the Home takeover.
- How strictly JustWatch rate-limits. A 6-hour cache and about 3 sorts × 6 apps ≈ 18 queries per refresh should be fine.
- Netflix deep links on Android TV open the title page but don't always auto-play. That's acceptable, because the title page is one OK press from playing.

## What was built

October 22, 2026, not yet deployed to the hubs, installed on the TV or built in Xcode.

- **Device probe (step 1), from the coordinator.** On this Google TV,
  `com.android.providers.tv.permission.READ_EPG_DATA` is a normal permission: declaring it is
  enough. `content query` from the adb shell returned nothing for `preview_program` and
  `watch_next_program`, so whether an app (the launcher, not the default Home) can read other
  apps' programs is still unknown.
- **Hub** (`hub/catalog.py`, routes in `house.py`, tests in `hub/tests/test_catalog.py` against
  `justwatch_catalog.json`). The API above, plus: tiles also carry `pkg`, `age` and `genres`;
  rows carry `label` ("Popular", "Trending", "New"); the row titles are "Popular on Netflix",
  "Trending on Netflix" and "New on Netflix". Pictures are `/api/tv/img/{poster|backdrop}/{n}/{slug}`
  (JustWatch's s332 posters and s1440 backdrops, as JPEG), kept on disk up to 200 MB.
  - JustWatch's package filter takes its **short names** (`nfx`, `hlu`, `mxx`), not the
    technical names in `tv.APPS`, and those change when a service renames (Paramount+ went from
    `pmp` to `ppp`/`ppe`, HBO Max from `hbm` to `mxx`). So the hub reads JustWatch's own
    `packages` list once a day and matches it to `tv.APPS` by technical name; `SHORT_NAMES` is
    the fallback.
  - **New** is `newTitles` (what JustWatch says each app added on a day), one request with seven
    aliased days; a new season stands for its show. `popularTitles` has no "date added" sort
    (its `sortBy` is `PopularTitlesSorting`: POPULAR, TRENDING).
  - **For you**: Continue (from the launcher's state), then the apps' own picks when the
    launcher can read them (below), then `similarTitlesV2` (on `node(id:)`, filtered to the TV's
    apps) of up to three Continue titles, each found by a title search in its app (the show, for
    an episode), then the apps' popular titles in turn.
  - Continue titles play with `{"action": "resume", "id"}`, the apps' own picks with
    `{"action": "recommendation", "id"}`; both are passed to the launcher only for ids it listed.
  - **Unverified against the real JustWatch**: the field and argument names follow JustWatch's
    own web queries as other open-source clients use them in 2026 (`popularTitles(sortBy:,
    offset:)`, `newTitles(date:, filter:, first:)`, `similarTitlesV2`, `packages(country:,
    platform:)`, `content { runtime ageCertification scoring { imdbScore } genres {
    translation } backdrops }`). If one is wrong, only the rows that use it are left out.
- **Launcher** (`catalog/Catalog.kt`, `catalog/Recommendations.kt`, `ui/CatalogRows.kt`):
  For you and each app's rows under Apps, the hero for a focused poster, OK through
  `Commands.open`, Hold OK for Open / Open the app / Hide from Home, a ~40 MB picture cache. The
  hub's address is `Prefs.hubUrl` (pushed at pairing, or `/api/settings {"hub"}`; the Dell's by
  default). The TV provider reader declares READ_EPG_DATA, reads Watch Next, preview programs
  and channels every 30 minutes with every query guarded, logs what it finds (tag
  `LivingRoomRecs`), and puts up to 50 into `/api/state` as `recommendations: [{id, pkg, app,
  title, poster, intentUri, source}]`; `{"type": "recommendation", "id"}` opens one, kept to its
  package. Empty, nothing else changes.
- **iPhone app** (`UI/TV/TVBrowse.swift`, models in `Model/TVModel.swift`, calls in `TVStore`):
  Browse above Search on the TV remote page, with the chips, a three-column poster grid (an
  app's Popular / Trending / New picked under the chips, More for the next page) and the title
  sheet with Play on TV and where it's included.
- **Not yet:** the web panel's Browse, and step 5 (which link shapes start playback, per app).

