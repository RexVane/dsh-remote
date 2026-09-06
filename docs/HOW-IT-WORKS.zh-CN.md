# 工作原理 — 深度文档

[English](HOW-IT-WORKS.md) | [简体中文](HOW-IT-WORKS.zh-CN.md)

README 的配套文档:设计动机、移动适配层的修改规则、完整的安全边界分析、完整故障表。

## 为什么需要它

DSH 把网页 UI 绑定在 `127.0.0.1`,并刻意拒绝 `--host 0.0.0.0`——它没有 TLS、没有认证、没有同源策略,直接暴露到网络等于远程代码执行。`tailscale serve` 安全地补上这一段:

- TLS 由 tailnet 证书自动终结;
- 访问由 Tailscale 身份与 ACL 把关,只有授权的 tailnet 用户/设备能到达;
- 反向代理指向回环端口,DSH 始终不必对外绑定。

手机装 Tailscale、加入同一 tailnet、打开网址即可。Wi-Fi 下走直连(低延迟),离开家走 DERP 中继(自动 NAT 打洞)。同一地址,零第二套配置。

## 手机布局适配

从手机*到达* DSH 只是*使用* DSH 的一半。原版 GUI 是桌面三栏外壳(要 280px 侧栏 + 748px 聊天列,共约 1060px),低于这个宽度面板互相挤压、`nowrap` 内容盖到邻居身上。所以插件还带一个浏览器半区 `lib/client.js`:移动适配 CSS 让 DSH 现有的 React 外壳继续当家,另加一个仅远程的目录流组件提供手机工作区选择器。

- 整个客户端半区只在非回环页面挂载(`ctx.connection.isLoopback === false`,即手机的 Tailscale 网址):电脑的 `127.0.0.1` 页面在任何窗口尺寸都不挂载样式表、跑马灯监视器或目录流。手机页内部,所有布局规则都在 `@media (max-width: 820px)` 里,桌面宽度的平板也不受影响。
- 折叠侧栏轨道归零,DSH 自己的切换按钮浮出为左上角的圆形开关;展开的侧栏变成覆盖抽屉。不克隆任何状态——按钮仍调用 DSH 的 `toggleSidebar()`。
- 一小段 JS 处理 CSS 表达不了的事:键盘感知的 `interactive-widget=resizes-content` viewport、放不下的模型名跑马灯、以及两个焦点守卫(防止点侧栏或命令按钮时软键盘盖住内容)。

用 **`?nomobilefit=1`** 打开手机页可跳过移动适配半区(手机的目录选择器保留——那是远程功能本身)。这是区分"本样式表的布局问题"和"DSH 自身问题"的可靠方法:同一网址带旗标与不带旗标各开一次,对比即可。

### 选择器策略(改 `lib/client.js` 前必读)

DSH 的 CSS modules 类名带每构建哈希,且有**两种命名方案**,都要处理:

| 来源 | 方案 | 示例 | 匹配方式 |
|---|---|---|---|
| UI 插件 bundle | `hash_name` | `hHd-Xa_sidebarCol` | `[class*="_sidebarCol"]` |
| 应用外壳(`/assets`) | `_name_hash` | `_item_19372` | `[class*="_item_"]` |

第二种形式的结尾下划线是结构性的,不是笔误。后缀跨 bundle 不唯一时,规则锚定在该元素必然包含的子元素上(`:has()`)。禁止字面 CSS-module 构建哈希;静态校验器会拒绝它们,升级就不会留下失效的构建专属分支。

两个容易违反的约束:

- **不要在 `CSS` 模板字面量里输入反引号。** 它会提前终止字面量,弄坏整个插件。
- **匹配不到任何东西的规则会静默失败。** 无报错、无警告,桌面端审查看起来一切正常。

两者都有自动检查——见下文。

### 验证改动

```powershell
npm run check        # 语法检查、服务端测试、静态移动校验器
npm run verify       # 仅静态校验器(可离线)
npm run verify:live  # 用真实无头浏览器执行手机宽度矩阵
npm run check:all    # 两套全部执行
```

**`npm run verify`** 在桩浏览器里加载 `lib/client.js`,断言生成的 CSS 括号平衡、完整位于 `@media` 守卫内、没有杂散反引号破坏字面量、**每一条** `[class*="…"]` 选择器仍出现在运行中的 DSH 实际提供的 bundle 里,并确认两个历史回归保持修复。连不上 DSH 时跳过实机选择器部分并明确说明。

**`npm run verify:live`** 启动无头 Chrome/Edge,加载真实 GUI,测量 320px 到 1200px 的十个视口:横向溢出、悬浮开关的位置与尺寸、折叠轨道宽度、开关显示的字形、viewport meta——外加一个桌面宽度证明样式表不越过断点。它用 Node 内置 WebSocket 走 CDP,不需要 Playwright、不需要 `npm install`。它只调整尺寸、测量、截图,从不点击会创建会话的东西。加 `--keep-shots` 把截图写进 `gui-test-screenshots/`。

两者都可指向其他 origin:

```powershell
node tools/verify-mobile-fit.mjs https://host.tailnet.ts.net
node tools/verify-mobile-geometry.mjs https://host.tailnet.ts.net --keep-shots
```

在托管 CI/沙箱会话中 Chrome 一连上 CDP 就退出时,加 `--no-sandbox`。这是仅限验证场景的显式逃生门;本地正常使用保持浏览器沙箱开启。

每次 DSH 升级后都需要重新运行——稳定后缀在上游组件重建时也可能消失或变化。

这些检查对应的发现记录见 `MOBILE-FIT-AUDIT.md`。

## 浏览器信任围栏

DSH 对 `/api` 主机做浏览器信任围栏校验(`dsh-client-connection` 里的 DNS 重绑定防御)。tailnet 域名(`*.ts.net`)不是局域网字面量,没有帮助时手机的请求会被 **403 Forbidden** 拒绝:页面能打开,但聊天/实时流静默失败——看起来像"会话不是实时的"。

**本插件自动修复**:把你的 tailnet 主机名追加进 `ctx.webRuntime.trustedHosts`——正是 DSH 围栏读取的数组(web-app bundle 把围栏接到 `!!js ctx.webRuntime.trustedHosts`,围栏每次请求持有同一数组引用)。不需要 `--trusted-host` 旗标。每次启动都会重新施加;更新插件代码后需重启 DSH 生效。

不装本插件也可以手动达到同样效果:

```powershell
dsh web --trusted-host <machine>.<tailnet>.ts.net
```

### 围栏的安全边界

围栏是 DNS 重绑定防御,**不是认证层**。本插件只把 tailnet 主机名加进 trusted-host 列表;DSH 依旧只绑 `127.0.0.1`,全部暴露面由 Tailscale 的 tailnet 成员身份、ACL 和(默认)TLS 把守。

具体说,在本插件适配的 DSH 构建上(已在 `0.1.1-rc.2` 验证),插件的 `/dsh-remote` 通道**没有用户级认证**——没有 cookie、没有会话、没有 401 层。围栏只挡 DNS 重绑定和跨站浏览器请求。tailnet 上任何能到达 Serve 端口、能把 tailnet 主机名写成 `Host` 头的客户端——包括非浏览器工具——都能直接调用 `listDrives`/`listDirectory`/`createDirectory` 和被代理的设置切片。tailnet 成员身份、ACL 和 TLS 是本插件暴露的一切的全部安全模型。

DSH rc.8 对配置面方法还有第二道更窄的边界。`host.pickDirectory`、`host.openPath`、`settings.*`、`credentials.*`、`llm.discoverModels` 等调用要求回环同源请求,无视普通 trusted-host 列表。已配置好的非机密模型目录(`llm.providers`/`llm.models`)是另一条浏览器安全面;它不会让提供方设置或模型发现动作变成远程可写。所以手机 `*.ts.net` 页面上选择原生 picker 时,报这个错是预期行为:

```text
transport failure for /api/host, pickDirectory
HTTP 403
```

再加一个 `--trusted-host`、放宽 Tailscale ACL、改 `hostname` 或重试 Serve 都解锁不了这些方法。不改源码的受支持分工是:

- **目录与工作区**:DSH 原生 `directory-picker-auto` 保持启用,回环的电脑页保留原生 Windows/macOS 对话框。只有非回环页面(手机的 Tailscale 网址)会遮蔽两个客户端目录流槽位。它的 `listDrives`、`listDirectory`、`createDirectory` 走插件自己的 `trusted-host` RPC 通道;最终真实路径仍交给 DSH 普通的 `workspace.create`。Windows 上手机先看到虚拟**此电脑**盘符列表;虚拟标签本身永远不会被当作文件系统路径提交。
- **一小片明确的设置面**:手机可以 (1) 运行模型发现(`llm.discoverModels`),(2) 读取设置 describe 视图(`settings.describe`,提供方已脱敏机密——只有存在标志过线),(3) 精确写 `agent-presets` 命名空间(`settings.update` 限定 `ns: "agent-presets"`,让设置页的 **Agent 预设**选择器在手机上可用),以及 (4) 从**模型配置 / Models** 页保存提供方修改——`settings.mutate` 限定 `llm-*` 提供方命名空间,加上 `credentials.describe`(只有配置标志,无值)和 `credentials.set`/`credentials.unset`(限环境变量形状的 API key 引用,如 `DEEPSEEK_API_KEY`)。这一切由插件自己的 `trusted-host` RPC 通道提供,受众只有 tailnet 页面(Tailscale 成员身份 + ACL + TLS)。配置面的其他一切——其余设置命名空间、权限行——仍仅限回环;这些管理操作请在主机电脑(`http://127.0.0.1:3080` 或 DSH 打印的端口)执行。配置完成后,远程页面仍可读取非机密模型目录并使用选定的模型。

手机 picker 是功能访问,不是文件系统沙箱:Windows 从就绪的盘符根开始;其他主机、或盘符探测失败/为空时,回退到主机账户的主目录。它接受全限定路径,没有部署级的浏览根限制。请把 Tailscale ACL 限定到你信任其接触 DSH、也信任其查看该账户目录的设备/用户。

如果手机仍然调用 `pickDirectory`,确认它用的是 `*.ts.net` 网址而不是 `127.0.0.1`、`dsh-remote` 客户端 bundle 处于活动状态、且当前插件版本提供 `/dsh-remote/listDrives`。最终组合应保持原生 `directory-picker` 条目启用;不要用浏览后端全局替换它,那会连电脑一起改掉。

## 插件是怎么工作的

- **Tailscale CLI 探测**:插件探测 PATH 上的 `tailscale` 加常见安装位置(`C:\Program Files\Tailscale\tailscale.exe`、`D:\Program Files (x86)\Tailscale\tailscale.exe`、`%LOCALAPPDATA%\Programs\{Tailscale,tailscale}\tailscale.exe`、macOS 应用包、`/usr/bin` 与 `/usr/local/bin`)。探测成功者胜出;全部失败时保留第一个非 `ENOENT` 候选,让超时或 `EACCES`/`EPERM` 之后作为真实错误报告,而不是误报"CLI 缺失"。
- **端口**:插件注入 `webServer` 服务,所以只在 HTTP 服务器开始监听后激活——读到的是真实端口(包括 OS 分配的 `0`)。
- **Serve 状态检查**:做任何改动前,插件从 Tailscale 本地 API 读取原始节点级 Serve 配置和 ETag。唯一且相同的路由直接复用,不跑变更命令,也绝不认领清理;多条相同路由按歧义拒绝。存在 Web handler 但没有活动 TCP 监听被视为休眠,不会被激活。现有冲突的根 handler、活动的 Funnel 监听、不兼容的端口模式都原样不动。
- **Windows LocalAPI 传输**:Tailscale 的受保护命名管道要求客户端请求 `Identification` 模拟级别。Node 普通的 `socketPath` 传输不设置它,所以插件仅对本地管道连接使用内置的 Windows PowerShell/.NET 桥。这保住了 Tailscale 的认证检查;不提权、不改策略、不绕过 LocalAPI 授权。类 Unix 系统继续直接用原生 Unix socket。
- **Serve**:HTTPS 模式执行显式 `tailscale serve --bg --yes --https=443 <target>`;HTTP 模式用 `--http=80`。目标始终是真实的 DSH 监听(含主机),所以仅 IPv6 或不匹配的绑定不可能静默变成一个成功返回 502 的端点。CLI 退出码 0 之后,插件重读 `Web/TCP`,在宣告之前做一次全新的路由/监听/Funnel 终检,从实际路由(而非 hostname 提示)推导端点,并验证精确的代理路由。若这期间 Funnel 被启用,插件用带 ETag 守护的安全回滚只移除自己的 handler,不宣告端点。
- **信任围栏**:把解析出的 tailnet 主机名(`<machine>.<tailnet>.ts.net`)推进 `webRuntime.trustedHosts`,已应用的 `/api` 围栏每次请求读取它(同一数组引用)。
- **分离式目录选择器**:电脑保留 DSH 原生目录选择器后端与客户端。非回环页面上,插件注册一个目录流占用者,其 bundle 晚于 DSH 原生 picker 加载;运行时对单槽位的后注册者分配更低的自动遮蔽优先级,所以插件流在手机页胜出,原生客户端留在回环电脑页。目录枚举与子目录创建走 `/dsh-remote`,`trusted-host` 权限、严格全限定路径检查、1000 条上限。
- **静态传输增强**:插件包装 webServer 的请求监听器,给 `/assets` 和 `/plugins` 的 GET 响应加上 Brotli 压缩(客户端不支持 `br` 时退回 gzip)、ETag 和缓存头——带指纹的名字(含每个 `?rev=` 插件 bundle URL)是 `immutable`,其余用 304 重验证。DSH 原本都没有,DERP 中继下手机每次打开页面都要重新下载约 4.4MB 启动负载;增强后核心资源首次加载约 0.4MB,重复加载接近零。Serve 路由验证成功后,插件还会从 DSH 自己的 `index.html` 预热响应缓存,DSH 重启后的首次手机加载不用付现压成本。增强按请求的 Host 头门控:只有非回环(tailnet)请求享受,电脑的 `127.0.0.1` 浏览器仍收到 DSH 字节级一致的原生响应。响应体逐字节相同,`/api` 与事件流原样通过,且增强只在插件启用时运行。
- **清理**:正常 dispose 时只移除本进程验证拥有的 `/` handler。更新基于最新配置构建并以 `If-Match: <ETag>` 提交;并发变更返回 HTTP 412,从新状态重试,所以无关路由被保留而非替换。若根 handler 或监听模式变了,清理停止、不写入。若同端口 Funnel 状态变了,清理执行仅 handler 的安全移除,保留当前 TCP/Funnel 监听;从不禁用其他进程的 Funnel。`keepOnExit:true` 跳过移除。

硬崩溃或强杀进程无法运行 disposer。先检查 `tailscale serve status --json`,确认哪个真实主机的 `/` handler 指向 DSH。如果有,用当前 CLI 只移除那一条,例如 `tailscale serve --yes --https=443 --set-path=/ off`(或对应 `--http=80` 形式)。省略 `--set-path=/` 可能移除共享该监听的其它路径。除非打算移除所有节点级 Serve handler,否则不要用 `tailscale serve reset`。

## 配置语义

`hostname` 只是早期的 URL/信任围栏提示;它不过滤路由归属、不授予 Serve 权限、也不能让失败的 Serve 命令变成成功。读取 Tailscale 节点级配置后,插件从实际验证过的路由推导 URL,提示过期会警告。自定义 `serveArgs` 会做结构校验,插件随后证明出现了一条端口、模式、DSH 代理目标都符合的唯一路由。`serve --help`、status/reset 子命令、前台命令或不同目标都不可能产生成功信息。

## 完整故障表

| 症状 | 原因 / 处理 |
|---|---|
| `dsh-remote: warning: tailscale CLI not found` | Tailscale 装在了不常见的位置。设置 `serveArgs` 不够——把 CLI 目录加进 PATH,或带着安装路径开 issue。 |
| 手机页面能打开但聊天没反应 / "不是实时的" | `/api` 围栏在拒绝主机。旧插件代码下这是预期的——**重启 DSH** 让信任围栏注入运行,并找启动日志里的 `added ... trust fence` 行。 |
| 手机上 `transport failure for /api/host, pickDirectory` / HTTP 403 | 远程目录流客户端没加载,原生流赢了。确认手机用 `*.ts.net` 网址、调和/重装本插件、重启 DSH,并确认 `/dsh-remote/listDrives` 可用。保持 DSH 原生 `directory-picker` 启用;不要用全局替换电脑 picker 的方式解决。 |
| 模型/设置页或模型发现动作报 HTTP 403 | DSH 把提供方设置、凭据、设置变更、`llm.discoverModels` 锁在回环。插件经可信通道代理一小片:模型发现、只读 describe 视图、`agent-presets` 命名空间的 `settings.update`,以及完整模型配置保存路径(`llm-*` 上的 `settings.mutate` + `credentials.set`/`unset`/`describe`)。其余必须在主机 `127.0.0.1` UI 配置。**更新插件后重启 DSH,服务端端点才会加载。** |
| Windows 上 `tailscale serve status` 说 `Access is denied` | 当前账户能查节点状态但无权检查/管理 Serve。用提升/授权账户跑 `dsh web`,或按那个 Tailscale 版本支持的方式配置 operator。 |
| `tailscale serve status --json` 输出 `{}` | 这是合法的空 Serve 配置,不是错误。启动/重启 `dsh web`;插件应创建并验证 DSH 路由。 |
| 警告提到 `Unable to impersonate using a named pipe until data has been read` | 来自使用 Node 普通 Windows 管道传输的旧插件构建。重装/调和本包并完全重启 DSH,加载内置的 `Identification` 级传输。 |
| `tailscale serve` 命令失败 | 先查权限,再把生成的命令与 `tailscale serve --help` 对照。`serveArgs` 支持兼容的监听旗标变体,但仍必须是 `serve`、后台模式、所配置的 HTTP/HTTPS 传输、以及精确的 DSH 目标。 |
| 日志有 tailnet DNS 名,但没有可达行 | 身份发现成功而 Serve 配置失败。端点不视为活动;修复伴随的 Serve/权限错误,让重试跑完或重启 DSH。 |
| 警告说配置的 hostname 与验证过的路由不同 | `hostname` 提示过期。插件使用并信任真实 Tailscale 路由,但请移除或更新提示以免误导启动输出。 |
| 手机完全打不开网址 | 手机 Tailscale 离线,或手机不在同一 tailnet。两端各查一次 `tailscale status`。 |
| DSH 硬崩溃后 tailnet 网址仍在转发 | 正常的路由移除没跑成。检查 `tailscale serve status --json`,确认 `/` handler 指向 DSH,再用 `tailscale serve --yes --https=443 --set-path=/ off` 或匹配的 `--http=80` 命令。 |
| 关机警告 Serve 或 Funnel 被并发修改 | ETag 比对设置看到别的写入者,或所属 handler/监听已无法安全辨认。插件会重试条件清理;同端口 Funnel 变更时只移除自己的 handler 并保留当前 TCP/Funnel 监听。若警告说回滚/清理失败,检查 `tailscale serve status --json`。 |
| `npm install -g` 因完整性/锁错误失败 | 清 npm 缓存(`npm cache clean --force`)或换新前缀;**不要**把 npx 缓存和全局安装混用。 |
| DSH 升级后手机布局不对 | 上游稳定类后缀变了。跑 `npm run verify`——它会点名每条失配规则并拒绝字面构建哈希。 |
| 布局可疑,不确定是不是本插件 | 用 `?nomobilefit=1` 重载以禁用适配,对比。 |
| 一次编辑后整个插件不加载 | 几乎总是 `CSS` 模板字面量里打了反引号,提前终止了字面量。`npm run verify` 会报告;`node --check lib/client.js` 显示解析错误。 |
| 悬浮侧栏按钮里两个字形重叠 | 鱼形标没被隐藏。DSH 只在 `:hover` 时切换,触屏永远不满足,规则必须针对 `_railMark`——验证该选择器仍能解析。 |
