---
description: 配布・継承のあるファイルを触る前に「正本はどれか」「手元は最新か」を確認する
---

# 触る前に確認する 3 つ

**配布・継承のあるファイル**（`.github/workflows/*` / `.claude/rules/*` / `ci-templates/*` /
テンプレート類）を変更する前に、必ず次を確認する。**確認せずに書き始めない。**

## 1. 正本（canonical）はどれか

**ドキュメントの記述ではなく、配布スクリプトの実装で確かめる。**

```bash
# @claude bot 関連の配布ルール（clone 不要・どの環境でも動く）
gh api repos/sigmaxyz-ad/ae-infra/contents/scripts/bot_drift_check.sh \
  -H "Accept: application/vnd.github.raw" | sed -n '1,30p'
```

現行（2026-08-01 時点）:

| 対象 | 正本 | 判定 |
|---|---|---|
| `claude.yml` / `mention-assign.yml` | **`_template/.github/workflows/`** | 内容ハッシュ**厳密一致** |
| `.claude/rules/*` | **`_template/.claude/rules/`** | 同上 |
| `.gitattributes` | `_template/`（`ws-*` は対象外） | 検知は同じだが、**是正は「未作成 or 既知テンプレ hash のときだけ上書き」**（リポ固有の追記を消さない安全弁） |

`ae-infra/ci-templates/` は**文書参照用ミラー**であって正本ではない。

## 2. 手元は最新か

```bash
git fetch origin main && git diff origin/main --stat
# 別ブランチで作業中のリポを読むときは worktree で最新 main を用意する
git worktree add ../<repo>-wt-main origin/main --detach
```

## 3. 同等機能が既に無いか

**実装前に canonical の中身を読む。** 二重実装は drift の温床になる。

---

## なぜこの規則があるか（2026-08-01 の実害）

`ci-templates/claude.yml` を正本と思い込んで PAT 検証を実装した。実際の正本 `_template` には
**同等機能（`patscope`）が 2026-07-30 に実装済み**で、さらに canonical は secrets 取得を
`toJSON(secrets)` から**動的キー方式へ改善済み**だった（ae-infra#277・爆発半径の最小化）。

古い版に変更を乗せてマージしており、**そのまま canonical へ持ち込んでいればセキュリティ改善を
巻き戻していた**。確認は数十秒で済むことだった。

> 下にトランポリンがあるか確かめずに飛び降りてはいけない。