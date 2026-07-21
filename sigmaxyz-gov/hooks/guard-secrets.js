#!/usr/bin/env node
// guard-secrets.js — 秘密ファイルの git 追跡/コミットを防ぐ（policy 駆動エンジン版）
// policy: guards['secrets'].mode (block|warn|off, 既定 block)
'use strict';
const H = require('./lib/hooklib');

const inp = H.readInput();
if (inp.toolName !== 'Bash') H.allow();
const MODE = H.guardMode('secrets', 'block');
if (MODE === 'off') H.allow();
const cmd = (inp.command || '').trim();
if (!cmd) H.allow();

const SECRET_FILE = /(^|[\/\s"'=])(\.env(\.[\w-]+)?|[\w.\-\/]*\.(pem|key|p12|pfx)|id_rsa|id_ed25519|credentials\.json|service[_-]?account[\w-]*\.json)(["'\s]|$)/i;
const GIT_STAGING = /\bgit\s+(add|commit\s+-a|commit\s+--all|stash)\b/;

if (GIT_STAGING.test(cmd)) {
  if (SECRET_FILE.test(cmd)) {
    H.enforce(MODE,
      `[guard-secrets] 秘密ファイル(.env / *.pem / *.key / credentials.json 等)の git 追跡を検出しました。\n` +
        `  コマンド: ${cmd.slice(0, 300)}\n\n` +
        `対処: .gitignore に追加し、秘密値は Secret Manager / 環境変数で管理してください。`
    );
  }
  const addsAll = /\bgit\s+add\s+(-A|--all|\.)(\s|$)/.test(cmd);
  if (addsAll) {
    H.ask(
      `git add -A / add . を検出しました。秘密ファイル(.env/*.key 等)を巻き込んでいないか確認してください。\n` +
        `問題なければ承認、心配なら対象を明示して add し直してください。\n  コマンド: ${cmd.slice(0, 200)}`
    );
  }
}

H.allow();
