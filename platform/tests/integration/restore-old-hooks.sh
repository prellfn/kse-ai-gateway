#!/usr/bin/env bash
# 集成测试结束后：卸载 KAIP 接入，并恢复测试前的 Codex / OpenCode / WorkBuddy 配置（含旧 KSE hook）
# 用法：bash tests/integration/restore-old-hooks.sh
set -euo pipefail
B="$HOME/.kaip-it-backup"
[ -d "$B" ] || { echo "未找到备份目录 $B"; exit 1; }
node "$HOME/.kaip/client/bin/kaip.js" uninstall || true
cp -p "$B/codex-hooks.json"        "$HOME/.codex/hooks.json"
cp -p "$B/codex-config.toml"       "$HOME/.codex/config.toml"
cp -p "$B/workbuddy-settings.json" "$HOME/.workbuddy/settings.json"
[ -f "$B/codebuddy-settings.json" ] && cp -p "$B/codebuddy-settings.json" "$HOME/.codebuddy/settings.json"
mkdir -p "$HOME/.config/opencode/plugins"
cp -p "$B/opencode-kse-guard.js"   "$HOME/.config/opencode/plugins/kse-guard.js"
echo "已恢复测试前配置。请完全重启 Codex / OpenCode / WorkBuddy。"
