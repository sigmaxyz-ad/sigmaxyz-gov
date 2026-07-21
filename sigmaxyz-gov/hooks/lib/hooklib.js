// hooklib.js — SIGMAXYZ AI ハーネス共通ライブラリ（policy 駆動エンジン版）
//
// 設計: 「執行(enforcement)＝このコード/hook が必ず動く（TM が OS レベルで担保）」と
//       「方針(policy)＝何を block/warn/off にするか（AD が managed settings の env で即時調整）」を分離。
// policy の与え方（AD が Web Console の `env` で設定）:
//   - GOV_POLICY_JSON            : 完全な policy(JSON文字列)。優先。
//   - GOV_<GUARD>_MODE           : 個別ガードの mode = block | warn | off。例 GOV_PERSONAL_PATH_MODE
//   guards[name].scan 等の追加パラメータも GOV_POLICY_JSON で与えられる。
// policy 未設定でも各ガードは安全な既定値で動く（是正版の挙動）。

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// ---- stdin（フック入力 JSON）を読む -------------------------------------
function readInput() {
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch (_) { raw = ''; }
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1); // BOM 耐性
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch (_) { data = {}; }
  const toolInput = data.tool_input || data.toolInput || {};
  return {
    raw,
    toolName: data.tool_name || data.toolName || '',
    toolInput,
    command: toolInput.command || '',
    filePath: toolInput.file_path || toolInput.filePath || '',
    content: toolInput.content || toolInput.new_string || toolInput.text || '',
    cwd: data.cwd || process.cwd(),
  };
}

// ---- policy（AD が env で即時調整） --------------------------------------
let _pol = null;
function policy() {
  if (_pol) return _pol;
  _pol = { guards: {} };
  try { if (process.env.GOV_POLICY_JSON) { const p = JSON.parse(process.env.GOV_POLICY_JSON); if (p && typeof p === 'object') _pol = p; } } catch (_) {}
  if (!_pol.guards) _pol.guards = {};
  return _pol;
}
function guardMode(name, def) {
  const g = policy().guards[name] || {};
  const envKey = 'GOV_' + name.toUpperCase().replace(/-/g, '_') + '_MODE';
  return String(g.mode || process.env[envKey] || def).toLowerCase();
}
function guardParam(name, key, def) {
  const g = policy().guards[name] || {};
  return g[key] !== undefined ? g[key] : def;
}
// mode に従って block / ask(warn) / allow(off) を出し分け
function enforce(mode, message) {
  mode = String(mode || '').toLowerCase();
  if (mode === 'off') allow();
  if (mode === 'block') block(message);
  ask(message); // warn / ask
}

// ---- パス解決ヘルパ ------------------------------------------------------
const HOME = os.homedir();
function expandHome(p) {
  if (!p) return p;
  if (p === '~') return HOME;
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(HOME, p.slice(2));
  return p;
}
function toAbsolute(p, cwd) {
  if (!p) return '';
  const e = expandHome(p);
  return path.resolve(cwd || HOME, e);
}
function normalize(p) {
  let n = path.resolve(p);
  if (process.platform === 'win32') n = n.replace(/\\/g, '/').toLowerCase();
  return n;
}

// ---- ユーザー自由領域（workspace）判定 ----------------------------------
function allowedWriteRoots() {
  const roots = [
    path.join(HOME, 'workspace'),
    os.tmpdir(),
    path.join(HOME, '.config', 'Code'),
    path.join(HOME, 'AppData', 'Roaming', 'Code'),
    path.join(HOME, 'AppData', 'Roaming', 'Claude'),
    path.join(HOME, '.gitconfig'),
  ];
  if (process.platform === 'win32' && process.env.TEMP) roots.push(process.env.TEMP);
  return roots.map(normalize);
}
function isInsideWorkspace(absPath) {
  const target = normalize(absPath);
  return allowedWriteRoots().some((root) => target === root || target.startsWith(root + '/'));
}

// ---- 出力ヘルパ ----------------------------------------------------------
function block(message) {
  process.stderr.write(message.endsWith('\n') ? message : message + '\n');
  process.exit(2);
}
function allow() { process.exit(0); }
function ask(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: reason },
  }));
  process.exit(0);
}
function notify(systemMessage) {
  try { process.stdout.write(JSON.stringify({ systemMessage, continue: true, suppressOutput: false })); } catch (_) {}
  process.exit(0);
}

module.exports = {
  readInput,
  policy, guardMode, guardParam, enforce,
  expandHome, toAbsolute, normalize, HOME,
  allowedWriteRoots, isInsideWorkspace,
  block, allow, ask, notify,
};
