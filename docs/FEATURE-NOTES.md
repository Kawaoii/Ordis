# Feature & design notes

A running log for Ordis: what the user asked for, what was spotted in other apps
worth copying, and the decisions behind the technical choices. Appended as things come
up, read when something needs revisiting.

Last updated: 2026-09-30

---

## How this file is used

- **Requests** are things the user asked for, in their words where it matters.
- **Competitor notes** are things worth stealing, with the reason they work.
- **Decisions** are the technical calls, so a later change does not silently undo the
  reasoning behind it.

Nothing here is a task list. Work items live in the session handoff.

---

## Requests from the user

### Layout and chrome

- Tabs should look like the split tabs sitting next to each other in the reference
  image, not a floating pill. A left icon rail **and** drag-to-split, so both.
- Split views must be **seamless**: no gaps above the windows at the corners, panes
  butting together, nothing floating over them.
- Item tiles: **hide the corners** so only the item's own image is seen.
- Mod names need a proper home and better design. Ideally they should *look* like the
  mod they represent rather than a cropped screenshot of one.
- Saved rivens should show the **weapon icon** rather than the "?" placeholder.
- One uniform button and title style for List / Copy / Delete and the filter chips.
- Clicking a saved riven opens the details window, over the game.
- Riven overlay: instant, selection-following, Warframe themed, per-stat tiers,
  weighted-score explanation like AlecaFrame.
- Riven grades: five tiers, Bronze / Silver / Gold / Platinum / Diamond. Hexagon shape
  is acceptable.
- Overlay toggles must survive a restart.
- Relic prices sit **below** the relic cards, AlecaFrame style.
- Market item tiles and codex-like categories are still wanted.
- Logo needs to go on the GitHub repo. The artwork is not on disk yet.

### Riven reading

- The user does not want any Overwolf dependency in the product. Stated firmly.
- The product must not be a band-aid. The wanted end state: a user downloads Ordis,
  switches the reroll overlay on, and it works.
- A single misread number shown as a confident grade is the one failure mode that must
  not exist.
- Read quality matters more than raw speed, but the read has to keep up with a reroll.

---

## Competitor notes

### AlecaFrame

- Riven overlay shows how perfect each stat is, the price of similar rivens, and which
  attributes are best for that weapon. It also compares old and new while rerolling.
  **Worth copying: the per-stat perfection breakdown, not just one overall grade.**
- Riven Explorer: filter and organise your own rivens, see grades and similar market
  rivens, list with one click.
- Riven sniper: alerts when a wanted riven is listed on warframe.market or riven.market.
- Distributed **through the Overwolf appstore**. Installing it means installing the
  Overwolf client, so it can never be a dependency of Ordis.
- Riven values are **received** from Overwolf's plugin event, not read by the app. So
  reverse engineering it would not reveal how to obtain them.
- Keeps a local cache at `%LOCALAPPDATA%\AlecaFrame\lastData.dat` containing rivens
  with real values. WFHelper ships an MIT decryptor for it, so the file is readable.

### WFHelper (MIT, 1,965 commits)

- Electron + TypeScript + Svelte. **No Overwolf anywhere.** Proof that a companion app
  can be built without it.
- Riven scanner, relic reward scanner, relic planner, arbitration summary, all as
  overlays in a borderless window.
- Its riven scanner is OCR, same as ours, and it pairs **YOLO detection** with
  **PaddleOCR** rather than fixed crop boxes. That is the strongest available technique.
- Inventory sources: warframe-api-helper, JSON import, or decrypting AlecaFrame's cache.
- Acknowledges in its own README that "the game has no local inventory API".
- Rivens tab, foundry, mastery, world state, stats, 16 themes, bulk selling.
- Requires the game in English for any scan.

---

## Technical findings

### The riven data problem (settled, with evidence)

Checked against the live API on the user's own account, plus WFHelper's README and
community sources:

- `https://api.warframe.com/api/inventory.php` returns the account. On the raw bytes:
  - `ModValues`, `Compatibility`, `ItemUpgrades`, `RolledStats`: **zero** occurrences.
  - All 638 `Value` fields are `{"Slot":…, "Value":…}`, i.e. loadout slot config.
  - 1088 upgrades but only 97 distinct fingerprints, all plain `{"lvl":5}` rank data.
  - Every "Riven" mention is the Void Riven blueprint, Riven Segments, challenge
    progress, a reward-category label, or a colour object. No riven with stats.
- `warframe-api-helper.exe` does not strip anything. Its `inventory.json` is the same
  payload, and `lastData.dat` is encrypted.
- **Therefore: no API method exposes rolled mod values, for rivens or any mod.**

### What was searched in game memory, and what that does and does not prove

Warframe.x64 is readable without elevation, 4.23 GB committed.

- `CreateToolhelp32Snapshot`-style approach works via `ReadProcessMemory`.
- `/Lotus/Upgrades/Mods/Riven`: 0 hits. `RivenData`: 0 hits.
- `Riven`: only UI strings, sound names, language paths, a `RivenModPack` item path, and
  one `RivenUpgrades/WeaponFactionDaTechrot.png` card icon.
- `LastInventorySync` (the marker Overwolf reportedly uses): **0 hits.**
- The account blob's start marker `{"Created":{"$date":{"$numberLong"`: **0 hits**, so
  the blob is not held as one contiguous string in memory at that moment.

**Caveat, recorded so it is not over-read later:** these are all *string* searches.
Riven values are floats behind hashed or numeric keys, so a string scan cannot see
them. Absence of a string is not absence of the data. The decisive test needs a riven
actually equipped or open in the game, then a rescan. Not yet done.

### The official riven endpoint

- `https://www-static.warframe.com/repos/weeklyRivensPC.json` (+ PS4 / XB1 / SWI),
  announced by [DE]Rebecca in *Riven Trading & Toolbuilders: Phase 1*.
- 143 KB, live. Eight fields per weapon: `itemType`, `compatibility`, `rerolled`, `avg`,
  `stddev`, `min`, `max`, `pop`, later `median`.
- These are **platinum trade values per weapon type**, not stat values.
- Not strict JSON: unquoted keys and single quotes. Needs a tolerant parser.
- Community reports it ships with whole weapons and platforms missing some weeks.
- `rivens.wf` has a public read API with real riven listings, actual stat combos.
  Community data, good as market reference.

### The riven rework — needs handling before it ships

From *Devshorts #115 & #116*, August 2026:

- **Combined stats.** Heat + Cold = Blast, Heat + Toxin = Gas, Cold + Toxin = Viral,
  and Damage + Status Chance = Status. Brand new, not obtainable by cycling.
  A riven with several combinations offers a choice.
- **Stat locking** with Kuva, so a locked stat survives a cycle.
- Nothing in Ordis's parser or stat tables knows any of this yet. Every combined riven
  will read as broken after the update.

---

## Decisions

- **Two engines, and a grade only when they agree.** Windows OCR via
  `@napi-rs/system-ocr` plus Tesseract. Disagreement means no grade, not a guess.
  Measured over 48 captured frames: 6 graded, 42 held back (40 too blurry, 2 real
  disagreements).
- **"Agreed" and "verified" are tracked separately.** A lone engine happens legitimately
  because the Windows engine cannot read the dimmed unselected card. That read is shown
  but labelled as a single source.
- **At least 2 resolved stats** before anything is graded. One misread digit on one
  line would otherwise become the whole result.
- **Language pinned to `en-US`** and passed explicitly. The engine's default follows the
  Windows display language, which read an English card badly on a German desktop.
- **`@napi-rs/system-ocr` over a PowerShell spawn.** Same engine, ~100-120ms per card
  in-process, no temp file, and it returns normalised bounding boxes.
- **No Overwolf, ever.** Riven collection is built up from verified reads as the player
  uses the app, plus manual entry. Not a stopgap: it is the only route that keeps values
  correct without a third-party client.
- **Reroll overlay needs no data source at all.** The riven is on screen. This is the
  part that is genuinely solved.

## Branding

The user drew a pixel-art wordmark. The letterforms are tight-set, so the single "R"
was extracted by hand-placed crop rather than by column gaps: the letters touch, which
defeats segmentation, and an auto-detected background picked white on a tight crop and
removed the letter instead of the canvas.

- `assets/ordis-mark.png` is that "R", 512x512, transparent, built with integer-only
  nearest-neighbour scaling. Any fractional scale resamples the blocks and destroys the
  effect, which is the whole point of the style.
- The titlebar's previous emblem and its letterspaced `ORDIS` text are gone. The emblem
  was the upstream project's, and the text repeated the window title next to a mark that
  already said the same thing.
- The same mark is the app icon for Windows and Linux, and the README's header image.
- **The repo avatar on the GitHub website is not a file in the repo.** The user has to
  upload it in the repository's Settings; nothing in the tree can change it.

The wordmark itself was not adopted. It extracts unreliably: the source has a stray line
near the bottom that stretches the detected bounds, and the letters cannot be separated
automatically. If a clean single-letter version is ever drawn, dropping it into
`assets/ordis-mark.png` is all that is needed to update the icon, the titlebar and the
README at once.

## Known bugs

- Split view: the rail renders on the **right** and the left pane comes up empty. The
  pane container is being inserted in the wrong place relative to the panels. Not fixed.
- Reroll re-read every frame: the dedupe hash covers the whole card including the
  **rotating riven art**, so the hash always changes. Fix is to hash only the static
  text band, which keeps "a new roll appeared" detection and ignores the animation.
- `docs/SESSION-HANDOFF.md` is stale after all of the above.

---

## Linux support: wanted, deliberately last

**Decision, 2026-09-30: finish Windows first, then Linux.** The user is on Windows 11
with a CachyOS install on a second M.2 drive. The riven reader works on Windows only
today, so switching the daily system before the Linux reader exists would mean not being
able to test the app's flagship feature. CachyOS gets used for targeted testing until
then, and the switch is a reward at the end rather than a handicap at the start.

An audit of the current tree found the portability surface is small and already mostly
in the right shape:

- **Four** `process.platform` guards in `main.js`, three of which already have
  `win32` / `darwin` branches rather than assuming Windows.
- **No drive-letter paths anywhere.**
- **No backslash path separators** in app code. `renderer.js` already normalises `\` to
  `/` when comparing paths, which is the right instinct.
- `desktopCapturer` is cross-platform in Electron.
- **One** Windows-only shell-out: `tasklist.exe`, used to find the game process.

### The two decisions that would be expensive to reverse

1. **Put the riven memory reader behind an interface, not inline `process.platform`
   checks.** Windows reads with `ReadProcessMemory`; Linux needs `process_vm_readv` and
   is gated by `kernel.yama.ptrace_scope`. If the scanning pipeline calls a Windows
   function directly, adding Linux becomes a rewrite of the pipeline instead of a new
   file dropped into it.

2. **Give `tasklist.exe` a non-Windows fallback** (`pgrep -f`). Cheap now, and it is the
   kind of thing that gets forgotten and then blocks a launch.

### What is known to be awkward on Linux, and is not solvable by us

- **Overlays need layer-shell.** GNOME has no layer-shell at all, so overlays there are
  best-effort or absent. X11 is the easy case. This is a compositor problem, not a port
  problem.
- **Memory reading is blocked by default.** Most distributions ship
  `kernel.yama.ptrace_scope=1`; relaxing it lets any program read any other program's
  memory. Linux users have to opt into that, which Windows users do not. Expect this to
  be the main source of support questions.
- Mission-log and worldstate features depend on Proton and on the `PROTON_LOG=1` launch
  option.

### Parked work

`tools/linux-riven-scan.py` is written and **never executed**, because there is no Python
on the Windows machine. It is a self-contained ctypes port of the Windows scanner and
needs running on the CachyOS drive. Its whole purpose is to answer one question: does
the riven summary still sit in memory as plain text under Proton? If it does not, the
Linux riven reader is a different problem and that needs knowing before any port starts.

`ptrace_scope` will almost certainly need relaxing on the CachyOS drive for the scan to
return anything.

---

## BREAKTHROUGH: the player's rivens are readable in game memory

**2026-09-30. Proved on the user's own running game, read-only.**

The user pushed back on an earlier claim that the memory route was closed. They were
right and the claim was wrong. The earlier scans had all been run while **no riven was
equipped or on screen**. With a riven card displayed, the player's whole riven
collection is in `Warframe.x64`'s memory as plain readable text.

Found with `ReadProcessMemory`, no elevation, no injection, no Overwolf:

```
Corinth Conci-acrican                      @ 024620DDA178
Phenmor Conci-vexinok                      @ 0246576A7050
Corinth Conci-acrican +8.7% Critical Damage @ 024657803DA0
Phenmor Conci-vexinok +6% ...              @ 024657B677E0
```

And the block around one of them, which is the whole riven:

```
Corinth Conci-acrican +8.7% Critical Damage
+9% Projectile Speed
+11.4% Multishot MR 14 Shotgun
```

A second, different riven, found in the same region:

```
+16.3% Multishot
+10.5% Fire Rate (x2 for Bows)
+6.8% Reload Speed
-11.2% Puncture
```

### What this gives us that nothing else did

- **Exact values.** No OCR, so no misreads. The single failure mode this whole reader
  was built to avoid disappears for this path.
- **The whole collection, not just the visible riven.** Every riven appears, including
  ones never equipped.
- Weapon name, every stat with sign and value, mastery rank, and weapon class
  (Shotgun / Rifle / Pistol / Melee) in one block.
- Read-only, in-process, no third-party client. Same technique class as
  `warframe-api-helper`, which the user already ran.

### Why the earlier scans found nothing

Searches for `/Lotus/Upgrades/Mods/Riven`, `RivenData`, `LastInventorySync` and the
account blob's start marker all returned zero hits. Those were string searches for
type paths and structural markers. The riven text is stored as **display strings**, so
a search for the riven's own name finds it immediately and the type paths never
appear at all. Searching for the wrong thing is indistinguishable from the thing not
being there, which is exactly the mistake to not repeat.

### Honest limits

- **ToS.** Memory readers are not covered by Warframe's terms. Same category as the
  helper the user already chose to run. Their call, not ours.
- **Brittle.** Layout and strings can change with a game update. Any extractor needs a
  fallback and must fail quietly rather than report a wrong value.
- **Strings, not structure.** The values are display text. A locale change or a
  re-worded stat would need the same alias handling the OCR parser already has.
- Not yet built. No extractor exists; this is the discovery that makes one possible.

### Next step for this

Scan for riven blocks by anchoring on the trailing `MR <n> <Class>` that ends each
block, extract backwards to the weapon name, and parse with the existing parser so
there is one code path for reading a riven regardless of where it came from.
