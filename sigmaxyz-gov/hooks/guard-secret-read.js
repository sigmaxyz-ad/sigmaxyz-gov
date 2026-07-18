#!/usr/bin/env node
// guard-secret-read.js — 秘密ファイルの Bash 経由“読み取り”をブロック
//
// PreToolUse(Bash)。compliance/security ハーネスの code 化。
// 既存の穴を塞ぐ:
//   - managed-settings の deny は Read(~/.ssh/**) 等「Read ツール」限定。
//     一方 allow に Bash(cat *) / Bash(grep *) があり、`cat ~/.ssh/id_rsa` 等が自動承認される。
//   - dlp-scan.js は「コマンド文字列」の秘密は見るが、cat 等の“出力”（ファイル内容）は見ない。
//   - guard-secrets.js は秘密ファイルの git 追跡のみを見る（読み取りは対象外）。
// → 本フックは「秘密ファイルを読取系コマンドで開く＝値がモデル文脈へ流入する」操作を弾く。
//
// 秘密が必要な場合は値を読ませず、Secret Manager / 環境変数参照に誘導する。

'use strict';
const H = require('./lib/hooklib');

const inp = H.readInput();
if (inp.toolName !== 'Bash') H.allow();

const cmd = (inp.command || '').trim();
if (!cmd) H.allow();

// 内容を標準出力/別ファイルへ吸い出す“読取・複製”系コマンド。
const READERS =
  /\b(cat|bat|tac|less|more|head|tail|nl|strings|xxd|hexdump|od|cut|awk|sed|base64|tee|cp|scp|rsync|grep|egrep|fgrep|rg|dd)\b/;

// 秘密ファイル/ディレクトリ（guard-secrets.js の SECRET_FILE と整合 + Read-deny 対象パスを追加）。
const SECRET_TARGET =
  /(^|[\/\s"'=])(\.env(\.[\w-]+)?|[\w.\-\/]*\.(pem|key|p12|pfx)|id_rsa|id_ed25519|credentials\.json|service[_-]?account[\w-]*\.json)(["'\s]|$)/i;

// Read-deny 済みの秘密パス（~/.ssh, ~/.aws/credentials, ~/.config/gcloud, /etc/shadow）。
const SECRET_PATH =
  /((^|[\s"'=])~?\/?\.ssh\/|(^|[\s"'=])~?\/?\.aws\/credentials\b|(^|[\s"'=])~?\/?\.config\/gcloud\/|\/etc\/shadow\b)/i;

// 誤検知除外: .env.example / .sample / .template / .dist は雛形であり秘密ではない。
const SAFE_ENV_TEMPLATE = /\.env(\.[\w-]+)?\.(example|sample|template|dist)\b|\.env\.(example|sample|template|dist)\b/i;

const looksSecret = (SECRET_TARGET.test(cmd) && !SAFE_ENV_TEMPLATE.test(cmd)) || SECRET_PATH.test(cmd);

if (READERS.test(cmd) && looksSecret) {
  H.block(
    `[guard-secret-read] 秘密ファイル(.ssh / .env / *.pem / *.key / credentials 等)を Bash で読み取ろうとしています。\n` +
      `  コマンド: ${cmd.slice(0, 300)}\n\n` +
      `管理ポリシー(要件②)により、秘密情報の“値”を取得しモデル文脈へ流入させる操作は禁止です。\n` +
      `値が必要な場合はファイルを開かず、Secret Manager / 環境変数を参照してください。\n` +
      `（managed-settings の Read 拒否は Read ツール限定のため、本フックが Bash 経由の抜け道を塞ぎます。）`
  );
}

H.allow();
