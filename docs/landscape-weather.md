# Landscape and live weather around the studio

Riley's request (2026-10-21): put a landscape around the 3D model, and make the sky show the day's
real weather. The studio is a lakefront building at **2595 Westshore Dr NE, Moses Lake, WA** (the
west shore of Moses Lake). No neighbouring houses: only the lake on the window side, the farm field
on the bed side, and a sky that is dark at night, light by day, and shows what the weather is doing
outside right now.

Both the web panel (`web/src/three/`) and the native iPhone app (`ios-native/Sources/Scene/`) get it.
The Mac menu bar app and the Windows widget load the panel, so they follow the web panel.

## Orientation

In Riley's Google Earth view the lake is on the 3 o'clock side of the building and the bed wall is on
the 9 o'clock side. Westshore Dr is on the lake's west shore, so the lake is to the **east**.

In the plan (`web/public/plans/riley.json`, x right, z down, the plan's "north" is −z):

- The kitchen window (on the z = 0 wall) and the small bathroom window (on the z = 2.2 wall) face −z.
  Sitting up in the bed (pos [4.12, 6.5], rot 180, head on the z = 7.7 wall) you look toward −z.
  So **plan −z faces the lake, real east**.
- The bed wall, z = 7.7 (plan +z), faces the **farm field, real west**.
- Then plan +x is real south and plan −x real north.

## Plan: the `site` block

A new optional top-level key in the plan. Plans without it (the demo homes) look exactly as today:
plinth, theme-driven light and dark, no landscape.

```json
"site": {
  "address": "2595 Westshore Dr NE, Moses Lake, WA",
  "lat": 47.16, "lon": -119.33,
  "planUp": 90,
  "landscape": { "water": "north", "field": "south", "shore": 7, "fieldEdge": 9 }
}
```

- `lat`/`lon`: the house (refined by geocoding at deploy; the default above is close enough for
  weather and the sun).
- `planUp`: compass bearing (degrees) the plan's −z direction points at. 90 = east.
- `landscape.water` / `landscape.field`: which side of the plan (`north` = −z, `south` = +z, `east` = +x,
  `west` = −x, in plan terms) the lake and the field are on.
- `shore`: metres from the building's outline on the water side to the waterline. `fieldEdge`: metres
  from the outline on the field side to where the crop rows start.
- The hub (`hub/plan.py`), the web editor's save, the agent's plan edits and the native app's plan model
  keep `site` through a save round trip (unknown keys must not be dropped). The editor does not need
  UI for it.
- Add the block to `web/public/plans/riley.json` and `ios-native/Resources/riley.json`. Deploy adds it
  to the hubs' existing `~/.house-hub/plan.json` (a hub never overwrites a user plan).

## The scene

All outdoor geometry is low-poly and stylised to match the model, not photographic. Sizes are in
metres around the plan's bounds.

- **Yard**: the plinth goes away (a thin foundation slab, 5 cm, stays under the walls). Ground is a
  gently uneven grass disc around the building, radius ~60 m, fading into the far terrain.
- **Lake** (water side): the yard runs `shore` metres, then a short sloping bank of sand and a few
  rocks (2–3 m), then water. The waterline curves gently (not ruler straight) and runs off past both
  sides of the building. The water is a large plane out to the horizon: colour from the sky (a darker,
  bluer version of the sky near the horizon colour), a specular sun or moon glint path, and small
  ripples whose size and speed follow the wind. Far shore: a low line of tan, sage-brown hills about
  1–2 km out, softened by haze (Moses Lake's east shore is dry, open scrub).
- **Field** (field side): a little yard, then at `fieldEdge` a flat field with crop rows running away
  from the house, out to the horizon. Its colour follows the season: green (May–Jul), gold (Aug–Sep),
  harvested tan stubble with darker furrows (Oct–Nov), dull brown (Dec–Mar), fresh green (Apr). With
  snow on the ground (`snowDepth` > 1 cm) the yard and field go white with rows showing faintly.
- **Sides** (the two remaining sides): the yard turns into dry scrub/grassland that meets the lake
  and the field. No houses, roads, trees in rows or fences beyond, at most, a few sagebrush clumps and
  a lone tree or two well away from the building.
- The landscape must not get in the way: nothing above floor level within 1.5 m of the outline,
  nothing that blocks the camera at its default framing or any orbit/zoom, nothing picked by taps.
  The TV close-up is unaffected.

## The sky

The sky is real-time: **day/night from the sun's actual position at the house**, and weather from
Open-Meteo.

### Sun and moon

- Computed on the client from `lat`/`lon` and the current time (a standard solar-position formula,
  NOAA or similar, accurate to ~1°; a simple moon position and phase). No network needed, so day and
  night are right even with no weather.
- Turned into the scene's frame with `planUp`: compass bearing b maps to plan direction
  (−z rotated clockwise by b − planUp). So at sunrise the sun rises over the lake.
- Day when the sun is above +6°, night below −6°, twilight in between: a warm horizon band toward the
  sun at sunrise and sunset, deepening blue above.

### Look: the stage follows the sky, not the theme

With a `site`, the stage's light and dark (today `LOOKS`/`setTheme` on the web, `applyLook` in
`HomeScene.swift`) is driven by the sky: sun altitude and cloud cover set the hemisphere/IBL colours,
the directional light (the sun by day, the moon at night, from their real directions), exposure and
bloom. Night looks like today's dark look (lamps glowing); a clear noon looks like today's light look;
overcast is flatter and greyer; storms darker. The panel's light/dark/auto setting then only styles the
card and UI, not the stage. Without a `site` everything stays as today.

The shadow map is re-rendered when the light's direction moves more than ~1° (the model is static).

### Weather looks

From the WMO weather code and the other fields (see the hub's `/api/weather` below):

| Weather | Look |
|---|---|
| Clear (0) | Clean gradient; stars at night (fewer near a bright moon); sun disc and glow by day |
| Mainly clear / partly cloudy / overcast (1–3) | Cloud layer whose coverage follows `cloud` % (0–100), drifting with the wind direction and speed; overcast greys the sky and softens shadows |
| Fog (45, 48) | Thick distance fog: the far shore and field fade out within ~60–150 m (follow `visibility`); rime fog (48) frosts the yard |
| Drizzle (51–57) | Grey sky, fine light streaks, faint rings on the water |
| Rain / showers (61–67, 80–82) | Rain streaks slanted by the wind, density from `precip` mm/h; rings on the water; wet darker ground; showers = broken clouds with rain |
| Freezing drizzle/rain (56, 57, 66, 67) | As rain, with a cold blue-grey tint |
| Snow (71–77, 85, 86) | Falling snow, density from `snow` cm/h, drifting with the wind; snow grains (77) small and sparse |
| Thunderstorm (95–99) | Dark heavy clouds, heavy rain, lightning: every 6–20 s a sky flash (brief light boost) and sometimes a bolt over the lake; hail (96, 99) adds small bouncing white specks |

Wind also moves the field (a slow shimmer on the crop) and the water ripples. Precipitation and
lightning stay outside the building: rain/snow fall around the model, not through the roof (a
particle volume with the building's footprint cut out, or particles that only fall outside the walls).

### Debug overrides (for testing and screenshots)

Web: `?sky=<kind>&skytime=<HH:MM>` (kind ∈ clear, partly, overcast, fog, drizzle, rain, snow, storm)
forces a look and a local time at the house, and skips the hub. Native: the same from launch arguments
`-sky <kind> -skytime <HH:MM>` (no UI).

## Weather source: the hub

`hub/weather.py`, started by `hub/house.py` when the plan has a `site`:

- Every 10 minutes (and at start), `GET https://api.open-meteo.com/v1/forecast` with the site's
  latitude/longitude, `current=temperature_2m,weather_code,cloud_cover,precipitation,rain,showers,snowfall,
  wind_speed_10m,wind_direction_10m,is_day,visibility,snow_depth`, `daily=sunrise,sunset`,
  `timezone=auto`. No key. Timeouts 10 s; on failure keep the last good reading and retry in 2 min.
- `GET /api/weather` returns the last reading normalised:
  `{ "at": iso, "code": int, "kind": "clear|partly|overcast|fog|drizzle|rain|snow|storm", "cloud": 0–100,
     "precip": mm/h, "snow": cm/h, "wind": km/h, "windDir": deg, "temp": °C, "isDay": bool,
     "visibility": m, "snowDepth": m, "sunrise": iso, "sunset": iso, "stale": bool }`,
  or `{ "kind": null }` (200) before the first reading. `stale` is true when the reading is over 40 min old.
- Also sent on `/api/events` as a `weather` event when it changes, so open panels update without polling.
  Clients that don't see an event still re-read `/api/weather` every 10 minutes.
- Each hub (Dell and the Mac backup) fetches on its own; nothing to sync.
- The phone reads weather from whichever hub it is using, so it works away from home over Tailscale.
- Tests in `hub/tests/` with Open-Meteo faked (no network in tests).

If there is no reading (hub down, no network), the sky still shows the right day/night with a plain
partly-cloudy look.

## Performance

- Web: the render loop renders only when something changed. The sky adds slow motion (clouds,
  water, field): when nothing else is moving, ambient frames run at ~20 fps; rain, snow and lightning at
  up to 30 fps; nothing when the page is hidden. `prefers-reduced-motion`: a still sky (no drift or
  falling particles; a rain/snow look is shown with static streaks/flakes).
- Native: RealityKit runs every frame anyway; keep particle counts modest (a few thousand at most),
  regenerate sky textures only on weather change or every few minutes as the sun moves, not per frame.
- Transparent stages (`background: null`, the Mac menu bar glass panel and the Windows widget): no
  sky dome, keep the landscape but fade its outer edge to transparent ~25 m out, keep the weather
  particles. The stage still follows the real day/night for its lighting.

## Files

- Web: `web/src/three/landscape.js` (terrain, lake, field, scrub), `web/src/three/sky.js` (dome, sun/moon,
  stars, clouds, fog, precipitation, lightning, the look it drives), `web/src/sky/sun.js` (solar/lunar
  position, pure functions), `web/src/sky/weather.js` (hub client + overrides); `world.js` wires them
  and lets the sky drive the look.
- Hub: `hub/weather.py`, routes in `hub/house.py`, `site` kept in `hub/plan.py`.
- Native: `ios-native/Sources/Scene/Landscape.swift`, `Sky.swift`, `ios-native/Sources/Model/SunMoon.swift`,
  `Weather.swift` (model + fetch through `HubClient`); `HomeScene.applyLook` driven by the sky when the
  plan has a site; `Plan.swift` decodes `site`.

## Status

- Spec written 2026-10-21. Built 2026-10-22: hub, web panel and native app.
- **Hub**: `hub/weather.py` reads Open-Meteo every 10 min (2 min after a failure, at once when the
  plan's site changes), serves `GET /api/weather` and sends a `weather` event when the reading
  changes (and to every panel that connects). `hub/plan.py` keeps `site` when the hub remakes its
  plan. Tests: `hub/tests/test_weather.py`, Open-Meteo faked.
- **Web**: `web/src/sky/sun.js`, `web/src/sky/weather.js`, `web/src/three/sky.js`,
  `web/src/three/landscape.js`, wired in `world.js`; `config.js` passes `site` through, the editor's
  import and the agent's plan edits keep it. Ambient frames at 20 fps, weather at 30 fps, one frame
  every 30 s with reduced motion, none while hidden. Screenshots (phone and desktop, every kind,
  day and night) in the project files under `house-control/landscape/`.
- **Native**: `Model/SunMoon.swift`, `Model/Weather.swift`, `Scene/Sky.swift`,
  `Scene/Landscape.swift`; `Plan.swift` decodes `site`; `HubClient` passes the `weather` event on
  and `HomeStore` reads `/api/weather` from the hub in use. Written without a Swift toolchain at
  hand: it has not been compiled or run yet (build it with `scripts/build-ios-native.sh`).

Limits:

- The camera looks down on the model (52°, a narrow lens), so the sky itself is hardly ever in view:
  the weather reads through the light, the lake (which mirrors the sky, clouds, stars and the
  lightning), cloud shadows, wet ground and puddles, the rain or snow and the fog.
- The light never comes in lower than 20° (sun) or 30° (moon), so the rooms stay readable at
  sunrise and sunset; the sun's real direction still sets the glow, the glitter on the lake and
  the colours.
- `skytime` is the house's local time when the reading's sunrise gives its UTC offset, or the
  device is in the house's time zone; otherwise it falls back to the longitude's (Moses Lake: UTC−8,
  so in summer an hour off).
- With the shore 7 m out, the default framing shows the lake only along the top of the picture.
- Native: no rain rings on the water, no hail, no cloud shadows or puddles, and no lightning bolt
  (flashes only); the fog is drawn ring by ring (each ring of the land and lake gives way to the
  fog's colour by its distance). The season's colours are taken when the model is built.

Where it differs from the spec:

- An opaque stage (the phone layout and the native app) gets the sky dome behind everything; the
  transparent glass panel gets none, and the land fades out between 20 and 28 m.
- Lightning is a flash of the whole stage and, on the web, a bolt drawn into the sky (seen in the
  lake and on the dome), not a 3D bolt over the lake (it would be out of frame).
- Rain and snow fall in a 32 × 15 m volume round the house, hidden inside the footprint below the
  roof line (web) or kept to four boxes round the footprint (native).
- Fog also lays a light haze over the model, so the house sits in it rather than on top of it.
- The Mac app's `hubRequest` now allows `api/weather` (`core/Sources/HouseCore/LocalHub.swift`), so
  the menu bar panel gets the weather from the Mac's hub.
- The island demo keeps its plinth (`outdoors: false`), whatever its plan says.
