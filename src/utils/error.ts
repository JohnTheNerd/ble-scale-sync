/**
 * Credentials that error text is known to carry, and what replaces them.
 *
 * Node's fetch echoes its input in the message: a URL with `user:password@`
 * comes back whole in "Request cannot be constructed from a URL that includes
 * credentials: <url>" (or "Failed to parse URL from <url>"), and a header value
 * with a newline or NUL in "Headers.append: "<value>" is an invalid header
 * value." That text reached the log, the retry queue file and the ntfy/telegram
 * export report, which can be a public topic.
 *
 * Greedy on purpose: a password may itself contain `@` or `/`, so the userinfo
 * runs to the LAST `@` of the word, and a header value runs to the last quote
 * before the suffix. Hiding a host in the rare URL with `@` in its path is the
 * accepted cost.
 */
const REDACTIONS: ReadonlyArray<[RegExp, string]> = [
  // An unparseable URL may hold a space, so the word rule below cannot see its end.
  [/(Failed to parse URL from )[^\r\n]*@/g, '$1***@'],
  // Scheme length bounded: every debug line passes here, and an unbounded
  // scheme would rescan a long hex dump from each of its characters.
  [/([a-z][a-z0-9+.-]{0,31}:\/\/)\S*@/gi, '$1***@'],
  [
    /(Headers\.\w+: )"[\s\S]*" is an invalid header (value|name)/g,
    '$1"***" is an invalid header $2',
  ],
  [/(Authorization["']?\s*[:=]\s*["']?)(?:(?:Bearer|Basic|Token)\s+)?[^\s,;"']+/gi, '$1***'],
  // Case-sensitive and 8+ characters, so prose such as "Basic auth" is left alone.
  [/\b(Bearer|Basic) [A-Za-z0-9._~+/-]{8,}=*/g, '$1 ***'],
];

/** Hide credentials in text bound for a log, a file or a notification. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  return out;
}

/** Convert an unknown caught value to a human-readable error message, credentials hidden. */
export function errMsg(err: unknown): string {
  return redactSecrets(err instanceof Error ? err.message : String(err));
}
