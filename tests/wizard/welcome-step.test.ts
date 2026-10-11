import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { WizardContext } from '../../src/wizard/types.js';
import { scriptedPrompts } from '../helpers/scripted-prompts.js';

vi.mock('../../src/update-check.js', () => ({ checkForUpdate: vi.fn(async () => null) }));
vi.mock('../../src/update-state.js', () => ({ configureUpdateState: vi.fn() }));

const { welcomeStep } = await import('../../src/wizard/steps/welcome.js');

function ctxFor(configPath: string, prompts: WizardContext['prompts']): WizardContext {
  return {
    config: {},
    configPath,
    isEditMode: false,
    nonInteractive: false,
    platform: { os: 'linux', arch: 'x64', hasDocker: false, hasPython: false, pythonCommand: null },
    prompts,
  };
}

describe('welcomeStep', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'welcome-step-'));
    file = path.join(dir, 'config.yaml');
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('offers to edit a config that parses', async () => {
    fs.writeFileSync(file, 'version: 1\nusers: []\n');
    const { prompts } = scriptedPrompts([[/existing config/, 'edit']]);
    const ctx = ctxFor(file, prompts);
    await welcomeStep.run(ctx);
    expect(ctx.isEditMode).toBe(true);
  });

  // An unquoted password starting with '*' is read as an alias (the error names
  // it) and one starting with '!' as a tag (the yaml library warns on stderr
  // with the line). Neither may print the password.
  it.each([
    ['an alias', '*hunter2'],
    ['a tag', '!hunter2'],
  ])('does not print a password that YAML reads as %s', async (_name, value) => {
    fs.writeFileSync(file, `version: 1\nusers: []\npassword: ${value}\n`);
    const emitted = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { prompts } = scriptedPrompts([[/existing config/, 'fresh']]);

    await welcomeStep.run(ctxFor(file, prompts));

    const printed = [
      ...emitted.mock.calls,
      ...vi.mocked(console.log).mock.calls,
      ...vi.mocked(console.warn).mock.calls,
      ...vi.mocked(console.error).mock.calls,
    ]
      .map((args) => args.map(String).join(' '))
      .join('\n');
    expect(printed).not.toContain('hunter2');
  });

  // G-23: an unparseable file was offered for editing and silently became {}.
  it('does not offer edit mode for a config that cannot be parsed, and says why', async () => {
    fs.writeFileSync(file, 'users: [unclosed\n');
    const { prompts, asked } = scriptedPrompts([[/existing config/, 'edit']]);
    const ctx = ctxFor(file, prompts);
    await welcomeStep.run(ctx);

    expect(ctx.isEditMode).toBe(false);
    expect(asked.some((m) => /existing config/.test(m))).toBe(false);
    const out = vi
      .mocked(console.log)
      .mock.calls.map((c) => String(c[0]))
      .join('\n');
    expect(out).toMatch(/cannot be edited/);
  });
});
