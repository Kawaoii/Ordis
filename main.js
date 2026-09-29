const { app, BrowserWindow, ipcMain, shell, dialog, desktopCapturer, screen } = require('electron');
const path = require('path');
const fs = require('fs/promises');
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

function normalizeRivenInventoryEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const stats = Array.isArray(raw.stats) ? raw.stats : [];
  if (!stats.length) return null;

  const grade = raw.grade && typeof raw.grade === 'object' ? raw.grade : {};
  const cleanStats = stats
    .filter((s) => s && typeof s === 'object' && s.name)
    .map((s) => ({
      name: String(s.name),
      value: Number(s.value) || 0,
      isPositive: !!s.isPositive
    }));
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
    createdAt: Number.isFinite(Number(raw.createdAt)) ? Number(raw.createdAt) : Date.now()
  };
}

async function readRivenInventory() {
  if (rivenInventoryCache) return rivenInventoryCache;
  const raw = await readJsonFile(getRivenInventoryPath(), null);
  const entries = Array.isArray(raw) ? raw : raw && Array.isArray(raw.entries) ? raw.entries : [];
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

function rivenStatsFingerprint(entry) {
  return [entry.weaponName || '']
    .concat(entry.stats.map((s) => (s.isPositive ? '+' : '-') + s.name + ':' + s.value))
    .join('~');
}

async function addRivenToInventory(entry) {
  const normalized = normalizeRivenInventoryEntry(entry);
  if (!normalized) return null;

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
const RIVEN_OVERLAY_HIDE_DELAY_MS = 10000;
const RIVEN_OVERLAY_LOG_POLL_INTERVAL_MS = 750;
const RIVEN_OVERLAY_LOG_TAIL_BYTES = 64 * 1024;
const RIVEN_OVERLAY_SCAN_DELAY_MS = 500;
const RIVEN_OVERLAY_SCAN_BURST_WINDOW_MS = 3000;
const RIVEN_OVERLAY_DUPLICATE_SCAN_MS = 1500;
const RIVEN_OVERLAY_MIN_KEYWORD_HITS = 2;
// Measured, not guessed: the mod card occupies 804,454 337x397 in a 1920x1080 frame
// (located by template-matching the card crop against the full screenshot). The
// previous guess of x:0.4 y:0.25 w:0.35 h:0.5 covered y 270-810 while the card runs
// to y 851, so the last stat line was cropped off and nothing ever OCR'd. These
// values add ~20px of margin on each side and scale with the frame.
const RIVEN_OVERLAY_CROP = { x: 0.4083, y: 0.4019, width: 0.1964, height: 0.4046 };
const RIVEN_OVERLAY_CROP_MIN_WIDTH = 900;
const RIVEN_OVERLAY_CROP_MAX_WIDTH = 1400;

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
  return /(?:Relic timer closed|MatchingService::EndSession)/i.test(String(text || ''));
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

function createRivenOcrRegion(image) {
  const size = image && image.getSize ? image.getSize() : { width: 0, height: 0 };
  const width = Math.max(1, Number(size.width) || 1);
  const height = Math.max(1, Number(size.height) || 1);
  const crop = {
    x: Math.max(0, Math.round(width * RIVEN_OVERLAY_CROP.x)),
    y: Math.max(0, Math.round(height * RIVEN_OVERLAY_CROP.y)),
    width: Math.max(1, Math.round(width * RIVEN_OVERLAY_CROP.width)),
    height: Math.max(1, Math.round(height * RIVEN_OVERLAY_CROP.height))
  };

  if (crop.x + crop.width > width) crop.width = width - crop.x;
  if (crop.y + crop.height > height) crop.height = height - crop.y;

  const targetWidth = Math.min(RIVEN_OVERLAY_CROP_MAX_WIDTH, Math.max(RIVEN_OVERLAY_CROP_MIN_WIDTH, crop.width * 1.7));
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

async function recognizeRivenRegion(capture) {
  const ocrRegion = createRivenOcrRegion(capture.image);
  const imageHash = crypto.createHash('sha1').update(ocrRegion.image.toBitmap()).digest('hex');
  const now = Date.now();

  if (imageHash === rivenOverlayLastHash && (now - rivenOverlayLastHashAt) < RIVEN_OVERLAY_DUPLICATE_SCAN_MS) {
    return { duplicate: true, imageHash, now };
  }

  rivenOverlayLastHash = imageHash;
  rivenOverlayLastHashAt = now;

  const worker = await getOcrWorker();
  const result = await worker.recognize(ocrRegion.image.toPNG(), {
    tessedit_pageseg_mode: getOcrModule().PSM.SINGLE_BLOCK,
    preserve_interword_spaces: '1'
  });
  const data = result && result.data ? result.data : {};
  const lines = transformOcrLines(extractOcrLines(data), ocrRegion);
  const text = String(data.text || lines.map((line) => line.text).join('\n'));

  return { duplicate: false, imageHash, now, text, lines };
}

async function scanRivenOverlayOnce() {
  if (!rivenOverlayEnabled || rivenOverlayScanning) return null;
  rivenOverlayScanning = true;
  rivenOverlayLastScanAt = Date.now();

  const diag = { displaysTried: 0, capturesFailed: 0, ocrRuns: 0, duplicates: 0, keywordHits: 0, valueHits: 0, bestText: '' };

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
      if (String(recognition.text).length > diag.bestText.length) diag.bestText = String(recognition.text);
      const hits = countRivenKeywordHits(recognition.text);
      if (hits > diag.keywordHits) diag.keywordHits = hits;
      // Both halves of the gate are reported, so a failure says which one fell short
      // instead of implying only the keyword count mattered.
      const valueHits = countRivenValueHits(recognition.text);
      if (valueHits > diag.valueHits) diag.valueHits = valueHits;

      if (!isLikelyWarframeRivenContent(recognition.text)) continue;

      rivenOverlayCachedDisplayId = capture.display && capture.display.id != null
        ? capture.display.id
        : rivenOverlayCachedDisplayId;

      return {
        ok: true,
        text: recognition.text,
        lines: recognition.lines,
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
 * Turn a successful OCR read into a graded riven.
 *
 * Returns a payload shaped for the renderer. Any step that cannot be completed
 * honestly reports why instead of guessing: an unrecognised weapon has no
 * disposition, and a disposition is what every maximum roll is scaled by.
 */
async function gradeRivenScan(success) {
  const base = {
    stage: 'ocr',
    text: success.text,
    lines: success.lines,
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
  try {
    const rivenData = getRivenDataModule();
    // getRivenData() is what actually loads the grade sheet and weapon list;
    // getCachedRivenData() only reads the cache it fills. Calling the getter alone
    // left the cache null, so every lookup failed and nothing could be graded.
    // It is TTL-cached, so repeat scans re-fetch at most once per interval.
    const data = await rivenData.getRivenData();
    // OCR puts fragments above the real weapon name, so every plausible name is
    // tried and the first one this tool actually knows wins. Matching published
    // data is the only reliable signal, and it also rejects the fragment.
    const names = (parsed.weaponNameCandidates && parsed.weaponNameCandidates.length)
      ? parsed.weaponNameCandidates
      : (parsed.weaponName ? [parsed.weaponName] : []);
    if (!names.length) {
      weaponError = 'The weapon name was not readable, so the disposition is unknown.';
    } else {
      const tried = [];
      for (const name of names) {
        const found = rivenData.findRivenWeapon(data, name);
        if (found && found.weapon) {
          weapon = found.weapon;
          matchedName = name;
          break;
        }
        tried.push(name);
      }
      if (!weapon) {
        weaponError = '"' + tried.join('", "') + '" ' + (tried.length > 1 ? 'are not weapons' : 'is not a weapon') +
          ' this tool knows, so its disposition is unknown and no maximum roll can be computed.';
      }
    }
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

  // Saved to the inventory so the riven is still there once the reroll screen
  // is gone. A failure here must not lose the grade that was just computed.
  try {
    const saved = await addRivenToInventory({
      weaponName: parsed.weaponName,
      rivenName: parsed.rivenName,
      stats: parsed.stats,
      grade: grade,
      disposition: weapon && weapon.disposition != null ? weapon.disposition : null,
      reqMasteryRank: weapon && weapon.reqMasteryRank != null ? weapon.reqMasteryRank : null,
      rivenType: weapon && weapon.rivenType ? weapon.rivenType : null
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

  while (rivenOverlayEnabled) {
    // A scan is already running: wait for it instead of burning an attempt on a no-op.
    if (rivenOverlayScanning) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      continue;
    }
    // Always allow one real attempt, even if the burst window elapsed while waiting.
    if (rivenOverlayScanAttempts > 0 && (rivenOverlayScanAttempts >= 3 || Date.now() >= rivenOverlayBurstUntil)) break;

    rivenOverlayScanAttempts += 1;
    const result = await scanRivenOverlayOnce();
    if (!result) continue;
    if (result.diag) lastDiag = result.diag;

    if (result.ok) {
      success = result;
      break;
    }

    if (rivenOverlayScanAttempts < 3) {
      await new Promise((resolve) => setTimeout(resolve, RIVEN_OVERLAY_SCAN_DELAY_MS));
    }
  }

  if (!rivenOverlayEnabled) return;

  if (success) {
    sendRivenScanResult(await gradeRivenScan(success));
    return;
  }

  sendRivenScanResult({
    success: false,
    stage: 'ocr',
    error: 'Reroll detected, but grading failed. ' + describeRivenScanFailure(lastDiag),
    diag: lastDiag
  });
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
  }, RIVEN_OVERLAY_SCAN_DELAY_MS);
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
      rivenOverlayLogPath = currentPath;
      rivenOverlayLogOffset = logInfo.size;
      rivenOverlayLogMissingNotified = false;
      return;
    }

    if (logInfo.size < rivenOverlayLogOffset) {
      rivenOverlayLogOffset = 0;
    }

    if (logInfo.size <= rivenOverlayLogOffset) return;

    const start = Math.max(rivenOverlayLogOffset, logInfo.size - RIVEN_OVERLAY_LOG_TAIL_BYTES);
    const chunk = await readLogChunk(currentPath, start, logInfo.size, RIVEN_OVERLAY_LOG_TAIL_BYTES);
    rivenOverlayLogOffset = logInfo.size;

    if (isRivenRerollConfirmLogText(chunk)) {
      triggerRivenScan('Riven reroll confirmed. Reading stats...');
      return;
    }

    if (isRivenRerollChoiceLogText(chunk) || isRivenRerollScreenLogText(chunk)) {
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

ipcMain.handle('riven-inventory-add', async (_event, entry) => {
  const saved = await addRivenToInventory(entry || {});
  if (!saved) return { ok: false, message: 'That riven had no readable stats to save.' };
  return { ok: true, entry: saved.entry, created: saved.created };
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
      // findRivenWeapon returns a { weapon, matched, ... } result, not the
      // weapon itself.
      const found = rivenData.findRivenWeapon(data, entry.weaponName);
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
  if (relicOverlayWindow && !relicOverlayWindow.isDestroyed()) {
    relicOverlayWindow.close();
    relicOverlayWindow = null;
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
