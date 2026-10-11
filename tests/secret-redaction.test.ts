import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { WebhookExporter } from '../src/exporters/webhook.js';
import { NtfyExporter } from '../src/exporters/ntfy.js';
import { formatNotification } from '../src/exporters/notification-message.js';
import { dispatchExports } from '../src/orchestrator.js';
import { saveQueue, flushQueue, enqueue, type QueuedExport } from '../src/runtime/export-queue.js';
import type { Exporter } from '../src/interfaces/exporter.js';
import type { BodyComposition } from '../src/interfaces/scale-adapter.js';

/**
 * Credentials in a misconfigured exporter must not travel with its error.
 *
 * Node's fetch repeats a `user:password@` URL in its TypeError, and that text
 * went to the log (three times per export), to the retry queue file as
 * `lastError`, and to the ntfy/telegram report, which can be a public topic.
 * Each sink is checked here with the REAL fetch: the request is refused while
 * it is being built, so nothing leaves the machine.
 */

const SECRET = 's3cretPW';
const CREDENTIAL_URL = `https://user:${SECRET}@example.invalid/hook`;

const PAYLOAD: BodyComposition = {
  weight: 80,
  impedance: 500,
  bmi: 23.9,
  bodyFatPercent: 18.5,
  waterPercent: 55.2,
  boneMass: 3.1,
  muscleMass: 62.4,
  visceralFat: 8,
  physiqueRating: 5,
  bmr: 1750,
  metabolicAge: 30,
};

/** The message the real fetch throws for the credential URL, unredacted. */
async function rawFetchMessage(): Promise<string> {
  try {
    await fetch(CREDENTIAL_URL);
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error('fetch was expected to refuse a URL with credentials');
}

/** An exporter that reports the raw fetch text itself, without errMsg(). */
function rawErrorExporter(name: string, message: string): Exporter {
  return {
    name,
    supportsBackdate: true,
    export: async () => ({ success: false, error: message }),
  };
}

let consoleCalls: unknown[][];

beforeEach(() => {
  consoleCalls = [];
  for (const level of ['log', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      consoleCalls.push(args);
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function everythingLogged(): string {
  return consoleCalls.map((args) => args.map(String).join(' ')).join('\n');
}

describe('credentials in fetch errors', () => {
  it('precondition: the raw fetch message carries the password', async () => {
    // Without this, every test below would pass against a Node that stopped
    // echoing the URL, and prove nothing.
    expect(await rawFetchMessage()).toContain(SECRET);
  });

  it('keeps them out of the webhook result and every log line', async () => {
    const webhook = new WebhookExporter({
      url: CREDENTIAL_URL,
      method: 'POST',
      headers: {},
      timeout: 5000,
    });

    const result = await webhook.export(PAYLOAD);

    expect(result.success).toBe(false);
    expect(result.error).toContain('https://***@example.invalid/hook');
    expect(result.error).not.toContain(SECRET);
    expect(consoleCalls.length).toBeGreaterThan(0);
    expect(everythingLogged()).not.toContain(SECRET);
  });

  it('keeps them out of the dispatch detail and the export report', async () => {
    const realFetch = globalThis.fetch;
    const reports: string[] = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).startsWith('http://ntfy.test/')) {
        reports.push(String(init?.body));
        return new Response(null, { status: 200 });
      }
      return realFetch(input, init);
    });
    const ntfy = new NtfyExporter({
      url: 'http://ntfy.test',
      topic: 'scale',
      title: 'Scale',
      priority: 3,
      reportExports: true,
    });
    const webhook = new WebhookExporter({
      url: CREDENTIAL_URL,
      method: 'POST',
      headers: {},
      timeout: 5000,
    });
    // This one bypasses errMsg(), so only the orchestrator stands between its
    // text and the report.
    const raw = rawErrorExporter('garmin', await rawFetchMessage());

    const result = await dispatchExports([webhook, raw, ntfy], PAYLOAD);

    const failed = result.details.filter((d) => !d.ok);
    expect(failed.map((d) => d.name).sort()).toEqual(['garmin', 'webhook']);
    for (const detail of failed) expect(detail.error).not.toContain(SECRET);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain('❌ garmin: ');
    expect(reports[0]).toContain('❌ webhook: ');
    expect(reports[0]).not.toContain(SECRET);
    expect(everythingLogged()).not.toContain(SECRET);
  });

  it('redacts a report error before cutting it to 120 characters', () => {
    // The cut lands between the password and its `@`. Redacting the cut text
    // instead would find no userinfo left to recognise.
    const error = `${'x'.repeat(98)} https://user:${SECRET}@example.invalid/hook`;
    expect(error.indexOf('@')).toBe(120);

    const text = formatNotification(PAYLOAD, {
      exportResults: [{ name: 'webhook', ok: false, error }],
    });

    expect(text).not.toContain(SECRET);
  });
});

describe('credentials in the retry queue file', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-redaction-'));
    file = path.join(dir, 'queue.jsonl');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // A file written by a version without redaction holds the raw text. The next
  // write of the queue, here the one that adds a new failure, must not carry it
  // over.
  it('redacts a lastError that an older version left in the file', () => {
    const now = Date.now();
    const old: QueuedExport = {
      exporter: 'webhook',
      payload: PAYLOAD,
      queuedAt: new Date(now - 60_000).toISOString(),
      attempts: 1,
      lastError: `Request cannot be constructed from a URL that includes credentials: ${CREDENTIAL_URL}`,
    };
    fs.writeFileSync(file, JSON.stringify(old) + '\n');

    enqueue(file, { ...old, exporter: 'influxdb', queuedAt: new Date(now).toISOString() }, now);

    const stored = fs.readFileSync(file, 'utf-8');
    expect(stored.trim().split('\n')).toHaveLength(2);
    expect(stored).toContain('https://***@example.invalid/hook');
    expect(stored).not.toContain(SECRET);
  });

  it('stores a redacted lastError when a queued export throws the fetch error', async () => {
    const queued: QueuedExport = {
      exporter: 'webhook',
      payload: PAYLOAD,
      queuedAt: new Date(Date.now() - 3600_000).toISOString(),
      attempts: 0,
    };
    saveQueue(file, [queued]);
    // Throws the real TypeError straight into flushQueue, no withRetry between.
    const throwing: Exporter = {
      name: 'webhook',
      supportsBackdate: true,
      export: async () => {
        await fetch(CREDENTIAL_URL);
        return { success: true };
      },
    };

    const outcome = await flushQueue(file, () => throwing);

    expect(outcome.failed).toBe(1);
    const stored = fs.readFileSync(file, 'utf-8');
    expect(stored).toContain('https://***@example.invalid/hook');
    expect(stored).not.toContain(SECRET);
    expect(everythingLogged()).not.toContain(SECRET);
  });
});
