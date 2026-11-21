#!/usr/bin/env bash
# 防篡改「事后」场景：直接篡改 KAIP 文件，验证后台监控检测并自愈（每 60 秒心跳）
# 在已安装 KAIP 客户端（含 kaip-watch 服务）的 Linux 终端上以 root 运行：bash tamper-selfheal.sh
K=$HOME/.kaip; CL=$K/client; HJ=$HOME/.codex/hooks.json
hookrun() {  # 用 Codex 载荷调用 hook，输出 allow/deny
  printf '%s' "{\"hook_event_name\":\"PreToolUse\",\"tool_name\":\"Bash\",\"cwd\":\"/tmp\",\"tool_input\":{\"command\":\"$1\"}}" \
    | node $CL/bin/kaip-hook.js --agent codex | grep -q '"deny"' && echo deny || echo allow
}
waitfor() {  # waitfor <描述> <检查命令>，最多等 150 秒
  for i in $(seq 1 30); do eval "$2" && { echo "  ✔ $1（约 $((i*5)) 秒）"; return 0; }; sleep 5; done; echo "  ✘ $1：超时"; return 1
}
sha() { sha256sum "$1" | cut -c1-16; }

echo "### 场景 1：客户端程序被改坏（hook.js 注入语法错误）"
H1=$(sha $CL/lib/hook.js)
echo "this is not javascript (((" >> $CL/lib/hook.js
echo "  篡改后普通命令 ls 的判定：$(hookrun 'ls -la')（应为 deny：组件不完整时不放行）"
waitfor "监控检测到并从平台恢复 hook.js" '[ "$(sha $CL/lib/hook.js)" = "$H1" ]'
echo "  恢复后 ls 的判定：$(hookrun 'ls -la')（应为 allow）"

echo "### 场景 2：Codex 配置中的 KAIP hook 被删除"
H2=$(sha $HJ)
python3 - "$HJ" <<'EOF'
import json, sys
p = sys.argv[1]; d = json.load(open(p))
for ev in list(d.get("hooks", {})):
    d["hooks"][ev] = [g for g in d["hooks"][ev] if not any("kaip-hook" in h.get("command", "") for h in g.get("hooks", []))]
    if not d["hooks"][ev]: del d["hooks"][ev]
json.dump(d, open(p, "w"), indent=2)
EOF
echo "  篡改后 hooks.json 中 KAIP 条目数：$(grep -c kaip-hook $HJ)"
waitfor "监控检测到并恢复 hook 配置" '[ "$(grep -c kaip-hook $HJ)" -ge 3 ]'
echo "  恢复后与原文件一致（Codex 信任记录仍有效）：$([ "$(sha $HJ)" = "$H2" ] && echo 是 || echo 否)"
node $CL/bin/kaip.js verify 2>/dev/null | grep Codex | sed 's/^/  /'

echo "### 场景 3：本地缓存策略被改（关闭写文件扫描，版本号不变）"
python3 - "$K/config.json" <<'EOF'
import json, sys
p = sys.argv[1]; d = json.load(open(p)); d["policy"]["scan_on_write"] = False; json.dump(d, open(p, "w"), indent=2)
EOF
echo "  篡改后 scan_on_write = $(python3 -c "import json;print(json.load(open('$K/config.json'))['policy']['scan_on_write'])")"
waitfor "平台强制覆盖本地策略" '[ "$(python3 -c "import json;print(json.load(open(\"$K/config.json\"))[\"policy\"][\"scan_on_write\"])")" = "True" ]'
