---
description: GCP で権限不足に当たったときの手順（PAM JIT を引く）
---

# GCP で `PERMISSION_DENIED` に当たったら

**「権限が無いので実行できません」と人に手作業を投げる前に、次の2つを必ず確認する。**

## 1. 本当に権限不足か

`terraform` の場合、**refresh が別リソースで止まっているだけ**のことがある。

```bash
terraform plan -refresh=false -target=<目的のリソース>
```

これで通るなら権限不足ではない。**目的の差分だけに絞って適用できる。**

## 2. PAM JIT の entitlement があるか

**作業名そのままの entitlement が用意されていることがある。**

```bash
gcloud beta pam entitlements list --location=global --project=<proj> \
  --format='value(name.basename())'
gcloud beta pam entitlements describe <name> --location=global --project=<proj> --format=yaml
```

`describe` で見るのは4点 — `eligibleUsers`（**SA 限定なら `--impersonate-service-account` が必要**）／`approvalWorkflow`（承認者と必要数）／`maxRequestDuration`／**`roleBindings`（足りない権限が実際に含まれるか）**。

`approvalWorkflow` がある entitlement では、承認は承認者が行い、`maxRequestDuration` で自動失効し、PAM のグラント記録に残る。**無い entitlement では、申請がそのまま権限付与になる**（PAM は承認ワークフロー無しの entitlement も作れる）。

> **⛔ 申請（`grants create`）は `approvalWorkflow` の有無に関わらず `[USER AUTHORIZATION]` を取る。**
> `approvalWorkflow` が無ければ**申請＝IAM 権限付与そのもの**であり、[AGENTS.md](../../AGENTS.md) の 🔴「IAM role 変更」に直接該当する。
> **有る場合も同じ**扱いにする — 「承認者が挟まるから自分で申請してよい」という理屈を残すと、`describe` の読み違い1回で権限付与に化ける。**有無の判定を安全性の根拠にしない。**
>
> `describe` で `approvalWorkflow` を確認するのは、**人に何を認可してもらうのかを正しく伝えるため**であって、認可を省く条件を探すためではない。

## 3. 承認は人間に渡す

**@claude がやるのは、承認待ちを一覧して提示するところまで**（読み取り・認可不要）。

```bash
gcloud beta pam grants list --entitlement=<name> --location=global --project=<proj> \
  --format='table(name.basename(),state,requester)'
```

AD には横断一覧する `jit` コマンドがある。

> **⛔ 承認する側の手順（承認コマンド・承認できる端末や経路）はこのファイルに書かない。**
> PAM の承認は IAM 権限の付与そのもので、[AGENTS.md](../../AGENTS.md) の「必ず人間の `[USER AUTHORIZATION]` を取る操作」に該当する。
> **このファイルは全リポの全セッションに配布され、権限不足に陥った @claude が最初に読む場所である。** ここに承認のやり方を書けば、「人間が実行する」と併記しても**コマンドはコピペされる**。文字による禁止は技術的な障壁ではない。
> **承認手順は正本（下記リンク）にのみ置く。**

**自分の申請を自分で承認する経路を作らないこと** — 申請と承認が同一主体になると JIT の意味が失われる。

## 確認手段の一覧（GCP 固有）

| 確認したいこと | 手段 |
|---|---|
| JIT で権限を取れるか | `gcloud beta pam entitlements list` |
| terraform が本当に権限不足で止まっているか | `terraform plan -refresh=false -target=<リソース>` |
| ある権限を持っているか | 該当の `describe` / `get` を直接叩く |
| 承認待ちがあるか | `gcloud beta pam grants list`（上記 §3・AD なら `jit`） |

---
正本: [ae-config `dept/ad/knowledge/gcp-permission-denied-check-jit.md`](https://github.com/sigmaxyz-ad/ae-config/blob/main/dept/ad/knowledge/gcp-permission-denied-check-jit.md)