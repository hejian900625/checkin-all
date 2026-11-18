# checkin-all —— 六个签到服务统一调度

把 WorkBuddy / Trae / Qoder / MiniMax / Doubao / Loomy 六个每日签到合并成**一个** Windows 计划任务 `DailyCheckinAll`。

## 结构

```
checkin-all/
  run.ps1        # 统一执行器（纯 ASCII，PS 5.1 安全）
  task.xml       # 计划任务定义（UTF-16）
  HANDOVER.md    # 会话交接文档（接手先读这个）
  logs/YYYY-MM-DD.log
  last-run.json  # 最近一次运行的结构化结果
  backup/        # 原先五个独立任务的 XML 导出（已删除，仅留档）
```

每个服务仍保留各自目录里的 `daily.ps1`（`wb-checkin` / `trae-checkin` / `qoder-checkin` / `mm-checkin` / `doubao-checkin` / `loomy-checkin`），
统一执行器只是按顺序调用它们，不复制任何业务逻辑。

## 调用契约

每个 `daily.ps1` 的退出码：

| code | 含义 | 执行器判定 |
|---|---|---|
| 0 | 已领取 / 今日已领 / 无需操作 | `OK` |
| 2 | 凭证失效，需要客户端兜底 | `NEEDS-AUTH` |
| 1 | 其它错误 | `FAIL`（Doubao 例外，见下） |
| 124 | 超时被杀 | `TIMEOUT` |

各服务内部已经有「纯 HTTP 优先、失败才最小化拉起客户端抓凭证/重试」的兜底，所以不需要外围再补。

Doubao 的服务端目前对本人账号恒返回 `710010702 系统错误`（客户端点「立即签到」也一样），
其 `exit=1` 属于已知服务端问题，所以执行器把它记为 `WARN` 而不是 `FAIL`，避免每轮都报红。

## 邮件通知

每次跑完会把汇总表发到 `mail.json` 里配置的收件人（默认 `181013051@qq.com`），用 163 邮箱 SMTP 直发，不依赖任何第三方服务。

`mail.json`：

```json
{
  "host": "smtp.163.com",
  "port": 465,
  "secure": true,
  "user": "你的地址@163.com",
  "pass": "163 客户端授权码（16 位，不是登录密码）",
  "from": "你的地址@163.com",
  "fromName": "每日签到",
  "to": "181013051@qq.com"
}
```

授权码获取：163 网页版 → 设置 → POP3/SMTP/IMAP → 开启 SMTP 服务 → 生成授权码。

- `user` / `from` 必须是同一个 163 地址，否则 163 会以 `553` 拒发。
- `mail.json` 里没有 `user`/`pass` 时，`mail.js` 直接 `exit 3`（`skipped`），`run.ps1` 只记一行日志，不影响签到本身。
- 跳过发信：`.\run.ps1 -NoMail`。
- 只测发信（不改签到状态）：`node mail.js --test`。
- 只验 SMTP 连通性（不认证）：`node mail.js --probe`。
- 只看渲染效果（不发信）：`node mail.js --dry`。

邮件内容：标题形如 `✅ 签到全部正常 · 2026-11-18 14:21 · 5/6`，正文是每个服务的状态、退出码、耗时，外加各自最后几行日志。有异常时标题变 `⚠️ 签到有异常`，头部条也从绿变棕。

邮件正文还包含一列「剩余额度」，显示各服务**当前真实可用余额**（不是累计获得）。六个来源各自的余额接口：

| 服务 | 余额接口 | 取哪个字段 |
| --- | --- | --- |
| WorkBuddy | `POST https://www.workbuddy.cn/billing/meter/get-user-resource-summary` | 所有 `Packages[].CycleRemainCapacity` 之和；**必须带 UA + `Accept-Language: zh`**，否则网关回 `10085 请求不合法` |
| Trae | `POST https://api.trae.cn/trae/api/v2/pay/ide_user_ent_usage` | `total_balance`（剩余 credits），`usage_summary.consumed_amount` 为已用 |
| Qoder | `GET https://openapi.qoder.com.cn/sash/api/v2/me/usage` | `qoderUsage.userQuota.remaining + addOnQuota.remaining`（免费版 userQuota 为 0，全在 addOnQuota） |
| MiniMax | `GET https://agent.minimax.cn/minimax-cloud/api/v1/credit/details?page_size=100`（需 `yy`/`x-signature` 签名，同签到接口） | 所有 `details[].remaining_amount` 之和；`credit_type 1` = M Plan 套餐、`credit_type 2` = 活动/签到发放。**默认只返回 20 条，必须带 `page_size=100` 才拉全**（否则少算约 500） |
| Doubao | `POST https://www.doubao.com/alice/commerce/sale/subscription/quota/summary/`，body `{"product_line":"membership"}` | `incentive_quota_section.window_limit_groups[].window_limits[]` 的 `total_amount` − `used_amount`（数值带千分位逗号，要去掉） |
| Loomy | `GET https://loomyad.xunfei.cn/api/v1/points/balance` | `availableBalance`（= `balance` 永久 + `dailyBalance` 每日） |

余额优先于活动数据展示：`claim.js` 打出 `BALANCE {…remaining…}` 后，`mail.js` 的 `parseBalance()` 先看 `remaining` 字段，没有才退回累计/活动维度。`remaining` 与总量相等时不重复显示「共 X」。

历史提醒：`total_credits`（WorkBuddy）、`progress.total_amount`（Doubao）、`campaigns[].benefit.amount`（Qoder）都是**累计获得**，Wire 到「当前余额」列会明显偏高（WorkBuddy 曾显示 4800，真实 3040.64）。

## 计划任务

`DailyCheckinAll`：

- 触发：每天 **10:20 / 14:20 / 22:20**（三次）。10:20 在 Qoder 10:00 刷新之后，14:20 作为白天补跑，22:20 兜底。
- `StartWhenAvailable`（错过会补跑）、`MultipleInstancesPolicy=IgnoreNew`（不重入）、`ExecutionTimeLimit=PT1H`。
- 账户 `DESKTOP-SN83EBA\Lenovo`，`InteractiveToken`，`LeastPrivilege`。
- 动作：`powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "...\checkin-all\run.ps1"`。

注册/更新：

```powershell
schtasks /Create /TN DailyCheckinAll /XML "<...>\checkin-all\task.xml" /F
```

`task.xml` 必须以 UTF-16（带 BOM）保存，否则 `schtasks` 会报格式错误。

## 手动用法

```powershell
cd C:\Users\Lenovo\Documents\deepseek-harness\default-workspace\checkin-all

.\run.ps1                       # 跑全部
.\run.ps1 -Only Qoder,MiniMax   # 只跑指定服务（-File 调用时用逗号分隔）
.\run.ps1 -Status               # 只打印表格，不改状态
.\run.ps1 -TimeoutSec 300       # 单个服务超时
```

输出示例：

```
11:21:30 === summary ===
11:21:30   WorkBuddy  OK          exit=0       1s
11:21:30   Trae       OK          exit=0       1s
11:21:30   Qoder      OK          exit=0       2s
11:21:30   MiniMax    OK          exit=0       1s
11:21:30   Doubao     WARN        exit=1      95s
11:21:30 overall: ok
```

## 退出码

- `0`：所有服务 `OK` 或 `WARN`
- `1`：至少一个服务 `FAIL` / `NEEDS-AUTH` / `TIMEOUT` / 脚本缺失

## 启动补跑的保护

`StartWhenAvailable` 会让错过的触发在开机后立刻补跑，而那时 DNS 往往还没起来。2026-11-10 08:26 就撞到过这一下：五个服务全部 `fetch failed` / `ENOTFOUND api.trae.cn`，签到实际没发生（那次事后手动补跑，WorkBuddy 连签 42 天、Trae 当天正常领取）。

现在执行器有两层保护：

1. 开跑前先等 DNS 可用（`Wait-Network`，最多 180 秒，每 5 秒试一次 `www.workbuddy.cn`）。
2. 单个服务若以 `fetch failed` / `ENOTFOUND` / `getaddrinfo` / `ETIMEDOUT` / `ECONNREFUSED` 失败，20 秒后重试一次。

## 注意

- 五个子目录里各自的 `task.xml` 只是留档，对应计划任务已删除，不要再单独注册，否则会和 `DailyCheckinAll` 重复触发。
- MiniMax 与 Qoder 的 refreshToken 都是「一次性、轮换、家族失效」，执行器串行调用、不并发，也不在客户端运行时插手刷新，这一点不能改。
- 全局日志在 `checkin-all/logs/`，排障时先看它，再进具体服务目录的 `logs/` 看细节。

## 改动守则（改 `run.ps1` 前必读）

计划任务用 **Windows PowerShell 5.1**（`powershell.exe`）执行，不是 pwsh 7。两者行为不同，以下四条是踩过的坑：

### 1. `run.ps1` 必须保持纯 ASCII

5.1 解析 `.ps1` 时按系统 ANSI 代码页解码，**UTF-8 中文字面量会直接导致 parse error**，脚本在解析阶段就整体失败——不执行、不写日志、不发邮件，计划任务只留一个 `Last Result: 1`。

2026-11-18 就是这么挂的：给 `$reauthHints` 写了中文提示，10:20 那轮什么都没跑，`logs/2026-11-18.log` 连文件都没生成。

中文只能放在 **`.js` 文件里**（Node 按 UTF-8 读，没问题），或者放进邮件正文由 `mail.js` 拼。

### 2. `Start-Process -PassThru` 读不到 `ExitCode`

PS 5.1 下，用 `-RedirectStandardOutput` 启动的子进程，`$p.ExitCode` 恒为空字符串（`HasExited=True` 也一样）。会让所有服务都判成 `FAIL exit=`。

现在的做法：每个任务先写一个临时 wrapper `.ps1`，里面 `& daily.ps1` 后把 `$LASTEXITCODE` 写进哨兵文件，父进程读文件拿退出码。

```powershell
$wrap = @(
    '$ErrorActionPreference = ''Continue'''
    '& ' + "'" + $script + "'"
    '$c = $LASTEXITCODE'
    'if ($null -eq $c) { $c = 0 }'
    '[System.IO.File]::WriteAllText(' + "'" + $statusFile + "', [string]`$c)"
) -join "`r`n"
```

### 3. 子进程日志要用 UTF-8 显式读

`Get-Content -Raw` 在 5.1 下按 ANSI 解码 UTF-8 文件，中文全变乱码（`娲诲姩=Buddy搴旂敤`）。必须：

```powershell
[System.IO.File]::ReadAllText($outFile, [System.Text.Encoding]::UTF8)
```

### 4. 改完必须用 5.1 实测，不能只信 pwsh 7

```powershell
# 1) 确认纯 ASCII
$b = [System.IO.File]::ReadAllBytes('C:\Users\Lenovo\Documents\deepseek-harness\default-workspace\checkin-all\run.ps1')
"nonAscii=$(@($b | Where-Object { $_ -gt 127 }).Count)"     # 必须是 0

# 2) 用 5.1 真跑一遍
powershell.exe -NoProfile -ExecutionPolicy Bypass -File 'C:\Users\Lenovo\Documents\deepseek-harness\default-workspace\checkin-all\run.ps1' -Only WorkBuddy -NoMail

# 3) 确认计划任务侧也正常
schtasks /Run /TN 'DailyCheckinAll'
schtasks /Query /TN 'DailyCheckinAll' /V /FO LIST | Select-String 'Last Result'   # 必须是 0
```

只跑 pwsh 7 会通过但线上仍挂——2026-11-18 的教训。

## 登录态失效提醒（exit 2）

`run.ps1` 会把退出码为 **2** 的服务单独收进 `last-run.json` 的 `reauth` 数组，`mail.js` 据此改主题与正文：

- 主题变成 `🔐 需要重新登录 · <服务名> · 时间`
- 顶部色条变 `#8a3a00`，标题改「签到汇总 · 需要重新登录」
- 表格上方多一块黄底提示，写明该服务的失效原因和恢复命令

对应关系：

| 服务 | 失效原因 | 恢复方式 |
| --- | --- | --- |
| Loomy | session 约 14 天到期 | `node login.js send/verify`（手机验证码） |
| Qoder | token 到期且无离线刷新接口 | 打开一次客户端续期 |
| Trae | token 7 天到期 | 打开一次客户端续期 |
| MiniMax | refresh token 家族失效 | 客户端扫码重登 |
| Doubao | cookie 过期 | 打开一次客户端重抓 |
| WorkBuddy | token 失效 | 打开一次客户端续期 |
