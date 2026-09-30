/* Guards for the community grading. Written as executable checks rather than prose
 * because every one of these was a real bug during development:
 *
 *  - ties were renumbered 1,2,3 so a riven claimed the best stat on the weapon
 *  - statMaxValue was called with the stat count instead of the disposition, which
 *    silently killed the quality half of the score
 *  - an unranked penalty subtracted more than three good positives could add
 *  - rule selection picked a weapon-specific variant over the generic one
 *
 * Run: node test-riven-community.js
 */
const fs = require('fs');
const path = require('path');
const community = require('./riven-community.js');
const rivenData = require('./riven-data.js');

const CSV = process.env.RIVEN_COMMUNITY_CSV ||
  path.join(process.env.TEMP || '.', 'goodrolls.csv');

let pass = 0;
let fail = 0;
function check(name, condition, detail) {
  if (condition) { pass += 1; console.log('  PASS  ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + (detail ? '   -> ' + detail : '')); }
}
function section(title) { console.log('\n' + title); }

if (!fs.existsSync(CSV)) {
  console.error('Sheet CSV not found at ' + CSV);
  console.error('Fetch it with:');
  console.error('  powershell -c "Invoke-WebRequest -Uri \'' + community.COMMUNITY_SHEET_URL + '\' -OutFile ' + CSV + '"');
  process.exit(2);
}
const map = community.parseCommunitySheet(fs.readFileSync(CSV, 'utf8'));
const S = (key, value, isPositive) => ({ key, name: rivenData.rivenStatName(key), value, isPositive });

section('the sheet');
check('parses a large number of weapons', map.size > 300, 'got ' + map.size);
check('every weapon has at least one rule',
  [...map.values()].every((w) => w.rules.length > 0));

section('abbreviations resolve');
// The sheet uses two-letter forms the game does not, and an unresolvable stat is
// dropped rather than guessed at, so a typo would silently lose a stat.
for (const [sheetForm, expected] of [['SL', 'SLASH'], ['Z', 'ZOOM'], ['RNG', 'RANGE'],
                                     ['MS', 'MS'], ['CD', 'CD'], ['PFS', 'PFS'],
                                     ['FR', 'FR'], ['REC', 'REC'], ['RLS', 'RLS']]) {
  check(sheetForm + ' -> ' + expected, rivenData.resolveRivenStatKey(sheetForm) === expected,
    String(rivenData.resolveRivenStatKey(sheetForm)));
}

section('ranked tiers');
const tiers = community.parseRankedTiers('PUNC > Z / PFS* > REC');
check('three tiers from ">"', tiers.length === 3, JSON.stringify(tiers));
check('PUNC alone in tier one', tiers[0].length === 1 && tiers[0][0] === 'PUNC');
check('Z and PFS tied in tier two', tiers[1].length === 2, JSON.stringify(tiers[1]));
check('annotations stripped', tiers[1].indexOf('PFS') !== -1, JSON.stringify(tiers[1]));
check('NONE produces no stat', community.parseRankedTiers('NONE > CD').length === 1,
  JSON.stringify(community.parseRankedTiers('NONE > CD')));

section('rule selection picks the right build');
// Vesper 77 has six rules; the attack speed one must be chosen by an AS riven.
const vesper = map.get('vesper 77');
if (vesper) {
  const asRiven = [S('AS', 60, true), S('RANGE', 30, true), S('ELEC', 80, true), S('CD', 40, false)];
  const asRule = community.selectRuleForStats(vesper, asRiven);
  check('attack speed riven selects a rule', !!asRule);
  check('and it is the attack speed rule', !!asRule && asRule.best === 'AS',
    asRule ? 'best=' + asRule.best : 'null');

  // A rule that mentions none of the riven's stats is a guess, not a description.
  const unrelated = [S('COLD', 90, true), S('HEAT', 90, true), S('DTC', 40, false)];
  check('unrelated riven is not graded against a random rule',
    community.selectRuleForStats(vesper, unrelated) === null ||
    community.selectRuleForStats(vesper, unrelated).best !== 'AS');
} else {
  check('vesper 77 present in sheet', false, 'absent');
}

section('ties are not renumbered');
// A riven whose third-place stats are tied must not be written as 1, 2, 3.
const angstrum = map.get('angstrum');
if (angstrum) {
  const g = community.gradeWithCommunityData(
    angstrum,
    [S('DMG', 200, true), S('SC', 100, true), S('ELEC', 90, true), S('ZOOM', 40, false)],
    { weaponClass: 'pistol', disposition: 1.35 }
  );
  const dmg = g.positiveRanks.find((p) => p.key === 'DMG');
  const sc = g.positiveRanks.find((p) => p.key === 'SC');
  check('tied stats share a rank', dmg && sc && dmg.rank === sc.rank,
    dmg && sc ? dmg.rank + ' vs ' + sc.rank : 'missing');
  check('notation does not claim 1dmg 2sc', g.notation.indexOf('1dmg') === -1, g.notation);
}

section('roll quality actually varies the score');
const sobek = map.get('sobek');
if (sobek) {
  const opts = { weaponClass: 'shotgun', disposition: 1.33 };
  const good = [S('MS', 140, true), S('CD', 160, true), S('TOX', 85, true), S('ZOOM', 30, false)];
  const poor = [S('MS', 10, true), S('CD', 12, true), S('TOX', 8, true), S('ZOOM', 5, false)];
  const a = community.gradeWithCommunityData(sobek, good, opts);
  const b = community.gradeWithCommunityData(sobek, poor, opts);
  check('quality is measured when disposition is known', a.qualityScore != null,
    String(a.qualityScore));
  check('a maxed riven outscores a rolled-to-nothing one', a.score > b.score,
    a.score + ' vs ' + b.score);
  check('by a meaningful margin', (a.score - b.score) >= 10, String(a.score - b.score));
}

section('a penalty cannot bury a good riven');
if (sobek) {
  const noPenalty = [S('MS', 100, true), S('CD', 120, true), S('TOX', 70, true)];
  const withPenalty = noPenalty.concat([S('ZOOM', 40, false)]);
  const a = community.gradeWithCommunityData(sobek, noPenalty,
    { weaponClass: 'shotgun', disposition: 1.33 });
  const b = community.gradeWithCommunityData(sobek, withPenalty,
    { weaponClass: 'shotgun', disposition: 1.33 });
  check('a penalty costs something', b.score < a.score, a.score + ' -> ' + b.score);
  check('but not more than 40 points', (a.score - b.score) <= 40, String(a.score - b.score));
}

section('unknown data is refused, not invented');
const bogus = { name: 'Not A Weapon', key: 'not a weapon', rules: [], notes: [] };
const g = community.gradeWithCommunityData(bogus, [S('MS', 100, true)],
  { weaponClass: 'rifle', disposition: 1.2 });
check('no rules means not graded', g && g.graded === false);
check('and a reason is given', g && g.reason === 'no-matching-rule', g && g.reason);

if (sobek) {
  const noDisp = community.gradeWithCommunityData(sobek,
    [S('MS', 100, true), S('CD', 120, true), S('TOX', 70, true), S('ZOOM', 30, false)],
    { weaponClass: 'shotgun' });
  check('without a disposition quality is skipped, not faked',
    noDisp.qualityScore === null, String(noDisp.qualityScore));
  check('and the score is still produced from rank alone', noDisp.score > 0, String(noDisp.score));
}

section('real photographs grade sensibly');
// Transcribed off cards, so the numbers are the player's own rivens.
const photos = [
  ['Sobek', [S('MS', 89.4, true), S('CD', 131.2, true), S('ZOOM', 59.4, true), S('REC', 0.1, true)], 'shotgun', 1.33],
  ['Hek', [S('MS', 146.8, true), S('FR', 94.3, true), S('RLS', 60.9, true), S('PUNC', 101, false)], 'shotgun', 0.9],
  ['Corvas', [S('MS', 60, true), S('CC', 128.9, true), S('DMG', 109.9, true), S('ZOOM', 20, false)], 'rifle', 1.2]
];
for (const [name, stats, cls, disp] of photos) {
  const w = map.get(name.toLowerCase());
  if (!w) { check(name + ' in sheet', false); continue; }
  const r = community.gradeWithCommunityData(w, stats, { weaponClass: cls, disposition: disp });
  check(name + ' grades as fair or better',
    r.graded && r.score >= 30, r.graded ? r.score + ' ' + r.grade : 'not graded');
  check(name + ' has notation', r.graded && r.notation.length > 0, r.notation);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
