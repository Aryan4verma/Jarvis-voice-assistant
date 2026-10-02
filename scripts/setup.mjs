#!/usr/bin/env node
// JARVIS preflight — a friendly, advisory check you run with `npm run setup`.
//
// It changes nothing and installs nothing. It looks at your machine, tells you
// what is ready and what is missing, and prints the two commands that start
// JARVIS. Every check degrades to a single friendly line if something is not
// there, and the script always exits 0 — it is advice, not a gate.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { NODE_REQUIREMENT, supportsNode } from './runtime.mjs';

const tick = '  ok  ';
const warn = ' note ';
const info = '  ·   ';

function line(tag, msg) {
  console.log(`[${tag}] ${msg}`);
}

console.log('');
console.log('JARVIS preflight — checking your machine (nothing is changed)');
console.log('------------------------------------------------------------');

// --- Node version --------------------------------------------------------
try {
  if (supportsNode()) {
    line(tick, `Node.js ${process.versions.node} (${NODE_REQUIREMENT} required).`);
  } else {
    line(warn, `Node.js ${process.versions.node} is unsupported. Use ${NODE_REQUIREMENT}; Node 24 LTS is recommended.`);
  }
} catch {
  line(warn, `Could not read the Node.js version. JARVIS needs ${NODE_REQUIREMENT}.`);
}

// --- Claude CLI on PATH ---------------------------------------------------
let claudeFound = false;
try {
  let res = spawnSync('claude', ['--version'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  if (process.platform === 'win32' && ['ENOENT', 'EINVAL'].includes(res.error?.code)) {
    // npm-installed CLI shims are .cmd files. Use a fixed command through cmd
    // only for this advisory probe; the application launcher uses Node directly.
    res = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'claude.cmd --version'], {
      encoding: 'utf8', timeout: 10000, windowsHide: true,
    });
  }
  if (res.status === 0 && res.stdout) {
    claudeFound = true;
    line(tick, `Claude CLI found: ${res.stdout.trim()}`);
  }
} catch {
  // ignore — handled below
}
if (!claudeFound) {
  line(warn, 'Claude CLI not found on your PATH.');
  line(info, 'Install it: npm install -g @anthropic-ai/claude-code');
  line(info, '  (or the platform installer at https://docs.claude.com/en/docs/claude-code)');
  line(info, 'Claude Agent mode uses the CLI authentication under Anthropic terms; cloud API modes use AI Settings instead.');
}

// --- ~/.claude.json and MCP servers --------------------------------------
const claudeJsonPath = join(homedir(), '.claude.json');
let mcpCount = 0;
try {
  const raw = readFileSync(claudeJsonPath, 'utf8');
  let parsed = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {};
  }
  const servers = parsed && typeof parsed.mcpServers === 'object' && parsed.mcpServers ? parsed.mcpServers : {};
  mcpCount = Object.keys(servers).length;
  if (mcpCount > 0) {
    line(tick, `~/.claude.json found with ${mcpCount} MCP server${mcpCount === 1 ? '' : 's'} configured.`);
  } else {
    line(info, '~/.claude.json found, but no MCP servers are configured yet. JARVIS still answers and drives its own interface.');
  }
} catch {
  line(info, '~/.claude.json not found yet. It appears once you run `claude` and log in. JARVIS works without any MCP servers.');
}

// --- ElevenLabs key (env or the elevenlabs MCP entry) --------------------
function findElevenLabsKey() {
  if (process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_API_KEY.trim()) {
    return 'environment (ELEVENLABS_API_KEY)';
  }
  try {
    const raw = readFileSync(claudeJsonPath, 'utf8');
    const parsed = JSON.parse(raw);
    const servers = parsed && parsed.mcpServers ? parsed.mcpServers : {};
    const el = servers.elevenlabs;
    const env = el && el.env ? el.env : {};
    if (env.ELEVENLABS_API_KEY && String(env.ELEVENLABS_API_KEY).trim()) {
      return 'the elevenlabs MCP server in ~/.claude.json';
    }
  } catch {
    // ignore — no key discoverable
  }
  return null;
}

const elSource = findElevenLabsKey();
if (elSource) {
  line(tick, `Premium voice available — ElevenLabs key found via ${elSource}.`);
} else {
  line(info, 'No ElevenLabs key found — JARVIS will use browser speech (that is completely fine).');
  line(info, '  Optional: configure ElevenLabs through Voice Settings; provider account limits and terms apply.');
}

// --- How to run ----------------------------------------------------------
console.log('');
console.log('To run JARVIS, open two terminals:');
console.log('  1)  npm run bridge      # the authenticated AI bridge');
console.log('  2)  npm run dev         # the face (open http://localhost:5173 in Chrome)');
console.log('');
console.log('Then click INITIALISE and say "Hey Jarvis".');
console.log('`npm run bridge:writes` broadens tool permissions; it does not add missing browser/phone integrations.');
console.log('');

process.exit(0);
