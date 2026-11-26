#!/usr/bin/env bash
# update.sh のテスト。git の答えを差し替え、リンク（link-skills.sh）は実行せずに、出力の組み立てと見出しを確かめる。
# ファイルは作らない。REAL_CHECKS=1 のときだけ、確認スクリプトを実際に実行する。
#   bash update.test.sh
set -uo pipefail

dir=$(cd -P "$(dirname "$0")" && pwd)
src=$dir/update.sh
repo_root=$(cd -P "$dir/../../../.." && pwd)
fails=0

ok() { echo "ok - $1"; }
ng() { echo "not ok - $1"; fails=$((fails + 1)); }

# load: update.sh の関数だけを読み込む（最後の main の呼び出しは外し、BASH_SOURCE は update.sh のパスに置き換える）
load() {
  local body
  body=$(sed '$d' "$src")
  body=${body//'${BASH_SOURCE[0]}'/$src}
  eval "$body"
}

# fake_git: git の答えを差し替える（既定ブランチの main にいて、取り込みは成功し、版は変わらない）
fake_git() {
  case "$*" in
    *"--git-dir"*) echo "${GIT_DIR_ANSWER:-/x/.git}" ;;
    *"--git-common-dir"*) echo "/x/.git" ;;
    *"refs/remotes/origin/HEAD"*) echo "origin/main" ;;
    *"symbolic-ref --short -q HEAD"*) echo "${BRANCH_ANSWER:-main}" ;;
    *" fetch "*)
      if [[ -n ${FETCH_FAIL:-} ]]; then
        echo "fatal: unable to access 'https://example.invalid/'"
        return 1
      fi
      ;;
    *" merge "*) ;;
    *"rev-parse --short HEAD"*) echo "74399af" ;;
    *) return 1 ;;
  esac
}

# run_main: main を実行する。git は fake_git、リンクは link の差し替え（link-skills.sh は実行しない）。
# 確認スクリプトは、そろっている答えに差し替える（REAL_CHECKS=1 のときは実際に実行する）
run_main() {
  (
    load
    git() { fake_git "$@"; }
    link() { echo "${LINK_ANSWER:-変更なし（Claude Code・Codex とも、すべてリンク済み）。}"; }
    if [[ -z ${REAL_CHECKS:-} ]]; then
      run_check() {
        CHECK_OUT='✅ すべての前提を満たしています（8 項目）'
        CHECK_STATUS=0
      }
    fi
    main
  )
}

# call <関数> <引数...>: update.sh の関数を単独で呼ぶ
call() {
  (
    load
    "$@"
  )
}

# checks: run_checks を、確認スクリプトの答えを差し替えて実行する（CLAUDE_OUT・CLAUDE_ST・CODEX_OUT・CODEX_ST）
checks() {
  (
    load
    run_check() {
      if [[ $1 == *"/.claude/skills/security-audit-preflight/"* ]]; then  # リポジトリが .claude/worktrees の下にあっても見分ける
        CHECK_OUT=$CLAUDE_OUT CHECK_STATUS=$CLAUDE_ST
      else
        CHECK_OUT=$CODEX_OUT CHECK_STATUS=$CODEX_ST
      fi
    }
    run_checks "$repo_root"
  )
}

last_h2() { grep '^## ' <<<"$1" | tail -n 1; }

# --- 最新で変更がないとき ---------------------------------------------------

out=$(run_main)
grep -qxF '最新です（74399af）。' <<<"$out" && ok "最新のときは取り込みの結果を 1 行で出す" || ng "最新のときは取り込みの結果を 1 行で出す"
grep -qxF '変更なし（Claude Code・Codex とも、すべてリンク済み）。' <<<"$out" && ok "リンクに変更がないときは 1 行で出す" || ng "リンクに変更がないときは 1 行で出す"
grep -qxF '✅ Claude Code・Codex とも、すべての前提を満たしています' <<<"$out" && ok "確認がそろっていれば 1 行で出す" || ng "確認がそろっていれば 1 行で出す"
[[ $(last_h2 "$out") == '## 確認結果' ]] && ok "確認結果を最後の節にする" || ng "確認結果を最後の節にする"
grep -qE '^## (更新|リンク|実行結果)$' <<<"$out" && ng "更新・リンクの見出しを出さない" || ok "更新・リンクの見出しを出さない"

# --- 失敗は必ず出す ----------------------------------------------------------

out=$(FETCH_FAIL=1 run_main)
grep -qxF 'origin から取得できなかったので、手元の main のままリンクします。' <<<"$out" && ok "取り込みの失敗を文章で出す" || ng "取り込みの失敗を文章で出す"
grep -qF "fatal: unable to access 'https://example.invalid/'" <<<"$out" && ok "取り込みの失敗の理由を出す" || ng "取り込みの失敗の理由を出す"

out=$(BRANCH_ANSWER=feature run_main)
grep -qF 'ではないので、取り込みもリンクもしていません。' <<<"$out" && ok "既定ブランチでないときは、取り込みもリンクもしない旨を出す" || ng "既定ブランチでないときは、取り込みもリンクもしない旨を出す"
grep -q '最新です' <<<"$out" && ng "既定ブランチでなければ取り込みの結果を出さない" || ok "既定ブランチでなければ取り込みの結果を出さない"

out=$(GIT_DIR_ANSWER=/x/.git/worktrees/w SECURITY_AUDIT_SKILLS_UPDATE_FROM_WORKTREE=1 run_main)
grep -qF 'git worktree の中なので、取り込みもリンクもしていません。' <<<"$out" && ok "worktree の中では、取り込みもリンクもしない旨を出す" || ng "worktree の中では、取り込みもリンクもしない旨を出す"
[[ $(last_h2 "$out") == '## 確認結果' ]] && ok "worktree の中でも確認結果を最後の節にする" || ng "worktree の中でも確認結果を最後の節にする"

# --- 確認結果の組み立て ------------------------------------------------------

ok_line='✅ すべての前提を満たしています（8 項目）'
out=$(CLAUDE_OUT=$ok_line CLAUDE_ST=0 CODEX_OUT=$ok_line CODEX_ST=0 checks)
grep -qxF '✅ Claude Code・Codex とも、すべての前提を満たしています' <<<"$out" && ! grep -q '^### ' <<<"$out" && ok "両方そろっていれば 1 行にする" || ng "両方そろっていれば 1 行にする"

problem=$'| | 項目 | 状態 | 使うスキル |\n| --- | --- | --- | --- |\n| ✅ | `git` | ok | a |\n| ❌ | `~/.claude/agents` へのリンク | 未リンク | a |\n\n- 使える: x'
out=$(CLAUDE_OUT=$problem CLAUDE_ST=0 CODEX_OUT=$ok_line CODEX_ST=0 checks)
grep -qxF '### Claude Code' <<<"$out" && grep -qxF '| ❌ | `~/.claude/agents` へのリンク | 未リンク | a |' <<<"$out" && ok "Claude Code の問題の行を出す" || ng "Claude Code の問題の行を出す"
grep -qxF '| ✅ | `git` | ok | a |' <<<"$out" && ng "✅ の行は出さない" || ok "✅ の行は出さない"
grep -qxF "$ok_line" <<<"$out" && ok "そろっている Codex は 1 行で出す" || ng "そろっている Codex は 1 行で出す"
[[ $(last_h2 "$out") == '## 確認結果' ]] && ok "問題があるときも確認結果を最後の節にする" || ng "問題があるときも確認結果を最後の節にする"

out=$(CLAUDE_OUT=$ok_line CLAUDE_ST=3 CODEX_OUT=$ok_line CODEX_ST=0 checks)
grep -qxF '（確認スクリプトが終了コード 3 で終わりました）' <<<"$out" && ok "終了コードが 0 以外なら、その旨を出す" || ng "終了コードが 0 以外なら、その旨を出す"

out=$(CLAUDE_OUT= CLAUDE_ST=missing CODEX_OUT=$ok_line CODEX_ST=0 checks)
grep -qxF '確認スクリプトが見つかりません。' <<<"$out" && ok "確認スクリプトがなければ、その旨を出す" || ng "確認スクリプトがなければ、その旨を出す"

out=$(CLAUDE_OUT=$'## 想定外の見出し\n本文' CLAUDE_ST=0 CODEX_OUT=$ok_line CODEX_ST=0 checks)
grep -qxF '#### 想定外の見出し' <<<"$out" && [[ $(last_h2 "$out") == '## 確認結果' ]] && ok "想定外の出力は省かず、見出しを下げて最後の節を保つ" || ng "想定外の出力は省かず、見出しを下げて最後の節を保つ"

# --- 問題の行の抜き出し ------------------------------------------------------

sample=$(printf '%s\n' \
  '**足りないものが 2 件あります。**' '' \
  '| | 項目 | 状態 | 使うスキル |' '| --- | --- | --- | --- |' \
  '| ✅ | `git` | ok | a |' \
  '| ⚠️ | `~/.agents/skills/x` のリンク | 未リンク | b |' \
  '| ❌ | `gh` | 見つかりません | a |' '' \
  '- 使える: x' '' '## 対処方法' '' '- **gh**: 手順')
rows=$(call problem_table "$sample")
if grep -qxF '| | 項目 | 状態 | 使うスキル |' <<<"$rows" && grep -qxF '| --- | --- | --- | --- |' <<<"$rows"; then
  ok "問題の行は表の見出しと区切りつきで出す"
else
  ng "問題の行は表の見出しと区切りつきで出す"
fi
if grep -qxF '| ⚠️ | `~/.agents/skills/x` のリンク | 未リンク | b |' <<<"$rows" && grep -qxF '| ❌ | `gh` | 見つかりません | a |' <<<"$rows"; then
  ok "❌ と ⚠️ の行を出す"
else
  ng "❌ と ⚠️ の行を出す"
fi
grep -qF '✅' <<<"$rows" && ng "✅ の行は出さない" || ok "✅ の行は出さない"
grep -qF '対処方法' <<<"$rows" && ng "対処方法などの注記は出さない" || ok "対処方法などの注記は出さない"
if call problem_table "$ok_line" >/dev/null; then
  ng "問題がなければ何も出さない"
else
  ok "問題がなければ何も出さない"
fi

if call is_all_ok "$ok_line"; then ok "そろっている 1 行を見分ける"; else ng "そろっている 1 行を見分ける"; fi
if call is_all_ok "$sample"; then ng "表はそろっている 1 行と見分ける"; else ok "表はそろっている 1 行と見分ける"; fi

# --- 実際の確認スクリプト（存在しないリンク先を見せて、問題の行が出ることを確かめる） ---

out=$(REAL_CHECKS=1 CLAUDE_CONFIG_DIR=/nonexistent/security-audit-skills-update-test/claude run_main)
grep -qxF '### Claude Code' <<<"$out" && grep -qF '| ❌ | `~/.claude/agents` へのリンク |' <<<"$out" && ok "実際の確認で問題があれば、その行を出す" || ng "実際の確認で問題があれば、その行を出す"
[[ $(last_h2 "$out") == '## 確認結果' ]] && ok "実際の確認の結果でも確認結果を最後の節にする" || ng "実際の確認の結果でも確認結果を最後の節にする"

echo "fails: $fails"
[[ $fails == 0 ]]
