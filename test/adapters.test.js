'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  adapterStatus,
  installAdapters,
  uninstallAdapters,
} = require('../src/lib/adapters');

test('adapter installer merges hooks and preserves unrelated settings', (context) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'airbrake-adapters-'));
  context.after(() => fs.rmSync(home, { force: true, recursive: true }));

  const claudeFile = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(claudeFile), { recursive: true });
  fs.writeFileSync(claudeFile, JSON.stringify({
    theme: 'dark',
    hooks: {
      PreToolUse: [
        {
          matcher: '*',
          hooks: [
            {
              type: 'command',
              command: '/tmp/airbrake/bin/airbrake hook',
              statusMessage: 'airbrake-presence-gate',
            },
            {
              type: 'command',
              command: '/usr/local/bin/audit-hook',
            },
          ],
        },
      ],
    },
  }));

  installAdapters('all', { binPath: '/tmp/airbrake/bin/airbrake', home });
  const statuses = adapterStatus({ binPath: '/tmp/airbrake/bin/airbrake', home });
  assert.equal(statuses.every((status) => status.installed), true);

  const claude = JSON.parse(fs.readFileSync(claudeFile, 'utf8'));
  assert.equal(claude.theme, 'dark');
  assert.equal(claude.hooks.PreToolUse.length, 2);
  assert.equal(
    claude.hooks.PreToolUse[0].hooks[0].command,
    '/usr/local/bin/audit-hook',
  );
  assert.equal(fs.existsSync(`${claudeFile}.airbrake-backup`), true);

  installAdapters('claude', { binPath: '/new/location/airbrake', home });
  const refreshed = JSON.parse(fs.readFileSync(claudeFile, 'utf8'));
  assert.match(
    refreshed.hooks.PreToolUse[1].hooks[0].command,
    /new\/location\/airbrake/,
  );

  uninstallAdapters('all', { binPath: '/tmp/airbrake/bin/airbrake', home });
  assert.equal(adapterStatus({ home }).every((status) => !status.installed), true);

  const after = JSON.parse(fs.readFileSync(claudeFile, 'utf8'));
  assert.equal(after.theme, 'dark');
  assert.equal(after.hooks.PreToolUse.length, 1);
  assert.equal(
    after.hooks.PreToolUse[0].hooks[0].command,
    '/usr/local/bin/audit-hook',
  );
});
