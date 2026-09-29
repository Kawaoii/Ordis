# DOCK SYSTEM

iOS-style snap docking for the app's 12 panels. Implemented in `dock.js`, styled
in `ordis-design.css` section 7.

## The interaction

Modelled on the iOS home screen rather than a desktop window manager, because
that is the behaviour that was asked for.

1. **Press and hold** a tab in the bottom dock strip for ~380ms. It lifts with a
   scale-up, a glow, and its label expands. That is the "pick up" cue.
2. **Drag.** The tab follows the cursor. While it is over the strip the other
   tabs reflow live (FLIP) and a glowing drop marker snaps between them.
3. **Drag away from the strip** and the panel tears off into a floating glass
   window that keeps following the cursor.
4. **Floating windows snap** to a 12x8 grid while being dragged and while being
   resized, so windows line up instead of drifting.

A plain click still just switches panels, and moving before the hold completes
cancels the drag, so brushing across the strip never starts a drag.

## Why it is a separate module

`renderer.js` owns panel visibility and lazy loading, and it treats `#content` as
the checklist panel itself (`getPanelRefs()` maps `checklist -> $('#content')`).
The panels are therefore *children of the content container*, and anything docked
into that container would be hidden whenever a different panel is shown.

So the dock builds its own layer above `#content` and only ever moves panel
elements in and out of that layer. `renderer.js` keeps doing what it already did
correctly, and `showPanel` is exposed as `window.showPanel` so there is exactly
one implementation of "show a panel".

## State

Persisted to `localStorage` under `ordis.dock.v1`:

```json
{ "order": ["checklist", "market", "..."], "floats": { "market": {"x":0,"y":0,"w":720,"h":460,"z":101} }, "active": "checklist" }
```

Unknown ids are discarded on load rather than trusted, so renaming a panel cannot
blank the strip. `applyFloat()` re-clamps on every apply, so a window restored at
a size larger than the current window cannot start off-screen.

## Things that are deliberately not done

- **`checklist` cannot be torn off.** It is `#content`. Moving it would destroy
  the app. `tearOff()` detects this and bails.
- **No free-floating by default.** Positions are snapped and clamped, per the
  request for iOS-like snapping rather than arbitrary placement.
- **Blur stays off cards.** A torn-off Market window renders its full card set,
  and 200+ live `backdrop-filter`s previously stalled the renderer.

## Bugs found and fixed while building this

Worth knowing because they are easy to reintroduce:

- **Torn-off windows rendered empty.** Moving the panel element is not enough:
  every panel carries the `hidden` class, so the window sat there showing only
  whatever was behind it through the glass. `tearOff()` now calls `focus()`.
  The same applied to windows restored from `localStorage` on startup.
- **Interactively created windows had no resize handles.** `decorateFloats()`
  only ran once during init, so handles were built for restored windows but not
  for ones torn off in the session.
- **Windows could be dragged off-screen** and become unreachable, since the
  title bar is the only grab area. `clampRect()` keeps 90px on screen.
- **The dock/close buttons were handled on `pointerdown`**, which never fires for
  keyboard Enter/Space. They are on `click` now.
- **FLIP reflow could never animate** because `renderStrip()` rebuilt every tab,
  destroying the elements the animation measures. `syncStripOrder()` reorders the
  existing nodes instead.

## Tests

In `%TEMP%\opencode`, not in the repo:

- `dock-tearoff.mjs` — lift, tear off, clamp, re-dock, persistence.
- `resize-test.mjs` — handle presence, SE grow/shrink, west-edge origin
  correction, on-screen clamp.
