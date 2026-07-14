// stamp-market.test.mjs — settlement (`pays:`) on synthetic towns.
//   node --test tools/stamp-market.test.mjs
// The stamps-spend blessing: a delivered letter carrying `pays: N` moves N
// stamps sender→recipient, derived like a mint (recomputable from the mail),
// all-or-nothing, voiding loudly when it can't settle. Zero-dep; throwaway
// repos and ed25519 keys, same shape as stamp-mint.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  parseDeliveries, householdKeys, deriveTransfers, parseStampLedger,
  foldBalances, parseLaws, classifyEntry,
} from './stamp-mint.mjs';
import { verifyStampLedger } from './stamp-verify.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

// ── synthetic town builder (mirrors stamp-mint.test.mjs) ─────────────────────

function town({ ledgerLines, pins = {}, addresses = {} }) {
  const repo = mkdtempSync(join(tmpdir(), 'stamp-market-'));
  mkdirSync(join(repo, 'tools'), { recursive: true });
  mkdirSync(join(repo, 'WHITE_PAGES'), { recursive: true });
  writeFileSync(join(repo, 'tools', 'github-ids.json'), JSON.stringify(pins));
  for (const [handle, github] of Object.entries(addresses)) {
    mkdirSync(join(repo, 'WHITE_PAGES', handle), { recursive: true });
    writeFileSync(join(repo, 'WHITE_PAGES', handle, 'ADDRESS.md'),
      `---\nhandle: ${handle}\n${github ? `github: ${github}\n` : ''}---\n`);
  }
  writeFileSync(join(repo, 'WHITE_PAGES', 'mail-ledger.md'), `# ledger\n\n${ledgerLines.join('\n')}\n`);
  return repo;
}

// A plain delivery, and a paying delivery (pays segment before thread).
const D = (date, id, from, to) => `- ${date} · ${id} · ${from} → ${to} · thread: new`;
const P = (date, id, from, to, n) => `- ${date} · ${id} · ${from} → ${to} · pays: ${n} · thread: new`;

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    pub: publicKey.export({ type: 'spki', format: 'pem' }),
    priv: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

function writeKey(repo, privPem) {
  const keyFile = join(repo, 'stamp-key.pem');
  writeFileSync(keyFile, privPem);
  return keyFile;
}

function run(repo, args) {
  return execFileSync(process.execPath, [join(HERE, 'stamp-mint.mjs'), ...args, '--repo', repo], { encoding: 'utf8' });
}

function appendLedger(repo, keyFile) {
  return run(repo, ['--append', '--key', keyFile]);
}

function ledgerText(repo) {
  return readFileSync(join(repo, 'WHITE_PAGES', 'stamp-ledger.md'), 'utf8');
}

function balances(repo) {
  return foldBalances(parseStampLedger(ledgerText(repo)));
}

// ── the parser + derivation ──────────────────────────────────────────────────

test('parseDeliveries reads pays; plain lines carry pays=null', () => {
  const repo = town({ ledgerLines: [
    D('2026-07-15', 'a-1', 'alice', 'bob'),
    P('2026-07-16', 'a-2', 'alice', 'bob', 3),
  ] });
  const d = parseDeliveries(repo);
  assert.equal(d[0].pays, null);
  assert.equal(d[1].pays, 3);
  rmSync(repo, { recursive: true, force: true });
});

test('a covered pays transfers; the letter also mints both sides', () => {
  const { pub, priv } = keypair();
  // alice earns balance by sending to distinct recipients over days, then pays bob.
  const repo = town({ ledgerLines: [
    D('2026-07-15', 'a-1', 'alice', 'carol'),   // alice +1 (sent), carol +1
    D('2026-07-16', 'a-2', 'alice', 'dave'),    // alice +1 (sent), dave +1
    D('2026-07-17', 'a-3', 'alice', 'erin'),    // alice +1 (sent), erin +1
    P('2026-07-18', 'a-4', 'alice', 'bob', 2),  // alice +1 (sent), bob +1, then alice → bob · 2
  ] });
  writeFileSync(join(repo, 'tools', 'stamp-pubkey.pem'), pub);
  appendLedger(repo, writeKey(repo, priv));

  const r = verifyStampLedger(repo);
  assert.equal(r.ok, true, r.problems.join('; '));
  const bal = balances(repo);
  // alice: 4 minted (4 sends, distinct recipients/day) − 2 paid = 2
  assert.equal(bal.get('alice'), 2);
  // bob: 1 minted (received a-4) + 2 received = 3
  assert.equal(bal.get('bob'), 3);
  assert.match(ledgerText(repo), /- 2026-07-18 · alice → bob · 2 · via: mail:a-4 · sig: /);
  rmSync(repo, { recursive: true, force: true });
});

test('NEGATIVE CONTROL: an over-balance pays voids loudly; the letter still mints', () => {
  const { pub, priv } = keypair();
  // bob has never sent — his only stamp is the one he earns receiving a-1.
  // He then tries to pay alice 5. Balance 1 < 5 → void, but a-2 still delivers+mints.
  const repo = town({ ledgerLines: [
    D('2026-07-15', 'a-1', 'alice', 'bob'),      // bob +1 (received)
    P('2026-07-16', 'a-2', 'bob', 'alice', 5),   // bob +1 (sent), alice +1 (received), then bob → alice · 5 VOIDS
  ] });
  writeFileSync(join(repo, 'tools', 'stamp-pubkey.pem'), pub);
  appendLedger(repo, writeKey(repo, priv));

  const r = verifyStampLedger(repo);
  assert.equal(r.ok, true, r.problems.join('; '));
  const text = ledgerText(repo);
  // the void note is present, arrow-free, reason insufficient-balance
  assert.match(text, /- 2026-07-16 · void · mail:a-2 · from bob to alice · 5 · insufficient-balance · sig: /);
  // NO transfer line was written
  assert.doesNotMatch(text, /bob → alice · 5 · via: mail/);
  // the letter still minted: bob earned his send stamp, alice her receive stamp
  const bal = balances(repo);
  assert.equal(bal.get('bob'), 2, 'bob keeps both mints (received a-1, sent a-2); nothing moved');
  assert.equal(bal.get('alice'), 2, 'alice keeps her mints (sent a-1, received a-2); no transfer landed');
  rmSync(repo, { recursive: true, force: true });
});

test('meep-void semantics: with the meep law active at pay time, to- and from-meep both void', () => {
  // Unit-level assertion on deriveTransfers directly: a law active at the pay
  // date names meepy a meep, so both a pays-to-meep and a pays-from-meep void on
  // meep-party grounds, regardless of balance. (The end-to-end signed pipeline
  // is exercised by the next test.)
  const repo = town({ ledgerLines: [
    D('2026-07-15', 'b-1', 'alice', 'bob'),
    D('2026-07-16', 'b-2', 'alice', 'carol'),
    P('2026-07-25', 'b-4', 'alice', 'meepy', 1),
    P('2026-07-25', 'b-5', 'meepy', 'alice', 1),
  ] });
  const deliveries = parseDeliveries(repo);
  const households = householdKeys(repo);
  const laws = [{ date: '2026-07-01', rules: 'stamps-v2', meeps: new Set(['meepy']) }];
  const transfers = deriveTransfers(deliveries, households, { laws, revisions: [] }, []);
  const toMeep = transfers.find((t) => t.id === 'b-4');
  const fromMeep = transfers.find((t) => t.id === 'b-5');
  assert.equal(toMeep.kind, 'void');
  assert.equal(toMeep.reason, 'meep-party');
  assert.equal(fromMeep.kind, 'void');
  assert.equal(fromMeep.reason, 'meep-party');
  rmSync(repo, { recursive: true, force: true });
});

test('meep-void end to end: law dated before the paying letters → both void, verify green', () => {
  const { pub, priv } = keypair();
  // Two throwaway deliveries give the law something to sit after, then the law,
  // then the paying letters — so meepy is a meep at pay time.
  const repo = town({ ledgerLines: [
    D('2026-07-15', 'c-1', 'alice', 'bob'),
    D('2026-07-16', 'c-2', 'alice', 'carol'),
    P('2026-07-25', 'c-3', 'alice', 'meepy', 1),
    P('2026-07-25', 'c-4', 'meepy', 'alice', 1),
  ] });
  writeFileSync(join(repo, 'tools', 'stamp-pubkey.pem'), pub);
  const keyFile = writeKey(repo, priv);
  // Declare v2 dated 2026-07-17 — after the plain deliveries, before the pays.
  // (The mint pass forbids a law date <= the last delivery, so append the plain
  // mints under a ledger that only knows the early deliveries first, then let
  // the law + pays come in a second mail wave.)
  // Simplest faithful path: two mail waves.
  // Wave 1: only the early deliveries exist → append mints, declare law.
  const ml = join(repo, 'WHITE_PAGES', 'mail-ledger.md');
  writeFileSync(ml, `# ledger\n\n${D('2026-07-15', 'c-1', 'alice', 'bob')}\n${D('2026-07-16', 'c-2', 'alice', 'carol')}\n`);
  appendLedger(repo, keyFile);
  run(repo, ['--declare-rules', 'stamps-v2', '--meeps', 'meepy', '--date', '2026-07-17', '--key', keyFile]);
  // Wave 2: the paying letters arrive.
  writeFileSync(ml, readFileSync(ml, 'utf8')
    + `${P('2026-07-25', 'c-3', 'alice', 'meepy', 1)}\n${P('2026-07-25', 'c-4', 'meepy', 'alice', 1)}\n`);
  appendLedger(repo, keyFile);

  const r = verifyStampLedger(repo);
  assert.equal(r.ok, true, r.problems.join('; '));
  const text = ledgerText(repo);
  assert.match(text, /- 2026-07-25 · void · mail:c-3 · from alice to meepy · 1 · meep-party · sig: /);
  assert.match(text, /- 2026-07-25 · void · mail:c-4 · from meepy to alice · 1 · meep-party · sig: /);
  assert.doesNotMatch(text, /→ meepy · 1 · via: mail/);
  rmSync(repo, { recursive: true, force: true });
});

test('--derive is total: it emits the transfer/void subsequence, and verify replays it', () => {
  const { pub, priv } = keypair();
  const repo = town({ ledgerLines: [
    D('2026-07-15', 'a-1', 'alice', 'carol'),
    D('2026-07-16', 'a-2', 'alice', 'dave'),
    P('2026-07-17', 'a-3', 'alice', 'bob', 1),   // covered → transfer
    P('2026-07-18', 'a-4', 'bob', 'alice', 9),   // bob can't cover 9 → void
  ] });
  writeFileSync(join(repo, 'tools', 'stamp-pubkey.pem'), pub);
  appendLedger(repo, writeKey(repo, priv));
  const derive = run(repo, ['--derive']);
  assert.match(derive, /- 2026-07-17 · alice → bob · 1 · via: mail:a-3/);
  assert.match(derive, /- 2026-07-18 · void · mail:a-4 · from bob to alice · 9 · insufficient-balance/);
  assert.equal(verifyStampLedger(repo).ok, true);
  rmSync(repo, { recursive: true, force: true });
});

test('a tampered transfer amount is caught by signature AND replay', () => {
  const { pub, priv } = keypair();
  const repo = town({ ledgerLines: [
    D('2026-07-15', 'a-1', 'alice', 'carol'),
    D('2026-07-16', 'a-2', 'alice', 'dave'),
    P('2026-07-17', 'a-3', 'alice', 'bob', 1),
  ] });
  writeFileSync(join(repo, 'tools', 'stamp-pubkey.pem'), pub);
  appendLedger(repo, writeKey(repo, priv));
  const p = join(repo, 'WHITE_PAGES', 'stamp-ledger.md');
  writeFileSync(p, readFileSync(p, 'utf8').replace('alice → bob · 1 · via: mail:a-3', 'alice → bob · 5 · via: mail:a-3'));
  const r = verifyStampLedger(repo);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((x) => x.includes('SIGNATURE FAILS')), 'signature catches it');
  assert.ok(r.problems.some((x) => x.includes('REPLAY DIVERGES')), 'replay catches it');
  rmSync(repo, { recursive: true, force: true });
});

test('a forged transfer with no paying letter behind it cannot hide', () => {
  const { pub, priv } = keypair();
  const repo = town({ ledgerLines: [D('2026-07-15', 'a-1', 'alice', 'bob')] });
  writeFileSync(join(repo, 'tools', 'stamp-pubkey.pem'), pub);
  appendLedger(repo, writeKey(repo, priv));
  const p = join(repo, 'WHITE_PAGES', 'stamp-ledger.md');
  // hand-add a transfer for a delivery that never carried pays
  writeFileSync(p, readFileSync(p, 'utf8') + '- 2026-07-15 · bob → alice · 1 · via: mail:a-1 · sig: AAAA\n');
  const r = verifyStampLedger(repo);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((x) => x.includes('SIGNATURE FAILS') || x.includes('beyond the derivation')));
  rmSync(repo, { recursive: true, force: true });
});

test('conservation holds across a transfer; a void moves nothing', () => {
  const { pub, priv } = keypair();
  const repo = town({ ledgerLines: [
    D('2026-07-15', 'a-1', 'alice', 'carol'),
    P('2026-07-16', 'a-2', 'alice', 'bob', 1),  // transfer
    P('2026-07-17', 'a-3', 'carol', 'alice', 9), // void (carol has 1)
  ] });
  writeFileSync(join(repo, 'tools', 'stamp-pubkey.pem'), pub);
  appendLedger(repo, writeKey(repo, priv));
  const bal = balances(repo);
  const sum = [...bal.values()].reduce((a, b) => a + b, 0);
  assert.equal(sum, 0, 'all accounts (incl. MINT) sum to zero');
  assert.equal(verifyStampLedger(repo).ok, true);
  rmSync(repo, { recursive: true, force: true });
});

test('paying yourself is not correspondence — no transfer, no void', () => {
  const repo = town({ ledgerLines: [
    D('2026-07-15', 'a-1', 'alice', 'carol'),
    P('2026-07-16', 'a-2', 'alice', 'alice', 1),
  ] });
  const transfers = deriveTransfers(parseDeliveries(repo), householdKeys(repo), {}, []);
  assert.equal(transfers.length, 0);
  rmSync(repo, { recursive: true, force: true });
});

test('classifyEntry distinguishes transfer, void, and a mail-via stake', () => {
  assert.equal(classifyEntry('- 2026-07-17 · alice → bob · 2 · via: mail:a-4').kind, 'transfer');
  assert.equal(classifyEntry('- 2026-07-17 · void · mail:a-4 · from bob to alice · 5 · insufficient-balance').kind, 'void');
  // a stake that rode in on mail must still classify as a stake, not a transfer
  assert.equal(classifyEntry('- 2026-07-17 · alice → stake:name/foo · 2 · via: mail:a-4').kind, 'stake');
  assert.equal(classifyEntry('- 2026-07-17 · stake:name/foo → alice · 2 · for: close').kind, 'return');
});
