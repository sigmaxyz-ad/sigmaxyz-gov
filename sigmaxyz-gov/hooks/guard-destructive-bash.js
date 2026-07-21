#!/usr/bin/env node
// guard-destructive-bash.js — 破壊的・危険な Bash コマンドをブロック（policy 駆動エンジン版）
// policy: guards['destructive-bash'].mode (block|warn|off, 既定 block)
'use strict';
const H = require('./lib/hooklib');

const inp = H.readInput();
if (inp.toolName !== 'Bash') H.allow();
const MODE = H.guardMode('destructive-bash', 'block');
if (MODE === 'off') H.allow();
const cmd = (inp.command || '').trim();
if (!cmd) H.allow();

const DANGER = [
  [/\brm\s+(-[a-zA-Z]*\s+)*(\/|~|~\/|\$HOME)\s*$/, 'ルート/ホーム全体の削除'],
  [/\brm\s+-[a-zA-Z]*\s+(\/|~|\/\*|~\/\*|\$HOME\/?\*?)(\s|$)/, 'ルート/ホーム配下の一括削除'],
  [/\brm\s+-[a-zA-Z]*r[a-zA-Z]*\s+[^;|&]*\/(etc|usr|bin|sbin|boot|lib|var|opt|sys|proc|dev)\b/, 'システムディレクトリの再帰削除'],
  [/:\(\)\s*\{\s*:\|:&\s*\};:/, 'fork bomb'],
  [/\bchmod\s+(-R\s+)?0?777\b/, 'chmod 777（過剰権限）'],
  [/\b(mkfs|fdisk|parted)\b/, 'ディスク初期化/パーティション操作'],
  [/\bdd\b[^|]*\bof=\/dev\/(sd|nvme|hd|disk|mmcblk)/, 'ブロックデバイスへの dd'],
  [/>\s*\/dev\/(sd|nvme|hd|disk)/, 'ブロックデバイスへのリダイレクト'],
  [/\bcurl\b[^|]*\|\s*(sudo\s+)?(ba)?sh\b/, 'curl | sh（遠隔コード実行）'],
  [/\bwget\b[^|]*\|\s*(sudo\s+)?(ba)?sh\b/, 'wget | sh（遠隔コード実行）'],
  [/\b(shutdown|reboot|halt|poweroff|init\s+0)\b/, 'システム停止/再起動'],
  [/\b(iptables|ufw|firewall-cmd)\b.*\b(flush|-F|disable|stop)\b/, 'ファイアウォール無効化'],
  [/\bhistory\s+-c\b|>\s*~?\/?\.bash_history/, '操作履歴の消去（証跡隠蔽）'],
];

for (const [re, label] of DANGER) {
  if (re.test(cmd)) {
    H.enforce(MODE,
      `[guard-destructive-bash] 破壊的/危険なコマンドを検出しました。\n` +
        `  種別: ${label}\n` +
        `  コマンド: ${cmd.slice(0, 300)}\n\n` +
        `管理ポリシーにより、システム破壊・遠隔コード実行・証跡隠蔽は禁止です。\n` +
        `（workspace 内の通常の削除・整理は許可されています。対象を ~/workspace/ 配下に限定してください。）`
    );
  }
}

H.allow();
