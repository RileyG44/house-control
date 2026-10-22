# House controls refresh

October 22, 2026. Based on `fork/main` at `366015f` (`RileyG44/house-control`), fetched
before implementation. The launcher redesign and its original Clear Skies Portal
discussion were reviewed before changing the controls.

The native iPhone app (`ios-native/`) uses SwiftUI and RealityKit. The Mac, Windows and
older phone shell share `web/`. The Dell hub is primary, the Mac hub is its backup, and
their existing peer sync carries saved scenes and tile order. The native phone can drive
the paired TV launcher directly on Wi-Fi; app launches still use the hub’s checked path.

## Behavior

- The phone and desktop share the launcher’s Urbanist font, teal field, round icon
  controls, soft card radii and pill menus, with readable light and dark appearances.
- Native AC airflow is a pool of 48 reused streak meshes. Fan speed changes their travel
  speed, swing changes their direction, and the path skims above the floor. Its numerical
  path is checked by `scripts/test-airflow.swift`.
- A light tile still toggles on tap. AC and TV tiles open their pages; their power buttons
  still switch power. A sideways TV swipe sets volume, coalescing pending levels.
- Presets can all be deleted, including the last preset. A hold and drag puts them in
  order; holding and releasing opens editing. On desktop, right-click or Shift+F10 opens
  editing/deletion, and Alt+Left/Right moves a preset. Saved order and deletions survive reload.
- A preset’s optional `tvs` map is `{ "<TV id>": {"app": "netflix", "name": "Netflix"} }`.
  The native phone, shared web UI and TV launcher run it along with the light and AC rules.
- The furniture library and bundled studio include a speaker. The live saved studio can
  be upgraded with the idempotent script in [Spotify setup](spotify.md). The existing plan
  and device links are preserved. The speaker’s remote supports Spotify Connect and a
  bridge to the signed-in Mac app.

## Validation

- **Hub:** 106 tests passed on the Dell in `/tmp/house-controls-check`, using copied sources,
  fake services and a separate pytest install. This did not replace the running hub.
- **Browser:** 11 acceptance checks passed across phone and desktop; one desktop copy of
  the phone touch-only check is intentionally skipped. Checks include actual browser touch
  events, power-safe TV swipes, persistent preset order/deletion, combined preset actions,
  Spotify transport/output selection and screenshots in both appearances. No page errors.
- **Native iPhone:** generic iOS device build succeeds with Xcode. Build number 5.
- **Mac:** native shell builds; the shared core XCTest suite passes (58 tests, 2 environment
  skips). The custom asset handler serves the bundled font with its correct MIME type.
- **TV launcher:** release APK builds with the new preset TV actions.
- **Airflow:** native path, floor clearance and fan-speed checks pass on macOS.

The Mac’s full hub run has the same three environment-dependent failures seen in the prior
launcher session: two need additional 127.0.0.x loopback addresses on macOS and one picks up
the real Mac editor’s saved plan. All 106 pass on Linux with the saved plan isolated.

The iPhone was unavailable and no simulator runtime is installed on this Mac. Physical
phone visual/touch QA remains pending. Spotify Connect’s live Echo transfer needs the
account’s one-time OAuth authorization; the player and bridge contracts are covered with
fake services. These are explicit live-verification gaps, not claims of hardware testing.

## Review gate

Do not merge until the requested Claude Opus 5.5 review at the highest available reasoning
setting has run and its actionable findings have been addressed. Review results and any
follow-up validation belong in the PR. Deployment follows that review gate.
