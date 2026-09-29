# Fork Migration

This repository is a fork. The lineage is:

```
Hasan580/Warframe-companion-app   (original)
  -> Kawaoii/Ordis                (intermediate fork; this is what package.json named)
    -> yours
```

This document lists what was already made fork-safe, what still points
upstream, and the licensing/ToS points worth your own attention.

---

## 1. Already done

**Update checker no longer hardcodes upstream.** `renderer.js` had
`UPDATE_REPO_API` pointing at `Hasan580/Warframe-companion-app`, so the app
checked *upstream's* releases and would have offered a download built from code
your fork does not contain. All of it now derives from one block:

```js
const FORK = Object.freeze({
  OWNER: 'Kawaoii',
  REPO: 'Ordis',
  UPDATE_ENABLED: true
});
```

Setting `UPDATE_ENABLED: false` short-circuits `checkForUpdates()` entirely.

**`package.json` packaging was missing new files.** `build.files` is an explicit
allowlist, and `dock.js`, `ordis-design.css` and `riven-overlay-dashboard.html`
were absent, so a packaged build shipped without them. Added.

## 2. Still to change

| Where | What | Note |
|---|---|---|
| `renderer.js` `FORK.OWNER` / `FORK.REPO` | `Kawaoii` / `Ordis` | Set to your remote. |
| `renderer.js` `TELEGRAM_CONTACT_URL` | `https://t.me/Hassanf0` | The upstream author's personal contact, surfaced as a button in Settings. It currently points at a stranger. Remove the button or repoint it. |
| `package.json` `author`, `build.productName`, `build.appId` | `Kawaoii`, `Ordis`, `com.warframe.companion` | Yours. Keep `appId` distinct from upstream or an installed fork will collide with it. |
| `package.json` `build.publish` | `owner: Kawaoii`, `repo: Ordis` | Auto-update target. |
| App title / `index.html` strings | "Ordis" | Consider renaming if you intend to distribute. |

## 3. Where the data comes from

| Source | Used for | How |
|---|---|---|
| `api.warframe.market` v1/v2 | items, orders, contracts, `/v2/me` | Runtime API |
| `warframestat.us` | news, vault trader, worldstate | Runtime, **third-party community API** |
| `warframe.com/cdn/worldState.php` | official worldstate | Runtime, official |
| `wiki.warframe.com` + `warframe.fandom.com` | item art, descriptions | Runtime, MediaWiki API |
| `raw.githubusercontent.com/WFCD/warframe-items` | relic/arcane catalogues | Runtime, community data repo |
| `CDN_URL` (Warframe asset host) | item images | Runtime |

Almost everything is fetched at runtime. What is **bundled and redistributed** is
the higher-risk set:

```
assets/AxiRelicIntact.png          47 KB   game art
assets/NeoRelicIntact.png          45 KB   game art
assets/RequiemRelicIntact.png      36 KB   game art
assets/deimos-vome-fass-cycle.jpg  1.7 MB  game art
assets/earth.png                  3.0 MB
assets/ordis-backdrop.png         3.0 MB   (copy of the root earth render)
assets/warframe-companion-app.png 1.8 MB
assets/easteregg song.mp3         5.4 MB   provenance unknown
assets/mastered logo.png          4.9 MB
```

## 4. Licensing / ToS points

**This is not legal advice.** These are the factual issues I found while reading
the code. Get your own read, and ask someone qualified before you distribute
anything.

**Trademarks.** "Warframe" is Digital Extremes' trademark. Using it descriptively
in a third-party companion tool is generally fine, and non-commercial status
strengthens that. The risk is implying endorsement — a fork that keeps upstream's
name, icon and description while being redistributed is more exposed than one
that doesn't. `appId` reuse compounds this: two packages claiming
`com.warframe.companion` cannot coexist cleanly.

**Bundled game art.** Relic tier icons and the Deimos cycle image are Warframe
assets. Displaying them by remote URL is a materially different situation from
shipping copies inside your installer. The bundled relic icons are the item most
worth replacing with something you have the right to redistribute, or dropping
and fetching at runtime like everything else.

**Unknown-provenance files.** `easteregg song.mp3` (5.4 MB) and
`ordis-backdrop.png` / `earth.png` (identical 3 MB files) have no visible
attribution. They are also dead weight: the backdrop is no longer used now that
the window is transparent. Both `ordis-backdrop.png` and the root
`3d-rendering-planet-earth.png` are unused and can be deleted outright.

**Wiki content.** Fandom-hosted Warframe content is CC BY-SA. That licence
requires attribution and share-alike *for that content*. Because the app fetches
it at runtime and keeps it out of the source tree, it does not normally extend
to the app's own code — but the wiki terms of use and the official
`wiki.warframe.com` terms are worth reading directly, and attribution is cheap to
add.

**Warframe.market.** There is a public API and order management is a supported
use. The relevant risk is automated request volume. The app makes a lot of
unrelated calls on panel switches; if you distribute this, add request
coalescing/caching and respect rate limits, and re-read their terms because the
Contracts work leans on `/v1/auctions` and the riven endpoints.

**warframestat.us** is an unofficial community API with no stability guarantee —
the codebase already treats it as fallible and falls back to other sources. It
can go away without notice and take features with it.

**Auto-updating a fork.** `electron-updater` pushing your builds is fine, but it
must never be pointed at a repository you do not control. That is exactly the bug
fixed above; do not reintroduce it by editing only one of the four URLs.

## 5. Suggested order of work

1. Delete `assets/ordis-backdrop.png` and the root `3d-rendering-planet-earth.png`
   (unused now the window is transparent).
2. Replace or drop the three bundled relic icons and the Deimos jpg.
3. Resolve the provenance of `easteregg song.mp3`, `mastered logo.png`,
   `launcher-preview.png`.
4. Set `FORK.OWNER` / `FORK.REPO`, `package.json` author/productName/appId/publish.
5. Decide what to do with the Telegram contact button.
6. If distributing: confirm your position on the trademarks and on Warframe's
   fan-content policy.
