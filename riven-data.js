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

/* The community good-rolls sheet, and the ranker that reads it.
 *
 * The previous source was a 114-row sheet credited to 44Bananas, which did not cover
 * 13 of the 86 rivens in a real inventory, so those came back ungraded. This one has
 * 417 and covers all but two. The matching was never the problem: it is the same
 * normalisation and prefix rule warframe.market uses, and every one of those 13
 * already resolved to a WFM name. The gap was always the data.
 *
 * riven-community reads its helpers from here rather than requiring this file back,
 * which would be a cycle between two modules that both need the other at load time.
 * That injection happens at the bottom of this file, once the functions exist. */
const rivenCommunity = require('./riven-community.js');
const { COMMUNITY_SHEET_URL, parseCommunitySheet, gradeWithCommunityData } = rivenCommunity;

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
  // The trailing aliases are the abbreviations the community good-rolls sheet uses.
  // They are two letters where the game's own wording is longer, so nothing else maps
  // onto them, and a stat that fails to resolve is graded against nothing at all.
  SLASH: { display: 'Slash Damage', base: { rifle: 119.97, shotgun: 119.97, pistol: 119.97, archgun: 90, melee: 119.7 }, aliases: ['slash damage', 'slash', 'sl'] },
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
  ZOOM: { display: 'Zoom', base: { rifle: 59.99, pistol: 80.1, archgun: 59.99 }, aliases: ['zoom', 'zoom in', 'ads speed', 'z'] },
  RANGE: { display: 'Range', base: { melee: 1.94 }, aliases: ['range', 'rng'] },
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
  CHE: { display: 'Channeling Efficiency', aliases: ['channeling efficiency'] },

  /* ---- Combined stats, from the riven rework (Devshorts #115 & #116, Aug 2026) ----
   *
   * Rivens can now merge two attributes into one the player has never been able to
   * cycle for. Heat + Cold becomes Blast, and so on down the table in
   * RIVEN_COMBINED_STATS. Damage + Status Chance becomes Status, which is the odd one
   * out: it folds a damage type and a rate stat together rather than two damage types.
   *
   * There is no `base` on any of these, for the same reason Channeling Damage has none:
   * the rework has not shipped and no ceiling has been published for any weapon class.
   * statMaxValue therefore returns null and perfectness reports unknown, which is the
   * correct answer. Inventing a base here would produce confident, wrong percentages on
   * exactly the rivens players are most excited about, which is the failure this whole
   * reader is built to avoid. Add a base only against a published value.
   *
   * They are listed here rather than left unknown so a combined riven parses, names
   * correctly, and can be searched and traded. A stat that fails to resolve is worse
   * than one with an honest "no ceiling yet". */
  BLAST: { display: 'Blast Damage', aliases: ['blast damage', 'blast'] },
  GAS: { display: 'Gas Damage', aliases: ['gas damage', 'gas'] },
  VIRAL: { display: 'Viral Damage', aliases: ['viral damage', 'viral'] },
  RADIATION: { display: 'Radiation Damage', aliases: ['radiation damage', 'radiation'] },
  CORROSIVE: { display: 'Corrosive Damage', aliases: ['corrosive damage', 'corrosive'] },
  SHOCK: { display: 'Shock Damage', aliases: ['shock damage', 'shock'] },
  MAGNETIC: { display: 'Magnetic Damage', aliases: ['magnetic damage', 'magnetic'] },
  HEMORRHAGE: { display: 'Hemorrhage Damage', aliases: ['hemorrhage damage', 'hemorrhage', 'haemorrhage'] },
  CAVALRY: { display: 'Cavalry Damage', aliases: ['cavalry damage', 'cavalry'] },
  DEMOLITION: { display: 'Demolition Damage', aliases: ['demolition damage', 'demolition'] },
  STATUS: { display: 'Status Damage', aliases: ['status damage', 'status'] }
};

/**
 * Which two attributes merge into which, from the rework announcement.
 *
 * This is what lets the app say "Blast, so Heat and Cold" instead of leaving the
 * player to work it out, and it is what a trade search needs: a Blast roll and a
 * Heat+Cold roll are the same stat to a buyer, and without this they are not
 * interchangeable.
 *
 * Order matters where two inputs could pair more than once, so the pairs are listed
 * explicitly rather than derived. Keys are sorted component keys joined with '+'.
 *
 * Status is the exception and is called out: it comes from Damage + Status Chance,
 * not from two damage types.
 */
const RIVEN_COMBINED_STATS = {
  'HEAT+COLD': 'BLAST',
  'HEAT+TOX': 'GAS',
  'COLD+TOX': 'VIRAL',
  'HEAT+ELEC': 'RADIATION',
  'TOX+ELEC': 'CORROSIVE',
  'COLD+ELEC': 'SHOCK',
  'ELEC+IMP': 'MAGNETIC',
  'IMP+PUNC': 'HEMORRHAGE',
  'IMP+SLASH': 'CAVALRY',
  'PUNC+SLASH': 'DEMOLITION',
  'DMG+SC': 'STATUS'
};

/**
 * Reverse lookup: which two attributes produce this stat.
 *
 * Returns null for anything that is not a combined stat, so callers can treat
 * "not combined" and "combined but unknown" the same way.
 */
function rivenCombinedComponents(key) {
  const wanted = String(key || '').toUpperCase();
  for (const pair of Object.keys(RIVEN_COMBINED_STATS)) {
    if (RIVEN_COMBINED_STATS[pair] !== wanted) continue;
    return pair.split('+');
  }
  return null;
}

/**
 * The combined stat these two attributes make, or null.
 *
 * Passing either order works, because a player reads the card in whatever order the
 * stats happen to be listed and should not have to care.
 */
function rivenCombineStats(a, b) {
  const keyA = String(a || '').toUpperCase();
  const keyB = String(b || '').toUpperCase();
  if (!keyA || !keyB) return null;
  return RIVEN_COMBINED_STATS[keyA + '+' + keyB] || RIVEN_COMBINED_STATS[keyB + '+' + keyA] || null;
}

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
/**
 * The name the game itself prints on the riven card, per attribute.
 *
 * `display` above is the wiki/market wording, which is not what the game shows:
 * the card reads "Cold", "Slash", "Electricity" and "Damage to Infested", not
 * "Cold Damage", "Slash Damage", "Electric Damage" and "Damage vs Infested".
 * Anything shown to the player or pasted into a trade filter has to be the
 * in-game string, or the search finds nothing.
 *
 * Taken from Warframe.market's published attribute list
 * (`/v2/riven/attributes`, `i18n.en.name`), which is the same list their trade
 * filters are built from. Two corrections to that list are noted inline. Any
 * attribute missing here falls back to `display`.
 */
const RIVEN_STAT_GAME_NAMES = {
  CD: 'Critical Damage',
  CC: 'Critical Chance',
  DMG: 'Damage',
  MS: 'Multishot',
  FR: 'Fire Rate',
  RLS: 'Reload Speed',
  MAG: 'Magazine Capacity',
  AMMO: 'Ammo Maximum',
  REC: 'Weapon Recoil',
  TOX: 'Toxin',
  HEAT: 'Heat',
  COLD: 'Cold',
  ELEC: 'Electricity',
  SLASH: 'Slash',
  IMP: 'Impact',
  PUNC: 'Puncture',
  DTC: 'Damage to Corpus',
  DTG: 'Damage to Grineer',
  DTI: 'Damage to Infested',
  SD: 'Status Duration',
  SC: 'Status Chance',
  PT: 'Punch Through',
  // Their list writes "Projectile speed"; every other name in it is title case,
  // and the card renders it capitalised.
  PFS: 'Projectile Speed',
  ZOOM: 'Zoom',
  RANGE: 'Range',
  IC: 'Initial Combo',
  ACC: 'Additional Combo Count',
  CDUR: 'Combo Duration',
  AS: 'Attack Speed',
  EFF: 'Heavy Attack Efficiency',
  FIN: 'Finisher Damage',
  SCC: 'Critical Chance for Slide Attack',
  // Their list has no entry for either of these: "channeling_damage" is labelled
  // "Initial combo" and "channeling_efficiency" is labelled "Heavy Attack
  // Efficiency", which is a different attribute. Left to the display name.
  CHD: 'Channeling Damage',
  CHE: 'Channeling Efficiency'
};

/**
 * Canonical in-game name for an attribute key, or '' when the key is unknown.
 *
 * This is what the app shows and what the trade string is built from. OCR reads
 * the card imperfectly — "Status Chanci", "Projectile Spee", "Magazine v
 * Capacity" — so a name that has been resolved to a key is replaced by this
 * rather than shown as it was read.
 */
function rivenStatName(key) {
  const meta = RIVEN_STATS[key];
  if (!meta) return '';
  return RIVEN_STAT_GAME_NAMES[key] || meta.display || '';
}

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
   * Grades are banded so the numeric score can never contradict the label: a D riven
   * always scores below a C one, and so on. These mirror the
   * RIVEN_OVERLAY_GRADE_THRESHOLDS already declared in main.js.
   *
   * Keyed on the community's S/A/B/C/D. The old great/good/ok/bad ladder sat alongside
   * it, and a riven graded by one path and a riven graded by the other ended up with
   * different letters in the same column.
   */
  const RIVEN_GRADE_BANDS = {
    S: { min: 75 },
    A: { min: 60 },
    B: { min: 45 },
    C: { min: 30 },
    D: { min: 0 }
  };

  const RIVEN_GRADES = ['S', 'A', 'B', 'C', 'D'];

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

  for (const entry of grades.values()) {
    total += 1;
    // Read off the rules rather than a flat list. A negative the sheet is happy to see
    // is the top-ranked one in that rule, so that is what "tolerated" means here.
    const seen = new Set();
    for (const rule of (entry.rules || [])) {
      if (rule.negativeTiers && rule.negativeTiers.length && rule.negativeTiers[0].length) {
        for (const stat of rule.negativeTiers[0]) seen.add(stat);
      }
    }
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

/**
 * Which stats the community sheet never mentions, across every weapon.
 *
 * A stat nobody has an opinion on cannot be called good or bad, and grading it either
 * way is a confident answer to a question nobody asked. A riven carrying one is
 * reported as ungradable rather than scored, which is the whole point of tracking this.
 */
function computeStatCoverage(grades) {
  const mentioned = new Set();
  for (const entry of grades.values()) {
    for (const rule of (entry.rules || [])) {
      if (rule.best) mentioned.add(rule.best);
      if (rule.second) mentioned.add(rule.second);
      for (const tier of rule.positiveTiers || []) {
        for (const stat of tier) mentioned.add(stat);
      }
      for (const tier of rule.negativeTiers || []) {
        for (const stat of tier) mentioned.add(stat);
      }
    }
  }
  const uncovered = Object.keys(RIVEN_STATS).filter((key) => !mentioned.has(key));
  return { covered: Array.from(mentioned).sort(), uncovered };
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
/* Set when a source failed or came back in a shape this module would not grade from.
 * Carried on the cache so the UI can say "no community grades this session" instead of
 * showing an empty column and leaving the player to guess why. */
let rivenDataCacheFetchError = null;

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

  /* The community good-rolls sheet, and warframe.market's riven list, in parallel.
   *
   * The bot that grades against this sheet is a Discord bot with its own shop and
   * currency. The data is fetched and the ranking is computed here, because that is not
   * a dependency this app should have. A failure on either is not fatal: the other's
   * answer still stands, and a riven with no data is reported as unknown rather than
   * guessed at. */
  const [communityResponse, weaponsResponse] = await Promise.all([
    fetchWithTimeout(COMMUNITY_SHEET_URL, { headers: { 'User-Agent': RIVEN_FETCH_HEADERS['User-Agent'] } }),
    fetchWithTimeout(RIVEN_WEAPONS_URL, { headers: RIVEN_FETCH_HEADERS })
  ]);

  const [csvText, weaponsPayload, fallbackPayload] = await Promise.all([
    communityResponse.text(),
    weaponsResponse.json(),
    // A failure here is not fatal. It only widens the set of weapons with a
    // known disposition, and the first source has already answered.
    fetchWithTimeout(RIVEN_DISPOSITIONS_FALLBACK_URL, { headers: RIVEN_FETCH_HEADERS })
      .then((res) => (res && res.ok ? res.json() : null))
      .catch(() => null)
  ]);

  /* The community sheet, parsed into ranked rules rather than the older flat
   * "TOX DTC or TOX DTG" lists. Parsed here rather than in riven-community.js so this
   * file stays the single place that reaches the network and holds the cache; the
   * ranking logic lives in the community module and is called from gradeRiven. */
  let sheetGrades = new Map();
  try {
    sheetGrades = parseCommunitySheet(csvText);
  } catch (err) {
    // Reported rather than thrown. A sheet that changed shape means no riven gets a
    // community grade, and the app should say so instead of refusing to open.
    sheetGrades = new Map();
    rivenDataCacheFetchError = 'community-sheet: ' + (err && err.message ? err.message : 'unreadable');
  }
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
      communityDataWeapon: communityDataFrom === 'base-weapon' && grade ? grade.name : '',
      // The whole ranked entry, not a flattened set. The community sheet's judgement is
      // an ordering, and gradeRiven needs the order to place a stat, so the rules are
      // carried through whole and the flattened goodStats set is gone with the old
      // sheet. Nothing else consumed it.
      communityEntry: grade || null,
      negativeTolerance: negativeTolerance.tolerance,
      uncoveredStats: statCoverage.uncovered,
      notes: grade && grade.notes && grade.notes.length ? grade.notes.join(' | ') : ''
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
      grades: COMMUNITY_SHEET_URL,
      gradesCommunity: 'Megrim & Valkyrial, on 44Bananas',
      weapons: RIVEN_WEAPONS_URL,
      weaponsFallback: RIVEN_DISPOSITIONS_FALLBACK_URL,
      weaponsFallbackAvailable: fallbackList.length > 0
    },
    fetchError: rivenDataCacheFetchError || null
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
/**
 * A tier per stat, the way a companion app presents a roll.
 *
 * `gradeRiven` produces one number for the whole riven, which hides the thing a
 * player actually wants to know: which stat is carrying it and which is dead
 * weight. Every input is already computed for the grade — the community sheet's
 * good/bad list, the tolerated curses, and the maximum each stat could reach on
 * this weapon — so this is a presentation of work that has been done, not a second
 * opinion.
 *
 *   S  a stat the weapon wants, rolled at 95% or better of its maximum
 *   A  a stat the weapon wants, at 70% or better
 *   B  wanted but rolled low, or neutral on this weapon
 *   C  unwanted: a stat nothing here wants, or a curse nothing tolerates
 *   ?  no verdict published, or no published maximum to measure it against
 *
 * `ratio` is how close the roll is to that maximum, and is null when the maximum
 * is not published. Nothing here is ever a guess: a stat with neither a verdict
 * nor a maximum comes back as '?' rather than being folded into an average.
 */
function rivenStatTiers(weapon, stats) {
  const list = Array.isArray(stats) ? stats : [];
  if (!list.length) return [];

  const hasCommunityData = Boolean(weapon && weapon.hasCommunityData);
  const goodStats = new Set(weapon && weapon.goodStats ? weapon.goodStats : []);
  const acceptableNegatives = new Set(weapon && weapon.acceptableNegatives ? weapon.acceptableNegatives : []);
  const disposition = weapon && weapon.disposition ? weapon.disposition : 0;
  const weaponClass = resolveWeaponClass(weapon);
  const weights = rivenCompositionWeight(
    list.filter((s) => s && s.isPositive).length,
    list.filter((s) => s && !s.isPositive).length
  );
  const canMeasure = Boolean(weaponClass) && Boolean(weights);

  return list.map((stat) => {
    if (!stat || !stat.key) {
      return { key: null, name: String(stat && stat.name ? stat.name : ''), tier: '?', ratio: null, max: null, verdict: 'unknown', note: 'Not a stat this tool recognises.' };
    }

    const isPositive = Boolean(stat.isPositive);
    const splice = isSpliceTrait(stat.key) ? evaluateSpliceTrait(stat.key, goodStats) : null;

    let verdict = 'unknown';
    if (isPositive) {
      if (splice) verdict = splice.good ? 'good' : 'poor';
      else if (hasCommunityData) verdict = goodStats.has(stat.key) ? 'good' : 'poor';
      else verdict = 'unknown';
    } else {
      if (!hasCommunityData) verdict = 'unknown';
      else verdict = acceptableNegatives.has(stat.key) ? 'harmless' : 'harmful';
    }

    const weight = isPositive ? (weights ? weights.bonus : null) : (weights ? Math.abs(weights.malus) : null);
    const max = canMeasure ? statMaxValue(stat.key, weaponClass, disposition, weight) : null;
    const magnitude = Math.abs(Number(stat.value) || 0);
    const ratio = max != null && max > 0 ? magnitude / max : null;

    let tier = '?';
    if (!isPositive) {
      // A curse is judged on whether the weapon tolerates it, not on its size:
      // a small unwanted curse and a large one are the same mistake.
      if (verdict === 'harmless') tier = 'B';
      else if (verdict === 'harmful') tier = 'C';
    } else if (verdict === 'good') {
      if (ratio == null) tier = 'A';
      else if (ratio >= 0.95) tier = 'S';
      else if (ratio >= 0.7) tier = 'A';
      else tier = 'B';
    } else if (verdict === 'poor') {
      tier = ratio == null ? 'C' : (ratio >= 0.95 ? 'C' : 'C');
    }

    const notes = {
      S: 'Wanted, and rolled as high as this weapon allows.',
      A: 'Wanted, and rolled well.',
      B: verdict === 'harmless' ? 'A penalty this weapon tolerates.' : 'Wanted, but rolled low.',
      C: isPositive ? 'Not a stat this weapon wants.' : 'A penalty nothing here tolerates.',
      '?': 'No community verdict, or no published maximum to measure against.'
    };

    return {
      key: stat.key,
      name: rivenStatName(stat.key) || String(stat.name || ''),
      tier: tier,
      ratio: ratio == null ? null : Math.round(ratio * 1000) / 10,
      max: max == null ? null : Math.round(max * 10) / 10,
      verdict: verdict,
      note: notes[tier] || notes['?']
    };
  });
}

/**
 * Where each stat sits, for a riven no single rule described.
 *
 * The community grader returns nothing here because the rule that matches the riven is
 * supposed to explain it, and when none does the honest answer is that the sheet has no
 * ranking. But the sheet does have rules for the weapon, and a stat appearing in one of
 * them is not the same as a stat nobody has ever thought about. Every rule for the
 * weapon is checked and the best placement any of them gives is used, which is a
 * statement about the weapon rather than a verdict on the riven.
 */
function fallbackStatRanks(weapon, stats) {
  const list = Array.isArray(stats) ? stats : [];
  const entry = weapon && weapon.communityEntry;
  if (!entry || !entry.rules || !entry.rules.length) return [];
  const best = {};
  for (const stat of list) {
    if (!stat || !stat.key) continue;
    let rank = -1;
    for (const rule of entry.rules) {
      if (rule.best === stat.key) { rank = 0; break; }
      if (rule.second === stat.key) { rank = Math.min(rank === -1 ? 1 : rank, 1); continue; }
      for (let i = 0; i < rule.positiveTiers.length; i++) {
        if (rule.positiveTiers[i].indexOf(stat.key) !== -1) {
          rank = rank === -1 ? 2 + i : Math.min(rank, 2 + i);
        }
      }
      for (let i = 0; i < rule.negativeTiers.length; i++) {
        if (rule.negativeTiers[i].indexOf(stat.key) !== -1) {
          rank = rank === -1 ? i : Math.min(rank, i);
        }
      }
    }
    best[stat.key] = { key: stat.key, name: rivenStatName(stat.key) || stat.name, rank };
  }
  return Object.keys(best).map((k) => best[k]);
}

function gradeRiven(weapon, stats) {
  const list = Array.isArray(stats) ? stats : [];
  const positives = list.filter(s => s && s.isPositive);
  const negatives = list.filter(s => s && !s.isPositive);

  const hasCommunityData = Boolean(weapon && weapon.hasCommunityData);

  /* The community sheet's judgement is an ordering, not a set, so the verdict and the
   * score both come from the ranker rather than from counting how many stats appear in
   * a list. Everything below still runs: perfectness, the stat-level tiers, the notes.
   * Only the letter grade and the score are decided elsewhere now. */
  const weaponClass = resolveWeaponClass(weapon);
  const disposition = weapon && weapon.disposition ? weapon.disposition : 0;
  const communityGrade = hasCommunityData
    ? gradeWithCommunityData(weapon.communityEntry, list, {
        weaponClass: weaponClass,
        disposition: disposition
      })
    : null;

  // Set of keys the sheet ranks anywhere, used for the stat-level good/poor verdict.
  const goodStats = new Set();
  if (weapon && weapon.communityEntry && weapon.communityEntry.rules) {
    for (const rule of weapon.communityEntry.rules) {
      if (rule.best) goodStats.add(rule.best);
      if (rule.second) goodStats.add(rule.second);
      for (const tier of rule.positiveTiers) for (const k of tier) goodStats.add(k);
    }
  }
  // Negatives the sheet is happy to see, taken from the best-ranked negative tier of
  // the rule that actually matched this riven, falling back to the first rule.
  const acceptableNegatives = new Set();
  if (weapon && weapon.communityEntry && weapon.communityEntry.rules) {
    const entry = weapon.communityEntry;
    const rule = (communityGrade && communityGrade.graded) ? null : entry.rules[0];
    const chosen = rule || entry.rules[0];
    if (chosen && chosen.negativeTiers.length && chosen.negativeTiers[0].length) {
      for (const k of chosen.negativeTiers[0]) acceptableNegatives.add(k);
    }
  }

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

  /* The old sheet expressed "this combination of stats is the one you want" as
   * alternative must/options lists. The community sheet expresses the same judgement
   * as a ranking, so a satisfied combination is now simply a riven where the sheet
   * ranked something in its first tier. */
  const satisfiedCombination = communityGrade && communityGrade.graded &&
    communityGrade.positiveRanks.some(p => p.rank >= 0 && p.rank <= 1) ? true : null;

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
    /* The fallback ladder, in the community's letters.
     *
     * This used to emit great/good/ok/bad while the graded path emitted S/A/B/C, and
     * the two landed in the same column: a list where 30 rows said "ok" and 28 said "A".
     * The grade filter chips are keyed on S/A/B/C, so the old letters were not merely
     * inconsistent, they were unfilterable. A riven clicking "Good" would not appear
     * under Good, because the row was labelled "ok" and matched nothing. Same scale
     * everywhere, or the column is lying about what it is showing. */
    grade = 'D';
    reasons.push('No positive stat is considered good for this weapon.');
  } else if (
    badPositiveCount === 0 &&
    goodPositiveCount === positiveResults.length &&
    (negativeVerdict === 'acceptable' || negativeVerdict === 'none') &&
    satisfiedCombination
  ) {
    grade = 'S';
    reasons.push('Every stat is good and the negative is harmless.');
  } else if (goodPositiveCount >= 2 && negativeVerdict === 'acceptable') {
    grade = 'A';
    reasons.push('Most stats help and the negative is harmless.');
  } else {
    grade = 'B';
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

  /* Score and letter come from the community ranker, which is the community's own
   * judgement, in the community's own units. The old weighted sum is gone: it counted
   * membership of a flat list, so a riven with the weapon's first and second choices
   * scored the same as one with its first choice and a throwaway, which is the opposite
   * of what the sheet says. Perfectness is still reported separately and is still the
   * honest "null" when it cannot be computed, but it no longer quietly moves the grade. */
  let rawScore = null;
  if (communityGrade && communityGrade.graded) {
    rawScore = communityGrade.score;
    grade = communityGrade.grade;
    if (communityGrade.notation) {
      reasons.unshift('Ranked ' + communityGrade.notation + ' on the community sheet.');
    }
    if (communityGrade.priceOriented) {
      reasons.push('This weapon\'s ranking is annotated as reflecting sale value rather than in-game strength.');
    }
    if (communityGrade.notes && communityGrade.notes.length) {
      reasons.push(String(communityGrade.notes[0]).slice(0, 220));
    }
  } else {
    const goodPositivePoints = Math.min(3, goodPositiveCount) / 3 * 45;
    const negativePoints = (negativeVerdict === 'acceptable' || negativeVerdict === 'none') ? 20 : 0;
    const combinationPoints = satisfiedCombination ? 15 : 0;
    const perfectnessPoints = perfectnessKnown ? perfectness * 20 : 0;
    rawScore = goodPositivePoints + negativePoints + combinationPoints + perfectnessPoints;
  }

  // Clamp into the grade's band so the number can never read as better than the
  // label. Without this a Bad riven could still show a high score purely for
    // having maxed stats, which is exactly the kind of mixed signal that makes a
    // tool untrustworthy.
  /* Clamped into the band, so a number can never read as better than its own label.
   *
   * Only applied to the fallback score. The community grade already derives its letter
   * from the same number, so re-clamping it against the old great/good/ok/bad bands
   * would cap every S at 79 and pull every real riven down into the bottom two grades.
   * Those bands are the old sheet's scale and do not apply to a rank. */
    let score = Math.round(rawScore == null ? 0 : rawScore);
    if (!communityGrade || !communityGrade.graded) {
      const band = RIVEN_GRADE_BANDS[grade];
      if (band) {
        score = Math.max(band.min, Math.min(score, 100));
        const index = RIVEN_GRADES.indexOf(grade);
        if (index > 0) {
          const ceiling = RIVEN_GRADE_BANDS[RIVEN_GRADES[index - 1]].min - 1;
          score = Math.min(score, ceiling);
        }
      }
    }
    score = Math.max(0, Math.min(100, score));
  
    return {
      grade: grade,
      gradeLabel: communityGrade && communityGrade.graded
        ? communityGrade.gradeLabel
        : (RIVEN_GRADES.indexOf(grade) === -1 ? 'Unknown' : grade.charAt(0).toUpperCase() + grade.slice(1)),
      score: score,
      // The community's own notation, the thing a player would write in chat.
      notation: communityGrade && communityGrade.graded ? communityGrade.notation : '',
      /* Per-stat placement, so the detail view can say "ranked 1 for this weapon" on
       * each stat. Without it the view had nothing to say and fell back to the old
       * verdict list, which the community grader no longer produces.
       *
       * Also filled in on the fallback path, where no single rule described this riven.
       * Those stats are genuinely unranked rather than unknown: the sheet does have a
       * rule for this weapon and it mentions some of them, and saying which is more
       * useful than the panel claiming to know nothing. rank -1 means not ranked. */
      gradeStats: communityGrade && communityGrade.graded
        ? (communityGrade.positiveRanks || []).concat(communityGrade.negativeRanks || []).map(function (r) {
          return { key: r.key, name: r.name, rank: r.rank };
        })
        : fallbackStatRanks(weapon, list),
      communitySource: 'community-sheet',
      priceOriented: Boolean(communityGrade && communityGrade.priceOriented),
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

/* Hand the community module what it needs from here, now that every function above
 * exists. Doing it here rather than at the top is what makes it safe: a module that
 * required this file while this file was still executing would get an incomplete copy. */
rivenCommunity.setHost({
  parseCsvRows,
  normalizeRivenName,
  resolveRivenStatKey,
  rivenStatName,
  statMaxValue,
  rivenCompositionWeight
});

module.exports = {
  COMMUNITY_SHEET_URL,
  RIVEN_WEAPONS_URL,
  RIVEN_STATS,
  RIVEN_WFM_NAMES,
  RIVEN_WFM_ALIAS_NAMES,
  RIVEN_SPLICE_TRAITS,
  RIVEN_COMBINED_STATS,
  rivenCombinedComponents,
  rivenCombineStats,
  RIVEN_SPLICE_TRAIT_ALIASES,
  RIVEN_SPLICE_TRAIT_KEYS,
  RIVEN_GRADE_BANDS,
  RIVEN_GRADES,
  RIVEN_ROLL_WEIGHTS,
  RIVEN_ROLL_SPREAD_MAX,
  normalizeRivenName,
  normalizeStatPhrase,
  parseCsvRows,
  resolveRivenStatKey,
  rivenStatName,
  rivenStatTiers,
  isSpliceTrait,
  rivenCompositionWeight,
  resolveWeaponClass,
  statMaxValue,
  getRivenData,
  getCachedRivenData,
  findRivenWeapon,
  gradeRiven
};
