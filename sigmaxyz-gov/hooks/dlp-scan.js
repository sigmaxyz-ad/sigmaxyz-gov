#!/usr/bin/env node
// dlp-scan.js — PII・機密・秘密鍵の流出を防ぐ（policy 駆動エンジン版）
// policy: guards['dlp'].mode (block|warn|off, 既定 block)
//   block: dlp_patterns.json の action(block) をブロック / warn: 検出しても stderr 警告のみ / off: 無効
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./lib/hooklib');

const inp = H.readInput();
const MODE = H.guardMode('dlp', 'block');
if (MODE === 'off') H.allow();

let cfg = { patterns: [], keywords: null };
try {
  cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'dlp_patterns.json'), 'utf8'));
} catch (_) { H.allow(); }

const EXTERNAL_SEND = /(gmail.*(send|draft)|create_draft|send_message|slack.*(post|send)|box.*upload|drive.*create|notebooklm.*source_add|comment|reply)/i;

let target = '';
let context = '';
if (['Write', 'Edit', 'NotebookEdit'].includes(inp.toolName)) { target = inp.content || ''; context = `${inp.toolName} の書込内容`; }
else if (inp.toolName === 'Bash') { target = inp.command || ''; context = 'Bash コマンド文字列'; }
else if (EXTERNAL_SEND.test(inp.toolName)) { target = JSON.stringify(inp.toolInput || {}); context = `外部送信ツール ${inp.toolName} の送信内容`; }
else { H.allow(); }

if (!target.trim()) H.allow();

const blockHits = [];
const warnHits = [];
for (const p of cfg.patterns || []) {
  let re;
  try { re = new RegExp(p.pattern, 'g'); } catch (_) { continue; }
  const found = target.match(re);
  if (found && found.length) {
    const entry = { name: p.name, desc: p.description, count: found.length };
    let action = p.action;
    if (action === 'warn' && Array.isArray(p.escalate_keywords)) {
      const lc = target.toLowerCase();
      if (p.escalate_keywords.some((k) => lc.includes(String(k).toLowerCase()))) { action = 'block'; entry.desc += '（文脈語あり→ブロック）'; }
    }
    if (action === 'block') blockHits.push(entry); else warnHits.push(entry);
  }
}
if (cfg.keywords && Array.isArray(cfg.keywords.blocked)) {
  const found = cfg.keywords.blocked.filter((k) => target.includes(k));
  if (found.length) {
    const entry = { name: 'confidential_label', desc: `機密ラベル: ${found.join(', ')}`, count: found.length };
    if (cfg.keywords.action === 'block') blockHits.push(entry); else warnHits.push(entry);
  }
}

function fmt(hits) { return hits.map((h) => `  - ${h.name}: ${h.count}件 (${h.desc})`).join('\n'); }

// MODE=block なら block を維持。MODE=warn なら block 相当も警告に格下げ（AD が env で緩められる）。
if (blockHits.length) {
  const msg =
    `[dlp-scan] 機微情報/秘密情報を検出しました（${context}）。\n` +
    `${fmt(blockHits)}\n\n` +
    `マイナンバー・カード番号・API キー・秘密鍵等の書込/外部送信は原則禁止です。\n` +
    `Secret Manager / 環境変数を使い、本文からは除去してください。\n` +
    (warnHits.length ? `\n参考（警告レベル・要確認）:\n${fmt(warnHits)}\n` : '');
  if (MODE === 'block') H.block(msg);
  else process.stderr.write(msg); // warn
}
if (warnHits.length) {
  process.stderr.write(
    `[dlp-scan] 警告: 個人情報候補を検出しました（${context}）。意図的か確認してください。\n` +
      `${fmt(warnHits)}\n`
  );
}

H.allow();
