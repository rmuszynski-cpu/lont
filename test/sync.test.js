'use strict';
// Interfejs w aplikacji na Androida musi być identyczny z tym, który testujemy.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

test('android/…/assets/index.html jest kopią public/index.html (uruchom: npm run sync-android)', () => {
  const root = path.join(__dirname, '..');
  const a = fs.readFileSync(path.join(root, 'public', 'index.html'));
  const b = fs.readFileSync(path.join(root, 'android', 'app', 'src', 'main', 'assets', 'index.html'));
  assert.ok(a.equals(b), 'pliki się różnią – wykonaj npm run sync-android');
});

test('apk.yml w katalogu głównym jest kopią .github/workflows/apk.yml (do wklejenia ręcznie, gdy folder .github się nie wgra)', () => {
  const root = path.join(__dirname, '..');
  const a = fs.readFileSync(path.join(root, '.github', 'workflows', 'apk.yml'));
  const b = fs.readFileSync(path.join(root, 'apk.yml'));
  assert.ok(a.equals(b), 'pliki apk.yml się różnią');
});
