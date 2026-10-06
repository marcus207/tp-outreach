/**
 * Shared suppression-list matching rule (same as send-gate isSuppressed):
 *   - exact, case-insensitive match on the address, OR
 *   - whole-domain match ONLY for rows with source = 'manual' and a domain set.
 *
 * A single-person suppression (unsubscribe link, reply, bounce, import) that
 * happens to carry a `domain` value must never block that person's colleagues.
 *
 * Both helpers return a SQL boolean expression. `emailExpr` and `tenantExpr`
 * are interpolated as-is, so pass a column reference (e.g. `c.email`,
 * `c.tenant`) or a placeholder (e.g. `$1`), never user input.
 */

/** `EXISTS (...)`: true when the address is suppressed for the tenant. */
export function suppressionMatchSql(emailExpr: string, tenantExpr: string): string {
  return `EXISTS (
           SELECT 1 FROM suppressed_emails sup
           WHERE sup.tenant = ${tenantExpr}
             AND (LOWER(sup.email) = LOWER(${emailExpr})
                  OR (sup.source = 'manual'
                      AND sup.domain IS NOT NULL AND sup.domain <> ''
                      AND LOWER(sup.domain) = LOWER(SPLIT_PART(${emailExpr}, '@', 2))))
         )`;
}

/** `NOT EXISTS (...)`: true when the address is NOT suppressed (use in WHERE). */
export function suppressionExclusionSql(emailExpr: string, tenantExpr: string): string {
  return `NOT ${suppressionMatchSql(emailExpr, tenantExpr)}`;
}
