#!/usr/bin/env node
// dlp-scan.js — 要件②(AI層): PII・機密・秘密鍵の流出を防ぐ
//
// PreToolUse。対象:
//   - Write/Edit/NotebookEdit の content（ファイルに書き込む内容）
//   - Bash の command 文字列（echo/cat ヒアドキュメント等に混入する秘密）
//   - 外部送信系 MCP ツール（Gmail送信 / Slack / Box upload 等）の引数全体
//
// dlp_patterns.json の action に従う:
//   - block : ブロック（exit 2）— マイナンバー/カード/各種APIキー/秘密鍵
//   - warn  : 注意喚起しつつ通す（電話/メール/機密ラベル）。stderr に出すが exit 0
//
// OS/ネットワーク層の DLP(Umbrella/SentinelOne) を代替するものではなく、
// AI が生成・送信する内容に対する最後の砦（二層防御の AI 層）。

'use strict';
const fs = require('fs');
const path = require('path');
const H = require('./lib/hooklib');

const inp = H.readInput();

// パターン読込
let cfg = { patterns: [], keywords: null };
try {
  cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'dlp_patterns.json'), 'utf8'));
} catch (_) {
  H.allow(); // パターンが読めない場合は通す（フォールバック）
}

// 外部送信系ツール名（MCP）。含まれていれば全引数を走査対象に。
const EXTERNAL_SEND = /(gmail.*(send|draft)|create_draft|send_message|slack.*(post|send)|box.*upload|drive.*create|notebooklm.*source_add|comment|reply)/i;

// 走査対象テキストを決定
let target = '';
let context = '';
if (['Write', 'Edit', 'NotebookEdit'].includes(inp.toolName)) {
  target = inp.content || '';
  context = `${inp.toolName} の書込内容`;
} else if (inp.toolName === 'Bash') {
  target = inp.command || '';
  context = 'Bash コマンド文字列';
} else if (EXTERNAL_SEND.test(inp.toolName)) {
  target = JSON.stringify(inp.toolInput || {});
  context = `外部送信ツール ${inp.toolName} の送信内容`;
} else {
  H.allow();
}

if (!target.trim()) H.allow();

const blockHits = [];
const warnHits = [];

for (const p of cfg.patterns || []) {
  let re;
  try {
    re = new RegExp(p.pattern, 'g');
  } catch (_) {
    continue;
  }
  const found = target.match(re);
  if (found && found.length) {
    const entry = { name: p.name, desc: p.description, count: found.length };
    let action = p.action;
    // 文脈語（マイナンバー/カード等）が近接していれば warn → block へ昇格（誤検知を抑えつつ本物は止める）
    if (action === 'warn' && Array.isArray(p.escalate_keywords)) {
      const lc = target.toLowerCase();
      if (p.escalate_keywords.some((k) => lc.includes(String(k).toLowerCase()))) {
        action = 'block';
        entry.desc += '（文脈語あり→ブロック）';
      }
    }
    if (action === 'block') blockHits.push(entry);
    else warnHits.push(entry);
  }
}

// 機密ラベルキーワード
if (cfg.keywords && Array.isArray(cfg.keywords.blocked)) {
  const found = cfg.keywords.blocked.filter((k) => target.includes(k));
  if (found.length) {
    const entry = { name: 'confidential_label', desc: `機密ラベル: ${found.join(', ')}`, count: found.length };
    if (cfg.keywords.action === 'block') blockHits.push(entry);
    else warnHits.push(entry);
  }
}

function fmt(hits) {
  return hits.map((h) => `  - ${h.name}: ${h.count}件 (${h.desc})`).join('\n');
}

if (blockHits.length) {
  H.block(
    `[dlp-scan] 機微情報/秘密情報を検出したためブロックしました（${context}）。\n` +
      `${fmt(blockHits)}\n\n` +
      `管理ポリシー(要件②)により、マイナンバー・カード番号・API キー・秘密鍵等の\n` +
      `書込/外部送信は禁止です。Secret Manager / 環境変数を使い、本文からは除去してください。\n` +
      (warnHits.length ? `\n参考（警告レベル・要確認）:\n${fmt(warnHits)}\n` : '') +
      `（このルールは managed-settings により固定されています。）`
  );
}

if (warnHits.length) {
  // 警告は通すが、モデルにユーザー確認を促す（exit 0 + stderr）
  process.stderr.write(
    `[dlp-scan] 警告: 個人情報候補を検出しました（${context}）。意図的か確認してください。\n` +
      `${fmt(warnHits)}\n` +
      `ダミー/テストデータでなければ、伏字や除去をユーザーに確認してから進めてください。\n`
  );
}

H.allow();
