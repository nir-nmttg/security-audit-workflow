# コントリビューションの手引き

Issue と Pull Request は誰でも歓迎する。\
バグの報告・改善の提案・ドキュメントの修正など、小さなものでもかまわない。

## 受け付ける変更

このリポジトリには、Cloudflare の `security-audit` でのセキュリティ監査と、その結果の Issue 化・調べ直しに使うスキルだけを置く。\
特定のプロジェクトのコードに依存するスキルや、監査と関係のないスキルは受け付けない。\
大きな変更や新しいスキルの追加は、先に Issue で相談してほしい。

## Pull Request の出し方

1. このリポジトリをフォークし、ブランチを作る。
2. [AGENTS.md](AGENTS.md) のルールに沿って変更する（名前・配置・description・README の更新など）。
3. コミットしてから、CI と同じ次のチェックを実行し、通ることを確かめる（Node.js 22.20 以上・`jq`・`perl` を使う）。

   ```bash
   scripts/check-descriptions.sh
   git diff --check "$(git hash-object -t tree /dev/null)" HEAD
   git ls-files -z '*.sh' | xargs -0 -n1 bash -n
   node --test .agents/skills/*/scripts/*.test.mjs .claude/skills/*/scripts/*.test.mjs
   bash .claude/skills/security-audit-verify-items/scripts/scripts.test.sh
   ```

   スクリプトを変えた場合は、変えた動作も確かめる。
4. `main` に向けて Pull Request を出す。\
   テンプレートの確認項目を埋める。

Pull Request では同じ確認を GitHub Actions でも行う。\
メンテナー以外からの Pull Request では、メンテナーが承認してから Actions が動く。\
マージはメンテナーが行う。

## 脆弱性の報告

脆弱性は公開の Issue に書かず、[SECURITY.md](SECURITY.md) の方法で報告してほしい。

## ライセンス

送った変更は、このリポジトリと同じ [MIT License](LICENSE) で公開される。
