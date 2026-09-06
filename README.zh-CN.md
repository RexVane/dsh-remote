# dsh-tailscale-serve

[English](README.md) | 简体中文

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)(DSH)插件:把 DSH 网页 GUI 通过 **Tailscale tailnet** 暴露给手机——同一个网址在家(Wi-Fi 直连)在外(DERP 中继)都能用,TLS 自动配置,手机优先布局,支持远程工作区选择器,无需 `--trusted-host`。

> **兼容目标**:Windows · DSH `0.1.0-rc.8`(信任围栏与私有 RPC 行为另在 `0.1.1-rc.2` 实测)· Tailscale `1.102.x` · Node.js `^22.19.0 || >=24.0.0`。DSH 每次升级后请重跑 `npm run check:all`,再视为已验证。

## 前提条件

**电脑和手机都装 Tailscale,登录同一个账号**(即同一个 tailnet)——电脑跑 DSH,手机打开网址,就这两步。

偶尔会咬人的只有两件:

1. 运行 `dsh web` 的账户要有权管理 Tailscale Serve——用该账户跑一下 `tailscale serve status --json` 确认(输出 `{}` 即正常)。若返回 `Access is denied`,用管理员 shell 运行 DSH,或给该账户授予 Serve/operator 权限(见[故障排查](#故障排查))。
2. Node.js 22.19+(主版本 22 内)或 24+——DSH 本身要求的范围。

## 安装

```powershell
# 1. DSH 本体(全局安装;npx 一次性缓存已被证明脆弱)
npm install -g @deepseek-ai/dsh@0.1.0-rc.8

# 2. 本插件装进 web profile(在插件目录内执行;
#    发布到 npm 后,这里直接写包名也可以)
dsh plugin --profile web add .

# 3. 启动——插件随 DSH 一起激活
dsh web
```

启动时应看到:

```
dsh web: http://127.0.0.1:3080
tailscale-serve: added <machine>.<tailnet>.ts.net to the DSH /api trust fence
tailscale-serve: DSH web is now reachable on your tailnet: https://<machine>.<tailnet>.ts.net
```

手机浏览器打开这个网址,完事。`DSH web is now reachable` 只在 Serve 命令成功退出**且** Tailscale 节点级配置里出现完全符合预期的代理路由后才打印——仅凭 tailnet DNS 名不会当作成功。

> **若 `dsh plugin` 报 `ENOENT ... scandir '<profile>\D:\...'`**(pnpm 10 错误解盘符 `file:`/`link:` 规范):在 `$env:USERPROFILE\.dsh\profiles\web` 里手动 `pnpm add "link:<路径>"`,再把 `"dsh-tailscale-serve"` 追加到该目录 `package.json` 的 `dsh.profile.bundles` 数组。

## 手机使用

1. 手机打开 Tailscale App,确认设备**在线**。
2. 手机浏览器打开 `https://<machine>.<tailnet>.ts.net`。
3. 聊天、工具调用、交付物**实时**流式呈现——和电脑上同一个会话。新建工作区会打开插件的虚拟**此电脑**视图:选盘符、浏览真实目录、可新建并选择。电脑自己的页面保持原生系统目录对话框。
4. 同一网址在外网也能用:没有直连路径时 Tailscale 走 DERP 中继。

手机**不需要**运行 DSH 或任何插件——只需要 Tailscale 成员身份。移动适配层的修改与验证(选择器策略、两个已知的坑、验证套件)见 [docs/HOW-IT-WORKS.zh-CN.md](docs/HOW-IT-WORKS.zh-CN.md)。

## 配置

在 `cordis.patch.yml` 设置,可从 profile 的 `--patch` 覆盖。完整语义见 [docs/HOW-IT-WORKS.zh-CN.md](docs/HOW-IT-WORKS.zh-CN.md)。

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关。`false` 时 DSH 只留回环——没有 Serve 路由、没有信任围栏条目、连插件的 RPC 通道都没有。 |
| `https` | `true` | Tailscale HTTPS(443 端口)。`false` 请求 80 端口纯 HTTP。 |
| `hostname` | *(自动探测)* | 可选的 `<machine>.<tailnet>.ts.net` URL 提示。通常省略;验证过的路由的实际主机名总是获胜。 |
| `keepOnExit` | `false` | DSH 退出后保留插件施加的 Serve 路由。 |
| `serveArgs` | *(省略)* | 高级覆盖:完整的 `tailscale serve` 参数向量。 |

## 安全

tailnet 就是门禁:Tailscale 身份、ACL 和 TLS 决定谁能到达页面——插件自身不提供用户级认证,所以请把 ACL 限定到你信任其接触 DSH、也信任其查看该账户目录的设备。DSH 的配置面方法仍仅限回环;插件只重新暴露一小片经过严格校验的切片(目录浏览/创建、模型发现、模型配置保存、Agent 预设)。完整边界分析:[docs/HOW-IT-WORKS.zh-CN.md](docs/HOW-IT-WORKS.zh-CN.md)。

## 故障排查

| 症状 | 处理 |
|---|---|
| 手机页面能打开但聊天没反应 / "不是实时的" | **重启 DSH** 让信任围栏注入运行;找启动日志里的 `added ... trust fence` 行。 |
| 手机上 `pickDirectory` / HTTP 403 | 远程目录流没加载——确认手机用 `*.ts.net` 网址,重启 DSH。 |
| 模型/设置页报 HTTP 403 | **更新插件后重启 DSH**,服务端端点才会加载。 |
| 手机完全打不开网址 | 手机 Tailscale 离线,或不在同一 tailnet。两端各查一次 `tailscale status`。 |
| DSH 升级后布局不对 | 跑 `npm run verify`——它会点名每条失配规则。 |
| 布局可疑,不确定是不是本插件 | 用 `?nomobilefit=1` 重载以禁用适配,对比。 |

完整故障表见 [docs/HOW-IT-WORKS.zh-CN.md](docs/HOW-IT-WORKS.zh-CN.md)。

## 卸载

```powershell
dsh plugin --profile web remove dsh-tailscale-serve
```

`dsh plugin remove` 转发给 pnpm **并**自动清理 `dsh.profile.bundles` 层叠条目——这一条命令就是完整卸载。只有两样它不知道的残留:

```powershell
# 仅当 DSH 硬崩溃留下路由时需要(正常关机会自己清理);
# keepOnExit 设为 true 时也需要:
tailscale serve --yes --https=443 --set-path=/ off

# 仅当插件是用 tarball 装的:删掉拷贝过去的压缩包
Remove-Item "$env:USERPROFILE\.dsh\profiles\web\dsh-tailscale-serve-*.tgz"
```

之后不再需要源码的话,把插件目录本身删掉即可。

## 许可证

MIT,全文见 `LICENSE`。

## 发布

源码在 [github.com/RexVane/dsh-tailscale-serve](https://github.com/RexVane/dsh-tailscale-serve)。`package.json` 的 `repository`、`homepage`、`bugs` 已指向它。
