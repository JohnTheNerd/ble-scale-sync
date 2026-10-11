import { parseDocument, YAMLError } from 'yaml';
import { createLogger } from '../logger.js';

const log = createLogger('Config');

/**
 * Parse config YAML without leaking the source into the error.
 *
 * The `yaml` library's error message carries a code frame of the offending
 * line, and some messages embed the raw token (an unquoted `*secret` becomes
 * "Unresolved alias ...: secret"). A config line very often holds a password
 * or token, and these messages end up in logs that users paste into public
 * issues. So the error we throw names only the file, the position, the error
 * code and the key on that line, never the value.
 *
 * Warnings get the same treatment. `parse()` hands each one to
 * `process.emitWarning`, code frame included, which writes it to stderr past
 * the logger: an unquoted password that starts with `!` reads as an unknown tag
 * and printed the whole line. They go to `onWarning` instead, as text without
 * the line. The value is still not what was written (the tag is dropped), so
 * the hint is the same as for an error.
 */
export function parseConfigYaml(
  raw: string,
  sourcePath: string,
  onWarning: (message: string) => void = (message) => log.warn(message),
): unknown {
  try {
    const doc = parseDocument(raw);
    // What parse() does, minus the warning output: the first error is thrown.
    if (doc.errors.length > 0) throw doc.errors[0];
    for (const warning of doc.warnings) {
      onWarning(describeYamlProblem('YAML warning in', warning, raw, sourcePath));
    }
    return doc.toJS();
  } catch (err) {
    throw new Error(describeYamlError(err, raw, sourcePath));
  }
}

const QUOTE_HINT = 'If that value is a password or token, put it in quotes.';

function describeYamlProblem(
  lead: string,
  err: YAMLError,
  raw: string,
  sourcePath: string,
): string {
  const pos = err.linePos?.[0];
  if (!pos) return `${lead} ${sourcePath} (${err.code}). ${QUOTE_HINT}`;
  const lineText = raw.split(/\r?\n/)[pos.line - 1] ?? '';
  const key = /^\s*(?:-\s+)?([A-Za-z0-9_.-]+)\s*:/.exec(lineText)?.[1];
  return (
    `${lead} ${sourcePath} at line ${pos.line}, column ${pos.col}` +
    (key ? ` (key '${key}')` : '') +
    `: ${err.code}. The line is not printed because it may hold a secret. ${QUOTE_HINT}`
  );
}

function describeYamlError(err: unknown, raw: string, sourcePath: string): string {
  if (err instanceof YAMLError) return describeYamlProblem('Invalid YAML in', err, raw, sourcePath);
  // An unresolved alias is raised as a plain ReferenceError whose message ends
  // with the alias name, i.e. the unquoted value itself.
  if (err instanceof Error && err.message.startsWith('Unresolved alias')) {
    return (
      `Invalid YAML in ${sourcePath}: a value starts with '*', which YAML reads as an alias. ` +
      QUOTE_HINT
    );
  }
  return `Invalid YAML in ${sourcePath}. ${QUOTE_HINT}`;
}
