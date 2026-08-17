// hooklib.js — SIGMAXYZ AI ハーネス共通ライブラリ（policy 駆動エンジン版）
//
// 設計: 「執行(enforcement)＝このコード/hook が必ず動く（TM が OS レベルで担保）」と
//       「方針(policy)＝何を block/warn/off にするか（AD が managed settings の env で即時調整）」を分離。
// policy の与え方（AD が Web Console の `env` で設定）:
//   - GOV_POLICY_JSON            : 完全な policy(JSON文字列)。優先。
//   - GOV_<GUARD>_MODE           : 個別ガードの mode = block | warn | off。例 GOV_PERSONAL_PATH_MODE
//   guards[name].scan 等の追加パラメータも GOV_POLICY_JSON で与えられる。
// policy 未設定でも各ガードは安全な既定値で動く（是正版の挙動）。

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// ---- ツール名の抽象化（hook-wiring.json の tool_aliases と対応）-----------
// 同じ操作(action)を Claude / Codex / Gemini はそれぞれ別のツール名で送ってくる。
// 各ガードにツール名を直書きすると、配線は当たっているのに中身を検査しない「静かな空振り」になる
// （#119: Codex の apply_patch が WRITE 系ガード全部を素通りしていた）。判定は必ずこの表を通す。
// 対応表の正本: dist-builder/dist/out/runtime/hook-wiring.json の tool_aliases
const WRITE_TOOLS = ['Write', 'Edit', 'NotebookEdit', 'apply_patch', 'write_file', 'replace'];
const SHELL_TOOLS = ['Bash', 'run_shell_command'];
function isWriteTool(name) { return WRITE_TOOLS.includes(String(name || '')); }
function isShellTool(name) { return SHELL_TOOLS.includes(String(name || '')); }

// ---- 値の文字列化（command は配列で来ることがある）-----------------------
function toText(v) {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  return v == null ? '' : String(v);
}

// ---- Codex apply_patch（V4A パッチ）の解析 --------------------------------
// Codex は apply_patch の tool_input.command に「パッチ本文そのもの」を入れて渡す。
// file_path も content も無いため、Claude スキーマ前提のガードは全て素通りする。
//   実測(codex 0.146.0-alpha.3.1 / 2026-07-30):
//   {"tool_name":"apply_patch","tool_input":{"command":"*** Begin Patch\n*** Update File: a.txt\n@@\n-hello\n+world\n*** End Patch\n"}}
// ここで対象ファイル（相対パスあり）と「追加された行」を取り出し、Claude 系と同じ filePath/content に正規化する。
// 削除行(-)を content に入れないのは、秘密情報を「消す」編集まで DLP がブロックしてしまうのを避けるため。
const PATCH_BEGIN = '*** Begin Patch';
const PATCH_END = '*** End Patch';
function parsePatch(text) {
  const files = [];
  const added = [];
  let inAdd = false;
  for (const line of String(text || '').split(/\r?\n/)) {
    let m;
    if ((m = /^\*\*\*\s+(Add|Update|Delete) File:\s*(.+?)\s*$/.exec(line))) { files.push(m[2]); inAdd = (m[1] === 'Add'); continue; }
    if ((m = /^\*\*\*\s+Move to:\s*(.+?)\s*$/.exec(line))) { files.push(m[1]); continue; }
    // Begin/End Patch, End of File, Environment ID。複数パッチ連結時に状態を持ち越さないよう inAdd を戻す。
    if (/^\*\*\*\s/.test(line)) { if (/^\*\*\*\s+(Begin|End) Patch\b/.test(line)) inAdd = false; continue; }
    if (line.startsWith('+')) { added.push(line.slice(1)); continue; }
    // Add File 配下は全行が追加内容（"+" 欠落パッチへの保険。検査対象を増やす方向にのみ効く）
    if (inAdd && !line.startsWith('-') && !line.startsWith('@@')) added.push(line);
  }
  return { files, added: added.join('\n') };
}

// ---- stdin（フック入力 JSON）を読む -------------------------------------
function readInput() {
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch (_) { raw = ''; }
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1); // BOM 耐性
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch (_) { data = {}; }
  const toolInput = data.tool_input || data.toolInput || {};
  const toolName = data.tool_name || data.toolName || '';
  let command = toText(toolInput.command);
  let filePath = toText(toolInput.file_path || toolInput.filePath);
  let content = toText(toolInput.content || toolInput.new_string || toolInput.new_source || toolInput.text);
  let filePaths = filePath ? [filePath] : [];

  // apply_patch の本文を取り出す。2経路ある。
  //  (a) ツール呼び出し: tool_name が apply_patch。command 全体がパッチ本文。
  //  (b) シェル経由: codex のシェルには apply_patch CLI が同居しており、モデルが
  //      `apply_patch <<'EOF' ... EOF` や argv 連結で叩ける。先頭一致では拾えないため部分一致で切り出す。
  let patch = '';
  if (toolName === 'apply_patch') {
    patch = command || toText(toolInput.input) || toText(toolInput.patch);
    // シェル実行ではない。パッチ本文中の "rm -rf" 等で Bash 系ガードが誤爆しないよう外す。
    command = '';
  } else {
    // 1つのコマンドに複数のパッチが含まれることがあるため、全て切り出す。
    // 1つ目だけを処理すると、2つ目の書込先が検査されず、かつ本文が command に残って
    // シェル系ガードが誤爆する（どちらも実測で確認）。
    const bodies = [];
    let rest = '';
    let i = 0;
    for (;;) {
      const s = command.indexOf(PATCH_BEGIN, i);
      if (s === -1) { rest += command.slice(i); break; }
      const e = command.indexOf(PATCH_END, s);
      const end = e === -1 ? command.length : e + PATCH_END.length;
      bodies.push(command.slice(s, end));
      rest += command.slice(i, s) + ' ';
      i = end;
    }
    if (bodies.length) {
      patch = bodies.join('\n');
      // 本文だけを除去し、command は空にしない。
      // heredoc の後ろに `&& rm -rf ~` を続ける形を Bash 系ガードが見落とさないため。
      command = rest.trim();
    }
  }
  if (patch) {
    const p = parsePatch(patch);
    if (p.files.length) { filePaths = p.files; filePath = p.files[0]; }
    if (p.added) content = p.added;
  }

  return { raw, toolName, toolInput, command, filePath, filePaths, content, patch, cwd: data.cwd || process.cwd() };
}

// ---- policy（2層で解決する） ----------------------------------------------
// ① 配布セットが管理者領域に置く baseline: 会社として踏み越えてはならない一線。
//    ここで locked に挙げたガードは、後の層から弱められない（強めるのは可）。
//    組織設定が未投入でも・どの組織に属していても効くことが①の存在理由。
// ② 組織設定の env: より快適かつ安全に使うための調整。即時反映・即時取り消し。
//
// 重要な不変条件: baseline が存在しない環境では、②のみで解決され従来と同一の挙動になる。
//                 ①が行き渡るまでの間に挙動が変わってはならない。
//
// ただし例外が1つある（COMPILED_FLOOR / 2026-08-15 追加）。
// 上の不変条件をそのまま適用すると、**baseline が無い端末では locked のはずのガードを
// ②から off にできる**（実測: baseline 有 + GOV_DESTRUCTIVE_BASH_MODE=off → block(exit 2) /
// baseline 無 + 同じ指定 → 素通り(exit 0)）。①の実体を読取専用にしても、①が届いていない
// 端末では守りが1つも無い状態を②から作れてしまう。
//
// 素朴な fail-closed（「本体があるのに baseline が無ければ落とす」）は使えない。
// フック本体が配られていること自体が、①が行き渡るまでの移行期の正常状態だからである。
// そこで**穴の実体だけ**を塞ぐ: 会社として踏み越えてはならない4つに限り、
// ②は既定より弱くできない（強めるのは従来どおり可）。
// 既定はもともと block なので、**通常の挙動は何も変わらない**。挙動が変わるのは
// 「baseline が無い端末で、明示的に off/warn へ弱めていた場合」だけで、それはまさに塞ぎたい穴。
//
// この一覧は baseline.json の locked と一致していなければならない。
// ずれると「①がある時は守られるのに、無い時は守られない（またはその逆）」という
// 端末ごとに違う下限が生まれる。一致は Test-BaselineGuards.ps1 が検査する。
const COMPILED_FLOOR = ['secrets', 'secret-read', 'destructive-bash', 'dlp'];
const MODE_RANK = { off: 0, warn: 1, ask: 1, block: 2 };
function modeRank(m) { const r = MODE_RANK[String(m || '').toLowerCase()]; return r === undefined ? -1 : r; }

function baselinePolicy() {
  // 探索順が重要。保護領域の固定パスを必ず先に見る。
  // env(GOV_BASELINE_POLICY)を先頭にすると、利用者が locked:[] の偽 baseline を自分のホームに置いて
  // そこを指すだけで第①層を丸ごと無効化できてしまう（実体を読取専用にしても、実体を指す
  // セレクタが利用者側で書き換えられるなら意味がない）。
  // env による差し替えは「固定パスに baseline が無い環境」でのみ許す。①が配布済みの端末では
  // 常に固定パスが勝つため、この経路からロックを外すことはできない。
  // 固定パスは環境変数に依存させない。ProgramFiles は利用者が自分のシェルで潰せるため、
  // それだけを頼りにすると「固定パスが存在しない」状態を作られ、env による差し替えに戻ってしまう
  // （＝この関数が排除したはずの、保証されていない優先順への依存が復活する）。
  // 環境変数由来は 32/64bit のずれを吸収する補助として使い、リテラルの既定パスを必ず候補に入れる。
  // 並び順が防御そのもの。このループは「最初に存在する候補」を採用するため、
  // 環境変数由来を先に置くと、利用者が ProgramFiles を自分の書ける場所へ差し替えて
  // そこに偽 baseline を置くだけで、リテラルの実体に到達する前に偽物が勝つ。
  // 「潰す」ではなく「差し替える」攻撃には後方のリテラルは効かない。
  // よって環境変数に依存しないリテラルを必ず先に、環境変数由来はその後に置く。
  const fixed = [];
  fixed.push('C:/Program Files/sigmaxyz-dist/policy/baseline.json');
  fixed.push('/opt/sigmaxyz-dist/policy/baseline.json');
  fixed.push('/etc/sigmaxyz-dist/policy/baseline.json');
  // 既定以外のドライブへ導入された場合の補助。ここに到達するのはリテラルが全て不在のときだけ。
  if (process.env.ProgramFiles) fixed.push(path.join(process.env.ProgramFiles, 'sigmaxyz-dist', 'policy', 'baseline.json'));
  if (process.env.ProgramW6432) fixed.push(path.join(process.env.ProgramW6432, 'sigmaxyz-dist', 'policy', 'baseline.json'));
  const candidates = fixed.slice();
  if (process.env.GOV_BASELINE_POLICY) candidates.push(process.env.GOV_BASELINE_POLICY);
  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p)) {
        const o = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (o && typeof o === 'object') { if (!o.guards) o.guards = {}; return o; }
      }
    } catch (_) { /* 壊れていても止めない。②のみで解決する */ }
  }
  return null;
}

// 内部専用キー。②の入力から混入すると解決経路そのものを付け替えられるため必ず除去する。
// 例: baseline 不在の端末で GOV_POLICY_JSON に `_base` を1つ入れるだけで、resolver が
//     「①あり」の分岐に切り替わり、従来と同一という不変条件が崩れる。
const RESERVED_POLICY_KEYS = ['_base', '_env', 'locked'];
function envPolicy() {
  let o = { guards: {} };
  try { if (process.env.GOV_POLICY_JSON) { const p = JSON.parse(process.env.GOV_POLICY_JSON); if (p && typeof p === 'object') o = p; } } catch (_) {}
  for (const k of RESERVED_POLICY_KEYS) { if (k in o) delete o[k]; }
  if (!o.guards || typeof o.guards !== 'object') o.guards = {};
  return o;
}

let _pol = null;
function policy() {
  if (_pol) return _pol;
  const base = baselinePolicy();
  const env = envPolicy();
  if (!base) { _pol = env; return _pol; }

  const lockedList = Array.isArray(base.locked) ? base.locked.map(String) : [];
  const isLocked = (n) => lockedList.includes(n) || (base.guards[n] && base.guards[n].locked === true);

  const names = new Set(Object.keys(base.guards).concat(Object.keys(env.guards)));
  const guards = {};
  for (const n of names) {
    const b = base.guards[n] || {};
    const e = env.guards[n] || {};
    if (!isLocked(n)) { guards[n] = Object.assign({}, b, e); continue; }
    // ロック項目: ②から受け付けるのは「mode を強める」ことだけ。
    // baseline の設定をそのまま使い、mode のみ上書き判定する。
    // e を丸ごとマージすると scan 等のパラメータまで②から差し替えられ、
    // 例えば scan:[] を入れるだけで検査対象が空になり、ロックが実質無効になる。
    const merged = Object.assign({}, b);
    merged.mode = (modeRank(e.mode) >= modeRank(b.mode)) ? (e.mode || b.mode) : b.mode;
    merged.locked = true;
    guards[n] = merged;
  }
  // どちらの層に由来する値かを後段で判別できるよう、素の2層も保持する
  _pol = Object.assign({}, base, env, { guards: guards, locked: lockedList, _base: base, _env: env });
  return _pol;
}
function isGuardLocked(name) {
  const g = policy().guards[name] || {};
  const l = policy().locked;
  return g.locked === true || (Array.isArray(l) && l.includes(name));
}
// 優先順（非ロック）: ②の GOV_POLICY_JSON > ②の GOV_<GUARD>_MODE > ①の baseline > 各ガードの既定
// 優先順（ロック）  : 上記のうち「baseline より強い」ものだけを採用する
function guardMode(name, def) {
  const p = policy();
  const envKey = 'GOV_' + name.toUpperCase().replace(/-/g, '_') + '_MODE';
  const jsonMode = (p._env && p._env.guards && p._env.guards[name] || {}).mode;
  const envMode = process.env[envKey];
  const baseMode = (p._base && p._base.guards && p._base.guards[name] || {}).mode;
  // baseline が無い環境（①未配布）では従来どおり: policy の値 → env → 既定。
  // ただし COMPILED_FLOOR の4つだけは、既定より弱い指定を受け付けない（上の注記を参照）。
  if (!p._base) {
    const g = p.guards[name] || {};
    const want = String(g.mode || envMode || def).toLowerCase();
    if (!COMPILED_FLOOR.includes(name)) { return want; }
    return String((modeRank(want) >= modeRank(def)) ? want : def).toLowerCase();
  }
  const want = jsonMode || envMode;
  if (isGuardLocked(name)) {
    const floor = baseMode || def;
    return String((modeRank(want) >= modeRank(floor)) ? (want || floor) : floor).toLowerCase();
  }
  return String(want || baseMode || def).toLowerCase();
}
function guardParam(name, key, def) {
  const g = policy().guards[name] || {};
  return g[key] !== undefined ? g[key] : def;
}

// ---- 除外パス（policy: guards[name].exclude / env: GOV_<GUARD>_EXCLUDE）----
// 個人パスや個人名を「正当に」含む領域（AI の記録・履歴・作業メモ等）を検査対象から外す。
// 全体 off にすると配布物への焼き込みまで素通りするため、領域単位で外せる必要がある。
//
// 設計上の制約（意図的）:
//   - 既定は空。設定しない限り挙動は一切変わらない
//   - ファイルパスが一意に定まる書込(Write/Edit/apply_patch 等)にのみ効く。
//     シェルコマンドには適用しない（対象が一意に定まらず、除外がガード全体の抜け道になるため）
//   - 秘密情報の検知(dlp-scan)には適用しない。秘密の流出は領域を問わず止める
// 書式: `~` 展開あり。`*` は階層内、`**` は階層をまたぐワイルドカード。区切りは / \ どちらでも可
function excludePatterns(name) {
  const p = policy();
  const envKey = 'GOV_' + name.toUpperCase().replace(/-/g, '_') + '_EXCLUDE';
  const raw = process.env[envKey];
  const envVarList = raw ? String(raw).split(',') : undefined;
  const jsonList = (p._env && p._env.guards && p._env.guards[name] || {}).exclude;
  const baseList = (p._base && p._base.guards && p._base.guards[name] || {}).exclude;
  let list;
  if (!p._base) {
    // baseline が無い環境（①未配布）では従来どおり
    const g = p.guards[name] || {};
    list = g.exclude !== undefined ? g.exclude : (envVarList || []);
  } else if (isGuardLocked(name)) {
    // ロック項目は「検査を外す指定」を後の層から受け付けない。baseline のものだけを使う
    list = baseList !== undefined ? baseList : [];
  } else {
    list = jsonList !== undefined ? jsonList : (envVarList !== undefined ? envVarList : (baseList !== undefined ? baseList : []));
  }
  if (!Array.isArray(list)) list = [list];
  return list.map((s) => String(s).trim()).filter(Boolean);
}
// センチネルはパスに出現し得ない制御文字(NUL)。空白等を使うと `Program Files` のような
// リテラル空白まで `.*` に化け、意図より広く除外してしまう。
const EXCLUDE_SENTINEL = '\u0000';
function excludeToRegExp(pat) {
  const norm = expandHome(String(pat)).replace(/\\/g, '/');
  // `?` もエスケープする。「ワイルドカードは * と ** だけ」という文書上の契約を崩さないため
  const esc = norm.replace(/[.+^${}()|[\]\\?]/g, '\\$&');
  const body = esc
    .split('**').join(EXCLUDE_SENTINEL)
    .replace(/\*/g, '[^/]*')
    .split(EXCLUDE_SENTINEL).join('.*');
  // 境界を明示する。無アンカーだと `~/.claude/memory` が `~/.claude/memory-secret/...` にも
  // 部分一致し、意図より広く除外される（＝より多くのパスがガードを素通りする方向の劣化）。
  const absolute = /^([A-Za-z]:)?\//.test(norm) || /^[A-Za-z]:/.test(norm);
  const head = (absolute || norm.startsWith('*')) ? '' : '(?:.*/)?';
  const tail = norm.endsWith('*') ? '' : '(?:/|$)';
  return new RegExp('^' + head + body + tail, 'i');
}
// 対象パスが「すべて」除外に該当するときだけ true。
// 単数の代表値ではなく全件を見る理由: apply_patch は1回で複数ファイルを触る。
// 先頭が除外領域というだけで検査を飛ばすと、同じパッチ内の配布物への焼き込みが素通りする。
function isExcludedPath(name, filePaths) {
  const list = Array.isArray(filePaths) ? filePaths.filter(Boolean) : (filePaths ? [filePaths] : []);
  if (!list.length) return false;
  const pats = excludePatterns(name);
  if (!pats.length) return false;
  return list.every((fp) => {
    const p = String(fp).replace(/\\/g, '/');
    return pats.some((pat) => { try { return excludeToRegExp(pat).test(p); } catch (_) { return false; } });
  });
}
// mode に従って block / ask(warn) / allow(off) を出し分け
function enforce(mode, message) {
  mode = String(mode || '').toLowerCase();
  if (mode === 'off') allow();
  if (mode === 'block') block(message);
  ask(message); // warn / ask
}

// ---- パス解決ヘルパ ------------------------------------------------------
const HOME = os.homedir();
function expandHome(p) {
  if (!p) return p;
  if (p === '~') return HOME;
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(HOME, p.slice(2));
  return p;
}
function toAbsolute(p, cwd) {
  if (!p) return '';
  const e = expandHome(p);
  return path.resolve(cwd || HOME, e);
}
function normalize(p) {
  let n = path.resolve(p);
  if (process.platform === 'win32') n = n.replace(/\\/g, '/').toLowerCase();
  return n;
}

// ---- ユーザー自由領域（workspace）判定 ----------------------------------
function allowedWriteRoots() {
  const roots = [
    path.join(HOME, 'workspace'),
    os.tmpdir(),
    path.join(HOME, '.config', 'Code'),
    path.join(HOME, 'AppData', 'Roaming', 'Code'),
    path.join(HOME, 'AppData', 'Roaming', 'Claude'),
    path.join(HOME, '.gitconfig'),
  ];
  if (process.platform === 'win32' && process.env.TEMP) roots.push(process.env.TEMP);
  return roots.map(normalize);
}
function isInsideWorkspace(absPath) {
  const target = normalize(absPath);
  return allowedWriteRoots().some((root) => target === root || target.startsWith(root + '/'));
}

// ---- 「疑いようのないシステム領域」判定（原則ではなくハード保護対象） ------
// POSIX: /etc /usr /bin /sbin /boot /lib /opt /sys /proc
// Windows: C:\Windows, C:\Program Files(, (x86)), C:\ProgramData
// normalize に依存せず生文字列を正規化して判定する（実行 OS に依らず両表記を拾う）。
function isSystemPath(p) {
  if (!p) return false;
  const s = String(p).replace(/\\/g, '/').replace(/^["']|["']$/g, '').toLowerCase();
  if (/^\/(etc|usr|bin|sbin|boot|lib|lib64|opt|sys|proc)(\/|$)/.test(s)) return true;
  if (/^[a-z]:\/(windows|program files( \(x86\))?|programdata)(\/|$)/.test(s)) return true;
  return false;
}

// ---- /dev/null 等「書込みに見えるが実体のない」宛先の判定 -----------------
const NULLISH = new Set([
  '/dev/null', '/dev/zero', '/dev/stdout', '/dev/stderr', '/dev/tty',
  '/dev/fd/1', '/dev/fd/2', 'nul', 'nul:', 'con',
]);
function isNullish(c) {
  const l = String(c || '').toLowerCase();
  if (NULLISH.has(l)) return true;
  if (/[\\/]dev[\\/](null|zero|stdout|stderr|tty)$/.test(l)) return true;
  return false;
}

// ---- Bash コマンドから書込み対象（宛先パス）を抽出 -----------------------
// リダイレクト先 / tee / cp・mv・install・rsync の宛先を返す。読取専用コマンドでは空配列。
function bashWriteTargets(cmd) {
  const out = [];
  if (!cmd) return out;
  let m;
  const redir = /(?:^|[\s;|&])(?:\d*>>?|&>)\s*("?)([^\s"'|;&]+)\1/g;
  while ((m = redir.exec(cmd)) !== null) out.push(m[2]);
  const teeRe = /\btee\s+(?:-a\s+)?("?)([^\s"'|;&]+)\1/g;
  while ((m = teeRe.exec(cmd)) !== null) out.push(m[2]);
  for (const verb of ['cp', 'mv', 'install', 'rsync']) {
    const re = new RegExp('\\b' + verb + '\\b([^;|&]*)', 'g');
    while ((m = re.exec(cmd)) !== null) {
      const args = m[1].trim().split(/\s+/).filter((a) => a && !a.startsWith('-'));
      if (args.length >= 2) out.push(args[args.length - 1]);
    }
  }
  return out;
}

// ---- Bash コマンドが「実体のある書込み」を含むか判定 ---------------------
// heredoc / sed -i / cp・mv 等の書込動詞 / nullish でないリダイレクト先が1つでもあれば true。
// 純粋な読み取り（ls / cat / grep、`2>/dev/null` 付き含む）では false。
function bashHasRealWrite(cmd) {
  if (!cmd) return false;
  if (/<<-?\s*["']?[A-Za-z_]/.test(cmd)) return true;            // heredoc 本体を書込む
  if (/\bsed\b[^|;&]*\s-i\b/.test(cmd)) return true;             // in-place 編集
  if (/\b(?:cp|mv|install|rsync|dd|ln|mkdir|touch|rm|rmdir|shred|unlink)\b/.test(cmd)) return true;
  return bashWriteTargets(cmd).some((t) => t && !isNullish(t));  // ファイルへのリダイレクト
}

// ---- 出力ヘルパ ----------------------------------------------------------
function block(message) {
  process.stderr.write(message.endsWith('\n') ? message : message + '\n');
  process.exit(2);
}
function allow() { process.exit(0); }
function ask(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: reason },
  }));
  process.exit(0);
}
function notify(systemMessage) {
  try { process.stdout.write(JSON.stringify({ systemMessage, continue: true, suppressOutput: false })); } catch (_) {}
  process.exit(0);
}

module.exports = {
  readInput, toText, parsePatch,
  WRITE_TOOLS, SHELL_TOOLS, isWriteTool, isShellTool,
  policy, guardMode, guardParam, enforce, excludePatterns, isExcludedPath, isGuardLocked, baselinePolicy,
  expandHome, toAbsolute, normalize, HOME,
  allowedWriteRoots, isInsideWorkspace,
  isSystemPath, isNullish, bashWriteTargets, bashHasRealWrite,
  block, allow, ask, notify,
};
