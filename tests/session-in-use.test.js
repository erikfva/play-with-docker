'use strict';

const assert = require('assert');
const { test } = require('node:test');

const {
  buildSessionActiveExistsSql,
  IN_USE_KEY,
  TERMINAL_SESSION_STATUSES
} = require('../src/services/session-in-use');

// ---------------------------------------------------------------------------
// Regression: GCS credentials reported Idle while their VM was RUNNING.
//
// GCS sessions persist the registry name in `credentialRef` and leave
// `credentialFingerprint` NULL. The old sub-queries matched every provider on
// `s.credentialfingerprint = v.credentialfingerprint`, which is never true in
// SQL when both sides are NULL — so `sessionActive` was false for every GCS
// credential. See tests for the matching-key table and the generated SQL.
// ---------------------------------------------------------------------------

test('GCS is matched on credentialRef, token providers on the fingerprint', () => {
  assert.equal(IN_USE_KEY.gcs, 'credentialRef');
  assert.equal(IN_USE_KEY.codesandbox, 'credentialFingerprint');
  assert.equal(IN_USE_KEY.codespaces, 'credentialFingerprint');
});

test('generated sub-query matches GCS on credentialRef (not the fingerprint)', () => {
  const sql = buildSessionActiveExistsSql('v');

  assert.match(sql, /s\.provider\s*=\s*v\.provider/);
  // GCS branch must compare the credential registry name.
  assert.match(sql, /s\.provider\s*=\s*'gcs'\s+AND\s+s\.credentialRef\s*=\s*v\.name/,
    `GCS branch should match credentialRef to the vps name: ${sql}`);
  // Non-GCS branch keeps fingerprint matching.
  assert.match(sql, /s\.provider\s*<>\s*'gcs'\s+AND\s+s\.credentialFingerprint\s*=\s*v\.credentialfingerprint/,
    `token-provider branch should match the fingerprint: ${sql}`);
  // The bare fingerprint comparison that caused the bug must be gone.
  assert.doesNotMatch(sql, /WHERE\s+s\.credentialfingerprint\s*=/i,
    `sub-query must not match on the fingerprint unconditionally: ${sql}`);
});

test('generated sub-query excludes terminal session statuses', () => {
  const sql = buildSessionActiveExistsSql('v');
  for (const status of ['TERMINATED', 'DELETED', 'FAILED']) {
    assert.match(sql, new RegExp(`'${status}'`), `missing terminal status ${status}: ${sql}`);
  }
  assert.match(sql, /NOT IN/i);
});

test('generated sub-query honours the caller-supplied vps alias', () => {
  const sql = buildSessionActiveExistsSql('u');
  assert.match(sql, /s\.provider\s*=\s*u\.provider/);
  assert.match(sql, /s\.credentialRef\s*=\s*u\.name/);
  assert.doesNotMatch(sql, /\bv\./);
});

test('generated sub-query contains no ? placeholder (convertSql-safe)', () => {
  assert.doesNotMatch(buildSessionActiveExistsSql('v'), /\?/);
});

test('generated sub-query is a correlated EXISTS', () => {
  const sql = buildSessionActiveExistsSql('v');
  assert.match(sql.trim(), /^EXISTS \(/);
  assert.match(sql, /SELECT 1 FROM sessions s/);
});

test('invalid aliases are rejected instead of interpolated', () => {
  for (const bad of ['', 'v; DROP TABLE vps', '1v', 'v.x', null, undefined]) {
    assert.throws(() => buildSessionActiveExistsSql(bad), /Invalid vps alias/,
      `alias ${JSON.stringify(bad)} should be rejected`);
  }
});

test('terminal status sets are defined per provider', () => {
  assert.deepStrictEqual(TERMINAL_SESSION_STATUSES.gcs, ['TERMINATED', 'DELETED', 'FAILED']);
  assert.deepStrictEqual(TERMINAL_SESSION_STATUSES.codesandbox, ['TERMINATED', 'DELETED', 'FAILED']);
  // Codespaces rows are retained and never hard-deleted, so DELETED never occurs.
  assert.deepStrictEqual(TERMINAL_SESSION_STATUSES.codespaces, ['TERMINATED', 'FAILED']);
});
