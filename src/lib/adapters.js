'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readJson, writeJson } = require('./json-file');

const MARKER = 'airbrake-presence-gate';

function quoteShell(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function hookCommand(binPath = fs.realpathSync(process.argv[1])) {
  return `${quoteShell(binPath)} hook`;
}

function claudeGroup(command) {
  return {
    matcher: '*',
    hooks: [
      {
        type: 'command',
        command,
        timeout: 2,
        statusMessage: MARKER,
      },
    ],
  };
}

function geminiGroup(command) {
  return {
    matcher: '.*',
    hooks: [
      {
        name: MARKER,
        type: 'command',
        command,
        timeout: 1000,
        description: 'Require an active Airbrake operator lease before tool execution.',
      },
    ],
  };
}

function isAirbrakeHook(hook) {
  return (
    hook.name === MARKER ||
    hook.statusMessage === MARKER ||
    /(?:^|[/\\])airbrake(?:'|")?\s+hook$/.test(String(hook.command || ''))
  );
}

function containsAirbrake(group) {
  return (group.hooks || []).some(isAirbrakeHook);
}

function withoutAirbrake(group) {
  return {
    ...group,
    hooks: (group.hooks || []).filter((hook) => !isAirbrakeHook(hook)),
  };
}

function addHook(config, eventName, group) {
  config.hooks ||= {};
  config.hooks[eventName] ||= [];
  config.hooks[eventName] = config.hooks[eventName]
    .map(withoutAirbrake)
    .filter((existing) => existing.hooks.length > 0);
  config.hooks[eventName].push(group);
  return config;
}

function removeHook(config, eventName) {
  if (!config.hooks || !Array.isArray(config.hooks[eventName])) {
    return config;
  }
  config.hooks[eventName] = config.hooks[eventName]
    .map(withoutAirbrake)
    .filter((group) => group.hooks.length > 0);
  if (config.hooks[eventName].length === 0) {
    delete config.hooks[eventName];
  }
  if (Object.keys(config.hooks).length === 0) {
    delete config.hooks;
  }
  return config;
}

function adapterSpecs({ home = os.homedir(), binPath } = {}) {
  const command = hookCommand(binPath);
  return {
    claude: {
      file: path.join(home, '.claude', 'settings.json'),
      event: 'PreToolUse',
      group: claudeGroup(command),
      mode: 'merge',
    },
    codex: {
      file: path.join(home, '.codex', 'hooks.json'),
      event: 'PreToolUse',
      group: claudeGroup(command),
      mode: 'merge',
      note: 'Review and trust the hook in Codex with /hooks before relying on it.',
    },
    copilot: {
      file: path.join(home, '.copilot', 'hooks', 'airbrake.json'),
      event: 'PreToolUse',
      group: claudeGroup(command),
      mode: 'standalone',
      root: { version: 1, description: 'Airbrake proof-of-concept presence hook.' },
    },
    gemini: {
      file: path.join(home, '.gemini', 'settings.json'),
      event: 'BeforeTool',
      group: geminiGroup(command),
      mode: 'merge',
    },
  };
}

function normalizeNames(name) {
  const supported = Object.keys(adapterSpecs());
  if (!name || name === 'all') {
    return supported;
  }
  if (!supported.includes(name)) {
    throw new Error(`Unknown adapter '${name}'. Expected one of: ${supported.join(', ')}, all.`);
  }
  return [name];
}

function installAdapters(name = 'all', options = {}) {
  const specs = adapterSpecs(options);
  const results = [];
  for (const adapter of normalizeNames(name)) {
    const spec = specs[adapter];
    const config = spec.mode === 'standalone'
      ? { ...spec.root }
      : readJson(spec.file);
    addHook(config, spec.event, spec.group);
    writeJson(spec.file, config);
    results.push({
      adapter,
      file: spec.file,
      installed: true,
      note: spec.note,
    });
  }
  return results;
}

function uninstallAdapters(name = 'all', options = {}) {
  const specs = adapterSpecs(options);
  const results = [];
  for (const adapter of normalizeNames(name)) {
    const spec = specs[adapter];
    if (!fs.existsSync(spec.file)) {
      results.push({ adapter, file: spec.file, installed: false });
      continue;
    }
    const config = readJson(spec.file);
    removeHook(config, spec.event);
    if (spec.mode === 'standalone' && !config.hooks) {
      fs.unlinkSync(spec.file);
    } else {
      writeJson(spec.file, config);
    }
    results.push({ adapter, file: spec.file, installed: false });
  }
  return results;
}

function adapterStatus(options = {}) {
  const specs = adapterSpecs(options);
  return Object.entries(specs).map(([adapter, spec]) => {
    if (!fs.existsSync(spec.file)) {
      return {
        adapter,
        file: spec.file,
        installed: false,
      };
    }
    const config = readJson(spec.file);
    const installed = Boolean(config.hooks?.[spec.event]?.some(containsAirbrake));
    return {
      adapter,
      file: spec.file,
      installed,
      note: installed ? spec.note : undefined,
    };
  });
}

module.exports = {
  MARKER,
  adapterSpecs,
  adapterStatus,
  addHook,
  containsAirbrake,
  hookCommand,
  installAdapters,
  removeHook,
  uninstallAdapters,
};
