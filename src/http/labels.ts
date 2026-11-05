/**
 * Lower-case, with emoji and punctuation dropped and runs of space collapsed:
 * "Needs / 👖 Clothing" -> "needs clothing". Letters and digits of any script survive, so Hebrew
 * labels compare as written (minus gershayim). The same rule as actual-mcp's `normalizeLabel`, so
 * a label the assistant read back from this API always matches here.
 */
export function normalizeLabel(s: string): string {
  return s
    .toLowerCase()
    .replace(/[׳״'’"]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Same label once case, emoji and punctuation are ignored; a label with nothing letter-like compares trimmed. */
export const sameLabel = (a: string, b: string) =>
  (normalizeLabel(a) || a.trim().toLowerCase()) === (normalizeLabel(b) || b.trim().toLowerCase());
