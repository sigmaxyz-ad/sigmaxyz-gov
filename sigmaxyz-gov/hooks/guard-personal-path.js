#!/usr/bin/env node
// guard-personal-path.js — 書込内容への個人パス/個人名の焼き込みを検知（policy 駆動エンジン版）
// policy: guards['personal-path'].mode (block|warn|off, 既定 warn) / .scan (検査対象ツール, 既定 Write/Edit/NotebookEdit)
'use strict';
const H = require('./lib/hooklib');
const os = require('os');
const path = require('path');

const inp = H.readInput();
const MODE = H.guardMode('personal-path', 'warn');
if (MODE === 'off') H.allow();

// 既定は Write/Edit/NotebookEdit のみ（読み取りコマンドで発火しない）。policy で Bash 等を追加可。
const SCAN = H.guardParam('personal-path', 'scan', ['Write', 'Edit', 'NotebookEdit']);
if (!SCAN.includes(inp.toolName)) H.allow();
const text = inp.toolName === 'Bash' ? (inp.command || '') : (inp.content || '');
if (!text.trim()) H.allow();

const userName = (os.userInfo && os.userInfo().username) || path.basename(os.homedir() || '') || '';

const patterns = [
  { name: 'Windows ユーザー絶対パス', re: /[A-Za-z]:[\\/]Users[\\/]([A-Za-z0-9._-]+)/i },
  { name: 'POSIX ユーザー絶対パス', re: /\/(?:c\/)?(?:Users|home)\/([A-Za-z0-9._-]+)/ },
];
const generic = ['', 'user', 'username', 'youruser', 'name', '<name>', '<user>', 'public', 'default', 'all users'];
const hits = [];
for (const p of patterns) {
  const m = text.match(p.re);
  if (m) {
    const seg = (m[1] || '').toLowerCase();
    if (generic.includes(seg)) continue;
    hits.push(`${p.name}: ${m[0]}`);
  }
}
if (userName && userName.length >= 3) {
  const reName = new RegExp(`\\b${userName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  if (reName.test(text) && !hits.some((h) => h.toLowerCase().includes(userName.toLowerCase()))) {
    hits.push(`ログイン名(個人名): ${userName}`);
  }
}
if (hits.length === 0) H.allow();

H.enforce(MODE,
  `[guard-personal-path] 書込み内容に絶対パス/個人名の混入を検出しました。\n` +
    hits.map((h) => `  - ${h}`).join('\n') +
    `\n\n配布物・設定・コードに個人名や C:\\Users\\<名> 等の絶対パスを焼くと、` +
    `配布先で動かず・個人情報漏れの原因になります。\n` +
    `対処: 汎用表記に置き換えてください(~ / $HOME / $env:USERPROFILE / %USERPROFILE% / 相対パス)。\n` +
    `ログ出力や正当な引用であれば、確認のうえ続行してください。`
);
