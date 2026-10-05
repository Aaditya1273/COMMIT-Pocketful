'use strict';
// Static browser assets, loaded once at startup and served from memory. Everything the
// UI needs (script, styles, icon) ships in the image; nothing is fetched at run time.

const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, 'public');
const load = (file, type) => ({ type, body: fs.readFileSync(path.join(dir, file)), cache: 'no-store' });

const shell = load('index.html', 'text/html; charset=utf-8');
const assets = new Map([
  ['/assets/app.js', load('app.js', 'text/javascript; charset=utf-8')],
  ['/assets/app.css', load('app.css', 'text/css; charset=utf-8')],
  ['/favicon.svg', load('favicon.svg', 'image/svg+xml')],
]);

module.exports = {
  page: () => shell,
  asset: (p) => assets.get(p) || null,
};
