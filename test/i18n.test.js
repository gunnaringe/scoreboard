import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { I18N } from '../web/i18n.js';

test('every language has the same keys', () => {
    const en = Object.keys(I18N.en).sort();
    for (const [lang, strings] of Object.entries(I18N)) assert.deepEqual(Object.keys(strings).sort(), en, lang);
});

test('every t() key used by the app exists', () => {
    const src = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
    // t('key'), plus keys passed around as strings: rotate(..., 'rotateOfficeConfirm', ...) and ERRORS.
    const used = new Set([...src.matchAll(/\bt\('(\w+)'/g), ...src.matchAll(/'((?:rotate\w+Confirm|rotated\w+|err\w+))'/g)].map((m) => m[1]));
    for (const key of used) assert.ok(key in I18N.en, `missing key: ${key}`);
});

// The frontend must not do rating maths: the server owns it (internal/rating).
test('the frontend ships no rating code', () => {
    const src = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
    assert.ok(!/winProbability\(|balanceTeams\(|displayRating\(/.test(src));
});

// Every RPC the frontend calls exists in the proto.
test('every RPC called by the frontend is defined', () => {
    const src = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
    const proto = readFileSync(new URL('../proto/scoreboard/v1/scoreboard.proto', import.meta.url), 'utf8');
    const defined = new Set([...proto.matchAll(/^\s*rpc (\w+)\(/gm)].map((m) => m[1]));
    // rpc('Method', ...), grpc(gid, 'Method', ...) and act('Method', ...)
    const called = new Set([...src.matchAll(/\b(?:rpc|act)\('(\w+)'|\bgrpc\([^,()]+,\s*'(\w+)'/g)].map((m) => m[1] || m[2]));
    assert.ok(called.size > 20, `found only ${called.size} calls`);
    for (const name of called) assert.ok(defined.has(name), `undefined RPC: ${name}`);
});
