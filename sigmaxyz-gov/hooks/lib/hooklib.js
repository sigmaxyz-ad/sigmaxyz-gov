// hooklib.js — SIGMAXYZ AI ハーネス共通ライブラリ（Windows / Linux 両対応 / Node.js 単一ソース）
//
// PreToolUse / SessionStart フックの共通処理:
//   - stdin JSON の読み取り
//   - パス解決（~ 展開・絶対化・OS 差吸収）
//   - ユーザー自由領域(workspace)の判定
//   - ブロック/許可の出力ヘルパ（exit 2 = ブロック・stderr をモデルに提示）

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// ---- stdin（フック入力 JSON）を読む -------------------------------------
// PreToolUse: { tool_name, tool_input:{ command, file_path, ... }, cwd, ... }
function readInput() {
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8'); // fd 0 = stdin
  } catch (_) {
    raw = '';
  }
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch (_) {
    data = {};
  }
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

// ---- パス解決ヘルパ ------------------------------------------------------
const HOME = os.homedir();

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return HOME;
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(HOME, p.slice(2));
  return p;
}

// 絶対パス化（相対は cwd 基準）。シンボリックリンクは展開しない（解決前の意図を見る）
function toAbsolute(p, cwd) {
  if (!p) return '';
  const e = expandHome(p);
  return path.resolve(cwd || HOME, e);
}

// OS 差を吸収して比較用に正規化（Windows は小文字化・バックスラッシュ→スラッシュ）
function normalize(p) {
  let n = path.resolve(p);
  if (process.platform === 'win32') {
    n = n.replace(/\\/g, '/').toLowerCase();
  }
  return n;
}

// ---- ユーザー自由領域（workspace）判定 ----------------------------------
// 許可される書込先:
//   - <HOME>/workspace 配下（要件①：自由領域。スキル・ランタイムも ~/workspace 配下へ寄せる）
//   - OS の一時ディレクトリ配下（os.tmpdir()）
//   - 移設できない OS 固有のユーザー設定（VS Code 設定 / ~/.gitconfig）= 許可リスト例外
//     ※ claude 設定・Scoop 等のランタイムは ~/workspace へ relocate する前提（CLAUDE_CONFIG_DIR 等）。
//        そのため ~/.claude 等は relocate 済みで対象外（書込ブロック）。
function allowedWriteRoots() {
  const roots = [
    path.join(HOME, 'workspace'),
    os.tmpdir(),
    // OS 固有・移設不可のユーザー設定（限定的に許可）
    path.join(HOME, '.config', 'Code'), // Linux: VS Code 設定のみ許可(~/.config 全体は許可しない)
    path.join(HOME, 'AppData', 'Roaming', 'Code'), // Windows: VS Code ユーザー設定
    path.join(HOME, '.gitconfig'), // git ユーザー設定（ファイル）
  ];
  // Windows の代表的 tmp も明示
  if (process.platform === 'win32' && process.env.TEMP) {
    roots.push(process.env.TEMP);
  }
  return roots.map(normalize);
}

function isInsideWorkspace(absPath) {
  const target = normalize(absPath);
  return allowedWriteRoots().some((root) => target === root || target.startsWith(root + '/'));
}

// ---- 出力ヘルパ ----------------------------------------------------------
// ブロック: exit 2 + stderr。stderr の文面がモデルに提示され、行動を是正させる。
function block(message) {
  process.stderr.write(message.endsWith('\n') ? message : message + '\n');
  process.exit(2);
}

// 許可（何もしない）
function allow() {
  process.exit(0);
}

// 人間の承認を求める（exit 0 + JSON。permissionDecision=ask）。auto モードでも確認ダイアログが出る。
function ask(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason: reason,
      },
    })
  );
  process.exit(0);
}

// 非ブロックの注意喚起（SessionStart 等で systemMessage を出す）
function notify(systemMessage) {
  try {
    process.stdout.write(JSON.stringify({ systemMessage, continue: true, suppressOutput: false }));
  } catch (_) {}
  process.exit(0);
}

module.exports = {
  readInput,
  expandHome,
  toAbsolute,
  normalize,
  HOME,
  allowedWriteRoots,
  isInsideWorkspace,
  block,
  allow,
  ask,
  notify,
};
