# 会话交接文档 —— 六服务每日签到自动化

> 生成时间：2026-11-18 14:45（Asia/Shanghai）
> 交接人：上一会话（checkin 系列全部逆向 + 部署 + 邮件通知）
> 接手须知：先读这份，再读各目录的 README，最后才动代码。

---

## 1. 一句话现状

六个桌面 AI 客户端的「每日签到 / 每日领额度」已经全部改成**不开客户端的纯 HTTP 自动化**，由一个 Windows 计划任务 `DailyCheckinAll` 统一调度，跑完自动发汇总邮件到 `181013051@qq.com`。

| 服务 | 桌面程序 | 签到机制 | 当前状态 |
| --- | --- | --- | --- |
| WorkBuddy | `D:\Program Files\WorkBuddy` | 领 100 积分/天，有连签 | ✅ 正常（连签 50 天） |
| Trae CN | `D:\Programs\Trae CN` | 领 100 Credits/天 | ✅ 正常 |
| Qoder CN | `D:\Program Files\Qoder CN` | 领 100 Credits/天（活动制） | ✅ 正常 |
| MiniMax Code | `D:\Program Files\MiniMax Code` | 7 天签到表，当天 1000 点 | ✅ 正常 |
| DoubaoWork | `D:\Program Files\DoubaoWork` | 签到 +400 额度 | ⚠️ 服务端恒报 `710010702`（客户端也一样），记 WARN |
| Loomy（讯飞） | `D:\Program Files\Loomy` | 无签到按钮，每日赠送额度自动刷新 | ✅ 正常 |

计划任务当前状态：`Ready`、`Last Result: 0`、下次 `22:20`。

---

## 2. 目录地图

根目录：`C:\Users\Lenovo\Documents\deepseek-harness\default-workspace`

```
checkin-all/       统一执行器 + 邮件（核心，改动从这里开始）
wb-checkin/        WorkBuddy
trae-checkin/      Trae CN
qoder-checkin/     Qoder CN
mm-checkin/        MiniMax Code
doubao-checkin/    DoubaoWork
loomy-checkin/     Loomy
```

每个子目录的文件分工是固定的：

| 文件 | 作用 |
| --- | --- |
| `claim.js` | 真正的业务逻辑：取 token → 查状态 → 领取 → 复查 → 打印 `BALANCE {json}` |
| `daily.ps1` | 包装脚本，给 `checkin-all\run.ps1` 调用；负责日志、客户端兜底、退出码 |
| `token/auth/*.js` | 凭证读取与刷新（各服务不同，见第 4 节） |
| `README.md` | 该服务的接口、算法、边界、踩坑 |
| 其余 `probe*.js` / `tmp-*.js` 等 | 逆向期的一次性探测脚本，**不要删也不要改**，出问题时是唯一的考古线索 |

---

## 3. 统一执行器 `checkin-all\run.ps1`

### 调用契约

每个 `daily.ps1` 退出码：

| code | 含义 | 执行器判定 |
| --- | --- | --- |
| 0 | 已领取 / 今日已领 / 无需操作 | `OK` |
| 2 | 凭证失效，需要本人重新登录 | `FAIL` + 进 `reauth` 数组 |
| 1 | 其它错误 | `FAIL`（Doubao 例外，记 `WARN`） |
| -2 | 超时被杀 | `TIMEOUT` |

### 两件必须记住的实现约束

1. **`run.ps1` 必须保持纯 ASCII**。计划任务用 `powershell.exe`（5.1），该版本会把 UTF-8 中文字面量解析成语法错误，脚本在解析阶段整体失败——不执行、不写日志、不发邮件，只留 `Last Result: 1`。中文只能写进 `.js`（Node 按 UTF-8 读没问题）。
2. **`Start-Process -PassThru` 在 5.1 下读不到 `ExitCode`**（有重定向输出时恒为空）。现在每个任务套一层临时 wrapper `.ps1`，wrapper 把 `$LASTEXITCODE` 写进哨兵文件，父进程读文件取值。

这两条已在 `checkin-all\README.md` 的「改动守则」章节，附有验证命令。

### 其他机制

- `Wait-Network`：开跑前最多等 180 秒到 DNS 可用（开机补跑时网络常常还没起来）。
- 单服务 `fetch failed` / `ENOTFOUND` / `getaddrinfo` / `ETIMEDOUT` / `ECONNREFUSED` → 20 秒后重试一次。
- 结果写 `last-run.json`（UTF-8 无 BOM），字段：`at` / `overall` / `reauth[]` / `jobs[]`，每个 job 有 `Name / Exit / Elapsed / State / Tail / Balance`。

---

## 4. 六个服务的凭证来源（最容易出问题的地方）

| 服务 | 凭证位置 | 刷新能力 | 失效表现 |
| --- | --- | --- | --- |
| WorkBuddy | `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info`（字段级加密，主密钥在 `~\.workbuddy\keyblob`，**Node 无法纯离线解密**） | 靠客户端启动回写；失败时 `daily.ps1` 最小化拉起客户端抓 | `exit 2` |
| Trae | `%APPDATA%\Trae CN\User\globalStorage\storage.json` 的 `iCubeAuthInfo://icube.cloudide`，用 `trae-checkin\byteCrypto.js` 离线解密 | **不能刷新**（`ExchangeToken` 恒 `20403 Token device not match`），token 7 天有效，靠客户端续期 | `exit 2` |
| Qoder | `%APPDATA%\com.qodercn.app.stable\auth.v1.dat`，Chromium v10 AES-256-GCM，DPAPI 解 `Local State` 的 `os_crypt.encrypted_key` | 无 refresh 接口；token 有效到 2026-11-16 后靠客户端续期 | `exit 2` |
| MiniMax | `~\.mavis\auth\prod\cn\mcode-public\auth.json` + `auth-state.json` | `POST https://account.minimax.cn/oauth2/token`（refresh_token grant） | `invalid_grant` → `exit 2` |
| Doubao | `~\.doubao-checkin\cookies.json`（29 条 doubao.com cookie，由 `grab-cookies.js` 通过 CDP 导出） | 无；cookie 过期需重抓 | `exit 2` |
| Loomy | `~\.loomy-checkin\session.json`（`login.js` 落盘） | 无 refresh token，session 约 14 天 | `exit 2` |

### ⚠️ MiniMax 的刷新纪律（血泪教训，不能改）

2026-11-09 我在客户端运行时自己用 refreshToken 刷新，结果 `400 invalid_grant: this refresh token can no longer be used`，导致客户端被强制登出、`auth.json` 被清空。现在的规矩写死在 `mm-checkin\mm-auth.js`：

1. 刷新成功后**立刻**把 accessToken/refreshToken/expiresAtMs 写回 `auth.json`（generation+1）与 `auth-state.json`。
2. **客户端在运行时绝不自己刷新**（用 `tasklist /FI "IMAGENAME eq MiniMax Code.exe"` 判断），只轮询文件等客户端回写。
3. 只有「客户端没跑 + 剩余 < 2 分钟」才刷新；遇到 `invalid_grant` 直接 `exit 2` 报「需要重登」，不重试。

---

## 5. 各服务的接口要点（详细见各自 README）

### WorkBuddy
- 签到：`POST https://www.workbuddy.cn/v2/billing/meter/checkin-activity-status` / `daily-checkin`，body `{}`
- 头：`Authorization: Bearer <accessToken>`、`X-User-Id`、可选 `X-Device-Token`（TuringShield）
- 码：`0` 成功 / `1001` 已签到 / `1002` 无资格 / `1003` 活动结束
- 余额：`POST /billing/meter/get-user-resource-summary` → `Packages[].CycleRemainCapacity` 求和，**必须带 UA + `Accept-Language: zh`**，否则 `10085 请求不合法`

### Trae CN
- 签到：`POST https://api.trae.cn/trae/api/v2/ug/checkin_credits/status` / `claim`，body `{"req_source":1}`
- 头：`Authorization: Cloud-IDE-JWT <token>` + `x-device-id` 等设备头
- **坑**：`~\.trae-cn\trae-jwt-token`（925 字节明文 JWT）**不被 ug 接口接受**，恒 `1001 未认证`；必须用 `storage.json` 里解密出的真实 token（1004 字符）
- 余额：`POST /trae/api/v2/pay/ide_user_ent_usage` → `total_balance`

### Qoder CN
- 活动：`GET https://openapi.qoder.com.cn/sash/api/v1/me/campaigns`，**必须带 `Cosy-ClientType: 10`**，否则静默返回空列表
- 领取：`POST /sash/api/v1/me/campaigns/{campaignId}/claim`（用 **uuid campaignId**，不是 campaignKey，否则 `400 FIELD_VALIDATION_FAILED`）
- 其他头：`Cosy-MachineId`、`Cosy-MachineToken`（跑 `resources\umid\runtime-info.exe` 取）、`Cosy-MachineType`、`Cosy-MachineCode`、`Cosy-Version: 0.5.6`
- 余额：`GET /sash/api/v2/me/usage` → `userQuota.remaining + addOnQuota.remaining`

### MiniMax Code
- 状态：`GET https://agent.minimax.cn/minimax-cloud/api/v1/signin/status`
- 领取：`POST /minimax-cloud/api/v1/signin/claim`，body `{}`
- 签名（两个都要）：`x-signature = md5(ts + 'I*7Cf%WZ#S&%1RlZJ&C2' + body)`；`yy = md5(encodeURIComponent(url含query) + '_' + bodyJson + md5(String(ms)) + 'ooui')`
- 余额：`GET /minimax-cloud/api/v1/credit/details?page_size=100` → `details[].remaining_amount` 求和（**必须 page_size=100**，默认只回 20 条）
- query 参数一长串（`device_platform/biz_id=3/app_id=3001/uuid/device_id/.../client=desktop`），照抄 `mm-checkin\claim.js`

### DoubaoWork
- 状态：`POST https://www.doubao.com/alice/ug/campaign/v3/detail/`，body `{"campaign_group_code":"pc_incentive_task_mvp_v3"}`
- 签到：`POST /alice/ug/campaign/landing/checkin`，body `{"scene":"pc_incentive_task_mvp_v3"}` → **恒 `710010702`**
- 参数组必须是 `work_desktop`（`aid=497858&web_platform=work_desktop&doubao_pc_version=5.74.35&version_code=20800&...`），加 `Agw-Js-Conv: str` 头，UA 后缀 `SamanthaDoubaoWork/2.31.10`
- **不需要 `a_bogus`**（读接口不带签名也 200）
- 已知结论：该账号本周期 25 天签到额度已用完（`quota/records` 拉全量确认），且服务端接口本身对任何人报错，客户端点「立即签到」同样 toast 失败。**不是我们构造的问题**，等接口恢复后计划任务会自动补签。

### Loomy
- 登录：`https://account.xfinfr.com`，HMAC-SHA1 签名（见 `loomy-checkin\sign.js`）
- 每日额度：`POST https://loomyad.xunfei.cn/api/v1/points/first-login`，body `{}`（幂等，`alreadyProcessed`）
- **没有签到按钮/接口**：`/points/sign-in`、`/checkin`、`/daily` 等全部 404。每日收益 = 每日赠送额度（`dailyQuota` 5000）+ 新手任务自动入账
- 余额：`GET /api/v1/points/balance` → `availableBalance`（= `balance` 永久 + `dailyBalance` 每日）

---

## 6. 邮件通知

- `checkin-all\mail.js`：纯 Node 标准库 SMTP 客户端（隐式 TLS + AUTH LOGIN），无第三方依赖。支持 `--test` / `--probe` / `--dry` / `--state`。
- `checkin-all\mail.json`：163 凭据（`hejian0625@163.com` + 授权码），ACL 已收紧；无凭据时 `exit 3` 静默跳过。
- 主题：正常 `✅ 签到全部正常 · 时间 · 5/6`；有异常 `⚠️ 签到有异常`；有 `exit 2` 时 `🔐 需要重新登录 · <服务名> · 时间`，且正文顶部多一块黄底提示（含失效原因 + 恢复命令）。
- 正文表格五列：服务 / 状态 / 退出码 / 耗时 / 剩余额度，每行下面附该服务最后几行日志。
- **剩余额度取的是真实余额，不是累计获得**。历史上错用过 `total_credits`（WorkBuddy 显示 4800，真实 3040.64），已修正。

---

## 7. 排障顺序

1. 看 `checkin-all\logs\YYYY-MM-DD.log` —— 有没有这次运行的日志。**如果当天文件根本不存在，说明 `run.ps1` 解析失败**（多半是混进了中文，见第 3 节）。
2. `schtasks /Query /TN DailyCheckinAll /V /FO LIST | Select-String 'Last Result'` —— `1` 表示脚本异常退出，`0` 表示正常。
3. 看 `checkin-all\last-run.json` 的 `jobs[]`，找到 `State != OK` 的那个。
4. 进对应服务目录的 `logs\` 看细节，或手动 `.\daily.ps1` 复现。
5. 邮件没收到但日志显示 `mail: sent` → 查 QQ 邮箱垃圾箱 / 163 发信频率限制。

---

## 8. 交接时仍挂着的事

- **Doubao**：`exit=1` 属服务端问题（`710010702`），已记 `WARN`。如果哪天恢复，`claim.js` 会自动签到成功，无需改代码。可以定期看看 `quota/records` 是否出现 2026-11-08 之后的记录。
- **凭证续期**：Trae（7 天）、Qoder、Loomy（14 天）都没有可用的 refresh 接口，到期后必须人工处理一次。邮件已经会提示（`🔐 需要重新登录`），但**没有自动化恢复**——如果要做，方向是「检测到 exit 2 时自动拉起对应客户端，等 token 回写后再跑一次」（`daily.ps1` 里已有雏形，靠 `-WindowStyle Minimized`）。
- ~~`checkin-all\README.md` 第 3 行仍写着「五个签到服务」~~ 已修正：开头与余额章节均按六个服务表述，余额表已补 Loomy。

---

## 9. 常用命令速查

```powershell
# 跑全部（不发信）
cd C:\Users\Lenovo\Documents\deepseek-harness\default-workspace\checkin-all
.\run.ps1 -NoMail

# 只跑某几个
.\run.ps1 -Only Qoder,MiniMax

# 只看表格
.\run.ps1 -Status

# 手动触发计划任务并看结果
schtasks /Run /TN 'DailyCheckinAll'
schtasks /Query /TN 'DailyCheckinAll' /V /FO LIST | Select-String 'Last Result'

# Loomy 重新登录（session 到期时）
cd ..\loomy-checkin
D:\nodejs\node.exe login.js send 13822190625
D:\nodejs\node.exe login.js verify 13822190625 <6位码> <MSGID>

# 改完 run.ps1 的两步验证（必做）
$b=[System.IO.File]::ReadAllBytes('run.ps1'); "nonAscii=$(@($b | Where-Object { $_ -gt 127 }).Count)"   # 必须 0
powershell.exe -NoProfile -ExecutionPolicy Bypass -File 'run.ps1' -Only WorkBuddy -NoMail
```

---

## 10. 账号与关键标识

| 项 | 值 |
| --- | --- |
| Windows 账户 | `DESKTOP-SN83EBA\Lenovo` |
| Node | `D:\nodejs\node.exe`（v24.20.0） |
| Trae userId | `1141714038826508` |
| Qoder userId | `01a0ace3-515c-7776-b5ba-1d995fd51f66` |
| MiniMax realUserID | `343189884558561281` |
| Doubao user_id | `3930094726810905` |
| Loomy userid | `261111092522799027` |
| WorkBuddy uid | `15d07d30-93b6-4bd4-9761-1879863917a6` |
