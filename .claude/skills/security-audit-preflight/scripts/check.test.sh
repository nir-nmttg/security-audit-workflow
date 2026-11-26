#!/usr/bin/env bash
# check.sh（Claude 版）のテスト。リンクは存在しないフォルダを見せて決め、worktree かどうかは git の答えを差し替えて決める。
# ファイルは作らず、ユーザーのリンクや GitHub のログイン状態にも依らない。
#   bash check.test.sh
set -uo pipefail

dir=$(cd -P "$(dirname "$0")" && pwd)
check=$dir/check.sh
repo_root=$(cd -P "$dir/../../../.." && pwd)
fails=0

ok() { echo "ok - $1"; }
ng() { echo "not ok - $1"; fails=$((fails + 1)); }

# リンクが 1 つもない設定フォルダを使う（存在しないパス）
export CLAUDE_CONFIG_DIR=/nonexistent/security-audit-preflight-test/claude

# with_git <git-dir の答え> <git-common-dir の答え>: git の答えを差し替えて check.sh を実行する
# （関数を先に定義してから、引数なしで source する）
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
grep -qxF '| | 項目 | 状態 | 使うスキル |' <<<"$out" && ok "使うスキルの列は、値が違うので残す" || ng "使うスキルの列は、値が違うので残す"
grep -qF '| ❌ | `~/.claude/agents` へのリンク |' <<<"$out" && ok "サブエージェントのリンクがなければ ❌" || ng "サブエージェントのリンクがなければ ❌"
[[ $(grep -cF '`~/.claude/skills` へのリンク |' <<<"$out") == 1 ]] && ok "スキルのリンクは 1 行にまとめる" || ng "スキルのリンクは 1 行にまとめる"
grep -qF 'security-audit-verify-items` のリンク' <<<"$out" && ng "verify-items のリンクを別の行にしない" || ok "verify-items のリンクを別の行にしない"
grep -qxF '## 対処方法' <<<"$out" && ok "対処方法を出す" || ng "対処方法を出す"

out=$(with_git "$repo_root/.claude/skills" "$repo_root/.claude")
grep -qF '（git worktree からは実行できないので、メインの checkout で実行する）' <<<"$out" && ok "worktree では、メインの checkout で実行する旨を添える" || ng "worktree では、メインの checkout で実行する旨を添える"
grep -qF "$repo_root/scripts/link-skills.sh --claude" <<<"$out" && ok "worktree でも、リンクの案内はメインの checkout のスクリプトを指す" || ng "worktree でも、リンクの案内はメインの checkout のスクリプトを指す"
grep -qxF '## Claude が実行できるコマンド' <<<"$out" && ng "worktree では実行するコマンドを出さない" || ok "worktree では実行するコマンドを出さない"

out=$(with_git "$repo_root/.claude" "$repo_root/.claude")
grep -qF '（git worktree からは実行できないので' <<<"$out" && ng "メインの checkout では worktree の注意を出さない" || ok "メインの checkout では worktree の注意を出さない"
grep -qxF '## Claude が実行できるコマンド' <<<"$out" && ok "メインの checkout では実行するコマンドを出す" || ng "メインの checkout では実行するコマンドを出す"
grep -qF "bash $repo_root/scripts/link-skills.sh --claude" <<<"$out" && ok "実行するコマンドはメインの checkout のスクリプト" || ng "実行するコマンドはメインの checkout のスクリプト"

echo "fails: $fails"
[[ $fails == 0 ]]
