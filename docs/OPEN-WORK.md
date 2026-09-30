# Open work

Everything here is unfinished. Written down so it stops living in a conversation and
starts being a list. Ordered by what is blocking what, not by when it was noticed.

Last updated after `17ffd0e`.

---

## 1. Riven overlay — the feature that is not finished

The memory reader is exact and fast. The overlay that shows its result in-game is
roughly half built, and every item here is a reason it does not behave like AlecaFrame.

### 1a. Read a baseline on the pre-cycle screen — **the big one**

All three log signals are already matched in `main.js`:

| signal | matcher | when |
|---|---|---|
| `OmegaRerollSelection.swf` | `isRivenRerollScreenLogText` | the selection screen — where AlecaFrame appears |
| "Are you sure you want to cycle" | `isRivenRerollConfirmLogText` | before the player answers |
| "Cycle Riven into current selection" | `isRivenRerollChoiceLogText` | the new roll, which is what we currently trigger on |

**The first two call `resetRivenOverlayBurst()`.** On the pre-cycle screen — the exact
moment a competitor's overlay shows up — we are tearing the scan down instead of reading.

Flipping them from cancel to read is two lines. It is not two lines of work, because a
baseline is a different *kind* of read:

- the new-roll read looks for a fingerprint it has not seen
- a baseline wants "whatever is selected right now", which is already in memory and
  already fingerprinted

So it needs its own read mode, and it has to stop updating once the new roll lands, or it
will overwrite the answer with the thing the player just replaced. Same shape as 1b.

### 1b. Two windows, previous left and current right

`readPendingRivenFromMemory` already returns `previousText` alongside the new roll, so
both cards come out of a single pass. Not built. The data is there; the windows are not.

### 1c. Live verification of everything shipped today

`e4f037b` (persistence), `d69e3cc` (cache warm, log priming, ALT+R) and `17ffd0e`
(serialised bursts) have **never been run against the game**. They parse, every identifier
resolves, and the trace shows the cache warm working — but "parses" is how the undefined
constants shipped. Someone has to cycle a riven.

### 1d. The OCR fallback reads our own window

Trace `bestText` came back containing `Estimating resolution`, `46 diacritics`, `expand` —
that is `npm run dev` output in the terminal. The crop is landing on the app, not the game.
Only bites when memory misses, and only when Ordis is not fully behind the game, but it
means the fallback is not trustworthy in a normal window arrangement.

### 1e. First roll after a game launch is still a cold walk

Cache warming helped enormously (14s → 4.5s measured) but it is a background task. Cycle
within the first seconds of launching Warframe and you still pay the full walk.

---

## 2. Corners — started, does not work

The audit that started this is sound: it reads what the browser actually resolved rather
than what the stylesheet says. The fixes are in the working tree, **uncommitted**, and only
one of the four landed:

| surface | intended | measured |
|---|---|---|
| `.split-workspace` | 10px | **10px — works** |
| `.app-container` | 14px shell | **0px — not applied** |
| `.split-pane-body` | 13px bottom | **0px — not applied** |
| `.content-topbar.rivens-topbar` | 13px top | **0px — not applied** |

`.app-container` is outranked by two `!important` rules at `ordis-design.css` L405 and
L567, both setting `border-radius: 0 0 16px 16px !important` because the titlebar was
meant to own the top pair. That intent is probably still right — the window *is*
frameless and transparent, so the shell needs the curve, but those two rules have to be
reconciled rather than appended to.

`docs/UI-FIXES.md` carries the full diagnosis. Floating windows and modal surfaces are
still square and were never in scope for the first pass.

---

## 3. Riven data

- **Grade vocabulary undecided.** The code emits `S/A/B/C`. The original request was
  Bronze → Diamond. Never resolved, and it touches the detail modal, the row badges and
  the notifier.
- **Rank is never shown.** Values are current-rank, so a rank-0 riven looks artificially
  bad next to a maxed one. The reader does not read rank.
- **`npm run verify:riven-bases` fails on 11 combined stats** — pre-existing, and no bases
  were invented to paper over it.
- **Similar-riven pricing / live listings** — not started.
- **OCR is ~50% on real frames.** Fallback only, by design. It is not going to get better
  without a different approach.

---

## 4. Rail icons

`riven-rune` and `mod-card` are drawn and inline. **Two art files were never created:**

- `assets/void-trace.png` (Relics)
- `assets/argon-crystal.png` (Resources)

Both fall back to a glyph, correctly, via a delegated error handler. WFM does not index
resources or rivens and the worldstate endpoint returns no item list, so these need to be
sourced by hand or drawn like the other two.

The lens circle is visible but subtle. The magnification is the part that reads.

---

## 5. Container-query scaling

Working, and measured: search 36/30/28px, type 13/12/11px, topbar padding 24/12/8px.

**Two rules in the block are unverified** — `.filter-btn` and the equipment `.nav-text` —
because the pane measured was the market, which has neither. They are written to the same
pattern and the cascade is proven, but nobody has looked at them on the equipment pane.

---

## 6. Glass theme — a trial, off by default

`node tools\toggle-glass.js on`. Never seen next to the game.

Known problems, all unaddressed:

- **Grade badges are tuned for dark.** `S/A/B/C` will wash out on cream. This is the part
  to measure rather than eyeball, because it is what a player would trust least.
- **Relics and the Void panels are dark by nature** and will look broken in a cream app.
- **Glass over a flat background is invisible.** The wash behind it is not decoration.
- **`backdrop-filter` is expensive.** It is applied selectively (rail, panes, floats) and
  lists and grids are deliberately excluded, because a pane of fifty glass cards would
  stutter through every drag. That boundary has not been load-tested.
- The text scale is fully inverted for a light ground. Every pair needs contrast checking.

---

## 7. Platform and packaging

- **Linux scanner has never run.** `tools/linux-riven-scan.py`, needs
  `kernel.yama.ptrace_scope=0`. The launcher failed with a Windows-specific
  `StandardErrorEncoding` error and was never fixed.
- **The app has never been built as an installer.** `npm run build:win` is untested. Every
  recent change is verified in `npm run dev` only, and the packaging story — including
  whether `tools/riven-scan.ps1` is reachable from inside the asar — is unproven.
- **GitHub repository avatar** is not set; it cannot be set from a file in the repo.
- **No fresh backup.** `C:\Users\Kawaoii\Documents\Ordis-backups\2026-09-30_072459` predates
  all of the above.

---

## 8. Unexplained

**CSS transforms do not apply to the rail's inline SVGs.** With `.is-lensed` set, the
computed transform stayed `matrix(1,0,0,1,0,0)` and the box never grew — while the same
`scale()` applied inline with `!important` worked, and a control SVG scaled fine. Worked
around by sizing with width/height instead. **Not diagnosed.** It may affect other inline
SVGs in the app, and the workaround is a guess dressed as a fix.

---

## 9. Process notes, for whoever picks this up

Three faults this session were invisible from reading the code and only appeared when a
probe measured what the browser or Node actually did:

- two constants used before they were defined, which threw on every failing scan
- a PowerShell edit left a literal `$2` in a function body: parses fine, throws on call
- a restore loop whose guard made it a no-op, so every tab switch deleted a panel

Two scripted edits are now swept for (`\$1`/`\$2` artifacts, and a wrong-API check for
`fs` vs `fsSync` in `main.js`). **Prefer the edit tool over PowerShell regex for
source changes.** Both breakages came from regex replacement, and neither was visible in
`node --check`.

The probes are the regression gates and they are worth keeping: all-tabs, three-pane drag,
layout switch, persistence, corners audit, and the riven overlay trace.
