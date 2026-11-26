#!/usr/bin/env bash
# このリポジトリの Claude Code のスキルを使うのに必要なコマンド・ログイン・リンクがそろっているかを確かめ、
# Markdown で結果と、足りないもののインストール方法を出力する。
# すべてそろっていれば 1 行だけを出す。❌・⚠️ があるときは、表と対処方法を出す。
# Claude が了承を得て実行できるもの（Homebrew でのインストール・リンク）は、&& でつないだ 1 行のコマンドとしても出す。
#
# 使い方: check.sh
#   - 何も変更しない（インストールやログインはしない）
#   - 足りないものがあっても終了コードは 0（スキルの読み込み時に実行するため）
#   - git worktree の中から実行したときは、リンクの向き先のメインの checkout のスキル・エージェントで判定する
set -uo pipefail

repo_root=$(cd -P "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)

has() { command -v "$1" >/dev/null 2>&1; }
ver() { "$@" 2>/dev/null | head -1 | sed 's/|/\\|/g'; }

# メインの checkout か。worktree からは link-skills.sh が断り、判定できないときも worktree かもしれないので、
# どちらもリンクを Claude が実行できるコマンドに入れない
main_checkout=false
main_root=$repo_root
if has git && gd=$(cd "$repo_root" && git rev-parse --git-dir 2>/dev/null) && gcd=$(cd "$repo_root" && git rev-parse --git-common-dir 2>/dev/null); then
  [[ $(cd "$repo_root" && cd -P "$gd" && pwd) == "$(cd "$repo_root" && cd -P "$gcd" && pwd)" ]] && main_checkout=true
  # リンクの向き先は、worktree でもメインの checkout（共通の .git の親）のスキル・エージェント
  main_root=$(cd "$repo_root" && cd -P "$gcd/.." && pwd) || main_root=$repo_root
fi
skills_dir="$main_root/.claude/skills"
agents_src="$main_root/.claude/agents"
link_script="$main_root/scripts/link-skills.sh"
link_dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills"
agents_dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/agents"
link_note=""
$main_checkout || link_note="（git worktree からは実行できないので、メインの checkout で実行する）"

marks=()     # 結果の表の行。状態・項目・詳細・使うスキルを、同じ番号の要素に入れる
items=()
details=()
useds=()
missing=()   # 足りないもの（キー）
warned=0     # 確認が必要なもの（⚠️）の数
fixes=()     # 対処方法の行
formulas=()  # brew install で入れられるもの

# 結果を記録する: add <キー> <状態 ok|ng|warn> <項目> <詳細> <使うスキル> [対処方法]
add() {
  local key=$1 state=$2 item=$3 detail=$4 used_by=$5 fix=${6:-} mark
  case $state in
    ok) mark='✅' ;;
    ng) mark='❌'; missing+=("$key") ;;
    warn) mark='⚠️'; warned=$((warned + 1)) ;;
  esac
  marks+=("$mark"); items+=("$item"); details+=("$detail"); useds+=("$used_by")
  [[ $state == ok || -z $fix ]] || fixes+=("- **$item**: $fix")
}

# 表を出す。「使うスキル」の列は、全行が同じ値なら省く
print_table() {
  local i same=true
  for i in "${!useds[@]}"; do
    [[ ${useds[i]} == "${useds[0]}" ]] || same=false
  done
  if $same; then
    echo "| | 項目 | 状態 |"
    echo "| --- | --- | --- |"
    for i in "${!marks[@]}"; do echo "| ${marks[i]} | ${items[i]} | ${details[i]} |"; done
  else
    echo "| | 項目 | 状態 | 使うスキル |"
    echo "| --- | --- | --- | --- |"
    for i in "${!marks[@]}"; do echo "| ${marks[i]} | ${items[i]} | ${details[i]} | ${useds[i]} |"; done
  fi
}

# --- コマンド -----------------------------------------------------------------

# check_cmd <コマンド> <使うスキル> <インストール方法> <Homebrew のパッケージ> [バージョンを出すコマンド...]
check_cmd() {
  local cmd=$1 used_by=$2 fix=$3 pkg=$4
  shift 4
  if has "$cmd"; then
    local v=""
    (($# > 0)) && v=$(ver "$@")
    add "$cmd" ok "\`$cmd\`" "${v:-$(command -v "$cmd")}" "$used_by"
  else
    add "$cmd" ng "\`$cmd\`" "見つかりません" "$used_by" "$fix"
    formulas+=("$pkg")
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
if ((${#formulas[@]} > 0)) && ! has brew; then
  need_brew=true
  add homebrew warn 'Homebrew' '見つかりません' 'インストールに使う'
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
    "\`$link_script --claude\`${link_note}（初めて \`~/.claude/agents\` を作ったときは、新しいセッションで使う）"
fi

# --- 監査するプロジェクトから使うためのリンク ------------------------------
# security-audit-verify-items は hook の guard.sh もこのリンクから呼ぶので、その未リンクは ❌（使えない）にする

unlinked=()
for skill in "$skills_dir"/*/; do
  skill=${skill%/}
  name=$(basename "$skill")
  [[ -f $skill/SKILL.md ]] || continue
  [[ -L $link_dir/$name && $(readlink "$link_dir/$name") == "$skill" ]] || unlinked+=("$name")
done
verify_items_unlinked=false
[[ -L $link_dir/$verify_items && $(readlink "$link_dir/$verify_items") == "$skills_dir/$verify_items" ]] || verify_items_unlinked=true
if $verify_items_unlinked; then
  add links ng "\`~/.claude/skills\` へのリンク" "未リンク: ${unlinked[*]:-$verify_items}" \
    "監査するプロジェクトで使うとき（$verify_items は hook の guard.sh にも必要）" "\`$link_script --claude\`${link_note}"
elif ((${#unlinked[@]} > 0)); then
  add links warn "\`~/.claude/skills\` へのリンク" "未リンク: ${unlinked[*]}" "監査するプロジェクトで使うとき" "\`$link_script\`${link_note}"
else
  add links ok "\`~/.claude/skills\` へのリンク" "すべてリンク済み" "監査するプロジェクトで使うとき"
fi

# --- スキルごとの使える / 使えない ---------------------------------------------

skill_needs() {
  case $1 in
    security-audit-verify-items) echo "git gh gh-login node jq perl agents-link links" ;;
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

if ((${#missing[@]} + warned == 0)); then
  echo "✅ すべての前提を満たしています（${#marks[@]} 項目）"
  exit 0
fi

if ((${#missing[@]} > 0)); then
  echo "**足りないものが ${#missing[@]} 件あります。** 下の「対処方法」を実行してください。"
else
  echo "**確認が必要なものが ${warned} 件あります。** 下の「対処方法」を実行してください。"
fi
echo
print_table
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
if ! $need_brew && ((${#formulas[@]} > 0)); then
  auto+=("brew install ${formulas[*]}")
  notes+=("- \`brew install ${formulas[*]}\`: Homebrew で ${formulas[*]} を入れる")
fi
for m in ${missing[@]+"${missing[@]}"}; do
  if [[ $m == agents-link || $m == links ]] && $main_checkout; then
    printf -v link_cmd 'bash %q --claude' "$link_script"
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
