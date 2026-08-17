#!/usr/bin/env node
// guard-external-write.js — 外部システムへの書込/送信は人間承認を経る（policy 駆動エンジン版）
// policy: guards['external-write'].mode (block|warn|off, 既定 warn=ask)
'use strict';
const H = require('./lib/hooklib');

const inp = H.readInput();
const MODE = H.guardMode('external-write', 'warn');
if (MODE === 'off') H.allow();

const EXTERNAL_TOOL =
  /(gmail.*(send|draft|create_draft)|send_message|slack.*(post|send)|box.*(upload|shared_link|collaboration)|drive.*(create|upload|copy)|notebooklm.*share|box_file_upload)/i;
const EXTERNAL_BASH = [
  /\b(curl|wget)\b.*\b-(X|-request)\s*(POST|PUT|DELETE|PATCH)\b/,
  /\b(mail|sendmail|mailx)\b/,
];

const reasonBase =
  '外部システムへの書込/送信です（コンプラを守ったフェアユース）。' +
  '送信先・内容を確認し、意図した操作か承認してください。';

if (inp.toolName && EXTERNAL_TOOL.test(inp.toolName)) {
  H.enforce(MODE, `${reasonBase}\n  ツール: ${inp.toolName}`);
}
if (H.isShellTool(inp.toolName)) {
  const cmd = inp.command || '';
  for (const re of EXTERNAL_BASH) {
    if (re.test(cmd)) H.enforce(MODE, `${reasonBase}\n  コマンド: ${cmd.slice(0, 200)}`);
  }
}

H.allow();
