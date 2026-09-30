/* ===========================================================================
   COMMUNITY GOOD-ROLLS DATA AND RANK GRADING
   ===========================================================================
   Source: the "good rolls" sheet the trading community actually grades with,
   credited to Megrim and Valkyrial, built on 44Bananas' original:

     https://docs.google.com/spreadsheets/d/1OQGKpWXeoPaN0Cy7mTvVZMRcwvZXgIC3EO1AIRAkwDg

   417 weapons against the 114 of the older sheet, and it is the sheet the
   Altair bot grades against, so a grade produced here matches what people say
   in chat. Neither is called: the data is fetched and the ranking is computed
   here, because the bot is a Discord bot with its own shop and currency and
   that is not a dependency this app should have.

   WHY RANKS AND NOT A SCORE ALONE
   -------------------------------
   The sheet does not say "critical damage is good". It says critical damage
   outranks fire rate, which outranks multishot, on this weapon. That is a
   ranking, and collapsing it to a single number throws away the part people
   actually use. So a grade is the notation itself, "1cc 2cd 3ms -4z", with a
   0-100 score alongside for sorting, because which twelve rivens to keep is
   not answerable by reading eighty-six sets of notation.

   THE SHEET'S LAYOUT
   ------------------
   Each weapon occupies one or more rows. The header labels only col1
   "Positives" and col4 "Negatives" because the middle columns continue the
   same idea, and reading it that way gives a per-slot priority ranking:

     col1  the single best positive
     col2  the second positive
     col3  the remaining positives, ranked, ">" better, "/" equal
     col4  the negatives, ranked best to worst
     col5  notes, frequently empty

   "NONE > CD / DMG > ELEC" in col3 means this weapon has no good third
   positive, then crit damage and damage tied, then electricity. A blank name
   column means the row continues the weapon above, which is how a weapon with
   more than one viable build lists each of them.

   ONE ROW PER BUILD, NOT PER WEAPON
   --------------------------------
   A weapon can have several rows, and a riven has to be matched to the right
   one. Vesper 77 has six: the crit ones want CC then CD, the attack speed one
   wants AS then RNG. Grading an attack speed Vesper against the crit row would
   call its best stat worthless, so the row is chosen by which stats the riven
   actually rolled. That is the single most important thing in this file.
   --------------------------------------------------------------------------- */

/* riven-data.js requires this module, and the reverse dependency is supplied rather
 * than imported, because a require cycle between two modules that both need the other at
 * load time gives one of them a half-initialised copy of the other. setHost is called
 * once from riven-data.js at load, and every helper below reads through it. The same
 * reason the CSV parser is not reimplemented here: riven-data already has an RFC4180
 * reader that handles the quoted notes field, and two readers drifting apart is how a
 * weapon ends up graded against the wrong column. */
let host = null;

function setHost(dependencies) {
  host = dependencies;
}

function need() {
  if (!host) {
    throw new Error('riven-community: setHost() was never called, so the shared helpers are unavailable.');
  }
  return host;
}

const COMMUNITY_SHEET_ID = '1OQGKpWXeoPaN0Cy7mTvVZMRcwvZXgIC3EO1AIRAkwDg';
const COMMUNITY_SHEET_URL =
  'https://docs.google.com/spreadsheets/d/' + COMMUNITY_SHEET_ID + '/export?format=csv&gid=0';

/* The sheet's abbreviations are two or three letters. resolveRivenStatKey maps them
 * onto the same keys the rest of the app uses, and anything it cannot map is dropped
 * rather than guessed at, so a stat nobody recognises cannot inflate a score. */
function abbrevToKey(token) {
  if (!token) return null;
  return need().resolveRivenStatKey(token);
}

/**
 * "PUNC > Z / PFS* > REC" becomes [["PUNC"], ["ZOOM", "PFS"], ["REC"]].
 *
 * ">" is strictly better than what follows, "/" is equal within a tier. A tier
 * holding NONE is the sheet saying there is no good option, and is kept as an
 * empty list so the ranking still has a position for it.
 */
function parseRankedTiers(cell) {
  const raw = String(cell || '').trim();
  if (!raw) return [];

  return raw.split('>').map((tier) => {
    const keys = [];
    for (const part of tier.split('/')) {
      // Strip the sheet's annotations without losing the stat: "PFS*" is a harmless
      // negative, "PUNC(0% Tenet)" only applies to one stance, "CD**" a footnote.
      const cleaned = part
        .replace(/\([^)]*\)/g, ' ')
        .replace(/[*^]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (!cleaned || /^none$/i.test(cleaned)) continue;
      const key = abbrevToKey(cleaned);
      if (key && keys.indexOf(key) === -1) keys.push(key);
    }
    return keys;
  }).filter((tier) => tier.length > 0);
}

/** One row of the sheet, as a rule a riven can be graded against. */
function buildRule(row) {
  const first = String(row.col1 || '').replace(/[*^]/g, ' ').replace(/\([^)]*\)/g, ' ').trim();
  const second = String(row.col2 || '').replace(/[*^]/g, ' ').replace(/\([^)]*\)/g, ' ').trim();

  const rule = {
    best: first ? abbrevToKey(first) : null,
    second: second ? abbrevToKey(second) : null,
    positiveTiers: parseRankedTiers(row.col3),
    negativeTiers: parseRankedTiers(row.col4),
    note: String(row.col5 || '').trim()
  };
  // A row with no preference at all says nothing and must not shadow a row that does.
  const hasPreference = rule.best || rule.second ||
    rule.positiveTiers.length || rule.negativeTiers.length;
  return hasPreference ? rule : null;
}

/**
 * Parse the sheet into weapon key -> { name, rules }.
 *
 * findTableStart looks for the header rather than assuming a row number: the sheet
 * carries a legend and an abbreviation table above the weapon table, and those change
 * whenever someone edits the legend.
 */
function parseCommunitySheet(csvText) {
  const rows = need().parseCsvRows(csvText);
  if (!rows.length) throw new Error('Community good-rolls sheet was empty.');

  let start = -1;
  for (let i = 0; i < rows.length; i++) {
    const head = String(rows[i][0] || '').trim().toLowerCase();
    const second = String(rows[i][1] || '').trim().toLowerCase();
    if (head === 'name' && second.indexOf('positive') === 0) { start = i + 1; break; }
  }
  if (start === -1) {
    throw new Error(
      'Community good-rolls sheet layout changed: no "Name,Positives" header found in ' +
      rows.length + ' rows. Refusing to parse rather than mis-grade.'
    );
  }

  const weapons = new Map();
  let current = null;

  for (let i = start; i < rows.length; i++) {
    const cells = rows[i];
    const nameCell = String(cells[0] || '').trim();
    const hasContent = String(cells[1] || '').trim() || String(cells[2] || '').trim() ||
      String(cells[3] || '').trim();

    if (nameCell.startsWith('[') && nameCell.endsWith(']')) {
      const name = nameCell.slice(1, -1).trim();
      const key = need().normalizeRivenName(name);
      if (!key) { current = null; continue; }
      current = { name, key, rules: [], notes: [] };
      weapons.set(key, current);
    }

    if (!current) continue;

    if (String(cells[5] || '').trim()) current.notes.push(String(cells[5]).trim());
    if (!hasContent) continue;

    const rule = buildRule({ col1: cells[1], col2: cells[2], col3: cells[3], col4: cells[4], col5: cells[5] });
    if (rule) {
      rule.notes = current.notes.slice();
      current.rules.push(rule);
    }
  }

  return weapons;
}

/**
 * Which of a weapon's rules does this riven belong to?
 *
 * A rule is scored by how much of what the riven rolled it actually has an opinion
 * about. A riven carrying attack speed belongs to the attack speed rule, not the crit
 * one, and that is decided here rather than by taking the first row.
 *
 * Ties go to the earlier row, because the sheet lists the general build first and the
 * alternatives after it.
 */
function selectRuleForStats(weaponEntry, stats) {
  if (!weaponEntry || !weaponEntry.rules || !weaponEntry.rules.length) return null;
  const keys = new Set((stats || []).map((s) => s.key).filter(Boolean));

  /* A rule has to explain the whole riven, not just its best stat.
   *
   * Scoring only the stats a rule happens to mention put Sobek's Cyte variant ahead of
   * its generic one for a riven carrying multishot and crit damage, because both name
   * MS and the first one listed won the tie. That rule is for one specific rifle and
   * mentions nothing about the riven's crit damage, so it was the wrong answer.
   *
   * An unmentioned stat is therefore a penalty, scaled by how much the rule cares. A
   * rule that names three of the riven's four stats describes it better than one that
   * names one, and a rule that names none of them is not a description at all. */
  let best = null;
  let bestScore = -Infinity;
  let bestCoverage = 0;

  for (const rule of weaponEntry.rules) {
    const mentioned = new Set();
    let score = 0;
    for (const key of keys) {
      if (rule.best === key) { score += 10; mentioned.add(key); }
      else if (rule.second === key) { score += 6; mentioned.add(key); }
      else if (rule.positiveTiers.some((tier) => tier.indexOf(key) !== -1)) { score += 3; mentioned.add(key); }
      // A negative tier is deliberately not counted here. It says what the sheet
      // considers a good penalty, not that the riven is built that way, and counting it
      // let a Zaw riven whose only stat was impact be matched to the rule that lists
      // impact as a penalty, then graded as though impact were its best stat.
    }
    const coverage = keys.size ? mentioned.size / keys.size : 0;
    // Coverage dominates, because it is what identifies the rule. Rank quality only
    // breaks ties between two rules that both describe the riven equally well.
    const combined = coverage * 100 + score;
    if (combined > bestScore) { bestScore = combined; bestCoverage = coverage; best = rule; }
  }

  /* How much of a riven a rule has to account for before it is a description of it
   * rather than a coincidence.
   *
   * This threshold is the difference between reporting the truth and inventing it. A
   * Phenmor with electricity, punch through and projectile speed matches neither of the
   * sheet's two Phenmor rules, both of which want multishot or crit chance, and it is
   * refused: the community has no opinion about that riven, so neither have we. Loosening
   * it to grade everything "graded 97 of 125" bought 22 answers, and 22 of them were a
   * confident letter against a rule that does not describe the riven. A riven this tool
   * cannot judge should say so. */
  return best && bestCoverage >= 0.5 ? best : null;
}

/* Where a stat sits in the ranking. Lower is better; -1 means the sheet has no
 * opinion, which is different from it being ranked last. */
function positiveRank(rule, key) {
  if (rule.best === key) return 0;
  if (rule.second === key) return 1;
  for (let i = 0; i < rule.positiveTiers.length; i++) {
    if (rule.positiveTiers[i].indexOf(key) !== -1) return 2 + i;
  }
  return -1;
}

function negativeRank(rule, key) {
  for (let i = 0; i < rule.negativeTiers.length; i++) {
    if (rule.negativeTiers[i].indexOf(key) !== -1) return i;
  }
  return -1;
}

/**
 * Grade a riven the way the community writes one down.
 *
 * "1cc 2cd 3ms -4z" reads as: this crit chance is the best stat available, this crit
 * damage is the second best, this multishot is third, and the zoom is a penalty.
 * The number after each is the rank position in the sheet's own ordering, so a stat
 * the sheet ranks first always shows 1 regardless of how large its roll is. Roll size
 * is deliberately not in here: a big roll of a third-rate stat is still a third-rate
 * stat, and that is the judgement the community is making.
 *
 * The score is for sorting only. It blends rank position with how close the roll is to
 * the best possible, because among two rivens that both want crit damage first, the
 * one closer to the ceiling is the better one and the notation alone will not say so.
 */
function gradeWithCommunityData(weaponEntry, stats, options) {
  const opts = options || {};
  const list = (stats || []).filter((s) => s && s.key);
  if (!list || !list.length) return null;

  const rule = selectRuleForStats(weaponEntry, list);
  if (!rule) {
    return {
      graded: false,
      reason: 'no-matching-rule',
      source: 'community',
      weaponClass: opts.weaponClass || '',
      notation: '',
      score: null,
      positiveRanks: [],
      negativeRanks: [],
      notes: (weaponEntry && weaponEntry.notes) || []
    };
  }

  /* A riven whose positives the sheet ranks nowhere has no verdict, and saying so is
   * the answer. Grading it produced the worst possible result: a Zaw riven with one
   * impact stat was written "imp" and scored 0, which reads as the worst riven you
   * own rather than as one this tool cannot judge. */
  const positivesPresent = list.filter((s) => s.isPositive);
  const anyRanked = positivesPresent.some((s) => positiveRank(rule, s.key) !== -1);
  if (!anyRanked) {
    return {
      graded: false,
      reason: 'no-ranked-positives',
      source: 'community',
      weaponClass: opts.weaponClass || '',
      notation: '',
      score: null,
      positiveRanks: [],
      negativeRanks: [],
      notes: (weaponEntry && weaponEntry.notes) || []
    };
  }

  const positives = list.filter((s) => s.isPositive);
  const negatives = list.filter((s) => !s.isPositive);

  const positiveRanks = positives.map((s) => ({
    key: s.key,
    name: need().rivenStatName(s.key) || s.name,
    value: s.value,
    rank: positiveRank(rule, s.key)
  })).sort((a, b) => {
    // -1 sorts last: an unranked positive is worse than any ranked one.
    if (a.rank === -1 && b.rank === -1) return 0;
    if (a.rank === -1) return 1;
    if (b.rank === -1) return -1;
    return a.rank - b.rank;
  });

  const negativeRanks = negatives.map((s) => ({
    key: s.key,
    name: need().rivenStatName(s.key) || s.name,
    value: s.value,
    rank: negativeRank(rule, s.key)
  })).sort((a, b) => {
    // For negatives a lower rank is the *better* penalty, so this is the same order.
    if (a.rank === -1 && b.rank === -1) return 0;
    if (a.rank === -1) return 1;
    if (b.rank === -1) return -1;
    return a.rank - b.rank;
  });

  /* Community notation: ranked positives in order, then the penalties.
   *
   * The number is the stat's tier in the sheet's own ordering, not a running counter.
   * The sheet ties stats deliberately, with "/", and the first attempt at this renumbered
   * them 1, 2, 3 as it walked the list, so a riven with damage and status chance tied
   * for third came out reading "1dmg 2sc" and claimed the first was the best stat on
   * the weapon. It is not. Ties share a number, and an unranked stat is written bare,
   * which is how the community writes a stat the sheet has no opinion on. */
  const parts = [];
  for (const p of positiveRanks) {
    parts.push(p.rank === -1 ? p.key.toLowerCase() : (p.rank + 1) + p.key.toLowerCase());
  }
  for (const q of negativeRanks) {
    parts.push('-' + (q.rank === -1 ? 0 : q.rank + 1) + q.key.toLowerCase());
  }
  const notation = parts.join(' ');

  /* Score, as two independent parts that are each 0-100 and then combined.
   *
   * The first attempt at this computed one running total where each stat added to both
   * a points figure and a possible figure. A riven rolled to the ceiling and the same
   * riven rolled to nothing both scored 50, because the quality term was diluted by the
   * stat count rather than moving the result. Two separately normalised halves cannot
   * cancel out like that.
   *
   * Rank: how good the stat combination is, per the sheet. Scored per tier rather than
   * per stat, so drawing three tied third-place stats is not punished for having drawn
   * three of them, and an unranked stat contributes nothing.
   *
   * Quality: how close each positive is to the largest it can reach. Only counted when
   * that maximum is actually knowable, so a stat with no known ceiling is left out of
   * this half rather than assumed to be full. */
  /* Rank: how good the stat combination is, per the sheet.
   *
   * Positives and penalties are scored in separate pools and then combined, rather than
   * added into one running total. The first version did the latter, and a riven with
   * three good positives and a penalty the sheet ranks highly came out at 31, which
   * called a 150% multishot shotgun riven "bad". An unranked penalty was subtracting a
   * full 100 from a pool that a single positive could only add 100 to, so one penalty
   * could erase three good stats. On this sheet the penalty is a cost, not a
   * disqualifier: a riven is rarely worthless for having zoom on it.
   *
   * So: the positives set the ceiling, and the penalty scales it down within a bounded
   * range. The first version's other failure is preserved deliberately, a stat the
   * sheet has no opinion on contributing nothing rather than an assumed middling value,
   * because that is what makes an all-unknown riven read as ungraded instead of
   * mediocre. */
  let positivePoints = 0;
  for (const p of positiveRanks) {
    if (p.rank === -1) continue;
    positivePoints += p.rank === 0 ? 100 : p.rank === 1 ? 74 : 48;
  }
  const positiveCount = positiveRanks.filter((p) => p.rank !== -1).length;
  const positiveScore = positiveCount > 0 ? positivePoints / (positiveCount * 100) : 0;

  // A penalty costs at most 30 points, and one the sheet ranks first barely counts,
  // because on this sheet that ranking means "this penalty is close to harmless".
  let penaltyScale = 0;
  if (negatives.length) {
    for (const q of negativeRanks) {
      penaltyScale += q.rank === -1 ? 1 : (q.rank === 0 ? 0.15 : q.rank === 1 ? 0.45 : 0.75);
    }
    // Two bad penalties are worse than one, but not twice as bad.
    penaltyScale = Math.min(1, penaltyScale / Math.max(1, negatives.length) + (negatives.length - 1) * 0.15);
    penaltyScale = Math.min(1, penaltyScale);
  }
  const rankScore = positiveCount > 0
    ? Math.max(0, Math.min(100, positiveScore * 100 * (1 - 0.3 * penaltyScale)))
    : 0;

  /* Roll quality, as a share of the largest this stat can reach.
   *
   * statMaxValue needs the weapon's disposition and a per-stat weight, both of which
   * come from the caller, because they depend on data this file does not hold. The
   * first version passed the stat count as the disposition, which made it return null
   * for every stat and quietly left this half of the score dead: a maxed riven and a
   * rolled-to-nothing one scored identically. Quality is skipped entirely when the
   * ceiling is unknown rather than assumed full, so a riven on a weapon with no
   * disposition is scored on rank alone instead of on a fabricated number. */
  const composition = need().rivenCompositionWeight(positives.length, negatives.length);
  const canMeasure = Boolean(opts.weaponClass) && Boolean(opts.disposition) && Boolean(composition);
  let qualityPoints = 0;
  let qualityPossible = 0;
  for (const p of positiveRanks) {
    if (!canMeasure) break;
    const weight = composition && composition.bonus ? composition.bonus : null;
    const max = need().statMaxValue(p.key, opts.weaponClass, opts.disposition, weight);
    if (max == null || !isFinite(max) || max <= 0) continue;
    // A good roll is most of the ceiling. Perfectness is measured against the best
    // possible roll, so 0.5 of the maximum is a middling roll and 1.0 is the best there
    // is; a square root keeps a decent roll from being punished too hard.
    const share = Math.max(0, Math.min(1, p.value / max));
    qualityPoints += Math.sqrt(share) * 100;
    qualityPossible += 100;
  }
  const qualityScore = qualityPossible > 0 ? (qualityPoints / qualityPossible) : null;

  /* Scaled so the full range is usable.
   *
   * As a raw share of the ceiling, a real roll sits around 0.45 to 0.65: a stat
   * between 45% and 65% of the largest it can be is an ordinary good roll, because
   * 100% of the ceiling is a once-in-a-lifetime perfect. Handing that straight to the
   * score meant a maxed riven and a rolled-to-nothing one differed by one point, which
   * is the difference between a number that means something and noise. This maps the
   * observed range onto 0-100: 30% of the ceiling reads as 0, 100% reads as 100, and
   * everything between is a straight line. */
  const usableQuality = qualityScore == null
    ? null
    : Math.max(0, Math.min(100, ((qualityScore - 0.3) / 0.7) * 100));

  // Rank decides what a riven is worth, quality decides how good a version of it was
  // rolled, so rank leads. Quality is a tiebreaker within a rank, not half the verdict.
  const score = usableQuality == null
    ? Math.round(rankScore)
    : Math.round(rankScore * 0.7 + usableQuality * 0.3);
  const finalScore = Math.max(0, Math.min(100, score));

  return {
    graded: true,
    source: 'community',
      notation,
      score: finalScore,
      rankScore: Math.round(rankScore),
      qualityScore: usableQuality == null ? null : Math.round(usableQuality),
      grade: scoreBand(finalScore),
      gradeLabel: scoreBandLabel(finalScore),
    positiveRanks,
    negativeRanks,
    weaponClass: opts.weaponClass || '',
    // The sheet's own reasoning, and on some weapons that reasoning is explicitly about
    // sale value rather than combat strength. Surfaced so the grade is not read as more
    // than it is.
    notes: (rule.notes && rule.notes.length ? rule.notes : (weaponEntry.notes || [])),
    priceOriented: /sale value|sells well|resell/i.test((rule.notes || []).join(' '))
  };
}

/* Bands, set against real rolls rather than picked to look tidy.
 *
 * Measured on photographed cards, a good riven scores around 45 and a very good one
 * around 75, because a stat sitting at 46% of its ceiling is a normal roll and not a
 * bad one. The first cut of these bands assumed 85 was reachable by an ordinary riven
 * and put everything real in the bottom two grades, which made the whole column read
 * as failure. These thresholds are where the real distribution actually falls. */
function scoreBand(score) {
  if (score >= 75) return 'S';
  if (score >= 60) return 'A';
  if (score >= 45) return 'B';
  if (score >= 30) return 'C';
  if (score > 0) return 'D';
  return 'unknown';
}

function scoreBandLabel(score) {
  if (score >= 75) return 'Great';
  if (score >= 60) return 'Good';
  if (score >= 45) return 'Fair';
  if (score >= 30) return 'Poor';
  if (score > 0) return 'Bad';
  return 'Ungraded';
}

module.exports = {
  setHost,
  COMMUNITY_SHEET_ID,
  COMMUNITY_SHEET_URL,
  parseCommunitySheet,
  parseRankedTiers,
  selectRuleForStats,
  gradeWithCommunityData,
  scoreBand,
  scoreBandLabel
};
