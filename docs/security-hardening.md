# 安全加固指南

本项目部署到内网后，**默认存在两处高危暴露面**。本文说明风险、检测方法与加固步骤。

---

## 1. 风险一：KSE HTTP API 无认证（高）

### 现象

KSE 的 `kavhttpd` 在 HTTP 模式下监听 `0.0.0.0:<port>`，若未开启 Token 认证，
**同网段任意主机都能直接调用扫描接口**：

```xml
<UseAccessToken>0</UseAccessToken>   <!-- 认证关闭 -->
<AccessTokens/>                       <!-- 令牌列表为空 -->
```

实测（错误 Token / 完全不带 Token 都能成功扫描）：

```bash
curl -X POST http://<KSE>:1234/api/v3.0/scanmemory \
  -H "Content-Type: application/octet-stream" \
  -H "Authorization: Bearer 任意错误令牌" \
  -d '{"timeout":"20000","object":"<base64>"}'
# → {"scanResult":"CLEAN", ...}   认证未生效
```

### 影响

| 能力 | 风险 |
|---|---|
| `scanmemory` / `checkurl` | 可把 KSE 当作免鉴权扫描预言机；可批量触发扫描耗尽 16 个扫描线程 |
| `scanfile` | KSE 仅允许**本机**路径扫描（跨机返回 `Scan file via remote request is rejected`），因此不能被用来读取 KSE 主机上的任意文件 |
| `update/start` | 可被匿名触发病毒库更新 |

> 注意：KAIP 平台的 `KAIP_KSE_TOKEN` 配置在 KSE 未开启认证时是**无效的**（只是装饰）。

### 检测

```bash
grep -E "UseAccessToken|AccessTokens" /opt/kaspersky/ScanEngine/etc/kavhttpd.xml
```

### 加固

**第一步（推荐，治本）：在 KSE Web UI 开启 Token 认证**

> ⚠️ 手册明确提示：**不要手动改 XML**，字段名容易出错导致 KSE 起不来。请走 Web UI。

1. `Settings → Service`：Protocol = **HTTPS**，填写
   Private key path = `/opt/kaspersky/ScanEngine/etc/kavhttpd_key.pem`、
   Certificate = `/opt/kaspersky/ScanEngine/etc/kavhttpd_cert.pem`
   （可从 `httpsrv/kl_scanengine_cert.pem` 与 `kl_scanengine_private.pem` 复制）
2. `Settings → Authorization`：打开 **Enable authorization for HTTP clients**，
   添加 Token（勾选 Add bearer prefix），打开 **Enable token**，Save
3. `Settings → Scanning`：把实际扫描目录加入白名单
4. 网关侧同步更新：`KSE_URL=https://<KSE>:8443`、`KSE_TOKEN=<新生成的明文 Token>`、
   `KSE_VERIFY_TLS=false`（自签证书）

**第二步（立即可做，网络层收口）：限制 KSE API 的可达来源**

```bash
sudo ./scripts/harden-firewall.sh --role kse --allow <Lite网关IP>
```

该脚本采用**外科式**策略：不翻转默认放行策略，只对 KSE API 端口加
「先放行具体来源 → 再拒绝其他所有来源」的规则，因此不会误伤机器上
ClickHouse / nginx / squid / ICAP 等其它业务端口。

---

## 2. 风险二：隔离区复核台无鉴权（中高）

### 现象

Lite 网关形态的复核台（`:8004`）提供**恢复**与**删除**隔离文件的能力，
但默认没有任何认证：

| 能力 | 影响 |
|---|---|
| `POST /api/quarantine/{id}/restore` | 把被隔离的恶意文件放回原路径 → 威胁重新进入执行环境 |
| `DELETE /api/quarantine/{id}` | 破坏审计证据 |
| `GET /api/quarantine` | 泄露文件路径、SHA-256、威胁名称 |

### 加固

```bash
sudo ./scripts/harden-firewall.sh --role gateway --allow <平台IP>,<管理端IP>
```

同时建议在反向代理层加认证（Nginx + Basic Auth / OIDC / mTLS），
参考 `platform/deploy/nginx-kaip.conf`。

---

## 3. 加固后的验证

```bash
# 未授权侧应无响应 (HTTP 000)
curl -s -m 5 -o /dev/null -w "%{http_code}\n" http://<KSE>:1234/api/v3.0/checkurl \
  -X POST -H "Content-Type: application/octet-stream" -d '{"url":"http://example.com/"}'

# 允许来源应正常
curl -s -m 5 http://<KSE>:1234/api/v3.0/version
```

看规则命中计数（确认确实是防火墙在拦，而不是应用层报错）：

```bash
iptables -L ufw-user-input -n -v | grep 1234
# DROP 规则的 pkts 计数递增 = 拦截生效
```

---

## 4. 加固后的业务回归清单

加固后**必须**逐项确认：

- [ ] SSH 仍可登录（`ufw allow 22/tcp`）
- [ ] 平台 API 可达（终端接入用，`:8080`）
- [ ] KSE API 从允许来源可达（`:1234`）
- [ ] ICAP 扫描链路正常（`:1344`，若使用）
- [ ] Lite 网关三项服务正常（`:8000` / `:8002` / `:8004`）
- [ ] 端到端扫描：干净文件 → CLEAN；EICAR → DETECT + 隔离
- [ ] 委托模式链路：Lite → 平台 → KSE 判定正确

---

## 5. 其他建议

| 项 | 建议 |
|---|---|
| KSE 许可证 | 定期检查有效期（`/api/v3.0/licenseinfo`），到期前续期 |
| 平台管理员口令 | 首次启动随机生成写入 `initial_admin_password.txt`，**登录后立即修改** |
| 终端令牌 | 终端丢失时在控制台吊销该终端（`require_agent` 校验 `token_hash`） |
| SSH 主机密钥 | 克隆部署的机器共享同一份主机密钥，建议 `ssh-keygen -A` 重新生成 |
| 审计日志 | `audit.jsonl` / SQLite 事件库应定期归档到集中日志平台 |
| 病毒库更新 | 离线环境用 KSE 本地镜像源；KAIP 平台已按病毒库版本号失效判定缓存 |
