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
 * runs to the LAST `@` of the word. Hiding a host in the rare URL with `@` in
 * its path is the accepted cost.
 *
 * Every rule is linear in the length of the text, because the logger passes
 * every line through here, debug hex dumps included. A pattern such as
 * `scheme://\S*@` rescans the rest of the word from each `://` it starts at, and
 * took minutes on a 1 MB line of JSON with URLs in it. So a rule consumes the
 * whole stretch it might hide in one match and decides in code which part of
 * it to hide.
 */
type Redaction = [RegExp, (match: string, ...groups: string[]) => string];

/** `prefix` kept, `rest` hidden up to its last `@`, or the match unchanged without one. */
function hideToLastAt(match: string, prefix: string, rest: string): string {
  const at = rest.lastIndexOf('@');
  return at < 0 ? match : `${prefix}***${rest.slice(at)}`;
}

const REDACTIONS: ReadonlyArray<Redaction> = [
  // An unparseable URL may hold a space, so the word rule below cannot see its end.
  [/(Failed to parse URL from )([^\r\n]*)/g, (m, prefix, rest) => hideToLastAt(m, prefix, rest)],
  // Anchored on `://` and the scheme checked behind it, bounded: every debug
  // line passes here, and an unbounded scheme would rescan a long hex dump from
  // each of its characters.
  [/:\/\/(?<=[a-z][a-z0-9+.-]{0,31}:\/\/)(\S*)/gi, (m, rest) => hideToLastAt(m, '://', rest)],
  // Without the suffix the second branch takes the rest of the text, so a text
  // full of these prefixes is not rescanned from each of them.
  [
    /(Headers\.\w+: ")(?:([\s\S]*?)(" is an invalid header (?:value|name))|[\s\S]*)/g,
    // An unmatched group reaches the callback as undefined.
    (m: string, prefix: string, _value?: string, suffix?: string) =>
      suffix === undefined ? m : `${prefix}***${suffix}`,
  ],
  [
    /(Authorization["']?\s*[:=]\s*["']?)(?:(?:Bearer|Basic|Token)\s+)?[^\s,;"']+/gi,
    (_m, prefix) => `${prefix}***`,
  ],
  // Case-sensitive and 8+ characters, so prose such as "Basic auth" is left alone.
  [/\b(Bearer|Basic) [A-Za-z0-9._~+/-]{8,}=*/g, (_m, scheme) => `${scheme} ***`],
];

/** Hide credentials in text bound for a log, a file or a notification. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [pattern, replace] of REDACTIONS) out = out.replace(pattern, replace);
  return out;
}

/** Convert an unknown caught value to a human-readable error message, credentials hidden. */
export function errMsg(err: unknown): string {
  return redactSecrets(err instanceof Error ? err.message : String(err));
}
