#!/usr/bin/env bash
# このリポジトリの Claude Code のスキルを使うのに必要なコマンド・ログイン・リンクがそろっているかを確かめ、
# Markdown で結果と、足りないもののインストール方法を出力する。
# Claude が了承を得て実行できるもの（Homebrew でのインストール・リンク）は、&& でつないだ 1 行のコマンドとしても出す。
#
# 使い方: check.sh
#   - 何も変更しない（インストールやログインはしない）
#   - 足りないものがあっても終了コードは 0（スキルの読み込み時に実行するため）
set -uo pipefail

repo_root=$(cd -P "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)
skills_dir="$repo_root/.claude/skills"
link_dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills"

has() { command -v "$1" >/dev/null 2>&1; }
ver() { "$@" 2>/dev/null | head -1 | sed 's/|/\\|/g'; }

# メインの checkout か。worktree からは link-skills.sh が断り、判定できないときも worktree かもしれないので、
# どちらもリンクを Claude が実行できるコマンドに入れない
main_checkout=false
if has git && gd=$(cd "$repo_root" && git rev-parse --git-dir 2>/dev/null) && gcd=$(cd "$repo_root" && git rev-parse --git-common-dir 2>/dev/null); then
  [[ $(cd "$repo_root" && cd -P "$gd" && pwd) == "$(cd "$repo_root" && cd -P "$gcd" && pwd)" ]] && main_checkout=true
fi
link_note=""
$main_checkout || link_note="（git worktree からは実行できないので、メインの checkout で実行する）"

rows=()      # 結果の表の行
missing=()   # 足りないもの（キー）
fixes=()     # 対処方法の行
formulas=()  # brew install で入れられるもの
casks=()     # brew install --cask で入れられるもの

# 結果を記録する: add <キー> <状態 ok|ng|warn> <項目> <詳細> <使うスキル> [対処方法]
add() {
  local key=$1 state=$2 item=$3 detail=$4 used_by=$5 fix=${6:-}
  local mark
  case $state in
    ok) mark='✅' ;;
    ng) mark='❌'; missing+=("$key") ;;
    warn) mark='⚠️' ;;
  esac
  rows+=("| $mark | $item | $detail | $used_by |")
  [[ $state == ok || -z $fix ]] || fixes+=("- **$item**: $fix")
}

# --- コマンド -----------------------------------------------------------------

# check_cmd <コマンド> <使うスキル> <インストール方法> <Homebrew のパッケージ（cask は cask:名前）> [バージョンを出すコマンド...]
check_cmd() {
  local cmd=$1 used_by=$2 fix=$3 pkg=$4
  shift 4
  if has "$cmd"; then
    local v=""
    (($# > 0)) && v=$(ver "$@")
    add "$cmd" ok "\`$cmd\`" "${v:-$(command -v "$cmd")}" "$used_by"
  else
    add "$cmd" ng "\`$cmd\`" "見つかりません" "$used_by" "$fix"
    case $pkg in
      cask:*) casks+=("${pkg#cask:}") ;;
      *) formulas+=("$pkg") ;;
    esac
  fi
}

verify_items="security-audit-verify-items"

check_cmd git "$verify_items" "\`xcode-select --install\`（または \`brew install git\`）" git git --version
check_cmd jq "$verify_items" "\`brew install jq\`" jq jq --version
check_cmd perl "$verify_items" "\`brew install perl\`（macOS には標準で入っている）" perl perl -e 'print "perl $^V\n"'
check_cmd gh "$verify_items" "\`brew install gh\` のあと \`gh auth login\`" gh gh --version
check_cmd node "$verify_items" "\`brew install node\`" node node --version

# インストール方法は Homebrew 前提なので、足りないコマンドがあって Homebrew も無ければ先に入れてもらう
need_brew=false
if ((${#formulas[@]} + ${#casks[@]} > 0)) && ! has brew; then
  need_brew=true
  rows+=("| ⚠️ | Homebrew | 見つかりません | インストールに使う |")
fi

# --- ログイン -----------------------------------------------------------------

if has gh; then
  if gh auth status >/dev/null 2>&1; then
    user=$(gh api user --jq .login 2>/dev/null || true)
    add gh-login ok "GitHub（gh）のログイン" "${user:+@$user}" "$verify_items"
  else
    add gh-login ng "GitHub（gh）のログイン" "未ログイン" "$verify_items" "\`gh auth login\`"
  fi
fi

# --- サブエージェントとスキルのリンク（security-audit-verify-items に必須） ---------

agents_src="$repo_root/.claude/agents"
agents_dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/agents"
unlinked_agents=()
for f in "$agents_src"/*.md; do
  [[ -f $f ]] || continue
  name=$(basename "$f")
  [[ -L $agents_dir/$name && $(readlink "$agents_dir/$name") == "$f" ]] || unlinked_agents+=("${name%.md}")
done
if ((${#unlinked_agents[@]} == 0)); then
  add agents-link ok "\`~/.claude/agents\` へのリンク" "すべてリンク済み" "$verify_items"
else
  add agents-link ng "\`~/.claude/agents\` へのリンク" "未リンク: ${unlinked_agents[*]}" "$verify_items" \
    "\`$repo_root/scripts/link-skills.sh --claude\`${link_note}（初めて \`~/.claude/agents\` を作ったときは、新しいセッションで使う）"
fi
# security-audit-item-verifier の hook は、ユーザー用のスキルのリンクから guard.sh を呼ぶ
if [[ -L $link_dir/security-audit-verify-items && $(readlink "$link_dir/security-audit-verify-items") == "$skills_dir/security-audit-verify-items" ]]; then
  add verify-items-link ok "\`~/.claude/skills/security-audit-verify-items\` のリンク" "リンク済み" "security-audit-verify-items（hook の guard.sh）"
else
  add verify-items-link ng "\`~/.claude/skills/security-audit-verify-items\` のリンク" "未リンク" "security-audit-verify-items（hook の guard.sh）" \
    "\`$repo_root/scripts/link-skills.sh --claude\`$link_note"
fi

# --- 監査するプロジェクトから使うためのリンク ------------------------------

unlinked=()
for skill in "$skills_dir"/*/; do
  skill=${skill%/}
  name=$(basename "$skill")
  [[ -f $skill/SKILL.md ]] || continue
  [[ -L $link_dir/$name && $(readlink "$link_dir/$name") == "$skill" ]] || unlinked+=("$name")
done
if ((${#unlinked[@]} == 0)); then
  add links ok "\`~/.claude/skills\` へのリンク" "すべてリンク済み" "監査するプロジェクトで使うとき"
else
  add links warn "\`~/.claude/skills\` へのリンク" "未リンク: ${unlinked[*]}" "監査するプロジェクトで使うとき" \
    "\`$repo_root/scripts/link-skills.sh\`"
fi

# --- スキルごとの使える / 使えない ---------------------------------------------

skill_needs() {
  case $1 in
    security-audit-verify-items) echo "git gh gh-login node jq perl agents-link verify-items-link" ;;
    *) echo "" ;;
  esac
}

ready=()
blocked=()
for skill in "$skills_dir"/*/; do
  name=$(basename "$skill")
  [[ -f $skill/SKILL.md ]] || continue
  lack=()
  for need in $(skill_needs "$name"); do
    for m in ${missing[@]+"${missing[@]}"}; do
      [[ $m == "$need" ]] && lack+=("$need")
    done
  done
  if ((${#lack[@]} > 0)); then
    blocked+=("${name}（${lack[*]}）")
  else
    ready+=("$name")
  fi
done

# --- 出力 ---------------------------------------------------------------------

if ((${#missing[@]} == 0)); then
  echo "**すべてそろっています。** このリポジトリの Claude Code のスキルはすべて使えます。"
else
  echo "**足りないものが ${#missing[@]} 件あります。** 下の「対処方法」を実行してください。"
fi
echo
echo "| | 項目 | 状態 | 使うスキル |"
echo "| --- | --- | --- | --- |"
printf '%s\n' "${rows[@]}"
echo
echo "- 使える: ${ready[*]:-なし}"
((${#blocked[@]} == 0)) || echo "- 使えない: ${blocked[*]}"
echo "- 組み込みブラウザ（Claude デスクトップアプリ）がないと、security-audit-verify-items で画面での裏付けができない（このスクリプトでは確かめない）"
if ((${#fixes[@]} > 0)); then
  echo
  echo "## 対処方法"
  echo
  ! $need_brew || echo '- **Homebrew**: 先に `/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"` で入れる（https://brew.sh の手順。パスワードの入力が要る）'
  printf '%s\n' "${fixes[@]}"
fi

# Claude が了承を得て実行できるもの。&& でつないだ 1 行にし、途中で失敗したら止める。
# Homebrew がなければインストールは出さない（先に入れてもらう）
auto=() notes=()
if ! $need_brew; then
  if ((${#formulas[@]} > 0)); then
    auto+=("brew install ${formulas[*]}")
    notes+=("- \`brew install ${formulas[*]}\`: Homebrew で ${formulas[*]} を入れる")
  fi
  if ((${#casks[@]} > 0)); then
    auto+=("brew install --cask ${casks[*]}")
    notes+=("- \`brew install --cask ${casks[*]}\`: Homebrew で ${casks[*]} を入れる")
  fi
fi
for m in ${missing[@]+"${missing[@]}"}; do
  if [[ $m == agents-link || $m == verify-items-link ]] && $main_checkout; then
    printf -v link_cmd 'bash %q --claude' "$repo_root/scripts/link-skills.sh"
    auto+=("$link_cmd")
    notes+=("- \`link-skills.sh --claude\`: このリポジトリの Claude Code のスキルとサブエージェントを \`~/.claude/\` にリンクする（サブエージェントは新しいセッションから使える）")
    break
  fi
done
if ((${#auto[@]} > 0)); then
  echo
  echo "## Claude が実行できるコマンド"
  echo
  printf '%s\n' "${notes[@]}"
  echo
  echo '```bash'
  joined=${auto[0]}
  for c in "${auto[@]:1}"; do joined+=" && $c"; done
  echo "$joined"
  echo '```'
fi
exit 0
