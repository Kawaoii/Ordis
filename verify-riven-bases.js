/**
 * Dev check: diff the transcribed riven base values in riven-data.js against
 * the official wiki's published table.
 *
 *   node verify-riven-bases.js
 *
 * The base values are published by Digital Extremes as documentation only, and
 * the Public Export carries no riven attribute table (only `omegaAttenuation`,
 * the disposition), so they have to be transcribed. This script makes that
 * transcription verifiable instead of trusted: it reads the live page, so a DE
 * patch that changes a base value shows up as a failure rather than silently
 * skewing every perfectness calculation.
 *
 * Not used at runtime. The app never fetches the wiki.
 */

const https = require('https');

const { RIVEN_STATS } = require('./riven-data.js');

const PAGE = 'Riven_Mods';
const API = 'https://wiki.warframe.com/api.php?action=parse&page=' + PAGE +
  '&prop=text&format=json&formatversion=2';

const CLASSES = ['rifle', 'shotgun', 'pistol', 'archgun', 'melee'];

/**
 * Wiki row label -> our stat key(s). The wiki writes one cell containing both
 * the positive and negative names, plus footnotes, so the labels are not simply
 * our `display` strings.
 *
 * A label maps to an array because the wiki combines rows we split: "Fire Rate
 * (x2 for Bows) /Attack Speed" is one row, but `FR` covers every class while
 * `AS` exists only for melee. Each key then declares its own subset of classes.
 */
const WIKI_LABEL_TO_KEY = {
  'Additional Combo Count Chance (bonus) /Chance to Gain Combo Count (malus)': ['ACC'],
  'Ammo Maximum': ['AMMO'],
  'Damage vs. Corpus': ['DTC'],
  'Damage vs. Grineer': ['DTG'],
  'Damage vs. Infested': ['DTI'],
  'Cold Damage': ['COLD'],
  'Combo Duration': ['CDUR'],
  'Critical Chance /Critical Chance (x2 for Heavy Attacks)': ['CC'],
  'Critical Chance for Slide Attack': ['SCC'],
  'Critical Damage': ['CD'],
  'Damage / Melee Damage': ['DMG'],
  'Electricity Damage': ['ELEC'],
  'Heat Damage': ['HEAT'],
  'Finisher Damage': ['FIN'],
  'Fire Rate (x2 for Bows) /Attack Speed': ['FR', 'AS'],
  'Projectile Speed': ['PFS'],
  'Initial Combo': ['IC'],
  'Impact Damage': ['IMP'],
  'Magazine Capacity': ['MAG'],
  'Heavy Attack Efficiency': ['EFF'],
  'Multishot': ['MS'],
  'Toxin Damage': ['TOX'],
  'Punch Through': ['PT'],
  'Puncture Damage': ['PUNC'],
  'Reload Speed': ['RLS'],
  'Range': ['RANGE'],
  'Slash Damage': ['SLASH'],
  'Status Chance': ['SC'],
  'Status Duration': ['SD'],
  'Weapon Recoil': ['REC'],
  'Zoom': ['ZOOM'],
  // Named by the wiki (prefix Tori/suffix Bo) but published with no per-class
  // values, so these never resolve to a base and are reported, not compared.
  'Channeling Damage': ['CHD'],
  'Channeling Efficiency': ['CHE']
};

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'WarframeCompanionApp/1.0 (riven base value check)' } }, res => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error('HTTP ' + res.statusCode + ' for ' + url));
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });
}

function cellText(html) {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#160;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Strip the footnote markers the wiki appends to attribute names, e.g.
 * "Heat Damage" followed by a superscript 1. They are <sup> tags, so removing
 * tags leaves the digit behind.
 */
function stripFootnotes(label) {
  return label.replace(/[¹²³⁰-⁹*]+$/u, '').trim();
}

/**
 * A base value cell is a dash (attribute cannot occur on that class) or a
 * number, optionally a percentage, a time/metre unit, or an x0.45 multiplier
 * that the game displays as +45%.
 */
function parseBaseValue(text) {
  if (!text || text === '-' || text === '–') return null;
  const multiplier = /^x\s*([\d.]+)$/i.exec(text);
  if (multiplier) return Number(multiplier[1]) * 100;
  const numeric = /^([\d.]+)/.exec(text);
  if (!numeric) return null;
  const value = Number(numeric[1]);
  return Number.isFinite(value) ? value : null;
}

function findBaseValueTable(html) {
  const tables = html.match(/<table[\s\S]*?<\/table>/g) || [];
  // The base-value table is the first one containing Multishot; the later
  // "Spliced Values" table does not.
  for (const table of tables) {
    if (/>Multishot</.test(table) && /Melee\s*\/?\s*Zaw/i.test(table)) return table;
  }
  return null;
}

/**
 * Attributes that are known to exist but for which the wiki publishes no
 * per-class base values (as of the last check). They appear on live riven
 * orders, so they must be modelled, but there is nothing to verify a base
 * against until DE documents one.
 */
const VALUELESS_KEYS = ['Channeling Damage', 'Channeling Efficiency'];

/**
 * Look for those attributes anywhere on the page, and report whether values have
 * since appeared next to them.
 */
function scanForValuelessAttributes(html) {
  const found = new Map();
  const rows = html.match(/<tr[\s\S]*?<\/tr>/g) || [];

  for (const row of rows) {
    const cells = (row.match(/<t[dh][\s\S]*?<\/t[dh]>/g) || []).map(cellText);
    if (cells.length < 3) continue;
    const label = stripFootnotes(cells[0]);
    if (VALUELESS_KEYS.indexOf(label) === -1) continue;

    const key = WIKI_LABEL_TO_KEY[label][0];
    const values = {};
    CLASSES.forEach((cls, i) => {
      const v = parseBaseValue(cells[3 + i]);
      if (v != null) values[cls] = v;
    });
    found.set(key, { hasValues: Object.keys(values).length > 0, values: values });
  }

  return found;
}

function parseBaseValueRows(tableHtml) {
  const rows = tableHtml.match(/<tr[\s\S]*?<\/tr>/g) || [];
  const parsed = new Map();
  const unmapped = [];
  const noBaseValues = [];
  const seenKeys = new Set();

  for (const row of rows) {
    const cells = (row.match(/<t[dh][\s\S]*?<\/t[dh]>/g) || []).map(cellText);
    if (cells.length < 3) continue;

    const label = stripFootnotes(cells[0]);
    const keys = WIKI_LABEL_TO_KEY[label];

    // An attribute the wiki names but gives no per-class values for. Previously
    // these were skipped silently, which hid Channeling Damage and Channeling
    // Efficiency: real attributes that exist on live orders.
    if (cells.length < 3 + CLASSES.length) {
      if (label && keys) {
        for (const k of keys) seenKeys.add(k);
        noBaseValues.push(keys.join(', ') + ' (' + label + ')');
      } else if (label && !/^(Attributes|Effect|Rifle)/i.test(label) && !/melee|spliced/i.test(label)) {
        unmapped.push(label + '  [row has only ' + cells.length + ' cells]');
      }
      continue;
    }

    if (!keys) {
      if (label && !/^(Attributes|Effect|Rifle)/i.test(label)) unmapped.push(label);
      continue;
    }

    const base = {};
    CLASSES.forEach((cls, i) => { base[cls] = parseBaseValue(cells[3 + i]); });
    for (const key of keys) { parsed.set(key, base); seenKeys.add(key); }
  }

  return { parsed, unmapped, noBaseValues, seenKeys };
}

function same(a, b) {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return Math.abs(a - b) < 0.005;
}

async function main() {
  const json = JSON.parse(await get(API));
  const html = json.parse && json.parse.text;
  if (!html) throw new Error('no page HTML in response');

  const table = findBaseValueTable(html);
  if (!table) throw new Error('could not locate the base-value table on ' + PAGE);

  const { parsed, unmapped, noBaseValues, seenKeys } = parseBaseValueRows(table);
  const problems = [];

  for (const label of unmapped) problems.push('wiki row not mapped to a key: ' + label);

  // Attributes the wiki names but gives no per-class values for. They live in a
  // separate stub table, so the main-table parser never sees them. Scan the whole
  // page: if DE ever publishes values for one, that is worth surfacing loudly
  // because a base can then be added instead of reporting perfectness unknown.
  const valueless = scanForValuelessAttributes(html);

  for (const [key, info] of valueless) {
    if (info.hasValues) {
      problems.push(
        key + ' (' + RIVEN_STATS[key].display + '): the wiki now publishes base values (' +
        JSON.stringify(info.values) + ') — add them to RIVEN_STATS.base'
      );
    } else {
      noBaseValues.push(key + ' (' + RIVEN_STATS[key].display + ') — named by the wiki, no values published');
    }
    seenKeys.add(key);
  }

  for (const [key, meta] of Object.entries(RIVEN_STATS)) {
    const wiki = parsed.get(key);
    if (!wiki) {
      if (seenKeys.has(key)) {
        // Documented by the wiki but with no published values. Carrying no base
        // is the honest state; inventing one would be the bug.
        if (meta.base) {
          problems.push(
            key + ' (' + meta.display + '): the wiki publishes no base value, but ' +
            'riven-data.js has ' + JSON.stringify(meta.base)
          );
        }
        continue;
      }
      problems.push(key + ' (' + meta.display + '): not found on the wiki page');
      continue;
    }
    for (const cls of CLASSES) {
      const ours = meta.base[cls] == null ? null : meta.base[cls];
      // We deliberately model a subset of the wiki's classes (AS covers only the
      // melee column of a row we also read as FR), so only compare what we claim.
      if (ours == null) continue;
      if (!same(ours, wiki[cls])) {
        problems.push(
          key + '.' + cls + ': riven-data.js has ' + ours + ', wiki has ' + wiki[cls] +
          '  (' + meta.display + ')'
        );
      }
    }
  }

  for (const key of parsed.keys()) {
    if (!RIVEN_STATS[key]) problems.push('wiki attribute ' + key + ' is missing from RIVEN_STATS');
  }

  if (problems.length) {
    console.error('riven base values have drifted from the official wiki:\n');
    for (const p of problems) console.error('  - ' + p);
    console.error('\n' + problems.length + ' difference(s). Update riven-data.js RIVEN_STATS.base.');
    process.exitCode = 1;
    return;
  }

  console.log('riven base values match the official wiki (' + parsed.size + ' attributes x ' + CLASSES.length + ' classes).');

  // Not a failure: these are real attributes the wiki names but gives no values
  // for, so riven-data.js carries them without a base and perfectness reports
  // unknown. Surfaced so a future DE patch publishing values gets noticed.
  if (noBaseValues.length) {
    console.log('\nDocumented by the wiki but with no published base values:');
    for (const n of noBaseValues) console.log('  - ' + n);
  }
}

main().catch(err => {
  console.error('verify-riven-bases failed: ' + err.message);
  process.exitCode = 1;
});
