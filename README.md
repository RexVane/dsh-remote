# dsh-tailscale-serve

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin that exposes the web GUI over your **Tailscale tailnet** — one URL that works on **Wi-Fi (direct)** and **away (DERP relay)**, with automatic TLS, and no `--trusted-host` flag.

> **Compatibility target:** Windows, DSH `0.1.0-rc.8`, Tailscale `1.102.x`, and Node.js `^22.19.0 || >=24.0.0` (the range declared by DSH rc.8). The static suite has been checked against the current rc.8 installation. The retained phone screenshots and mobile-fit audit came from an earlier live run; rerun `npm run check:all` against the installed DSH after every DSH upgrade before treating the selector-sensitive mobile layer as verified.

## Why

DSH binds its browser UI to `127.0.0.1` and intentionally refuses `--host 0.0.0.0`: it has no TLS, no auth, no origin policy, so exposing it to the network is remote code execution. `tailscale serve` bridges that safely:

- TLS is terminated with a tailnet certificate (automatic).
- Access is governed by Tailscale identity and ACLs — only authorized tailnet users/devices can reach it.
- The reverse proxy targets the loopback port, so DSH never has to bind wide.

The phone installs Tailscale, joins the same tailnet, and opens the URL. On Wi-Fi Tailscale takes a direct path (low latency); off-network it relays through DERP (NAT traversal). Same address, no second config.

## Prerequisites

1. **Tailscale** installed and logged in on the DSH host (`tailscale up`). The plugin locates the CLI automatically in the common install locations; a PATH entry is not required (see [How it works](#how-it-works)).
2. **Tailscale** installed on the phone, joined to the **same tailnet**. The phone must be **online** — an offline device cannot reach the tailnet, by design.
3. **MagicDNS** enabled. HTTPS Serve certificates and the verified URL use the node's `*.ts.net` name; the plugin deliberately does not report an HTTPS IP URL that would fail certificate validation.
4. `tailscale serve` support — verify with `tailscale serve --help` (Tailscale ≥ 1.50 recommended).
5. **Permission to manage Tailscale Serve from the account that runs DSH.** On Windows, run the following from the same PowerShell session/account you will use for `dsh web`:

   ```powershell
   tailscale serve status --json
   ```

   An output of `{}` is successful and simply means that this node has no Serve routes yet; the plugin can create the first route. If it returns `Access is denied`, run DSH from an elevated shell or grant that account Serve/operator access using the mechanism supported by your installed Tailscale version. A successful `tailscale status` or a visible `*.ts.net` DNS name proves only that the node is online; it does not prove that the account can create, inspect, or conditionally update Serve configuration.
6. **Node.js 22.19 or newer within major 22, or Node.js 24 or newer.** DSH rc.8 excludes Node 23 and earlier Node 22 releases. Node 24 is the currently exercised development version.

## Install

### 1. Install DSH (if not already)

The plugin requires DSH itself. A **global install** is the most reliable option (the npx one-shot cache has proven fragile — it can corrupt and then refuse to reinstall with `ECOMPROMISED`):

```powershell
npm install -g @deepseek-ai/dsh@0.1.0-rc.8
```

After this, `dsh` is available from any directory.

### 2. Install the plugin into the web profile

From anywhere (the path is anchored to your invoking directory):

```powershell
dsh plugin --profile web add D:\AIApp\dsh-tailscale-serve
```

or, from inside the plugin directory:

```powershell
dsh plugin --profile web add .
```

`dsh plugin` forwards to `pnpm`, installs the package into the `web` profile, and reconciles it into the `dsh.profile.bundles` layer stack (the `dsh.bundle.patch` declaration in `package.json` is what makes it a composition layer).

> **Windows path quirk (verified)**: pnpm 10 mis-resolves a drive-letter `file:`/`link:` spec inside the profile directory. If `dsh plugin` fails with `ENOENT ... scandir '<profile>\D:\...'`, install manually instead:
>
> ```powershell
> Set-Location "$env:USERPROFILE\.dsh\profiles\web"
> pnpm add "link:D:\AIApp\dsh-tailscale-serve"
> ```
>
> then append `"dsh-tailscale-serve"` to the `dsh.profile.bundles` array in `package.json` (after `@deepseek-ai/dsh-web-app`).

### 3. Start DSH

```powershell
dsh web
```

On startup you should see:

```
dsh web: http://127.0.0.1:3080
tailscale-serve: added <machine>.<tailnet>.ts.net to the DSH /api trust fence
tailscale-serve: DSH web is now reachable on your tailnet: https://<machine>.<tailnet>.ts.net
tailscale-serve: TLS is handled by Tailscale. Phone: install Tailscale, join the same tailnet, open that URL.
```

The two lines prove different things. `added ... trust fence` means ordinary browser API traffic will not be rejected solely because of the `*.ts.net` host. `DSH web is now reachable` is printed only after the Serve command exits successfully **and** Tailscale's node-level config contains the exact expected proxy route. A known tailnet DNS name alone is never treated as success; transient startup failures are retried, while permission, conflict, or route-verification errors stop without a false success message.

## Phone usage

1. Open the Tailscale app on the phone and confirm the device is **online** (green).
2. Open `https://<machine>.<tailnet>.ts.net` (for example, `https://my-pc.example-tailnet.ts.net`) in the phone browser.
3. Chat, tool calls, and deliverables stream **live** — the same session you see on the PC. The bundled profile patch also selects DSH's in-page directory browser. On Windows it opens at a virtual **This PC** view with the ready drive roots (for example `C:\` and `D:\`); choosing a drive then browses the real host folders and can create/select a workspace without invoking the host OS folder dialog.
4. Same URL works away from home: Tailscale relays through DERP when there is no direct path.

> The phone device does **not** need to run DSH or any plugin — it only needs Tailscale membership.

## Phone layout adaptation

Reaching DSH from the phone is only half of *using* DSH from the phone. The shipped GUI is a desktop three-column shell (it wants a 280px sidebar plus a 748px chat column, ~1060px total), so below that width panels squeeze each other and `nowrap` content paints over its neighbours. This plugin therefore also ships a browser half, `lib/client.js`, which is **a stylesheet, not a component**: DSH's own React components, state and buttons stay in charge.

- Everything lives inside one `@media (max-width: 820px)` block, so a desktop browser is bit-for-bit unaffected.
- The collapsed sidebar rail goes to zero width and DSH's own toggle is floated out as a round opener in the top-left corner; the expanded sidebar becomes an overlay drawer. No state is cloned — the button still calls DSH's `toggleSidebar()`.
- A small JavaScript half handles what CSS cannot express: a keyboard-aware `interactive-widget=resizes-content` viewport, a marquee for model names too long to fit, and two focus guards that stop a sidebar tap or the command button from opening the soft keyboard over the content.

Load any page with **`?nomobilefit=1`** to disable the whole adaptation. That is the reliable way to tell a layout fault in this sheet apart from one in DSH itself: open the same URL with and without the flag and compare.

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

## Configuration

The plugin is configured through the patch layer (`cordis.patch.yml`), overridable from a profile `--patch`:

| key | default | meaning |
|---|---|---|
| `enabled` | `true` | Master switch. `false` keeps DSH on loopback only. |
| `https` | `true` | Use Tailscale HTTPS on port 443. `false` asks Tailscale explicitly for plain HTTP on port 80; use that only on a trusted tailnet and only when TLS is genuinely undesirable. |
| `hostname` | *(auto-detected)* | Optional `<machine>.<tailnet>.ts.net` URL hint used before the Serve route can be read. Normally omit it; the verified route's actual host always wins, and a stale/mismatched value produces a warning. |
| `keepOnExit` | `false` | Keep the plugin-applied root handler after DSH exits. With the default, a normal shutdown removes only the route this process proved it added; it does not restore or replace the rest of Serve. |
| `serveArgs` | *(omitted)* | Advanced override for the complete vector, e.g. `["serve", "--bg", "--yes", "--https=443", "http://127.0.0.1:3080"]`. It must explicitly configure exactly one matching HTTP(S) listener in background mode and end with the actual DSH target. Service, path, TCP-forwarding, and TUN modes are rejected because this plugin cannot safely own/clean them. |

`hostname` is only an early URL/trust-fence hint; it does not filter route ownership, grant Tailscale Serve permission, or make a failed Serve command succeed. After reading Tailscale's node-level config, the plugin derives the URL from the actual verified route and warns if the hint was stale. A custom `serveArgs` value is structurally validated, and the plugin then proves that one unambiguous route with the expected port, mode, and DSH proxy target appeared. `serve --help`, a status/reset subcommand, a foreground command, or a different target cannot produce a success message.

## Browser trust fence

DSH validates the `/api` host against a browser-trust fence (DNS-rebinding defense in `dsh-client-connection`). The tailnet domain (`*.ts.net`) is not a LAN literal, so without help the phone's requests would be refused with **403 Forbidden**: the page loads, but the chat/live stream silently fails — it looks like "the conversation is not real-time".

**This plugin fixes that automatically**: it appends your tailnet hostname to `ctx.webRuntime.trustedHosts` — the exact array DSH's fence reads (the web-app bundle wires the fence to `!!js ctx.webRuntime.trustedHosts`, and the fence holds the same array reference per request). No `--trusted-host` flag is needed. The change is re-applied on every startup; a plugin-code update requires a DSH restart to take effect.

If you run DSH without this plugin, you can get the same effect manually:

```powershell
dsh web --trusted-host <machine>.<tailnet>.ts.net
```

### Security boundary of the fence

The fence is a DNS-rebinding defense, **not** an auth layer. This plugin only adds the tailnet hostname to the trusted-host list; DSH itself still binds `127.0.0.1` and the whole exposure is gated by Tailscale's tailnet membership, ACLs, and (by default) TLS.

DSH rc.8 has a second, deliberately narrower boundary for configuration-plane methods. Calls including `host.pickDirectory`, `host.openPath`, `settings.*`, `credentials.*`, and `llm.discoverModels` require a loopback same-origin request and ignore the ordinary trusted-host list. The already-configured, non-secret model catalog (`llm.providers`/`llm.models`) is a different browser-safe surface; it does not make provider settings or model discovery actions remotely writable. Therefore this error is expected from a `*.ts.net` page when the native picker is selected:

```text
transport failure for /api/host, pickDirectory
HTTP 403
```

Adding another `--trusted-host`, weakening a Tailscale ACL, changing `hostname`, or retrying Serve does not unlock those methods. The supported no-source-code split is:

- **Folders and workspaces:** this package's `cordis.patch.yml` disables DSH's automatic/native picker, mounts the browse Host backend, and lets this plugin's client bundle occupy both workspace directory-flow slots. On Windows the picker first shows a virtual **This PC** drive list; only an actual drive/root or directory is sent to `host.listDirectory`, `host.createDirectory`, or `workspace.create`. The virtual label itself is never submitted as a filesystem path. Restart DSH after installing or changing the patch. This selection applies to the whole web profile, so the PC browser also gets the same in-page browser instead of the Windows/macOS native dialog.
- **Credentials, provider settings, and model discovery:** open the loopback UI on the host PC (`http://127.0.0.1:3080`, or the port printed by DSH) and perform those administrative actions there. Once configured, the remote page may still read the non-secret model catalog and use the selected model, but it cannot use this plugin to bypass the loopback-only configuration methods.

The browse picker is functional access, not a filesystem sandbox: Windows starts from its ready drive roots; other hosts, or a failed/empty drive probe, fall back to the host account's home directory. It accepts absolute paths and has no deployment-level browse-root restriction. Restrict the Tailscale ACL to devices/users you trust with DSH and with visibility into that account's directories.

If directory browsing still invokes `pickDirectory`, inspect the active web profile's final composition and confirm that `directory-picker` is disabled, `directory-picker-browse` is mounted, and the `dsh-tailscale-serve` client bundle is active. Reinstall/reconcile the plugin and restart DSH if the profile was generated before these rows were added.

## How it works

- **Tailscale CLI discovery**: the plugin probes `tailscale` on PATH plus the common install locations (`C:\Program Files\Tailscale\tailscale.exe`, `D:\Program Files (x86)\Tailscale\tailscale.exe`, `%LOCALAPPDATA%\Programs\{Tailscale,tailscale}\tailscale.exe`, the macOS app bundle, `/usr/bin` and `/usr/local/bin`). A successful probe wins; if every probe fails, the first non-`ENOENT` candidate is retained so a timeout or `EACCES`/`EPERM` error is reported later instead of being mislabeled as a missing CLI.
- **Port**: the plugin injects the `webServer` service, so it activates only after the HTTP server is listening — it reads the real port (including an OS-assigned port `0`).
- **Serve state inspection**: before making a change, the plugin reads the raw node-level Serve config and its ETag from Tailscale's local API. A unique identical route is reused without running the mutation command and is never claimed for cleanup; multiple identical routes are rejected as ambiguous. A pre-existing Web handler with no active TCP listener is treated as dormant and is not activated. Existing conflicting root handlers, active Funnel listeners, or incompatible port modes are left untouched.
- **Windows LocalAPI transport**: Tailscale's protected named pipe requires the client to request the `Identification` impersonation level. Node's ordinary `socketPath` transport does not set it, so the plugin uses a bundled Windows PowerShell/.NET bridge only for the local pipe connection. This preserves Tailscale's authentication check; it does not elevate the process, change policy, or bypass LocalAPI authorization. Unix-like systems continue to use the native Unix socket directly.
- **Serve**: HTTPS mode runs an explicit `tailscale serve --bg --yes --https=443 <target>`; HTTP mode uses `--http=80`. The target is always the actual DSH listener, including its host, so an IPv6-only or mismatched bind cannot silently become a successful 502 endpoint. After the CLI exits 0, the plugin re-reads `Web/TCP`, performs a final fresh route/listener/Funnel check immediately before announcement, derives the endpoint from the actual route rather than the hostname hint, and verifies the exact proxy route. If Funnel became enabled during that window, the plugin removes only its own handler with an ETag-guarded safety rollback and does not announce the endpoint.
- **Trust fence**: it pushes the resolved tailnet hostname (`<machine>.<tailnet>.ts.net`) into `webRuntime.trustedHosts`, which the already-applied `/api` fence reads per request (same array reference).
- **Cleanup**: on normal dispose, it removes only the verified `/` handler owned by this process. The update is built from the latest config and posted with `If-Match: <ETag>`; a concurrent change returns HTTP 412 and is retried from the new state, so unrelated routes are preserved rather than replaced. If the root handler or listener mode changed, cleanup stops without a write. If same-port Funnel state changed, cleanup performs a handler-only safety removal that preserves the current TCP/Funnel listener; it never disables the other process's Funnel. `keepOnExit:true` skips this removal.

A hard crash or forced process termination cannot run the disposer. Inspect
`tailscale serve status --json` first and verify which actual host has a `/`
handler targeting DSH. If it does, remove only that path with the
current CLI, for example `tailscale serve --yes --https=443 --set-path=/ off`
(or the corresponding `--http=80` form). Omitting `--set-path=/` can remove
other paths sharing the listener. Do not use `tailscale serve reset` unless you
intend to remove every node-level Serve handler.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `tailscale-serve: warning: tailscale CLI not found` | Tailscale is installed somewhere unusual. Set `serveArgs` is not enough — either add the CLI's directory to PATH or open an issue with your install path. |
| Phone page loads but chat is dead / "not real-time" | The `/api` fence was rejecting the host. Expected with the old plugin code — **restart DSH** so the trust-fence injection runs, and look for the `added ... trust fence` startup line. |
| `transport failure for /api/host, pickDirectory` / HTTP 403 | DSH selected its native, loopback-only picker. Confirm the browse-picker rows from this package are present in the active web profile, then reconcile/reinstall the plugin and restart DSH. Do not try to solve this with `--trusted-host`. |
| Models/settings page or model discovery action fails with HTTP 403 | DSH rc.8 keeps provider settings, credentials, settings mutations, and `llm.discoverModels` loopback-only. Configure them from the host's `127.0.0.1` UI; the ordinary non-secret model catalog is separate. |
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

## Uninstall

```powershell
dsh plugin --profile web remove dsh-tailscale-serve
```

If the plugin was installed manually (`link:`), instead remove the dependency and the `dsh-tailscale-serve` entry from `dsh.profile.bundles` in `C:\Users\<you>\.dsh\profiles\web\package.json`, then `pnpm install` in that directory.

## License

MIT. See `LICENSE` for the full text.

## Publishing

No canonical source repository is present in this directory or published for this package name, so `repository`, `homepage`, and `bugs` are intentionally not guessed. Create the public repository and add those three URLs to `package.json` before the first registry release.
