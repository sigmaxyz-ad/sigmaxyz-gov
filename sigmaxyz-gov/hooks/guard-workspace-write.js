#!/usr/bin/env node
// guard-workspace-write.js — workspace 外への書込/削除を検知（policy 駆動エンジン版）
// policy: guards['workspace-write'].mode (block|warn|off, 既定 warn)
'use strict';
const path = require('path');
const H = require('./lib/hooklib');

const inp = H.readInput();
const MODE = H.guardMode('workspace-write', 'warn');
if (MODE === 'off') H.allow();

function deny(target, where) {
  H.enforce(MODE,
    `[guard-workspace-write] ~/workspace の外への書込/削除です（原則 workspace に集約）。\n` +
      `  対象: ${target}\n` +
      `  検出箇所: ${where}\n\n` +
      `原則は ~/workspace/ 配下・OS 一時ディレクトリ・アプリのネイティブ設定領域(%APPDATA% 等)です。\n` +
      `意図的な書込であれば、確認のうえ続行してください。理由なく workspace 外へ散らかさないでください。\n` +
      `（秘密情報の外部送信・破壊的操作は別途制限されます）`
  );
}

if (['Write', 'Edit', 'NotebookEdit'].includes(inp.toolName)) {
  if (!inp.filePath) H.allow();
  const abs = H.toAbsolute(inp.filePath, inp.cwd);
  if (!H.isInsideWorkspace(abs)) deny(abs, `${inp.toolName} file_path`);
  H.allow();
}

if (inp.toolName === 'Bash') {
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
  const NULLISH = new Set([
    '/dev/null', '/dev/zero', '/dev/stdout', '/dev/stderr', '/dev/tty',
    '/dev/fd/1', '/dev/fd/2', 'nul', 'nul:', 'con',
  ]);
  function isNullish(c) {
    const l = (c || '').toLowerCase();
    if (NULLISH.has(l)) return true;
    if (/[\\/]dev[\\/](null|zero|stdout|stderr|tty)$/.test(l)) return true;
    return false;
  }
  for (let c of candidates) {
    if (!c) continue;
    if (isNullish(c)) continue;
    if (c.includes('$') || c.includes('*') || c.includes('`')) {
      if (/^\/(etc|usr|bin|sbin|boot|lib|opt|sys|proc)\b/.test(c)) deny(c, 'Bash system path');
      continue;
    }
    const abs = H.toAbsolute(c, inp.cwd);
    if (!H.isInsideWorkspace(abs)) deny(abs, 'Bash write/delete target');
  }
  H.allow();
}

H.allow();
