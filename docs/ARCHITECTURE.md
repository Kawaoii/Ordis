# Architecture

Working notes for this repository. Read this before changing anything.

Rules here are not stylistic preferences. Each one exists because breaking it has
already cost time: either the app failed to start, or a bug shipped that was
invisible to the checks that were being run at the time.

## What this is

An Electron desktop companion app for Warframe. Item codex, Warframe.market
trading, relic/arcane catalogs, item comparison, and various calculators.

- Runtime: Electron 41, Node 24.
- `main.js` — windows, IPC, WFM session handling, relic overlay, update check.
- `preload.js` — the only renderer↔main bridge (`contextIsolation` on).
- `renderer.js` — the bulk of the UI. ~18.9k lines.
- `market.js` — Warframe.market integration, orders, contracts, analytics.
- `dock.js` — iOS-style snap docking for panels. See `docs/DOCK-SYSTEM.md`.
- `styles.css` — legacy theme, ~15k lines. Largely superseded.
- `ordis-design.css` — the authoritative visual layer. **Loads last.**

## Rules that will bite you

1. **`ordis-design.css` is the only place new visual rules belong.** It loads
   after `styles.css` and resets the legacy tokens at the source. Do not append
   override blocks to `styles.css`; earlier passes did that and the last block
   silently won, which is how the old and new themes ended up fighting.
2. **The window is `transparent: true`. That makes every backdrop read-back
   expensive, because the compositor has to sample the desktop *behind* the
   window.** This is the single most load-bearing constraint in the codebase.
   - No `backdrop-filter` anywhere. Not on cards, not on chrome. Not even on a
     handful of surfaces. It is currently zero declarations on purpose.
   - No `mix-blend-mode`. It forces the same read-back.
   - No `filter:` per image. 121 item cards each with a `contrast/saturate/
     drop-shadow` chain is enough on its own.
   - Measured, not guessed: adding the item-art blend layer plus per-image filters
     took cold-start failure from **3-in-4 to 0-in-5** - the renderer stopped
     responding to the DevTools protocol entirely and the window never painted.
     After removing them: **6-in-6 started clean.**
   - There is a **pre-existing ~25% intermittent cold-start stall** that predates
     all of this. It is not fixed. It is just no longer made certain.
3. **The glass look is carried by tint + a hairline rim, not by blur.** Windows
   has no lensing, and a real blur is not affordable here (rule 2). Don't
   "improve" the glass by adding a filter.
4. **Tokens are declared on `:root` *and* every `[data-theme]` selector.** The
   legacy theme blocks out-specify `:root` alone.
5. **`#content` is itself the "checklist" panel.** `getPanelRefs()` maps
   `checklist -> $('#content')`. Anything docked into `#content` disappears when a
   different panel is shown, which is why the dock lives in its own layer.
6. **Panels are lazily loaded.** Do not mount all 12 at once; Market alone
   renders 200+ cards.
7. `showPanel` is exposed as `window.showPanel` for `dock.js`. Keep it that way
   so there is exactly one implementation of "show a panel".
8. **`showPanel` must keep calling `OrdisDock.sync(panel)`.** Panels are also
   opened from relic links, "Used By" jumps and the item modal; without the sync
   the dock strip highlights the wrong tab.
9. **Never use PowerShell `-replace` (or sed) to rewrite JS/CSS source.** `$$` is
   a regex escape and gets consumed - it silently turned a `querySelectorAll`
   loop into a call on a single element, which threw at init and killed every
   listener in that file. It also ate a `.titlebar {` selector outright.
   `node --check` catches neither. Use the edit tool.
10. **A float window's content must not be given a fixed height.** The panel
   roots are flex columns with an inner `flex: 1` content column; forcing
   `height: 100%` distributes the sections down the page. Use `height: auto` and
   let `.dock-float-body` scroll. Same for top bars: in a column layout the
   cross-axis `flex: 1 1 300px` inflates them (the Relics top bar was 646px tall
   in a 708px body).

## Checking the CSS parses

A stray `}` in this file silently swallows the rules after it. That is not
hypothetical: the `prefers-reduced-transparency` block lost its `@media` wrapper
and then `!important`-switched off blur on every surface, which is why the glass
looked flat for several passes.

```powershell
# must print 0, and no negative values
$depth = 0; Get-Content ordis-design.css | ForEach-Object {
  $depth += ([regex]::Matches($_,'\{')).Count - ([regex]::Matches($_,'\}')).Count }
$depth
```

## Commands

There is no test suite and no linter configured. This is what has been used:

```powershell
# Syntax-check every script after an edit - this is the fastest smoke test.
node --check main.js; node --check renderer.js; node --check market.js
node --check dock.js; node --check preload.js

# Run with the DevTools protocol attached, for scripted UI checks.
npx electron . --remote-debugging-port=9222
```

The CDP helpers live in `%TEMP%\opencode` and are not part of the repo:
`shot.mjs` (screenshot + optional expression, with a hard watchdog),
`live.mjs` (liveness: one eval, one screenshot), `align-audit.mjs` (grid/overflow/
icon audit), `dock-tearoff.mjs` and `resize-test.mjs` (dock interaction),
`wfm-auth-test.mjs` (negative auth), `bisect-css.ps1` + `bisect-run.ps1` (keep
only the first N CSS sections, then run a cold start N times to get a failure
rate).

**Every one of those scripts must call `process.exit()`.** A CDP WebSocket keeps
node's event loop alive, so a script that just ends never exits, the harness kills
the process tree on timeout, and the app dies with it. That looked exactly like a
hanging renderer for most of one session and cost real time. `shot.mjs` and
`live.mjs` are safe; older ones were not.

**If you add a real test or lint setup, document it here.**

## Gotchas found the hard way

- `styles.css` was once truncated from ~17.5k to 15,070 lines to strip appended
  design experiments. That silently removed layout rules for the item-info drop
  rows and variants. Those were reconstructed in `ordis-design.css` section 8.
  Before deleting CSS in this repo, confirm the rule is not reconstructed
  elsewhere.
- `.sidebar-nav` needs `min-height: 0`. As a flex item it defaulted to
  `min-height: auto`, grew past the window, and put the last nav entries out of
  reach.
- Node's global `fetch` (undici) does **not** share Chromium's cookie jar.
  Storing the WFM cookie in the session is not enough; `main.js` keeps the
  verified token and injects `Cookie: JWT=...` explicitly.
- `build.files` in `package.json` is an explicit allowlist. A new top-level file
  that is not listed is missing from the packaged app.
- **The item thumbnails keep their white plate on purpose.** The source PNGs from
  Warframe have it baked in. Four separate attempts to tone it down were reverted;
  see the note in `ordis-design.css` §9b for what was tried and why.
