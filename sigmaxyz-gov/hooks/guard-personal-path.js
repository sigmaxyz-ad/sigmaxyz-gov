#!/usr/bin/env node
// guard-personal-path.js — 過剰反応是正版（読み取りコマンドで発火しない）
//
// 変更方針(2026-07-18, 堀MD 指摘):
//   従来は Bash コマンド文字列(inp.command)まで丸ごと検査していたため、
//   `ls /c/Users/<名>/...` のような「パスを参照するだけ」の読み取りでも警告が出ていた。
//   本 hook の目的は「ファイル/配布物に個人パスを焼き込むのを防ぐ」ことなので、
//   検査対象を Write/Edit の書込内容(inp.content)に限定する。
// 従来どおり block ではなく ask(人間確認)。汎用表記(~ / $env:USERPROFILE 等)は対象外。
'use strict';
const H = require('./lib/hooklib');
const os = require('os');
const path = require('path');

const inp = H.readInput();
const TARGET_TOOLS = ['Write', 'Edit', 'NotebookEdit'];
if (!TARGET_TOOLS.includes(inp.toolName)) H.allow();

// 検査対象 = 書込み内容のみ（Bash コマンドの参照パスは対象外＝過剰反応の除去）
const text = inp.content || '';
if (!text.trim()) H.allow();

const userName = (os.userInfo && os.userInfo().username) || path.basename(os.homedir() || '') || '';

const patterns = [];
patterns.push({ name: 'Windows ユーザー絶対パス', re: /[A-Za-z]:[\\/]Users[\\/]([A-Za-z0-9._-]+)/i });
patterns.push({ name: 'POSIX ユーザー絶対パス',   re: /\/(?:c\/)?(?:Users|home)\/([A-Za-z0-9._-]+)/ });

const hits = [];
for (const p of patterns) {
  const m = text.match(p.re);
  if (m) {
    const seg = (m[1] || '').toLowerCase();
    const generic = ['', 'user', 'username', 'youruser', 'name', '<name>', '<user>', 'public', 'default', 'all users'];
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

H.ask(
  `[guard-personal-path] 書込み内容に絶対パス/個人名の混入を検出しました。\n` +
    hits.map((h) => `  - ${h}`).join('\n') +
    `\n\n配布物・設定・コードに個人名や C:\\Users\\<名> 等の絶対パスを焼くと、` +
    `配布先で動かず・個人情報漏れの原因になります。\n` +
    `対処: 汎用表記に置き換えてください(~ / $HOME / $env:USERPROFILE / %USERPROFILE% / 相対パス)。\n` +
    `ログ出力や正当な引用であれば、確認のうえ続行してください。`
);
