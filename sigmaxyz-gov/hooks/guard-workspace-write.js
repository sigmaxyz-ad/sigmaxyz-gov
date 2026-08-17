#!/usr/bin/env node
// guard-workspace-write.js — workspace 外への書込/削除を検知（policy 駆動エンジン版）
// policy: guards['workspace-write'].mode (block|warn|off, 既定 warn)
'use strict';
const path = require('path');
const H = require('./lib/hooklib');

const inp = H.readInput();
const MODE = H.guardMode('workspace-write', 'warn');
// システム領域（/etc /usr /bin ... / C:\Windows / C:\Program Files 等）への書込は
// 「疑いようのない危険操作」として既定 block を維持（policy で個別調整可）。
// グレーゾーン（%APPDATA% 等の workspace 外）のみ warn/ask に格下げ。
const SYS_MODE = H.guardMode('workspace-write-system', 'block');
if (MODE === 'off' && SYS_MODE === 'off') H.allow();

function deny(target, where, isSystem) {
  const mode = isSystem ? SYS_MODE : MODE;
  if (mode === 'off') return;
  const head = isSystem
    ? `[guard-workspace-write] システム領域への書込/削除です（既定で拒否）。\n`
    : `[guard-workspace-write] ~/workspace の外への書込/削除です（原則 workspace に集約）。\n`;
  H.enforce(mode,
    head +
      `  対象: ${target}\n` +
      `  検出箇所: ${where}\n\n` +
      (isSystem
        ? `/etc・/usr・C:\\Windows・C:\\Program Files 等の OS/システム領域への書込は既定で拒否します。\n` +
          `正当な理由がある場合は policy(guards['workspace-write-system'].mode) で調整してください。\n`
        : `原則は ~/workspace/ 配下・OS 一時ディレクトリ・アプリのネイティブ設定領域(%APPDATA% 等)です。\n` +
          `意図的な書込であれば、確認のうえ続行してください。理由なく workspace 外へ散らかさないでください。\n`) +
      `（秘密情報の外部送信・破壊的操作は別途制限されます）`
  );
}

// deny() は block なら即 exit、warn なら ask を出して exit 0 する。つまり最初に当たった1件で打ち切られる。
// そのため「重い方（システム領域=既定 block）から先に」評価する。逆順だと、workspace 外の1件目で
// ask(exit 0) して、後続のシステム領域書込を見ずに通してしまう（apply_patch は1回で複数ファイルを触る）。
function checkTargets(targets, where) {
  const rest = [];
  for (const t of targets) {
    if (!t) continue;
    const abs = H.toAbsolute(t, inp.cwd);
    // システム領域は生パスで表示（C:\... が実行 OS の cwd 前置で乱れるのを防ぐ）。
    if (H.isSystemPath(t)) deny(t, where, true);
    else if (H.isSystemPath(abs)) deny(abs, where, true);
    else rest.push(abs);
  }
  for (const abs of rest) {
    if (!H.isInsideWorkspace(abs)) deny(abs, where);
  }
}

// WRITE 系ツール（Claude=Write/Edit/NotebookEdit・Codex=apply_patch・Gemini=write_file/replace）。
// apply_patch は 1 回で複数ファイルを触るため filePaths を全件検査する（#119）。
if (H.isWriteTool(inp.toolName)) {
  const targets = inp.filePaths.length ? inp.filePaths : (inp.filePath ? [inp.filePath] : []);
  if (!targets.length) {
    // パッチ本文はあるのに書込先が1件も取れない = V4A として解釈できなかった（将来のフォーマット変更等）。
    // ここで静かに allow すると #119 と同じ失敗様式（スキーマ変更で素通り）を再生産するため、確認に落とす。
    if (inp.patch && inp.patch.trim() && MODE !== 'off') {
      H.ask(
        `[guard-workspace-write] ${inp.toolName} の内容をパッチとして解釈できず、書込先を特定できませんでした。\n` +
          `  先頭: ${inp.patch.slice(0, 120)}\n\n` +
          `フォーマットが変わった可能性があります（静かに許可せず確認に落としています）。\n` +
          `意図した操作であれば承認してください。`
      );
    }
    H.allow();
  }
  checkTargets(targets, `${inp.toolName} の書込対象`);
  H.allow();
}

if (H.isShellTool(inp.toolName)) {
  // シェル経由の apply_patch（heredoc / argv 連結）で切り出した対象ファイルも検査する。
  // コマンド文字列からの宛先抽出ではパッチの対象ファイルを拾えないため、ここが無いと素通りする。
  if (inp.patch) checkTargets(inp.filePaths, 'シェル経由 apply_patch の書込対象');
  const cmd = inp.command || '';
  if (!cmd.trim()) H.allow();
  const candidates = [];
  const redir = /(?:^|[\s;|&])(?:\d*>>?|&>)\s*("?)([^\s"'|;&]+)\1/g;
  let m;
  while ((m = redir.exec(cmd)) !== null) candidates.push(m[2]);
  const teeRe = /\btee\s+(?:-a\s+)?("?)([^\s"'|;&]+)\1/g;
  while ((m = teeRe.exec(cmd)) !== null) candidates.push(m[2]);
  for (const verb of ['cp', 'mv', 'install', 'rsync']) {
    const re = new RegExp('\\b' + verb + '\\b([^;|&]*)', 'g');
    while ((m = re.exec(cmd)) !== null) {
      const args = m[1].trim().split(/\s+/).filter((a) => a && !a.startsWith('-'));
      if (args.length >= 2) candidates.push(args[args.length - 1]);
    }
  }
  for (const verb of ['rm', 'rmdir', 'shred', 'unlink']) {
    const re = new RegExp('\\b' + verb + '\\b([^;|&]*)', 'g');
    while ((m = re.exec(cmd)) !== null) {
      const args = m[1].trim().split(/\s+/).filter((a) => a && !a.startsWith('-'));
      for (const a of args) candidates.push(a);
    }
  }
  for (const verb of ['mkdir', 'touch']) {
    const re = new RegExp('\\b' + verb + '\\b([^;|&]*)', 'g');
    while ((m = re.exec(cmd)) !== null) {
      const args = m[1].trim().split(/\s+/).filter((a) => a && !a.startsWith('-'));
      for (const a of args) candidates.push(a);
    }
  }
  for (let c of candidates) {
    if (!c) continue;
    if (H.isNullish(c)) continue;
    // 変数・グロブ・コマンド置換を含む宛先は絶対パス解決できないため、生文字列でシステム領域のみ判定。
    if (c.includes('$') || c.includes('*') || c.includes('`')) {
      if (H.isSystemPath(c)) deny(c, 'シェルのシステム領域パス', true);
      continue;
    }
    const abs = H.toAbsolute(c, inp.cwd);
    if (H.isSystemPath(c) || H.isSystemPath(abs)) deny(H.isSystemPath(c) ? c : abs, 'シェルのシステム領域パス', true);
    else if (!H.isInsideWorkspace(abs)) deny(abs, 'シェルの書込/削除対象');
  }
  H.allow();
}

H.allow();
