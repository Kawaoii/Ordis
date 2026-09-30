/*
 * Amber glass: turn the trial theme on or off.
 *
 *   node tools\toggle-glass.js          toggle
 *   node tools\toggle-glass.js on
 *   node tools\toggle-glass.js off
 *
 * The theme itself lives at the bottom of ordis-design.css, inert, and this is the only
 * thing that switches it. It is kept out of the app's scripts on purpose: a theme you
 * have to edit code to try is a theme you cannot judge, because by the time you have
 * looked at it properly you have changed something else as well.
 *
 * Or from the console with the app open:
 *   document.body.classList.toggle('theme-amber-glass')
 */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'index.html');
const CLASS = 'theme-amber-glass';

function current(html) {
  const m = html.match(/<body([^>]*)>/);
  return !!(m && m[1] && m[1].indexOf(CLASS) !== -1);
}

function set(html, on) {
  const m = html.match(/<body([^>]*)>/);
  if (!m) throw new Error('no <body> tag in index.html');
  // Strip any previous class list rather than appending to it, so running this twice
  // cannot leave a stale duplicate behind.
  const attrs = m[1].replace(new RegExp('\\s*' + CLASS, 'g'), '').trim();
  const body = on ? '<body class="' + CLASS + '">' : '<body>';
  return html.slice(0, m.index) + body + html.slice(m.index + m[0].length);
}

let html = fs.readFileSync(FILE, 'utf8');
const arg = (process.argv[2] || '').toLowerCase();
const on = arg === 'on' ? true : arg === 'off' ? false : !current(html);

fs.writeFileSync(FILE, set(html, on));
console.log('amber glass: ' + (on ? 'ON' : 'OFF'));
console.log('restart the app, or run this in the console:');
console.log('  document.body.classList.' + (on ? 'add' : 'remove') + "('" + CLASS + "')");
