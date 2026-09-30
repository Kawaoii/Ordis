# Ordis — session handoff

> **Partly superseded.** The riven-reading section below predates the discovery that
> Warframe keeps each riven's full summary as a readable string in its own process
> memory, and the OCR pipeline described here was later measured at roughly 50% correct
> stat values on real frames of the riven screen. Read [FEATURE-NOTES.md](FEATURE-NOTES.md)
> for the current state, especially its "BREAKTHROUGH" section. What follows is still
> accurate for the relic overlay, the parser and the riven data tables.

Written so work can continue after a reboot or a lost conversation. Everything
here is also in Git history and in the dated backups, so nothing depends on
this file.

## Where things are

- Repo: `C:\Users\Kawaoii\Documents\GitHub\Warframe-companion-app`
- Remote: `https://github.com/Kawaoii/Ordis.git` (upstream: Hasan580)
- Dated backups: `C:\Users\Kawaoii\Documents\ordis-backups\` (12 kept)
- Backup runner: `C:\Users\Kawaoii\AppData\Local\Temp\opencode\backup.cjs`
- Test harnesses: `C:\Users\Kawaoii\AppData\Local\Temp\opencode\*.mjs`

Latest commit at time of writing: `8e23863` Fix the riven parser against a real
in-game screen.

## Pushed and done

- Ordis rebrand, attribution, About screen, `appId: io.github.kawaoii.ordis`
- Warframe.market: browser/PAT login, session rehydration across restarts, My
  Orders, set part counts, Prime merge, post-order form and orders table styled
- Michroma bundled with its OFL licence; design tokens; rounded corners;
  full-bleed item tiles; per-view panel tint
- **Rivens tab** — every successful scan is filed to `riven-inventory.json`
  (sort by grade/perfectness/disposition/name/newest, filter, search, copy
  trade string, delete, list)
- **Reroll diff overlay** — previous roll left, new roll right, per-stat
  good/poor colouring. Works for every weapon because it only compares two OCR
  reads.
- **Prime rivens grade correctly.** Was "unknown, score 0" for every Prime.
  Fixed by merging rivens.wf dispositions and falling back to the base
  weapon's community-sheet entry.

## Data sources, and what each is good for

| Source | Covers | Used for |
|---|---|---|
| `api.warframe.market/v2/riven/weapons` | 420 weapons, 7 Prime | authoritative `rivenType` + icon |
| `rivens.wf/api/v1/weapons` | 881 variants, 189 Prime | fills Prime dispositions |
| 44bananas sheet | 114 rows, 2 Prime | which stats are good per weapon |

**Known gap:** dispositions for the newest content (Gara, Garad, Grimaldi,
Kavatak, Hemera, Khora, Scimitar, Thrax Prime, Verglas Prime, Coda weapons,
Rubedo Prime, Toridak Prime) are published nowhere. Warframe.market's own
database (`42bytes-team/wfm-items`, `tracked/rivens/items`, 414 files) is
missing them too. The app reports perfectness as unknown rather than guessing.

## Hard limits (verified, not assumed)

- **Warframe.market orders cannot bind a specific riven.** Riven orders carry
  only `subtype: revealed|unrevealed` on the generic `<class>_riven_mod_veiled`
  item. No per-riven id, no stat data. Which riven an order refers to is agreed
  and traded in game.
- **Contracts are not in the public v2 API** (404 on every plausible path),
  even though the rules page rate-limits "contract search endpoints".
- **The public profile has no mods.** `getProfileViewingData.php` returns
  Equipment (frames/weapons/companions/loadouts), Stats, Syndicates, Challenges,
  Wishlist. It cannot list your rivens.
- **AlecaFrame's public API is stats and relics only** — no riven data. Their
  advantage is that they are an Overwolf app and read the real inventory.
- **The user does not want an Overwolf dependency.** Ordis must stay a
  standalone Electron app. The inventory-enumeration route that needs no
  third-party anything is OCR of the in-game mod screen.

## The OCR finding from a live test

Tested on a real Ocucor reroll. The pipeline did not work, and none of this was
visible from fixtures. Fixed in `8e23863`:

- the stat value is the first number whose following text starts with a letter
  (OCR debris like `0) +112.1% Slash` was dropping whole stats)
- stat names are trimmed of trailing debris, accepted only if the trimmed form
  still resolves
- attribute names resolve within one OCR edit ("Recoll" -> Recoil)
- every leading word run of a `<Weapon> <RivenName>` line is offered as a
  weapon candidate; the known-weapon lookup decides ("Ocucor" is a weapon,
  "Ocucor Sci-zetides" is not)
- two stats on separate lines were being merged; a wrapped name is letters only

Result on that capture: previous riven 3/3 stats, new riven 2/3. The third,
`+112.1% Slash`, was lost on that frame and needs one more live test.

**Not yet done:** the two cards must be cropped and OCR'd **separately**. OCRing
the screen as one flat stream merges them ("Ocucor Visilis Ocucor Sci-zetides"),
because both cards' text sits at the same height.

### Per-card cropping (done, not yet committed at time of writing)

Both cards are now cropped and read on their own, so they can never merge:

- `RIVEN_OVERLAY_CARDS` in `main.js` holds the two regions. Measured on the real
  frame by eye against a grid overlay, not guessed: left card x 0.275..0.410, right
  card x 0.410..0.578, both y 0.420..0.775. The gap between the cards is empty from
  0.390 to 0.430, so the split sits in the middle of a 0.04-wide margin.
- The right card is the new roll and is what gets graded. The left card is the roll
  it replaces, so the before/after overlay now reads the previous roll off the same
  frame instead of remembering the last scan, and survives a restart. It is only
  used when it grades as the same weapon, and any doubtful read falls back to the
  remembered roll.
- `PSM.SINGLE_COLUMN` instead of `SINGLE_BLOCK`, and ~3.4x upscale. A card is one
  centred column under a picture; `SINGLE_BLOCK` pulled the card art and the button
  below it in, which is where the junk name candidates came from.
- Replaying the saved frame through the shipped numbers: left card 3/3 stats, right
  card 3/3 including `+112.1% Slash`, both weapon names first in the candidate list.
  Two OCR passes cost about 2.5s including worker start, so it is not a perf worry.

Three parser bugs came out of that replay, all in `riven-parser.js`:

- `v &x0.72 Damage to Infested` was read as a **72% penalty** instead of the 28%
  shortfall. A marked fraction under 1 is now read like a bare one. This was the
  dangerous kind of bug: a wrong value grades silently.
- `+88 .3% Status Duration` was read as **3%**. A space inside a decimal is now
  closed before the value is picked.
- `+112.1% \_Slash` was dropped because debris sat between the value and the name.
  Any non-alphanumeric run is now skipped before the name is read.

## Environment notes

- Launch Electron **without** `-WindowStyle Hidden`, and never let a shell
  command time out while it runs, or the tool kills the process tree.
- A hidden window makes Chromium report `document.hidden: true` and composite
  every `backdrop-filter` into one smeared layer — screenshots come out
  uniformly blurred. Fix for captures:
  `Page.setWebLifecycleState {state:'active'}` + `Emulation.setFocusEmulationEnabled`.
- Do not sweep on `.modal` and add `hidden` — `#market-orders-modal` is
  full-screen with `backdrop-filter: blur(6px)` and un-hiding it smears the app.
- Warframe is at `S:\SteamLibrary\steamapps\common\Warframe`. `EE.log` is at
  `%LOCALAPPDATA%\Warframe\EE.log`.
- The machine has 24 GB RAM. `opencode` held 2.2 GB commit because the session
  DB is ~2 GB of screenshots. Keep large captures out of the transcript.

## Next work

1. One live reroll to confirm the per-card read in the app itself: both cards
   graded, the diff showing the on-screen previous roll. Everything up to that
   point was verified by replaying the saved frame, not in game.
2. Riven images in the tab — data already available (WFM serves an icon per
   weapon); `riven-data.js` carries `icon` through.
3. Riven detail window: per-stat verdicts + live weapon-class order book
   (lowest/avg/highest, counts). Real data, no fabricated per-attribute prices.
4. Inventory-screen OCR so the Rivens tab lists rivens already owned.
5. `docs/CHANGELOG.md`, `docs/ARCHITECTURE.md`, `README.md` refresh; push.
6. Dock regression suite still 10/14: float-drag overlap, left-edge tiling,
   resize, post-tile overlap.
