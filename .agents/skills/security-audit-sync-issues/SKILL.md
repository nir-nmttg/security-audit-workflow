---
name: security-audit-sync-issues
description: Cloudflare の security-audit で自律監査し、非公開リポジトリの調査・判定一覧と確定所見の修正 Issue を作成・更新する。続きの監査にも使う。
---

# フル監査の結果を GitHub Issue に反映する

監査するプロジェクトの直下で実行する。Cloudflare の `security-audit` でフル監査し、成果物は実行者の端末に保存する。全判定と反映結果は集約 Issue に、確定所見は根本原因ごとの修正 Issue に記録する。人は Issue を読んで修正や追加調査を判断する。

このスキル集の流れでは、このスキルが ① 広く洗い出す段を受け持つ。元スキルは、OS で強制した隔離環境（外部ネットワークの禁止など）やデプロイ先の事実がなければ所見を確定にせず `needs_validation`（要検証）に留める。隔離環境がない環境では確定が出ないのが通常の結果で、要検証は ② の security-audit-verify-items が手元の材料と人の知識で確かめて確定・棄却にし、③ 修正 Issue から直す。

## 実行環境を確かめる

- Cloudflare の `skills/security-audit/` を、参照ファイル・スキーマ・バリデーターごと、信頼できるスキルの配置先（例 `~/.agents/skills/security-audit/`）に置く。監査には `git`・`node`・サブエージェントと、保存先への書き込み権限を使う。 [Cloudflare のスキル](https://github.com/cloudflare/security-audit-skill/tree/main/skills/security-audit)
- Issue の反映には、対象ホストでログイン済みの `gh` と Issue の作成・編集権限を使う。確認には [security-audit-preflight](../security-audit-preflight/SKILL.md) を使える。GitHub の前提を満たせない場合も、監査成果物は端末に保存する。
- 元スキルが確定に求める隔離環境があるかを最初に確かめ、`run-metadata.json` に記録する。なければ、確定まで進めないこと（要検証は security-audit-verify-items で確かめる）を、最終報告と集約 Issue の冒頭の「次の一手」に書く。

## 引数を確かめる

```text
$security-audit-sync-issues [--profile quick|standard|deep] [<集約 Issue の URL か番号>]
```

- 集約 Issue を指定したときは **続きの監査** にする。新しい集約 Issue を作らず、指定した Issue の項目（既定は未検証と未完了の工程・範囲）を今回の監査で調べ直して差し替える。手順は [続きの監査で既存の集約 Issue に書く](references/issue-sync.md#5-続きの監査で既存の集約-issue-に書く) に従う。指定がなければ、実行ごとに集約 Issue を1件作る。
- `--profile` の既定値は `deep`。指定された `quick`・`standard`・`deep` のいずれか、未指定なら `deep` を、元スキルにプロファイルとして明示して渡す（元スキルの既定は `standard` なので任せない）。それ以外の値が指定された場合は使える値を案内し、監査を保留する。
- `git rev-parse --show-toplevel` で監査対象を確かめる。Git リポジトリを特定できない場合は、監査するプロジェクトの直下で実行するよう案内する。

## 人の応答を待たずに進める

- スケジュールには対象プロジェクトとこのスキルの呼び出しを設定し、同じリポジトリへの Issue 反映を同時実行1件にする。実行時のプロファイル・範囲・予算は指定を使う。未指定ならプロファイルは `deep`、範囲はリポジトリ全体、元スキルの `budget` は `null` とする。
- 調査中に判断材料や権限が不足したら、理由と追加調査の方法を記録して、独立して進められる作業を続ける。予算不足や曖昧な登録先も保留理由に記録する。プロファイル・範囲・予算の変更が必要な項目は、再開条件として残す。
- 監査の完了状況と Issue 反映の完了状況を別々に記録する。反映できる結果を最後まで処理し、未解決事項を集約 Issue と最終報告に残す。

## Supervisor と Coordinator に分けて進める

Codex の安全審査で Coordinator のターンが止まっても人の手を待たずに進むよう、このスキルを呼び出したエージェント（Supervisor）は、手順 1〜4 をサブエージェントの Coordinator に任せて見張り、止まったら続きを頼む。Supervisor の手順は [Supervisor として Coordinator の停止を見張る](references/supervision.md) に従い、手順 5・6 の最終報告は Supervisor が書く。Coordinator は元スキルの Parent（親）に当たり、この SKILL.md と参照ファイルの「親エージェント」も Coordinator（Coordinator を使わない場合は Supervisor）を指す。元スキルの hunter・critic・verifier などを Worker と呼ぶ。

Coordinator の役目:

- 最初に子を1つ起動して決まった語を返させ、Coordinator 自身が子を起動できることを確かめる。この起動は元スキルの `budget` に数え、`budget` が指定されていれば元スキルの最低限の予約に足りることを確かめてから起動する。起動できなければ、共有ファイルを作る前に状態報告 `unsupported` を返す。
- 手順 1〜4 と「監査の一部が止まった場合」を行う。出力先には、元スキルの出力先として Supervisor が作った実行フォルダを使う。元スキルの親の役目（共有ファイルの唯一の書き手、台帳の更新、Worker の起動）と `issue_sync` の書き手は Coordinator が持つ。
- 判断材料・権限・予算が足りないときも「人の応答を待たずに進める」に従って記録し、進められる作業を続ける。
- Supervisor には途中経過を送らない。Supervisor に返すのは、ターンを終えるときの状態報告だけにする。
- ターンを終えるときは、次の状態報告だけを最終回答にする。`complete`・`incomplete` は、監査が元スキルの終わり方（成果物が揃い検証を通す、または `run_status: "incomplete"` と理由を記録）に達し、手順 4 の Issue 反映を終えた（保留した場合はその理由を記録した）ときだけ使う。

  ```json
  {"role":"coordinator","status":"complete|incomplete|unsupported","run_dir":"<実行フォルダの絶対パス>"}
  ```

Coordinator を起動できない場合や、Coordinator が `unsupported` を返した場合は、Supervisor が手順 1〜6 を自分で行い、Supervisor のターンが止まったら人が「続けてください」を送る。

## 監査して結果を反映する

1. 導入済みの `security-audit` の `SKILL.md` と対象に必要な参照ファイルを読む。[登録先と実行の記録](references/issue-sync.md#監査開始前に登録先を特定する) に従い、GitHub リポジトリと実行識別子を記録する。
2. 指定プロファイルで元スキルの手順と隔離条件に従ってフル監査し、結果を `~/security-audit-skill/<repo-name>/run-<N>/` に保存する。一部の作業が止まったら [監査の一部が止まった場合](#監査の一部が止まった場合) に従う。最終報告（部分報告を含む）を確定した実際の日時を、実行時に記録したタイムゾーンとオフセット付きの ISO 8601 形式で `run-metadata.json` の `report_finalized_at` に記録する。再開時などで確かめられない日時は不明とする。
3. [Issue に反映する手順](references/issue-sync.md) に従う。独立検証済みの `confirmed` が1件以上あるときだけ [修正 Issue に反映する](references/fix-issues.md) を読み、根本原因ごとの修正 Issue に反映する。[本文の書式](references/issue-templates.md) を使い、タイトルには影響に応じた深刻度を付ける。
4. 修正 Issue の反映結果を確かめ、確定・要検証・未検証・棄却を一覧表と項目ごとの詳細にした集約 Issue を作成・更新する（続きの監査では、指定した Issue の対象の項目だけを差し替える）。確定所見は、題名を修正 Issue へのリンクにして対応状況（`open`・`merged` など）を載せ、反映結果は詳細に書く。タイトルは実行時に記録したタイムゾーンの日付で `[yyyy-mm-dd] セキュリティ監査の調査・判定一覧` とする。
5. 日本語で監査と Issue 反映の完了状況・監査対象 SHA・4区分の件数・集約 Issue の URL を報告する。確かめられない件数は不明とする。`REPORT.md` を保存できたら絶対パスを示し、保存できなければ保存済み成果物の絶対パスと停止理由を示す。修正 Issue は作成／更新／変更なし／保留の件数と URL、`agent:autofix` を追加したものを示す。Terra への頼み直しは、`model-fallback.json` の件数（審査で止まった元の Worker の数、Terra を起動できた数、結果ごとの数、見送りの理由ごとの数）を示し、記録がなければ記録なし、再開後の分だけなら再開後の分と書く。別名の追加・古い結果・再発候補・権限不足・追加検証や人の判断が必要な項目には理由を添える。
6. 最後に **次の一手** を、当てはまるものだけ短く書く。保留や未検証が残り集約 Issue があれば「続きは `$security-audit-sync-issues <集約 Issue の URL>`」、集約 Issue がまだなければ（`summary_url` が `null`）「同じ会話で『続けてください』と送る」と実行フォルダの絶対パス、要検証があり集約 Issue があれば「security-audit-verify-items に集約 Issue の URL を渡して確かめられる」と書く。

## 監査の一部が止まった場合

- 指定プロファイル・監査範囲・証拠基準を維持する。止まった項目とその依存作業を保留し、元スキルの工程順と前提を守って、独立して進められる作業を続ける。
- 一時エラーは安全に再試行できる場合に復旧する。Worker が審査で止まったときは、[審査で止まった Worker を別のモデルに頼み直す](references/model-fallback.md) に従う。頼み直さない・頼み直しても進まない場合や、個々の操作が Daybreak の案内や権限不足で拒否されたときは、その項目を保留し、ソースや既存テストの読み取りなど、許可された方法で必要な事実を確かめられるか判断する。
- 保留・終わりの状態・予算の予約は、元スキルの台帳の状態の決まりに従う。審査の停止で保留にした作業は、元スキルの再割り当て（`planned` に戻す、新しい verifier で再実行する）に回さない。保留した項目は、あとの続きの監査で調べ直せる。
- Coordinator のターンそのものが審査で止まった場合は、Supervisor が [Supervisor として Coordinator の停止を見張る](references/supervision.md) に従って続きを頼む。続きを頼まれた Coordinator は、届いた文面に従う（止まる直前に扱っていた項目は保留にし、項目に分かれない作業は1回だけ進め直し、そのほかは止まる前の続きから進める）。
- 初期調査から成果物の検証・保存まで、親エージェントが進捗を随時保存する。停止した工程・項目 ID（カバレッジ単位 ID や fingerprint など）・理由・確認済みの根拠・残作業・再開条件は、同じ実行の `coverage-ledger.json` に元スキルの形式を保って記録する。台帳に記録できない場合は `run-metadata.json` を使い、どちらにも保存できなければユーザーへの報告に含める。再開時は記録を読み直し、監査対象 SHA と再開条件を確認する。
- 判定に至らなかった候補は、元スキルの決まりどおり台帳に未解決の理由を記録し、未検証として `needs_validation` と別に数える。停止による未完了が残る場合は `run_status: "incomplete"` と `incomplete_reason` を記録し、残った範囲と再開条件を部分報告と最終報告に書く。

## 審査で止まった Worker を別のモデルに頼み直す

Worker が審査で止まったときは [審査で止まった Worker を別のモデルに頼み直す](references/model-fallback.md) を読み、GPT-6.1 Terra に1回だけ頼み直す。以下の2つは、止まったかどうかにかかわらず行う。`FALLBACK` はこのスキルのフォルダにある `scripts/fallback.mjs` を `node` で実行すること、`RUN_DIR` は実行フォルダの絶対パスを表す。

- 親エージェントは `run-metadata.json` を作った直後に `FALLBACK init "$RUN_DIR"` を実行する。この仕組みが入る前に始めた実行を再開したときは、最初に `FALLBACK init "$RUN_DIR" --resumed` を実行する（記録は再開後の分だけになる）。
- Coordinator 自身が止まって続きを頼まれたとき（Supervisor が自分で監査していて、人が「続けてください」と送ったときも）は、最初に `FALLBACK pending "$RUN_DIR"` を実行し、出た記録ごとに次のように扱う。もう一度頼み直すことはしない。
  - 台帳に、その ID の結果がすでに反映されている（監査単位の `agent_id` がその ID で終わりの状態になっている、verifier なら判定が記録されている）: `FALLBACK end "$RUN_DIR" <ID> completed` だけを実行する。
  - `codex_agent_id` があり、`list_agents` でその Worker がまだ動いている: 待って、参照ファイルの手順 7. で扱う。
  - その Worker が終わっている、`not_started`、または `list_agents` で見つからない: 結果を扱う途中で止まった可能性があるので、保留にしてから `FALLBACK end "$RUN_DIR" <ID> interrupted` を実行する（同じ結果を扱い直して何度も止まらないようにするため）。`interrupted` が2件になると、`begin` は新しい頼み直しを断る。
