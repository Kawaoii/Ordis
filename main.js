const { app, BrowserWindow, ipcMain, shell, dialog, desktopCapturer, screen } = require('electron');
const path = require('path');
const fs = require('fs/promises');
// Promises for the work, sync only for the two existence checks that decide where a
// bundled script lives, which have to be answered before anything can be awaited.
const fsSync = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');

// tesseract.js and electron-updater are deliberately NOT required at startup.
// They cost ~830ms of blocking require time between them and neither is needed
// to show a window, so they load on first actual use instead. See getOcrModule
// and getAutoUpdater below.
let tesseractModule = null;
let autoUpdaterModule = null;

function getOcrModule() {
  if (!tesseractModule) {
    tesseractModule = require('tesseract.js');
  }
  return tesseractModule;
}

// riven-data.js pulls in the grade sheet and market parsers and riven-parser.js
// pulls in riven-data.js, so they are loaded on first riven scan for the same
// reason tesseract is: nothing on the startup path needs them.
let rivenParserModule = null;
let rivenDataModule = null;

function getRivenParserModule() {
  if (!rivenParserModule) rivenParserModule = require('./riven-parser.js');
  return rivenParserModule;
}

function getRivenDataModule() {
  if (!rivenDataModule) rivenDataModule = require('./riven-data.js');
  return rivenDataModule;
}

function getAutoUpdater() {
  if (!autoUpdaterModule) {
    autoUpdaterModule = require('electron-updater').autoUpdater;
  }
  return autoUpdaterModule;
}

let mainWindow;
let relicOverlayWindow;
let rivenOverlayWindow;
let wfmLoginWindow;

/**
 * The verified Warframe.market session token, held in the main process.
 *
 * WHY THIS EXISTS
 * ---------------
 * setWfmCookie() writes the JWT into Chromium's cookie jar, but API calls are
 * made with Node's global fetch (undici), which keeps its own cookie handling and
 * never reads Chromium's jar. So storing a cookie alone authenticated nothing:
 * every session-authenticated request went out anonymous and came back 401.
 *
 * The token is therefore also kept here and injected as an explicit Cookie header
 * on outgoing requests. It is only ever set after verifyWfmTokenInMain() has
 * proven the token actually works, and it is never logged.
 */
let wfmSessionToken = '';

/**
 * Warframe.market request headers, in one place.
 *
 * These were previously written out separately at each call site and had drifted
 * apart, which is how the authentication bug survived: one place verified a
 * session with a cookie, another deleted the Authorization header outright, and a
 * third went out with no identifying header at all.
 *
 * Per the published API contract:
 *  - Requests must carry a descriptive User-Agent. Impersonating a browser is
 *    explicitly forbidden and is grounds for being blocked, so this never lies
 *    about being Chrome.
 *  - Authenticated calls send `Authorization: Bearer <jwt>`. The legacy JWT
 *    cookie is sent too, because the site still honours it and dropping it
 *    regressed verified sessions.
 *  - Crossplay defaults to false server-side, so without this header every
 *    crossplay order is silently missing for PC-side buyers.
 */
const WFM_API_BASE = 'https://api.warframe.market/v2/';

function wfmUserAgent() {
  let version = '';
  try {
    version = String(app.getVersion() || '').trim();
  } catch (err) {
    version = '';
  }
  const label = 'Ordis' + (version ? '/' + version : '');
  return label + ' (+https://github.com/Kawaoii/Ordis)';
}

function wfmHeaders(extra) {
  return Object.assign({
    'Accept': 'application/json',
    'User-Agent': wfmUserAgent(),
    'Platform': 'pc',
    'Language': 'en',
    'Crossplay': 'true'
  }, extra || {});
}

/** Adds both documented and legacy auth to a header set, if a token is known. */
function wfmAuthHeaders(headers, token) {
  const raw = String(token || '').trim();
  if (!raw) return headers;
  const bare = raw.startsWith('JWT ') ? raw.slice(4).trim() : raw;
  if (!bare) return headers;
  headers['Authorization'] = 'Bearer ' + bare;
  headers['Cookie'] = 'JWT=' + bare;
  return headers;
}
const DEFAULT_MIN_WIDTH = 1024;
const DEFAULT_MIN_HEIGHT = 640;
// The topbar carries a search field plus nine filter controls, two status pills
// and the window buttons. At the old 1280 default that row did not fit, and the
// controls on the right were clipped out of view with no way to scroll to them.
// 1440 is the width at which that row lays out on a single line.
const DEFAULT_WINDOW_WIDTH = 1440;
const DEFAULT_WINDOW_HEIGHT = 900;
let isDev = !app.isPackaged;
let updateDownloaded = false;
let ocrWorkerPromise = null;
let activeOcrProgressTarget = null;
let relicOverlayEnabled = false;
let relicOverlayTimer = null;
let relicOverlayScanning = false;
let relicOverlayLastHash = '';
let relicOverlayLastHashAt = 0;
let relicOverlayLastDetectionAt = 0;
let relicOverlayLastCaptureAt = 0;
let relicOverlayBurstUntil = 0;
let relicOverlayLogTimer = null;
let relicOverlayLogPath = '';
let relicOverlayLogOffset = 0;
let relicOverlayLogMissingNotified = false;
/**
 * Per-stat verdict, resolved here rather than in the renderer because this is
 * the only place the community sheet's goodStat and acceptableNegative lists
 * are in scope.
 *
 * This is the "which of these rolls are the good ones" judgement the Rivens
 * detail window shows per line. It is the community's opinion about the weapon,
 * not a price, and it is the part of AlecaFrame's riven view that comes from
 * public data.
 *
 * A stat with no verdict is reported as unknown rather than assumed harmful:
 * most players mis-read "not in the good list" as "bad", and for a stat the
 * sheet does not cover that is simply not known.
 */
function describeRivenStatVerdicts(weapon, stats) {
  if (!weapon || !Array.isArray(stats)) return [];
  const goodStats = new Set(weapon.goodStats || []);
  const acceptableNegatives = new Set(weapon.acceptableNegatives || []);
  const hasCommunityData = Boolean(weapon.hasCommunityData);

  return stats.map((stat) => {
    const out = { name: stat.name, isPositive: !!stat.isPositive, verdict: 'unknown' };
    if (!hasCommunityData) return out;

    const key = stat.key || getRivenDataModule().resolveRivenStatKey(stat.name);
    if (!key) return out;

    if (stat.isPositive) {
      if (getRivenDataModule().isSpliceTrait(key)) {
        out.verdict = 'combo';
        return out;
      }
      out.verdict = goodStats.has(key) ? 'good' : 'poor';
      return out;
    }

    if (acceptableNegatives.has(key)) out.verdict = 'harmless';
    else if (weapon.negativeTolerance && !acceptableNegatives.size) out.verdict = 'harmless';
    else out.verdict = 'harmful';
    return out;
  });
}

/* Reroll history.
 *
 * The decision a player is actually making is "is this new roll better than the
 * one I just threw away", and that comparison needs no market data at all: the
 * stat panel is read by OCR and the previous read is already in memory. That
 * matters because dispositions are published for only a few hundred weapons,
 * so a percentage-based grade is unavailable for plenty of real weapons while
 * the before/after comparison is always available.
 *
 * Keyed by weapon so switching weapons in the mods screen does not show a diff
 * against an unrelated riven. */
let rivenLastRoll = null;

function rivenRollKey(weaponName) {
  const normalized = String(weaponName || '').trim().toLowerCase();
  return normalized || 'unknown';
}

function buildRivenRollSummary(parsed, grade) {
  return {
    weaponName: parsed.weaponName || '',
    rivenName: parsed.rivenName || '',
    stats: parsed.stats.map((s) => ({
      name: s.name,
      value: s.value,
      isPositive: !!s.isPositive
    })),
    grade: grade ? grade.grade : '',
    gradeLabel: grade ? grade.gradeLabel : '',
    score: grade && grade.score != null ? grade.score : null,
    perfectness: grade && grade.perfectnessKnown ? grade.perfectness : null,
    at: Date.now()
  };
}

/* ============================================================
   Riven inventory
   ------------------------------------------------------------
   Scanned rivens are kept in one JSON file next to the other caches, so the
   list survives a restart and can be inspected or deleted by hand.

   The record deliberately keeps the raw parse alongside the grade. The grade
   depends on the community sheet and on the weapon's disposition, and both
   move: dispositions change every Prime Access and the sheet gets corrected.
   Re-grading from the stored stats is therefore always possible, and nothing
   here is lost when the verdict changes.
   ============================================================ */
const RIVEN_INVENTORY_FILE = 'riven-inventory.json';
const RIVEN_INVENTORY_VERSION = 1;
const RIVEN_INVENTORY_MAX = 500;

function getRivenInventoryPath() {
  return path.join(app.getPath('userData'), RIVEN_INVENTORY_FILE);
}

let rivenInventoryCache = null;
let rivenInventoryWriteChain = Promise.resolve();

// Warframe.market serves item art from this base. market.js keeps its own copy
// because the renderer cannot reach into the main process; keep the two in step.
const WFM_ASSET_CDN_BASE = 'https://warframe.market/static/assets/';

/* Riven mod art.
 *
 * A riven is a mod, and that is the picture the game and the market show for it.
 * Warframe.market has one mod item per weapon class rather than one per riven, so
 * the art is per class: fetched once, then cached on disk. The path contains a
 * content hash, so it is looked up rather than hard-coded.
 *
 * The seven slugs are the same set the renderer posts orders under, and they were
 * verified against /v2/items. */
const RIVEN_MOD_ITEM_SLUGS = {
  rifle: 'rifle_riven_mod_veiled',
  shotgun: 'shotgun_riven_mod_veiled',
  pistol: 'pistol_riven_mod_veiled',
  melee: 'melee_riven_mod_veiled',
  kitgun: 'kitgun_riven_mod_veiled',
  zaw: 'zaw_riven_mod_veiled',
  archgun: 'companion_weapon_riven_mod_veiled'
};
const RIVEN_MOD_ICON_FILE = 'riven-mod-icons.json';
let rivenModIconCache = null;

function buildRivenIconUrl(icon) {
  const relative = String(icon || '').trim();
  if (!relative) return '';
  if (/^https?:\/\//i.test(relative)) return relative;
  if (/unknown\.(thumb\.)?png$/i.test(relative)) return '';
  return WFM_ASSET_CDN_BASE + relative.replace(/^\/+/, '');
}

function getRivenModIconPath() {
  return path.join(app.getPath('userData'), RIVEN_MOD_ICON_FILE);
}

/**
 * Fill in the mod icon for every weapon class present in the inventory.
 *
 * Best effort by design: a missing icon leaves the weapon art in place, and the
 * next launch tries again. Nothing here is allowed to fail a save.
 */
async function ensureRivenModIcons(classes) {
  const wanted = Array.from(new Set((classes || []).map((c) => String(c || '').trim()).filter(Boolean)));
  if (!wanted.length) return;

  try {
    if (!rivenModIconCache) {
      const stored = await readJsonFile(getRivenModIconPath(), null);
      rivenModIconCache = stored && typeof stored === 'object' ? stored : {};
    }
  } catch (err) {
    rivenModIconCache = {};
  }

  const missing = wanted.filter((cls) => !rivenModIconCache[cls] && RIVEN_MOD_ITEM_SLUGS[cls]);
  if (!missing.length) return;

  let changed = false;
  await Promise.all(missing.map(async (cls) => {
    const slug = RIVEN_MOD_ITEM_SLUGS[cls];
    if (!slug) return;
    // Plain fetch with its own abort: the timeout helper in riven-data.js is not
    // exported, and calling a name that is not in scope here fails silently inside
    // the catch below, which is exactly what happened the first time.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch('https://api.warframe.market/v2/items/' + encodeURIComponent(slug), {
        headers: wfmHeaders(),
        signal: controller.signal
      });
      if (!response.ok) return;
      const payload = await response.json();
      const icon = payload && payload.data && payload.data.i18n && payload.data.i18n.en
        ? payload.data.i18n.en.icon
        : '';
      const url = buildRivenIconUrl(icon);
      if (url) {
        rivenModIconCache[cls] = url;
        changed = true;
      }
    } catch (err) {
      // Offline or rate limited: the entry keeps the weapon art this time.
    } finally {
      clearTimeout(timeout);
    }
  }));

  if (changed) {
    try {
      await writeJsonFile(getRivenModIconPath(), rivenModIconCache);
    } catch (err) {
      // A cache that cannot be written just means fetching it again next time.
    }
  }
}

/**
 * The name the game prints for a stat, resolved from whatever text we have.
 *
 * Rivens scanned before this existed were saved with the OCR spelling
 * ("Status Chanci", "Projectile Spee"), and those files are still on disk. Both
 * fields are repaired on read, from the stat key when there is one and from the
 * saved name when there is not, so old entries stop displaying a mangled name
 * without needing a rescan or a delete.
 */
function canonicalRivenStatName(name, key) {
  const text = String(name || '').trim();
  if (!text) return { name: '', key: '' };
  try {
    const rivenData = getRivenDataModule();
    const resolved = String(key || '').trim() || rivenData.resolveRivenStatKey(text) || '';
    if (resolved) {
      return { name: rivenData.rivenStatName(resolved) || text, key: resolved };
    }
  } catch (err) {
    // The data module is optional at read time; the raw name is still usable.
  }
  return { name: text, key: String(key || '').trim() };
}

function normalizeRivenInventoryEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const stats = Array.isArray(raw.stats) ? raw.stats : [];
  if (!stats.length) return null;

  const grade = raw.grade && typeof raw.grade === 'object' ? raw.grade : {};
  const cleanStats = stats
    .filter((s) => s && typeof s === 'object' && s.name)
    .map((s) => {
      const canonical = canonicalRivenStatName(s.name, s.key);
      return {
        key: canonical.key,
        name: canonical.name,
        value: Number(s.value) || 0,
        isPositive: !!s.isPositive
      };
    });
  if (!cleanStats.length) return null;

  return {
    id: String(raw.id || '').trim() || 'r-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
    weaponName: String(raw.weaponName || raw.parsed?.weaponName || '').trim(),
    rivenName: String(raw.rivenName || raw.parsed?.rivenName || '').trim(),
    stats: cleanStats,
    grade: String(grade.grade || '').trim().toUpperCase(),
    gradeLabel: String(grade.gradeLabel || '').trim(),
    score: Number.isFinite(Number(grade.score)) ? Number(grade.score) : null,
    perfectness: grade.perfectnessKnown && Number.isFinite(Number(grade.perfectness)) ? Number(grade.perfectness) : null,
    perfectnessKnown: !!grade.perfectnessKnown,
    weaponClass: String(grade.weaponClass || '').trim(),
    // rivenType comes from Warframe.market's own riven weapons list and is the
    // field that decides which market item the riven is posted under. The
    // grading engine's weaponClass is a separate inference used for the grade
    // sheet, so the two can disagree; where they do, the market one wins,
    // because posting a riven under the wrong item is not recoverable by the
    // buyer.
    rivenType: String(raw.rivenType || '').trim(),
    // Warframe.market's riven weapons list carries an icon for every weapon it
    // knows (419 of 420 on the list this was written against). The path is
    // relative to their asset CDN, which is the same base market.js builds item
    // art from; it is turned into a full URL here so the renderer does not have to
    // know where it came from.
    icon: String(raw.icon || '').trim(),
    iconUrl: buildRivenIconUrl(raw.icon),
    // The riven mod's own art, which is what the game and the market show for a
    // riven. Falls back to the weapon art in the renderer when this is empty,
    // which is the case until the class icon has been fetched once.
    modIconUrl: (rivenModIconCache && rivenModIconCache[String(raw.rivenType || raw.weaponClass || '').trim()]) || '',
    // Per-stat good/poor/harmless verdict, from the community sheet.
    statVerdicts: Array.isArray(raw.statVerdicts)
      ? raw.statVerdicts
          .filter((v) => v && typeof v === 'object' && v.name)
          .map((v) => ({
            name: String(v.name),
            isPositive: !!v.isPositive,
            verdict: ['good', 'poor', 'harmless', 'harmful', 'combo', 'unknown'].indexOf(String(v.verdict)) !== -1
              ? String(v.verdict)
              : 'unknown'
          }))
      : [],
    disposition: Number.isFinite(Number(raw.disposition)) ? Number(raw.disposition) : null,
    reqMasteryRank: Number.isFinite(Number(raw.reqMasteryRank)) ? Number(raw.reqMasteryRank) : null,
    reasons: Array.isArray(grade.reasons) ? grade.reasons.map(String).slice(0, 5) : [],
    // The riven's own unique in-game id. Warframe.market identifies a riven by
    // the generic riven item plus this value as the order subtype, and it is not
    // derivable from a screenshot of the stat panel, so it has to be entered by
    // hand before the riven can be listed.
    wfmSubtype: String(raw.wfmSubtype || '').trim(),
    listedPrice: Number.isFinite(Number(raw.listedPrice)) ? Number(raw.listedPrice) : null,
    wfmOrderId: String(raw.wfmOrderId || '').trim(),
    /* The community's own notation, "1cc 2cd 3ms -4z", which is what a player would
     * write about this riven and the only form the grade sheet is actually expressed
     * in. Computed by gradeRiven and then thrown away, because everything this
     * function kept was either in the grade object or a top-level field it happened to
     * remember. The rank is the answer; a letter on its own throws it away. */
    notation: String(raw.notation || '').trim(),
    /* Where each stat sits in the community's ranking, so the detail view can say
     * "ranked 1 for this weapon" per stat instead of the verdict list the old grader
     * produced, which no longer exists and read as "no community verdict" against every
     * stat of a correctly graded riven. */
    gradeStats: Array.isArray(raw.gradeStats) ? raw.gradeStats.slice(0, 8).map((r) => ({
      key: String(r.key || ''),
      name: String(r.name || ''),
      rank: Number.isFinite(Number(r.rank)) ? Number(r.rank) : -1
    })).filter((r) => r.name) : [],
    /* The names the parser offered for this riven, best first: the bare weapon, then
     * the weapon with its riven name. "Hek" and "Hek Sati-fevadra" are the same weapon,
     * and which of them the market and the sheet are keyed on decides whether the riven
     * is graded or reported as unrecognised. Carried on the entry because grading now
     * happens when the riven is filed, and a later re-grade has to reach the same answer
     * from the same list or the two paths drift. */
    weaponNameCandidates: Array.isArray(raw.weaponNameCandidates)
      ? raw.weaponNameCandidates.filter((c) => typeof c === 'string' && c.trim()).slice(0, 4)
      : [],
    /* True when the sheet annotates this weapon's ranking as being about sale value
     * rather than in-game strength. Shown in the row so a good grade is not read as
     * meaning the riven is strong in a build. */
    priceOriented: !!raw.priceOriented,
    createdAt: Number.isFinite(Number(raw.createdAt)) ? Number(raw.createdAt) : Date.now()
  };
}

async function readRivenInventory() {
  if (rivenInventoryCache) return rivenInventoryCache;
  const raw = await readJsonFile(getRivenInventoryPath(), null);
  const entries = Array.isArray(raw) ? raw : raw && Array.isArray(raw.entries) ? raw.entries : [];
  // Resolved before normalising, because the mod art is attached during it.
  await ensureRivenModIcons(entries.map((entry) => entry && (entry.rivenType || (entry.grade && entry.grade.weaponClass))));
  rivenInventoryCache = entries.map(normalizeRivenInventoryEntry).filter(Boolean);
  return rivenInventoryCache;
}

// Serialised through a chain so two scans arriving close together cannot
// interleave a read and a write and lose the second entry.
function writeRivenInventory(entries) {
  rivenInventoryWriteChain = rivenInventoryWriteChain.then(async () => {
    const body = { version: RIVEN_INVENTORY_VERSION, entries };
    await writeJsonFile(getRivenInventoryPath(), body);
    rivenInventoryCache = entries;
  }).catch(() => {
    rivenInventoryCache = entries;
  });
  return rivenInventoryWriteChain;
}

/**
 * Grade one entry in place, from the community sheet.
 *
 * Every path that files a riven goes through this. It used to happen only when someone
 * pressed "Re-grade all", which left every riven read from the game sitting in the list
 * with no grade at all, and left a list graded by the previous grader carrying a mixture
 * of two vocabularies: the old great/good/ok/bad alongside the new S/A/B/C. Filing a
 * riven and grading it are one action, not two.
 *
 * Failure is silent on the entry and not on the list: a riven that cannot be graded
 * keeps its stats and shows no grade, which is the honest outcome, and the reason is
 * left in `reasons` for the detail view.
 */
async function applyRivenGrade(entry) {
  if (!entry) return null;
  let data = null;
  try {
    data = await getRivenDataModule().getRivenData();
  } catch (err) {
    return entry;
  }
  const rivenData = getRivenDataModule();

  const tryGrade = (name) => {
    if (!name) return null;
    const found = rivenData.findRivenWeapon(data, name);
    return found && found.matched ? found.weapon : null;
  };

  // The bare weapon name first, then the full candidate that carries the riven name.
  // findRivenWeapon refuses an ambiguous prefix rather than guessing, so a name that
  // matches several weapons falls through to the next candidate rather than being
  // graded against the wrong one.
  const names = [entry.weaponName].concat(Array.isArray(entry.weaponNameCandidates) ? entry.weaponNameCandidates : []);
  let weapon = null;
  for (const name of names) { weapon = tryGrade(name); if (weapon) break; }
  if (!weapon) return entry;

  try {
    const grade = rivenData.gradeRiven(weapon, entry.stats);
    if (!grade) return entry;
    entry.grade = grade.grade;
    entry.gradeLabel = grade.gradeLabel;
    entry.score = grade.score;
    entry.notation = grade.notation || '';
    entry.gradeStats = Array.isArray(grade.gradeStats) ? grade.gradeStats : [];
    entry.priceOriented = !!grade.priceOriented;
    entry.perfectness = grade.perfectnessKnown ? grade.perfectness : null;
    entry.perfectnessKnown = !!grade.perfectnessKnown;
    entry.weaponClass = grade.weaponClass || entry.weaponClass;
    entry.rivenType = weapon.rivenType || entry.rivenType;
    entry.disposition = weapon.disposition != null ? weapon.disposition : entry.disposition;
    entry.reqMasteryRank = weapon.reqMasteryRank != null ? weapon.reqMasteryRank : entry.reqMasteryRank;
    entry.reasons = Array.isArray(grade.reasons) ? grade.reasons.slice(0, 5) : [];
    return entry;
  } catch (err) {
    return entry;
  }
}

function rivenStatsFingerprint(entry) {
  return [entry.weaponName || '']
    .concat(entry.stats.map((s) => (s.isPositive ? '+' : '-') + s.name + ':' + s.value))
    .join('~');
}

async function addRivenToInventory(entry) {
  let normalized = normalizeRivenInventoryEntry(entry);
  if (!normalized) return null;

  // The class icon is attached during normalisation, so it has to be in the cache
  // first. A riven saved before this existed picks it up here.
  await ensureRivenModIcons([normalized.rivenType || normalized.weaponClass]);
  normalized = normalizeRivenInventoryEntry(entry) || normalized;
  await applyRivenGrade(normalized);

  const entries = await readRivenInventory();
  const fingerprint = rivenStatsFingerprint(normalized);

  // Rerolling a stat panel produces a new read every time. Without this the
  // inventory fills with copies of the same riven the moment the player is
  // sitting on the reroll screen.
  const existingIndex = entries.findIndex((e) => rivenStatsFingerprint(e) === fingerprint);
  if (existingIndex !== -1) {
    const merged = Object.assign({}, entries[existingIndex], {
      // A re-read can improve the grade: the disposition sheet or the community
      // data may have been updated since it was first saved.
      grade: normalized.grade || entries[existingIndex].grade,
      gradeLabel: normalized.gradeLabel || entries[existingIndex].gradeLabel,
      score: normalized.score != null ? normalized.score : entries[existingIndex].score,
      perfectness: normalized.perfectness != null ? normalized.perfectness : entries[existingIndex].perfectness,
      reasons: normalized.reasons.length ? normalized.reasons : entries[existingIndex].reasons,
      lastSeenAt: Date.now()
    });
    entries[existingIndex] = merged;
    await writeRivenInventory(entries);
    return { entry: merged, created: false };
  }

  normalized.lastSeenAt = Date.now();
  entries.unshift(normalized);
  // Newest first is the useful order, so trimming from the tail drops the
  // oldest rather than whatever was scanned most recently.
  const trimmed = entries.slice(0, RIVEN_INVENTORY_MAX);
  await writeRivenInventory(trimmed);
  return { entry: normalized, created: true };
}

async function updateRivenInventoryEntry(id, patch) {
  const entries = await readRivenInventory();
  const index = entries.findIndex((e) => e.id === id);
  if (index === -1) return null;
  const merged = normalizeRivenInventoryEntry(Object.assign({}, entries[index], patch, { id: entries[index].id }));
  if (!merged) return null;
  entries[index] = merged;
  await writeRivenInventory(entries);
  return merged;
}

async function removeRivenInventoryEntry(id) {
  const entries = await readRivenInventory();
  const next = entries.filter((e) => e.id !== id);
  if (next.length === entries.length) return false;
  await writeRivenInventory(next);
  return true;
}

let rivenOverlayEnabled = false;

let rivenOverlayLogTimer = null;
let rivenOverlayLogPath = '';
let rivenOverlayLogOffset = 0;
let rivenOverlayLogMissingNotified = false;
let rivenOverlayScanning = false;
let rivenOverlayCachedDisplayId = null;
let rivenOverlayManualDisplayId = null;
let rivenOverlayDebugDir = null;
let rivenOverlayHideTimer = null;
// Selection-following state. `selectedSide` is which card is lit, and the
// signature is that plus a hash of its pixels, so an unchanged screen costs
// nothing and a flip is picked up on the next cycle.
let rivenOverlayWatchTimer = null;
let rivenOverlayWatchUntil = 0;
let rivenOverlayWatchBusy = false;
let rivenOverlaySelectedSide = '';
let rivenOverlayWatchSignature = '';
const PROFILE_FETCH_TIMEOUT_MS = 15000;
const PROFILE_REMOTE_FETCH_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const PROFILE_REMOTE_RETRY_COOLDOWN_MS = 15 * 60 * 1000;
const PROFILE_LOG_CONFIG_FILE = 'warframe-profile-log.json';
const PROFILE_CACHE_FILE = 'warframe-profile-cache.json';
const PROFILE_INTRINSIC_RANK_XP = 1500;
const PROFILE_NORMAL_STAR_CHART_XP_MAX = 27519;
const PROFILE_STEEL_PATH_XP_MAX = 27519;
const RELIC_OVERLAY_IDLE_SCAN_INTERVAL_MS = 4500;
const RELIC_OVERLAY_ACTIVE_SCAN_INTERVAL_MS = 450;
const RELIC_OVERLAY_DUPLICATE_SCAN_MS = 1800;
const RELIC_OVERLAY_MAX_CAPTURE_WIDTH = 1280;
const RELIC_OVERLAY_MAX_CAPTURE_HEIGHT = 720;
const RELIC_OVERLAY_HOLD_MS = 1800;
const RELIC_OVERLAY_TRIGGER_WINDOW_MS = 8000;
const RELIC_OVERLAY_LOG_POLL_INTERVAL_MS = 750;
const RELIC_OVERLAY_LOG_TAIL_BYTES = 64 * 1024;
const WARFRAME_PROCESS_NAMES = ['Warframe.x64.exe', 'Warframe.exe'];
const EXPORT_REGIONS_URL = 'https://raw.githubusercontent.com/calamity-inc/warframe-public-export-plus/senpai/ExportRegions.json';
const JUNCTION_MASTERY_XP = 1000;
let regionMasteryCache = null;
let regionMasteryCacheFetchedAt = 0;
const REGION_MASTERY_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const RIVEN_OVERLAY_GRADE_THRESHOLDS = { S: 80, A: 60, B: 40, C: 20 };
// How long the roll card stays up over the game. Long enough to read a stat,
// short enough that it is not sitting there when the next screen appears.
const RIVEN_OVERLAY_HIDE_DELAY_MS = 9000;

/* Following the selection.
 *
 * The reroll screen stays open while the player decides, and they flip between
 * the old riven and the new one with a keybind. The card is worth updating while
 * that happens, the way a companion overlay does, so the screen is watched for a
 * couple of minutes and whichever card is lit is the one shown. The cards are the
 * same size and the same height apart, so "which one is selected" is just "which
 * one is brighter" — measured from the pixels we already cropped, with no second
 * read and no extra OCR. */
const RIVEN_OVERLAY_WATCH_WINDOW_MS = 150000;
const RIVEN_OVERLAY_WATCH_INTERVAL_MS = 850;
// 300ms, not 750ms: the cards are on screen for as long as the player takes to
// answer the choice prompt, and a real one took 1.5s. Half of that was being spent
// waiting to notice. Only the new bytes of the log are read each time, so polling
// this often costs a file read and nothing else.
const RIVEN_OVERLAY_LOG_POLL_INTERVAL_MS = 300;
/* How much of the log to read on the first poll after the app starts.
 *
 * It has to be big enough to contain a reroll that happened before the app was
 * launched, which is the whole point: a player who rolled a riven, quit Warframe, opened
 * Ordis and turned riven grading on expects that roll to be graded. Measured on a real
 * log, the reroll prompt sat about 300 KB back from the end, so 64 KB missed it every
 * time. 512 KB covers it with room to spare and still bounds the read to half a
 * megabyte rather than the whole file. */
const RIVEN_OVERLAY_LOG_TAIL_BYTES = 512 * 1024;
const RIVEN_OVERLAY_SCAN_DELAY_MS = 500;
// The cards are only on screen while the choice prompt is up, and a real reroll
// showed the player answering it 1.5s after it appeared. The first attempt waits a
// fifth of that, and the burst is given room for four reads so a frame caught
// mid-animation does not end the attempt.
const RIVEN_OVERLAY_FIRST_SCAN_DELAY_MS = 200;
const RIVEN_OVERLAY_MAX_SCAN_ATTEMPTS = 4;
const RIVEN_OVERLAY_SCAN_BURST_WINDOW_MS = 6000;
const RIVEN_OVERLAY_DUPLICATE_SCAN_MS = 1500;
const RIVEN_OVERLAY_MIN_KEYWORD_HITS = 2;
// Measured on a real 1920x1080 reroll frame, by locating the two cards in the
// screenshot rather than guessing at them.
//
// The screen shows the riven you already have and the roll side by side, and both
// cards' text sits at the same height, so reading one region as a single stream
// merged them: the weapon name came out as "Ocucor Visilis Ocucor Sci-zetides" and
// the stat set was whichever lines happened to survive. Each card is cropped and
// read on its own instead.
//
// Left card  x 0.275..0.410, right card x 0.410..0.578, both y 0.420..0.775. The gap
// between the cards is empty from 0.390 to 0.430, so the split at 0.410 sits in the
// middle of a 0.04-wide margin rather than on an edge. The old single crop
// (x 0.408..0.605) happened to clear the left card on this frame, which is why the
// merge was only ever visible in the diagnostic capture, but it left the two cards
// one bad pixel apart.
const RIVEN_OVERLAY_CARDS = {
  previous: { x: 0.275, y: 0.42, width: 0.135, height: 0.355 },
  current: { x: 0.41, y: 0.42, width: 0.168, height: 0.355 }
};
// Each card is only ~260-320px wide on a 1080p frame, so it is worth roughly 3.4x
// before OCR: the name and the three stat lines are 10-14px tall as drawn.
const RIVEN_OVERLAY_CARD_UPSCALE = 3.4;
const RIVEN_OVERLAY_CARD_MIN_WIDTH = 900;
const RIVEN_OVERLAY_CARD_MAX_WIDTH = 1400;

/* Only the bottom half of a card carries text: the name, the three stat lines and
 * the mastery readout. The picture above them is most of the pixels and none of
 * the data, and it is what drags page segmentation into inventing words.
 *
 * Measured on a real frame: reading the band instead of the whole card returned the
 * same three stats on both cards, in roughly half the time (649ms against 1516ms
 * on the left card). Fractions are of the card, not the screen: the name sits at
 * 0.55-0.63 of the card's height and the last stat line ends at 0.87, so 0.50 to
 * 0.93 is the band with a little air either side. */
const RIVEN_OVERLAY_CARD_TEXT_BAND = { y: 0.5, height: 0.43 };

// Words too common in the Warframe UI to be evidence of a riven stat panel: they
// appear on unrelated screens and would make the gate pass on anything.
const RIVEN_OVERLAY_GENERIC_WORDS = new Set([
  'damage', 'critical', 'chance', 'crit', 'rate', 'speed', 'max', 'capacity',
  'effect', 'time', 'attack', 'weapon', 'stats', 'total', 'bonus', 'value',
  'the', 'and', 'for', 'vs', 'with'
]);
let rivenOverlayKeywords = null;

/**
 * Build the OCR keyword list from riven-data's own stat names, aliases and splice
 * traits instead of maintaining it by hand. The hand-kept list had silently drifted
 * and was missing Channeling, the three Damage-to-Faction stats and the slide-attack
 * stat, so a valid riven could be rejected outright. Deriving it means a new
 * attribute is covered the moment the data knows about it.
 */
function getRivenOverlayKeywords() {
  if (rivenOverlayKeywords) return rivenOverlayKeywords;

  const words = new Set();
  const add = (phrase) => {
    if (typeof phrase !== 'string') return;
    for (const token of phrase.toLowerCase().split(/[^a-z0-9]+/)) {
      if (token.length >= 4 && !RIVEN_OVERLAY_GENERIC_WORDS.has(token)) words.add(token);
    }
  };

  try {
    const data = getRivenDataModule();
    for (const entry of Object.values(data.RIVEN_STATS || {})) {
      add(entry && entry.display);
      for (const alias of (entry && entry.aliases) || []) add(alias);
    }
    for (const name of Object.keys(data.RIVEN_SPLICE_TRAITS || {})) add(name);
  } catch (err) {
    // The gate must keep working even if the data module cannot be loaded.
    for (const word of ['multishot', 'electricity', 'puncture', 'slash', 'impact',
                        'toxin', 'cold', 'heat', 'reload', 'magazine', 'recoil',
                        'ammo', 'channeling', 'slide', 'grineer', 'corpus',
                        'infested', 'finisher', 'launcher', 'melee']) {
      add(word);
    }
  }

  rivenOverlayKeywords = Array.from(words).sort();
  return rivenOverlayKeywords;
}
let rivenOverlayScanTimer = null;
let rivenOverlayBurstUntil = 0;
let rivenOverlayScanAttempts = 0;
let rivenOverlayLastHash = '';
let rivenOverlayLastHashAt = 0;
let rivenOverlayLastScanAt = 0;

function sendUpdaterEvent(type, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send('app-update-event', Object.assign({ type: type }, payload || {}));
}

function sendOcrProgress(payload) {
  if (!activeOcrProgressTarget || activeOcrProgressTarget.isDestroyed()) {
    return;
  }
  activeOcrProgressTarget.send('ocr-scan-progress', payload || {});
}

function sendRelicOverlayEvent(type, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('relic-overlay-event', Object.assign({ type }, payload || {}));
}

function sanitizeForInlineScript(payload) {
  return JSON.stringify(payload || {}).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function getDisplayForRelicOverlay(bounds) {
  if (bounds && Number.isFinite(Number(bounds.x)) && Number.isFinite(Number(bounds.y))) {
    return screen.getDisplayNearestPoint({
      x: Math.round(Number(bounds.x)),
      y: Math.round(Number(bounds.y))
    });
  }

  try {
    return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  } catch (err) {
    return screen.getPrimaryDisplay();
  }
}

function getDisplayCaptureSize(display) {
  const bounds = display && display.bounds ? display.bounds : { width: 1280, height: 720 };
  const scaleFactor = Number(display && display.scaleFactor) || 1;
  const rawWidth = Math.max(1, Math.round(bounds.width * scaleFactor));
  const rawHeight = Math.max(1, Math.round(bounds.height * scaleFactor));
  const downscale = Math.min(
    1,
    RELIC_OVERLAY_MAX_CAPTURE_WIDTH / rawWidth,
    RELIC_OVERLAY_MAX_CAPTURE_HEIGHT / rawHeight
  );
  return {
    width: Math.max(1, Math.round(rawWidth * downscale)),
    height: Math.max(1, Math.round(rawHeight * downscale))
  };
}

async function ensureRelicOverlayWindow(display) {
  const targetDisplay = display || screen.getPrimaryDisplay();
  const bounds = targetDisplay.bounds || { x: 0, y: 0, width: 1280, height: 720 };

  if (relicOverlayWindow && !relicOverlayWindow.isDestroyed()) {
    relicOverlayWindow.setBounds(bounds);
    return relicOverlayWindow;
  }

  relicOverlayWindow = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    focusable: false,
    hasShadow: false,
    alwaysOnTop: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });

  relicOverlayWindow.setIgnoreMouseEvents(true);
  relicOverlayWindow.setAlwaysOnTop(true, 'screen-saver');
  relicOverlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  try {
    relicOverlayWindow.setContentProtection(true);
  } catch (err) {
    // Best effort: prevents the overlay labels from being read by our own screen OCR on supported systems.
  }
  relicOverlayWindow.on('closed', () => {
    relicOverlayWindow = null;
  });

  await relicOverlayWindow.loadFile(path.join(__dirname, 'relic-overlay.html'));
  return relicOverlayWindow;
}

async function updateRelicOverlayWindow(payload) {
  const safePayload = payload || {};
  const display = getDisplayForRelicOverlay(safePayload.displayBounds);
  const overlay = await ensureRelicOverlayWindow(display);
  if (!overlay || overlay.isDestroyed()) return { ok: false };

  const labels = Array.isArray(safePayload.labels) ? safePayload.labels : [];
  const shouldShow = safePayload.detected === true && labels.length > 0 && relicOverlayEnabled;
  const script = 'window.renderRelicOverlay && window.renderRelicOverlay(' + sanitizeForInlineScript(safePayload) + ');';
  await overlay.webContents.executeJavaScript(script, true);

  if (shouldShow) {
    overlay.setBounds((display && display.bounds) || overlay.getBounds());
    overlay.showInactive();
  } else {
    overlay.hide();
  }

  return { ok: true, visible: shouldShow };
}

async function clearRelicOverlayWindow(message) {
  if (!relicOverlayWindow || relicOverlayWindow.isDestroyed()) return;
  try {
    await updateRelicOverlayWindow({
      detected: false,
      labels: [],
      message: message || ''
    });
  } catch (err) {
    relicOverlayWindow.hide();
  }
}

/* Riven overlay.
 *
 * The reroll screen is a full-screen game view, so a grade shown inside the app is
 * a grade nobody is looking at. This is the same arrangement as the relic overlay:
 * a click-through, always-on-top transparent window over the whole display, fed
 * the scan result and hidden again on a timer.
 *
 * The card sits centre-bottom rather than over the two riven cards themselves,
 * which occupy the middle of the screen: the player is comparing those, and
 * covering them would defeat the purpose. */
async function ensureRivenOverlayWindow(display) {
  const targetDisplay = display || screen.getPrimaryDisplay();
  const bounds = targetDisplay.bounds || { x: 0, y: 0, width: 1280, height: 720 };

  if (rivenOverlayWindow && !rivenOverlayWindow.isDestroyed()) {
    rivenOverlayWindow.setBounds(bounds);
    return rivenOverlayWindow;
  }

  rivenOverlayWindow = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    focusable: false,
    hasShadow: false,
    alwaysOnTop: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });

  rivenOverlayWindow.setIgnoreMouseEvents(true);
  rivenOverlayWindow.setAlwaysOnTop(true, 'screen-saver');
  rivenOverlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  try {
    // Without this the overlay is part of the next capture, and the app reads its
    // own grade card as riven stats.
    rivenOverlayWindow.setContentProtection(true);
  } catch (err) {
    // Best effort.
  }
  rivenOverlayWindow.on('closed', () => {
    rivenOverlayWindow = null;
  });

  await rivenOverlayWindow.loadFile(path.join(__dirname, 'riven-overlay.html'));
  return rivenOverlayWindow;
}

/**
 * Reduce a scan result to what the overlay draws. Kept separate from the drawing
 * so nothing untrusted (raw OCR text, a stat name off the screen) is ever turned
 * into markup by string concatenation.
 */
function buildRivenOverlayModel(payload) {
  const source = payload || {};
  const grade = source.grade || null;
  const parsed = source.parsed || {};

  const stats = Array.isArray(parsed.stats) ? parsed.stats.slice(0, 6).map((stat) => ({
    name: String(stat.name == null ? '' : stat.name).slice(0, 40),
    value: Number(stat.value),
    isPositive: !!stat.isPositive
  })) : [];

  const previous = source.previousRoll || null;
  const previousStats = previous && Array.isArray(previous.stats)
    ? previous.stats.slice(0, 6).map((stat) => ({
        name: String(stat.name == null ? '' : stat.name).slice(0, 40),
        value: Number(stat.value),
        isPositive: !!stat.isPositive
      }))
    : [];

  return {
    success: source.success === true,
    pending: source.pending === true,
    // Which card this read came from, so the overlay can say whether it is showing
    // the new roll or the riven being replaced. Following the selection is the
    // whole point of the watch loop.
    side: source.side === 'previous' ? 'previous' : 'current',
    error: String(source.error == null ? '' : source.error).slice(0, 240),
    weaponName: String(parsed.weaponName == null ? '' : parsed.weaponName).slice(0, 60),
    rivenName: parsed.rivenName ? String(parsed.rivenName).slice(0, 60) : '',
    grade: grade ? String(grade.grade == null ? '' : grade.grade).slice(0, 4) : '',
    gradeLabel: grade ? String(grade.gradeLabel == null ? '' : grade.gradeLabel).slice(0, 40) : '',
    score: grade && grade.score != null ? Number(grade.score) : null,
    perfectness: grade && grade.perfectnessKnown && Number.isFinite(Number(grade.perfectness))
      ? Number(grade.perfectness)
      : null,
    reasons: Array.isArray(grade && grade.reasons) ? grade.reasons.slice(0, 3).map(String) : [],
    // Per-stat tiers and verdicts, so the overlay can mark a good stat with a
    // symbol that means something instead of only showing a sign.
    verdicts: Array.isArray(source.statTiers)
      ? source.statTiers.slice(0, 8).map((t) => ({
          name: String(t.name == null ? '' : t.name).slice(0, 40),
          verdict: String(t.verdict == null ? 'unknown' : t.verdict).slice(0, 12),
          tier: String(t.tier == null ? '?' : t.tier).slice(0, 2),
          ratio: t.ratio == null ? null : Number(t.ratio)
        }))
      : [],
    stats: stats,
    hasPrevious: !!previous,
    previousPerfectness: previous && previous.perfectness != null ? Number(previous.perfectness) : null,
    previousVerdicts: Array.isArray(source.previousStatVerdicts)
      ? source.previousStatVerdicts
          .filter((v) => v && v.name)
          .slice(0, 8)
          .map((v) => ({ name: String(v.name).slice(0, 40), verdict: String(v.verdict || 'unknown').slice(0, 12) }))
      : [],
    previousStats: previousStats
  };
}

async function showRivenOverlay(result, display) {
  if (!rivenOverlayEnabled) return { ok: false, reason: 'disabled' };
  const model = buildRivenOverlayModel(result);
  // A failed read is worth showing too: silence over the game is
  // indistinguishable from the feature not working.
  if (!model.pending && !model.success && !model.error) return { ok: false, reason: 'nothing-to-show' };
  // The watch is following a selection; the roll it replaces is the other card.
  if (model.success && !result.previousRoll && model.side === 'current' && rivenOverlaySelectedSide === 'current') {
    model.hasPrevious = false;
  }

  try {
    const overlay = await ensureRivenOverlayWindow(display || getDisplayForRelicOverlay());
    if (!overlay || overlay.isDestroyed()) return { ok: false, reason: 'no-window' };

    await overlay.webContents.executeJavaScript(
      'window.renderRivenOverlay && window.renderRivenOverlay(' + sanitizeForInlineScript(model) + ');',
      true
    );
    overlay.showInactive();

    if (rivenOverlayHideTimer) clearTimeout(rivenOverlayHideTimer);
    rivenOverlayHideTimer = setTimeout(() => {
      rivenOverlayHideTimer = null;
      if (rivenOverlayWindow && !rivenOverlayWindow.isDestroyed()) rivenOverlayWindow.hide();
    }, RIVEN_OVERLAY_HIDE_DELAY_MS);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err && err.message ? err.message : 'overlay failed' };
  }
}

async function hideRivenOverlay() {
  if (rivenOverlayHideTimer) {
    clearTimeout(rivenOverlayHideTimer);
    rivenOverlayHideTimer = null;
  }
  if (rivenOverlayWindow && !rivenOverlayWindow.isDestroyed()) rivenOverlayWindow.hide();
}

/**
 * Mean brightness of a fraction of a cropped region, 0..1.
 *
 * Only called on the two fixed strips below. This used to measure the whole card,
 * which was wrong: the riven mod's picture rotates, so the art's own brightness
 * changes second to second and the overlay could decide the selection had flipped
 * when nothing had. Measured on a real pair of cards, the picture separates the two
 * cards by 1.4x while the strip along the bottom edge separates them by 10.7x, so
 * the art is not part of the test at all.
 */
function measureRegionLuminance(image, x0, y0, x1, y1) {
  if (!image || !image.toBitmap || !image.getSize) return 0;
  let bitmap;
  let size;
  try {
    bitmap = image.toBitmap();
    size = image.getSize();
  } catch (err) {
    return 0;
  }
  if (!bitmap || !bitmap.length) return 0;

  const width = Math.max(1, Number(size && size.width) || Math.round(bitmap.length / 4));
  const height = Math.max(1, Number(size && size.height) || 1);
  const from = Math.max(0, Math.round(width * (x0 == null ? 0 : x0)));
  const to = Math.min(width, Math.round(width * (x1 == null ? 1 : x1)));
  const top = Math.max(0, Math.round(height * (y0 == null ? 0 : y0)));
  const bottom = Math.min(height, Math.round(height * (y1 == null ? 1 : y1)));
  if (to <= from || bottom <= top) return 0;

  let sum = 0;
  let count = 0;
  for (let y = top; y < bottom; y += 2) {
    for (let x = from; x < to; x += 2) {
      const index = (y * width + x) * 4;
      if (index + 2 >= bitmap.length) continue;
      sum += 0.299 * bitmap[index + 2] + 0.587 * bitmap[index + 1] + 0.114 * bitmap[index];
      count++;
    }
  }
  return count ? sum / count / 255 : 0;
}

/* The two fixed strips used to tell the cards apart, and their weights.
 *
 * The bottom strip is the rank and mastery readout, which lights up on the card
 * that is selected; the top strip is the frame above the picture. Neither contains
 * the rotating art, so neither moves on its own. The bottom strip is weighted
 * heavily because it is by far the stronger signal. */
const RIVEN_CARD_SELECTION_STRIPS = [
  { x0: 0, y0: 0.92, x1: 1, y1: 1, weight: 3 },
  { x0: 0, y0: 0, x1: 1, y1: 0.06, weight: 1 }
];

/**
 * Which card is selected: 'previous', 'current', or '' when it cannot be told.
 *
 * Hysteresis matters as much as the measurement. A selection only changes when the
 * player flips, so the challenger has to beat the card already shown by a clear
 * margin; otherwise a frame that happens to be a shade brighter swaps the answer
 * and the score appears to change by itself.
 */
function pickSelectedRivenCard(regions, currentSide) {
  const score = (region) => RIVEN_CARD_SELECTION_STRIPS.reduce((total, strip) => {
    return total + strip.weight * measureRegionLuminance(region.image, strip.x0, strip.y0, strip.x1, strip.y1);
  }, 0);

  const previous = score(regions.previous);
  const current = score(regions.current);
  if (!previous && !current) return '';

  const winner = current >= previous ? 'current' : 'previous';
  const loser = winner === 'current' ? previous : current;
  const leader = winner === 'current' ? current : previous;

  if (currentSide && currentSide !== winner) {
    // Stay on what is already shown unless the other card is clearly brighter.
    if (!(leader > loser * 1.15)) return currentSide;
  }
  return winner;
}

/**
 * One pass of "keep the overlay in step with the selection".
 *
 * Reads only the lit card, so flipping between the two rivens updates what the
 * overlay says without a second read of the other one. Nothing is filed: this is
 * the live view, and the roll is saved by the burst that runs on the reroll
 * itself, not by every flip the player makes while deciding.
 */
async function runRivenWatchCycle() {
  if (!rivenOverlayEnabled || rivenOverlayWatchBusy) return;
  if (Date.now() >= rivenOverlayWatchUntil) {
    stopRivenOverlayWatch();
    return;
  }
  rivenOverlayWatchBusy = true;

  try {
    let capture = null;
    const candidates = getRivenCandidateDisplayIds();
    for (const displayId of candidates) {
      try {
        capture = await captureDisplayById(displayId);
      } catch (err) {
        capture = null;
      }
      if (capture) {
        rivenOverlayCachedDisplayId = capture.display && capture.display.id != null
          ? capture.display.id
          : rivenOverlayCachedDisplayId;
        break;
      }
    }
    if (!capture) return;

    const regions = {
      previous: createRivenOcrRegion(capture.image, RIVEN_OVERLAY_CARDS.previous),
      current: createRivenOcrRegion(capture.image, RIVEN_OVERLAY_CARDS.current)
    };
    const side = pickSelectedRivenCard(regions, rivenOverlaySelectedSide);
    if (!side) return;
    const region = regions[side];
    /* Hash the static text band, not the card. The card's picture rotates while the
     * card sits there, so hashing the whole card produced a different signature on
     * every frame and the watch loop re-read a riven that had not changed. */
    const signature = side + ':' + crypto.createHash('sha1')
      .update(createRivenTextRegion(region).image.toBitmap()).digest('hex');
    if (signature === rivenOverlayWatchSignature) return;
    rivenOverlayWatchSignature = signature;
    rivenOverlaySelectedSide = side;

    const read = await recognizeRivenRegion(capture, side);
    const card = read.cards[side];
    if (!card) return;
    // An unverified read has empty text on purpose. Holding off here is the whole
    // point: a frame the engines could not agree on must not become a grade.
    if (!card.agreed || !String(card.text || '').trim()) return;

    const success = {
      ok: true,
      text: card.text,
      lines: card.lines,
      ocrEngine: card.engine || '',
      ocrEngines: card.engines || [],
      ocrCorroborating: card.corroborating || 0,
      ocrVerified: !!card.verified,
      previousText: side === 'current' ? read.cards.previous && read.cards.previous.text : '',
      previousLines: side === 'current' ? read.cards.previous && read.cards.previous.lines : [],
      previousOcrEngine: side === 'current' && read.cards.previous ? (read.cards.previous.engine || '') : '',
      imageSize: capture.imageSize,
      displayBounds: capture.display && capture.display.bounds ? capture.display.bounds : null,
      displayId: capture.display && capture.display.id != null ? capture.display.id : '',
      capturedAt: read.now
    };

    const graded = await gradeRivenScan(success, { file: false, watch: true });
    if (graded && graded.success) {
      graded.side = side;
      await showRivenOverlay(graded, capture.display);
    }
  } catch (err) {
    // A cycle that fails is simply skipped; the next one is 850ms away.
  } finally {
    rivenOverlayWatchBusy = false;
  }
}

function startRivenOverlayWatch() {
  stopRivenOverlayWatch();
  rivenOverlayWatchUntil = Date.now() + RIVEN_OVERLAY_WATCH_WINDOW_MS;
  rivenOverlayWatchSignature = '';
  rivenOverlaySelectedSide = '';

  const tick = async () => {
    if (!rivenOverlayEnabled || Date.now() >= rivenOverlayWatchUntil) {
      stopRivenOverlayWatch();
      return;
    }
    await runRivenWatchCycle();
    rivenOverlayWatchTimer = setTimeout(tick, RIVEN_OVERLAY_WATCH_INTERVAL_MS);
  };

  rivenOverlayWatchTimer = setTimeout(tick, 250);
}

function stopRivenOverlayWatch() {
  if (rivenOverlayWatchTimer) {
    clearTimeout(rivenOverlayWatchTimer);
    rivenOverlayWatchTimer = null;
  }
  rivenOverlayWatchUntil = 0;
  rivenOverlayWatchBusy = false;
  rivenOverlayWatchSignature = '';
  rivenOverlaySelectedSide = '';
}

function getRelicOverlayTextSignature(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .slice(0, 600);
}

function isLikelyRelicRewardScreen(text, lines) {
  const normalized = getRelicOverlayTextSignature(text);
  if (/\bvoid\b.*\bfissure\b.*\brewards?\b/.test(normalized)) return true;
  if (/\bfissure\b.*\brewards?\b/.test(normalized)) return true;
  const rewardMatches = String(text || '').match(/(?:\bforma\s+blueprint\b|\bprime\b\s+(?:blueprint|chassis|neuroptics|systems|blade|barrel|receiver|stock|string|handle|hilt|grip|link|pouch|guard|gauntlet|cerebrum|carapace|wings|harness|fuselage|stars|disc|ornament|chain|head|boot|upper limb|lower limb)\b)/ig);
  if (rewardMatches && rewardMatches.length >= 2) return true;
  if (rewardMatches && rewardMatches.length >= 1 && Date.now() < relicOverlayBurstUntil) return true;
  const sourceLines = Array.isArray(lines) ? lines : [];
  let rewardLineCount = 0;
  for (const line of sourceLines) {
    const value = String(line && line.text ? line.text : '');
    if (/\bforma\s+blueprint\b/i.test(value) || (/\bprime\b/i.test(value) && /\b(blueprint|chassis|neuroptics|systems|blade|barrel|receiver|stock|string|handle|hilt|grip|link|pouch|guard|gauntlet|cerebrum|carapace|wings|harness|fuselage|stars)\b/i.test(value))) {
      rewardLineCount += 1;
    }
  }
  return rewardLineCount >= 2 && /\b(relic|opened|owned|reward|fissure|prime|forma)\b/.test(normalized);
}

async function captureRelicOverlayScreen() {
  const display = getDisplayForRelicOverlay();
  const captureSize = getDisplayCaptureSize(display);
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: captureSize
  });
  const displayId = String(display && display.id ? display.id : '');
  let source = sources.find((entry) => String(entry.display_id || '') === displayId);
  if (!source) {
    source = sources.find((entry) => String(entry.id || '').indexOf(displayId) !== -1) || sources[0];
  }
  if (!source || !source.thumbnail || source.thumbnail.isEmpty()) {
    throw new Error('Screen capture is unavailable. Check OS screen recording permission or use borderless/windowed mode.');
  }

  return {
    display,
    image: source.thumbnail,
    imageSize: source.thumbnail.getSize()
  };
}

function createRelicOverlayOcrRegion(image) {
  const size = image && image.getSize ? image.getSize() : { width: 0, height: 0 };
  const width = Math.max(1, Number(size.width) || 1);
  const height = Math.max(1, Number(size.height) || 1);
  const crop = {
    x: Math.max(0, Math.round(width * 0.235)),
    y: Math.max(0, Math.round(height * 0.315)),
    width: Math.max(1, Math.round(width * 0.53)),
    height: Math.max(1, Math.round(height * 0.18))
  };

  if (crop.x + crop.width > width) crop.width = width - crop.x;
  if (crop.y + crop.height > height) crop.height = height - crop.y;

  const targetWidth = Math.min(1150, Math.max(900, crop.width * 1.7));
  const scale = targetWidth / crop.width;
  const targetHeight = Math.max(1, Math.round(crop.height * scale));
  const prepared = image
    .crop(crop)
    .resize({
      width: Math.round(targetWidth),
      height: targetHeight,
      quality: 'best'
    });

  return {
    image: prepared,
    offsetX: crop.x,
    offsetY: crop.y,
    scale
  };
}

function isRelicOverlayRewardLogText(text) {
  return /(?:Got rewards|Pause countdown done|Relic rewards initialized|ProjectionRewardChoice)/i.test(String(text || ''));
}

function isRelicOverlayRewardEndLogText(text) {
  /* Not "Relic timer closed". On a real run that is written 0.36s after the
   * rewards are initialised, while the reward screen itself stays up for another
   * 15s, so treating it as the end took the overlay away a second after it
   * appeared. The screen shutting down is the actual end. */
  return /(?:Relic reward screen shut down|MatchingService::EndSession)/i.test(String(text || ''));
}

function getRelicOverlayScanDelay() {
  return Date.now() < relicOverlayBurstUntil
    ? RELIC_OVERLAY_ACTIVE_SCAN_INTERVAL_MS
    : RELIC_OVERLAY_IDLE_SCAN_INTERVAL_MS;
}

function scheduleRelicOverlayScan(delayMs) {
  if (!relicOverlayEnabled) return;
  if (relicOverlayTimer) {
    clearTimeout(relicOverlayTimer);
    relicOverlayTimer = null;
  }

  relicOverlayTimer = setTimeout(async () => {
    relicOverlayTimer = null;
    try {
      await scanRelicOverlayOnce();
    } catch (err) {
      sendRelicOverlayEvent('error', {
        ok: false,
        message: err && err.message ? err.message : 'Relic overlay scan failed.'
      });
    }

    if (relicOverlayEnabled) {
      scheduleRelicOverlayScan(getRelicOverlayScanDelay());
    }
  }, Math.max(0, Number(delayMs) || 0));
}

function triggerRelicOverlayBurst(reason) {
  if (!relicOverlayEnabled) return;
  relicOverlayBurstUntil = Math.max(relicOverlayBurstUntil, Date.now() + RELIC_OVERLAY_TRIGGER_WINDOW_MS);
  relicOverlayLastHash = '';
  relicOverlayLastHashAt = 0;
  sendRelicOverlayEvent('status', {
    enabled: true,
    message: reason || 'Reward screen detected in EE.log. Reading platinum values...'
  });
  scheduleRelicOverlayScan(80);
}

async function readLogChunk(filePath, start, end, maxBytes) {
  const length = Math.max(0, Math.min(maxBytes, end - start));
  if (!filePath || length <= 0) return '';

  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const read = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, read.bytesRead || 0).toString('utf8');
  } finally {
    await handle.close();
  }
}

function readRelicOverlayLogChunk(filePath, start, end) {
  return readLogChunk(filePath, start, end, RELIC_OVERLAY_LOG_TAIL_BYTES);
}

async function pollRelicOverlayLog() {
  if (!relicOverlayEnabled) return;

  try {
    const logInfo = await findWarframeLog();
    if (!logInfo || !logInfo.path) {
      if (!relicOverlayLogMissingNotified) {
        relicOverlayLogMissingNotified = true;
        sendRelicOverlayEvent('status', {
          enabled: true,
          message: 'EE.log not found. Overlay is using slower screen fallback scanning.'
        });
      }
      return;
    }

    const currentPath = path.normalize(logInfo.path);
    if (currentPath !== relicOverlayLogPath) {
      relicOverlayLogPath = currentPath;
      relicOverlayLogOffset = logInfo.size;
      relicOverlayLogMissingNotified = false;
      sendRelicOverlayEvent('status', {
        enabled: true,
        message: 'Watching EE.log for Void Fissure rewards...'
      });
      return;
    }

    if (logInfo.size < relicOverlayLogOffset) {
      relicOverlayLogOffset = 0;
    }

    if (logInfo.size <= relicOverlayLogOffset) return;

    const start = Math.max(relicOverlayLogOffset, logInfo.size - RELIC_OVERLAY_LOG_TAIL_BYTES);
    const chunk = await readRelicOverlayLogChunk(currentPath, start, logInfo.size);
    relicOverlayLogOffset = logInfo.size;

    /* End is tested first, and the end pattern has to be narrow because of it.
     *
     * A real fissure run writes:
     *   4267.551  ProjectionRewardChoice.lua: Relic rewards initialized
     *   4267.911  ProjectionsCountdown.lua: Relic timer closed
     *   4282.911  ProjectionsCountdown.lua: Relic timer closed
     *   4282.912  ProjectionRewardChoice.lua: Relic reward screen shut down
     *
     * The first two land inside one 750ms poll. "Relic timer closed" used to be
     * treated as the end, so that poll cleared the overlay on the very chunk that
     * should have raised it and the feature never fired. The reward countdown
     * ending is not the screen closing: the screen stays up for another 15
     * seconds, which is exactly how long the overlay needs to be useful.
     *
     * The last line is the real end, and it must keep winning over the start
     * pattern it also matches ("ProjectionRewardChoice" appears in it), hence end
     * first. */
    if (isRelicOverlayRewardEndLogText(chunk)) {
      relicOverlayBurstUntil = 0;
      relicOverlayLastHash = '';
      relicOverlayLastHashAt = 0;
      relicOverlayLastDetectionAt = 0;
      await clearRelicOverlayWindow('Watching EE.log for Void Fissure rewards...');
      sendRelicOverlayEvent('status', {
        enabled: true,
        message: 'Reward screen closed. Watching EE.log for the next relic.'
      });
    } else if (isRelicOverlayRewardLogText(chunk)) {
      triggerRelicOverlayBurst('Void Fissure reward screen detected. Reading platinum values...');
    }
  } catch (err) {
    if (!relicOverlayLogMissingNotified) {
      relicOverlayLogMissingNotified = true;
      sendRelicOverlayEvent('status', {
        enabled: true,
        message: 'Could not read EE.log, using slower screen fallback scanning.'
      });
    }
  }
}

async function startRelicOverlayLogWatcher() {
  if (relicOverlayLogTimer) {
    clearInterval(relicOverlayLogTimer);
    relicOverlayLogTimer = null;
  }

  relicOverlayLogPath = '';
  relicOverlayLogOffset = 0;
  relicOverlayLogMissingNotified = false;
  await pollRelicOverlayLog();
  relicOverlayLogTimer = setInterval(() => {
    pollRelicOverlayLog().catch(() => {});
  }, RELIC_OVERLAY_LOG_POLL_INTERVAL_MS);
}

function stopRelicOverlayLogWatcher() {
  if (relicOverlayLogTimer) {
    clearInterval(relicOverlayLogTimer);
    relicOverlayLogTimer = null;
  }
  relicOverlayLogPath = '';
  relicOverlayLogOffset = 0;
  relicOverlayLogMissingNotified = false;
}

async function scanRelicOverlayOnce() {
  if (!relicOverlayEnabled || relicOverlayScanning) return;
  relicOverlayScanning = true;
  relicOverlayLastCaptureAt = Date.now();

  try {
    const capture = await captureRelicOverlayScreen();
    const ocrRegion = createRelicOverlayOcrRegion(capture.image);
    const imageHash = crypto.createHash('sha1').update(ocrRegion.image.toBitmap()).digest('hex');
    const now = Date.now();

    if (imageHash === relicOverlayLastHash && (now - relicOverlayLastHashAt) < RELIC_OVERLAY_DUPLICATE_SCAN_MS) {
      return;
    }
    relicOverlayLastHash = imageHash;
    relicOverlayLastHashAt = now;

    const worker = await getOcrWorker();
    const result = await worker.recognize(ocrRegion.image.toPNG(), {
      tessedit_pageseg_mode: getOcrModule().PSM.SINGLE_BLOCK,
      preserve_interword_spaces: '1'
    });
    const data = result && result.data ? result.data : {};
    const lines = transformOcrLines(extractOcrLines(data), ocrRegion);
    const text = String(data.text || lines.map((line) => line.text).join('\n'));
    const detected = isLikelyRelicRewardScreen(text, lines);
    if (detected) relicOverlayLastDetectionAt = now;

    sendRelicOverlayEvent('scan', {
      ok: true,
      detected,
      text,
      lines,
      imageSize: capture.imageSize,
      displayBounds: capture.display && capture.display.bounds ? capture.display.bounds : null,
      scaleFactor: capture.display && capture.display.scaleFactor ? capture.display.scaleFactor : 1,
      capturedAt: now
    });

    if (!detected && (!relicOverlayLastDetectionAt || Date.now() - relicOverlayLastDetectionAt > RELIC_OVERLAY_HOLD_MS)) {
      await clearRelicOverlayWindow('Watching EE.log for Void Fissure rewards...');
    }
  } catch (err) {
    sendRelicOverlayEvent('error', {
      ok: false,
      message: err && err.message ? err.message : 'Relic overlay scan failed.'
    });
    if (!relicOverlayLastDetectionAt || Date.now() - relicOverlayLastDetectionAt > RELIC_OVERLAY_HOLD_MS) {
      await clearRelicOverlayWindow('');
    }
  } finally {
    relicOverlayScanning = false;
  }
}

async function startRelicOverlayLoop() {
  if (relicOverlayTimer) {
    clearTimeout(relicOverlayTimer);
    relicOverlayTimer = null;
  }
  relicOverlayBurstUntil = 0;
  relicOverlayLastHash = '';
  relicOverlayLastHashAt = 0;
  relicOverlayLastDetectionAt = 0;
  await startRelicOverlayLogWatcher();
  scheduleRelicOverlayScan(250);
}

async function stopRelicOverlayLoop() {
  relicOverlayEnabled = false;
  if (relicOverlayTimer) {
    clearTimeout(relicOverlayTimer);
    relicOverlayTimer = null;
  }
  stopRelicOverlayLogWatcher();
  relicOverlayLastHash = '';
  relicOverlayLastHashAt = 0;
  relicOverlayLastDetectionAt = 0;
  relicOverlayBurstUntil = 0;
  await clearRelicOverlayWindow('');
  if (relicOverlayWindow && !relicOverlayWindow.isDestroyed()) {
    relicOverlayWindow.close();
    relicOverlayWindow = null;
  }
}

function getOcrWorker() {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = getOcrModule().createWorker('eng', 1, {
      cachePath: path.join(app.getPath('userData'), 'tesseract-cache'),
      logger: (message) => {
        if (!message || typeof message !== 'object') return;
        sendOcrProgress({
          status: message.status || '',
          progress: typeof message.progress === 'number' ? message.progress : 0
        });
      }
    }).catch((err) => {
      ocrWorkerPromise = null;
      throw err;
    });
  }

  return ocrWorkerPromise;
}

function dataUrlToBuffer(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/^data:image\/[a-z0-9.+-]+;base64,(.+)$/i);
  if (!match) {
    throw new Error('Invalid image data.');
  }
  return Buffer.from(match[1], 'base64');
}

function normalizeOcrBbox(box) {
  if (!box || typeof box !== 'object') return null;
  const x0 = Number(box.x0);
  const y0 = Number(box.y0);
  const x1 = Number(box.x1);
  const y1 = Number(box.y1);
  if (![x0, y0, x1, y1].every((value) => Number.isFinite(value))) return null;
  if (x1 <= x0 || y1 <= y0) return null;
  return { x0, y0, x1, y1 };
}

function transformOcrBbox(box, transform) {
  const bbox = normalizeOcrBbox(box);
  if (!bbox) return null;
  const scale = Number(transform && transform.scale) || 1;
  const offsetX = Number(transform && transform.offsetX) || 0;
  const offsetY = Number(transform && transform.offsetY) || 0;
  return {
    x0: bbox.x0 / scale + offsetX,
    y0: bbox.y0 / scale + offsetY,
    x1: bbox.x1 / scale + offsetX,
    y1: bbox.y1 / scale + offsetY
  };
}

function transformOcrLines(lines, transform) {
  if (!Array.isArray(lines)) return [];
  if (!transform) return lines;
  return lines.map((line) => {
    const words = Array.isArray(line && line.words) ? line.words : [];
    return Object.assign({}, line, {
      bbox: transformOcrBbox(line && line.bbox, transform),
      words: words.map((word) => Object.assign({}, word, {
        bbox: transformOcrBbox(word && word.bbox, transform)
      }))
    });
  });
}

function extractOcrWords(line) {
  const words = Array.isArray(line && line.words) ? line.words : [];
  return words
    .map((word) => {
      const text = String(word && word.text ? word.text : '').trim();
      if (!text) return null;
      const bbox = normalizeOcrBbox(word.bbox);
      if (bbox && (bbox.x1 - bbox.x0 < 3 || bbox.y1 - bbox.y0 < 6)) return null;
      return {
        text,
        confidence: typeof word.confidence === 'number' ? word.confidence : 0,
        bbox
      };
    })
    .filter(Boolean);
}

function extractOcrLines(data) {
  const output = [];
  const pushLine = (line) => {
    const text = String(line && line.text ? line.text : '').trim();
    if (!text) return;
    const bbox = normalizeOcrBbox(line.bbox);
    if (bbox && (bbox.x1 - bbox.x0 < 6 || bbox.y1 - bbox.y0 < 8)) return;
    output.push({
      text,
      confidence: typeof line.confidence === 'number' ? line.confidence : 0,
      bbox,
      words: extractOcrWords(line)
    });
  };

  const directLines = Array.isArray(data && data.lines) ? data.lines : [];
  for (const line of directLines) {
    pushLine(line);
  }

  if (output.length > 0) {
    return output;
  }

  const blocks = Array.isArray(data && data.blocks) ? data.blocks : [];

  for (const block of blocks) {
    const paragraphs = Array.isArray(block && block.paragraphs) ? block.paragraphs : [];
    for (const paragraph of paragraphs) {
      const lines = Array.isArray(paragraph && paragraph.lines) ? paragraph.lines : [];
      for (const line of lines) {
        pushLine(line);
      }
    }
  }

  if (output.length > 0) {
    return output;
  }

  const text = String(data && data.text ? data.text : '');
  return text
    .split(/\r?\n/)
    .map((line) => String(line || '').trim())
    .filter(Boolean)
    .map((line) => ({ text: line, confidence: 0 }));
}

function sendRivenOverlayEvent(type, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('riven-overlay-event', Object.assign({ type }, payload || {}));
}

/**
 * Report login progress to the renderer.
 *
 * Needed because a recoverable login failure no longer ends the
 * wfm-login-browser promise: the window stays open for a retry, so without
 * this the renderer would sit on "Opening Warframe Market login..." with no
 * explanation of why nothing is happening.
 */
function sendWfmLoginStatus(payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('wfm-login-status', payload || {});
}

function sendRivenScanResult(payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('riven-scan-result', payload || {});
}

function isRivenRerollScreenLogText(text) {
  return /OmegaRerollSelection\.swf/i.test(String(text || ''));
}

function isRivenRerollConfirmLogText(text) {
  return /Are you sure you want to cycle/i.test(String(text || ''));
}

function isRivenRerollChoiceLogText(text) {
  return /Cycle Riven into current selection/i.test(String(text || ''));
}

function normalizeRivenOverlayText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function countRivenKeywordHits(text) {
  const keywords = getRivenOverlayKeywords();
  const normalized = normalizeRivenOverlayText(text);
  if (!normalized) return 0;
  const padded = ' ' + normalized + ' ';
  let total = 0;
  for (const keyword of keywords) {
    if (padded.indexOf(' ' + keyword + ' ') !== -1) total++;
  }
  return total;
}

/**
 * Count stat-shaped values: percentages and multipliers. This is deliberately
 * vocabulary-free, so a frame full of ordinary damage numbers cannot pass the gate
 * on wording alone, and a riven whose stats happen to be entirely generic words
 * ("+120% Damage", "-30% Fire Rate") is not rejected for lack of keywords.
 */
function countRivenValueHits(text) {
  // Matched against the raw text on purpose. normalizeRivenOverlayText keeps only
  // letters and digits, so it deletes the "%", "+", "-" and "." this looks for, and
  // matching afterwards always returned 0, which silently reduced the gate to
  // "three keywords" and made the values-only path dead code.
  const raw = String(text || '').toLowerCase();
  if (!raw.trim()) return 0;
  const matches = raw.match(/[+-]?\s*\d+(?:\.\d+)?\s*%|x\s*\d+(?:\.\d+)?/g);
  return matches ? matches.length : 0;
}

function isLikelyWarframeRivenContent(text) {
  // One keyword plus two values, or three values with none, is enough: a riven stat
  // panel always shows several rolled numbers next to their names.
  const keywords = countRivenKeywordHits(text);
  const values = countRivenValueHits(text);
  return (keywords >= 1 && keywords + values >= 3) || values >= 3;
}

function createRivenOcrRegion(image, card) {
  const region = card || RIVEN_OVERLAY_CARDS.current;
  const size = image && image.getSize ? image.getSize() : { width: 0, height: 0 };
  const width = Math.max(1, Number(size.width) || 1);
  const height = Math.max(1, Number(size.height) || 1);
  const crop = {
    x: Math.max(0, Math.round(width * region.x)),
    y: Math.max(0, Math.round(height * region.y)),
    width: Math.max(1, Math.round(width * region.width)),
    height: Math.max(1, Math.round(height * region.height))
  };

  if (crop.x + crop.width > width) crop.width = width - crop.x;
  if (crop.y + crop.height > height) crop.height = height - crop.y;

  const targetWidth = Math.min(
    RIVEN_OVERLAY_CARD_MAX_WIDTH,
    Math.max(RIVEN_OVERLAY_CARD_MIN_WIDTH, crop.width * RIVEN_OVERLAY_CARD_UPSCALE)
  );
  const scale = targetWidth / crop.width;
  const targetHeight = Math.max(1, Math.round(crop.height * scale));
  const prepared = image
    .crop(crop)
    .resize({
      width: Math.round(targetWidth),
      height: targetHeight,
      quality: 'best'
    });

  return {
    image: prepared,
    offsetX: crop.x,
    offsetY: crop.y,
    scale
  };
}

/**
 * The readable part of a card, cropped from the card crop.
 *
 * Kept at the same upscale as the card it came from: only the vertical extent is
 * cut, so the glyphs are the same size that was measured working. The full card is
 * still used for deciding which one is selected, because the selection glow is on
 * the card's frame and not in the text.
 */
function createRivenTextRegion(cardRegion) {
  const image = cardRegion && cardRegion.image;
  const size = image && image.getSize ? image.getSize() : { width: 0, height: 0 };
  const width = Math.max(1, Number(size.width) || 1);
  const height = Math.max(1, Number(size.height) || 1);
  const y = Math.max(0, Math.min(height - 1, Math.round(height * RIVEN_OVERLAY_CARD_TEXT_BAND.y)));
  const bandHeight = Math.max(1, Math.min(height - y, Math.round(height * RIVEN_OVERLAY_CARD_TEXT_BAND.height)));
  if (bandHeight >= height) return cardRegion;

  return {
    image: image.crop({ x: 0, y: y, width: width, height: bandHeight }),
    offsetX: cardRegion.offsetX,
    offsetY: cardRegion.offsetY + Math.round(y * cardRegion.scale),
    scale: cardRegion.scale
  };
}

function findDisplayById(displayId) {
  const wanted = String(displayId == null ? '' : displayId);
  if (!wanted) return null;
  const displays = screen.getAllDisplays();
  return displays.find((display) => String(display.id) === wanted)
    || displays.find((display) => String(display.id).indexOf(wanted) === 0)
    || null;
}

async function captureDisplayById(displayId) {
  const display = findDisplayById(displayId) || (displayId == null ? null : screen.getPrimaryDisplay());
  const captureSize = getDisplayCaptureSize(display);
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: captureSize
  });

  const wanted = String(display && display.id ? display.id : '');
  let source = wanted ? sources.find((entry) => String(entry.display_id || '') === wanted) : null;
  if (!source && wanted) {
    source = sources.find((entry) => String(entry.id || '').indexOf(wanted) !== -1) || null;
  }
  if (!source) source = sources[0];

  if (!source || !source.thumbnail || source.thumbnail.isEmpty()) {
    throw new Error('Screen capture is unavailable. Check OS screen recording permission or use borderless/windowed mode.');
  }

  return {
    display,
    image: source.thumbnail,
    imageSize: source.thumbnail.getSize()
  };
}

function getRivenCandidateDisplayIds() {
  const candidates = [];
  const push = (value) => {
    if (value == null || value === '') return;
    const key = String(value);
    if (!candidates.includes(key)) candidates.push(key);
  };

  push(rivenOverlayManualDisplayId);
  push(rivenOverlayCachedDisplayId);
  try {
    const cursorDisplay = getDisplayForRelicOverlay();
    push(cursorDisplay && cursorDisplay.id);
  } catch (err) {
    // Cursor position is unavailable on some platforms; the display sweep below still covers it.
  }
  for (const display of screen.getAllDisplays()) push(display.id);

  return candidates;
}

/* Windows ships its own OCR engine (Windows.Media.Ocr) and it is both faster and more
 * accurate than Tesseract on the lit riven card, so it is tried first and Tesseract
 * stays as the fallback. Measured over 48 captured frames, the two agreed on 42; every
 * one of the 6 disagreements was a frame the player would call unreadable anyway (a
 * mid-reroll motion blur, or the dimmed unselected card, which this engine cannot read
 * and Tesseract mostly can). That split is the reason both are kept.
 *
 * It is reached through @napi-rs/system-ocr, a native binding, rather than by spawning
 * powershell.exe against a .ps1. Same engine, but it takes the PNG buffer directly and
 * returns in roughly 100ms instead of paying a process launch on every card, which is
 * what lets the 850ms watch loop keep up with a reroll.
 *
 * The language is pinned to English rather than left to the default. The game decides
 * the text, and the engine's TryCreateFromUserProfileLanguages() would follow the
 * Windows display language instead, which read an English card badly on a German
 * desktop. */
/* ===========================================================================
   RIVEN MEMORY READER
   ===========================================================================
   Warframe keeps each riven's summary in its own process memory as one plain
   string: the weapon name, every stat with its signed value, the mastery rank
   and the weapon class. That is exact data, so it removes OCR from the path
   entirely, which is the point: the one failure this reader must never have is a
   confidently wrong number.

   Read-only. Opens the client for PROCESS_VM_READ and nothing else: no writes,
   no injection, no code in the game, nothing sent anywhere. It is the same
   technique class as warframe-api-helper, which reads the login ticket the same
   way.

   Windows only, because it uses Win32. Everything else in the app is portable
   and this is the one piece that is not; see docs/FEATURE-NOTES.md.
   --------------------------------------------------------------------------- */

const RIVEN_MEMORY_SCRIPT = 'riven-scan.ps1';
const RIVEN_MEMORY_TIMEOUT_MS = 120000;
// Rivens do not change while the game sits idle, and a full walk of the address
// space is not free, so a rescan sooner than this is refused rather than queued.
const RIVEN_MEMORY_MIN_INTERVAL_MS = 60 * 1000;

let rivenMemoryLastScan = null;
let rivenMemoryInFlight = null;

/**
 * Resolve a bundled script to a real path on disk.
 *
 * A packaged build puts main.js inside app.asar, and a child process cannot read a
 * file out of an asar archive: it would fail on the path, every scan would error,
 * and the reader would look permanently broken while reporting nothing. So a
 * packaged copy is unpacked to temp once and reused.
 */
async function resolveBundledScript(name) {
  const candidates = [path.join(__dirname, name), path.join(__dirname, 'tools', name)];
  const packed = candidates.find((p) => fsSync.existsSync(p));
  if (!packed) return '';

  // In a packaged build main.js sits inside app.asar, and a child process cannot read a
  // file out of an asar archive. It would fail on the path every single time, so the
  // reader would look permanently broken while reporting nothing useful. Copy it out
  // once to temp and reuse that.
  if (packed.indexOf('app.asar') === -1) return packed;

  const unpacked = path.join(app.getPath('temp'), 'ordis-scripts', name);
  try {
    await fs.mkdir(path.dirname(unpacked), { recursive: true });
    await fs.writeFile(unpacked, await fs.readFile(packed));
    return unpacked;
  } catch (err) {
    return '';
  }
}

/**
 * Read the player's rivens out of game memory.
 *
 * Never throws. A failed read is a missing feature for a moment, not a broken app,
 * so every failure path returns { ok: false, reason } and the caller decides what to
 * tell the player.
 */
async function scanRivensFromMemory(options) {
  const settings = options || {};
  if (process.platform !== 'win32') {
    return { ok: false, reason: 'unsupported-platform', message: 'Reading game memory is Windows only for now.' };
  }

  const now = Date.now();
  if (!settings.force && rivenMemoryLastScan && now - rivenMemoryLastScan.at < RIVEN_MEMORY_MIN_INTERVAL_MS) {
    return Object.assign({}, rivenMemoryLastScan, { cached: true });
  }
  // Two scans at once would double the memory traffic for no gain, and the second
  // would return a half-finished picture.
  if (rivenMemoryInFlight) return rivenMemoryInFlight;

  rivenMemoryInFlight = (async () => {
    const script = await resolveBundledScript(RIVEN_MEMORY_SCRIPT);
    if (!script) return { ok: false, reason: 'script-missing' };

    const outFile = path.join(app.getPath('temp'), 'ordis-riven-memory.json');
    // Remembers which regions held the rivens. The first scan of a session walks the
    // whole address space; after that it starts where the answers were, which is the
    // difference between a visible pause and no pause at all.
    const cacheFile = path.join(app.getPath('userData'), 'riven-memory-regions.txt');
    const args = [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
      '-Out', outFile,
      '-Cache', cacheFile,
      '-MaxSeconds', String(settings.maxSeconds || 90),
      // The reader's own default of 60 is a safety stop for a cold walk, and it was
      // silently truncating a real collection: a player with 86 rivens got 64 and no
      // indication that anything was missing. Generous enough that a full collection
      // finishes on its own, with the time budget as the real limit.
      '-StopAfter', String(settings.stopAfter || 600)
    ];
    if (settings.rebuild) args.push('-RebuildCache');
    const run = await execFileAsync('powershell', args, RIVEN_MEMORY_TIMEOUT_MS);

    let payload = null;
    try {
      payload = JSON.parse(await fs.readFile(outFile, 'utf8'));
    } catch (err) {
      // The script also prints its result, so fall back to that if the file is missing
      // or was never written. execFileAsync resolves on non-zero exit too, which is
      // exactly the shape of a "game is not running" result.
      try {
        payload = JSON.parse(String(run.stdout || '').trim());
      } catch (err2) {
        payload = null;
      }
    }
    if (!payload || payload.error) {
      return {
        ok: false,
        reason: payload && payload.error ? 'game-not-running' : 'no-output',
        message: payload && payload.error ? payload.error : 'The reader produced no output.',
        detail: run.message || ''
      };
    }

    // Parsed through the same parser the OCR path uses, so a riven read from memory
    // and one read from the screen go down one code path and cannot drift apart.
    const parser = getRivenParserModule();
    const entries = [];
    // Keyed on the weapon rather than on the values. The same riven is found more than
    // once, and the copies are not always current: the game's list string is rebuilt
    // when the list is drawn, so a riven that has been ranked since can still be
    // present at its old address with its old numbers. Ranking only ever raises a
    // riven's values, never lowers them, so the largest copy seen is the current one.
    // Keeping both would show the same riven twice at two different values.
    const byWeapon = new Map();
    for (const block of payload.rivens || []) {
      let parsed = null;
      try {
        parsed = parser.parseRivenOcr(block.text, { fromMemory: true });
      } catch (err) {
        parsed = null;
      }
      if (!parsed || !parsed.stats || !parsed.stats.length) continue;
      const entry = {
        text: block.text,
        stats: parsed.stats,
        weaponName: parsed.weaponName || '',
        weaponNameCandidates: parsed.weaponNameCandidates || [],
        masterRank: parsed.masterRank,
        // The class comes from the "mr 10 shotgun" trailer. Without it grading cannot
        // work out the largest possible roll for these stats, because the maximum a
        // stat can reach depends on the weapon it sits on.
        rivenType: parsed.weaponClass || '',
        warnings: parsed.warnings || []
      };
      /* Two different riven names on one weapon, a Phenmor Conci-Vexinok and a Phenmor
       * Cronitox, are genuinely two rivens and both have to survive. So the riven name
       * is part of the key, taken from the full candidate rather than the bare weapon
       * name, which is the only field that carries it.
       *
       * The candidate has to be matched to the same weapon this entry resolved to, or
       * two different weapons produce the same second candidate and collapse into one
       * riven. That is what dropped a second Penta and a second Stahlta from the list. */
      const full = entry.weaponNameCandidates.find((c) =>
        String(c).toLowerCase().indexOf(String(entry.weaponName || '').toLowerCase()) === 0) || '';
      const rivenName = full
        ? String(full).slice(String(entry.weaponName || '').length).replace(/^[\s-]+/, '')
        : '';
      /* Stats are part of the key, not just the name.
       *
       * Two riven names on one weapon is two rivens and both survive, but two copies of
       * the same riven are the same riven, and keying on the name alone left pairs of
       * rows with identical stats and an identical score sitting in the list. The
       * fingerprint is what actually distinguishes them, so it is the key. */
      const key = String(entry.weaponName || '?').toLowerCase() + '|' +
        rivenName.toLowerCase() + '|' +
        entry.stats.map((s) => (s.isPositive ? '+' : '-') + s.key + ':' + s.value).sort().join(',');
      const total = entry.stats.reduce((sum, s) => sum + Math.abs(s.value), 0);
      const held = byWeapon.get(key);
      if (!held || total > held.total) byWeapon.set(key, { total, entry });
    }
    for (const held of byWeapon.values()) entries.push(held.entry);

    rivenMemoryLastScan = {
      ok: true,
      at: now,
      entries,
      scannedMs: payload.scannedMs,
      mbPerSec: payload.mbPerSec,
      // Worth showing, because a scan that ended on the clock rather than on the
      // collection being complete is a partial answer and the player should know.
      timedOut: !!payload.timedOut,
      cachedRegionsUsed: payload.cachedRegionsUsed || 0,
      cacheWritten: !!payload.cacheWritten,
      // Rivens the reader refused because the game's own copy of them drops a minus
      // sign. Passed on so the player can be told the read was partial, rather than
      // seeing a shorter list and assuming that is all they own.
      ambiguousSkipped: payload.ambiguousSkipped || 0
    };
    return rivenMemoryLastScan;
  })();

  try {
    return await rivenMemoryInFlight;
  } finally {
    rivenMemoryInFlight = null;
  }
}

const RIVEN_WIN_OCR_LANGUAGE = 'en-US';
// A stat line always carries a number next to a sign, percent or multiplier. Used only
// to decide whether a read is worth trusting, never to grade: grading is the parser's
// job, and it is the one place a wrong number becomes a confident wrong answer.
const RIVEN_STAT_LINE_HINT = /[+\-x×]\s*\d|\d\s*%|\d\s*[x×]/i;
const RIVEN_WIN_OCR_MIN_LINES = 2;

let systemOcrModule = null;
let winOcrBroken = false;

function getSystemOcrModule() {
  // Required on first use for the same reason tesseract is: it is a native addon and
  // nothing on the startup path needs it.
  if (!systemOcrModule) systemOcrModule = require('@napi-rs/system-ocr');
  return systemOcrModule;
}

function countStatLikeLines(text) {
  let count = 0;
  for (const line of String(text || '').split(/\r?\n/)) {
    if (RIVEN_STAT_LINE_HINT.test(line)) count++;
  }
  return count;
}

/**
 * Read one riven card with the Windows OCR engine.
 *
 * Returns the recognised lines, or null when this engine cannot be used, so the caller
 * falls back to Tesseract. A failure here is never a scan failure.
 */
async function windowsOcrLines(png) {
  if (process.platform !== 'win32' || winOcrBroken) return null;

  try {
    const result = await getSystemOcrModule().recognize(png, undefined, [RIVEN_WIN_OCR_LANGUAGE]);
    const raw = (result && result.lines ? result.lines : []).map((line) => ({
      text: String(line.text || '').trim(),
      // Normalised 0..1 boxes, kept because they are what a later pass needs to tell
      // the weapon name from the stat block without re-cropping by hand.
      box: line.boundingBox || null
    })).filter((line) => line.text);

    if (countStatLikeLines(raw.map((line) => line.text).join('\n')) < RIVEN_WIN_OCR_MIN_LINES) {
      return null;
    }
    return raw;
  } catch (err) {
    // A missing language pack is the one failure that will never fix itself, so it is
    // worth remembering; anything else is treated as a bad frame and retried.
    if (err && /lang/i.test(String(err.message || ''))) winOcrBroken = true;
    return null;
  }
}

/**
 * Reduce one card's parsed stats to a comparable string.
 *
 * Two engines reading the same pixels will rarely agree on the raw text, so agreement
 * is judged on the numbers that actually matter: the same stats, with the same values
 * and signs. Names are resolved to their canonical keys first so "Damage to Infested"
 * and "Damage to Infectcd" can still count as the same stat, and values are rounded so
 * float noise is not treated as a disagreement.
 */
function rivenStatFingerprint(parsed) {
  const stats = parsed && Array.isArray(parsed.stats) ? parsed.stats : [];
  return stats
    .map((stat) => {
      let key = '';
      try {
        key = getRivenDataModule().resolveRivenStatKey(stat.name) || String(stat.name || '').toLowerCase();
      } catch (err) {
        key = String(stat.name || '').toLowerCase();
      }
      return key + (stat.isPositive ? '+' : '-') + (Math.round(Number(stat.value) * 10) / 10);
    })
    .sort()
    .join('|');
}

/* A riven carries two or three bonuses and at most one curse. One resolved stat is not
 * enough to grade from: a single misread digit on a single line would then be presented
 * as the whole result. */
const RIVEN_MIN_STATS_FOR_GRADE = 2;

/**
 * Decide what a card's worth of engine reads actually establishes.
 *
 * Returns the read to grade from when the engines agree, and otherwise reports the
 * disagreement rather than picking a winner. This is the whole point: a single OCR read
 * of a 10px-tall line is a guess, and a guess presented as a grade is the one failure
 * this app must never have. When the engines differ there is no correct answer to
 * choose, so the honest result is "not verified yet" and the next frame gets another
 * go.
 */
function reconcileRivenReads(reads) {
  const usable = (reads || []).filter((read) => read && read.parsed && read.parsed.stats &&
    read.parsed.stats.length >= RIVEN_MIN_STATS_FOR_GRADE);
  if (!usable.length) {
    return { agreed: false, reason: 'no-engine-read-enough-stats', reads: reads || [] };
  }

  const prints = new Map();
  for (const read of usable) {
    const print = rivenStatFingerprint(read.parsed);
    if (!prints.has(print)) prints.set(print, []);
    prints.get(print).push(read);
  }

  if (prints.size > 1) {
    return { agreed: false, reason: 'engines-disagree', reads: reads || [], variants: prints.size };
  }

  const winners = [...prints.values()][0];
  return {
    agreed: true,
    read: winners[0],
    // Recorded for the report so a disputed value can be argued about with evidence.
    engines: winners.map((read) => read.engine),
    corroborating: winners.length,
    /* "Agreed" and "verified" are not the same thing, and conflating them is how a
     * single unread check would end up wearing the same badge as a confirmed one.
     *
     * A lone engine does happen legitimately: the Windows engine cannot read the
     * dimmed unselected card, so the previous roll is Tesseract-only and there is
     * nobody to check it against. That read is still worth showing - it is the diff -
     * but it is one source, and the overlay says so rather than implying a second
     * opinion that never happened. */
    verified: winners.length > 1
  };
}

async function recognizeRivenRegion(capture, only) {
  // `only` reads a single card. The watch loop uses it to follow the selection:
  // the card that is not lit does not need reading twice.
  const wanted = only === 'previous' || only === 'current'
    ? { [only]: RIVEN_OVERLAY_CARDS[only] }
    : { previous: RIVEN_OVERLAY_CARDS.previous, current: RIVEN_OVERLAY_CARDS.current };
  const regions = {};
  for (const [side, card] of Object.entries(wanted)) {
    regions[side] = createRivenOcrRegion(capture.image, card);
  }
  /* Hash the text band, not the whole card.
   *
   * The card's picture rotates continuously while the card sits on screen, so hashing
   * the card meant the hash changed on every single frame and every scan looked like a
   * new one. That is what made the riven get re-read over and over while nothing about
   * it had changed. The band below the picture is static, and it holds everything this
   * function actually uses.
   *
   * Both cards still contribute, because a new roll appearing next to an unchanged
   * previous roll is genuinely a different screen and must not be dismissed as a
   * duplicate. */
  const imageHash = crypto.createHash('sha1');
  for (const side of Object.keys(regions)) {
    imageHash.update(createRivenTextRegion(regions[side]).image.toBitmap());
  }
  const hash = imageHash.digest('hex');
  const now = Date.now();

  if (!only && hash === rivenOverlayLastHash && (now - rivenOverlayLastHashAt) < RIVEN_OVERLAY_DUPLICATE_SCAN_MS) {
    return { duplicate: true, imageHash: hash, now };
  }

  if (!only) {
    rivenOverlayLastHash = hash;
    rivenOverlayLastHashAt = now;
  }

  // SINGLE_COLUMN, not SINGLE_BLOCK: a card is one centred column of lines under a
  // picture, and SINGLE_BLOCK pulls the card art and the button below it into the
  // same block, which is where the junk name candidates came from.
  //
  // The worker is fetched inside the fallback, not here: loading it costs ~830ms and
  // the Windows engine is meant to answer the common case without it at all.
  const readWithTesseract = async (region) => {
    const worker = await getOcrWorker();
    const result = await worker.recognize(region.image.toPNG(), {
      tessedit_pageseg_mode: getOcrModule().PSM.SINGLE_COLUMN,
      preserve_interword_spaces: '1'
    });
    const data = result && result.data ? result.data : {};
    const lines = transformOcrLines(extractOcrLines(data), region);
    return {
      text: String(data.text || lines.map((line) => line.text).join('\n')),
      lines: lines,
      engine: 'tesseract'
    };
  };

  const readWithWindows = async (region) => {
    const winLines = await windowsOcrLines(region.image.toPNG());
    if (!winLines) return null;
    return {
      text: winLines.map((line) => line.text).join('\n'),
      lines: winLines,
      engine: 'windows'
    };
  };

  /* Every card is read by both engines, always, and the two are then made to agree.
   *
   * Running only one engine and trusting it is what made this feature feel unreliable:
   * a misread digit had no way of being caught. The Windows engine cannot read the
   * dimmed card and Tesseract mostly can, so the two also cover each other's blind
   * spot. When they do not agree, nothing is graded - see reconcileRivenReads. */
  const readCard = async (cardRegion) => {
    // The text band is cut here and only here. The caller hands over the whole card,
    // because both engines read the same band and cutting it twice leaves OCR a sliver
    // of the card that neither of them can read.
    const region = createRivenTextRegion(cardRegion);
    const png = region.image.toPNG();

    const [winRead, tessRead] = await Promise.all([
      readWithWindows(region),
      // Tesseract is allowed to be missing: it is the second opinion, and on a machine
      // where only one engine works a single clean read is better than no read at all.
      readWithTesseract(region).catch(() => null)
    ]);

    const reads = [winRead, tessRead].filter(Boolean).map((read) => {
      let parsed = null;
      try {
        parsed = getRivenParserModule().parseRivenOcr(read.text);
      } catch (err) {
        parsed = null;
      }
      return Object.assign({}, read, { parsed: parsed });
    });

    const verdict = reconcileRivenReads(reads);
    return {
      region: region,
      reads: reads,
      agreed: verdict.agreed,
      reason: verdict.reason,
      variants: verdict.variants || 0,
      // The graded text is the agreed one, or empty when nothing was verified. An empty
      // text here is what makes the caller hold off rather than show a wrong number.
      text: verdict.agreed ? verdict.read.text : '',
      lines: verdict.agreed ? verdict.read.lines : [],
      engine: verdict.agreed ? verdict.read.engine : '',
      engines: verdict.engines || [],
      corroborating: verdict.corroborating || 0,
      verified: !!(verdict.agreed && verdict.verified)
    };
  };

  const cards = {};
  for (const side of Object.keys(regions)) {
    cards[side] = await readCard(regions[side]);
  }

  // Off unless the environment asks for it. Reading the cards is guesswork until
  // it can be replayed against the exact pixels the game drew, and a screenshot in
  // a transcript is both lossy and enormous.
  const dumpDir = String(process.env.ORDIS_RIVEN_CAPTURE_DIR || '').trim();
  if (dumpDir && !only) {
    try {
      await fs.mkdir(dumpDir, { recursive: true });
      await Promise.all(Object.keys(regions).map((side) =>
        fs.writeFile(path.join(dumpDir, now.toString() + '-' + side + '.png'), regions[side].image.toPNG())));
    } catch (err) {
      // A failed dump must never fail a scan.
    }
  }

  return { duplicate: false, imageHash: hash, now, cards };
}

async function scanRivenOverlayOnce() {
  if (!rivenOverlayEnabled || rivenOverlayScanning) return null;
  rivenOverlayScanning = true;
  rivenOverlayLastScanAt = Date.now();

  const diag = {
    displaysTried: 0,
    capturesFailed: 0,
    ocrRuns: 0,
    duplicates: 0,
    keywordHits: 0,
    valueHits: 0,
    // Frames the engines could not agree on. Non-zero here is normal during a reroll
    // and is the reason a grade can be late rather than wrong.
    unverified: 0,
    bestText: ''
  };

  try {
    const candidateIds = getRivenCandidateDisplayIds();
    for (const displayId of candidateIds) {
      diag.displaysTried += 1;
      let capture = null;
      let recognition = null;
      try {
        capture = await captureDisplayById(displayId);
      } catch (err) {
        diag.capturesFailed += 1;
        diag.lastError = err && err.message ? err.message : 'capture failed';
        continue;
      }

      try {
        recognition = await recognizeRivenRegion(capture);
      } catch (err) {
        diag.capturesFailed += 1;
        diag.lastError = err && err.message ? err.message : 'ocr failed';
        continue;
      }

      if (!recognition || recognition.duplicate) {
        diag.duplicates += 1;
        continue;
      }

      diag.ocrRuns += 1;

      // The gate looks at both cards together: the left one is the riven being
      // replaced and the right one is the roll, and either can be the only one
      // that reads cleanly on a given frame.
      //
      // It reads every engine's raw text, not the agreed text, because "this is not a
      // riven screen" and "this is a riven screen the engines could not agree on" are
      // different failures and the diagnostics have to be able to tell them apart.
      const gateText = (card) => (card && card.reads ? card.reads : [])
        .map((r) => r.text)
        .filter((part) => String(part || '').trim())
        .join('\n');
      const scannedText = [gateText(recognition.cards.previous), gateText(recognition.cards.current)]
        .filter((part) => String(part || '').trim())
        .join('\n');
      if (scannedText.length > diag.bestText.length) diag.bestText = scannedText;
      const hits = countRivenKeywordHits(scannedText);
      if (hits > diag.keywordHits) diag.keywordHits = hits;
      // Both halves of the gate are reported, so a failure says which one fell short
      // instead of implying only the keyword count mattered.
      const valueHits = countRivenValueHits(scannedText);
      if (valueHits > diag.valueHits) diag.valueHits = valueHits;

      if (!isLikelyWarframeRivenContent(scannedText)) continue;
      diag.unverified += (recognition.cards.current.agreed ? 0 : 1);

      rivenOverlayCachedDisplayId = capture.display && capture.display.id != null
        ? capture.display.id
        : rivenOverlayCachedDisplayId;

      return {
        ok: true,
        // The right card is the new roll, and it is what gets graded. The left card
        // is the roll it replaces, read from the same frame rather than remembered
        // from the last scan.
        text: recognition.cards.current.text,
        lines: recognition.cards.current.lines,
        ocrEngine: recognition.cards.current.engine || '',
        ocrEngines: recognition.cards.current.engines || [],
        ocrCorroborating: recognition.cards.current.corroborating || 0,
        ocrVerified: !!recognition.cards.current.verified,
        previousText: recognition.cards.previous.text,
        previousLines: recognition.cards.previous.lines,
        previousOcrEngine: recognition.cards.previous.engine || '',
        imageSize: capture.imageSize,
        displayBounds: capture.display && capture.display.bounds ? capture.display.bounds : null,
        displayId: capture.display && capture.display.id != null ? capture.display.id : displayId,
        capturedAt: recognition.now
      };
    }

    return { ok: false, reason: 'no-riven-content', diag };
  } catch (err) {
    return {
      ok: false,
      reason: 'scan-failed',
      message: err && err.message ? err.message : 'Riven overlay scan failed.',
      diag
    };
  } finally {
    rivenOverlayScanning = false;
  }
}

function describeRivenScanFailure(diag) {
  const d = diag || {};
  if (!d.ocrRuns) {
    if (d.capturesFailed > 0 && d.duplicates === 0) {
      return 'Screen capture failed on every display. Check your OS screen recording permission, and use borderless or windowed mode. (' + (d.lastError || 'no detail') + ')';
    }
    if (d.duplicates > 0 && d.capturesFailed === 0) {
      return 'The captured frame never changed, so the reroll screen was probably still animating. Try again.';
    }
    return 'No display could be captured. Check your OS screen recording permission.';
  }
  // The gate needs 1 keyword plus 2 values, or 3 values on their own, so quoting a
  // bare "need 2 keywords" here would send the user chasing the wrong number.
  return 'Read the screen but could not find riven stats (' + d.keywordHits + ' keyword hit' + (d.keywordHits === 1 ? '' : 's') +
    ', ' + (d.valueHits || 0) + ' value' + (d.valueHits === 1 ? '' : 's') +
    '; need 1 keyword with 2 values, or 3 values). The crop region may be off for your resolution. Sample text: ' +
    JSON.stringify(String(d.bestText || '').trim().slice(0, 120));
}

/**
 * Find the weapon a parsed card belongs to.
 *
 * OCR puts fragments above the real weapon name, so every plausible name is tried
 * and the first one this tool actually knows wins. Matching published data is the
 * only reliable signal, and it also rejects the fragment.
 */
function matchRivenWeapon(rivenData, data, parsed) {
  const names = (parsed.weaponNameCandidates && parsed.weaponNameCandidates.length)
    ? parsed.weaponNameCandidates
    : (parsed.weaponName ? [parsed.weaponName] : []);
  if (!names.length) {
    return { weapon: null, matchedName: null, error: 'The weapon name was not readable, so the disposition is unknown.' };
  }

  const tried = [];
  for (const name of names) {
    const found = rivenData.findRivenWeapon(data, name);
    if (found && found.weapon) {
      return { weapon: found.weapon, matchedName: name, error: null };
    }
    tried.push(name);
  }

  return {
    weapon: null,
    matchedName: null,
    error: '"' + tried.join('", "') + '" ' + (tried.length > 1 ? 'are not weapons' : 'is not a weapon') +
      ' this tool knows, so its disposition is unknown and no maximum roll can be computed.'
  };
}

/**
 * Summarise the other card on the same frame, for the before/after view.
 *
 * The left card is the riven the new roll replaces, so it is a truer "previous roll"
 * than the last remembered one: it is what was actually on screen, and it is still
 * there after a restart or a missed scan. It is only used when it grades as the same
 * weapon, because a diff between two different rivens is worse than no diff. Every
 * doubtful step returns null and the caller falls back to the remembered roll.
 */
function summarizeRivenSideCard(text, rivenData, data, currentParsed) {
  if (!rivenData || !data || !String(text || '').trim()) return null;

  let parsed = null;
  try {
    parsed = getRivenParserModule().parseRivenOcr(text);
  } catch (err) {
    return null;
  }
  // A partial read would put a wrong number next to a right one, which is the one
  // comparison the player is actually reading.
  if (!parsed || !parsed.stats.length || parsed.unresolvedStats.length) return null;

  const match = matchRivenWeapon(rivenData, data, parsed);
  const current = currentParsed ? matchRivenWeapon(rivenData, data, currentParsed) : null;
  if (!match.weapon || !current.weapon) return null;
  if (String(match.weapon.name).toLowerCase() !== String(current.weapon.name).toLowerCase()) return null;

  let grade = null;
  try {
    grade = rivenData.gradeRiven(match.weapon, parsed.stats);
  } catch (err) {
    return null;
  }
  if (!grade) return null;

  return buildRivenRollSummary(parsed, grade);
}

/**
 * Turn a successful OCR read into a graded riven.
 *
 * Returns a payload shaped for the renderer. Any step that cannot be completed
 * honestly reports why instead of guessing: an unrecognised weapon has no
 * disposition, and a disposition is what every maximum roll is scaled by.
 */
async function gradeRivenScan(success, options) {
  /* `file: false` grades without saving.
   *
   * The watch loop grades on every flip between the two cards, and saving those
   * would file the same riven several times while the player is still deciding.
   * The burst that runs on the reroll itself is what saves. */
  const settings = options || {};
  const shouldFile = settings.file !== false;
  const base = {
    stage: 'ocr',
    text: success.text,
    lines: success.lines,
    // Which engine produced this read, and whether the other one agreed. A disputed
    // value is much easier to argue about when the report says who saw what.
    ocrEngine: success.ocrEngine || '',
    ocrEngines: success.ocrEngines || [],
    ocrCorroborating: success.ocrCorroborating || 0,
    ocrVerified: !!success.ocrVerified,
    // The other card on the same frame, kept so a report of a bad read can show
    // what both halves of the screen actually said.
    previousText: success.previousText,
    previousLines: success.previousLines,
    previousOcrEngine: success.previousOcrEngine || '',
    displayId: success.displayId,
    displayBounds: success.displayBounds,
    capturedAt: success.capturedAt
  };

  let parsed;
  try {
    parsed = getRivenParserModule().parseRivenOcr(success.text);
  } catch (err) {
    return Object.assign({}, base, {
      success: false,
      error: 'Reroll was read but the stats could not be parsed. ' + (err && err.message ? err.message : '')
    });
  }

  if (!parsed) {
    return Object.assign({}, base, {
      success: false,
      error: 'Reroll was read but no riven stats were found in the text. ' +
        'The mod card may have been cropped out of the capture region.'
    });
  }

  if (!parsed.stats.length) {
    return Object.assign({}, base, {
      success: false,
      parsed: parsed,
      error: 'Reroll was read but none of the stat names were recognised' +
        (parsed.unresolvedStats.length
          ? ': ' + parsed.unresolvedStats.map((s) => s.name).join(', ')
          : '. The card may have been cut off.') +
        ' Nothing was graded rather than guessing.'
    });
  }

  // A riven has at most three bonuses and one curse. If the parse broke the
  // layout rules it means lines were lost or noise was read as stats, and grading
  // it would produce a confident wrong answer.
  const layoutProblem = parsed.warnings.find((w) => /at most/.test(w));
  if (layoutProblem) {
    return Object.assign({}, base, {
      success: false,
      parsed: parsed,
      error: 'Reroll was read but the stats do not form a valid riven (' + layoutProblem + '). ' +
        'Nothing was graded rather than grading a partial read.'
    });
  }

  // An unrecognised stat name means the stat set cannot be confirmed complete, so a
  // perfectness averaged over the recognised subset would understate the true
  // value. Refuse rather than report a number we cannot stand behind.
  //
  // The one exception is a stat set that is already maximal: three bonuses and one
  // curse is the most a riven can have, so any further line cannot be a riven stat
  // and is safe to ignore. That case still grades, but is flagged as partial so the
  // UI can say an extra line was seen.
  const RIVEN_MAX_BONUSES = 3;
  const RIVEN_MAX_CURSES = 1;
  const bonusCount = parsed.stats.filter((s) => s.isPositive).length;
  const curseCount = parsed.stats.length - bonusCount;
  const statsAreMaximal = bonusCount >= RIVEN_MAX_BONUSES && curseCount >= RIVEN_MAX_CURSES;

  if (parsed.unresolvedStats.length && !statsAreMaximal) {
    return Object.assign({}, base, {
      success: false,
      parsed: parsed,
      unresolvedStats: parsed.unresolvedStats,
      error: 'Reroll was read but ' + parsed.unresolvedStats.length + ' stat name' +
        (parsed.unresolvedStats.length === 1 ? ' was' : 's were') + ' not recognised (' +
        parsed.unresolvedStats.map((s) => s.name).join(', ') + '), so the full stat set is ' +
        'unknown and a score would be averaged over part of it. Nothing was graded.'
    });
  }

  let weapon = null;
  let weaponError = null;
  let matchedName = null;
  let rivenDataModule = null;
  let rivenDataPayload = null;
  try {
    rivenDataModule = getRivenDataModule();
    // getRivenData() is what actually loads the grade sheet and weapon list;
    // getCachedRivenData() only reads the cache it fills. Calling the getter alone
    // left the cache null, so every lookup failed and nothing could be graded.
    // It is TTL-cached, so repeat scans re-fetch at most once per interval.
    rivenDataPayload = await rivenDataModule.getRivenData();
    const match = matchRivenWeapon(rivenDataModule, rivenDataPayload, parsed);
    weapon = match.weapon;
    matchedName = match.matchedName;
    weaponError = match.error;
  } catch (err) {
    weaponError = 'Could not load weapon data: ' + (err && err.message ? err.message : 'unknown error');
  }

  let grade = null;
  if (weapon) {
    try {
      grade = getRivenDataModule().gradeRiven(weapon, parsed.stats);
    } catch (err) {
      weaponError = 'Grading failed: ' + (err && err.message ? err.message : 'unknown error');
    }
  }

  if (!grade) {
    return Object.assign({}, base, {
      success: false,
      parsed: parsed,
      error: 'Reroll was read (' + parsed.stats.length + ' stats) but could not be graded. ' +
        (weaponError || 'No reason recorded.')
    });
  }

  const result = Object.assign({}, base, {
    success: true,
    parsed: parsed,
    grade: grade,
    // The roll this one is replacing, for the before/after view. Filled in below
    // from the left card of the same frame, or from the last roll graded in this
    // session. Only set when it is the same weapon, so switching weapons in the
    // mods screen does not present an unrelated riven as "your previous roll".
    previousRoll: null,
    // Per-stat good/poor verdicts, resolved from the community sheet.
    statVerdicts: [],
    // Surfaced rather than swallowed: an unresolved stat name usually means the
    // game added an attribute and riven-data.js has not caught up.
    unresolvedStats: parsed.unresolvedStats,
    // Only reachable with a maximal stat set, where the extra line cannot be a
    // riven stat. Still worth telling the user about.
    partial: parsed.unresolvedStats.length > 0,
    partialCaveat: parsed.unresolvedStats.length > 0
      ? 'Graded from the ' + parsed.stats.length + ' recognised stats. Also saw ' +
        parsed.unresolvedStats.map((s) => s.name).join(', ') + ', which cannot be part of a riven ' +
        'that already has its maximum ' + RIVEN_MAX_BONUSES + ' bonuses and ' + RIVEN_MAX_CURSES + ' curse.'
      : ''
  });

  // The roll this one replaces, and the per-stat verdicts, are worked out for
  // every read: the watch loop shows them over the game. Only the save is skipped
  // there, because it grades on every flip between the cards.
  try {
    const summary = buildRivenRollSummary(parsed, grade);
    const key = rivenRollKey(parsed.weaponName);
    result.statVerdicts = describeRivenStatVerdicts(weapon, parsed.stats);
    // A tier per stat, so the player can see which stat is carrying the roll and
    // which is dead weight, rather than one number for the whole riven.
    try {
      result.statTiers = getRivenDataModule().rivenStatTiers(weapon, parsed.stats) || [];
    } catch (err) {
      result.statTiers = [];
    }

    // The roll this one replaces, read from the left card of the same frame when
    // that read is sound, and otherwise the last one graded in this session. Only
    // set for the same weapon, so switching weapons in the mods screen does not
    // present an unrelated riven as "your previous roll".
    const fromScreen = summarizeRivenSideCard(success.previousText, rivenDataModule, rivenDataPayload, parsed);
    if (fromScreen) {
      result.previousRoll = fromScreen;
    } else if (rivenLastRoll && rivenLastRoll.key === key) {
      result.previousRoll = rivenLastRoll.summary;
    }
    rivenLastRoll = { key: key, summary: summary };

    // Saved to the inventory so the riven is still there once the reroll screen is
    // gone. A failure here must not lose the grade that was just computed.
    if (!shouldFile) return result;

    const saved = await addRivenToInventory({
      weaponName: parsed.weaponName,
      rivenName: parsed.rivenName,
      stats: parsed.stats,
      grade: grade,
      disposition: weapon && weapon.disposition != null ? weapon.disposition : null,
      reqMasteryRank: weapon && weapon.reqMasteryRank != null ? weapon.reqMasteryRank : null,
      rivenType: weapon && weapon.rivenType ? weapon.rivenType : null,
      icon: weapon && weapon.icon ? weapon.icon : '',
      statVerdicts: describeRivenStatVerdicts(weapon, parsed.stats)
    });
    if (saved) result.inventory = { id: saved.entry.id, created: saved.created };
  } catch (err) {
    result.inventoryError = 'Graded, but the riven could not be added to the Rivens tab.';
  }

  return result;
}

async function runRivenScanBurst() {
  rivenOverlayScanAttempts = 0;
  let lastDiag = null;
  let success = null;

  // Something on screen the moment the reroll is seen, so the overlay is visibly
  // alive while the capture and OCR run. Without it the first sign of life is the
  // finished card, which arrives a second or two later or not at all.
  showRivenOverlay({ pending: true }).catch(() => {});

  while (rivenOverlayEnabled) {
    // A scan is already running: wait for it instead of burning an attempt on a no-op.
    if (rivenOverlayScanning) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      continue;
    }
    // Always allow one real attempt, even if the burst window elapsed while waiting.
    if (rivenOverlayScanAttempts > 0 &&
        (rivenOverlayScanAttempts >= RIVEN_OVERLAY_MAX_SCAN_ATTEMPTS || Date.now() >= rivenOverlayBurstUntil)) break;

    rivenOverlayScanAttempts += 1;
    const result = await scanRivenOverlayOnce();
    if (!result) continue;
    if (result.diag) lastDiag = result.diag;

    if (result.ok) {
      success = result;
      break;
    }

    if (rivenOverlayScanAttempts < RIVEN_OVERLAY_MAX_SCAN_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, RIVEN_OVERLAY_SCAN_DELAY_MS));
    }
  }

  if (!rivenOverlayEnabled) return;

  if (success) {
    const graded = await gradeRivenScan(success);
    sendRivenScanResult(graded);
    // The player is looking at the game, not at this app, so the same result goes
    // on top of the game. A failure here is not the scan's failure: the grade has
    // already been computed and filed either way.
    showRivenOverlay(graded, success.displayBounds ? findDisplayById(success.displayId) : null).catch(() => {});
    return;
  }

  sendRivenScanResult({
    success: false,
    stage: 'ocr',
    error: 'Reroll detected, but grading failed. ' + describeRivenScanFailure(lastDiag),
    diag: lastDiag
  });
  // Say so over the game too, otherwise a failed read looks exactly like a
  // missing feature.
  showRivenOverlay({
    success: false,
    error: 'Could not read this reroll. ' + describeRivenScanFailure(lastDiag)
  }).catch(() => {});
}

function triggerRivenScan(reason) {
  if (!rivenOverlayEnabled) return;
  rivenOverlayBurstUntil = Date.now() + RIVEN_OVERLAY_SCAN_BURST_WINDOW_MS;
  rivenOverlayLastHash = '';
  rivenOverlayLastHashAt = 0;

  if (rivenOverlayScanTimer) {
    clearTimeout(rivenOverlayScanTimer);
    rivenOverlayScanTimer = null;
  }

  rivenOverlayScanTimer = setTimeout(() => {
    rivenOverlayScanTimer = null;
    runRivenScanBurst().catch(() => {});
  }, RIVEN_OVERLAY_FIRST_SCAN_DELAY_MS);
}

function resetRivenOverlayBurst() {
  rivenOverlayBurstUntil = 0;
  rivenOverlayScanAttempts = 0;
  rivenOverlayLastHash = '';
  rivenOverlayLastHashAt = 0;
  if (rivenOverlayScanTimer) {
    clearTimeout(rivenOverlayScanTimer);
    rivenOverlayScanTimer = null;
  }
}

async function pollRivenOverlayLog() {
  if (!rivenOverlayEnabled) return;

  try {
    const logInfo = await findWarframeLog();
    if (!logInfo || !logInfo.path) {
      if (!rivenOverlayLogMissingNotified) {
        rivenOverlayLogMissingNotified = true;
        sendRivenOverlayEvent('status', {
          enabled: true,
          message: 'EE.log not found. Riven grading will not trigger until Warframe has run once.'
        });
      }
      return;
    }

    const currentPath = path.normalize(logInfo.path);
    if (currentPath !== rivenOverlayLogPath) {
      /* First sight of this log: start a little way back rather than at the very end.
       *
       * It used to seek straight to the end of the file, which meant the watcher could
       * only ever see lines written after the app started. The reroll prompt the overlay
       * triggers on was already sitting in the log - twice - and was skipped, so
       * enabling riven grading appeared to do nothing at all and lastScanAt stayed at 0
       * until the player happened to roll a new one.
       *
       * The tail is bounded so a 300 MB log does not get read on startup. It is read from
       * the end because the trigger is the last thing that happened, and a match this
       * old is harmless: the scan that follows reads the screen, not the log. */
      rivenOverlayLogPath = currentPath;
      rivenOverlayLogOffset = Math.max(0, logInfo.size - RIVEN_OVERLAY_LOG_TAIL_BYTES);
      rivenOverlayLogMissingNotified = false;
    }

    if (logInfo.size < rivenOverlayLogOffset) {
      rivenOverlayLogOffset = 0;
    }

    if (logInfo.size <= rivenOverlayLogOffset) return;

    const start = Math.max(rivenOverlayLogOffset, logInfo.size - RIVEN_OVERLAY_LOG_TAIL_BYTES);
    const chunk = await readLogChunk(currentPath, start, logInfo.size, RIVEN_OVERLAY_LOG_TAIL_BYTES);
    rivenOverlayLogOffset = logInfo.size;

    /* Which dialog means the cards are on screen.
     *
     * The cost prompt ("Are you sure you want to cycle X for Y?") is written before
     * the player has even answered, and the roll does not exist yet — triggering on
     * it meant the whole burst ran and expired against a dialog box. In the log of a
     * real reroll the two are 300+ seconds apart:
     *
     *   429.474  Are you sure you want to cycle Multron Decido for 900?
     *   431.551  Dialog::SendResult(4)          <- the player pressed Yes
     *   749.300  Cycle Riven into current selection?   <- the new roll is on screen
     *
     * So the choice prompt is the trigger. It is also the one with a short fuse: the
     * player answered 1.5s after it appeared, which is why the first attempt waits
     * 200ms rather than half a second. */
    if (isRivenRerollChoiceLogText(chunk)) {
      triggerRivenScan('Riven rolled. Reading stats...');
      // The screen stays open while the player decides, and they flip between the
      // old riven and the new one. Following that is the difference between an
      // overlay and a notification.
      startRivenOverlayWatch();
      return;
    }

    if (isRivenRerollConfirmLogText(chunk) || isRivenRerollScreenLogText(chunk)) {
      resetRivenOverlayBurst();
    }
  } catch (err) {
    if (!rivenOverlayLogMissingNotified) {
      rivenOverlayLogMissingNotified = true;
      sendRivenOverlayEvent('status', {
        enabled: true,
        message: 'Could not read EE.log, riven grading is paused.'
      });
    }
  }
}

async function startRivenOverlayLogWatcher() {
  if (rivenOverlayLogTimer) {
    clearInterval(rivenOverlayLogTimer);
    rivenOverlayLogTimer = null;
  }

  rivenOverlayLogPath = '';
  rivenOverlayLogOffset = 0;
  rivenOverlayLogMissingNotified = false;
  await pollRivenOverlayLog();
  rivenOverlayLogTimer = setInterval(() => {
    pollRivenOverlayLog().catch(() => {});
  }, RIVEN_OVERLAY_LOG_POLL_INTERVAL_MS);
}

function stopRivenOverlayLogWatcher() {
  if (rivenOverlayLogTimer) {
    clearInterval(rivenOverlayLogTimer);
    rivenOverlayLogTimer = null;
  }
  rivenOverlayLogPath = '';
  rivenOverlayLogOffset = 0;
  rivenOverlayLogMissingNotified = false;
  resetRivenOverlayBurst();
}

async function startRivenOverlayLoop() {
  await startRivenOverlayLogWatcher();
}

async function stopRivenOverlayLoop() {
  rivenOverlayEnabled = false;
  stopRivenOverlayWatch();
  stopRivenOverlayLogWatcher();
  if (rivenOverlayWindow && !rivenOverlayWindow.isDestroyed()) {
    rivenOverlayWindow.close();
    rivenOverlayWindow = null;
  }
  if (rivenOverlayHideTimer) {
    clearTimeout(rivenOverlayHideTimer);
    rivenOverlayHideTimer = null;
  }
}

function execFileAsync(command, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(command, args || [], { timeout: timeoutMs || 5000, windowsHide: true }, (error, stdout) => {
      resolve({
        ok: !error,
        stdout: String(stdout || ''),
        message: error && error.message ? error.message : ''
      });
    });
  });
}

function parseTasklistCsv(output) {
  return String(output || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      var firstCell = line.match(/^"([^"]+)"/);
      return firstCell ? firstCell[1] : line.split(',')[0];
    })
    .filter((name) => /\.exe$/i.test(name));
}

async function detectWarframeProcess() {
  if (process.platform === 'win32') {
    for (const processName of WARFRAME_PROCESS_NAMES) {
      const result = await execFileAsync('tasklist.exe', ['/FI', `IMAGENAME eq ${processName}`, '/FO', 'CSV', '/NH'], 5000);
      const matches = parseTasklistCsv(result.stdout);
      if (matches.some((name) => name.toLowerCase() === processName.toLowerCase())) {
        return { running: true, name: processName };
      }
    }

    return { running: false, name: '' };
  }

  const result = await execFileAsync('ps', ['-A', '-o', 'comm='], 5000);
  const processNames = String(result.stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const match = processNames.find((name) => /^Warframe/i.test(path.basename(name)));
  return match ? { running: true, name: match } : { running: false, name: '' };
}

function uniquePaths(paths) {
  const seen = new Set();
  const output = [];
  for (const candidate of paths) {
    if (!candidate) continue;
    const normalized = path.normalize(candidate);
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(normalized);
  }
  return output;
}

function getDefaultWarframeLogPath() {
  const homeDir = app.getPath('home');

  if (process.platform === 'win32') {
    if (process.env.LOCALAPPDATA) {
      return path.join(process.env.LOCALAPPDATA, 'Warframe', 'EE.log');
    }
    return path.join(homeDir, 'AppData', 'Local', 'Warframe', 'EE.log');
  }

  if (process.platform === 'darwin') {
    return path.join(homeDir, 'Library', 'Application Support', 'CrossOver', 'Bottles', 'Warframe', 'drive_c', 'users', 'crossover', 'AppData', 'Local', 'Warframe', 'EE.log');
  }

  return path.join(homeDir, '.steam', 'steam', 'steamapps', 'compatdata', '230410', 'pfx', 'drive_c', 'users', 'steamuser', 'AppData', 'Local', 'Warframe', 'EE.log');
}

function getWarframeLogCandidates() {
  const candidates = [getDefaultWarframeLogPath()];
  const homeDir = app.getPath('home');

  if (process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, 'Warframe', 'EE.log'));
  }

  if (homeDir) {
    candidates.push(path.join(homeDir, 'AppData', 'Local', 'Warframe', 'EE.log'));
    candidates.push(path.join(homeDir, '.steam', 'steam', 'steamapps', 'compatdata', '230410', 'pfx', 'drive_c', 'users', 'steamuser', 'AppData', 'Local', 'Warframe', 'EE.log'));
    candidates.push(path.join(homeDir, '.local', 'share', 'Steam', 'steamapps', 'compatdata', '230410', 'pfx', 'drive_c', 'users', 'steamuser', 'AppData', 'Local', 'Warframe', 'EE.log'));
    candidates.push(path.join(homeDir, 'Library', 'Application Support', 'CrossOver', 'Bottles', 'Warframe', 'drive_c', 'users', 'crossover', 'AppData', 'Local', 'Warframe', 'EE.log'));
  }

  return uniquePaths(candidates);
}

function getProfileLogConfigPath() {
  return path.join(app.getPath('userData'), PROFILE_LOG_CONFIG_FILE);
}

function getProfileCachePath() {
  return path.join(app.getPath('userData'), PROFILE_CACHE_FILE);
}

async function readJsonFile(filePath, fallbackValue) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : fallbackValue;
  } catch (err) {
    return fallbackValue;
  }
}

async function writeJsonFile(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function normalizeConfiguredLogPath(value) {
  const rawPath = String(value || '').trim();
  return rawPath ? path.normalize(rawPath) : '';
}

async function readProfileLogConfig() {
  const config = await readJsonFile(getProfileLogConfigPath(), {});
  return {
    customPath: normalizeConfiguredLogPath(config && config.customPath)
  };
}

async function getConfiguredWarframeLogPath() {
  const config = await readProfileLogConfig();
  return config.customPath || '';
}

async function setConfiguredWarframeLogPath(filePath) {
  const customPath = normalizeConfiguredLogPath(filePath);
  if (!customPath) {
    throw new Error('No EE.log path was selected.');
  }

  const stat = await fs.stat(customPath);
  if (!stat.isFile()) {
    throw new Error('Selected path is not a file.');
  }

  await writeJsonFile(getProfileLogConfigPath(), {
    customPath,
    updatedAt: Date.now()
  });
  return getWarframeLogConfigSummary();
}

async function clearConfiguredWarframeLogPath() {
  try {
    await fs.unlink(getProfileLogConfigPath());
  } catch (err) {
    if (!err || err.code !== 'ENOENT') throw err;
  }
  return getWarframeLogConfigSummary();
}

async function pathExistsAsFile(filePath) {
  if (!filePath) return false;
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch (err) {
    return false;
  }
}

async function getWarframeLogConfigSummary() {
  const defaultPath = getDefaultWarframeLogPath();
  const configuredPath = await getConfiguredWarframeLogPath();
  const activePath = configuredPath || defaultPath;

  return {
    ok: true,
    defaultPath,
    configuredPath,
    activePath,
    usingCustomPath: !!configuredPath,
    exists: await pathExistsAsFile(activePath)
  };
}

async function findWarframeLog() {
  const configuredPath = await getConfiguredWarframeLogPath();
  const candidates = configuredPath ? [configuredPath] : getWarframeLogCandidates();
  const found = [];

  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (!stat.isFile()) continue;
      found.push({ path: candidate, mtimeMs: stat.mtimeMs, size: stat.size });
    } catch (err) {
      // Missing candidates are expected on machines without Warframe installed in that location.
    }
  }

  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return found[0] || null;
}

async function readWarframeLogText(logInfo) {
  const maxWholeFileBytes = 32 * 1024 * 1024;
  const edgeBytes = 8 * 1024 * 1024;
  const filePath = logInfo && logInfo.path ? logInfo.path : '';
  if (!filePath) return '';

  if (logInfo.size <= maxWholeFileBytes) {
    return fs.readFile(filePath, 'utf8');
  }

  const handle = await fs.open(filePath, 'r');
  try {
    const head = Buffer.alloc(edgeBytes);
    const tail = Buffer.alloc(edgeBytes);
    await handle.read(head, 0, edgeBytes, 0);
    await handle.read(tail, 0, edgeBytes, Math.max(0, logInfo.size - edgeBytes));
    return head.toString('utf8') + '\n' + tail.toString('utf8');
  } finally {
    await handle.close();
  }
}

function collectRegexMatches(text, regex) {
  const matches = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    if (match[1]) matches.push(String(match[1]).trim());
  }
  return matches;
}

function extractAccountIdFromLog(text) {
  const idPattern = '([a-f0-9]{16,32}|[0-9]{8,})';
  const patterns = [
    new RegExp('AccountId:\\s*' + idPattern, 'gi'),
    new RegExp('Logged in[^\\r\\n]*\\(' + idPattern + '\\)', 'gi'),
    new RegExp('playerId\\s*[=:]\\s*' + idPattern, 'gi'),
    new RegExp('account(?:\\s*id)?\\s*[=:]\\s*' + idPattern, 'gi')
  ];
  const matches = [];

  for (const pattern of patterns) {
    matches.push(...collectRegexMatches(text, pattern));
  }

  const validMatches = matches.filter((value) => value && !/^0+$/.test(value));
  return validMatches.length > 0 ? validMatches[validMatches.length - 1] : '';
}

function extractDisplayNameFromLog(text) {
  const names = collectRegexMatches(text, /Player name changed to\s+(.+?)(?:\s+Clan:|\r?\n|$)/gi)
    .map((name) => name.replace(/\s+AccountId:.*$/i, '').trim())
    .filter(Boolean);
  return names.length > 0 ? names[names.length - 1] : '';
}

function normalizeProfileXpEntry(rawEntry, source) {
  if (!rawEntry || typeof rawEntry !== 'object') return null;
  const itemType = String(rawEntry.ItemType || rawEntry.itemType || rawEntry.type || rawEntry.uniqueName || '').trim();
  if (!itemType) return null;

  const rawXp = rawEntry.XP ?? rawEntry.xp ?? rawEntry.Experience ?? rawEntry.experience ?? 0;
  const xp = Number(rawXp);

  return {
    itemType,
    xp: Number.isFinite(xp) ? xp : 0,
    source: source || 'profile'
  };
}

function mergeProfileXpEntry(entry, map) {
  if (!entry || !entry.itemType) return;
  const key = entry.itemType.toLowerCase();
  const existing = map.get(key);
  if (!existing || entry.xp > existing.xp) {
    map.set(key, entry);
  }
}

function collectNamedArrayEntries(root, keyName, map, source, depth) {
  if (!root || depth > 8) return;

  if (Array.isArray(root)) {
    for (const entry of root) {
      collectNamedArrayEntries(entry, keyName, map, source, depth + 1);
    }
    return;
  }

  if (typeof root !== 'object') return;

  for (const [key, value] of Object.entries(root)) {
    if (String(key).toLowerCase() === String(keyName).toLowerCase() && Array.isArray(value)) {
      for (const entry of value) {
        mergeProfileXpEntry(normalizeProfileXpEntry(entry, source), map);
      }
      continue;
    }
    collectNamedArrayEntries(value, keyName, map, source, depth + 1);
  }
}

function collectProfileStatsWeaponEntries(profileData, map) {
  const stats = profileData && typeof profileData === 'object' ? (profileData.Stats || profileData.stats) : null;
  if (!stats || typeof stats !== 'object') return;

  const weaponLists = [
    stats.Weapons,
    stats.weapons
  ].filter(Array.isArray);

  for (const weapons of weaponLists) {
    for (const entry of weapons) {
      mergeProfileXpEntry(normalizeProfileXpEntry(entry, 'statsWeapons'), map);
    }
  }
}

function collectInlineProfileXpEntries(root, map, depth) {
  if (!root || depth > 10) return;

  if (Array.isArray(root)) {
    for (const entry of root) {
      collectInlineProfileXpEntries(entry, map, depth + 1);
    }
    return;
  }

  if (typeof root !== 'object') return;

  const itemType = root.ItemType || root.itemType || root.uniqueName || root.UniqueName || root.TypeName || root.typeName;
  const xp = root.XP ?? root.xp ?? root.Experience ?? root.experience;
  if (itemType && xp !== undefined) {
    mergeProfileXpEntry(normalizeProfileXpEntry({
      ItemType: itemType,
      XP: xp
    }, 'inlineProfileXp'), map);
  }

  for (const value of Object.values(root)) {
    collectInlineProfileXpEntries(value, map, depth + 1);
  }
}

function extractProfileXpEntries(profileData) {
  const map = new Map();
  collectNamedArrayEntries(profileData, 'XPInfo', map, 'xpInfo', 0);
  collectProfileStatsWeaponEntries(profileData, map);
  collectInlineProfileXpEntries(profileData, map, 0);
  return Array.from(map.values()).sort((a, b) => a.itemType.localeCompare(b.itemType));
}

function toProfileExtraLookupKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/['`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function getProfileMasteryExtraKey(itemType) {
  const key = toProfileExtraLookupKey(itemType);
  if (!key) return '';
  const looksLikeXpField = key.includes('xp') || key.includes('experience') || key.includes('mastery');
  if (!looksLikeXpField && (key.includes('completed') || key.includes('cleared') || key.includes('count'))) return '';

  if ((key.includes('steel') && (key.includes('mission') || key.includes('star chart') || key.includes('node'))) || key.includes('steel path')) return 'steelPathXp';
  if ((key.includes('hard mode') || key.includes('hardmode')) && (key.includes('mission') || key.includes('node'))) return 'steelPathXp';
  if ((key.includes('mission') || key.includes('star chart') || key.includes('starchart') || key.includes('node')) && !key.includes('steel') && !key.includes('hardmode') && !key.includes('hard mode')) return 'normalStarChartXp';
  if ((key.includes('railjack') || key.includes('rail jack') || key.includes('crewship')) && (key.includes('intrinsic') || key.includes('skill') || looksLikeXpField)) return 'railjackRanks';
  if ((key.includes('duviri') || key.includes('drifter')) && (key.includes('intrinsic') || key.includes('skill') || looksLikeXpField)) return 'duviriRanks';
  return '';
}

function recordProfileMasteryExtra(extras, found, key, value, isRankValue) {
  if (!key) return;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return;

  found.add(key);
  if (key === 'railjackRanks' || key === 'duviriRanks') {
    const ranks = isRankValue ? numeric : Math.floor(numeric / PROFILE_INTRINSIC_RANK_XP);
    extras[key] = Math.max(extras[key], Math.floor(ranks));
  } else if (key === 'normalStarChartXp') {
    extras[key] = Math.max(extras[key], Math.min(Math.floor(numeric), PROFILE_NORMAL_STAR_CHART_XP_MAX));
  } else if (key === 'steelPathXp') {
    extras[key] = Math.max(extras[key], Math.min(Math.floor(numeric), PROFILE_STEEL_PATH_XP_MAX));
  } else {
    extras[key] = Math.max(extras[key], Math.floor(numeric));
  }
}

async function fetchRegionMasteryMap() {
  if (regionMasteryCache && Date.now() - regionMasteryCacheFetchedAt < REGION_MASTERY_CACHE_TTL_MS) {
    return regionMasteryCache;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROFILE_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(EXPORT_REGIONS_URL, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Warframe Companion App'
      }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const regions = await response.json();
    const masteryMap = new Map();
    for (const [tag, region] of Object.entries(regions || {})) {
      const rawXp = Number(region && region.masteryExp);
      const missionType = String(region && region.missionType ? region.missionType : '');
      masteryMap.set(String(tag), {
        masteryExp: Number.isFinite(rawXp) && rawXp > 0 ? Math.floor(rawXp) : 0,
        missionType
      });
    }

    regionMasteryCache = masteryMap;
    regionMasteryCacheFetchedAt = Date.now();
    return masteryMap;
  } finally {
    clearTimeout(timeout);
  }
}

function getPrimaryProfileResult(profileData) {
  return Array.isArray(profileData && profileData.Results) ? profileData.Results[0] : null;
}

function getProfileMissionMasteryValue(mission, regionInfo) {
  if (!mission || Number(mission.Completes || mission.completes || 0) <= 0) return 0;

  const tag = String(mission.Tag || mission.tag || '');
  const missionType = String(regionInfo && regionInfo.missionType ? regionInfo.missionType : '');
  const isJunction = /junction/i.test(tag) || missionType === 'MT_JUNCTION';
  const baseXp = Number(regionInfo && regionInfo.masteryExp);
  return (Number.isFinite(baseXp) && baseXp > 0 ? Math.floor(baseXp) : 0) + (isJunction ? JUNCTION_MASTERY_XP : 0);
}

async function applyProfileMissionMasteryExtras(profileData, extras, found) {
  const profile = getPrimaryProfileResult(profileData);
  const missions = Array.isArray(profile && profile.Missions) ? profile.Missions : [];
  if (missions.length === 0) return;

  let masteryMap;
  try {
    masteryMap = await fetchRegionMasteryMap();
  } catch (err) {
    return;
  }

  let normalStarChartXp = 0;
  let steelPathXp = 0;

  for (const mission of missions) {
    const tag = String(mission && (mission.Tag || mission.tag) ? (mission.Tag || mission.tag) : '');
    const regionInfo = masteryMap.get(tag) || null;
    const missionXp = getProfileMissionMasteryValue(mission, regionInfo);
    if (missionXp <= 0) continue;

    normalStarChartXp += missionXp;
    if (Number(mission.Tier || mission.tier || 0) >= 1) {
      steelPathXp += missionXp;
    }
  }

  recordProfileMasteryExtra(extras, found, 'normalStarChartXp', normalStarChartXp, false);
  recordProfileMasteryExtra(extras, found, 'steelPathXp', steelPathXp, false);
}

function applyProfileSkillMasteryExtras(profileData, extras, found) {
  const profile = getPrimaryProfileResult(profileData);
  const skills = profile && profile.PlayerSkills && typeof profile.PlayerSkills === 'object'
    ? profile.PlayerSkills
    : null;
  if (!skills) return;

  const railjackSkillKeys = [
    'LPS_COMMAND',
    'LPS_ENGINEERING',
    'LPS_GUNNERY',
    'LPS_PILOTING',
    'LPS_TACTICAL'
  ];
  const duviriSkillKeys = [
    'LPS_DRIFT_RIDING',
    'LPS_DRIFT_COMBAT',
    'LPS_DRIFT_ENDURANCE',
    'LPS_DRIFT_OPPORTUNITY'
  ];

  const railjackRanks = railjackSkillKeys.reduce((sum, key) => sum + Math.max(0, Math.floor(Number(skills[key]) || 0)), 0);
  const duviriRanks = duviriSkillKeys.reduce((sum, key) => sum + Math.max(0, Math.floor(Number(skills[key]) || 0)), 0);

  recordProfileMasteryExtra(extras, found, 'railjackRanks', railjackRanks, true);
  recordProfileMasteryExtra(extras, found, 'duviriRanks', duviriRanks, true);
}

function collectProfileMasteryExtras(root, extras, found, depth) {
  if (!root || depth > 10) return;

  if (Array.isArray(root)) {
    for (const entry of root) {
      collectProfileMasteryExtras(entry, extras, found, depth + 1);
    }
    return;
  }

  if (typeof root !== 'object') return;

  const label = root.ItemType || root.itemType || root.type || root.Name || root.name || root.Label || root.label || root.title || '';
  const labelKey = getProfileMasteryExtraKey(label);
  if (labelKey) {
    const xpValue = root.XP ?? root.xp ?? root.Experience ?? root.experience ?? root.Mastery ?? root.mastery;
    recordProfileMasteryExtra(extras, found, labelKey, xpValue, false);
  }

  for (const [rawKey, value] of Object.entries(root)) {
    const key = String(rawKey || '');
    const extraKey = getProfileMasteryExtraKey(key);
    if (extraKey && typeof value !== 'object') {
      const lookupKey = toProfileExtraLookupKey(key);
      const isRankValue = lookupKey.includes('rank') || lookupKey.includes('level');
      recordProfileMasteryExtra(extras, found, extraKey, value, isRankValue);
    }
    collectProfileMasteryExtras(value, extras, found, depth + 1);
  }
}

async function extractProfileMasteryExtras(profileData, xpInfo) {
  const extras = {
    normalStarChartXp: 0,
    steelPathXp: 0,
    railjackRanks: 0,
    duviriRanks: 0,
    foundKeys: []
  };
  const found = new Set();

  for (const entry of Array.isArray(xpInfo) ? xpInfo : []) {
    const key = getProfileMasteryExtraKey(entry && entry.itemType);
    recordProfileMasteryExtra(extras, found, key, entry && entry.xp, false);
  }
  collectProfileMasteryExtras(profileData, extras, found, 0);
  await applyProfileMissionMasteryExtras(profileData, extras, found);
  applyProfileSkillMasteryExtras(profileData, extras, found);

  extras.foundKeys = Array.from(found);
  return extras;
}

function extractProfileSummary(profileData, fallbackDisplayName) {
  const profile = getPrimaryProfileResult(profileData);
  return {
    displayName: String((profile && profile.DisplayName) || fallbackDisplayName || '').trim(),
    masteryRank: Number.isFinite(Number(profile && profile.PlayerLevel)) ? Number(profile.PlayerLevel) : null
  };
}

function getProfileAccountCacheKey(accountId) {
  return crypto.createHash('sha256').update(String(accountId || '')).digest('hex');
}

async function readProfileCacheState() {
  const state = await readJsonFile(getProfileCachePath(), { entries: {} });
  if (!state.entries || typeof state.entries !== 'object') {
    state.entries = {};
  }
  return state;
}

async function writeProfileCacheState(state) {
  await writeJsonFile(getProfileCachePath(), Object.assign({ entries: {} }, state || {}));
}

async function getProfileCacheEntry(accountId) {
  const key = getProfileAccountCacheKey(accountId);
  if (!key) return null;
  const state = await readProfileCacheState();
  return state.entries[key] || null;
}

function createCacheableProfileResult(result) {
  const cached = Object.assign({}, result || {});
  delete cached.process;
  delete cached.logPath;
  delete cached.logUpdatedAt;
  delete cached.endpoint;
  delete cached.cacheControl;
  delete cached.expires;
  delete cached.cached;
  delete cached.cacheAgeMs;
  return cached;
}

async function updateProfileCacheEntry(accountId, patch) {
  const key = getProfileAccountCacheKey(accountId);
  if (!key) return;
  const state = await readProfileCacheState();
  const previous = state.entries[key] || {};
  state.entries[key] = Object.assign({}, previous, patch || {}, {
    accountHash: key,
    updatedAt: Date.now()
  });
  await writeProfileCacheState(state);
}

async function saveProfileCacheAttempt(accountId, attemptedAt) {
  await updateProfileCacheEntry(accountId, {
    lastAttemptAt: attemptedAt || Date.now()
  });
}

async function saveProfileCacheFailure(accountId, failedAt, message) {
  await updateProfileCacheEntry(accountId, {
    lastAttemptAt: failedAt || Date.now(),
    lastError: String(message || 'Profile fetch failed.')
  });
}

async function saveProfileCacheResult(accountId, result) {
  const fetchedAt = Number(result && result.fetchedAt) || Date.now();
  await updateProfileCacheEntry(accountId, {
    fetchedAt,
    lastAttemptAt: fetchedAt,
    lastError: '',
    result: createCacheableProfileResult(result)
  });
}

function formatCooldownMs(ms) {
  const totalMinutes = Math.max(1, Math.ceil(Number(ms || 0) / 60000));
  if (totalMinutes < 60) return totalMinutes + ' minute' + (totalMinutes === 1 ? '' : 's');
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours + ' hour' + (hours === 1 ? '' : 's') + (minutes ? ' ' + minutes + ' minute' + (minutes === 1 ? '' : 's') : '');
}

async function fetchProfileJson(accountId, platform) {
  const encodedId = encodeURIComponent(accountId);
  let sub = 'api';
  if (platform) {
    const p = String(platform).trim().toLowerCase();
    if (p === 'ps4' || p === 'playstation') sub = 'api-ps4';
    else if (p === 'xb1' || p === 'xbox') sub = 'api-xb1';
    else if (p === 'swi' || p === 'switch' || p === 'nintendo switch') sub = 'api-swi';
    else if (p === 'mob' || p === 'mobile' || p === 'ios' || p === 'android') sub = 'api-mob';
  }
  const endpoint = `https://${sub}.warframe.com/cdn/getProfileViewingData.php?playerId=${encodedId}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROFILE_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(endpoint, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Warframe Companion App'
      }
    });
    const text = await response.text();

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        message: response.status === 429
          ? 'Warframe rejected the profile request because too many requests were made. Wait before trying again.'
          : `${response.status} ${response.statusText || 'profile request failed'}`
      };
    }

    let json;
    try {
      json = JSON.parse(text);
    } catch (err) {
      return {
        ok: false,
        message: 'Profile endpoint returned non-JSON data.'
      };
    }

    return {
      ok: true,
      data: json,
      endpoint,
      cacheControl: response.headers.get('cache-control') || '',
      expires: response.headers.get('expires') || ''
    };
  } catch (err) {
    return {
      ok: false,
      message: err && err.name === 'AbortError' ? 'Profile request timed out.' : (err && err.message ? err.message : 'Profile request failed.')
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchWarframeProfileFromLog(manualAccountId, platform) {
  let accountId = manualAccountId ? String(manualAccountId).trim() : '';
  let fallbackDisplayName = '';
  let logInfo = null;
  let processInfo = { running: false };

  if (!accountId) {
    processInfo = await detectWarframeProcess();
    if (!processInfo.running) {
      return {
        ok: false,
        reason: 'process-not-running',
        process: processInfo,
        message: 'Open Warframe and log in. The app will detect the process before fetching your profile.'
      };
    }

    logInfo = await findWarframeLog();
    if (!logInfo) {
      return {
        ok: false,
        reason: 'log-not-found',
        process: processInfo,
        message: 'Warframe is running, but EE.log was not found in the usual local Warframe folder.'
      };
    }

    const logText = await readWarframeLogText(logInfo);
    accountId = extractAccountIdFromLog(logText);
    fallbackDisplayName = extractDisplayNameFromLog(logText);

    if (!accountId) {
      return {
        ok: false,
        reason: 'account-id-not-found',
        process: processInfo,
        logPath: logInfo.path,
        logUpdatedAt: logInfo.mtimeMs,
        message: 'Warframe was detected, but the account id is not in EE.log yet. Log in fully, then enter and leave a Relay or Dojo to refresh profile data.'
      };
    }
  } else {
    processInfo = await detectWarframeProcess();
    logInfo = await findWarframeLog();
  }

  const now = Date.now();
  const cacheEntry = await getProfileCacheEntry(accountId);
  const cachedFetchedAt = Number(cacheEntry && cacheEntry.fetchedAt) || 0;
  const cacheAgeMs = cachedFetchedAt ? now - cachedFetchedAt : Infinity;

  if (cacheEntry && cacheEntry.result && cachedFetchedAt && cacheAgeMs < PROFILE_REMOTE_FETCH_COOLDOWN_MS) {
    return Object.assign({}, cacheEntry.result, {
      ok: true,
      process: processInfo,
      logPath: logInfo ? logInfo.path : '',
      logUpdatedAt: logInfo ? logInfo.mtimeMs : 0,
      cached: true,
      cacheAgeMs,
      fetchedAt: cachedFetchedAt,
      message: 'Using locally cached Warframe profile data to avoid repeated requests.'
    });
  }

  const lastAttemptAt = Number(cacheEntry && cacheEntry.lastAttemptAt) || 0;
  const retryAgeMs = lastAttemptAt ? now - lastAttemptAt : Infinity;
  const lastAttemptWasFailed = lastAttemptAt && (!cachedFetchedAt || lastAttemptAt > cachedFetchedAt);
  if (lastAttemptWasFailed && retryAgeMs < PROFILE_REMOTE_RETRY_COOLDOWN_MS) {
    const remainingMs = PROFILE_REMOTE_RETRY_COOLDOWN_MS - retryAgeMs;
    return {
      ok: false,
      reason: 'profile-cooldown',
      process: processInfo,
      logPath: logInfo ? logInfo.path : '',
      logUpdatedAt: logInfo ? logInfo.mtimeMs : 0,
      cooldownMs: remainingMs,
      message: 'Profile fetch is cooling down for about ' + formatCooldownMs(remainingMs) + ' to protect you from Warframe rate limits.'
    };
  }

  await saveProfileCacheAttempt(accountId, now);

  const profileResponse = await fetchProfileJson(accountId, platform);
  if (!profileResponse.ok) {
    await saveProfileCacheFailure(accountId, now, profileResponse.message);
    return {
      ok: false,
      reason: 'profile-fetch-failed',
      process: processInfo,
      logPath: logInfo ? logInfo.path : '',
      logUpdatedAt: logInfo ? logInfo.mtimeMs : 0,
      message: profileResponse.message || 'Profile data could not be fetched.'
    };
  }

  const profileData = profileResponse.data || {};
  const xpInfo = extractProfileXpEntries(profileData);
  const masteryExtras = await extractProfileMasteryExtras(profileData, xpInfo);
  const summary = extractProfileSummary(profileData, fallbackDisplayName);

  if (xpInfo.length === 0) {
    await saveProfileCacheFailure(accountId, now, 'No mastery XP entries were found.');
    return {
      ok: false,
      reason: 'profile-empty',
      process: processInfo,
      logPath: logInfo ? logInfo.path : '',
      logUpdatedAt: logInfo ? logInfo.mtimeMs : 0,
      displayName: summary.displayName,
      masteryRank: summary.masteryRank,
      message: 'Profile data was fetched, but no mastery XP entries were found. Enter and leave a Relay or Dojo, then try again.'
    };
  }

  const result = {
    ok: true,
    process: processInfo,
    logPath: logInfo ? logInfo.path : '',
    logUpdatedAt: logInfo ? logInfo.mtimeMs : 0,
    displayName: summary.displayName,
    masteryRank: summary.masteryRank,
    xpInfo,
    xpInfoCount: xpInfo.length,
    masteryExtras,
    endpoint: profileResponse.endpoint,
    cacheControl: profileResponse.cacheControl,
    expires: profileResponse.expires,
    fetchedAt: Date.now()
  };

  await saveProfileCacheResult(accountId, result);
  return result;
}

const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const UPDATE_CHECK_STARTUP_DELAY_MS = 60 * 1000;
const UPDATE_CHECK_STATE_FILE = 'update-check-state.json';
let backgroundUpdateCheckTimer = null;

function getUpdateCheckStatePath() {
  return path.join(app.getPath('userData'), UPDATE_CHECK_STATE_FILE);
}

/**
 * Check for updates at most once a day, and not during the first minute.
 *
 * The renderer already offers a manual "check for updates" button, so nothing is
 * lost by throttling the automatic path. Re-checking on every launch means a
 * network round trip every time someone opens the app, which is how an updater
 * turns into background chatter nobody asked for.
 */
async function scheduleBackgroundUpdateCheckAfter(startupDelayMs) {
  if (isDev) {
    return;
  }

  const state = await readJsonFile(getUpdateCheckStatePath(), {});
  const lastCheck = Number(state && state.lastCheckAt) || 0;
  const elapsed = Date.now() - lastCheck;
  const wait = elapsed >= UPDATE_CHECK_INTERVAL_MS
    ? startupDelayMs
    : UPDATE_CHECK_INTERVAL_MS - elapsed + startupDelayMs;

  if (backgroundUpdateCheckTimer) {
    clearTimeout(backgroundUpdateCheckTimer);
  }
  backgroundUpdateCheckTimer = setTimeout(() => {
    backgroundUpdateCheckTimer = null;
    getAutoUpdater()
      .checkForUpdates()
      .catch(() => {})
      .finally(async () => {
        try {
          await writeJsonFile(getUpdateCheckStatePath(), { lastCheckAt: Date.now() });
        } catch (err) {
          // Persisting the update timestamp is best-effort only.
        }
      });
  }, wait);
  if (typeof backgroundUpdateCheckTimer.unref === 'function') {
    backgroundUpdateCheckTimer.unref();
  }
}

function setupAutoUpdater() {
  if (isDev) {
    return;
  }

  const autoUpdater = getAutoUpdater();
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    sendUpdaterEvent('checking-for-update');
  });

  autoUpdater.on('update-available', (info) => {
    updateDownloaded = false;
    sendUpdaterEvent('update-available', {
      version: info && info.version ? info.version : '',
      releaseName: info && info.releaseName ? info.releaseName : '',
      releaseNotes: info && info.releaseNotes ? info.releaseNotes : ''
    });
  });

  autoUpdater.on('update-not-available', (info) => {
    updateDownloaded = false;
    sendUpdaterEvent('update-not-available', {
      version: info && info.version ? info.version : ''
    });
  });

  autoUpdater.on('error', (error) => {
    sendUpdaterEvent('error', {
      message: error && error.message ? error.message : 'Updater error'
    });
  });

  autoUpdater.on('download-progress', (progress) => {
    sendUpdaterEvent('download-progress', {
      percent: progress && typeof progress.percent === 'number' ? progress.percent : 0,
      transferred: progress && typeof progress.transferred === 'number' ? progress.transferred : 0,
      total: progress && typeof progress.total === 'number' ? progress.total : 0,
      bytesPerSecond: progress && typeof progress.bytesPerSecond === 'number' ? progress.bytesPerSecond : 0
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    updateDownloaded = true;
    sendUpdaterEvent('update-downloaded', {
      version: info && info.version ? info.version : ''
    });

    setTimeout(() => {
      sendUpdaterEvent('installing-update');
      autoUpdater.quitAndInstall(false, true);
    }, 1200);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: DEFAULT_WINDOW_WIDTH,
    height: DEFAULT_WINDOW_HEIGHT,
    minWidth: DEFAULT_MIN_WIDTH,
    minHeight: DEFAULT_MIN_HEIGHT,
    frame: false,
    // Liquid Glass: the window itself is transparent so the desktop refracts
    // through the glass panels, exactly as the reference reads. The rounded
    // shell and hairline edge are painted by .app-container, not by the OS.
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
      webSecurity: false,
      spellcheck: false
    }
  });

  // Must be absolute: loadFile resolves a relative path against the process working
  // directory, not the app folder, so launching from anywhere else (a shortcut, a
  // double-clicked exe, a packaged build) silently produced an empty window with no
  // error and nothing clickable.
  const indexPath = path.join(__dirname, 'index.html');
  mainWindow.loadFile(indexPath).catch((err) => {
    const message = err && err.message ? err.message : String(err);
    try {
      dialog.showErrorBox(
        'Warframe Companion could not start',
        'The interface file could not be loaded:\n\n' + indexPath + '\n\n' + message
      );
    } catch (dialogErr) {
      console.error('interface failed to load and no dialog could be shown:', message);
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    /* Closing the window closes the app.
     *
     * The two overlays are separate windows, so `window-all-closed` never fired
     * and the process stayed alive with a Tesseract worker and a log poller running
     * against a game, showing nothing. That is what left a headless Ordis sitting in
     * the task manager after the window was closed. */
    if (relicOverlayWindow && !relicOverlayWindow.isDestroyed()) {
      relicOverlayWindow.close();
      relicOverlayWindow = null;
    }
    if (rivenOverlayWindow && !rivenOverlayWindow.isDestroyed()) {
      rivenOverlayWindow.close();
      rivenOverlayWindow = null;
    }
    app.quit();
  });
}

// Electron defaults to allowing many instances. Without a lock, double-clicking
// the shortcut twice leaves two copies fighting over the same windows, ports and
// OCR workers, which is exactly the "always-running overlay software" feel we are
// avoiding. The second launch hands off to the first and exits immediately.
const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    createWindow();
    // Register the event handlers now so a manual check from the renderer is
    // reported correctly, but do not require the updater module yet. In dev the
    // module is never loaded at all.
    setupAutoUpdater();
    scheduleBackgroundUpdateCheckAfter(UPDATE_CHECK_STARTUP_DELAY_MS);
  });
}

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

ipcMain.on('window-minimize', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.on('window-maximize', () => {
  if (mainWindow) {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  }
});

ipcMain.on('window-close', () => {
  if (mainWindow) mainWindow.close();
});

ipcMain.handle('set-trade-mode', (_event, enabled) => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return { ok: false, enabled: false };
  }

  var next = !!enabled;
  mainWindow.setAlwaysOnTop(false);
  mainWindow.setMinimumSize(DEFAULT_MIN_WIDTH, DEFAULT_MIN_HEIGHT);

  return { ok: true, enabled: next };
});

ipcMain.handle('set-always-on-top', (_event, enabled) => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return { ok: false, enabled: false };
  }

  var next = !!enabled;
  mainWindow.setAlwaysOnTop(next, next ? 'screen-saver' : 'normal');
  return { ok: true, enabled: next };
});

ipcMain.handle('set-relic-overlay-enabled', async (_event, enabled) => {
  const next = !!enabled;
  relicOverlayEnabled = next;

  if (!next) {
    await stopRelicOverlayLoop();
    sendRelicOverlayEvent('status', {
      enabled: false,
      message: 'Relic reward overlay disabled.'
    });
    return { ok: true, enabled: false };
  }

  try {
    await ensureRelicOverlayWindow(getDisplayForRelicOverlay());
    relicOverlayEnabled = true;
    await startRelicOverlayLoop();
    sendRelicOverlayEvent('status', {
      enabled: true,
      message: 'Watching EE.log for Void Fissure rewards...'
    });
    return { ok: true, enabled: true };
  } catch (err) {
    relicOverlayEnabled = false;
    await stopRelicOverlayLoop();
    return {
      ok: false,
      enabled: false,
      message: err && err.message ? err.message : 'Could not start relic reward overlay.'
    };
  }
});

ipcMain.handle('get-relic-overlay-status', () => {
  return {
    ok: true,
    enabled: relicOverlayEnabled,
    scanning: relicOverlayScanning,
    lastCaptureAt: relicOverlayLastCaptureAt,
    lastDetectionAt: relicOverlayLastDetectionAt,
    logPath: relicOverlayLogPath,
    burstActive: Date.now() < relicOverlayBurstUntil
  };
});

ipcMain.handle('set-riven-overlay-enabled', async (_event, enabled) => {
  const next = !!enabled;

  if (!next) {
    await stopRivenOverlayLoop();
    sendRivenOverlayEvent('status', {
      enabled: false,
      message: 'Riven grading overlay disabled.'
    });
    return { ok: true, enabled: false };
  }

  try {
    rivenOverlayEnabled = true;
    await startRivenOverlayLoop();
    /* The window is built now rather than on the first result.
     *
     * A riven result is only useful for the second or two the cards are on
     * screen, and creating a BrowserWindow and loading a file takes long enough
     * that doing it lazily meant the first reroll of every session produced
     * nothing at all. The relic overlay has always been created on enable for the
     * same reason. */
    try {
      await ensureRivenOverlayWindow(getDisplayForRelicOverlay());
      if (rivenOverlayWindow && !rivenOverlayWindow.isDestroyed()) rivenOverlayWindow.hide();
    } catch (err) {
      // A display that cannot host it is reported by the scan itself.
    }
    sendRivenOverlayEvent('status', {
      enabled: true,
      message: 'Watching EE.log for riven rerolls...'
    });
    return { ok: true, enabled: true };
  } catch (err) {
    await stopRivenOverlayLoop();
    return {
      ok: false,
      enabled: false,
      message: err && err.message ? err.message : 'Could not start riven grading overlay.'
    };
  }
});

/* ============================================================
   Riven inventory IPC
   ------------------------------------------------------------
   These read and write a local JSON file. Nothing here touches the network:
   listing a riven on Warframe.market is a separate, explicit action taken by
   the renderer with the user's own credentials, so saving a scanned riven can
   never create an order by accident.
   ============================================================ */
ipcMain.handle('riven-inventory-list', async () => {
  const entries = await readRivenInventory();
  return { ok: true, entries };
});

/* Reads the player's rivens straight out of game memory. Kept separate from the
 * inventory handlers because it is a read of the running game rather than of a file,
 * it only works on Windows, and it is slow enough to want an explicit trigger. */
ipcMain.handle('riven-memory-scan', async (_event, options) => {
  return scanRivensFromMemory(options || {});
});

ipcMain.handle('riven-inventory-add', async (_event, entry) => {
  const saved = await addRivenToInventory(entry || {});
  if (!saved) return { ok: false, message: 'That riven had no readable stats to save.' };
  return { ok: true, entry: saved.entry, created: saved.created };
});

/* A whole memory read at once. Merges into the saved list rather than replacing it: a
 * riven added by hand, or one the screen reader graded during a reroll, is not thrown
 * away because a memory read did not happen to see it. */
ipcMain.handle('riven-inventory-add-many', async (_event, payload) => {
  const result = await addRivensToInventory((payload && payload.entries) || []);
  return { ok: true, entries: result.entries, created: result.created };
});

ipcMain.handle('riven-inventory-update', async (_event, payload) => {
  const data = payload || {};
  if (!data.id) return { ok: false, message: 'No riven id given.' };
  const entry = await updateRivenInventoryEntry(data.id, data.patch || {});
  if (!entry) return { ok: false, message: 'That riven is no longer in the list.' };
  return { ok: true, entry };
});

ipcMain.handle('riven-inventory-remove', async (_event, id) => {
  const removed = await removeRivenInventoryEntry(id);
  if (!removed) return { ok: false, message: 'That riven is no longer in the list.' };
  return { ok: true };
});

/* Bulk version of the above, for a whole memory read.
 *
 * Calling addRivenToInventory in a loop would read, re-sort and rewrite the entire
 * saved file once per riven. A player with a hundred-odd rivens would pay a hundred
 * file rewrites to add what is really one change, and the file is the thing being read
 * while the game is being read. Normalising first, then writing once, keeps the cost
 * proportional to the result instead of to the collection.
 */
async function addRivensToInventory(list) {
  const incoming = Array.isArray(list) ? list : [];
  if (!incoming.length) {
    return { entries: await readRivenInventory(), created: 0 };
  }

  // One icon fetch for every class present, rather than one per riven.
  const classes = [];
  for (const raw of incoming) {
    const cls = raw && (raw.rivenType || raw.weaponClass);
    if (cls && classes.indexOf(cls) === -1) classes.push(cls);
  }
  await ensureRivenModIcons(classes);

  const normalized = [];
  for (const raw of incoming) {
    const entry = normalizeRivenInventoryEntry(raw);
    if (entry) normalized.push(entry);
  }
  // Graded as they are filed, for the same reason the single-entry path grades on the
  // way in. Leaving this to a later "Re-grade all" is what produced a list where the
  // newest rivens had no grade and the older ones carried a mixture of the old
  // great/good/ok/bad scale and the new one.
  for (const entry of normalized) await applyRivenGrade(entry);
  if (!normalized.length) {
    return { entries: await readRivenInventory(), created: 0 };
  }

  const entries = await readRivenInventory();
  // Fingerprints are computed once and reused for both the match and the trim, rather
  // than recomputed inside the per-riven search.
  const index = new Map();
  entries.forEach((e, i) => {
    const key = rivenStatsFingerprint(e);
    if (!index.has(key)) index.set(key, i);
  });

  let created = 0;
  const merged = [];
  for (const entry of normalized) {
    const key = rivenStatsFingerprint(entry);
    const at = index.get(key);
    if (at !== undefined) {
      const prev = entries[at];
      const updated = Object.assign({}, prev, {
        grade: entry.grade || prev.grade,
        gradeLabel: entry.gradeLabel || prev.gradeLabel,
        score: entry.score != null ? entry.score : prev.score,
        perfectness: entry.perfectness != null ? entry.perfectness : prev.perfectness,
        reasons: entry.reasons.length ? entry.reasons : prev.reasons,
        lastSeenAt: Date.now()
      });
      // Re-reads of the same riven arrive in one batch, so the last one wins rather
      // than the first being frozen for the rest of the run.
      if (merged[at]) merged[at] = updated; else entries[at] = updated;
      continue;
    }
    entry.lastSeenAt = Date.now();
    index.set(key, entries.length + merged.length);
    merged.push(entry);
    created++;
  }

  const out = entries.concat(merged)
    .slice()
    .sort(function (a, b) { return (b.lastSeenAt || 0) - (a.lastSeenAt || 0); })
    .slice(0, RIVEN_INVENTORY_MAX);
  await writeRivenInventory(out);
  return { entries: out, created };
}

/* ============================================================
   Riven re-grade
   ------------------------------------------------------------

   The community grade sheet and the weapon dispositions both move, and
   dispositions change with every Prime Access. Re-grading from the stored
   stats means a riven saved months ago is not stuck with a stale verdict.
   ============================================================ */
ipcMain.handle('riven-inventory-regrade', async () => {
  const entries = await readRivenInventory();
  if (!entries.length) return { ok: true, updated: 0, failed: 0, entries };

  let data = null;
  try {
    data = await getRivenDataModule().getRivenData();
  } catch (err) {
    return {
      ok: false,
      message: 'Could not reach the riven data sources: ' +
        (err && err.message ? err.message : 'unknown error'),
      entries
    };
  }

  const rivenData = getRivenDataModule();
  let updated = 0;
  let failed = 0;

  for (const entry of entries) {
    try {
      /* The same function the filing path uses.
       *
       * It used to be a second, hand-written copy of the lookup and the assignment, and
       * the two had already drifted: one knew about the riven-name candidate and the
       * other did not, so a riven graded when filed and the same riven re-graded could
       * come back with a different grade. */
      const before = entry.grade;
      const weaponNames = [entry.weaponName]
        .concat(Array.isArray(entry.weaponNameCandidates) ? entry.weaponNameCandidates : []);
      let found = null;
      for (const name of weaponNames) {
        const hit = rivenData.findRivenWeapon(data, name);
        if (hit && hit.matched) { found = hit; break; }
      }
      const weapon = found && found.weapon;
      if (!weapon) {
        failed += 1;
        continue;
      }
      const grade = rivenData.gradeRiven(weapon, entry.stats);
      if (!grade) {
        failed += 1;
        continue;
      }
      entry.grade = grade.grade;
      entry.gradeLabel = grade.gradeLabel;
      entry.score = grade.score;
      entry.perfectness = grade.perfectnessKnown ? grade.perfectness : null;
      entry.perfectnessKnown = !!grade.perfectnessKnown;
      entry.weaponClass = grade.weaponClass || entry.weaponClass;
      entry.rivenType = weapon.rivenType || entry.rivenType;
      entry.disposition = weapon.disposition != null ? weapon.disposition : entry.disposition;
      entry.reqMasteryRank = weapon.reqMasteryRank != null ? weapon.reqMasteryRank : entry.reqMasteryRank;
      entry.reasons = Array.isArray(grade.reasons) ? grade.reasons.slice(0, 5) : [];
      // Carried onto the row so it survives the save. The grade is the community's
      // ranking expressed as a letter, and the letter throws the ranking away.
      entry.notation = grade.notation || '';
      entry.gradeStats = Array.isArray(grade.gradeStats) ? grade.gradeStats : [];
      entry.priceOriented = !!grade.priceOriented;
      updated += 1;
    } catch (err) {
      failed += 1;
    }
  }

  await writeRivenInventory(entries);
  return { ok: true, updated, failed, entries };
});

ipcMain.handle('get-riven-overlay-status', () => {
  return {
    ok: true,
    enabled: rivenOverlayEnabled,    scanning: rivenOverlayScanning,
    logPath: rivenOverlayLogPath,
    cachedDisplayId: rivenOverlayCachedDisplayId,
    manualDisplayId: rivenOverlayManualDisplayId,
    lastScanAt: rivenOverlayLastScanAt,
    burstActive: Date.now() < rivenOverlayBurstUntil
  };
});

ipcMain.handle('get-available-displays', () => {
  return screen.getAllDisplays().map((display) => {
    return {
      id: display.id,
      label: display.label || 'Display',
      bounds: display.bounds,
      scaleFactor: display.scaleFactor,
      primary: display.id === screen.getPrimaryDisplay().id
    };
  });
});

ipcMain.handle('set-riven-overlay-display', (_event, displayId) => {
  const value = displayId == null || displayId === '' ? null : displayId;
  if (value !== null && !findDisplayById(value)) {
    return { ok: false, message: 'That display is no longer connected.' };
  }
  rivenOverlayManualDisplayId = value;
  return { ok: true, manualDisplayId: rivenOverlayManualDisplayId };
});

ipcMain.handle('update-relic-overlay', async (_event, payload) => {
  if (!relicOverlayEnabled) return { ok: false, visible: false, reason: 'disabled' };
  try {
    return await updateRelicOverlayWindow(payload || {});
  } catch (err) {
    return {
      ok: false,
      visible: false,
      message: err && err.message ? err.message : 'Could not update relic overlay.'
    };
  }
});

ipcMain.handle('open-external-url', async (_event, url) => {
  var target = String(url || '').trim();
  if (!/^https?:\/\//i.test(target)) {
    return { ok: false, message: 'Only http and https links are allowed.' };
  }

  try {
    await shell.openExternal(target);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      message: err && err.message ? err.message : 'Failed to open external link.'
    };
  }
});

ipcMain.handle('get-app-version', () => {
  var version = String(app.getVersion() || '').trim();
  if (version) return version;
  try {
    var pkg = require(path.join(__dirname, 'package.json'));
    return pkg && pkg.version ? String(pkg.version) : '';
  } catch (err) {
    return '';
  }
});

ipcMain.handle('check-for-app-update', async () => {
  if (isDev) {
    return { ok: false, reason: 'dev-mode' };
  }
  // A background app that re-checks on every single launch is the behaviour that
  // makes an updater feel like bloatware. Only a user-initiated check goes
  // through here; the routine daily check is throttled in checkForUpdatesInBackground.
  try {
    await getAutoUpdater().checkForUpdates();
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      message: err && err.message ? err.message : 'Update check failed.'
    };
  } finally {
    // An explicit check resets the daily timer, so the automatic pass does not
    // immediately repeat the request the user just made.
    scheduleBackgroundUpdateCheckAfter(UPDATE_CHECK_INTERVAL_MS);
  }
});

ipcMain.handle('download-app-update', async () => {
  if (isDev) {
    return { ok: false, reason: 'dev-mode' };
  }
  try {
    await getAutoUpdater().downloadUpdate();
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      message: err && err.message ? err.message : 'Update download failed.'
    };
  }
});

ipcMain.handle('install-downloaded-update', () => {
  if (isDev || !updateDownloaded) {
    return { ok: false };
  }
  sendUpdaterEvent('installing-update');
  getAutoUpdater().quitAndInstall(false, true);
  return { ok: true };
});

ipcMain.handle('detect-warframe-process', async () => {
  try {
    return { ok: true, process: await detectWarframeProcess() };
  } catch (err) {
    return {
      ok: false,
      process: { running: false, name: '' },
      message: err && err.message ? err.message : 'Warframe process detection failed.'
    };
  }
});

ipcMain.handle('get-warframe-log-config', async () => {
  try {
    return await getWarframeLogConfigSummary();
  } catch (err) {
    return {
      ok: false,
      message: err && err.message ? err.message : 'Could not read EE.log location settings.'
    };
  }
});

ipcMain.handle('select-warframe-log-file', async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose Warframe EE.log',
      properties: ['openFile'],
      filters: [
        { name: 'Warframe EE.log', extensions: ['log'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });

    if (!result || result.canceled || !result.filePaths || !result.filePaths[0]) {
      return Object.assign({ canceled: true }, await getWarframeLogConfigSummary());
    }

    return await setConfiguredWarframeLogPath(result.filePaths[0]);
  } catch (err) {
    return {
      ok: false,
      message: err && err.message ? err.message : 'Could not change EE.log location.'
    };
  }
});

ipcMain.handle('reset-warframe-log-path', async () => {
  try {
    return await clearConfiguredWarframeLogPath();
  } catch (err) {
    return {
      ok: false,
      message: err && err.message ? err.message : 'Could not reset EE.log location.'
    };
  }
});

ipcMain.handle('fetch-warframe-profile', async (_event, manualAccountId, platform) => {
  try {
    return await fetchWarframeProfileFromLog(manualAccountId, platform);
  } catch (err) {
    return {
      ok: false,
      reason: 'unexpected-error',
      message: err && err.message ? err.message : 'Profile fetch failed.'
    };
  }
});

ipcMain.handle('scan-image-for-items', async (event, imageDataUrl) => {
  activeOcrProgressTarget = event.sender;
  sendOcrProgress({ status: 'queued', progress: 0 });

  try {
    const imageBuffer = dataUrlToBuffer(imageDataUrl);
    const worker = await getOcrWorker();
    const result = await worker.recognize(imageBuffer, {}, { blocks: true });
    const data = result && result.data ? result.data : {};

    sendOcrProgress({ status: 'done', progress: 1 });

    return {
      ok: true,
      text: String(data.text || ''),
      lines: extractOcrLines(data)
    };
  } catch (err) {
    return {
      ok: false,
      message: err && err.message ? err.message : 'Image scan failed.'
    };
  } finally {
    activeOcrProgressTarget = null;
  }
});


ipcMain.handle('wfm-fetch', async (_event, url, options) => {
  try {
    options = options || {};
    options.headers = options.headers || {};

    // A caller may pass Authorization in either the documented
    // "Bearer <jwt>" form or as a bare token; normalise both to the bare jwt.
    const supplied = options.headers['Authorization'] || options.headers['authorization'] || '';
    delete options.headers['Authorization'];
    delete options.headers['authorization'];
    let token = String(supplied).trim();
    if (/^Bearer\s+/i.test(token)) token = token.replace(/^Bearer\s+/i, '').trim();
    if (token.startsWith('JWT ')) token = token.slice(4).trim();

    // Fall back to the verified session when the caller did not pass one
    // explicitly. Without this the stored session was never sent, because the
    // cookie jar and undici do not share state.
    if (!token) token = wfmSessionToken;
    wfmAuthHeaders(options.headers, token);

    Object.assign(options.headers, wfmHeaders());
    options.headers['Accept'] = 'application/json';

    const resp = await fetch(url, options);
    const status = resp.status;
    const ok = resp.ok;

    let body = null;
    const contentType = resp.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      body = await resp.json().catch(() => null);
    } else {
      body = await resp.text().catch(() => null);
    }

    return {
      ok: ok,
      status: status,
      body: body
    };
  } catch (err) {
    return {
      ok: false,
      status: 500,
      message: err && err.message ? err.message : 'Network error occurred during API fetch.'
    };
  }
});

async function setWfmCookie(tokenOnly) {
  try {
    const { session } = require('electron');
    await session.defaultSession.cookies.set({
      url: 'https://warframe.market',
      name: 'JWT',
      value: tokenOnly,
      domain: '.warframe.market',
      path: '/',
      secure: true,
      httpOnly: true,
      expirationDate: Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60)
    });
  } catch (err) {
    console.error('Failed to set WFM session cookie:', err);
  }
}

/**
 * Ask warframe.market who a token belongs to.
 *
 * The browser login harvests a JWT cookie, but a cookie existing does not mean
 * the token is usable: /v2/me is the only thing that proves it. Doing that check
 * here rather than in the renderer means the login window can be kept open when
 * verification fails, instead of being destroyed and leaving the user with an
 * auth error and no way to retry.
 */
async function verifyWfmTokenInMain(token) {
  const raw = String(token || '').trim();
  const tokenOnly = raw.startsWith('JWT ') ? raw.slice(4).trim() : raw;
  if (!tokenOnly) return { ok: false, message: 'Warframe Market did not return a session token.' };

  try {
    const resp = await fetch('https://api.warframe.market/v2/me', {
      headers: wfmAuthHeaders(wfmHeaders(), tokenOnly)
    });

    if (resp.status === 401 || resp.status === 403) {
      return {
        ok: false,
        message: 'Warframe Market rejected that session (HTTP ' + resp.status + '). It may have expired, or the sign-in did not complete. The login window is still open - try signing in again.'
      };
    }
    if (!resp.ok) {
      return {
        ok: false,
        message: 'Could not verify the Warframe Market session (HTTP ' + resp.status + '). This is usually a network or Cloudflare block rather than a bad password. The login window is still open.'
      };
    }

    const json = await resp.json().catch(() => null);
    const data = json && json.data ? json.data : null;
    if (!data) {
      return { ok: false, message: 'Warframe Market returned an unexpected response while verifying the session.' };
    }
    return { ok: true, token: 'JWT ' + tokenOnly, user: data };
  } catch (err) {
    return {
      ok: false,
      message: 'Could not reach Warframe Market to verify the session: ' + (err && err.message ? err.message : 'network error')
    };
  }
}

ipcMain.handle('wfm-set-cookie', async (_event, token) => {
  // A token is only a session if Warframe.market accepts it. Previously this
  // handler wrote the cookie and returned ok:true unconditionally, so an expired
  // or mistyped token looked like a successful login and the failure only
  // surfaced later as a 401 on some unrelated market call.
  const verified = await verifyWfmTokenInMain(token);
  if (!verified.ok) {
    wfmSessionToken = '';
    return { ok: false, message: verified.message };
  }

  const tokenOnly = String(token).startsWith('JWT ') ? String(token).substring(4).trim() : String(token).trim();
  wfmSessionToken = tokenOnly;
  await setWfmCookie(tokenOnly);
  return { ok: true, user: verified.user };
});

ipcMain.handle('wfm-login-cancel', async () => {
  if (wfmLoginWindow && !wfmLoginWindow.isDestroyed()) {
    wfmLoginWindow.destroy();
  }
  wfmLoginWindow = null;
  return { ok: true };
});

ipcMain.handle('wfm-login-browser', async (_event) => {
  if (wfmLoginWindow && !wfmLoginWindow.isDestroyed()) {
    wfmLoginWindow.focus();
    return { ok: false, message: 'The Warframe Market login window is already open.' };
  }

  const { session } = require('electron');
  const loginSession = session.fromPartition('wfm-login', { cache: false });
  const LOGIN_TIMEOUT_MS = 180000;
  const CLOUDFLARE_TITLE = /just a moment|attention required|checking your browser/i;

  return new Promise((resolve) => {
    let settled = false;
    let pollTimer = null;
    let timeoutTimer = null;
    let sawCloudflare = false;
    // Guards the verify step so a slow /v2/me response is not started again on
    // the next tick, and so one rejected token is not retried forever.
    let verifying = false;
    let rejectedToken = '';

    const clearTimers = () => {
      if (pollTimer) clearInterval(pollTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      pollTimer = null;
      timeoutTimer = null;
    };

    // Only a verified session closes the window. `keepWindow` is used for
    // recoverable failures so the user can sign in again without restarting.
    //
    // The polling interval deliberately survives a recoverable failure: clearing
    // it here would stop the watcher, and the re-armed timeout would then fire
    // with nothing left to detect the retry.
    const finish = (result, keepWindow) => {
      if (settled) return;
      if (keepWindow) {
        // Leave the window open and keep polling. The renderer is told the
        // current status so the message appears immediately, and the promise
        // stays pending until the window is closed or a later attempt succeeds.
        if (result && result.message) {
          sendWfmLoginStatus({ ok: false, message: result.message, recoverable: true });
          console.warn('WFM browser login not completed:', result.message);
        }
        return;
      }

      settled = true;
      clearTimers();
      if (wfmLoginWindow && !wfmLoginWindow.isDestroyed()) {
        wfmLoginWindow.destroy();
      }
      wfmLoginWindow = null;
      resolve(result);
    };

    const timeoutMessage = () => (
      sawCloudflare
        ? 'Warframe Market never got past its Cloudflare check, so no session was created. ' +
          'This is a network or IP-reputation block rather than a login problem. Try again later or from a ' +
          'different network, or use the email and password form.'
        : 'Timed out waiting for a Warframe Market session. Finish logging in within three minutes, then try again.'
    );

    const armTimeout = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      timeoutTimer = setTimeout(() => finish({ ok: false, message: timeoutMessage() }), LOGIN_TIMEOUT_MS);
    };

    armTimeout();

    wfmLoginWindow = new BrowserWindow({
      width: 1180,
      height: 860,
      title: 'Log in to Warframe Market',
      autoHideMenuBar: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        partition: 'wfm-login'
      }
    });

pollTimer = setInterval(async () => {
       try {
         // A Cloudflare interstitial can sit in front of the login page indefinitely.
         // Remember that it was seen so the eventual timeout explains the real cause.
         if (!sawCloudflare && wfmLoginWindow && !wfmLoginWindow.isDestroyed()) {
           try {
             if (CLOUDFLARE_TITLE.test(wfmLoginWindow.getTitle())) {
               sawCloudflare = true;
               // Reset the timeout because Cloudflare can take a while
               armTimeout();
             }
           } catch (err) {
             // The title is unavailable while the page is still committing; try again next tick.
           }
         }

         if (verifying) return;

         const cookies = await loginSession.cookies.get({ domain: '.warframe.market' });
         const jwt = cookies.find((cookie) => cookie && cookie.name === 'JWT' && cookie.value);
         if (!jwt || !jwt.value) return;

         // Ignore a token already known to be bad, otherwise a cookie the site
         // refuses to accept would be re-verified every second forever.
         if (jwt.value === rejectedToken) return;

         verifying = true;
         let result;
         try {
           result = await verifyWfmTokenInMain(jwt.value);
         } finally {
           verifying = false;
         }

         if (result && result.ok) {
           // Keep the verified token so later wfm-fetch calls are authenticated
           // without the renderer having to resend the Authorization header.
           wfmSessionToken = String(result.token || '').replace(/^JWT\s+/i, '').trim();
           finish({ ok: true, token: result.token, user: result.user });
           return;
         }

         rejectedToken = jwt.value;
         wfmSessionToken = '';
         finish({ ok: false, message: result && result.message ? result.message : 'Warframe Market rejected that session.' }, true);
         // The user may sign in again in the still-open window, which issues a
         // fresh cookie. Re-arm the clock so a retry is not cut short.
         armTimeout();
       } catch (err) {
         // Keep polling; a transient cookie read failure should not abort the login.
       }
     }, 1000);

    wfmLoginWindow.on('closed', () => {
      clearTimers();
      wfmLoginWindow = null;
      if (settled) return;
      settled = true;
      resolve({ ok: false, message: 'Login window closed before a session was established.' });
    });

wfmLoginWindow.webContents.on('did-fail-load', (_e, code, description, _url, isMainFrame) => {
       // -3 is ERR_ABORTED, which Chromium reports for a navigation that was
       // cancelled or superseded. Every redirect and every Cloudflare interstitial
       // produces one, so treating it as a hard failure aborted the login before the
       // login page had even finished loading. Sub-frames fail for their own reasons
       // and say nothing about the page the user is looking at.
       if (code === -3) return;
       if (isMainFrame === false) return;
       // Ignore certain failures that may be related to Cloudflare interstitial resources
       if (description && (/cloudflare/i.test(description))) {
         return;
       }
       finish({ ok: false, message: 'Could not load Warframe Market: ' + (description || code) });
     });

wfmLoginWindow.loadURL('https://warframe.market/login').catch((err) => {
       if (err && err.message && /cloudflare/i.test(err.message)) {
         finish({ ok: false, message: 'Cloudflare is blocking access to Warframe Market. Please try again later or use the email and password form.' });
       } else {
         finish({ ok: false, message: err && err.message ? err.message : 'Could not open Warframe Market.' });
       }
     });
  });
});

app.on('before-quit', () => {
  if (relicOverlayTimer) {
    clearTimeout(relicOverlayTimer);
    relicOverlayTimer = null;
  }
  stopRelicOverlayLogWatcher();
  stopRivenOverlayWatch();
  if (relicOverlayWindow && !relicOverlayWindow.isDestroyed()) {
    relicOverlayWindow.close();
    relicOverlayWindow = null;
  }
  if (rivenOverlayWindow && !rivenOverlayWindow.isDestroyed()) {
    rivenOverlayWindow.close();
    rivenOverlayWindow = null;
  }
  if (wfmLoginWindow && !wfmLoginWindow.isDestroyed()) {
    wfmLoginWindow.destroy();
    wfmLoginWindow = null;
  }
  if (!ocrWorkerPromise) return;
  ocrWorkerPromise
    .then((worker) => worker && typeof worker.terminate === 'function' ? worker.terminate() : null)
    .catch(() => {});
});
