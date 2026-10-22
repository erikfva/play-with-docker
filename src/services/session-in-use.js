'use strict';

/**
 * Shared "is this credential backing a live session?" logic.
 *
 * The `sessions` table does not identify its credential the same way for every
 * provider: CodeSandbox and Codespaces persist a `credentialFingerprint`, while
 * GCS stores the registry name in `credentialRef` and leaves the fingerprint
 * NULL. Matching any provider on the fingerprint alone therefore never matches
 * GCS (`NULL = NULL` is not true in SQL), which is why every GCS credential
 * used to report `sessionActive = false` even while its VM was RUNNING.
 *
 * Both the VPS list route and the VPS status service build their EXISTS
 * sub-query from this module so the two can never disagree again.
 */

/** Column on `sessions` that identifies the credential a session consumes. */
const IN_USE_KEY = {
  gcs: 'credentialRef',
  codesandbox: 'credentialFingerprint',
  codespaces: 'credentialFingerprint'
};

/** Session statuses that no longer count as "in use", per provider. */
const TERMINAL_SESSION_STATUSES = {
  gcs: ['TERMINATED', 'DELETED', 'FAILED'],
  codesandbox: ['TERMINATED', 'DELETED', 'FAILED'],
  codespaces: ['TERMINATED', 'FAILED']
};

const DEFAULT_TERMINAL_SESSION_STATUSES = ['TERMINATED', 'DELETED', 'FAILED'];

/**
 * Build the correlated EXISTS sub-query used for `sessionActive`.
 *
 * The caller supplies the alias of the `vps` row being tested (`v`, `u`, ...).
 * The result contains no `?` placeholders, so it can be interpolated into
 * queries that go through convertSql's `$n` index rewriting. The status list
 * is fixed literals from TERMINAL_SESSION_STATUSES — never user input.
 *
 * Uses the union of terminal statuses rather than a per-provider CASE so the
 * fragment stays index-friendly; the only difference is that a `DELETED`
 * Codespaces session counts as inactive, which it semantically is.
 *
 * @param {string} vpsAlias - alias of the vps table in the outer query
 * @returns {string} SQL predicate
 */
function buildSessionActiveExistsSql(vpsAlias) {
  const alias = String(vpsAlias || '').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) {
    throw new Error(`Invalid vps alias for sessionActive sub-query: "${vpsAlias}"`);
  }

  const terminal = DEFAULT_TERMINAL_SESSION_STATUSES
    .map((status) => `'${status}'`)
    .join(', ');

  return `EXISTS (
    SELECT 1 FROM sessions s
    WHERE s.provider = ${alias}.provider
      AND COALESCE(s.status, '') NOT IN (${terminal})
      AND (
        (s.provider = 'gcs'  AND s.credentialRef = ${alias}.name)
        OR (s.provider <> 'gcs' AND s.credentialFingerprint = ${alias}.credentialfingerprint)
      )
  )`;
}

module.exports = {
  IN_USE_KEY,
  TERMINAL_SESSION_STATUSES,
  DEFAULT_TERMINAL_SESSION_STATUSES,
  buildSessionActiveExistsSql
};
