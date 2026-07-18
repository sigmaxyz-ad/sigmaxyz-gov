#!/usr/bin/env node
// guard-external-write.js — 要件③: 外部システムへの書込/送信は必ず人間の承認を経る
//
// PreToolUse。external-system-write ハーネスの code 化。
// 外部送信/書込ツール（メール送信・Slack・Box/Drive アップロード・gh PR/Issue・git push・
// gcloud/gsutil/bq 等）の呼び出しを検出したら、permissionDecision="ask" を返して
// ユーザー確認を強制する（auto モードでも必ず止まる）。
//
// ブロック(exit 2)ではなく「ask」を返すのがポイント:
//   - 正当な外部送信は止めず、人間の明示承認(=authorization)を必ず挟む
//   - フェアユース③「コンプラを守った利用」を運用で担保
//
// 注意: 本フックは managed-settings 経由で常時有効・無効化不可。

'use strict';
const H = require('./lib/hooklib');

const inp = H.readInput();

// MCP「本当の送信/共有/アップロード」ツール名（人や社外へ届く操作のみ ask）。
// 注: コード/リポジトリ系(git push, gh PR)・GCP 系は ask しない（GitHub/GCP 側の統制に委ねる）。
const EXTERNAL_TOOL =
  /(gmail.*(send|draft|create_draft)|send_message|slack.*(post|send)|box.*(upload|shared_link|collaboration)|drive.*(create|upload|copy)|notebooklm.*share|box_file_upload)/i;

// Bash「本当の送信」コマンド（メール送信・外部 API への書込 POST 等）のみ ask。
const EXTERNAL_BASH = [
  /\b(curl|wget)\b.*\b-(X|-request)\s*(POST|PUT|DELETE|PATCH)\b/,
  /\b(mail|sendmail|mailx)\b/,
];

// hooklib.js の H.ask() を使用（重複定義を排除）

const reasonBase =
  '外部システムへの書込/送信です（要件③: コンプラを守ったフェアユース）。' +
  '送信先・内容を確認し、意図した操作か承認してください。';

// MCP ツール
if (inp.toolName && EXTERNAL_TOOL.test(inp.toolName)) {
  H.ask(`${reasonBase}\n  ツール: ${inp.toolName}`);
}

// Bash
if (inp.toolName === 'Bash') {
  const cmd = inp.command || '';
  for (const re of EXTERNAL_BASH) {
    if (re.test(cmd)) {
      H.ask(`${reasonBase}\n  コマンド: ${cmd.slice(0, 200)}`);
    }
  }
}

H.allow();
