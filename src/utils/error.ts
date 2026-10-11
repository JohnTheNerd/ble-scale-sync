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

const URL_SCHEME = /^[a-z][a-z0-9+.-]{0,31}:\/\//i;

const REDACTIONS: ReadonlyArray<Redaction> = [
  // fetch ends its message with the URL as it was given, and that may hold a
  // space, a tab or a line break: the URL parser accepts a space in the
  // userinfo and drops tabs and line breaks, so such a URL is refused for its
  // credentials, not for its shape. The word rule below would stop at the
  // first of them, short of the `@`. Here the URL runs to the end of the text,
  // or to the first frame when the message heads a stack.
  [
    /(that includes credentials: |Failed to parse URL from )([\s\S]*?)(?=\n {4}at |$)/g,
    (m, prefix, url) => {
      const scheme = URL_SCHEME.exec(url)?.[0] ?? '';
      return hideToLastAt(m, prefix + scheme, url.slice(scheme.length));
    },
  ],
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
  // A secret in the query string (`?token=`, `api_key=`, `X-Plex-Token=`) and a
  // Telegram bot token in the path. fetch repeats such a URL whole when it
  // cannot parse it, as a webhook URL missing its `https://` or with a bad
  // port, and when it also carries userinfo. The name prefix is bounded and
  // must end in `_` or `-`, so `monkey=` or `keys=` stay as they are.
  [
    /([?&](?:[\w-]{0,16}[_-])?(?:token|key|apikey|secret|password|passwd|pass|pwd|auth|signature|sig|ticket)=)[^&#\s"'<>),;]+/gi,
    (_m, name) => `${name}***`,
  ],
  [/(\/bot)\d+:[\w-]+/g, (_m, path) => `${path}***`],
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
