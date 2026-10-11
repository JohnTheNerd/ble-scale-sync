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
    ]) {
      expect(redactSecrets(text)).toBe(text);
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
