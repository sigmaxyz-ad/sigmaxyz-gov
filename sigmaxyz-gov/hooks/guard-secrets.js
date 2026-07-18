#!/usr/bin/env node
// guard-secrets.js — 秘密ファイルの git 追跡/コミットを防ぐ
//
// PreToolUse(Bash)。compliance/security ハーネスの code 化。
// dlp-scan.js が「内容」の秘密を見るのに対し、本フックは「秘密ファイルを git に乗せる操作」を弾く。
// 対象: .env / *.pem / *.key / *.p12 / credentials.json / id_rsa を git add / commit する操作。

'use strict';
const H = require('./lib/hooklib');

const inp = H.readInput();
if (inp.toolName !== 'Bash') H.allow();
const cmd = (inp.command || '').trim();
if (!cmd) H.allow();

const SECRET_FILE = /(^|[\/\s"'=])(\.env(\.[\w-]+)?|[\w.\-\/]*\.(pem|key|p12|pfx)|id_rsa|id_ed25519|credentials\.json|service[_-]?account[\w-]*\.json)(["'\s]|$)/i;

// git add / git commit -a / git stash 等、ステージング/コミット系
const GIT_STAGING = /\bgit\s+(add|commit\s+-a|commit\s+--all|stash)\b/;

if (GIT_STAGING.test(cmd)) {
  // 明示的な秘密ファイル(.env/*.key 等)の add/commit → ブロック（高精度）
  if (SECRET_FILE.test(cmd)) {
    H.block(
      `[guard-secrets] 秘密ファイル(.env / *.pem / *.key / credentials.json 等)の git 追跡を検出しました。\n` +
        `  コマンド: ${cmd.slice(0, 300)}\n\n` +
        `対処: .gitignore に追加し、秘密値は Secret Manager / 環境変数で管理してください。`
    );
  }
  // `git add .` / `-A` は秘密を巻き込む「可能性」があるため、ブロックせず人間確認(ask)に留める
  const addsAll = /\bgit\s+add\s+(-A|--all|\.)(\s|$)/.test(cmd);
  if (addsAll) {
    H.ask(
      `git add -A / add . を検出しました。秘密ファイル(.env/*.key 等)を巻き込んでいないか確認してください。\n` +
        `問題なければ承認、心配なら対象を明示して add し直してください。\n  コマンド: ${cmd.slice(0, 200)}`
    );
  }
}

H.allow();
