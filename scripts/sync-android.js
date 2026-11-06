'use strict';
// Kopiuje interfejs (public/index.html) do projektu Androida. Uruchom po każdej zmianie interfejsu: npm run sync-android
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const dst = path.join(root, 'android', 'app', 'src', 'main', 'assets', 'index.html');
fs.mkdirSync(path.dirname(dst), { recursive: true });
fs.copyFileSync(path.join(root, 'public', 'index.html'), dst);
console.log('Skopiowano public/index.html do', path.relative(root, dst));
