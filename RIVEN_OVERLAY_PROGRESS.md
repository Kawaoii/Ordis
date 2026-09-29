# Riven Overlay — Implementation Progress

**Last updated:** 2026-09-27
**Status:** Phases 1–3 complete and verified. Data layer (riven reference data + grading
engine) complete and tested. Phase 4 OCR parsing, Phase 5 wiring and Phases 6–7 pending.

> **Note on the previous version of this file:** it claimed Phases 1–3 were already
> finished, but no riven code existed in `main.js` at all. Only the renderer/UI side
> had been written, and the four IPC channels it invoked had no handlers, so
> enabling the toggle threw `No handler registered`. Separately, an uncommitted
> change had replaced the synchronous `require('electron')` with an async
> `await import('electron/main')`, which left every electron global `undefined`
> during module evaluation and made the app fail to load at all
> (`TypeError: Cannot read properties of undefined (reading 'whenReady')`).
> Both are fixed.

---

## What's Built

### Phase 1 — EE.log Detection ✅
Polls Warframe's `EE.log` every 750ms, reading only bytes appended since the last offset.

| Log pattern | Meaning |
|---|---|
| `Are you sure you want to cycle` | User confirmed the reroll — **triggers the scan burst** |
| `Created /Lotus/Interface/OmegaRerollSelection.swf` | Reroll screen opened — resets burst state |
| `Cycle Riven into current selection?` | User choosing between old/new stats — resets burst state |

Reuses `findWarframeLog()` (the same resolver the relic overlay and profile features use),
so a user-configured log path is honoured.

**Files:** `main.js` — `isRivenRerollConfirmLogText`, `isRivenRerollScreenLogText`,
`isRivenRerollChoiceLogText`, `pollRivenOverlayLog`, `startRivenOverlayLogWatcher`,
`stopRivenOverlayLogWatcher`

### Phase 2 — Screen Capture ✅
Fallback chain over `getRivenCandidateDisplayIds()`:
1. **Manual override** — display chosen in settings
2. **Cached display** — `rivenOverlayCachedDisplayId`, learned from the last successful scan
3. **Cursor display** — via existing `getDisplayForRelicOverlay()`
4. **Every connected display** — swept until one produces valid riven content

Each candidate is matched to a `desktopCapturer` source by `display_id`; captures are
downscaled to the shared 1280×720 budget via `getDisplayCaptureSize()`.

**Files:** `main.js` — `captureDisplayById`, `findDisplayById`, `getRivenCandidateDisplayIds`

### Phase 3 — OCR ✅
Reuses the single shared Tesseract worker (`getOcrWorker()`) and the relic overlay's
bbox/line helpers (`transformOcrLines`, `extractOcrLines`).

**Crop region:** `RIVEN_OVERLAY_CROP = { x: 0.40, y: 0.25, width: 0.35, height: 0.50 }`,
upscaled to 900–1400px wide for Tesseract, then clamped so it can never exceed the
source bounds (verified at 800×600, 1920×1080 and 3840×2160).

**Content validation:** `isLikelyWarframeRivenContent()` requires ≥2 distinct keyword
hits out of: riven, critical, damage, multishot, electricity, puncture, slash, impact,
status, duration, range, strength, fire rate, magazine, reload, toxin, cold, heat, mr.
Matching is whole-word on a normalised string, so `mirivendamage` does not count.

**Scan burst:** a reroll confirm schedules up to 3 attempts at 500ms intervals
(`runRivenScanBurst`) so the panel is caught even if the animation is still playing.
Consecutive identical frames are skipped via a SHA-1 hash of the cropped bitmap
(`RIVEN_OVERLAY_DUPLICATE_SCAN_MS`).

### Data Layer — Reference Data & Grading ✅ NEW

`riven-data.js` resolves a parsed riven into a graded verdict using two live HTTP
sources (no scraping, no bundled data to go stale):

| Source | Endpoint | Supplies |
|---|---|---|
| 44bananas / Xennethkeisere "good rolls" | `docs.google.com/spreadsheets/d/1zbaeJBuBn44cbVKzJins_E3hTDpnmvOk8heYN-G8yy8/export?format=csv&gid=0` | per-weapon good/bad stat matrix, notes |
| Warframe.market v2 riven weapons | `api.warframe.market/v2/riven/weapons` | canonical names, disposition, riven type, MR |

The sheet is the **exact dataset AlecaFrame uses** for its Great/Good/OK/Bad grades,
obtained from the link on https://docs.alecaframe.com/features/riven-explorer.html

**Join result: 113/113 sheet weapons matched a WFM weapon, zero unmatched, all with
disposition.** Verified live.

`rivenAttributes.json` and `market.js`'s `rivenAttributes` are both unusable for
grading (the former is fabricated, the latter is metadata only), and
`STATS_API_V1` (`/v1/items`, `market.js:13`) is dead — WFM removed it and it now
returns `{"error": ...}`.

**Sheet format decoding.** A positive cell encodes one or more acceptable
combinations separated by `or`. Within a combination, whitespace separates groups:
a lone stat is a must-have, a slash-joined group means "pick from these".
`rubico,CD MS FR/HEAT/CC/DMG` = CD and MS required, plus one of FR/HEAT/CC/DMG.
Negatives are the list of stats that are *harmless* for that weapon; anything else
is not harmless **for that weapon**, which is the only claim the data supports.
The CSV header row is validated, so a reordered or renamed column fails loudly
instead of silently mis-parsing every weapon.

**Grading** mirrors AlecaFrame's semantics: Great needs every positive good plus a
harmless negative, Bad means nothing helps. Score is a weighted 0–100 blend
(positives 45, harmless negative 20, satisfied combination 15, roll perfectness
20) and is then **clamped into its grade's band** so the number can never read
better than the label. Weapons with no community data return `unknown` with an
explicit reason rather than a fabricated grade.

Three earlier assumptions were wrong and were removed rather than patched:

1. **A hand-written "detrimental negatives" list was invented and deleted.** The
   sheet shows `PUNC` is tolerated by 55 of 113 weapons and `SD` by only 1, so a
   global good/bad verdict is not in the data. Replaced with
   `computeNegativeTolerance()`, which reports how many graded weapons tolerate
   each negative and surfaces that as context ("only 11 of 113 tolerate -AMMO")
   without letting it drive the grade.
2. **The sheet has zero melee rows**, so every melee-only stat scores 0 coverage.
   Grading a Zarr from rifle rules returned a confident, wrong "bad". Any riven
   containing a stat that no graded weapon considers good is now reported as a
   **coverage gap → `unknown`** (see `computeStatCoverage`). The sheet is
   34 distinct good-stat sets over 113 weapons but genuinely has no melee data.
3. **Melee-only stats were missing from the stat table.** Verified against the
   wiki's 31-attribute base-value table
   (<https://wiki.warframe.com/w/Riven_Mods>). `FIN` is **Finisher Damage**
   (melee base 119.7%, prefix `Exi` / suffix `Cta`) and was correct originally.
   `SCC` (Critical Chance for Slide Attack, melee base 120%) was genuinely
   missing and has been added. `KBD`, `QC`, `FC` and `ECR` are **not** riven
   attributes — they appeared nowhere in the wiki table and were removed.
   `Finesse` is likewise not a riven attribute and was never a valid substitute.

`findRivenWeapon()` now returns a match descriptor (`matched`, `exact`,
`ambiguous`, `reason`) instead of a weapon or null. An ambiguous prefix returns no
weapon, because silently grading the wrong weapon is worse than reporting no grade.

### Roll values and perfectness (rewritten)

Perfectness previously used invented per-stat coefficients (`roll`, with `2.0` for
Multishot and Critical Damage). That was wrong: it implied a 200% Multishot riven
on a 1.0-disposition rifle, which the game cannot produce.

The official formula
(<https://wiki.warframe.com/w/Riven_Mods#Attribute_Value_Formula>) is:

```
value = base_value × U(0.90, 1.10) × disposition × weight
```

`weight` depends on how many positive and negative attributes the riven has, so it
cannot be a per-stat constant:

| Layout | Bonus weight | Malus weight |
| --- | --- | --- |
| 2 bonus, 0 malus | 0.99 | 0 |
| 2 bonus, 1 malus | 1.2375 | −0.495 |
| 3 bonus, 0 malus | 0.75 | 0 |
| 3 bonus, 1 malus | 0.9375 | −0.75 |

A 2B1M riven therefore rolls the highest numbers, which is the community's reason
for pricing them separately. `RIVEN_STATS[key].base` now holds the base value per
weapon class (rifle/shotgun/pistol/archgun/melee), transcribed from the same wiki
table. The "unverified" caveat on `PT`, `SC`, `SD`, `IC` and `ACC` is gone: the
unverified 1.0 coefficients were the problem, not those stats.

Anything not knowable yields `null`, never a guess: an attribute that cannot occur
on the weapon's class, a stat count the game cannot produce, or an unknown weapon
class. `gradeRiven()` reports `perfectness: null` with `perfectnessKnown: false` and
adds a reason naming the cause, rather than showing 0%, which would read as "every
roll is terrible".

### Weapon class

Neither official nor market data classifies every weapon correctly, verified by
joining the Public Export against WFM on `uniqueName` ↔ `gameRef` (419/420 exact):

- **WFM `rivenType` is the better signal** for shotguns, Zaws, Kitguns and
  sentinels. DE's own `productCategory` files `Strun`, `Sobek`, `Tigris`, `Astilla`,
  `Kohm` and `Cedo` under `Pistols`/`LongGuns` although they are shotguns, and files
  the Zaws (`Balla`, `Cyath`, `Dokrahm`, `Plague Kripath`) under `Pistols`.
- **DE is better for Archguns**, which WFM reports as `rifle`. `RIVEN_ARCHGUN_REFS`
  holds the 15 verified official `gameRef` values with `productCategory ===
  'SpaceGuns'`; these are corrected to the Archgun column.
- **`kitgun` resolves to `null`** on purpose. The wiki publishes no Kitgun column,
  and inventing one is exactly the failure this module exists to prevent.

WFM's dispositions were also checked against DE's official `omegaAttenuation`:
**0 mismatches across 419 weapons**, so WFM remains the disposition source and the
620 KB Public Export is not fetched at runtime.

**Update 44 support (Riven Splicing).** Trait Locking is live and Riven Splicing
ships with Glacial Defiance in the 2026-09-23 → 2026-10-15 window. Splicing merges
two traits into one of 18 combo traits via 22 recipes, all encoded in
`RIVEN_SPLICE_TRAITS`. Combo traits are always positive, count as locked, and are
graded through whichever component recipe actually matches (some traits have two
valid pairings). New damage types Blast/Magnetic/Gas/Radiation and factions
Techrot/Scaldra are included.

### Verification

`npm run verify:riven-bases` (`verify-riven-bases.js`) re-reads the official wiki
page and diffs it against `RIVEN_STATS.base`, so a DE patch that changes a base
value fails loudly instead of silently skewing perfectness. It reports
**32 attributes × 5 classes matching**. The app never fetches the wiki at runtime;
the Public Export carries no riven attribute table (only `omegaAttenuation`), so the
base values have to be transcribed and this check is what makes that safe.

Test suite: 61 assertions, all passing, at `%TEMP%/opencode/riven-data-test.js`.

### IPC Handlers ✅
| Handler | Line | Purpose |
|---|---|---|
| `set-riven-overlay-enabled` | `main.js:2062` | Enable/disable, starts/stops the log watcher |
| `get-riven-overlay-status` | `main.js:2092` | enabled, scanning, logPath, cached + manual display, lastScanAt, burstActive |
| `get-available-displays` | `main.js:2105` | All monitors with label, bounds, scaleFactor, primary |
| `set-riven-overlay-display` | `main.js:2117` | Persists manual override, rejects disconnected displays |

### Settings / Result UI ✅
- Toggle "Riven Grading Overlay (Beta)" + status line + display dropdown (`index.html`)
- Toggle, status and display handlers (`renderer.js`)
- `onRivenScanResult` bridge (`preload.js`)
- Grade notification card (`renderer.js`) — written but dormant, see Phase 5

---

## Verification

`node --check` passes on `main.js`, `renderer.js`, `preload.js`, `riven-data.js`,
`market.js`, `riven-parser.js`. `package.json` parses.

Full suite, **139 assertions, 0 failures**:

| Suite | Assertions | Covers |
|---|---|---|
| `riven-data-test.js` | 53 | CSV, sheet header validation, stat aliases, splice dictionary, live WFM join, match confidence, tolerance, coverage gaps, grading, score bands |
| `app-e2e.js` | 32 | boot, IPC surface, no console errors |
| `riven-logic-test.js` | 21 | log triggers, content validation, crop geometry at 3 resolutions |
| `pipeline-e2e.js` | 14 | fake capture + OCR through the real pipeline |
| `startup-e2e.js` | 13 | log watcher lifecycle: create, truncate, delete, disable |
| `burst-e2e.js` | 6 | reroll burst scanning |

The app boots clean: no `App threw an error during load`. Only benign
`Gpu Cache Creation failed` / `disk_cache` warnings from the sandboxed GPU stack.

**Not yet verified end-to-end:** actual OCR against a live Warframe reroll screen.
That needs a real in-game capture to tune the crop region and keywords.

---

## Bloat / Background Behaviour Work

Goal: the app should not behave like Overwolf or AlecaFrame — no duplicate
instances, no idle polling nobody asked for, no updater chatter on every launch.

### Changes made

| Change | Detail |
|---|---|
| Lazy `tesseract.js` | Was `require`d at startup (~47 ms). Now loaded via `getOcrModule()` on first OCR use. |
| Lazy `electron-updater` | Was `require`d at startup (~235 ms measured, 779 ms on a cold cache). Now `getAutoUpdater()` on first use; never loaded at all in dev. |
| Single instance lock | `app.requestSingleInstanceLock()`. A second launch focuses the existing window and exits instead of running a duplicate. |
| Throttled updater | Automatic checks run **at most once a day**, never in the first 60 s. State persisted to `userData/update-check-state.json`; an explicit user check resets the timer. |
| Throttled renderer update check | Startup GitHub call limited to once per 24 h via `localStorage`, delayed 15 s past first paint. The manual button always works. |
| Countdown timers | The 1 s Prime and cycle countdowns drop to a 60 s tick while the window is hidden and resync immediately on becoming visible (`startVisibilityAwareInterval`). |
| Item refresh | The 30 min poll and the focus/online/visibility wake handlers now no-op while `document.hidden`. |
| Packaging | `build.files` now includes `riven-data.js` and no longer ships the fabricated `rivenAttributes.json`. |

### Measured effect

| Metric | Before | After |
|---|---|---|
| Blocking `require` at startup | ~830 ms | 0 ms (both lazy) |
| Idle CPU (10–40 s, visible) | not measured separately | 0.03–0.14 s total |
| Working set | 653.7 MB | 532–545 MB |
| Handles | 2,317 | 2,319–2,346 |
| Outbound HTTPS on a throttled launch | 5 | 2 |
| Second concurrent launch | ran a full duplicate | exits immediately, 4 procs total |
| Processes after force-kill | 0 | 0 |

A bare Electron window with the same runtime costs **303 MB and 4 processes**, so
roughly 300 MB of the footprint is the framework itself and not this app's
behaviour. Remaining outbound connections are legitimate app data:
`api.warframestat.us` (item/worldstate data) and `api.warframe.market`.

**Measurement caveat:** the first launch after a change still contacts GitHub.
That is the throttle doing its job, not a leak — but it only persists if the app
exits gracefully. Force-killing the process discards the buffered `localStorage`
write, so repeated kill-based tests always look like the throttle is failing.
Use `CloseMainWindow()` when verifying the throttle.

---

## What's NOT Built Yet

### Phase 4 — Stat Parsing
`riven-parser.js` exists as a draft but is **not wired in** and should be rewritten
before use. Known problems:
- Hardcoded 25-weapon list instead of the live weapon list from `riven-data.js`
- `rivenSuffixes` list is nonsense filler (invented names like `toxicron`, `satiata`)
- `normalizeStatName` fuzzy-matches on 6-char prefixes, so `damage` resolves to
  `Toxin Damage`
- Stat regex `([+-])\s*(\d+...)` is unanchored and will match mid-line noise
- No awareness of the 18 splice combo traits or the new damage types

`riven-data.js` already provides `resolveRivenStatKey()`, which should be used
instead of the parser's own fuzzy matcher. Needs to produce: weapon name, stat
name/value/polarity, MR, riven name.

### Phase 5 — Roll Grading
The grading engine exists and is tested in `riven-data.js` (`gradeRiven()`); it is
simply not wired to the OCR path yet. `RIVEN_OVERLAY_GRADE_THRESHOLDS`
(S≥80, A≥60, B≥40, C≥20) in `main.js:65` is now redundant and should be removed in
favour of the engine's own grade + score. The renderer notification card goes live
once Phase 4 feeds it a populated payload.

### Phase 6 — WFM Integration
Live price lookup via `AUCTIONS_SEARCH_API`, listing-text generation, "List on WFM"
deep link. Weapon metadata is already covered by `riven-data.js`; only pricing is
missing.

### Phase 7 — Overlay Window
`riven-overlay.html` is an 895-byte stub and no `rivenOverlayWindow` is ever created
(the variable is declared and otherwise unused). `riven-overlay-dashboard.html` is a
15KB dev dashboard. `RIVEN_OVERLAY_HIDE_DELAY_MS` and `rivenOverlayHideTimer` are
declared but unused.

### Dead / dormant declarations
`rivenOverlayWindow`, `rivenOverlayHideTimer`, `rivenOverlayDebugDir` are each
declared and never read. `rivenAttributesData` was removed from `main.js` (also
dead). `rivenAttributes.json` is no longer in `build.files`; it is untracked and
its contents are fabricated, so it can be deleted once you are sure nothing else
references it. `wfm-login-browser` has a handler in `main.js`.

---

## Known Issues & Improvements Needed

1. **Crop region is a guess** — 40%/25%/35%/50% was never validated against a real
   capture. Tune `RIVEN_OVERLAY_CROP` first; it is the single highest-value fix.
2. **Keyword validation is weak** — 2 keyword hits can be satisfied by unrelated UI
   (e.g. a "Status" + "Range" mod tooltip). Consider requiring a stat-shaped line
   (`±<number>%` or `±<number>` followed by a known stat name).
3. **OCR accuracy** — Warframe's stylised font is noisy; Phase 4 needs real fuzzy
   matching. Capture some failing OCR text and iterate against it.
4. **Scan delay** — 500ms with a 3-attempt burst; make configurable if slow hardware
   needs more.
5. **Linux untested** — log path resolution is cross-platform, but screen capture on
   X11/Wayland is unverified.
6. **Pick counts are inferred** — the sheet states how many stats to pick only in
   free-text notes, never in the data. The grader currently requires *every* option
   group to be satisfied, which is conservative: a riven that hits one option but
   misses another will not reach Great. Validate against known rivens and consider
   shipping an explicit per-weapon pick-count table.
7. **Community notes are not surfaced** — the sheet flags real exceptions, e.g.
   Rubico lists `IMP` as acceptable but its note says it is bad for Eidolon. The
   `notes` field is stored on each weapon and should be shown in the UI.
8. **Riven data is volatile** — dispositions are rebalanced every Prime Access
   round and the sheet is community-maintained. Both are read live with a 6h TTL
   cache, so the app must never persist a grade as if it were permanent.
9. **No melee grading** — the community sheet has no melee rows, so every melee
   riven reports `unknown` with a coverage-gap reason. This is deliberate: the
   alternative is a confident wrong grade. Supporting melee properly needs either
   a melee-aware source or an explicit melee good-stat table.
10. **Unverified roll coefficients** — `PT`, `SC`, `SD`, `IC` and `ACC` are set to
   1.0. If their true maximum is below disposition × 100, perfectness is
   under-reported for those stats. Verify against a known maxed riven.
11. **WFM `rivenType` and `group` are unreliable** — both report `rifle` /
   `primary` for melee weapons such as Zarr. Do not use either field to decide
   whether a weapon is melee; that is exactly why the coverage-gap check exists.

---

## Data Sources Available in market.js

- `rivenWeapons` — riven-eligible weapons from WFM
- `rivenAttributes` — possible riven stats with min/max per disposition
- `AUCTIONS_SEARCH_API` — `https://api.warframe.market/v1/auctions/search`
- `wfmFetch()` — authenticated fetch wrapper

---

## File Map

| File | State |
|---|---|
| `main.js` | Detection, capture, OCR, scan burst, 4 IPC handlers, state |
| `preload.js` | IPC bridge (`setRivenOverlayEnabled`, `getRivenOverlayStatus`, `getAvailableDisplays`, `setRivenOverlayDisplay`, `onRivenScanResult`) |
| `renderer.js` | Settings handlers, display dropdown, dormant grade card |
| `index.html` | Settings DOM |
| `riven-parser.js` | Unwired Phase 4 draft, needs rewrite. Not required by `main.js` yet and **not in `build.files`** — it must be added there when wired, or the packaged app will fail to load it |
| `riven-data.js` | **New.** Live weapon metadata + community grade matrix + splice dictionary + grading engine |
| `riven-overlay.html` | Phase 7 stub. In `build.files` |
| `riven-overlay-dashboard.html` | Dev dashboard. Not in `build.files` (dev-only, intentional) |
| `rivenAttributes.json` | Shipped but never loaded; contents fabricated, should be deleted |
| `verify-riven-bases.js` | **New.** Dev-only check that diffs `RIVEN_STATS.base` against the official wiki. `npm run verify:riven-bases`. Not packaged |

---

## Roadmap: replacing AlecaFrame

Agreed as the next phase, after the riven overlay is finished. Recorded here so the
intent survives context loss.

1. **Riven inventory view** — list the player's own Rivens, AlecaFrame-style.
   Needs a decision on where the data comes from: WFM has no "my inventory"
   endpoint, so this means either reading the in-game Arsenal, or a logged-in WFM
   account orders/listing lookup.
2. **iPhone-style "liquid glass" theme** replacing the current theme. This is a
   real acrylic/lens material (blurred backdrop, specular highlight, edge
   refraction), not a flat colour swap. Cost depends on whether it is a CSS
   approximation or a renderer effect.
3. **Static sidebar** — no hover-expand. One window, sidebar always visible, and
   navigation driven by pressing the section buttons. This is a layout and
   navigation restructure of `index.html` + `renderer.js`, not a styling tweak.
4. **Warframe.market panel on the right half** — item search, listing view, and
   posting a sell order with amount/quantity, plus copy-to-clipboard for the buy
   text. `market.js` already has the WFM auth wrapper and auction search, so this
   extends existing work rather than starting fresh.

**Sequencing note:** item 4 and the Riven inventory both need authenticated WFM
account access, which is the single biggest unknown in the whole project — it has
never been tested in a real browser session, and WFM's order endpoints are the
part of their API most likely to change or rate-limit. That should be proven early
rather than after the UI is built.
