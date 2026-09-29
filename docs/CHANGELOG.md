# Development Changelog

Append-only, newest first. Records work as it was completed, including the bugs
found along the way and what is still unfinished, so the reasoning behind the code
is not lost once the person who wrote it moves on.

---

## 2026-09-29 (later) — My Orders layout, glass legibility, authoritative set parts

### Bugs found and fixed

| Bug | Cause | Fix |
|---|---|---|
| **My Orders rows were ~500px tall and the table ~3000px in a 900px window** | every rule for the listings table was lost when `styles.css` was trimmed, and only `.status-dot` survived. Nothing constrained the thumbnail, so the browser used its intrinsic 512x512 and each row grew to fit | rebuilt the block in `ordis-design.css` from the DOM `renderMyOrders` actually produces |
| Desktop was legible through the window | `.app-container` was `rgba(9,16,23,0.86)`, justified by checking how far a white pixel lifts the *surface*. That bounds the background, not the contrast it carries: white text on a dark IDE is ~200 levels brighter, so at 14% another application's source was readable through the grid | raised to `0.93` and rewrote the comment, which had the reasoning backwards |
| Part lists were incomplete | grid grouping infers sets from a hardcoded part-word list, which never contained "Disc", so Glaive Prime's parts bar was missing one | the parts bar now asks `/v2/item/{slug}/set`, falling back to the local list |

### On the My Orders CSS loss

This is the second time the `styles.css` trim has silently removed a whole
component's layout, the first being item-info drops. Nothing in the toolchain
detects it: `node --check` only reads JS, and a missing selector is not a syntax
error. The browser simply falls back to unstyled rendering, which looks like a
design choice rather than a defect. Worth a check that walks the rendered DOM for
element classes that have no rule anywhere.

### Verified

My Orders view 3094px -> 608px, thumbnails 512x512 -> 40x40, all 7 listings on
one screen. Glaive Prime components resolve to Complete set / Blade / Blueprint /
**Disc**, the last of which the word list did not know about. Grid still 3369
items with images. Glass at 0.93 over a bright window.

### Not done

- `/v2/items` carries no `setRoot` / `setParts` / `quantityInSet`, so grid
  grouping still infers sets from names. There is no bulk source; per-card
  requests would be worse than the inference. Only the opened set is resolved
  authoritatively.
- Riven parser, grading wiring, overlay window and the Rivens tab are still open.

---

## 2026-09-29 — Warframe.market session restoration, attribution, docs

### Bugs found and fixed

| Bug | Cause | Fix |
|---|---|---|
| **Every authenticated call 401'd after a restart** | the main process only learns the token through `wfm-set-cookie`, which was called from `connectWfmSocket()` inside `initMarket()`. The market module initialises lazily on first visit, so until the user opened the Market tab the main process held no token and every session request went out anonymous | `rehydrateWfmSession()` restores the stored token at startup, independent of the market UI |
| Rehydrated session still looked logged out | the restore path set the session but never refreshed the header, so the button stayed hidden and the UI read as disconnected | call `updateWfmHeaderUI()` after a successful restore |
| `Authorization` header was deleted before sending | `wfm-fetch` stripped the caller's header and sent only a legacy `JWT` cookie, so the documented auth method was never used | send `Authorization: Bearer <jwt>` **and** the cookie, normalising `Bearer`/`JWT `/bare input |
| Player names rendered as "Unknown" or "Connected" | v2 returns `ingameName`; the code read only the v1 `ingame_name` | `wfmIngameName()` reads both, used everywhere |
| **Your own listings were hidden in the orders table** | `isMyOwnOrder()` compared `user.ingame_name`, always undefined, so nothing ever matched | same helper, so the comparison actually runs |
| Crossplay orders silently missing | the `Crossplay` header defaults to false server-side and was never sent | sent on all Warframe.market requests |
| Inconsistent request headers | written out separately per call site and had drifted apart | one `wfmHeaders()` / `wfmAuthHeaders()` pair in `main.js` |

### Rules compliance

Warframe.market asks clients to identify themselves and forbids impersonating a
browser. `User-Agent` is now `Ordis/<version> (+https://github.com/Kawaoii/Ordis)`
everywhere, replacing both a version-less string and a spoofed `Chrome/120` UA.

**The credentials login path cannot be made to work and should be removed.**
`POST /auth/signin` is first-party only and requires Firebase App Check, and
OAuth 2.0 is not open to public integrations yet. That flow scrapes the login page
with a fake browser UA, which is both against the rules and exactly what
Cloudflare is built to block. The interactive browser window is the supported
approach and already works.

### Verified

Cold start with no re-login: `/v2/me` **200** as `R3DTAIL_GHOUL`,
`/v2/orders/my?order_type=sell` **200** (7), `?order_type=buy` **200** (7).
Market grid 200 cards. My Orders renders 8 rows with all 7 thumbnails loaded.

### Also done

- About screen in Settings carrying the upstream credit, licence name and Digital
  Extremes disclaimer, as the licence requires.
- The inherited "Message me on Telegram" button pointed at the original author's
  personal contact, so a user's bug report would have reached a third party.
  Replaced with a link to this fork's issue tracker.
- `appId` is now `io.github.kawaoii.ordis`; safe to change because no releases had
  been published, so no existing install could be stranded.
- Docs renamed to `docs/ARCHITECTURE.md` and `docs/CHANGELOG.md`.

### Not done

- The credentials login path is still present; it should be deleted in favour of
  the browser window.
- Set grouping still uses a hardcoded part-word list. The v2 Item model exposes
  `setRoot`, `setParts` and `quantityInSet`, which would be authoritative.

---

## 2026-09-28 — Liquid Glass redesign + dock system


### Goal
Rebrand the UI as iOS "Liquid Glass" (cool teal/steel, rounded, no red), make
sub-windows glass too, then build iOS-home-screen-style snap docking for panels.

### Shipped

**Glass / visual**
- Window is now genuinely transparent (`transparent: true`,
  `backgroundColor: '#00000000'`, `hasShadow: false`). The desktop is the
  backdrop; `.app-container` paints the rounded shell, hairline edge and drop
  shadow.
- Palette corrected from violet/magenta to the reference's steel/teal
  (`--wfui-accent: #5eead4`, `--blue: #7dd3fc`, `--cyan: #5eead4`). All warm
  magenta tints removed.
- Shell owns window rounding; inner chrome is square so it does not double-round
  against the clipped edge.
- Panel tints dropped to ~0.30–0.42 alpha so the desktop reads *through* the
  glass. Heavier fills read as "dark panel with a blur", not glass.

**Dock (`dock.js`, ~780 lines)**
- Bottom-docked glass strip, 12 panels, icon-only with the active/hovered label
  expanding (12 labels do not fit 1180px and a half-scrolled strip reads broken).
- Press-and-hold ~380ms lifts a tab; drag over the strip reflows siblings (FLIP)
  with a glowing drop marker; drag away tears off into a floating glass window.
- 12x8 snap field for floating-window position and resize; 90px of grab area is
  always kept on screen.
- Persisted to `localStorage` `ordis.dock.v1`; unknown ids discarded on load.
- `checklist` cannot be torn off — it is `#content`.

### Bugs found and fixed

| Bug | Cause | Fix |
|---|---|---|
| **Every WFM token was "accepted"** | `wfm-set-cookie` wrote a cookie and returned `ok:true` unconditionally, never calling `verifyWfmTokenInMain` | verify first, only persist on success |
| **Authenticated market calls all 401'd** | `wfm-fetch` only built a `Cookie` header from a caller-supplied `Authorization`; but `setWfmCookie` wrote to Chromium's jar while requests go out via Node's undici, which never reads it | keep verified token in main, inject `Cookie` on every fetch |
| **Torn-off windows were empty** | panels carry `hidden`; moving the element never unhid it, so the float only showed what was behind it | `tearOff()` calls `focus()`; restored floats get a visibility pass on init |
| **Torn-off windows had no resize handles** | `decorateFloats()` only ran once at startup, so only restored windows got handles | `buildHandles()` in `tearOff()` |
| **Windows draggable off-screen, unrecoverable** | snapping never clamped | `clampRect()` in every position/apply path |
| **Dock/close buttons keyboard-dead** | handled on `pointerdown`, which does not fire for Enter/Space | moved to `click` |
| **FLIP reflow could never animate** | `renderStrip()` rebuilt every tab, destroying the elements the animation measures | `syncStripOrder()` reorders existing nodes |
| **Relics panel hung on "Loading relic catalog" forever** | `fetchWfcdSingleFile` had no timeout; cache only written on success, so retries queued behind a dead promise | `AbortController` + 20s timeout, converted to a visible error |
| **Sidebar could not reach its last entries** | `.sidebar-nav` is a flex item with default `min-height: auto`, so it grew past the window instead of scrolling | `min-height: 0` |
| **Item-info drops/variants rendered unstyled** | their layout CSS was lost when `styles.css` was trimmed to 15,070 lines; only border-radius survived | reconstructed in `ordis-design.css` §8 from the actual DOM |
| **Broken-image symbols in the grid** | analytics renders images with no `error` handler, and `Arcane Energize` / `Arcane Grace` 404 on the CDN | capture-phase document listener; arcanes get a fallback glyph |
| **Packaged build was broken** | `build.files` allowlist omitted `dock.js`, `ordis-design.css`, `riven-overlay-dashboard.html` | added |
| **Float's market topbar overlapped itself** | panel topbars were laid out for full width | stack + shrink rules scoped to `.dock-float-body` |

### Verification
- WFM: valid token → `/v2/me` **200** with real account data. Six invalid token
  shapes (empty, whitespace, garbage, bogus-JWT, `JWT `-prefixed, truncated) →
  all correctly `ok:false` with clear messages.
- Dock: lift → tear off → clamp → resize (SE grow/shrink, west-edge origin
  correction verified) → re-dock → persist, all asserted.
- Alignment audit across 4 widths x 12 panels: clean apart from the two
  404 images above.

### Notes / not done
- **The WFM token used for testing was discarded, not stored.** It is in the chat
  transcript, so it should be treated as compromised and revoked.
- Kuva weapons are still unreachable from the Equipment checklist.
- Riven overlay and Riven inventory remain unbuilt.

---

## 2026-09-28 (later) — sidebar declutter, and a serious performance regression

### Done
- **Sidebar no longer duplicates the dock.** All 10 `data-panel` links (Market,
  Trading Analytics, Prime Resurgence, Relics, Arcanes, Worldstate, Solar System,
  Compare, Recommendations, Resources) were exact duplicates of dock tabs. With
  26 entries the sidebar overflowed a 900px window and the bottom half was only
  reachable by scrolling. Removed; the sidebar is now the 11 equipment categories
  + Mods + 4 tool actions, and fits without scrolling. One unguarded listener
  (`#nav-market`) was guarded first.
- **Dock highlight now syncs.** `showPanel` calls `OrdisDock.sync(panel)`. Panels
  are also opened from relic links, "Used By" jumps and the item modal, and the
  strip used to keep highlighting whatever was previously open.
- Sidebar made denser so all entries fit at 900px.

### The regression, and what it taught

Chasing the item art, I added a `mix-blend-mode: multiply` overlay plus a
per-image `filter` chain to tone down Warframe's baked-in white thumbnails. The
app stopped rendering entirely — window blank, renderer unresponsive to even
`1+1` over CDP.

Bisected it properly rather than guessing:

| Config | Cold starts that came up |
|---|---|
| Full CSS with the art treatment | **0 / 5** |
| Sections 1-9 only | 3 / 4 |
| Full CSS, blend + per-image filter removed | **6 / 6** |

Both were reverted. The tint/rim carries the glass; the art plate stays as it is.

**The underlying constraint is that the window is `transparent: true`.** On a
transparent window every `backdrop-filter`, `mix-blend-mode` or per-layer filter
forces the compositor to read back whatever is *behind* the window, i.e. the
desktop. With 121 cards in the same stacking context that is enough to wedge the
renderer. This is now rule 2 in `ARCHITECTURE.md`, with the measurements.

**A pre-existing ~25% intermittent cold-start stall remains.** It reproduces with
all the heavy CSS removed, so it predates this work and is not fixed. It is just
no longer made certain by the design layer.

### Correction to an earlier note

Part of what was recorded as "intermittent renderer unresponsiveness" was
self-inflicted. The CDP helper scripts never closed their WebSocket, so node never
exited, the harness killed the process tree on timeout, and the app died with it
— which looks exactly like a hanging renderer. All helpers now call
`process.exit()`, and `shot.mjs` has a 45s watchdog. Worth re-testing the
remaining stall with a harness that cannot cause it.

---

## 2026-09-28 (late) — browser-style dock, tiling, float reflow

### Interaction changed to browser semantics
Tabs no longer use a 380ms press-and-hold. Crossing a 5px movement threshold
lifts the tab immediately, and leaving the strip detaches it - the Brave/Chrome
model. The hold was iOS behaviour and it read as "nothing happens" to anyone
dragging deliberately; it also meant a tab could be moved but not torn off
unless the pointer lingered. Same change applied to the category rail.

### Side-by-side tiling
Dragging a window against a workspace edge makes it that half (left/right, or
top/bottom), so two windows tile without hand-sizing. Bounds are the usable area
above the dock strip, not the full workspace, or a full-height tile disappears
behind the strip. Verified: gap 0, no overlap, both 719px in a 1438px space.

Neighbour-edge snapping and the 12x8 grid still apply when no edge is targeted.

### Bugs found and fixed
| Bug | Cause | Fix |
|---|---|---|
| Only the FIRST tear-off ever worked | a torn-off window outranked the dock strip, so it swallowed the press meant for the next tab | strip pinned to z-index 5000, above the float range; float z capped below it with re-basing |
| Float could not be dragged at all | `raise()` referenced an undefined `f` (damage from a careless regex edit), throwing before the drag started | declared and guarded `f` |
| Float drag dead even when raised | `-webkit-app-region: drag` on the float title bar hands the pointer to the OS window manager | removed; the real window titlebar keeps it |
| Tiling computed then discarded | the drag handler wrote back only x/y, not size | writes the full rect |
| Windows buried each other | cascade step 34px, less than the title bar height, so the window below could not be grabbed | step is now `TITLEBAR_H + 12` |
| A missed drop was unrecoverable | only 90px of grab area was kept on screen | whole title bar clamped inside the usable area and clear of the strip |
| Content spread apart inside a float | `height: 100%` on the panel re-triggered `flex: 1` growth, distributing sections down the page | `height: auto`, content columns `flex: 0 0 auto`, body scrolls |
| Relics top bar 646px tall | column-direction top bar let `flex: 1 1 300px` grow on the cross axis | `align-content: flex-start` + children `flex: 0 0 auto` |
| Category click did nothing | a `$$` helper prefix was consumed by a PowerShell `-replace`, turning a `querySelectorAll` loop into a call on one element, which threw at init | restored `$$` |
| Category highlight lost on panel switch | `applyPanelVisibility` cleared every `.active` in 11 branches and restored none | single `syncCategoryActive()` re-applied from `currentCategory` |
| Top bar square over a rounded window | `.titlebar` is a `position: fixed` SIBLING of the shell, so the shell's `overflow: hidden` never clipped it | given the shell's radius and base tint directly |

### Also done
- Left sidebar removed entirely. Equipment categories -> category rail (drag
  re-orderable, persisted); tool buttons -> titlebar; Mastered/Total/%
  Mastery Rank -> status strip. Only two ids disappeared, neither referenced by
  JS. The seven stat elements read unguarded by renderer.js were relocated, not
  dropped, so they did not throw.
- Market ownership filters moved beside the search bar (topbar is one row again).
- The content area showed a dead black region while the active panel was a
  floating window. It now shows a "open in its own window" placeholder with a
  button to dock it back.

### Open
- Regression suite is 10/14. Failing: float drag while a second window overlaps
  it, left-edge tiling, resize, and non-overlap after tiling. The drag mechanism
  itself is sound (in-page pointer test moved a window with zero errors), so
  these are interaction/targeting issues that were not root-caused.
- Tiles do not reflow their internal grids at narrow widths yet - the relic grid
  still shows two columns in a half-width window.
- `styles.css` still carries dead rules for the removed sidebar.

### Process warning
Two real bugs today came from PowerShell `-replace` on JS: `$$` was consumed as
a regex escape, and a `.titlebar {` selector was eaten. `node --check` catches
neither. Prefer the edit tool over regex rewrites on source files.
