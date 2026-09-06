# How it works — deep dive

[English](HOW-IT-WORKS.md) | [简体中文](HOW-IT-WORKS.zh-CN.md)

Companion to the README: the design rationale, the mobile-fit layer's editing rules, the full security-boundary analysis, and the complete symptom table.

## Why

DSH binds its browser UI to `127.0.0.1` and intentionally refuses `--host 0.0.0.0`: it has no TLS, no auth, no origin policy, so exposing it to the network is remote code execution. `tailscale serve` bridges that safely:

- TLS is terminated with a tailnet certificate (automatic).
- Access is governed by Tailscale identity and ACLs — only authorized tailnet users/devices can reach it.
- The reverse proxy targets the loopback port, so DSH never has to bind wide.

The phone installs Tailscale, joins the same tailnet, and opens the URL. On Wi-Fi Tailscale takes a direct path (low latency); off-network it relays through DERP (NAT traversal). Same address, no second config.

## Phone layout adaptation

Reaching DSH from the phone is only half of *using* DSH from the phone. The shipped GUI is a desktop three-column shell (it wants a 280px sidebar plus a 748px chat column, ~1060px total), so below that width panels squeeze each other and `nowrap` content paints over its neighbours. This plugin therefore also ships a browser half, `lib/client.js`: mobile-fit CSS leaves DSH's existing React shell in charge, while one remote-only directory-flow component supplies the phone workspace picker.

- The whole client half mounts only on a non-loopback page (`ctx.connection.isLoopback === false`, the phone's Tailscale URL): the PC's `127.0.0.1` page never mounts the stylesheet, the marquee watcher, or the directory flow, at any window size. Within the phone page, every layout rule lives inside `@media (max-width: 820px)`, so desktop-width tablets are untouched too.
- The collapsed sidebar rail goes to zero width and DSH's own toggle is floated out as a round opener in the top-left corner; the expanded sidebar becomes an overlay drawer. No state is cloned — the button still calls DSH's `toggleSidebar()`.
- A small JavaScript half handles what CSS cannot express: a keyboard-aware `interactive-widget=resizes-content` viewport, a marquee for model names too long to fit, and two focus guards that stop a sidebar tap or the command button from opening the soft keyboard over the content.

Load the phone page with **`?nomobilefit=1`** to skip the mobile-fit half (the phone's directory picker stays — it is the remote functionality itself). That is the reliable way to tell a layout fault in this sheet apart from one in DSH itself: open the same URL with and without the flag and compare.

### Selector strategy (read before editing `lib/client.js`)

DSH ships CSS modules with per-build hashed class names, in **two different schemes** that must both be handled:

| Source | Scheme | Example | Match with |
|---|---|---|---|
| UI plugin bundles | `hash_name` | `hHd-Xa_sidebarCol` | `[class*="_sidebarCol"]` |
| App shell (`/assets`) | `_name_hash` | `_item_19372` | `[class*="_item_"]` |

The trailing underscore in the second form is load-bearing, not a typo. Rules are anchored on a child the element must contain (`:has()`) wherever a suffix is not unique across bundles. Literal CSS-module build hashes are not allowed; the static verifier rejects them so an upgrade cannot leave a stale build-specific branch behind.

Two constraints are easy to violate:

- **Never put a backtick inside the `CSS` template literal.** It ends the literal early and breaks the entire plugin.
- **A rule that matches nothing fails silently.** No error, no warning, and a desktop review looks perfect.

Both are checked automatically — see below.

### Verifying a change

```powershell
npm run check        # syntax checks, server tests, then the static mobile verifier
npm run verify       # static verifier alone (works offline)
npm run verify:live  # drive a real headless browser through the phone matrix
npm run check:all    # both suites
```

**`npm run verify`** loads `lib/client.js` under a stub browser and asserts that the generated CSS is brace-balanced and fully inside its `@media` guard, that no stray backtick broke the literal, that **every** `[class*="…"]` selector still occurs in the bundles the running DSH actually serves, and that two past regressions stay fixed. With no DSH reachable it skips the live-selector section and says so.

**`npm run verify:live`** starts headless Chrome or Edge, loads the real GUI, and measures ten viewports from 320px to 1200px: horizontal overflow, the floating opener's position and size, the collapsed rail track, which glyph the opener shows, and the viewport meta — plus a desktop width to prove the sheet does not leak past its breakpoint. It speaks CDP over Node's built-in WebSocket, so it needs no Playwright and no `npm install`. It only resizes, measures and screenshots; it never clicks anything that creates a session. Add `--keep-shots` to write screenshots into `gui-test-screenshots/`.

Point either at another origin:

```powershell
node tools/verify-mobile-fit.mjs https://host.tailnet.ts.net
node tools/verify-mobile-geometry.mjs https://host.tailnet.ts.net --keep-shots
```

In a managed CI/sandbox session where Chrome exits immediately after CDP
connects, add `--no-sandbox`. This is an explicit verification-only escape
hatch; normal local runs keep the browser sandbox enabled.

Re-run after every DSH upgrade — stable suffixes can still disappear or change when upstream components are rebuilt.

See `MOBILE-FIT-AUDIT.md` for the findings these checks were built from.

## Browser trust fence

DSH validates the `/api` host against a browser-trust fence (DNS-rebinding defense in `dsh-client-connection`). The tailnet domain (`*.ts.net`) is not a LAN literal, so without help the phone's requests would be refused with **403 Forbidden**: the page loads, but the chat/live stream silently fails — it looks like "the conversation is not real-time".

**This plugin fixes that automatically**: it appends your tailnet hostname to `ctx.webRuntime.trustedHosts` — the exact array DSH's fence reads (the web-app bundle wires the fence to `!!js ctx.webRuntime.trustedHosts`, and the fence holds the same array reference per request). No `--trusted-host` flag is needed. The change is re-applied on every startup; a plugin-code update requires a DSH restart to take effect.

If you run DSH without this plugin, you can get the same effect manually:

```powershell
dsh web --trusted-host <machine>.<tailnet>.ts.net
```

### Security boundary of the fence

The fence is a DNS-rebinding defense, **not** an auth layer. This plugin only adds the tailnet hostname to the trusted-host list; DSH itself still binds `127.0.0.1` and the whole exposure is gated by Tailscale's tailnet membership, ACLs, and (by default) TLS.

Concretely, on the DSH builds this plugin runs against (verified on `0.1.1-rc.2`), the plugin's `/dsh-remote` channel carries **no user-level authentication** — no cookies, no session, no 401 layer. The fence blocks DNS-rebinding and cross-site browser requests only. Any client on the tailnet that can reach the Serve port and present the tailnet hostname as its `Host` header — including non-browser tools — can call `listDrives`/`listDirectory`/`createDirectory` and the proxied settings slice directly. Tailnet membership, ACLs, and TLS are the entire security model for everything this plugin exposes.

DSH rc.8 has a second, deliberately narrower boundary for configuration-plane methods. Calls including `host.pickDirectory`, `host.openPath`, `settings.*`, `credentials.*`, and `llm.discoverModels` require a loopback same-origin request and ignore the ordinary trusted-host list. The already-configured, non-secret model catalog (`llm.providers`/`llm.models`) is a different browser-safe surface; it does not make provider settings or model discovery actions remotely writable. Therefore this error is expected from a `*.ts.net` page when the native picker is selected:

```text
transport failure for /api/host, pickDirectory
HTTP 403
```

Adding another `--trusted-host`, weakening a Tailscale ACL, changing `hostname`, or retrying Serve does not unlock those methods. The supported no-source-code split is:

- **Folders and workspaces:** DSH's stock `directory-picker-auto` remains enabled, so the loopback PC page keeps the native Windows/macOS dialog. Only a non-loopback page (the phone's Tailscale URL) shadows the two client directory-flow slots. Its `listDrives`, `listDirectory`, and `createDirectory` operations use this plugin's own `trusted-host` RPC channel; the final real path is still handed to DSH's ordinary `workspace.create`. Windows shows a virtual **This PC** drive list and macOS its `/Volumes`; the virtual label itself is never submitted as a filesystem path.
- **A narrow, explicit settings slice:** the phone may (1) run model discovery (`llm.discoverModels`), (2) read the settings describe view (`settings.describe`, secrets redacted by the provider — only presence flags cross), (3) write exactly the `agent-presets` namespace (`settings.update` scoped to `ns: "agent-presets"`) so the Settings page's **Agent preset** picker works from the phone, and (4) save provider edits from the **模型配置 / Models** page — `settings.mutate` restricted to `llm-*` provider namespaces, plus `credentials.describe` (configured flags only, no values) and `credentials.set`/`credentials.unset` for env-var-shaped API-key refs (`DEEPSEEK_API_KEY`-style names). This slice is served by this plugin's own `trusted-host` RPC channel, whose only audience is the tailnet page (Tailscale membership + ACLs + TLS). Everything else in the configuration plane — other settings namespaces, permission rows — stays loopback-only; perform those administrative actions on the host PC (`http://127.0.0.1:3080`, or the port printed by DSH). Once configured, the remote page may still read the non-secret model catalog and use the selected model.

The phone picker is functional access, not a filesystem sandbox: Windows starts from its ready drive roots and macOS from `/Volumes`; Linux and other hosts, or a failed/empty probe, fall back to the host account's home directory. It accepts fully qualified paths and has no deployment-level browse-root restriction. Restrict the Tailscale ACL to devices/users you trust with DSH and with visibility into that account's directories.

If the phone still invokes `pickDirectory`, confirm that it is using the `*.ts.net` URL rather than `127.0.0.1`, that the `dsh-remote` client bundle is active, and that the current plugin version exposes `/dsh-remote/listDrives`. The final composition should keep the stock `directory-picker` entry enabled; do not globally replace it with the browse backend, because that also changes the PC.

## How the plugin works

- **Tailscale CLI discovery**: the plugin probes `tailscale` on PATH plus the common install locations (`C:\Program Files\Tailscale\tailscale.exe`, `D:\Program Files (x86)\Tailscale\tailscale.exe`, `%LOCALAPPDATA%\Programs\{Tailscale,tailscale}\tailscale.exe`, the macOS app bundle, `/usr/bin` and `/usr/local/bin`). A successful probe wins; if every probe fails, the first non-`ENOENT` candidate is retained so a timeout or `EACCES`/`EPERM` error is reported later instead of being mislabeled as a missing CLI.
- **Port**: the plugin injects the `webServer` service, so it activates only after the HTTP server is listening — it reads the real port (including an OS-assigned port `0`).
- **Serve state inspection**: before making a change, the plugin reads the raw node-level Serve config and its ETag from Tailscale's local API. A unique identical route is reused without running the mutation command and is never claimed for cleanup; multiple identical routes are rejected as ambiguous. A pre-existing Web handler with no active TCP listener is treated as dormant and is not activated. Existing conflicting root handlers, active Funnel listeners, or incompatible port modes are left untouched.
- **Windows LocalAPI transport**: Tailscale's protected named pipe requires the client to request the `Identification` impersonation level. Node's ordinary `socketPath` transport does not set it, so the plugin uses a bundled Windows PowerShell/.NET bridge only for the local pipe connection. This preserves Tailscale's authentication check; it does not elevate the process, change policy, or bypass LocalAPI authorization. Unix-like systems continue to use the native Unix socket directly.
- **Serve**: HTTPS mode runs an explicit `tailscale serve --bg --yes --https=443 <target>`; HTTP mode uses `--http=80`. The target is always the actual DSH listener, including its host, so an IPv6-only or mismatched bind cannot silently become a successful 502 endpoint. After the CLI exits 0, the plugin re-reads `Web/TCP`, performs a final fresh route/listener/Funnel check immediately before announcement, derives the endpoint from the actual route rather than the hostname hint, and verifies the exact proxy route. If Funnel became enabled during that window, the plugin removes only its own handler with an ETag-guarded safety rollback and does not announce the endpoint.
- **Trust fence**: it pushes the resolved tailnet hostname (`<machine>.<tailnet>.ts.net`) into `webRuntime.trustedHosts`, which the already-applied `/api` fence reads per request (same array reference).
- **Split directory picker**: the PC keeps DSH's native directory-picker backend and client. On non-loopback pages the plugin registers a directory-flow occupant whose bundle loads after DSH's stock picker; the runtime assigns each later registration on a single slot a lower automatic shadowing priority, so the plugin's flow wins there and the native client stays on the loopback PC page. Directory enumeration and child creation travel over `/dsh-remote` with `trusted-host` authority, strict fully-qualified path checks, and a 1,000-entry bound.
- **Static transport enhancement**: the plugin wraps the webServer's request listener and serves `/assets` and `/plugins` GET responses with Brotli compression (gzip where the client does not advertise `br`), an ETag, and caching headers — fingerprinted names (including every `?rev=` plugin bundle URL) are `immutable`, the rest revalidate with a 304. DSH ships none of these, so over a DERP relay the phone re-downloaded the full ~4.4MB boot payload on every page load; with the enhancement the core assets transfer ~0.4MB on the first load and repeat loads are near-zero. Once the Serve route is verified the plugin also pre-warms the response cache from DSH's own `index.html`, so the first phone load after a DSH restart never pays on-demand compression. The enhancement gates on the request's Host header: only non-loopback (tailnet) requests get it, so the PC's `127.0.0.1` browser still receives DSH's byte-exact stock responses. Response bodies are byte-identical, `/api` and event streams pass through untouched, and the enhancer runs only while the plugin is enabled.
- **Cleanup**: on normal dispose, it removes only the verified `/` handler owned by this process. The update is built from the latest config and posted with `If-Match: <ETag>`; a concurrent change returns HTTP 412 and is retried from the new state, so unrelated routes are preserved rather than replaced. If the root handler or listener mode changed, cleanup stops without a write. If same-port Funnel state changed, cleanup performs a handler-only safety removal that preserves the current TCP/Funnel listener; it never disables the other process's Funnel. `keepOnExit:true` skips this removal.

A hard crash or forced process termination cannot run the disposer. Inspect `tailscale serve status --json` first and verify which actual host has a `/` handler targeting DSH. If it does, remove only that path with the current CLI, for example `tailscale serve --yes --https=443 --set-path=/ off` (or the corresponding `--http=80` form). Omitting `--set-path=/` can remove other paths sharing the listener. Do not use `tailscale serve reset` unless you intend to remove every node-level Serve handler.

## Configuration semantics

`hostname` is only an early URL/trust-fence hint; it does not filter route ownership, grant Tailscale Serve permission, or make a failed Serve command succeed. After reading Tailscale's node-level config, the plugin derives the URL from the actual verified route and warns if the hint was stale. A custom `serveArgs` value is structurally validated, and the plugin then proves that one unambiguous route with the expected port, mode, and DSH proxy target appeared. `serve --help`, a status/reset subcommand, a foreground command, or a different target cannot produce a success message.

## All symptoms

| Symptom | Cause / fix |
|---|---|
| `dsh-remote: warning: tailscale CLI not found` | Tailscale is installed somewhere unusual. Set `serveArgs` is not enough — either add the CLI's directory to PATH or open an issue with your install path. |
| Phone page loads but chat is dead / "not real-time" | The `/api` fence was rejecting the host. Expected with the old plugin code — **restart DSH** so the trust-fence injection runs, and look for the `added ... trust fence` startup line. |
| `transport failure for /api/host, pickDirectory` / HTTP 403 on the phone | The remote directory-flow client did not load, so the stock native flow won. Confirm the phone uses the `*.ts.net` URL, reconcile/reinstall this plugin, restart DSH, and verify `/dsh-remote/listDrives` is available. Keep DSH's stock `directory-picker` enabled; do not solve this by globally replacing the PC picker. |
| Models/settings page or model discovery action fails with HTTP 403 | DSH keeps provider settings, credentials, settings mutations, and `llm.discoverModels` loopback-only. The plugin proxies a narrow slice over its trusted channel: model discovery, the read-only settings describe view, `settings.update` for the `agent-presets` namespace, and the full model-config save path (`settings.mutate` on `llm-*` namespaces + `credentials.set`/`unset`/`describe`). Anything else must be configured from the host's `127.0.0.1` UI. **Restart DSH after updating the plugin so the server-side endpoints load.** |
| `tailscale serve status` says `Access is denied` on Windows | The current account may query general node status but cannot inspect/manage Serve. Run `dsh web` from an elevated/authorized account or configure an operator supported by that Tailscale release. |
| `tailscale serve status --json` prints `{}` | This is a valid empty Serve configuration, not an error. Start/restart `dsh web`; the plugin should create and then verify the DSH route. |
| Warning mentions `Unable to impersonate using a named pipe until data has been read` | That came from an older plugin build using Node's plain Windows pipe transport. Reinstall/reconcile this package and fully restart DSH so the bundled `Identification`-level transport is loaded. |
| `tailscale serve` command fails | First check permission, then compare the generated command with `tailscale serve --help`. `serveArgs` supports compatible listener-flag variants, but still must use `serve`, background mode, the configured HTTP/HTTPS transport, and the exact DSH target. |
| Tailnet DNS name is logged, but there is no reachable line | Identity discovery succeeded while Serve configuration failed. The endpoint is not considered active; fix the accompanying Serve/permission error and let the retry run or restart DSH. |
| Warning says the configured hostname differs from the verified route | The `hostname` hint is stale. The plugin uses and trusts the actual Tailscale route, but remove or update the hint to avoid misleading startup output. |
| Phone can't reach the URL at all | Phone Tailscale is offline, or the phone is not a member of the same tailnet. Check `tailscale status` on both devices. |
| After a hard DSH crash, the tailnet URL still forwards | Normal route removal could not run. Inspect `tailscale serve status --json`, verify the `/` handler targets DSH, then use `tailscale serve --yes --https=443 --set-path=/ off` or the matching `--http=80` command. |
| Shutdown warns that Serve or Funnel changed concurrently | The ETag compare-and-set saw another writer, or the owned handler/listener could no longer be safely identified. The plugin retries conditional cleanup and, for a same-port Funnel change, removes only its own handler while preserving the current TCP/Funnel listener. If the warning says rollback/cleanup failed, inspect `tailscale serve status --json`. |
| `npm install -g` fails with integrity/lock errors | Clear the npm cache (`npm cache clean --force`) or use a fresh prefix; do **not** mix the npx cache with a global install. |
| Phone layout looks wrong after a DSH upgrade | An upstream stable class suffix changed. Run `npm run verify` — it names every rule that no longer matches and rejects literal build hashes. |
| Layout suspect, unsure whether it is this plugin | Reload with `?nomobilefit=1` to disable the adaptation and compare. |
| Whole plugin stops loading after an edit | Almost always a backtick typed inside the `CSS` template literal, which ends it early. `npm run verify` reports it; `node --check lib/client.js` shows the parse error. |
| Two glyphs overlap in the floating sidebar button | The fish mark is not being hidden. DSH only swaps it on `:hover`, which touch never satisfies, so the rule must target `_railMark` — verify that selector still resolves. |
