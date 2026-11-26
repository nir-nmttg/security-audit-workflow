#!/usr/bin/env bash
# check.sh（Codex 版）のテスト。HOME は存在しないフォルダにして配置を未配置に見せ、
# 定義の確認と worktree の判定は、コマンドの答えを差し替えて確かめる。ファイルは作らない。
#   bash check.test.sh
set -uo pipefail

dir=$(cd -P "$(dirname "$0")" && pwd)
check=$dir/check.sh
repo_root=$(cd -P "$dir/../../../.." && pwd)
fails=0

ok() { echo "ok - $1"; }
ng() { echo "not ok - $1"; fails=$((fails + 1)); }

# ホームフォルダがない状態にして、Cloudflare の security-audit・保存先・リンクを未配置に見せる
export HOME=/nonexistent/security-audit-preflight-test/home

# with_git <git-dir の答え> <git-common-dir の答え>: git の答えを差し替えて check.sh を実行する
# （関数を先に定義してから、引数なしで source する。引数があると check.sh は使い方を出して止まる）
with_git() {
  CHECK_PATH=$check GIT_DIR_ANSWER=$1 GIT_COMMON_ANSWER=$2 bash -c '
    git() {
      case "$*" in
        *"--git-dir"*) echo "$GIT_DIR_ANSWER" ;;
        *"--git-common-dir"*) echo "$GIT_COMMON_ANSWER" ;;
        *) command git "$@" ;;
      esac
    }
    set --
    source "$CHECK_PATH"
  '
}

out=$(bash "$check")
code=$?
[[ $code == 0 ]] && ok "終了コードは 0" || ng "終了コードは 0（$code）"
grep -q '^\*\*足りないものが [0-9]* 件あります。\*\*' <<<"$out" && ok "❌ があると見出しを出す" || ng "❌ があると見出しを出す"
grep -qxF '| | 項目 | 状態 | 使うスキル |' <<<"$out" && ok "表の形を Claude 版と同じにする" || ng "表の形を Claude 版と同じにする"
grep -qF '| ❌ | Cloudflare `security-audit` |' <<<"$out" && ok "Cloudflare の security-audit がなければ ❌" || ng "Cloudflare の security-audit がなければ ❌"
grep -qF '| ❌ | 監査結果の保存先 |' <<<"$out" && ok "保存先に書けなければ ❌" || ng "保存先に書けなければ ❌"
grep -q '✅ すべての前提を満たしています' <<<"$out" && ng "❌ があるときは 1 行にしない" || ok "❌ があるときは 1 行にしない"
grep -qxF '## 対処方法' <<<"$out" && ok "対処方法を出す" || ng "対処方法を出す"

bash "$check" extra >/dev/null 2>&1
[[ $? == 2 ]] && ok "引数があれば終了コード 2" || ng "引数があれば終了コード 2"

out=$(CHECK_PATH=$check bash -c '
  sed() { if [[ $1 == -n && $2 == "s/^name:"* ]]; then echo "name: wrong"; else command sed "$@"; fi; }
  set --
  source "$CHECK_PATH"
')
grep -qF '| ❌ | `security-audit-preflight` の定義 | name（name: wrong）がフォルダ名と違う |' <<<"$out" && ok "name がフォルダ名と違えば ❌" || ng "name がフォルダ名と違えば ❌"

out=$(CHECK_PATH=$check bash -c '
  grep() { if [[ $1 == -o ]]; then echo "](references/nope.md)"; else command grep "$@"; fi; }
  set --
  source "$CHECK_PATH"
')
grep -qF '参照ファイルがない: references/nope.md' <<<"$out" && ok "参照する補助ファイルがなければ ❌" || ng "参照する補助ファイルがなければ ❌"

out=$(with_git "$repo_root/.agents/skills" "$repo_root/.agents")
grep -qF "$repo_root/scripts/link-skills.sh --codex" <<<"$out" && ok "worktree でも、リンクの案内はメインの checkout のスクリプトを指す" || ng "worktree でも、リンクの案内はメインの checkout のスクリプトを指す"
grep -qF '（git worktree からは実行できないので、メインの checkout で実行する）' <<<"$out" && ok "worktree では、メインの checkout で実行する旨を添える" || ng "worktree では、メインの checkout で実行する旨を添える"

out=$(with_git "$repo_root/.agents" "$repo_root/.agents")
grep -qF '（git worktree からは実行できないので' <<<"$out" && ng "メインの checkout では worktree の注意を出さない" || ok "メインの checkout では worktree の注意を出さない"

echo "fails: $fails"
[[ $fails == 0 ]]
