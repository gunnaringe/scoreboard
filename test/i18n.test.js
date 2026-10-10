import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { I18N } from '../public/i18n.js';

test('every language has the same keys', () => {
    const en = Object.keys(I18N.en).sort();
    for (const [lang, strings] of Object.entries(I18N)) assert.deepEqual(Object.keys(strings).sort(), en, lang);
});

test('every t() key used by the app exists', () => {
    const src = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
    // t('key'), plus keys passed around as strings: rotate(..., 'rotateOfficeConfirm', ...) and ERRORS.
    const used = new Set([...src.matchAll(/\bt\('(\w+)'/g), ...src.matchAll(/'((?:rotate\w+Confirm|rotated\w+|err\w+))'/g)].map((m) => m[1]));
    for (const key of used) assert.ok(key in I18N.en, `missing key: ${key}`);
});
