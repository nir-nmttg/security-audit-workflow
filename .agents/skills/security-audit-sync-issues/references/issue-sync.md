# 監査結果を Issue に反映する手順

## 監査開始前に登録先を特定する

- `origin` があれば `git remote get-url --all origin` で取得先を確認する。`origin` がなければ、ほかのリモートから GitHub のリポジトリを探す。SSH と HTTPS などで同じリポジトリを指す URL は同じ対象として扱う。
- GitHub のリポジトリを一意に特定できたら、ホスト・所有者・リポジトリ名を `run-metadata.json` に記録する。反映時は監査時の記録を使う。特定できなければ、監査成果物を端末に保存し、反映を保留する。
- 親エージェントが同じメタデータに `issue_sync` を作り、`audit_id` に新しい UUID、`status` に `pending` を保存する。UUID は `node -p 'require("node:crypto").randomUUID()'` などで生成する。同じ実行の再開時は保存済みの値を使い、新しい実行には別の値を割り当てる。
- 新規実行では、実行環境のローカルタイムゾーンを `node -p 'Intl.DateTimeFormat().resolvedOptions().timeZone'` などで取得し、`run-metadata.json` の `timezone` に IANA 名で保存する。この実行の日付・日時の記録と表示にはそのゾーンを使い、日時には ISO 8601 のオフセットを付ける。再開時は保存したゾーンを使い、記録がなければ再開環境で取得した値を基準として記録する。取得できなければ日時を不明とし、取得を再開条件に記録する。
- `issue_sync` には集約 Issue の日付と URL（`summary_url`）、修正 Issue の fingerprint ごとの反映結果・URL・保留理由も保存する。修正 Issue は配列 `individuals` に1件ずつ `fingerprint`・`url`・`result`（`created`・`updated`・`unchanged`・`held` のどれか）・`autofix_added`（真偽値）・`reason`（保留の理由の短い文。なければ `null`）を、件数は `individual_counts`（`created`・`updated`・`unchanged`・`held`・`autofix_added`）に保存する。監査対象 SHA やプロファイルなど元スキルの項目を保ち、候補の判定と根拠は元スキルの台帳と `findings.json` に記録する。

## 1. 監査成果物を照合する

- 保存済みの最終報告 `REPORT.md`・`run-metadata.json`・最終版の `findings.json` が同じ実行の成果物であることを確かめる。報告書とメタデータを照合し、監査対象リポジトリと完全なコミット SHA（`NEW_SHA`）を一意に特定する。Cloudflare の `validate-findings.cjs` と `validate-coverage-ledger.cjs` を `node` で同じ実行の `findings.json` と `coverage-ledger.json` に対して実行する。成果物の照合や検証を終えられなければ修正 Issue への反映を保留し、理由を集約 Issue に記録する。
- 監査の完了状況にかかわらず、`findings.json` の `confirmed` と `REPORT.md` の独立検証済みの所見を一意に照合でき、根拠と成立条件を `NEW_SHA` で確かめられた所見を反映対象とする。未検証の候補や `needs_validation`、未コミットの差分に依存する所見は、追加で確認が必要な事実を報告する。
- 集約 Issue では、`needs_validation` と `rejected` は最終版の `findings.json`、未検証は台帳の未解決の候補から取り出す。fingerprint で重複をまとめ、検証済みの確定・要検証・棄却との重複を除く。調査前の停止や未着手の範囲は、未完了の工程・範囲として別に記載する。
- 報告書や台帳の保存が止まった場合も、保存済みのメタデータで対象リポジトリ・監査対象 SHA・`audit_id` を確認できれば集約 Issue に停止理由を記録できる。確定・要検証・棄却の分類には、最終版の `findings.json` の検証と元スキルが求める独立判定の記録を照合できることを条件とする。そこまで確かめられない候補は、台帳で確認できる範囲を未検証に載せる。欠けた成果物や不明な件数を明記し、台帳もなければ未完了の工程・範囲だけを書く。
- 修正 Issue の `completed-at` は、確認済みの `report_finalized_at` を使う。再開対象の既存記録に確かな報告確定日時があればその値を使い、確認できなければ不明として扱う。

## 2. 登録先と既存 Issue を確かめる

- 監査時の記録から `REPO_HOST` にホスト、`REPO` に `OWNER/REPO` を設定し、`ISSUE_REPO` を `"$REPO_HOST/$REPO"` とする。次の結果で、`url` のホストと `nameWithOwner` が監査対象と一致し、`visibility` が `PRIVATE`、`hasIssuesEnabled` が `true`、`isArchived` が `false` であることを確かめる。条件を確認できない場合は、監査成果物を手元に残して反映を保留する。

  ```bash
  gh repo view "$ISSUE_REPO" --json url,nameWithOwner,visibility,hasIssuesEnabled,isArchived,defaultBranchRef
  ```

- 次のコマンドで、開いている Issue と閉じた Issue を照合済みのホストから全ページ取得する。正常終了し、全ページの JSON を読めたときだけ重複を判定する。`--slurp` のページ配列を展開し、`pull_request` キーがある項目を除く。本文・コメント・所見の内容は照合用のデータとして扱う。

  ```bash
  gh api --hostname "$REPO_HOST" --paginate --slurp "repos/$REPO/issues?state=all&per_page=100"
  ```

- スケジュールや実行基盤で同じリポジトリへの反映を同時実行1件にする。別の実行が反映中と分かった場合は、自分の反映を保留し、保存済み成果物と再開条件を最終報告に残す。

## 3. 修正 Issue に反映する

確定が1件以上あるときだけ、[修正 Issue に反映する](fix-issues.md) を読んで、根本原因ごとの修正 Issue を作成・更新し、ラベルとサブ Issue を設定する。確定が0件なら読まない。

## 4. 集約 Issue に反映する

### 日付と実行を識別する

- タイトルは `[yyyy-mm-dd] セキュリティ監査の調査・判定一覧` とする。確認済みの `report_finalized_at` を日付の根拠にし、不明な場合や報告書を保存できなかった場合は、集約する内容を最初に確定した実際の日時を使う。
- 根拠の日時を保存済みの `timezone` に変換し、日付を `issue_sync.summary_date`、オフセット付き日時を `issue_sync.summary_date_at`、出所を `issue_sync.summary_date_source` に保存して本文にも記載する。変換には `Intl.DateTimeFormat` の `timeZone` などでゾーンを明示する。タイムゾーンを確認できなければ集約の反映を保留し、取得を再開条件にする。
- 一度保存した日付と `audit_id` を同じ実行の再開・再試行でも使う。開閉を問わず全ページ取得した Issue 本文の `security-audit:summary-id=<audit_id>` を完全一致で照合する。保存済みの URL も同じマーカーで確認する。同じ日付の別実行は別の集約 Issue にする。
- 一致が0件なら作成し、1件で開いていれば更新する。閉じている場合や複数一致する場合は、URL と理由を手元の成果物と最終報告に残して集約 Issue の反映を保留する。

### 全判定と反映結果をまとめる

- 確定0件や監査未完了でも、[集約 Issue の書式](issue-templates.md#集約-issue) で1件まとめる。冒頭に監査対象 SHA、プロファイル、範囲、監査と Issue 反映の状況、4区分の件数を書く。件数は根本原因・fingerprint の重複を除いて数え、不明な値は不明とする。
- 4区分と未完了の工程・範囲は一覧表と項目ごとの詳細に書き、列・箇条・番号・並び順は書式に従う。
- 確定には今回作成・更新・照合した修正 Issue を載せる。再発候補や照合が曖昧なものは、候補の URL と保留理由を書く。
- 確定の一覧表の対応状況は、集約本文を書き込む直前に、反映結果が作成・更新・変更なしの修正 Issue ごとに `gh issue view "$NUMBER" --repo "$ISSUE_REPO" --json state,closedByPullRequestsReferences` で取り直して決める。閉じている Issue は、参照された PR を `gh pr view "$PR_URL" --json state` で確かめ、`MERGED` があれば `merged` にする。状態を取得できなければ `不明` と書き、理由を詳細の反映結果に書く。
- 要検証は `blockers` と `validation_plan`、棄却は `reason` をもとに書き、棄却には判断を覆す新しい事実の条件を示す。
- 同じ実行の再開で候補が確定した場合は、番号を変えずに確定の区分へ移し、修正 Issue にリンクする。人が記載した判断や追記は保持する。
- 書き込む本文を組み立てたら、`scripts/summary-body.mjs check <全文>` を通す（番号の一意、見出しの件数・一覧表の行数・詳細の数の一致、並び順を確かめる。件数が不明の区分は見出しの形が違うので、外れた語を見て手で確かめる）。冒頭の件数と、Terra での頼み直しの見出しの件数・行数・`model-fallback.json` の記録の件数の一致は手で確かめる。
- 書き込む全文（更新では区画外の人の追記を含む）を、[本文とコメントに分ける](issue-templates.md#本文とコメントに分ける) に従って `scripts/summary-body.mjs split` に通す（更新では今の本文とコメントを `--body`・`--comments` に渡し、新しく作るときは省く）。全文が 60,000 文字に収まり、まだ分けていない集約 Issue は、全文をそのまま本文にする（`mode single`）。超える場合や、すでに分けている集約 Issue は、本文（一覧表）と区分ごとの詳細コメントに分ける（`mode split`）。詳細は削らない。`split` が上限で止まった（終了コード 1）場合は、全文の更新案を手元に保存して集約 Issue の反映を保留し、理由を最終報告に残す。

### 再開時も同じ Issue を更新する

- 書き込み予定の集約本文と `issue_sync.summary_revision` を端末に保存する。初回は1とし、内容を変えるたびに増やす。本文の `security-audit:summary-revision` に同じ値を記録する。書き込み結果が不明な場合は、保存した本文と版番号を使って GitHub の状態を照合する。
- 作成直前は全ページの一覧を取り直し、`summary-id` の重複を再確認する。更新直前は最新の本文・タイトル・状態を `gh issue view` で、コメントを全ページ取得し、`scripts/summary-body.mjs compose` で全文に戻してから比べる（本文からリンクした詳細コメントだけを詳細として読む）。既存の版が今回より新しい場合、または同じ版で予定した監査用区画と内容が異なる場合は、URL と理由を手元に残して保留する。
- 更新は `security-audit:summary-begin` と `security-audit:summary-end` の間を一意に特定でき、人の追記を保持できる場合に行う。監査用区画外の本文・担当者・既存ラベルを保持し、タイトルを保存済みの日付の書式に合わせる。区画を特定できない場合は更新案を手元に残して保留する。
- 手順 2 の登録先条件を再確認し、[修正 Issue の作成・更新](fix-issues.md#3-修正-issue-を作成更新する) と同じ `gh issue create` / `gh issue edit` と `--body-file` を使う。`mode split` で新しく作るときは、`split` の本文の詳細へのリンクを「（詳細はコメントに書く）」に置き換えた本文で作成し、計画の詳細コメントを作ってから、URL を `fill` で入れた本文に 1 回で編集する。更新では計画の順（`create` のコメントを作る → `fill` した本文を編集する → `retire` のコメントを書き換える）に書き、`same` は書かない。リンク中のコメントは書き換えない（中身の変わる部は `split` が新しいコメントにする）。本文とタイトルに差分がなければ書き込みを省く。反映後に本文とコメントを取得し直して `compose` し、書き込み予定の全文と一致すること、リンクと一覧表・詳細を確かめ、集約 Issue の URL をメタデータに保存する。成否が不明なら再取得して照合してから再試行する。
- 同じ実行の再開では、その実行の最新の台帳・最終版の所見を使い、監査用区画を台帳から組み直す。security-audit-verify-items が書いた区分の移動や追記は台帳にないため消える。既存の集約 Issue の続きとして監査するときは、組み直さずに [5. 続きの監査で既存の集約 Issue に書く](#5-続きの監査で既存の集約-issue-に書く) に従う。

## 5. 続きの監査で既存の集約 Issue に書く

引数で集約 Issue の URL か番号を受けたときは、新しい集約 Issue を作らず、その Issue の項目を差し替える。security-audit-verify-items が書いた区分の移動・修正 Issue へのリンク・人の追記と、今回の対象でない項目は変えない。

以下、`SUMMARY` はこのスキルのフォルダにある `scripts/summary-body.mjs` を `node` で実行することを表す。終了コード 1 は検査に外れた、2 は集約 Issue の構造の異常、3 は引数の誤り。

### 始める前に確かめる

- 集約 Issue が手順 2 の登録先にあり、開いていて、本文に `security-audit:summary-id` があることを確かめる。本文とコメントの全ページを取って `SUMMARY compose` で全文に戻し、`SUMMARY items` が通る（構造が書式どおり）ことを確かめる。閉じている・構造が書式どおりでない（終了コード 2）ときは、理由の語を最終報告に書いて集約 Issue への反映を保留する。並び順の違い（`SUMMARY check` の `order:`・`details_order:`）は、組み立てで直るので保留の理由にしない。
- `SUMMARY items <全文> > "$RUN_DIR/summary-start.json"` で、開始時の項目の全文・ID を控える（出力の `default_targets` は security-audit-verify-items 用で要検証を含むので、続きの監査の対象には使わない）。本文の `security-audit:summary-revision` の値を `issue_sync.continues.start_revision` に、集約 Issue の URL を `issue_sync.summary_url` にも保存する。

### 対象と識別子

- 対象は、ユーザーが番号を指定すればその項目、指定がなければその Issue の未検証と未完了の工程・範囲の項目にする。要検証は、Codex では隔離環境がないと確定・棄却に決まらず、security-audit-verify-items が書き換える項目と重なるので、指定がなければ対象にしない。
- 対象の項目を今回の監査でどう扱うか（どの候補・監査単位を今回の作業にするか）は、元スキルの前回の実行の扱いに従う。このファイルが決めるのは、結果をどの Issue のどの項目に書くかだけ。
- 実行フォルダ・台帳・`findings.json`・`audit_id` は今回の実行のものを新しく作る。書き込み先の Issue は `issue_sync.continues`（`summary_url`・`summary_id`・`start_revision`）に別に保存し、本文の `summary-id` は Issue のものを変えない。
- 項目は ID（fingerprint・項目 ID・監査単位 ID）で今回の台帳と結ぶ。`U` の番号は書くたびに振り直されるので照合に使わない。`U` の項目は ID が複数・省略ありなので、控えた ID の全体で照合する。一意に結べない項目は書かず、理由を最終報告に書く。

### 書く

1. lock を取る前に、対象の項目ごとに下書き（1 行目に `区分: <確定|要検証|未検証|棄却|未完了の工程・範囲|削除>`、空行、一覧表の 1 行、空行、`<details>` の詳細）を書式どおりに作る。区分が変わらない項目の題名と領域は変えない。調べ終えた未完了の工程・範囲は `区分: 削除` にする。確定にした所見は、本文とコメントを取り直して `SUMMARY same` で対象が開始時から変わっていないことを確かめてから、[修正 Issue に反映する](fix-issues.md) で修正 Issue を作り（ラベルとサブ Issue も済ませる）、題名をそのリンクにする。変わっていた項目は修正 Issue を作らずに報告に回す。lock の中では時間のかかる作業をしない（30 分を過ぎた lock は、ほかの実行に引き継がれる）。
2. `SUMMARY lock "$RUN_DIR" <集約 Issue の URL>` で書き込みの順番を取る（security-audit-verify-items と同じ lock を使う）。`locked …` が出たら、ほかの実行が書いている。1 分ずつ待って取り直す。本文やコメントを書く直前にも呼び直し、`ok` 以外なら書かずに止める。
3. lock を取ったら、本文とコメントを取り直して `compose` し、`SUMMARY same "$RUN_DIR/summary-start.json" <全文> <対象の番号>` で、対象の項目が開始時から変わっていないことを確かめる。変わっていれば、その項目は書かずに報告に回す。
4. 計画の JSON（`items`・`new`・`remove`・`values`・`note`）を書き、3. で取り直した全文から `SUMMARY assemble <全文> <計画> <組み立てた全文> --targets <対象の番号> --bump-revision <start_revision>` で組み立てる（`--targets` には、新しく足す項目の番号も入れる）。`counts …` が出たら（冒頭に `**結論**:` の行がない古い書式）、組み立てた全文の冒頭の件数を手で直し、`assemble` と同じ `--targets`・`--new`（新しく足した番号）・`--remove`（統合して消した番号）・`--bump-revision` で `SUMMARY check-body` を通し直す。`note` には `**<日付> 追記（続きの監査）**: <今回の監査対象 SHA の先頭 12 桁> で <対象の番号> を調べ直した。` の形で、何をしたかを 1 行書く。冒頭の監査対象 SHA・タイトルの日付は元のままにし、今回の SHA と日時は、差し替えた項目の根拠の箇条と追記の行に書く（[書式](issue-templates.md#詳細) の「冒頭と異なる SHA・日時の根拠は、その箇条に明記する」）。
5. `SUMMARY check` が通ることを確かめる。書く直前に lock を呼び直し、本文とコメントを取り直して `compose` した全文が 3. の全文と同じことを確かめる（違えば書かずに 3. からやり直す）。手順 4 の「再開時も同じ Issue を更新する」の `split` と書き方で書き、書いたあとで取り直して `compose` し、組み立てた全文と一致することを確かめる。
6. 続きの監査では、修正 Issue・ラベル・サブ Issue を本文より先に済ませるので、反映状況（[6. ラベルと反映状況を記録する](#6-ラベルと反映状況を記録する)）は確定した値で 5. の 1 回で書き、書き戻しの版を作らない。`**結論**:` の行の Issue 反映の状況は、組み立てたあとに書き換えてから 4. と同じ引数で `SUMMARY check-body` を通す（結論の行は書き換えてよい）。終えたら、または書くのをやめたら `SUMMARY unlock "$RUN_DIR" <集約 Issue の URL>` で lock を外す。

## 6. ラベルと反映状況を記録する

### ラベルを確かめて付ける

- 集約 Issue に `agent:security-audit` を付ける（修正 Issue のラベルは [ラベルとサブ Issue](fix-issues.md#4-ラベルとサブ-issue)）。未付与のラベルごとに `LABEL` をその名前に設定する。登録先のラベルを全ページ取得し、`name` が `LABEL` と完全一致する項目があるか確認する。

  ```bash
  gh api --hostname "$REPO_HOST" --paginate --slurp "repos/$REPO/labels?per_page=100"
  ```

- 一覧を最後まで取得でき、ラベルがなければ、このスキルの `scripts/labels.json` にある色と説明で作る（security-audit-verify-items も同じファイルを使う）。あるラベルの色と説明は変えない。作成に失敗した場合は一覧を読み直す。別の担当者が作成済みと分かれば、そのラベルを使う。

  ```bash
  gh label create "$LABEL" --repo "$ISSUE_REPO" --color "$COLOR" --description "$DESCRIPTION"
  ```

- ラベルの存在を確認できたら、`gh issue edit "$NUMBER" --repo "$ISSUE_REPO" --add-label "$LABEL"` で付ける。本文とラベルの両方に差分がなければ書き込まない。ラベルの確認・作成・付与を完了できなければ、対象 Issue の URL・ラベル名・理由を報告する。

### 反映状況を確定して書き戻す

- 修正 Issue・ラベル・サブ Issue の結果を確かめ、集約 Issue 自身のラベル付与も確認してから `issue_sync.status` を確定する。すべて反映できれば `complete`、一部に保留や失敗（サブ Issue は失敗だけ）があれば `partial`、登録先や権限などの前提を満たせず書き込めなければ `blocked` とする。監査の `run_status` は監査工程の完了状況を表す。
- 確定した反映状況とラベル・サブ Issue の結果を、書式に従って集約 Issue（冒頭の Issue 反映の状況、確定の一覧表の対応状況と詳細の反映結果、どの確定項目にも属さない保留を書く未完了の工程・範囲）に書き戻す。差分があれば手順 4 に従って版を増やして保存・反映・再取得する。この最終更新に失敗した場合は `issue_sync.status` を `partial` にし、保存済みの更新案と停止理由を最終報告に残す。
- 既存の集約 Issue を更新するときで、修正 Issue がなく、詳細をコメントに分けないときは、集約 Issue 自身のラベル付けを本文より先に済ませ、確定した反映状況で本文を 1 回で書く（反映状況だけを書き直す版を作らない）。新しく作るとき・分けるとき・サブ Issue の親の設定を待つときは、仮の本文を書いて読み戻してから、反映状況を書き戻す。
- 集約 Issue への反映も保留になった場合は、反映予定の本文と理由を実行フォルダに保存し、保存済み成果物の絶対パス・該当 Issue の URL・再開条件を最終報告に残す。
