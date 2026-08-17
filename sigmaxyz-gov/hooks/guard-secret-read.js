#!/usr/bin/env node
// guard-secret-read.js — 秘密ファイルの Bash 経由“読み取り”をブロック（policy 駆動エンジン版）
// policy: guards['secret-read'].mode (block|warn|off, 既定 block)
'use strict';
const H = require('./lib/hooklib');

const inp = H.readInput();
// シェル系ツール（Claude/Codex=Bash・Gemini=run_shell_command）を別名表で判定（#119）
if (!H.isShellTool(inp.toolName)) H.allow();
const MODE = H.guardMode('secret-read', 'block');
if (MODE === 'off') H.allow();
const cmd = (inp.command || '').trim();
if (!cmd) H.allow();

const READERS =
  /\b(cat|bat|tac|less|more|head|tail|nl|strings|xxd|hexdump|od|cut|awk|sed|base64|tee|cp|scp|rsync|grep|egrep|fgrep|rg|dd)\b/;
const SECRET_TARGET =
  /(^|[\/\s"'=])(\.env(\.[\w-]+)?|[\w.\-\/]*\.(pem|key|p12|pfx)|id_rsa|id_ed25519|credentials\.json|service[_-]?account[\w-]*\.json)(["'\s]|$)/i;
const SECRET_PATH =
  /((^|[\s"'=])~?\/?\.ssh\/|(^|[\s"'=])~?\/?\.aws\/credentials\b|(^|[\s"'=])~?\/?\.config\/gcloud\/|\/etc\/shadow\b)/i;
const SAFE_ENV_TEMPLATE = /\.env(\.[\w-]+)?\.(example|sample|template|dist)\b|\.env\.(example|sample|template|dist)\b/i;

const looksSecret = (SECRET_TARGET.test(cmd) && !SAFE_ENV_TEMPLATE.test(cmd)) || SECRET_PATH.test(cmd);

if (READERS.test(cmd) && looksSecret) {
  H.enforce(MODE,
    `[guard-secret-read] 秘密ファイル(.ssh / .env / *.pem / *.key / credentials 等)を Bash で読み取ろうとしています。\n` +
      `  コマンド: ${cmd.slice(0, 300)}\n\n` +
      `管理ポリシー(要件②)により、秘密情報の“値”を取得しモデル文脈へ流入させる操作は禁止です。\n` +
      `値が必要な場合はファイルを開かず、Secret Manager / 環境変数を参照してください。`
  );
}

H.allow();
