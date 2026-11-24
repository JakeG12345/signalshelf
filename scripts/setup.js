#!/usr/bin/env node
// One-click setup + health check.
//   npm run setup            install/rebuild deps, check everything, register MCP in Claude Desktop
//   npm run doctor           checks only, changes nothing
//   flags: --dry-run  --name <server-name>  --config <path to claude_desktop_config.json>
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MCP_PATH = path.join(ROOT, 'server', 'mcp.js');
const args = process.argv.slice(2);
const flag = f => args.includes(f);
const opt = (f, d) => (args.indexOf(f) >= 0 ? args[args.indexOf(f) + 1] : d);
const DOCTOR = flag('--doctor');
const DRY = flag('--dry-run') || DOCTOR;
const NAME = opt('--name', 'signal-shelf');
const NODE = process.execPath;
const PORT = Number(process.env.PORT) || 3456;

const c = { g: s => `\x1b[32m${s}\x1b[0m`, r: s => `\x1b[31m${s}\x1b[0m`, y: s => `\x1b[33m${s}\x1b[0m`, b: s => `\x1b[1m${s}\x1b[0m`, d: s => `\x1b[2m${s}\x1b[0m` };
const results = [];
const pass = (name, detail = '') => { results.push(['pass', name]); console.log(`  ${c.g('✔')} ${name}${detail ? c.d('  ' + detail) : ''}`); };
const warn = (name, detail = '') => { results.push(['warn', name]); console.log(`  ${c.y('!')} ${name}${detail ? '\n      ' + c.y(detail) : ''}`); };
const failc = (name, detail = '') => { results.push(['fail', name]); console.log(`  ${c.r('✘')} ${name}${detail ? '\n      ' + c.r(detail) : ''}`); };

function claudeConfigPath() {
  const custom = opt('--config');
  if (custom) return path.resolve(custom);
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  return path.join(os.homedir(), '.config', 'Claude', 'claude_desktop_config.json');
}

const SQLITE_PROBE = `
  const Database = (await import('better-sqlite3')).default;
  const d = new Database(':memory:');
  d.exec("CREATE VIRTUAL TABLE t USING fts5(x)");
  d.prepare("SELECT json_each.value FROM json_each('[1]')").all();
  console.log('ok');`;
const probe = code => spawnSync(NODE, ['--input-type=module', '-e', code], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, KT_SETUP_PROBE: '1' } });
const npm = (...a) => spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', a, { cwd: ROOT, stdio: 'inherit' });

async function mcpHandshake() {
  return new Promise(resolve => {
    const child = spawn(NODE, [MCP_PATH], { cwd: os.homedir(), stdio: ['pipe', 'pipe', 'pipe'] }); // cwd ≠ project, like Claude Desktop
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); resolve({ ok: false, error: 'timed out after 10s', stderr: err }); }, 10000);
    child.stdout.on('data', d => {
      out += d;
      for (const line of out.split('\n')) {
        try {
          const msg = JSON.parse(line);
          if (msg.id === 2) {
            clearTimeout(timer); child.kill();
            resolve({ ok: !!msg.result, tools: msg.result?.tools?.map(t => t.name) || [], error: msg.error?.message });
          }
        } catch { /* partial line */ }
      }
    });
    child.stderr.on('data', d => { err += d; });
    child.on('exit', code => { clearTimeout(timer); resolve({ ok: false, error: `exited with code ${code}`, stderr: err }); });
    const send = m => child.stdin.write(JSON.stringify(m) + '\n');
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'kt-setup', version: '1' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  });
}

async function main() {
  console.log(c.b(`\nSignal Shelf ${DOCTOR ? 'doctor' : 'setup'}${DRY && !DOCTOR ? ' (dry run)' : ''}\n`));

  // 1. Node
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 18) pass(`Node ${process.versions.node}`, NODE);
  else { failc(`Node ${process.versions.node} is too old`, 'Install Node 18+ (https://nodejs.org) and re-run.'); return summary(); }

  // 2. Dependencies
  if (!fs.existsSync(path.join(ROOT, 'node_modules', '@modelcontextprotocol', 'sdk'))) {
    if (DRY) failc('Dependencies not installed', 'Run: npm install');
    else { console.log(c.d('    installing dependencies…')); if (npm('install', '--no-fund', '--no-audit').status !== 0) { failc('npm install failed'); return summary(); } pass('Dependencies installed'); }
  } else pass('Dependencies present');

  // 3. Native SQLite module matches this Node
  let p = probe(SQLITE_PROBE);
  if (p.stdout.trim() !== 'ok') {
    const abi = /NODE_MODULE_VERSION|did not self-register|dlopen|wrong ELF|incompatible architecture/i.test(p.stderr);
    if (!DRY) {
      console.log(c.d(`    better-sqlite3 failed to load${abi ? ' (built for another Node/arch)' : ''}; rebuilding…`));
      npm('rebuild', 'better-sqlite3');
      p = probe(SQLITE_PROBE);
    }
    if (p.stdout.trim() === 'ok') pass('better-sqlite3 rebuilt for this Node');
    else { failc('better-sqlite3 cannot load', (p.stderr.split('\n').find(l => /Error/.test(l)) || p.stderr).trim() + '\n      Try: rm -rf node_modules && npm install'); return summary(); }
  } else pass('SQLite + FTS5 + JSON1 available');

  // 4. Database opens + migrates
  const dbProbe = probe(`const m = await import(${JSON.stringify(new URL('../server/db.js', import.meta.url).href)});
    const s = m.getStats(); console.log(JSON.stringify({ schema: m.db.pragma('user_version', { simple: true }), total: s.total, path: m.DB_PATH }));`);
  try {
    const info = JSON.parse(dbProbe.stdout.trim().split('\n').pop());
    pass(`Database ready (schema v${info.schema}, ${info.total} entries)`, info.path);
  } catch {
    failc('Database failed to open', dbProbe.stderr.trim().split('\n').slice(0, 3).join('\n      '));
    return summary();
  }

  // 5. MCP handshake
  const hs = await mcpHandshake();
  if (hs.ok) pass(`MCP server responds (${hs.tools.length} tools)`, hs.tools.join(', '));
  else { failc('MCP server did not respond', `${hs.error}${hs.stderr ? '\n      ' + hs.stderr.trim().split('\n').slice(-3).join('\n      ') : ''}`); }

  // 6. Claude Desktop config
  const cfgPath = claudeConfigPath();
  const entry = { command: NODE, args: [MCP_PATH] };
  let cfg = {};
  let cfgOk = true;
  if (fs.existsSync(cfgPath)) {
    try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8') || '{}'); }
    catch (e) { cfgOk = false; failc('claude_desktop_config.json is not valid JSON, not touching it', `${cfgPath}: ${e.message}`); }
  }
  if (cfgOk) {
    const current = cfg.mcpServers?.[NAME];
    const same = current && current.command === entry.command && JSON.stringify(current.args) === JSON.stringify(entry.args);
    if (same) pass(`Registered in Claude Desktop as "${NAME}"`, cfgPath);
    else if (DRY) {
      (DOCTOR ? warn : pass)(current ? `Claude Desktop entry "${NAME}" is out of date` : `Not yet registered in Claude Desktop`, DOCTOR ? 'Run: npm run setup' : 'would write ' + JSON.stringify(entry));
    } else {
      fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
      if (fs.existsSync(cfgPath)) {
        const bak = `${cfgPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
        fs.copyFileSync(cfgPath, bak);
        console.log(c.d(`    backup: ${bak}`));
      }
      cfg.mcpServers = { ...(cfg.mcpServers || {}), [NAME]: entry };
      const tmp = cfgPath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n');
      fs.renameSync(tmp, cfgPath);
      pass(`${current ? 'Updated' : 'Registered'} "${NAME}" in Claude Desktop`, cfgPath);
      console.log(c.y('      → Fully quit Claude Desktop (⌘Q) and reopen it to load the tools.'));
    }
  }

  // 7. Apple Podcasts (macOS only)
  if (process.platform === 'darwin') {
    const pod = path.join(os.homedir(), 'Library/Group Containers/243LU875E5.groups.com.apple.podcasts/Documents/MTLibrary.sqlite');
    if (!fs.existsSync(pod)) warn('Apple Podcasts library not found', 'Open the Podcasts app once if you want podcast sync.');
    else {
      try { fs.closeSync(fs.openSync(pod, 'r')); pass('Apple Podcasts library readable'); }
      catch { warn('Apple Podcasts library is blocked by macOS privacy', 'System Settings → Privacy & Security → Full Disk Access → enable your terminal app (and Claude, for MCP sync).'); }
    }
  }

  // 8. Dashboard (informational)
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(1500) });
    const h = await r.json();
    pass(`Dashboard running on http://localhost:${PORT}`, `v${h.version}`);
  } catch {
    warn(`Dashboard not running on port ${PORT}`, 'Start it with: npm start  (needed for the Chrome extension; MCP works without it)');
  }

  console.log(c.d(`\n  Claude Code users:  claude mcp add ${NAME} -- "${NODE}" "${MCP_PATH}"`));
  console.log(c.d('  Note: the config pins this exact Node binary. If you switch Node versions (nvm), re-run npm run setup.'));
  summary();
}

function summary() {
  const fails = results.filter(r => r[0] === 'fail').length;
  const warns = results.filter(r => r[0] === 'warn').length;
  console.log('\n' + (fails ? c.r(`✘ ${fails} problem(s) need fixing`) : c.g('✔ All good')) + (warns ? c.y(`, ${warns} warning(s)`) : '') + '\n');
  process.exitCode = fails ? 1 : 0;
}

main().catch(err => { console.error(c.r(err.stack || err.message)); process.exit(1); });
