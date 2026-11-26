#!/usr/bin/env bash
# security-audit-workflow を origin の既定ブランチまで fast-forward し、Claude Code・Codex へリンクし直して、
# security-audit-preflight の確認結果を Markdown で出力する。確認結果は、そろっていれば 1 行、問題があれば ❌・⚠️ の行だけを出す。
#
# 使い方: update.sh
#   - メインの checkout が既定ブランチ（origin/HEAD、取れなければ main）にいるときだけ、取り込みとリンクを行う
#   - 取り込みは git fetch origin <既定ブランチ> のあと merge --ff-only --no-autostash。
#     未コミットの変更が衝突する・履歴が分かれているときは、作業ツリーを変えずに取り込みを飛ばす
#   - git worktree の中から呼ばれたら、メインの checkout の update.sh に引き継ぐ
#   - 終了コードは常に 0（スキルの読み込み時に実行するため）
set -uo pipefail

# 取り込みで自分自身が書き換わっても、読み込み済みの main を最後まで実行する
main() {
  local repo_root git_dir common_dir main_root target
  repo_root=$(cd -P "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)

  if ! command -v git >/dev/null 2>&1; then
    printf '`git` が見つからないので、取り込みもリンクもしていません。\n\n'
    run_checks "$repo_root"
    return
  fi
  if ! git_dir=$(git -C "$repo_root" rev-parse --path-format=absolute --git-dir 2>/dev/null) ||
    ! common_dir=$(git -C "$repo_root" rev-parse --path-format=absolute --git-common-dir 2>/dev/null); then
    printf '%s を git リポジトリと判定できないので、取り込みもリンクもしていません。\n\n' "$repo_root"
    run_checks "$repo_root"
    return
  fi

  # worktree の中を更新・リンクすると、片付けたときにリンクが切れるので、メインの checkout に任せる
  if [[ $git_dir != "$common_dir" ]]; then
    main_root=$(dirname "$common_dir")
    target="$main_root/.claude/skills/security-audit-skills-update/scripts/update.sh"
    if [[ -z ${SECURITY_AUDIT_SKILLS_UPDATE_FROM_WORKTREE:-} && -f $target ]]; then
      SECURITY_AUDIT_SKILLS_UPDATE_FROM_WORKTREE=1 exec bash "$target"
    fi
    printf 'git worktree の中なので、取り込みもリンクもしていません。メインの checkout（%s）から実行し直してください。\n\n' "$main_root"
    run_checks "$repo_root"
    return
  fi

  local default_branch branch
  default_branch=$(git -C "$repo_root" symbolic-ref --short -q refs/remotes/origin/HEAD 2>/dev/null)
  default_branch=${default_branch#origin/}
  default_branch=${default_branch:-main}
  branch=$(git -C "$repo_root" symbolic-ref --short -q HEAD 2>/dev/null)

  [[ -z ${SECURITY_AUDIT_SKILLS_UPDATE_FROM_WORKTREE:-} ]] || printf 'git worktree から呼ばれたので、メインの checkout（%s）で実行しました。\n\n' "$repo_root"
  if [[ $branch != "$default_branch" ]]; then
    # 作業中のブランチの内容を全プロジェクトにリンクしないよう、リンクも飛ばす
    printf 'メインの checkout（%s）が %s にあり、%s ではないので、取り込みもリンクもしていません。\n\n' "$repo_root" "${branch:-detached HEAD}" "$default_branch"
    printf '%s に戻してから実行し直してください。\n\n' "$default_branch"
  else
    update "$repo_root" "$default_branch"
    echo
    link "$repo_root"
    echo
  fi

  run_checks "$repo_root"
}

# update <repo_root> <既定ブランチ>
update() {
  local repo_root=$1 default_branch=$2 out before after count
  # 鍵のパスフレーズ・ホスト鍵の確認などで入力待ちにならないようにする。
  # ssh の設定がすでにあれば、その後ろにオプションを足す（ssh は同じオプションの最初の値を使うので、利用者の指定が優先される。
  # -o を受け付けないラッパーを設定している場合は取得に失敗し、その旨を表示する）
  local ssh_command
  export GIT_TERMINAL_PROMPT=0
  ssh_command=${GIT_SSH_COMMAND:-$(git -C "$repo_root" config core.sshCommand 2>/dev/null)}
  export GIT_SSH_COMMAND="${ssh_command:-ssh} -o BatchMode=yes -o ConnectTimeout=10"

  if ! out=$(git -C "$repo_root" fetch --quiet origin "+refs/heads/$default_branch:refs/remotes/origin/$default_branch" </dev/null 2>&1); then
    echo "origin から取得できなかったので、手元の $default_branch のままリンクします。"
    code_block "$out"
    return
  fi

  before=$(git -C "$repo_root" rev-parse --short HEAD)
  if ! out=$(git -C "$repo_root" merge --ff-only --no-autostash "origin/$default_branch" </dev/null 2>&1); then
    echo "origin/$default_branch を取り込めなかったので（未コミットの変更との衝突・履歴の分岐など）、手元の $default_branch のままリンクします。"
    code_block "$out"
    return
  fi
  after=$(git -C "$repo_root" rev-parse --short HEAD)

  if [[ $before == "$after" ]]; then
    echo "最新です（${after}）。"
    return
  fi
  count=$(git -C "$repo_root" rev-list --count "$before..$after")
  echo "$before → $after に更新しました（$count 件のコミット）。"
  code_block "$(git -C "$repo_root" log --oneline --no-decorate -20 "$before..$after")"
  ((count <= 20)) || echo "（新しい 20 件だけ表示）"
}

# link <repo_root>
link() {
  local repo_root=$1 script out status changes
  script="$repo_root/scripts/link-skills.sh"
  if [[ ! -f $script ]]; then
    echo "\`scripts/link-skills.sh\` が見つからないので、リンクしていません。"
    return
  fi
  out=$(bash "$script" </dev/null 2>&1)
  status=$?
  if ((status != 0)); then
    echo "リンクに失敗しました（終了コード ${status}）。"
    code_block "$out"
    return
  fi
  changes=$(grep -E '^(added|relinked|removed|skip) ' <<<"$out")
  if [[ -z $changes ]]; then
    echo "変更なし（Claude Code・Codex とも、すべてリンク済み）。"
    return
  fi
  # どちら向けの変更かわかるよう、[Claude Code] などの見出し行も残す
  code_block "$(grep -E '^(\[|(added|relinked|removed|skip) )' <<<"$out")"
  if grep -q '^added ' <<<"$changes"; then
    echo "新しく入ったスキル・サブエージェントは、新しいセッション（Codex は再起動）から使えることがあります。"
  fi
}

# run_checks <repo_root>: security-audit-preflight の確認結果を出す。
# 両方の確認がそろっていれば 1 行、問題があれば ❌・⚠️ の行だけを表の見出しつきで出す。
# 「## 確認結果」は最後の節にする（SKILL.md がこの見出しの有無で取り直しを判断する）
run_checks() {
  local repo_root=$1 claude_out claude_status codex_out codex_status
  run_check "$repo_root/.claude/skills/security-audit-preflight/scripts/check.sh"
  claude_out=$CHECK_OUT
  claude_status=$CHECK_STATUS
  run_check "$repo_root/.agents/skills/security-audit-preflight/scripts/check.sh"
  codex_out=$CHECK_OUT
  codex_status=$CHECK_STATUS

  echo "## 確認結果"
  echo
  if [[ $claude_status == 0 && $codex_status == 0 ]] && is_all_ok "$claude_out" && is_all_ok "$codex_out"; then
    echo "✅ Claude Code・Codex とも、すべての前提を満たしています"
    echo
    return
  fi
  check_section "Claude Code" "$claude_status" "$claude_out"
  check_section "Codex" "$codex_status" "$codex_out"
  echo "スキルごとの利用可否は、Codex から \`\$security-audit-preflight\` で確かめてください。"
  echo
}

# run_check <check.sh>: 確認スクリプトを実行し、結果を CHECK_OUT・CHECK_STATUS に入れる（なければ CHECK_STATUS=missing）
run_check() {
  if [[ ! -f $1 ]]; then
    CHECK_OUT=''
    CHECK_STATUS=missing
    return
  fi
  CHECK_OUT=$(bash "$1" </dev/null 2>&1)
  CHECK_STATUS=$?
}

# check_section <見出し> <終了コード> <出力>: 問題の行を出す。そろっていれば 1 行、想定外の出力はそのまま出す
check_section() {
  local label=$1 status=$2 out=$3 table
  echo "### $label"
  echo
  if [[ $status == missing ]]; then
    echo "確認スクリプトが見つかりません。"
  elif table=$(problem_table "$out"); then
    echo "$table"
  elif is_all_ok "$out"; then
    echo "$out"
  elif [[ -n $out ]]; then
    # 想定外の出力は省かずに出す。「## 確認結果」を最後の節に保つため、見出しは下げる
    LC_ALL=C sed 's/^## /#### /' <<<"$out"
  else
    echo "（出力がありません）"
  fi
  if [[ $status != missing && $status != 0 ]]; then
    echo "（確認スクリプトが終了コード $status で終わりました）"
  fi
  echo
}

# problem_table <出力>: 表の見出しと区切り、❌・⚠️ の行を出す。問題の行がなければ何も出さずに終わる
problem_table() {
  local line head=() rows=()
  while IFS= read -r line; do
    case $line in
      '| ❌ '*|'| ⚠️ '*) rows+=("$line") ;;
      '| ✅ '*) ;;
      '| '*) ((${#head[@]} < 2)) && head+=("$line") ;;
    esac
  done <<<"$1"
  ((${#rows[@]} > 0)) || return 1
  if ((${#head[@]} > 0)); then printf '%s\n' "${head[@]}"; fi
  printf '%s\n' "${rows[@]}"
}

# is_all_ok <出力>: すべてそろっているときの 1 行か
is_all_ok() {
  [[ $1 == '✅ すべての前提を満たしています（'*'項目）' ]]
}

# code_block <text>
code_block() {
  [[ -n $1 ]] || return 0
  echo '```text'
  echo "$1"
  echo '```'
}

main "$@"; exit 0
