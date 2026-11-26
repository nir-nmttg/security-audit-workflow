#!/usr/bin/env bash
# prepare.sh・guard.sh・cleanup.sh のテスト。一時的なリポジトリで実行フォルダを作り、終わったら消す。
#   bash scripts.test.sh
set -uo pipefail

dir=$(cd -P "$(dirname "$0")" && pwd)
tmp=$(mktemp -d)
fails=0
runs=()
cleanup() {
  for r in "${runs[@]}"; do bash "$dir/cleanup.sh" "$r" >/dev/null 2>&1; rm -rf "$r"; done
  rm -rf "$tmp"
}
trap cleanup EXIT

ok() { echo "ok - $1"; }
ng() { echo "not ok - $1"; fails=$((fails + 1)); }

# 対象リポジトリとサブエージェントのリンクを用意する
repo=$tmp/repo
git init -q "$repo"
mkdir -p "$repo/app" "$repo/sub"
echo "x" >"$repo/app/a.rb"
printf '.env*\nnode_modules/\n' >"$repo/.gitignore"
git -C "$repo" add .
git -C "$repo" -c user.email=t@example.com -c user.name=t commit -q -m init
sha=$(git -C "$repo" rev-parse HEAD)
echo "KEY=secretvalue1" >"$repo/.env"
echo "KEY=secretvalue2" >"$repo/sub/.env.local"
echo "KEY=secretvalue3" >"$repo/.env.unignored-test"
printf '.env*\n!.env.unignored-test\nnode_modules/\n' >"$repo/.gitignore"
# 入れ子の作業ツリーの .env.sample は写さない（.git というファイルか、フォルダを持つ。ファイルは先の gitdir が消えたもの）
mkdir -p "$repo/tmp/wt-1" && echo "gitdir: $tmp/gone/.git/worktrees/wt-1" >"$repo/tmp/wt-1/.git" && echo "KEY=nested1" >"$repo/tmp/wt-1/.env.sample"
git init -q "$repo/tmp/wt-2" && echo "KEY=nested2" >"$repo/tmp/wt-2/.env.sample"
export CLAUDE_CONFIG_DIR=$tmp/claude
mkdir -p "$CLAUDE_CONFIG_DIR/agents" "$CLAUDE_CONFIG_DIR/skills"
touch "$CLAUDE_CONFIG_DIR/agents/security-audit-item-verifier.md"
ln -s "$(cd -P "$dir/.." && pwd)" "$CLAUDE_CONFIG_DIR/skills/security-audit-verify-items"

out=$(bash "$dir/prepare.sh" "$repo" "$sha") && ok "prepare.sh が成功する" || ng "prepare.sh が成功する: $out"
run=$(sed -n 's/^run //p' <<<"$out")
runs+=("$run")
[[ -f $run/worktree/app/a.rb && -d $run/items && -d $run/ledger && -d $run/issues ]] && ok "作業ツリーとフォルダができる" || ng "作業ツリーとフォルダができる"
[[ -f $run/refs/issue-templates.md && -f $run/refs/issue-sync.md ]] && ok "書式と反映の規則を写す" || ng "書式と反映の規則を写す"
[[ -f $run/refs/fix-issues.md ]] && ok "修正 Issue の反映の規則も写す" || ng "修正 Issue の反映の規則も写す"
[[ -f $run/worktree/.env && -f $run/worktree/sub/.env.local ]] && [[ -f $run/worktree/.env.unignored-test ]] && grep -q '^env_copied 3$' <<<"$out" && ok ".env* をコピーする（無視されていないものも）" || ng ".env* をコピーする: $out"
[[ ! -e $run/worktree/tmp/wt-1/.env.sample && ! -e $run/worktree/tmp/wt-2/.env.sample ]] && ok "入れ子の作業ツリーの .env* は写さない" || ng "入れ子の作業ツリーの .env* は写さない"
grep -q secretvalue <<<"$out" && ng "値を出力しない" || ok "値を出力しない"

hook() { jq -n --arg t "$1" --argjson i "$2" '{tool_name:$t, tool_input:$i, cwd:"/"}' | bash "$dir/guard.sh" 2>/dev/null; }
expect() { # expect <0|2> <説明> <ツール> <入力の JSON>
  hook "$3" "$4"
  local code=$?
  [[ $code == "$1" ]] && ok "$2" || ng "$2（終了コード $code）"
}
expect 0 "作業ツリーの中は読める" Read "{\"file_path\":\"$run/worktree/app/a.rb\"}"
expect 2 "対象リポジトリ（メインの checkout）は読めない" Read "{\"file_path\":\"$repo/app/a.rb\"}"
expect 0 "Grep は実行フォルダの中なら通す" Grep "{\"pattern\":\"x\",\"path\":\"$run/worktree\"}"
expect 2 "Grep の path の省略は止める" Grep '{"pattern":"x"}'
expect 0 "items/ には書ける" Write "{\"file_path\":\"$run/items/A03.json\",\"content\":\"{}\"}"
expect 2 "ledger/ には書けない" Write "{\"file_path\":\"$run/ledger/run.json\",\"content\":\"{}\"}"
expect 2 "作業ツリーには書けない" Write "{\"file_path\":\"$run/worktree/app/a.rb\",\"content\":\"y\"}"
expect 0 "実行フォルダへの cd で始まる Bash は通す" Bash "{\"command\":\"cd $run/worktree && git log --oneline -1\"}"
expect 2 "cd のない Bash は止める" Bash '{"command":"ls"}'
expect 2 "実行フォルダの外への cd は止める" Bash "{\"command\":\"cd $repo && ls\"}"
expect 2 "gh は止める" Bash "{\"command\":\"cd $run && gh issue view 1\"}"
expect 2 "二重引用符の中のコマンド置換の git commit も止める" Bash "{\"command\":\"cd $run/worktree && echo \\\"\$(git commit -m x)\\\"\"}"
expect 2 "二重引用符の中のバッククォートの git reset も止める" Bash "{\"command\":\"cd $run/worktree && echo \\\"\`git reset --hard\`\\\"\"}"
expect 0 "二重引用符の中のコマンド置換の読み取りだけの git は通す" Bash "{\"command\":\"cd $run/worktree && echo \\\"\$(git rev-parse HEAD)\\\"\"}"
expect 2 "git -c alias.… は止める" Bash "{\"command\":\"cd $run/worktree && git -c alias.x=log x\"}"
expect 2 "コメントのあとの行の git stash も止める" Bash "{\"command\":\"cd $run/worktree && ls # don't need\\ngit stash\"}"
expect 0 "語の途中の # はコメントにしない" Bash "{\"command\":\"cd $run/worktree && git log --format=%h#%s -1\"}"
expect 2 "閉じていない引用符は止める" Bash "{\"command\":\"cd $run/worktree && echo 'x && git checkout .\"}"
expect 2 "入れ子のコマンド置換のあとの git checkout も止める" Bash "{\"command\":\"cd $run/worktree && echo \\\"\$(basename \\\"\$(pwd)\\\")\\\" && git checkout .\"}"
expect 2 "git bisect は止める" Bash "{\"command\":\"cd $run/worktree && git bisect reset\"}"
expect 2 "git add は止める" Bash "{\"command\":\"cd $run/worktree && git add -A\"}"
expect 2 "git stage は止める（一覧にないサブコマンド）" Bash "{\"command\":\"cd $run/worktree && git stage -A\"}"
expect 0 "git show・blame・ls-files は通す" Bash "{\"command\":\"cd $run/worktree && git show HEAD:app/a.rb && git blame app/a.rb && git ls-files\"}"
expect 2 "issue.mjs は止める" Bash "{\"command\":\"cd $run && node /x/scripts/issue.mjs status $run\"}"
expect 2 "状態を変える git は止める" Bash "{\"command\":\"cd $run/worktree && git checkout main\"}"
expect 2 "依存の導入は止める" Bash "{\"command\":\"cd $run/worktree && npm install\"}"
expect 2 "Edit は止める" Edit "{\"file_path\":\"$run/items/a\"}"
expect 2 ".. を含む Write は止める" Write "{\"file_path\":\"$run/items/x/../../ledger/start.json\",\"content\":\"{}\"}"
expect 2 ".. を含む Read は止める" Read "{\"file_path\":\"$run/x/../../../etc/hosts\"}"
expect 2 ".. を含む cd は止める" Bash "{\"command\":\"cd $run/worktree/../.. && ls\"}"
expect 0 "git branch の一覧（--contains）は通す" Bash "{\"command\":\"cd $run/worktree && git branch -a --contains $sha\"}"
expect 0 "git branch -r は通す" Bash "{\"command\":\"cd $run/worktree && git branch -r\"}"
expect 0 "標準エラーを捨てた git branch -r は通す" Bash "{\"command\":\"cd $run/worktree && git branch -r 2>/dev/null\"}"
expect 0 "git branch --list のパターンは通す" Bash "{\"command\":\"cd $run/worktree && git branch -vv --no-color --list 'feat/*'\"}"
expect 0 "パス引数の config は止めない（git diff A B -- config app）" Bash "{\"command\":\"cd $run/worktree && git diff A B -- config app\"}"
expect 0 "引用符の中の日本語を含む git log は通す" Bash "{\"command\":\"cd $run/worktree && git log --format='日本語' -1\"}"
expect 0 "実行フォルダの作業ツリーへの git -C は通す" Bash "{\"command\":\"cd $run && git -C $run/worktree log -1\"}"
expect 0 "cd の先から解決する git -C の相対パスは通す" Bash "{\"command\":\"cd $run && git -C worktree log -1\"}"
expect 2 "git -C で実行フォルダの外（/tmp）を指すのは止める" Bash "{\"command\":\"cd $run/worktree && git -C /tmp log\"}"
expect 2 "git -C の .. は止める" Bash "{\"command\":\"cd $run/worktree && git -C ../.. log\"}"
expect 2 "git -C に展開される形は止める" Bash "{\"command\":\"cd $run/worktree && git -C \$HOME log\"}"
expect 2 "git branch で作成は止める" Bash "{\"command\":\"cd $run/worktree && git branch new-branch\"}"
expect 2 "git branch -D は止める" Bash "{\"command\":\"cd $run/worktree && git branch -D main\"}"
expect 2 "git config は止める" Bash "{\"command\":\"cd $run/worktree && git config user.name x\"}"
expect 2 "git remote は止める" Bash "{\"command\":\"cd $run/worktree && git remote add x y\"}"
expect 2 "グローバルオプションを飛ばした先の commit は止める" Bash "{\"command\":\"cd $run/worktree && git -c user.name=x commit -m y\"}"
expect 2 "区切りのあとの git の状態を変える操作は止める" Bash "{\"command\":\"cd $run/worktree && git log -1 | git push\"}"
expect 2 "git branch に一覧以外の名前があれば止める" Bash "{\"command\":\"cd $run/worktree && git branch -a feature\"}"
expect 2 "引用符の中の括弧のあとの git branch -D は止める" Bash "{\"command\":\"cd $run/worktree && git branch --format='%(refname)' -D x\"}"
expect 2 "引用符の中の ; のあとの git branch -D は止める" Bash "{\"command\":\"cd $run/worktree && git branch --format='a;b' -D x\"}"
expect 2 "2>&1 のあとの git branch -D は止める" Bash "{\"command\":\"cd $run/worktree && git branch 2>&1 -D x\"}"
expect 2 "git branch の後ろの \$() の中身が -D でも止める" Bash "{\"command\":\"cd $run/worktree && git branch --list \$(echo x) -D y\"}"
expect 2 "git のサブコマンドを \$() で作るのは止める" Bash "{\"command\":\"cd $run/worktree && git \$(echo commit) x\"}"
expect 2 "\$() の中の git commit は止める" Bash "{\"command\":\"cd $run/worktree && echo \$(git commit -m x)\"}"
expect 0 "2>&1 とパイプで読む git log は通す" Bash "{\"command\":\"cd $run/worktree && git log -1 2>&1 | head -3\"}"
expect 0 "&> の出力先は語として数えない" Bash "{\"command\":\"cd $run/worktree && git branch -r &>/dev/null\"}"
expect 0 "読み取りの git grep と show は通す" Bash "{\"command\":\"cd $run/worktree && git grep -n config -- '*.rb' | head -20 && git show HEAD:app/a.rb\"}"
expect 0 "\$() の中の読み取りの git は通す" Bash "{\"command\":\"cd $run/worktree && git diff \$(git merge-base HEAD HEAD) HEAD -- app\"}"
expect 0 "git for-each-ref の %(refname) は通す" Bash "{\"command\":\"cd $run/worktree && git for-each-ref --format='%(refname)' refs/remotes\"}"
expect 2 "xargs 経由の git commit は止める" Bash "{\"command\":\"cd $run/worktree && ls | xargs git commit\"}"
expect 2 "git --git-dir で実行フォルダの外を指すのは止める" Bash "{\"command\":\"cd $run/worktree && git --git-dir=/tmp/x log\"}"
expect 2 "git --work-tree（次の語で指す）が外なら止める" Bash "{\"command\":\"cd $run/worktree && git --work-tree /tmp log\"}"
expect 0 "出力先の指定（2>&1）は git の引数に数えない" Bash "{\"command\":\"cd $run/worktree && git log -1 2>&1 | head -3\"}"

out2=$(bash "$dir/prepare.sh" "$repo" "$sha") || ng "2 回目の prepare.sh が成功する"
run2=$(sed -n 's/^run //p' <<<"$out2")
runs+=("$run2")
[[ -f $run/worktree/app/a.rb && -f $run2/worktree/app/a.rb ]] && ok "新しく作っても、同じリポジトリのほかの実行の作業ツリーは消さない" || ng "ほかの実行の作業ツリーは消さない"
grep -qxF "other_worktree $run" <<<"$out2" && ok "作業ツリーが残っているほかの実行を知らせる" || ng "作業ツリーが残っているほかの実行を知らせる: $out2"
bash "$dir/cleanup.sh" "$run" >/dev/null
expect 2 "作業ツリーを消した実行フォルダは使えない" Read "{\"file_path\":\"$run/items/A03.json\"}"

out3=$(bash "$dir/prepare.sh" --resume "$run") && [[ -f $run/worktree/app/a.rb ]] && ok "--resume で作業ツリーを作り直す" || ng "--resume で作業ツリーを作り直す: $out3"
rm -rf "$run/worktree"
bash "$dir/prepare.sh" --resume "$run" >/dev/null 2>&1 && [[ -f $run/worktree/app/a.rb ]] && ok "作業ツリーを手で消したあとも --resume で作り直す" || ng "作業ツリーを手で消したあとも --resume で作り直す"
# 古い実行フォルダ（修正 Issue の反映の規則がない）から --resume すると足す。あるものは上書きしない
rm "$run/refs/fix-issues.md"
bash "$dir/prepare.sh" --resume "$run" >/dev/null 2>&1 && [[ -f $run/refs/fix-issues.md ]] && ok "--resume で欠けた参照を写す" || ng "--resume で欠けた参照を写す"
echo "そのまま" >"$run/refs/issue-sync.md"
bash "$dir/prepare.sh" --resume "$run" >/dev/null 2>&1 && [[ $(cat "$run/refs/issue-sync.md") == "そのまま" ]] && ok "--resume で既存の参照は上書きしない" || ng "--resume で既存の参照は上書きしない"

bash "$dir/cleanup.sh" "$run2" >/dev/null && [[ ! -d $run2/worktree && -d $run2/items ]] && ok "cleanup.sh は作業ツリーだけを消す" || ng "cleanup.sh は作業ツリーだけを消す"
[[ -z $(git -C "$repo" worktree list --porcelain | grep -F "$run2/worktree") ]] && ok "対象リポジトリの登録も片付ける" || ng "対象リポジトリの登録も片付ける"

# 関連リポジトリを版を固定して写す（deps.sh）。origin/main は、写す SHA から届く状態にする
git -C "$repo" remote add origin https://example.com/Acme/Shared.git
git -C "$repo" update-ref refs/remotes/origin/main "$sha"
drun=$(sed -n 's/^run //p' <<<"$(bash "$dir/prepare.sh" "$repo" "$sha")")
runs+=("$drun")
dep="deps/Shared@$sha"
echo "未追跡" >"$repo/app/untracked.rb"
dout=$(bash "$dir/deps.sh" "$drun" "$repo" "$sha" --source lockfile)
dcode=$?
[[ $dcode == 0 ]] && grep -qxF "dep $dep" <<<"$dout" && [[ -f $drun/$dep/app/a.rb && ! -e $drun/$dep/app/untracked.rb && ! -e $drun/$dep/.env ]] && ok "deps.sh は追跡されたファイルだけを展開する" || ng "deps.sh は追跡されたファイルだけを展開する: $dout"
jq -e --arg sha "$sha" '.[0] | .name == "Shared" and .remote == "example.com/acme/shared" and .sha == $sha and .source == "lockfile" and .adopted == false and .path == ("deps/Shared@" + $sha)' "$drun/ledger/deps.json" >/dev/null && ok "ledger/deps.json に記録を 1 件足す" || ng "ledger/deps.json に記録を足す"
bash "$dir/deps.sh" "$drun" "$repo" "$sha" --source lockfile >/dev/null && [[ $(jq length "$drun/ledger/deps.json") == 1 ]] && ok "同じ remote と sha の記録は足さない" || ng "同じ remote と sha の記録は足さない"
git -C "$repo" -c user.email=t@example.com -c user.name=t commit -q --allow-empty -m local
lsha=$(git -C "$repo" rev-parse HEAD)
bash "$dir/deps.sh" "$drun" "$repo" "$lsha" --source default_branch >/dev/null 2>&1
[[ $? == 1 && ! -e $drun/deps/Shared@$lsha ]] && ok "手元だけのコミットは写さない" || ng "手元だけのコミットは写さない"
rm -rf "$drun/$dep"
bash "$dir/deps.sh" --resume "$drun" >/dev/null && [[ -f $drun/$dep/app/a.rb ]] && ok "--resume で展開を写し直す" || ng "--resume で展開を写し直す"
rm -rf "$drun/$dep"
git -C "$repo" update-ref -d refs/remotes/origin/main
mout=$(bash "$dir/deps.sh" --resume "$drun")
mcode=$?
[[ $mcode == 1 ]] && grep -qxF "dep_missing $dep" <<<"$mout" && ok "届かなくなった SHA は dep_missing を出して終了コード 1" || ng "届かなくなった SHA は dep_missing を出して終了コード 1: $mcode $mout"
git -C "$repo" update-ref refs/remotes/origin/main "$sha"
bash "$dir/deps.sh" "$drun" "$repo" "$sha" >/dev/null 2>&1
[[ $? == 3 ]] && ok "--source がなければ終了コード 3" || ng "--source がなければ終了コード 3"
bash "$dir/deps.sh" "$tmp" "$repo" "$sha" --source lockfile >/dev/null 2>&1
[[ $? == 1 ]] && ok "実行フォルダでなければ止める" || ng "実行フォルダでなければ止める"
for u in 'git@example.com:Acme/Shared.git' 'ssh://git@example.com:2222/Acme/Shared' 'https://user@example.com/Acme/Shared/'; do
  git -C "$repo" remote set-url origin "$u"
  rm -rf "$drun/deps" "$drun/ledger/deps.json"
  if bash "$dir/deps.sh" "$drun" "$repo" "$sha" --source lockfile >/dev/null 2>&1 && [[ $(jq -r '.[0].remote + " " + .[0].name' "$drun/ledger/deps.json") == "example.com/acme/shared Shared" ]]; then
    ok "origin の URL（$u）から remote と name を求める"
  else
    ng "origin の URL（$u）から remote と name を求める"
  fi
done
rm -f "$drun/ledger/deps.json"
bash "$dir/deps.sh" "$drun" "$repo" "$sha" --source submodule --adopted yes >/dev/null && jq -e '.[0].adopted == true and .[0].source == "submodule"' "$drun/ledger/deps.json" >/dev/null && ok "--adopted yes と --source を記録する" || ng "--adopted yes と --source を記録する"
bash "$dir/deps.sh" "$drun" "$repo" no-such-rev --source lockfile >/dev/null 2>&1
[[ $? == 1 ]] && ok "解決できない rev は終了コード 1" || ng "解決できない rev は終了コード 1"
bash "$dir/cleanup.sh" "$drun" >/dev/null && [[ ! -d $drun/deps && -f $drun/ledger/deps.json ]] && ok "cleanup.sh は deps/ を消して ledger/deps.json は残す" || ng "cleanup.sh は deps/ を消して ledger/deps.json は残す"

rm "$CLAUDE_CONFIG_DIR/skills/security-audit-verify-items"
bash "$dir/prepare.sh" "$repo" "$sha" >/dev/null 2>&1
[[ $? == 1 ]] && ok "スキルがリンクされていなければ止める" || ng "スキルがリンクされていなければ止める"
ln -s "$(cd -P "$dir/.." && pwd)" "$CLAUDE_CONFIG_DIR/skills/security-audit-verify-items"
rm "$CLAUDE_CONFIG_DIR/agents/security-audit-item-verifier.md"
bash "$dir/prepare.sh" "$repo" "$sha" >/dev/null 2>&1
[[ $? == 1 ]] && ok "サブエージェントがリンクされていなければ止める" || ng "サブエージェントがリンクされていなければ止める"

# このスキル集の版の遅れ。メインの checkout が origin の既定ブランチより遅れていれば知らせる（worktree から呼んでも、メインの checkout を見る）
sk=$tmp/skills
mkdir -p "$sk/.claude/skills" "$sk/.agents/skills"
cp -R "$dir/.." "$sk/.claude/skills/security-audit-verify-items"
cp -R "$dir/../../../../.agents/skills/security-audit-sync-issues" "$sk/.agents/skills/"
git -C "$sk" init -q
git -C "$sk" add -A
git -C "$sk" -c user.email=t@example.com -c user.name=t commit -q -m base
base=$(git -C "$sk" rev-parse HEAD)
newer=$(git -C "$sk" -c user.email=t@example.com -c user.name=t commit-tree "$(git -C "$sk" rev-parse "HEAD^{tree}")" -p "$base" -m newer)
git -C "$sk" symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main
git -C "$sk" update-ref refs/remotes/origin/main "$newer"
git -C "$sk" worktree add -q --detach "$tmp/skills-wt" "$newer"
for cfg in sk wt; do mkdir -p "$tmp/claude-$cfg/agents" "$tmp/claude-$cfg/skills"; touch "$tmp/claude-$cfg/agents/security-audit-item-verifier.md"; done
ln -s "$sk/.claude/skills/security-audit-verify-items" "$tmp/claude-sk/skills/security-audit-verify-items"
ln -s "$tmp/skills-wt/.claude/skills/security-audit-verify-items" "$tmp/claude-wt/skills/security-audit-verify-items"
behind=$(CLAUDE_CONFIG_DIR=$tmp/claude-sk bash "$sk/.claude/skills/security-audit-verify-items/scripts/prepare.sh" "$repo" "$sha")
grep -qxF "skills_behind 1" <<<"$behind" && ok "メインの checkout が遅れていれば skills_behind を出す" || ng "メインの checkout が遅れていれば skills_behind を出す: $behind"
wtout=$(CLAUDE_CONFIG_DIR=$tmp/claude-wt bash "$tmp/skills-wt/.claude/skills/security-audit-verify-items/scripts/prepare.sh" "$repo" "$sha")
grep -qxF "skills_behind 1" <<<"$wtout" && ok "worktree から呼んでも、メインの checkout の遅れを知らせる" || ng "worktree から呼んでも、メインの checkout の遅れを知らせる: $wtout"
git -C "$sk" update-ref refs/remotes/origin/main "$base"
uptodate=$(CLAUDE_CONFIG_DIR=$tmp/claude-sk bash "$sk/.claude/skills/security-audit-verify-items/scripts/prepare.sh" "$repo" "$sha")
[[ $? == 0 ]] && ! grep -q '^skills_behind' <<<"$uptodate" && ok "遅れていなければ skills_behind を出さない" || ng "遅れていなければ skills_behind を出さない: $uptodate"
git -C "$sk" update-ref -d refs/remotes/origin/main
unknown=$(CLAUDE_CONFIG_DIR=$tmp/claude-sk bash "$sk/.claude/skills/security-audit-verify-items/scripts/prepare.sh" "$repo" "$sha")
[[ $? == 0 ]] && ! grep -q '^skills_behind' <<<"$unknown" && ok "判定できなければ何も出さず、終了コードも変えない" || ng "判定できなければ何も出さず、終了コードも変えない: $unknown"

echo "fails: $fails"
[[ $fails == 0 ]]
