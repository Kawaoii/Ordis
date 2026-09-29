/**
 * Riven reference data: community grade matrix + live weapon metadata + grading.
 *
 * Sources (both plain HTTP, no scraping):
 *  - 44bananas / Xennethkeisere "good rolls" sheet, which is the exact data
 *    AlecaFrame uses for its Great/Good/OK/Bad grades:
 *    https://docs.google.com/spreadsheets/d/1zbaeJBuBn44cbVKzJins_E3hTDpnmvOk8heYN-G8yy8
 *  - Warframe.market v2 riven weapons for canonical names and disposition:
 *    https://api.warframe.market/v2/riven/weapons
 *
 * Disposition is rebalanced by Digital Extremes every Prime Access round, so it
 * is always read live from WFM rather than baked in.
 */

const RIVEN_GRADES_SHEET_ID = '1zbaeJBuBn44cbVKzJins_E3hTDpnmvOk8heYN-G8yy8';
const RIVEN_GRADES_SHEET_URL =
  'https://docs.google.com/spreadsheets/d/' + RIVEN_GRADES_SHEET_ID + '/export?format=csv&gid=0';
const RIVEN_WEAPONS_URL = 'https://api.warframe.market/v2/riven/weapons';

/* Second disposition source.
 *
 * Warframe.market's riven list is authoritative for rivenType and covers 420
 * weapons, but only 7 of those names contain "Prime" - Rubedo Prime, Soma Prime
 * and Toridak Prime are all absent, so their disposition, and therefore any
 * perfectness, is unknown. Riven.Market publishes 881 variant dispositions
 * including 189 Prime ones, which fills most of that gap.
 *
 * Neither source is complete for the newest weapons, so a missing disposition
 * is reported as missing rather than defaulted. Which source supplied a value
 * is recorded on the weapon so the UI can say where it came from. */
const RIVEN_DISPOSITIONS_FALLBACK_URL = 'https://rivens.wf/api/v1/weapons';

/* Name prefixes and suffixes that mark a variant rather than a distinct weapon
 * for the purposes of "which stats are good".
 *
 * The grade sheet is keyed on base weapon names, so a variant has to be mapped
 * back to one. This is deliberately a small list of families rather than a
 * rule: the sheet's judgement is per archetype, and a wrong strip would attach
 * one weapon's opinion to an unrelated weapon. Every strip is only accepted
 * when it actually lands on a real sheet entry, so a family that is not in the
 * sheet simply finds nothing and is reported as unknown.
 *
 * "Prime" covers Sisters of Parvos and Coda content too, because almost all of
 * it ships as a Prime variant of an existing weapon: Furis Prime, Nautilus
 * Prime, Thrax Prime, Parmelia Prime, Shuriken Prime and so on. The Kuva prefix
 * covers the lich family, where the sheet lists "Drakgoon" and the market lists
 * "Kuva Drakgoon". */
const RIVEN_SHEET_NAME_PREFIXES = ['kuva '];
const RIVEN_SHEET_NAME_SUFFIXES = [' prime'];

const RIVEN_DATA_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const RIVEN_FETCH_TIMEOUT_MS = 20000;

// Warframe.market asks clients to identify themselves with a descriptive
// User-Agent rather than impersonating a browser, and hides crossplay data
// unless it is requested explicitly.
const RIVEN_FETCH_HEADERS = {
  'Accept': 'text/csv,application/json',
  'User-Agent': 'Ordis (+https://github.com/Kawaoii/Ordis)',
  'Platform': 'pc',
  'Language': 'en',
  'Crossplay': 'true'
};

/**
 * Canonical stat keys follow the 44bananas sheet abbreviations so the community
 * matrix can be consumed without a translation layer. `display` is what the UI
 * shows. `base` is the attribute's base value per weapon class, transcribed from
 * the official wiki's Riven Mods base-value table:
 *   https://wiki.warframe.com/w/Riven_Mods
 *
 * The base values are published by Digital Extremes as documentation only; the
 * Public Export carries no riven attribute table (only `omegaAttenuation`, the
 * disposition), so they cannot be fetched from an official API and must be
 * transcribed. `verify-riven-bases.js` re-reads the wiki page and diffs it
 * against this table, so drift from a DE patch is detected rather than assumed
 * away. Do not hand-edit `base` without re-running that check.
 *
 * `base` is stored in the same unit the game displays, so a value of 45 means
 * "+45% Damage vs Corpus" (the wiki writes that row as x0.45).
 * A null/absent entry means the attribute cannot appear on that class at all.
 */
const RIVEN_STATS = {
  CD: { display: 'Critical Damage', base: { rifle: 120, shotgun: 90, pistol: 90, archgun: 80.1, melee: 90 }, aliases: ['crit damage', 'critical dmg'] },
  CC: { display: 'Critical Chance', base: { rifle: 149.99, shotgun: 90, pistol: 149.99, archgun: 99.9, melee: 180 }, aliases: ['crit chance', 'critical chance'] },
  DMG: { display: 'Damage', base: { rifle: 165, shotgun: 164.7, pistol: 219.6, archgun: 99.9, melee: 164.7 }, aliases: ['dmg', 'damage%'] },
  MS: { display: 'Multishot', base: { rifle: 90, shotgun: 119.7, pistol: 119.7, archgun: 60.3 }, aliases: ['multi shot', 'multishot'] },
  FR: { display: 'Fire Rate', base: { rifle: 60.03, shotgun: 90, pistol: 74.7, archgun: 60.03, melee: 54.9 }, aliases: ['fire rate', 'firerate'] },
  RLS: { display: 'Reload Speed', base: { rifle: 50, shotgun: 50, pistol: 50, archgun: 99.9 }, aliases: ['reload speed', 'reload'] },
  MAG: { display: 'Magazine Capacity', base: { rifle: 50, shotgun: 50, pistol: 50, archgun: 60.3 }, aliases: ['magazine capacity', 'magazine', 'mag'] },
  AMMO: { display: 'Ammo Maximum', base: { rifle: 49.95, shotgun: 90, pistol: 90, archgun: 99.9 }, aliases: ['ammo maximum', 'ammo max', 'ammo'] },
  REC: { display: 'Weapon Recoil', base: { rifle: 90, shotgun: 90, pistol: 90, archgun: 90 }, aliases: ['weapon recoil', 'recoil'] },
  TOX: { display: 'Toxin Damage', base: { rifle: 90, shotgun: 90, pistol: 90, archgun: 119.7, melee: 90 }, aliases: ['toxin damage', 'toxin', 'toxicity'] },
  HEAT: { display: 'Heat Damage', base: { rifle: 90, shotgun: 90, pistol: 90, archgun: 119.7, melee: 90 }, aliases: ['heat damage', 'heat'] },
  COLD: { display: 'Cold Damage', base: { rifle: 90, shotgun: 90, pistol: 90, archgun: 119.7, melee: 90 }, aliases: ['cold damage', 'cold'] },
  ELEC: { display: 'Electric Damage', base: { rifle: 90, shotgun: 90, pistol: 90, archgun: 119.7, melee: 90 }, aliases: ['electric damage', 'electricity', 'electric', 'elec'] },
  SLASH: { display: 'Slash Damage', base: { rifle: 119.97, shotgun: 119.97, pistol: 119.97, archgun: 90, melee: 119.7 }, aliases: ['slash damage', 'slash'] },
  IMP: { display: 'Impact Damage', base: { rifle: 119.97, shotgun: 119.97, pistol: 119.97, archgun: 90, melee: 119.7 }, aliases: ['impact damage', 'impact'] },
  PUNC: { display: 'Puncture Damage', base: { rifle: 119.97, shotgun: 119.97, pistol: 119.97, archgun: 90, melee: 119.7 }, aliases: ['puncture damage', 'puncture'] },
  // The wiki labels these "Damage vs X" while the game renders them "Damage to X"
  // (confirmed from a real reroll frame: "x1.55 Damage to Grineer"). Without the
  // in-game spelling these fall through to DMG's generic "damage" alias and get
  // graded against the Damage base instead of the much smaller faction base.
  DTC: { display: 'Damage vs Corpus', base: { rifle: 45, shotgun: 45, pistol: 45, archgun: 45, melee: 45 }, aliases: ['damage vs corpus', 'damage to corpus', 'vs corpus', 'to corpus', 'corpus'] },
  DTG: { display: 'Damage vs Grineer', base: { rifle: 45, shotgun: 45, pistol: 45, archgun: 45, melee: 45 }, aliases: ['damage vs grineer', 'damage to grineer', 'vs grineer', 'to grineer', 'grineer'] },
  DTI: { display: 'Damage vs Infested', base: { rifle: 45, shotgun: 45, pistol: 45, archgun: 45, melee: 45 }, aliases: ['damage vs infested', 'damage to infested', 'vs infested', 'to infested', 'infested'] },
  SD: { display: 'Status Duration', base: { rifle: 99.99, shotgun: 99.99, pistol: 99.99, archgun: 99.99, melee: 99.99 }, aliases: ['status duration'] },
  SC: { display: 'Status Chance', base: { rifle: 90, shotgun: 90, pistol: 90, archgun: 60.3, melee: 90 }, aliases: ['status chance'] },
  PT: { display: 'Punch Through', base: { rifle: 2.7, shotgun: 2.7, pistol: 2.7, archgun: 2.7 }, aliases: ['punch through', 'punch thru'] },
  PFS: { display: 'Projectile Flight Speed', base: { rifle: 90, shotgun: 90, pistol: 90 }, aliases: ['projectile flight speed', 'flight speed', 'projectile speed'] },
  ZOOM: { display: 'Zoom', base: { rifle: 59.99, pistol: 80.1, archgun: 59.99 }, aliases: ['zoom', 'zoom in', 'ads speed'] },
  RANGE: { display: 'Range', base: { melee: 1.94 }, aliases: ['range'] },
  IC: { display: 'Initial Combo', base: { melee: 24.5 }, aliases: ['initial combo', 'combo count'] },
  ACC: { display: 'Additional Combo Count', base: { melee: 58.77 }, aliases: ['additional combo count', 'extra combo count'] },
  CDUR: { display: 'Combo Duration', base: { melee: 8.1 }, aliases: ['combo duration'] },
  AS: { display: 'Attack Speed', base: { melee: 54.9 }, aliases: ['attack speed', 'melee attack speed'] },
  EFF: { display: 'Heavy Attack Efficiency', base: { melee: 73.44 }, aliases: ['heavy attack efficiency', 'attack efficiency'] },
  FIN: { display: 'Finisher Damage', base: { melee: 119.7 }, aliases: ['finisher damage', 'finisher'] },
  SCC: { display: 'Critical Chance for Slide Attack', base: { melee: 120 }, aliases: ['critical chance for slide attack', 'slide attack critical chance', 'slide crit'] },

  // Channeling Damage and Channeling Efficiency are real riven attributes: they
  // appear on live orders (26 and 8 respectively in a 768-riven sample) and the
  // wiki lists them with the name prefixes Tori/Bo and Uti/Tia. The wiki has not
  // published a base value for either, on any weapon class, so there is no `base`
  // here. That makes statMaxValue return null and perfectness report unknown for
  // these two rather than inventing a ceiling. Do not add a base without a
  // published value to check it against.
  CHD: { display: 'Channeling Damage', aliases: ['channeling damage'] },
  CHE: { display: 'Channeling Efficiency', aliases: ['channeling efficiency'] }
};

/**
 * Canonical Warframe.market `url_name` for each stat.
 *
 * These are the identifiers the game and the market actually use, so they are
 * matched exactly before any prose alias is tried. Relying on the prose aliases
 * alone was not good enough: `critical_chance_on_slide_attack` missed every
 * alias and then fell through prefix matching to the shorter `critical chance`,
 * silently resolving Critical Chance for Slide Attack as plain Critical Chance
 * and grading the two with different ceilings. Exact names close that whole
 * class of mis-resolution.
 *
 * FR and AS share one url_name because the game ships a single
 * `fire_rate_/_attack_speed` entry for both columns. FR is listed first so it
 * wins the exact match; the parser picks AS from the resolved weapon class.
 */
const RIVEN_WFM_NAMES = {
  CD: 'critical_damage',
  CC: 'critical_chance',
  SCC: 'critical_chance_on_slide_attack',
  DMG: 'base_damage_/_melee_damage',
  MS: 'multishot',
  FR: 'fire_rate_/_attack_speed',
  AS: 'attack_speed',
  RLS: 'reload_speed',
  MAG: 'magazine_capacity',
  AMMO: 'ammo_maximum',
  REC: 'recoil',
  TOX: 'toxin_damage',
  HEAT: 'heat_damage',
  COLD: 'cold_damage',
  ELEC: 'electric_damage',
  SLASH: 'slash_damage',
  IMP: 'impact_damage',
  PUNC: 'puncture_damage',
  DTC: 'damage_vs_corpus',
  DTG: 'damage_vs_grineer',
  DTI: 'damage_vs_infested',
  SD: 'status_duration',
  SC: 'status_chance',
  PT: 'punch_through',
  PFS: 'projectile_speed',
  ZOOM: 'zoom',
  RANGE: 'range',
  IC: 'initial_combo',
  ACC: 'chance_to_gain_extra_combo_count',
  CDUR: 'combo_duration',
  EFF: 'heavy_attack_efficiency',
  FIN: 'finisher_damage',
  CHD: 'channeling_damage',
  CHE: 'channeling_efficiency'
};

/**
 * The one attribute the game models as both a bonus and a curse, so it appears
 * on the market under two url_names.
 */
const RIVEN_WFM_ALIAS_NAMES = {
  ACC: ['chance_to_gain_combo_count']
};

/**
 * Riven attribute value formula, from the official wiki:
 *   https://wiki.warframe.com/w/Riven_Mods#Attribute_Value_Formula
 *
 *   value = base_value * U(0.90, 1.10) * disposition * weight
 *
 * `weight` depends on how many positive and negative attributes the riven
 * happens to have, which is why it cannot be a fixed per-stat coefficient.
 * A two-positive riven rolls the highest numbers, which is the community's
 * reason for pricing them separately.
 */
const RIVEN_ROLL_SPREAD_MAX = 1.10;

const RIVEN_ROLL_WEIGHTS = {
  '2+0': { bonus: 0.99, malus: 0 },
  '2+1': { bonus: 1.2375, malus: -0.495 },
  '3+0': { bonus: 0.75, malus: 0 },
  '3+1': { bonus: 0.9375, malus: -0.75 }
};

/**
 * Weight for a riven with the given number of positive and negative attributes.
 * Returns null for a composition the game cannot produce, so callers report an
 * unknown perfectness instead of inventing a number.
 */
function rivenCompositionWeight(positiveCount, negativeCount) {
  const weights = RIVEN_ROLL_WEIGHTS[positiveCount + '+' + negativeCount];
  return weights ? weights : null;
}

/**
 * Map a Warframe.market `rivenType` onto the wiki's base-value column.
 *
 * WFM's type is the better signal in most cases: it correctly separates
 * shotguns, Zaws and Kitguns that Digital Extremes' own `productCategory`
 * lumps into `Pistols`/`LongGuns` (Strun and Sobek are `Pistols`/`LongGuns` in
 * the Public Export but really are shotguns). The exception is Archguns, which
 * WFM reports as `rifle`; those are corrected from uniqueName below.
 *
 * `kitgun` maps to null on purpose: the wiki publishes no Kitgun column, and
 * guessing one would be exactly the kind of confident wrong answer this module
 * exists to avoid.
 */
const RIVEN_TYPE_TO_CLASS = {
  rifle: 'rifle',
  shotgun: 'shotgun',
  pistol: 'pistol',
  archgun: 'archgun',
  melee: 'melee',
  zaw: 'melee'
};

/**
 * Archgun gameRefs, transcribed from the Public Export
 * (`productCategory === 'SpaceGuns'`, intersected with the WFM riven weapon
 * list). WFM reports all 15 of these as `rifle`, but they use the Archgun
 * base-value column. Stored as exact gameRefs so a name collision cannot
 * misclassify anything, and so the list can be re-derived and diffed offline
 * the same way the base values are.
 */
const RIVEN_ARCHGUN_REFS = new Set([
  '/Lotus/Weapons/Grineer/HeavyWeapons/GrnHeavyGrenadeLauncher',
  '/Lotus/Weapons/Tenno/Archwing/Primary/ArchBurstGun/ArchBurstGun',
  '/Lotus/Weapons/Tenno/Archwing/Primary/ArchLongRifle/ArchLongRifle',
  '/Lotus/Weapons/Tenno/Archwing/Primary/ArchwingHeavyPistols/ArchHeavyPistols',
  '/Lotus/Weapons/Tenno/Archwing/Primary/FoldingMachineGun/ArchMachineGun',
  '/Lotus/Weapons/Tenno/Archwing/Primary/LaunchGrenade/ArchCannon',
  '/Lotus/Weapons/Tenno/Archwing/Primary/NokkoArchGun/NokkoArchGun',
  '/Lotus/Weapons/Tenno/Archwing/Primary/Railgun/ArchRailgun',
  '/Lotus/Weapons/Tenno/Archwing/Primary/RepurposedGrineerAntiAircraftGun/ArchGRNAAGun',
  '/Lotus/Weapons/Tenno/Archwing/Primary/RocketArtillery/ArchRocketCrossbow',
  '/Lotus/Weapons/Tenno/Archwing/Primary/ThanoTechArchGun/ThanoTechArchGun',
  '/Lotus/Weapons/Tenno/Archwing/Primary/ThanoTechArchLongGun/ThanoTechLongGun',
  '/Lotus/Weapons/Tenno/Archwing/Primary/ThanoTechGrenadeLaunch/ThanoTechGrenadeLauncher',
  '/Lotus/Weapons/Tenno/Archwing/Primary/TnConcreteArchgun/TnConcreteArchgunWeapon',
  '/Lotus/Weapons/Tenno/Archwing/Primary/TnShieldframeArchGun/TnShieldFrameArchGun'
]);

/**
 * Resolve which base-value column a weapon uses, or null when unknown.
 */
function resolveWeaponClass(weapon) {
  if (!weapon) return null;
  if (weapon.gameRef && RIVEN_ARCHGUN_REFS.has(weapon.gameRef)) return 'archgun';
  const type = String(weapon.rivenType || '').toLowerCase();
  return RIVEN_TYPE_TO_CLASS[type] || null;
}

/**
 * Update 44 (Iceblade of Narin) added Riven Splicing: two traits merge into one
 * combo trait that is always positive, counts as locked, and survives cycling.
 * 22 recipes produce these 18 distinct traits.
 *
 * Each entry is a list of recipes, because some combo traits can be made from
 * more than one pair. A combo is only worth what the traits it replaced are
 * worth, so it is graded through whichever recipe actually matches.
 */
const RIVEN_SPLICE_TRAITS = {
  'Heavy Attack Damage': [['EFF', 'ACC']],
  'Heavy Attack Windup Speed': [['EFF', 'CDUR']],
  'Parry Angle': [['AS', 'RANGE']],
  'Slam Damage': [['DMG', 'AS']],
  'Weakpoint Damage': [['DMG', 'ZOOM'], ['DMG', 'MS']],
  'Weakpoint Critical Chance': [['CC', 'ZOOM'], ['CC', 'MS']],
  'Ammo Efficiency': [['MAG', 'RLS'], ['REC', 'AMMO']],
  'Magazine Reload While Holstered': [['RLS', 'MAG'], ['AMMO', 'MAG']],
  'Status Damage': [['DMG', 'SC']],
  'Gas': [['TOX', 'HEAT']],
  'Corrosive': [['TOX', 'ELEC']],
  'Viral': [['TOX', 'COLD']],
  'Radiation': [['HEAT', 'ELEC']],
  'Blast': [['HEAT', 'COLD']],
  'Magnetic': [['ELEC', 'COLD']],
  'Damage vs Orokin': [['DTC', 'DTG']],
  'Damage vs Techrot': [['DTC', 'DTI']],
  'Damage vs Scaldra': [['DTI', 'DTG']]
};

/** Extra phrasings Tesseract produces for the combo traits. */
const RIVEN_SPLICE_TRAIT_ALIASES = {
  'Heavy Attack Damage': ['heavy attack damage', 'heavy dmg'],
  'Heavy Attack Windup Speed': ['heavy attack windup speed', 'heavy windup speed', 'windup speed'],
  'Parry Angle': ['parry angle', 'parry'],
  'Slam Damage': ['slam damage'],
  'Weakpoint Damage': ['weakpoint damage', 'weak point damage', 'wp damage'],
  'Weakpoint Critical Chance': [
    'weakpoint critical chance', 'weak point critical chance', 'wp crit chance', 'weakpoint crit chance'
  ],
  'Ammo Efficiency': ['ammo efficiency'],
  'Magazine Reload While Holstered': [
    'magazine reload while holstered', 'mag reload while holstered', 'reload while holstered'
  ],
  'Status Damage': ['status damage'],
  'Gas': ['gas'],
  'Corrosive': ['corrosive'],
  'Viral': ['viral'],
  'Radiation': ['radiation'],
  'Blast': ['blast'],
  'Magnetic': ['magnetic'],
  'Damage vs Orokin': ['damage vs orokin', 'vs orokin', 'orokin'],
  'Damage vs Techrot': ['damage vs techrot', 'vs techrot', 'techrot'],
  'Damage vs Scaldra': ['damage vs scaldra', 'vs scaldra', 'scaldra']
};

const RIVEN_SPLICE_TRAIT_KEYS = Object.keys(RIVEN_SPLICE_TRAITS);

/**
 * Grades are banded so the numeric score can never contradict the label: a Bad
 * riven always scores below an Ok one, and so on. These mirror the
 * RIVEN_OVERLAY_GRADE_THRESHOLDS already declared in main.js.
 */
const RIVEN_GRADE_BANDS = {
  great: { min: 80 },
  good: { min: 60 },
  ok: { min: 40 },
  bad: { min: 0 }
};

const RIVEN_GRADES = ['great', 'good', 'ok', 'bad'];

function normalizeRivenName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Minimal RFC4180 parser: the sheet quotes notes fields that contain commas. */
function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

/**
 * A positive cell encodes one or more acceptable combinations separated by
 * "or". Within a combination, whitespace separates groups: a lone stat is a
 * must-have, and a slash-joined group means "pick from these".
 */
function parsePositiveCombinations(cell) {
  const alternatives = [];
  for (const chunk of String(cell || '').split(/\s+or\s+/i)) {
    if (!chunk.trim()) continue;

    const must = [];
    const options = [];
    for (const token of chunk.trim().split(/\s+/)) {
      const stats = token.split('/').map(s => s.trim().toUpperCase()).filter(Boolean);
      if (!stats.length) continue;
      if (stats.length === 1) {
        must.push(stats[0]);
      } else {
        options.push(stats);
      }
    }
    if (must.length || options.length) alternatives.push({ must, options });
  }
  return alternatives;
}

function parseNegativeList(cell) {
  return String(cell || '')
    .split('/')
    .map(s => s.trim().toUpperCase())
    .filter(Boolean);
}

const RIVEN_SHEET_EXPECTED_HEADER = {
  0: 'WEAPON',
  1: 'POSITIVE STATS',
  5: 'NEGATIVE STATS'
};

function parseRivenGradeSheet(csvText) {
  const rows = parseCsvRows(csvText);
  if (!rows.length) throw new Error('Riven grade sheet was empty.');

  // The column layout is positional, so a reordered sheet would silently grade
  // every weapon against the wrong column. Fail loudly instead.
  const header = rows[0];
  for (const [index, expected] of Object.entries(RIVEN_SHEET_EXPECTED_HEADER)) {
    const actual = String(header[index] || '').trim().toUpperCase();
    if (actual.indexOf(expected) !== 0) {
      throw new Error(
        'Riven grade sheet layout changed: expected column ' + index + ' to start with "' + expected +
        '" but found "' + actual + '". Refusing to parse rather than mis-grade.'
      );
    }
  }

  const grades = new Map();
  for (const row of rows.slice(1)) {
    const name = String(row[0] || '').trim();
    if (!name) continue;

    const key = normalizeRivenName(name);
    if (!key) continue;

    const combinations = parsePositiveCombinations(row[1]);
    if (!combinations.length) continue;

    const goodStats = new Set();
    for (const alt of combinations) {
      for (const stat of alt.must) goodStats.add(stat);
      for (const group of alt.options) for (const stat of group) goodStats.add(stat);
    }

    grades.set(key, {
      sheetName: name,
      combinations: combinations,
      goodStats: Array.from(goodStats),
      acceptableNegatives: parseNegativeList(row[5]),
      notes: String(row[8] || '').trim().replace(/^\(?NOTE:\s*/i, '').replace(/\)$/, '').trim()
    });
  }

  return grades;
}

/**
 * Which stats does the community matrix actually have an opinion about?
 *
 * A stat that is "good" for zero of the graded weapons is not a stat the matrix
 * rejects, it is a stat the matrix never covers. The sheet has no melee rows at
 * all, so every melee-only stat (attack speed, heavy attack efficiency, initial
 * combo, combo duration, range, finisher damage, slide-attack critical chance)
 * scores zero coverage. Reading that silence as "bad" would hand a confident
 * wrong answer to every melee player, so uncovered stats are reported as a
 * coverage gap instead.
 */
function computeStatCoverage(grades) {
  const goodCounts = new Map();
  let total = 0;

  for (const grade of grades.values()) {
    total += 1;
    for (const stat of grade.goodStats) {
      goodCounts.set(stat, (goodCounts.get(stat) || 0) + 1);
    }
  }

  const uncovered = [];
  for (const key of Object.keys(RIVEN_STATS)) {
    if (!goodCounts.has(key)) uncovered.push(key);
  }
  return { uncovered: uncovered, total: total };
}

/**
 * How often is each negative stat tolerated across the graded weapons?
 *
 * The sheet states, per weapon, which negatives are harmless. A negative absent
 * from a weapon's list is not harmless *for that weapon*, which is the only
 * claim the data actually supports. Tallying tolerance across all weapons gives
 * useful context ("only 11 of 113 weapons tolerate -Ammo Maximum") without
 * inventing a global good/bad verdict the community never made.
 */
function computeNegativeTolerance(grades) {
  const toleratedBy = new Map();
  let total = 0;

  for (const grade of grades.values()) {
    total += 1;
    const seen = new Set(grade.acceptableNegatives);
    for (const stat of seen) {
      toleratedBy.set(stat, (toleratedBy.get(stat) || 0) + 1);
    }
  }

  const tolerance = {};
  for (const [stat, count] of toleratedBy) {
    tolerance[stat] = { toleratedBy: count, total: total, share: total ? count / total : 0 };
  }
  return { tolerance: tolerance, total: total };
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RIVEN_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, Object.assign({ signal: controller.signal }, options));
    if (!response.ok) throw new Error('HTTP ' + response.status + ' for ' + url);
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

let rivenDataCache = null;
let rivenDataCacheFetchedAt = 0;

/**
 * Resolve one OCR stat name to a canonical key. Handles plain stats, the 18
 * splice combo traits, and the loose phrasing Tesseract tends to produce.
 */
function normalizeStatPhrase(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

let rivenStatLookup = null;

function getRivenStatLookup() {
  if (rivenStatLookup) return rivenStatLookup;

  const exact = new Map();
  const prefix = [];

  for (const [key, meta] of Object.entries(RIVEN_STATS)) {
    // Canonical market/game names first so they cannot be shadowed by a prose
    // alias that happens to normalise to the same phrase.
    const canonical = [RIVEN_WFM_NAMES[key]].concat(RIVEN_WFM_ALIAS_NAMES[key] || []);
    const names = canonical.filter(Boolean).concat([key, meta.display], meta.aliases || []);
    for (const name of names) {
      const phrase = normalizeStatPhrase(name);
      if (phrase && !exact.has(phrase)) exact.set(phrase, key);
    }
  }

  for (const [trait, recipes] of Object.entries(RIVEN_SPLICE_TRAITS)) {
    const names = [trait].concat(RIVEN_SPLICE_TRAIT_ALIASES[trait] || []);
    for (const name of names) {
      const phrase = normalizeStatPhrase(name);
      if (phrase && !exact.has(phrase)) exact.set(phrase, trait);
    }
  }

  for (const [phrase, key] of exact) {
    if (phrase.length >= 4) prefix.push({ phrase: phrase, key: key });
  }
  prefix.sort((a, b) => b.phrase.length - a.phrase.length);

  rivenStatLookup = { exact: exact, prefix: prefix };
  return rivenStatLookup;
}

function resolveRivenStatKey(rawName) {
  const phrase = normalizeStatPhrase(rawName);
  if (!phrase) return null;

  const lookup = getRivenStatLookup();

  if (lookup.exact.has(phrase)) return lookup.exact.get(phrase);

  // Tesseract sometimes truncates or drops a trailing word, e.g. "Ammo Ma".
  for (const entry of lookup.prefix) {
    if (phrase.length >= 4 && (entry.phrase.startsWith(phrase) || phrase.startsWith(entry.phrase))) {
      return entry.key;
    }
  }

  return null;
}

function isSpliceTrait(key) {
  return Object.prototype.hasOwnProperty.call(RIVEN_SPLICE_TRAITS, key);
}

/**
 * A combo trait is graded through its recipes. It counts as good when every
 * component of at least one recipe is good for this weapon, since a player may
 * have built the combo from whichever pairing was good for them.
 */
function evaluateSpliceTrait(key, goodStats) {
  const recipes = RIVEN_SPLICE_TRAITS[key] || [];
  if (!recipes.length) return { good: false, recipes: [], matchingRecipes: [] };

  const matchingRecipes = recipes.filter(recipe =>
    recipe.every(component => goodStats.has(component))
  );

  return { recipes: recipes, good: matchingRecipes.length > 0, matchingRecipes: matchingRecipes };
}

async function getRivenData(options) {
  const now = Date.now();
  if (!options || options.force !== true) {
    if (rivenDataCache && now - rivenDataCacheFetchedAt < RIVEN_DATA_CACHE_TTL_MS) {
      return rivenDataCache;
    }
  }

  const [sheetResponse, weaponsResponse] = await Promise.all([
    fetchWithTimeout(RIVEN_GRADES_SHEET_URL, { headers: { 'User-Agent': RIVEN_FETCH_HEADERS['User-Agent'] } }),
    fetchWithTimeout(RIVEN_WEAPONS_URL, { headers: RIVEN_FETCH_HEADERS })
  ]);

  const [csvText, weaponsPayload, fallbackPayload] = await Promise.all([
    sheetResponse.text(),
    weaponsResponse.json(),
    // A failure here is not fatal. It only widens the set of weapons with a
    // known disposition, and the first source has already answered.
    fetchWithTimeout(RIVEN_DISPOSITIONS_FALLBACK_URL, { headers: RIVEN_FETCH_HEADERS })
      .then((res) => (res && res.ok ? res.json() : null))
      .catch(() => null)
  ]);

  const sheetGrades = parseRivenGradeSheet(csvText);
  const weaponList = Array.isArray(weaponsPayload) ? weaponsPayload : (weaponsPayload.data || []);
  const weapons = new Map();

  for (const entry of weaponList) {
    const name = entry && entry.i18n && entry.i18n.en ? entry.i18n.en.name : '';
    const key = normalizeRivenName(name);
    if (!key) continue;

    const disposition = Number(entry.disposition);
    weapons.set(key, {
      name: name,
      slug: entry.slug || '',
      gameRef: entry.gameRef || '',
      group: entry.group || '',
      rivenType: entry.rivenType || '',
      icon: (entry.i18n.en && (entry.i18n.en.icon || entry.i18n.en.thumb)) || '',
      reqMasteryRank: Number.isFinite(Number(entry.reqMasteryRank)) ? Number(entry.reqMasteryRank) : 0,
      disposition: Number.isFinite(disposition) && disposition > 0 ? disposition : 0,
      dispositionSource: Number.isFinite(disposition) && disposition > 0 ? 'warframe.market' : ''
    });
  }

  /* Fold in the fallback dispositions.
   *
   * Riven.Market keys dispositions by variant name inside each weapon, so
   * "Soma" carries both Soma and Soma Prime. Warframe.market's own entry wins
   * where both have the weapon, because it is the source the market itself
   * prices against; the fallback only fills weapons Warframe.market does not
   * list at all, or lists without a disposition. */
  const fallbackList = fallbackPayload && Array.isArray(fallbackPayload.weapons) ? fallbackPayload.weapons : [];
  const fallbackOnly = [];

  for (const entry of fallbackList) {
    const variants = entry && entry.variants && typeof entry.variants === 'object' ? entry.variants : {};
    for (const variantName of Object.keys(variants)) {
      const key = normalizeRivenName(variantName);
      const disposition = Number(variants[variantName]);
      if (!key || !Number.isFinite(disposition) || disposition <= 0) continue;

      const existing = weapons.get(key);
      if (existing && existing.disposition > 0) continue;

      if (existing) {
        existing.disposition = disposition;
        existing.dispositionSource = 'rivens.wf';
        continue;
      }

      // Type is only a hint here. Riven.Market spells its types in title case
      // ("Rifle", "Pistol") and includes Archgun and Zaw, which the market's
      // rivenType enum does not.
      const rivenType = String(entry.type || '').toLowerCase();
      const known = ['rifle', 'pistol', 'shotgun', 'melee', 'kitgun', 'zaw', 'archgun'];
      weapons.set(key, {
        name: variantName,
        slug: '',
        gameRef: entry.id || '',
        group: entry.displayName || '',
        rivenType: known.indexOf(rivenType) === -1 ? '' : rivenType,
        icon: '',
        reqMasteryRank: 0,
        disposition: disposition,
        dispositionSource: 'rivens.wf'
      });
      fallbackOnly.push(variantName);
    }
  }


  const negativeTolerance = computeNegativeTolerance(sheetGrades);
  const statCoverage = computeStatCoverage(sheetGrades);

  const merged = new Map();
  for (const [key, weapon] of weapons) {
    let grade = sheetGrades.get(key) || null;
    let communityDataFrom = grade ? 'own' : '';

    /* The 44bananas sheet is keyed on base weapon names: 114 rows, of which two
     * contain "Prime". So a Prime variant has no entry of its own, and grading
     * it against nothing produced "unknown, score 0" for every Prime riven -
     * which is the whole population of current content.
     *
     * A Prime variant is the same archetype as its base weapon, and the sheet's
     * judgement of which stats are good is driven by the archetype, so the base
     * entry is a far better answer than no answer. It is recorded as
     * `base-weapon` so the UI can say the grade came from the base weapon
     * rather than implying it was measured on the Prime.
     *
     * The same reasoning covers the "Kuva X" family, where the sheet lists the
     * base weapon ("Drakgoon", "Karak") and the market lists the Kuva-prefixed
     * copy. Both are the same weapon with a different drop source, so the
     * family prefix is stripped too. */
    if (!grade) {
      const fallbacks = [];
      for (const suffix of RIVEN_SHEET_NAME_SUFFIXES) {
        if (key.endsWith(suffix)) fallbacks.push(key.slice(0, -suffix.length).trim());
      }
      for (const prefix of RIVEN_SHEET_NAME_PREFIXES) {
        if (key.startsWith(prefix)) fallbacks.push(key.slice(prefix.length).trim());
        // "Kuva Bramma Prime" is both; stripping the suffix first then the
        // prefix reaches "Bramma".
        const withoutPrefix = key.slice(prefix.length).trim();
        for (const suffix of RIVEN_SHEET_NAME_SUFFIXES) {
          if (withoutPrefix.endsWith(suffix)) {
            fallbacks.push(withoutPrefix.slice(0, -suffix.length).trim());
          }
        }
      }
      for (const candidate of fallbacks) {
        if (!candidate || candidate === key) continue;
        const baseGrade = sheetGrades.get(candidate);
        if (baseGrade) {
          grade = baseGrade;
          communityDataFrom = 'base-weapon';
          break;
        }
      }
    }

    merged.set(key, Object.assign({}, weapon, {
      hasCommunityData: Boolean(grade),
      communityDataFrom: communityDataFrom,
      communityDataWeapon: communityDataFrom === 'base-weapon' && grade ? grade.sheetName : '',
      combinations: grade ? grade.combinations : [],
      goodStats: grade ? grade.goodStats : [],
      acceptableNegatives: grade ? grade.acceptableNegatives : [],
      negativeTolerance: negativeTolerance.tolerance,
      uncoveredStats: statCoverage.uncovered,
      notes: grade ? grade.notes : ''
    }));
  }

  // Weapons with no disposition from either source. A riven for one of these
  // cannot have its perfectness computed, and the UI has to say so rather than
  // quietly showing 0% or a number borrowed from the base weapon.
  const missingDisposition = [];
  for (const [key, weapon] of merged) {
    if (!(weapon.disposition > 0)) missingDisposition.push(weapon.name || key);
  }

  rivenDataCache = {
    weapons: merged,
    statsWithCommunityData: sheetGrades.size,
    weaponsTotal: merged.size,
    weaponsFromFallback: fallbackOnly.length,
    missingDisposition: missingDisposition.sort(),
    negativeTolerance: negativeTolerance.tolerance,
    negativeToleranceTotal: negativeTolerance.total,
    uncoveredStats: statCoverage.uncovered,
    fetchedAt: now,
    sources: {
      grades: RIVEN_GRADES_SHEET_URL,
      weapons: RIVEN_WEAPONS_URL,
      weaponsFallback: RIVEN_DISPOSITIONS_FALLBACK_URL,
      weaponsFallbackAvailable: fallbackList.length > 0
    }
  };
  rivenDataCacheFetchedAt = now;
  return rivenDataCache;
}

function getCachedRivenData() {
  return rivenDataCache;
}

/**
 * Resolve an OCR'd weapon name to a weapon record.
 *
 * The result carries how the name was matched, because a fuzzy match silently
 * grading the wrong weapon is worse than reporting no grade at all. Exact and
 * unique-prefix matches are safe; an ambiguous prefix is refused.
 */
function findRivenWeapon(data, rawName) {
  const empty = { weapon: null, matched: false, exact: false, ambiguous: false, reason: 'no-data' };
  if (!data || !data.weapons) return empty;

  const key = normalizeRivenName(rawName);
  if (!key) return Object.assign({}, empty, { reason: 'empty-name' });

  if (data.weapons.has(key)) {
    return { weapon: data.weapons.get(key), matched: true, exact: true, ambiguous: false, reason: 'exact' };
  }

  const prefixHits = [];
  for (const [candidateKey, weapon] of data.weapons) {
    if (candidateKey.startsWith(key + ' ') || key.startsWith(candidateKey + ' ')) {
      prefixHits.push(weapon);
    }
  }

  if (prefixHits.length === 1) {
    return { weapon: prefixHits[0], matched: true, exact: false, ambiguous: false, reason: 'unique-prefix' };
  }
  if (prefixHits.length > 1) {
    return Object.assign({}, empty, { ambiguous: true, reason: 'ambiguous-prefix' });
  }
  return Object.assign({}, empty, { reason: 'not-found' });
}

/**
 * Highest value a single attribute can reach on this weapon, in the unit the
 * game displays (120 means +120%).
 *
 * Returns null when the maximum is not knowable, rather than a guessed number:
 * an unknown weapon class, an attribute that cannot appear on that class, or a
 * stat count the game cannot produce. Callers surface that as an unknown
 * perfectness rather than a misleading percentage.
 */
function statMaxValue(key, weaponClass, disposition, weight) {
  const meta = RIVEN_STATS[key];
  if (!meta || !meta.base) return null;
  const base = meta.base[weaponClass];
  if (base == null) return null;
  if (!(disposition > 0) || !(weight > 0)) return null;
  return base * RIVEN_ROLL_SPREAD_MAX * disposition * weight;
}

/**
 * Grade a parsed riven against its weapon.
 *
 * `stats` entries look like { key, value, isPositive } where value is the
 * in-game percentage (120 means +120%).
 *
 * Grade semantics mirror AlecaFrame: Great needs every positive to be a stat the
 * community considers good plus a harmless negative; Bad means nothing helps or
 * the negative is actively harmful.
 */
function gradeRiven(weapon, stats) {
  const list = Array.isArray(stats) ? stats : [];
  const positives = list.filter(s => s && s.isPositive);
  const negatives = list.filter(s => s && !s.isPositive);

  const hasCommunityData = Boolean(weapon && weapon.hasCommunityData);
  const goodStats = new Set(weapon && weapon.goodStats ? weapon.goodStats : []);
  const acceptableNegatives = new Set(weapon && weapon.acceptableNegatives ? weapon.acceptableNegatives : []);

  const evaluated = list.map(stat => {
    const key = stat.key;
    const splice = isSpliceTrait(key) ? evaluateSpliceTrait(key, goodStats) : null;
    let good;
    if (splice) {
      good = splice.good;
    } else if (!hasCommunityData) {
      good = null;
    } else {
      good = goodStats.has(key);
    }
    return { stat: stat, key: key, good: good, splice: splice };
  });

  const positiveResults = evaluated.filter(e => e.stat.isPositive);
  const negativeResults = evaluated.filter(e => !e.stat.isPositive);
  const goodPositiveCount = positiveResults.filter(e => e.good === true).length;
  const badPositiveCount = positiveResults.filter(e => e.good === false).length;

  const negative = negativeResults[0] || null;
  let negativeVerdict = 'none';
  if (negative) {
    if (!hasCommunityData) {
      negativeVerdict = 'unknown';
    } else if (acceptableNegatives.has(negative.key)) {
      negativeVerdict = 'acceptable';
    } else {
      negativeVerdict = 'unlisted';
    }
  }

  // Informational only: never changes the grade, because the community data does
  // not make a global claim about any negative.
  const tolerance = weapon && weapon.negativeTolerance ? weapon.negativeTolerance[negative ? negative.key : ''] : null;

  let satisfiedCombination = null;
  if (hasCommunityData) {
    for (const alt of weapon.combinations) {
      const mustOk = alt.must.every(stat => positiveResults.some(p => p.key === stat));
      if (!mustOk) continue;
      const optionsOk = alt.options.every(group =>
        group.some(stat => positiveResults.some(p => p.key === stat))
      );
      if (optionsOk) {
        satisfiedCombination = alt;
        break;
      }
    }
  }

  const disposition = weapon && weapon.disposition ? weapon.disposition : 0;
  const weaponClass = resolveWeaponClass(weapon);
  const weights = rivenCompositionWeight(positives.length, negatives.length);
  const bonusWeight = weights ? weights.bonus : null;
  const malusWeight = weights ? Math.abs(weights.malus) : null;

  // Only counted when the class and layout are both known, so an unknown class
  // is still reported as such instead of every stat looking unpublished.
  const canMeasure = Boolean(weaponClass) && Boolean(weights);

  const unmeasured = [];
  const perfectnessParts = evaluated.map(e => {
    if (isSpliceTrait(e.key)) return null;
    const isPositiveStat = Boolean(e.stat.isPositive);
    const weight = isPositiveStat ? bonusWeight : malusWeight;
    const max = statMaxValue(e.key, weaponClass, disposition, weight);
    if (max == null) {
      if (canMeasure) unmeasured.push(e.key);
      return null;
    }
    const magnitude = Math.abs(Number(e.stat.value) || 0);
    return { key: e.key, value: e.stat.value, max: Math.round(max * 10) / 10, ratio: magnitude / max };
  }).filter(Boolean);

  // null, not a number: an uncomputable perfectness is missing information, and
  // reporting it as zero would read as "every roll is terrible".
  //
  // A single unmeasurable stat invalidates the whole figure rather than being
  // averaged away. Perfectness computed from one of two stats still looks like a
  // complete assessment of the riven, which is the confident wrong answer this
  // module exists to avoid.
  const perfectness = (perfectnessParts.length && !unmeasured.length)
    ? perfectnessParts.reduce((total, part) => total + Math.min(1, part.ratio), 0) / perfectnessParts.length
    : null;
  const perfectnessKnown = perfectness !== null;

  let grade = 'unknown';
  const reasons = [];

  // A stat no graded weapon considers good is outside the matrix, not bad. The
  // common case is a melee riven: the sheet has no melee rows, so grading it
  // from rifle rules would be confidently wrong.
  const uncovered = new Set(weapon && weapon.uncoveredStats ? weapon.uncoveredStats : []);
  const uncoveredPositives = positiveResults
    .map(e => e.key)
    .filter(key => uncovered.has(key) && !isSpliceTrait(key));

  if (!hasCommunityData) {
    grade = 'unknown';
    reasons.push('No community grade data for this weapon yet.');
  } else if (uncoveredPositives.length) {
    grade = 'unknown';
    reasons.push(
      'Community data has no coverage for ' + uncoveredPositives.join(', ') +
      ', so this riven cannot be graded reliably.'
    );
  } else if (goodPositiveCount === 0) {
    grade = 'bad';
    reasons.push('No positive stat is considered good for this weapon.');
  } else if (
    badPositiveCount === 0 &&
    goodPositiveCount === positiveResults.length &&
    (negativeVerdict === 'acceptable' || negativeVerdict === 'none') &&
    satisfiedCombination
  ) {
    grade = 'great';
    reasons.push('Every stat is good and the negative is harmless.');
  } else if (goodPositiveCount >= 2 && negativeVerdict === 'acceptable') {
    grade = 'good';
    reasons.push('Most stats help and the negative is harmless.');
  } else {
    grade = 'ok';
    if (badPositiveCount > 0) reasons.push('Some positives are not useful for this weapon.');
    if (negativeVerdict === 'unlisted') {
      reasons.push('Negative ' + negative.key + ' is not on this weapon\'s harmless list.');
      if (tolerance && tolerance.total) {
        reasons.push(
          'Only ' + tolerance.toleratedBy + ' of ' + tolerance.total +
          ' graded weapons tolerate -' + negative.key + '.'
        );
      }
    }
  }

  // Say why perfectness is missing instead of letting a bare "0%" imply a
  // terrible roll.
  if (unmeasured.length) {
    const names = unmeasured.map(k => RIVEN_STATS[k] ? RIVEN_STATS[k].display : k);
    reasons.push(
      'No published base value for ' + names.join(' and ') + ', so perfectness cannot ' +
      'be scored' +
      (perfectnessParts.length
        ? '. Rating the remaining ' + perfectnessParts.length + ' stat' +
          (perfectnessParts.length === 1 ? '' : 's') + ' would not be enough to judge this riven.'
        : '.')
    );
  }

  if (!perfectnessKnown && !unmeasured.length) {
    if (!weaponClass) {
      reasons.push(
        'Weapon class is unknown, so the maximum roll for these stats cannot be ' +
        'computed (' + (weapon && weapon.rivenType ? 'market type "' + weapon.rivenType + '"' : 'no type') + ').'
      );
    } else if (!weights) {
      reasons.push(
        positives.length + ' positive and ' + negatives.length +
        ' negative stats is not a riven layout the game produces.'
      );
    } else {
      reasons.push('No positive stat here has a published base value for a ' + weaponClass + '.');
    }
  }

  // Weighted so a perfect riven lands exactly on 100.
  const goodPositivePoints = Math.min(3, goodPositiveCount) / 3 * 45;
  const negativePoints = (negativeVerdict === 'acceptable' || negativeVerdict === 'none') ? 20 : 0;
  const combinationPoints = satisfiedCombination ? 15 : 0;
  // Contributes nothing when unknown; the missing 20 points are the honest cost
  // of not knowing, and `perfectnessKnown` tells the UI to say so.
  const perfectnessPoints = perfectnessKnown ? perfectness * 20 : 0;

  const rawScore = goodPositivePoints + negativePoints + combinationPoints + perfectnessPoints;

  // Clamp into the grade's band so the number can never read as better than the
  // label. Without this a Bad riven could still show a high score purely for
  // having maxed stats, which is exactly the kind of mixed signal that makes a
  // tool untrustworthy.
  const band = RIVEN_GRADE_BANDS[grade];
  let score = Math.round(rawScore);
  if (band) {
    score = Math.max(band.min, Math.min(score, 100));
    const index = RIVEN_GRADES.indexOf(grade);
    if (index > 0) {
      const ceiling = RIVEN_GRADE_BANDS[RIVEN_GRADES[index - 1]].min - 1;
      score = Math.min(score, ceiling);
    }
  }
  score = Math.max(0, Math.min(100, score));

  return {
    grade: grade,
    gradeLabel: RIVEN_GRADES.indexOf(grade) === -1 ? 'Unknown' : grade.charAt(0).toUpperCase() + grade.slice(1),
    score: score,
    reasons: reasons,
    hasCommunityData: hasCommunityData,
    weapon: weapon || null,
    perfectness: perfectnessKnown ? Math.round(perfectness * 1000) / 10 : null,
    perfectnessKnown: perfectnessKnown,
    weaponClass: weaponClass,
    perfectnessParts: perfectnessParts,
    satisfiedCombination: satisfiedCombination,
    negativeVerdict: negativeVerdict,
    positives: positiveResults.map(e => ({ key: e.key, value: e.stat.value, good: e.good, splice: e.splice })),
    negative: negative ? { key: negative.key, value: negative.stat.value, verdict: negativeVerdict } : null
  };
}

module.exports = {
  RIVEN_GRADES_SHEET_URL,
  RIVEN_WEAPONS_URL,
  RIVEN_STATS,
  RIVEN_WFM_NAMES,
  RIVEN_WFM_ALIAS_NAMES,
  RIVEN_SPLICE_TRAITS,
  RIVEN_SPLICE_TRAIT_ALIASES,
  RIVEN_SPLICE_TRAIT_KEYS,
  RIVEN_GRADE_BANDS,
  RIVEN_GRADES,
  RIVEN_ROLL_WEIGHTS,
  RIVEN_ROLL_SPREAD_MAX,
  normalizeRivenName,
  normalizeStatPhrase,
  parseCsvRows,
  parseRivenGradeSheet,
  computeNegativeTolerance,
  computeStatCoverage,
  parsePositiveCombinations,
  parseNegativeList,
  resolveRivenStatKey,
  isSpliceTrait,
  rivenCompositionWeight,
  resolveWeaponClass,
  statMaxValue,
  getRivenData,
  getCachedRivenData,
  findRivenWeapon,
  gradeRiven
};
