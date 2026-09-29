/**
 * Phase 4: Parse OCR text from a riven reroll screen into structured data.
 *
 * The stat names in here are delegated to riven-data.js rather than duplicated,
 * so there is one list of aliases and one name resolver. The previous draft kept
 * its own 24-entry weapon table and its own 20-entry riven-suffix list, which
 * meant it recognised things that do not exist in the game (it listed a weapon
 * called "Ocucor"; the real weapon is Opticor) while missing most real ones.
 *
 * The line formats below are taken from OCRing two real reroll frames, and are
 * the shapes this has to survive:
 *   "<Weapon> <RivenName>"     the riven name is prefix+suffix joined by a hyphen
 *   "+116.7% Heat"             ordinary bonus
 *   "-103.9% Critical Damage"  the curse
 *   "x1.55 Damage to Grineer"  faction damage over 100% renders as xN, with no
 *                              sign and no percent sign
 *   "0.72 Damage to Infested"  a multiplier under 1 is a malus, not a bonus
 */

const rivenData = require('./riven-data.js');

/** Words the game prints on the riven screens that are not stat lines. */
const UI_CHROME = new Set([
  'fits in', 'inventory', 'mods', 'items', 'item', 'lock trait', 'show ranked',
  'close', 'buy', 'sell', 'equip', 'remaining kuva', 'owned', 'region',
  'challenge', 'unveil', 'veiled', 'details', 'mastery rank', 'requiring',
  'copy', 'edit', 'back', 'next', 'previous', 'search', 'filter', 'sort'
]);

/**
 * Phrases that mark a line as UI rather than data. Matched on a normalised form
 * so case and spacing do not matter. These are substrings rather than whole
 * lines, so they have to be written to survive OCR: the game prints
 * "Remaining Kuvas" but a frame read "Remaining Kuvais", so the phrase stops
 * before the part that varies.
 */
const CHROME_PHRASES = [
  'fits in', 'lock trait', 'remaining kuva', 'cycle for', 'show ranked',
  'inventory mods', 'mastery rank', 'kuvas to reroll'
];

/**
 * A riven name is a prefix and a suffix from the published riven-name table,
 * joined by a hyphen with no surrounding space ("Igni-Argus"). Weapon names can
 * also contain hyphens, but not in that shape, which is what makes this safe to
 * split on.
 */
const RIVEN_NAME = /([A-Z][a-z]{2,})-([A-Z][a-z]{2,})\s*$/;

function normaliseLine(line) {
  return String(line || '').toLowerCase().replace(/[^a-z0-9%.\sx-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function isChrome(line) {
  const norm = normaliseLine(line);
  if (!norm) return true;
  if (UI_CHROME.has(norm)) return true;
  if (CHROME_PHRASES.some((p) => norm.indexOf(p) !== -1)) return true;
  // Long runs of separators are the background of the mod card, not content.
  if (/^[^\w]{6,}$/.test(norm)) return true;
  // "1% MR 8" is the mastery-rank progress readout. It has a percent sign and a
  // number, so the no-letters rule misses it, and it would otherwise be read as a
  // 1% stat called "MR 8".
  if (/\bmr\s*\d/.test(norm)) return true;
  // No letters at all: a price, a platinum balance or a stat bar readout.
  if (!/[a-z]/.test(norm)) return true;
  return false;
}

/**
 * Read one stat line.
 *
 * The game does not print a plain percentage for every stat, and OCR rarely gives
 * us a clean start-of-line, so the value is located anywhere in the line and the
 * form is decided from the characters immediately around it:
 *
 *   "+116.7% Heat"              -> 116.7, positive
 *   "-103.9% Critical Damage"   -> 103.9, negative
 *   "x1.55 Damage to Grineer"   -> 155,  positive   (multiplier, no sign or percent)
 *   "0.72 Damage to Infested"   -> 28,   negative   (multiplier under 1 is a malus)
 *
 * `value` is the magnitude of the change as a percentage of the stat's base, with
 * the direction carried separately by isPositive. riven-data grades a negative by
 * Math.abs(value) against a malus-weighted maximum, so a full penalty is a large
 * number and no penalty is 0.
 *
 * Real OCR debris seen in front of a value, all of which must be tolerated:
 *   "| +221.1% ...", "v & X0.7 ...", "WV) x0.7 ...", "-~  0.72 ..."
 *
 * @returns {{value: number, name: string, isPositive: boolean}|null}
 */
/**
 * Resolve a stat name, tolerating a single OCR substitution.
 *
 * "Recoil" is read as "Recoll" often enough that dropping the stat loses a
 * whole line off a riven. A one-edit match against the published attribute list
 * is safe here: the candidate set is 32 names, and requiring a distance of at
 * most one on a name of this length will not collide with a different attribute.
 */
function fuzzyStatKey(name) {
  const direct = rivenData.resolveRivenStatKey(name);
  if (direct) return direct;

  const target = String(name || '').toLowerCase().replace(/[^a-z]/g, '');
  if (target.length < 5) return null;

  for (const key of Object.keys(rivenData.RIVEN_STATS || {})) {
    const display = String((rivenData.RIVEN_STATS[key] || {}).display || '').toLowerCase().replace(/[^a-z]/g, '');
    if (!display) continue;
    if (display === target || withinOneEdit(display, target) || withinOneEdit(key.toLowerCase(), target)) {
      return key;
    }
  }
  return null;
}

/** True when a and b differ by at most one insertion, deletion or substitution. */
function withinOneEdit(a, b) {
  if (a === b) return true;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;

  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < la && j < lb) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (la > lb) i++;
    else if (lb > la) j++;
    else { i++; j++; }
  }
  return edits + (la - i) + (lb - j) <= 1;
}

/**
 * Clean debris off the tail of a stat name.
 *
 * A riven card draws the stat text over an animated background, and OCR picks
 * up a stray character at the end of the line often enough to matter:
 * "Zoom y", "Weapon Recoll", "Status Duration p", "_Slash". A name that does
 * not resolve to a known stat gets this treatment; one that does resolve is
 * left alone, so a real name that happens to end in a single letter is safe.
 */
function trimStatName(rawName) {
  let name = String(rawName || '').trim().replace(/\s+/g, ' ');

  // Only trim if the cleaned form still looks like the same name.
  for (let attempt = 0; attempt < 3; attempt++) {
    const trimmed = name
      .replace(/[\s._:;,|]+$/, '')   // trailing punctuation and separators
      .replace(/\s+[a-z]$/, '')      // "Zoom y"
      .replace(/^[_.\s]+/, '')        // "_Slash"
      .trim();
    if (trimmed === name || !trimmed) break;
    if (rivenData.resolveRivenStatKey(trimmed)) {
      name = trimmed;
      break;
    }
    name = trimmed;
  }

  return name.trim();
}

function parseStatLine(line) {
  if (!line) return null;
  const text = String(line).trim();

  // The stat value is the first number on the line whose following text starts
  // with a letter. Not simply the first number: OCR often prefixes debris to a
  // line, so "0) +112.1% Slash" begins with a "0" that is not the value, and
  // taking it dropped the whole stat.
  let found = null;
  const numberPattern = /\d+(?:\.\d+)?/g;
  let match;
  while ((match = numberPattern.exec(text)) !== null) {
    const after = text.slice(match.index + match[0].length);
    if (/^[\s%)\].,:;|]*[A-Za-z_]/.test(after)) {
      found = { index: match.index, text: match[0] };
      break;
    }
  }
  if (!found) return null;

  const number = parseFloat(found.text);
  const before = text.slice(0, found.index);
  const after = text.slice(found.index + found.text.length);

  // The stat name follows the value and must start with a letter, which rejects
  // lines where the number is the content ("MR 8", "022").
  const rest = after.replace(/^[\s%]+/, '');
  if (!/^[A-Za-z]/.test(rest)) return null;
  const name = trimStatName(rest);
  if (!name) return null;
  // A wrapped stat name can still end on a card readout, e.g. "1% MR 8 022" would
  // otherwise be read as a 1% bonus called "MR 8 022".
  if (isChrome(name)) return null;

  // Only a marker directly against the number counts. "-~  0.72" must not read the
  // stray hyphen as a minus sign, and "v & X0.7" must still read as a multiplier,
  // so trailing whitespace is trimmed but intervening characters are not skipped.
  const marker = before.replace(/\s+$/, '');

  if (/x$/i.test(marker)) {
    return { value: Math.round(number * 1000) / 10, name: name, isPositive: number >= 1 };
  }
  if (/\+$/.test(marker)) {
    return { value: number, name: name, isPositive: true };
  }
  if (/-$/.test(marker)) {
    return { value: number, name: name, isPositive: false };
  }
  if (/^\s*%/.test(after)) {
    return { value: number, name: name, isPositive: true };
  }

  // A bare fraction with no marker, e.g. "0.72 Damage to Infested". Under 1 is a
  // malus worth the shortfall.
  if (found.text.indexOf('.') !== -1 && number < 1) {
    return { value: Math.round((1 - number) * 1000) / 10, name: name, isPositive: false };
  }

  return null;
}

/**
 * Split a name line into the weapon name and the riven name.
 *
 * "Ceramic Dagger Igni-Argus" -> { weaponName: "Ceramic Dagger", rivenName: "Igni-Argus" }
 */
function splitWeaponAndRivenName(line) {
  const text = String(line || '').trim().replace(/\s+/g, ' ');
  if (!text) return { weaponName: null, rivenName: null };

  const match = text.match(RIVEN_NAME);
  if (match && match.index > 0) {
    const weaponName = text.slice(0, match.index).trim();
    // Only treat it as a riven name if there is a plausible weapon name in front.
    if (weaponName.length >= 2) {
      return { weaponName: weaponName, rivenName: match[1] + '-' + match[2] };
    }
  }

  return { weaponName: text, rivenName: null };
}

/**
 * True when a line could be a weapon name: mostly letters, at least two words or
 * a single reasonably long word, and not a stat line.
 */
function looksLikeWeaponName(line) {
  // OCR frames the card with rule lines, so the name arrives as "= | Ceramic
  // Dagger". The leading debris has to go before the shape test, otherwise the
  // real weapon name is discarded and a stray fragment above it is used instead.
  const text = String(line || '').trim().replace(/^[^A-Za-z]+/, '').replace(/\s+/g, ' ');
  if (!text || text.length < 3 || text.length > 60) return false;
  if (parseStatLine(text)) return false;
  if (/[0-9%]/.test(text)) return false;
  if (isChrome(text)) return false;
  const words = text.split(/\s+/);
  if (words.length > 5) return false;
  if (!/^[A-Za-z][A-Za-z &'.\-]*$/.test(text)) return false;
  // Every published weapon name is title case, and a wrapped stat continuation
  // ("for Slide Attack") is not a name at all.
  if (!/^[A-Z]/.test(text)) return false;
  // A single short capitalised fragment ("No BE") is debris, not a weapon name.
  if (words.length === 1 && text.length < 6) return false;
  return true;
}

/**
 * Parse raw OCR text from a riven screen.
 *
 * Stat name resolution is intentionally left to riven-data.js, and unresolved
 * names are kept in the result rather than dropped, so the caller can tell the
 * difference between "this riven has a stat I do not understand" and "this riven
 * has fewer stats than the screen showed".
 *
 * @param {string} rawText raw tesseract output
 * @returns {Object|null} structured parse, or null when nothing usable was found
 */
function parseRivenOcr(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;

  const lines = rawText.split('\n').map((l) => l.replace(/\s+/g, ' ').trim());

  const result = {
    weaponName: null,
    weaponNameCandidates: [],
    rivenName: null,
    stats: [],
    unresolvedStats: [],
    lockedTrait: false,
    challengeScreen: false,
    masterRank: null,
    warnings: [],
    rawText: rawText
  };

  // Stats arrive in two columns, so a multi-word name can be split across lines
  // ("+88.7% Heavy Attack" / "Efficiency"). Hold back a candidate whose name is
  // not yet a known stat and try to complete it with the next line.
  let pending = null;

  const commit = (candidate) => {
    if (!candidate) return;
    const key = fuzzyStatKey(candidate.name);
    const entry = {
      key: key,
      name: candidate.name,
      value: candidate.value,
      isPositive: candidate.isPositive
    };
    if (key) result.stats.push(entry);
    else result.unresolvedStats.push(entry);
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line) continue;

    const lower = line.toLowerCase();
    if (lower.indexOf('lock trait') !== -1) result.lockedTrait = true;
    if (lower.indexOf('cycle for') !== -1 || lower.indexOf('remaining kuva') !== -1) {
      result.challengeScreen = true;
    }

    const mr = line.match(/\bMR\s*(\d{1,2})\b/i);
    if (mr && result.masterRank === null) result.masterRank = parseInt(mr[1], 10);

    if (isChrome(line)) continue;

    const stat = parseStatLine(line);
    if (stat) {
      // The card is two columns, so a multi-word name can be split across lines
      // ("+88.7% Heavy Attack" / "Efficiency"). Try the join *before* committing,
      // because the short form often resolves to the wrong thing on its own:
      // "Heavy Attack" is a prefix of the splice trait "Heavy Attack Windup
      // Speed", so committing early graded a riven as carrying a trait it did
      // not have.
      const next = lines[index + 1];
      /* Only a line that is not itself a complete stat can be a continuation.
       *
       * It must also be letters and spaces only. A real riven card puts one
       * stat per line, so a following line carrying a number or a percent sign
       * is the next stat, not the tail of this one's name. Without this check
       * a screen read of
       *   -82.5% Weapon Recoil
       *   +88.3% Status Duration
       *   +112.1% Slash
       * joined the last two into one stat called
       * "Status Duration 0) +112.1% Slash", because the leading "0)" of an
       * OCR-mangled line stops parseStatLine from seeing a stat in it. */
      const canBeContinuation = next && !isChrome(next) && !/\d|%/.test(next);
      if (canBeContinuation && !parseStatLine(next)) {
        const joined = stat.name + ' ' + next.trim();
        if (rivenData.resolveRivenStatKey(joined)) {
          commit(Object.assign({}, stat, { name: joined }));
          index++;           // the continuation line is part of this stat
          continue;
        }
      }

      if (rivenData.resolveRivenStatKey(stat.name)) {
        commit(stat);
      } else {
        pending = stat;
      }
      continue;
    }

    if (looksLikeWeaponName(line)) {
      const cleaned = line.replace(/^[^A-Za-z]+/, '').replace(/\s+/g, ' ').trim();
      const split = splitWeaponAndRivenName(cleaned);
      /* Keep every plausible name, best first. OCR puts fragments above the real
       * weapon name ("No BE" ahead of "= | Ceramic Dagger"), so a single guess
       * silently grades against the wrong weapon. The caller picks the first
       * candidate that riven-data actually knows, which is the only reliable
       * signal here.
       *
       * A riven card titles itself "<Weapon> <RivenName>", and a riven name is
       * arbitrary text: "Ocucor Vissilis", "Ocucor Sci-zetides", "Igni-Argus"
       * all occur. No pattern reliably tells them apart, so every leading word
       * run is offered as a candidate and the known-weapon lookup in the main
       * process decides. "Ocucor" is a weapon; "Ocucor Sci-zetides" is not. */
      const candidates = [];
      if (split.weaponName) candidates.push(split.weaponName);
      const words = cleaned.split(' ').filter(Boolean);
      for (let take = words.length - 1; take >= 1; take--) {
        candidates.push(words.slice(0, take).join(' '));
      }
      if (cleaned) candidates.push(cleaned);

      for (const candidate of candidates) {
        if (result.weaponNameCandidates.indexOf(candidate) === -1) {
          result.weaponNameCandidates.push(candidate);
        }
      }
      if (!result.weaponName) {
        result.weaponName = split.weaponName || cleaned;
        result.rivenName = split.rivenName;
      }
    }
  }

  if (pending) commit(pending);

  // A riven carries two or three bonuses and at most one curse. Anything else
  // means the parse picked up noise or lost a line, and grading it anyway would
  // produce a confident wrong answer.
  const positives = result.stats.filter((s) => s.isPositive).length;
  const negatives = result.stats.filter((s) => !s.isPositive).length;
  if (positives > 3) {
    result.warnings.push('read ' + positives + ' bonuses, but a riven has at most 3');
  }
  if (negatives > 1) {
    result.warnings.push('read ' + negatives + ' curses, but a riven has at most 1');
  }
  if (result.unresolvedStats.length) {
    result.warnings.push(
      result.unresolvedStats.length + ' stat name(s) not recognised: ' +
      result.unresolvedStats.map((s) => s.name).join(', ')
    );
  }

  if (!result.weaponName && result.stats.length === 0) return null;

  // Best-effort riven-name pairing for the first candidate; the caller re-splits
  // once it settles on a weapon that riven-data knows.
  for (let i = 0; i < result.weaponNameCandidates.length; i++) {
    const split = splitWeaponAndRivenName(result.weaponNameCandidates[i]);
    if (split.rivenName) {
      result.rivenName = split.rivenName;
      break;
    }
  }

  return result;
}

module.exports = {
  parseRivenOcr,
  parseStatLine,
  splitWeaponAndRivenName,
  isChrome,
  normaliseLine
};
