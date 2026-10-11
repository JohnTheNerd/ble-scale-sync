import { describe, it, expect } from 'vitest';
import { errMsg, redactSecrets } from '../../src/utils/error.js';

describe('errMsg()', () => {
  it('extracts message from Error instance', () => {
    expect(errMsg(new Error('something broke'))).toBe('something broke');
  });

  it('converts string to itself', () => {
    expect(errMsg('plain string')).toBe('plain string');
  });

  it('converts number to string', () => {
    expect(errMsg(404)).toBe('404');
  });

  it('converts null to string', () => {
    expect(errMsg(null)).toBe('null');
  });

  it('converts undefined to string', () => {
    expect(errMsg(undefined)).toBe('undefined');
  });

  it('converts object to string', () => {
    expect(errMsg({ code: 'ENOENT' })).toBe('[object Object]');
  });

  it('handles TypeError subclass', () => {
    expect(errMsg(new TypeError('invalid type'))).toBe('invalid type');
  });
});

/**
 * Node's fetch repeats its input in the error message. These go through the
 * REAL fetch, not a stub, so a Node upgrade that rewords the message breaks
 * them instead of leaving the redaction matching nothing. Every request below
 * is refused while it is being built, before any socket opens: offline and
 * deterministic.
 */
describe('errMsg() with credentials in a fetch error', () => {
  async function fetchError(input: string, init?: RequestInit): Promise<unknown> {
    try {
      await fetch(input, init);
    } catch (err) {
      return err;
    }
    throw new Error('fetch was expected to refuse this request');
  }

  it('hides the password of a URL with userinfo', async () => {
    const err = await fetchError('https://user:s3cretPW@example.invalid/hook');
    // Precondition: the raw message really carries it, or this proves nothing.
    expect((err as Error).message).toContain('s3cretPW');
    const msg = errMsg(err);
    expect(msg).not.toContain('s3cretPW');
    expect(msg).toContain('https://***@example.invalid/hook');
  });

  it('hides userinfo in a URL that cannot be parsed', async () => {
    const err = await fetchError('http://user:pa ss@exa mple/x');
    expect((err as Error).message).toContain('pa ss');
    expect(errMsg(err)).not.toContain('pa ss');
  });

  // The URL parser accepts a space in the userinfo and drops tabs and line
  // breaks, so fetch refuses these for their credentials and echoes the URL as
  // given, whitespace and all.
  it.each([
    ['a space', ' '],
    ['a tab', '\t'],
    ['a line break', '\n'],
  ])('hides the whole password when it holds %s', async (_name, gap) => {
    const err = await fetchError(`https://user:s3cret${gap}PW@example.invalid/hook`);
    expect((err as Error).message).toContain(`s3cret${gap}PW`);
    const msg = errMsg(err);
    expect(msg).not.toContain('s3cret');
    expect(msg).not.toContain('PW@');
    expect(msg).toContain('https://***@example.invalid/hook');
  });

  it('hides the whole password in a stack and keeps its frames', async () => {
    const err = (await fetchError('https://user:s3cret PW@example.invalid/hook')) as Error;
    const raw = err.stack ?? '';
    const stack = redactSecrets(raw);
    expect(stack).not.toContain('s3cret');
    expect(stack).toContain('https://***@example.invalid/hook');
    // Whether undici's stack carries frames differs between Node builds (the CI
    // Node 24 printed none), so the frames are compared rather than required.
    const frames = (s: string) => s.split('\n').filter((l) => /^ {4}at /.test(l));
    expect(frames(stack)).toEqual(frames(raw));
  });

  // fetch repeats a URL it cannot parse, so a webhook URL missing its scheme,
  // or with a port out of range, carries its query string into the message.
  it('hides query string secrets of a URL fetch cannot parse', async () => {
    const err = await fetchError('example.invalid/hook?token=SECRETQ&api_key=SECRETK&n=1');
    expect((err as Error).message).toContain('SECRETQ');
    const msg = errMsg(err);
    expect(msg).not.toMatch(/SECRET[QK]/);
    expect(msg).toContain('example.invalid/hook?token=***&api_key=***&n=1');
  });

  it('hides a query string secret after the userinfo', async () => {
    const err = await fetchError('https://user:pw@example.invalid/hook?access_token=SECRETQ');
    expect((err as Error).message).toContain('SECRETQ');
    expect(errMsg(err)).toContain('https://***@example.invalid/hook?access_token=***');
  });

  it('hides a Telegram bot token in the path of a URL fetch cannot parse', async () => {
    const token = '123456:fake-bot-token-for-tests';
    const err = await fetchError(`https://api.telegram.org:99999/bot${token}/sendMessage`);
    expect((err as Error).message).toContain(token);
    const msg = errMsg(err);
    expect(msg).not.toContain('fake-bot');
    expect(msg).toContain('/bot***/sendMessage');
  });

  it('hides a header value fetch rejects for a newline', async () => {
    const err = await fetchError('http://127.0.0.1:9/x', {
      headers: { Authorization: 'Bearer drv_SECRET\nX' },
    });
    expect((err as Error).message).toContain('drv_SECRET');
    const msg = errMsg(err);
    expect(msg).not.toContain('drv_SECRET');
    expect(msg).toContain('is an invalid header value');
  });

  it('hides a header value fetch rejects for a NUL', async () => {
    const err = await fetchError('http://127.0.0.1:9/x', {
      headers: { Authorization: `Bearer drv_SECRET${String.fromCharCode(0)}X` },
    });
    expect((err as Error).message).toContain('drv_SECRET');
    expect(errMsg(err)).not.toContain('drv_SECRET');
  });
});

describe('redactSecrets()', () => {
  it('leaves text without credentials alone', () => {
    for (const text of [
      'HTTP 401',
      'connect ECONNREFUSED 127.0.0.1:8086',
      'POST https://example.com:8443/api/v1/athlete/weights returned 500',
      'mqtt://broker.lan:1883 unreachable',
      'Token refreshed successfully.',
      'Intervals.icu uses HTTP Basic auth',
      'mail me at someone@example.com',
      'POST https://influx.lan/api/v2/write?org=home&bucket=scale&precision=ms failed',
      'GET /search?monkey=1&keys=3&keyboard=us',
      'GET /bots/list and /bot/help',
    ]) {
      expect(redactSecrets(text)).toBe(text);
    }
  });

  // Every log line passes here. A rule that rescanned the rest of the text from
  // each place it could start (`scheme://\S*@` from every `://`) took seconds on
  // these and minutes on a 1 MB line; linear, each is a millisecond or two.
  it('stays linear on long lines that repeat what a rule looks for', () => {
    const lines = [
      `[${Array.from({ length: 8000 }, () => '"http://h.example/x"').join(',')}]`,
      'Headers.append: "'.repeat(16000),
      'Failed to parse URL from x'.repeat(10000),
    ];
    for (const line of lines) {
      const started = performance.now();
      expect(redactSecrets(line)).toBe(line);
      expect(performance.now() - started).toBeLessThan(250);
    }
  });

  it('hides a password that itself contains @ and /', () => {
    expect(redactSecrets('at mqtt://user:p@ss/w0rd@broker:1883 now')).toBe(
      'at mqtt://***@broker:1883 now',
    );
  });

  it('hides an Authorization value and a bare Bearer token', () => {
    expect(redactSecrets('sent Authorization: Bearer abc123def456')).toBe(
      'sent Authorization: ***',
    );
    expect(redactSecrets('{"authorization":"Token abcdefgh1234"}')).toBe('{"authorization":"***"}');
    expect(redactSecrets('rejected Bearer drv_0123456789abcdef')).toBe('rejected Bearer ***');
  });
});
