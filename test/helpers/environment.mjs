// Every test process starts outside the real user configuration and transcript roots.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'limitcast-test-'));
process.env.HOME = root;
for (const key of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GROK_HOME', 'LIMITCAST_STATE', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME'])
  process.env[key] = join(root, key.toLowerCase());
delete process.env.LIMITCAST_ALLOW;
delete process.env.LIMITCAST_LICENSE;
