# 審査で止まった Worker を別のモデルに頼み直す

Worker が審査で止まったときに読む。セッションのモデル（Sol など）の Worker が審査で止まった作業を、GPT-6.1 Terra（`gpt-6.1-terra`）の新しい Worker に1回だけ頼み直す。モデルによって審査での止まり方が変わるかを実運用で確かめるための試みで、結果は件数とともに最終報告と集約 Issue に残す。Terra への依頼も同じ審査を通る。依頼文を言い換えたり分けたりして審査を避けることはしない。

以下、`FALLBACK` はこのスキルのフォルダにある `scripts/fallback.mjs` を `node` で実行すること、`RUN_DIR` は実行フォルダの絶対パスを表す。`FALLBACK` は1つずつ呼び、同時に呼ばない。記録（`RUN_DIR/model-fallback.json`）は `FALLBACK` だけが書く。記録の始め方（`FALLBACK init`）と、Coordinator が続きを頼まれたときの `FALLBACK pending` の扱いは SKILL.md にある。

## 止まったとみなす条件

Worker を `wait_agent` で待ったとき、最終回答が `Agent errored:` で始まり `flagged for possible cybersecurity risk` を含むか、返り値のエラーの種別が `cyber_policy` なら、審査で止まったとみなす。Worker の回答の本文にこの文言が引用されているだけなら、止まったとはみなさない。

## 止まったときの手順

1. `budget` が指定されていれば、元スキルの予約（post-wave critic・final-clean critic・検証の予約）を崩さずに1回分の起動を払えるかを確かめる。
2. `FALLBACK begin "$RUN_DIR" --stage <recon|hunting|critic|validation|final_verification> --stopped-agent <止まった agent ID>` に、担当した監査単位 ID を `--unit`、候補の fingerprint を `--fingerprint` で1つずつ付けて実行する。監査単位も候補もない reconnaissance・critic では、依頼の名前（例 `architecture`・`post-wave-2`）を `--task` で付ける。払えなければ `--no-budget` を付ける。Phase 3 の候補検証は `validation`、Phase 5 の最終検証は `final_verification` にする。
3. 止まった Worker を `close_agent` で閉じる（頼み直さないときも閉じる）。止まった Worker の `scratch/` は使わず、何も `artifacts/` に昇格しない。
4. 出力が `skip reason=handled result=<結果>` なら、同じ停止をすでに扱っているので台帳を変えない（`pending` のものは、SKILL.md の再開の扱いで扱う）。`skip reason=retry_worker` は頼み直しの Worker 自身の停止なので、手順 7. の `stopped` にする。ほかの `skip reason=<理由>` なら頼み直さず、保留にして理由を台帳に記録する。
5. 出力が `go retry_agent_id=<ID> model=gpt-6.1-terra` なら、起動の前に準備する。新しい `agents/<ID>/` に `scratch/`・`artifacts/` を作り、止まった Worker に渡した依頼文の agent ID・`scratch/`・`artifacts/` のパス・昇格の許可リストだけを新しい ID のものに替える（ほかは変えない）。hunter なら台帳の `in_progress` の監査単位の `agent_id` を新しい ID に替えてバリデーターを通す。準備に失敗したら起動せず、保留にしてから `FALLBACK end "$RUN_DIR" <ID> failed` を実行する。
6. `spawn_agent` で起動する。`model` に `gpt-6.1-terra`、`fork_turns` に `"none"` を指定し（親の履歴をすべて引き継ぐ起動ではモデルを指定できない。依頼文は元スキルの決まりで単独で読める）、`reasoning_effort` は渡さない（親の推論レベルを引き継ぐ）。起動できたら、すぐに `FALLBACK started "$RUN_DIR" <ID> <spawn_agent が返した agent_id>` を実行する。この起動は元スキルの予算の1回に数える。起動が、モデルが見つからない・使えないことで失敗したら `unavailable`、ほかの理由で失敗したら `failed` とし、台帳の監査単位を保留の形にしてから `end` で記録する。
7. 結果を待ち、`FALLBACK end "$RUN_DIR" <ID> <結果>` で記録する。保留にする結果（`invalid`・`stopped`・`failed`）は、台帳を保留の形にしてから `end` を実行する（逆の順で止まると、再開時に保留の書き漏れを見つけられない）。終えた Worker も `close_agent` で閉じる。
   - `completed`: 結果を返し、元スキルの検証（構造化結果の検証、台帳とバリデーター）を通って台帳に反映できた。そのあとの Phase 3 の候補検証・Phase 5 の独立検証も元スキルどおりに行い、Terra の結果だけを特別に扱わない。
   - `invalid`: 結果を返したが、元スキルの検証で捨てた（不正な形など）。保留にする。
   - `stopped`: 審査で止まった。保留にする。
   - `failed`: ほかのエラーで止まった。保留にする。
