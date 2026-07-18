#!/usr/bin/env node
// session-banner.js — SessionStart: コンプラ宣言とフェアユース注意を提示（透明性・要件③）
//
// ユーザー(と AI)に、この環境が TM（テクノロジーマネジメントグループ）管理下であること、自由領域がどこか、
// 何が固定で何を自分で追加できるかを毎セッション冒頭で明示する。
// 非ブロック（systemMessage を出して continue）。
'use strict';
const os = require('os');
const path = require('path');
const home = os.homedir();
const ws = path.join(home, 'workspace');
const banner =
  `[SIGMAXYZ 管理AI環境] テクノロジーマネジメントグループ(TM) 管理ポリシー適用中\n` +
  `─────────────────────────────────────────────\n` +
  `自由に使える領域      : ${ws}/\n` +
  `自分で追加できるもの  : スキル(~/workspace/.claude/commands)・MCP・自前フック/ハーネス\n` +
  `固定（変更/無効化不可）: セキュリティ/コンプラのフック・deny ルール（managed-settings）\n` +
  `フェアユース          : 席ライセンスの共有・個人アカウント混在は規約違反。会社アカウントで利用。\n` +
  `機微情報              : APIキー/秘密鍵/「社外秘」等は書込・外部送信を自動ブロック。マイナンバー・カード番号は検知して警告（文脈により自動ブロック）。\n` +
  `─────────────────────────────────────────────`;
process.stdout.write(JSON.stringify({ systemMessage: banner, continue: true, suppressOutput: false }));
process.exit(0);