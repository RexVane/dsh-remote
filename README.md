# dsh-remote

English | [简体中文](README.zh-CN.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin that exposes the web GUI over your **Tailscale tailnet** — one URL for the phone, the tablet, or any browser on your tailnet. Works on **Wi-Fi (direct)** and **away (DERP relay)**, with automatic TLS, a remote workspace picker, and no `--trusted-host` flag.

> **Compatibility:** host — Windows verified end to end; macOS lists `/Volumes` and Linux starts at the home directory (covered by tests, not exercised on real hardware) · client — any modern browser; Android Chrome verified on a real device, iOS Safari not yet exercised on hardware · DSH `0.1.0-rc.8` (fence/RPC behaviour additionally verified on `0.1.1-rc.2`) · Tailscale `1.102.x` · Node.js `^22.19.0 || >=24.0.0`. Re-run `npm run check:all` after every DSH upgrade before trusting the selector-sensitive mobile layer.

## Prerequisites

**Install Tailscale on the PC and the phone and log both into the same Tailscale account** (that is, the same tailnet) — the PC runs DSH, the phone opens the URL. That is the whole setup.

Two additional requirements:

1. The account that runs `dsh web` must be allowed to manage Tailscale Serve — check with `tailscale serve status --json` from that account (an empty `{}` is fine). If it returns `Access is denied`, run DSH from an elevated shell or grant the account Serve/operator access (see [Troubleshooting](#troubleshooting)).
2. Node.js 22.19+ (within major 22) or 24+ — the range DSH itself requires.

## Install

```powershell
# 1. DSH itself (global install; the npx one-shot cache is fragile)
npm install -g @deepseek-ai/dsh@0.1.0-rc.8

# 2. this plugin into the web profile (run inside the plugin directory;
#    once published to npm, the package name works here too)
dsh plugin --profile web add .

# 3. start — the plugin activates with DSH
dsh web
```

On startup you should see:

```
dsh web: http://127.0.0.1:3080
dsh-remote: added <machine>.<tailnet>.ts.net to the DSH /api trust fence
dsh-remote: DSH web is now reachable on your tailnet: https://<machine>.<tailnet>.ts.net
```

Open that URL in the device browser and the setup is complete. `DSH web is now reachable` is printed only after the Serve command succeeded **and** Tailscale's node-level config contains the exact expected proxy route — a visible tailnet DNS name alone is never treated as success.

> **If `dsh plugin` fails with `ENOENT ... scandir '<profile>\D:\...'`** (pnpm 10 mis-resolves drive-letter `file:`/`link:` specs): install manually with `pnpm add "link:<path>"` inside `$env:USERPROFILE\.dsh\profiles\web`, then append `"dsh-remote"` to the `dsh.profile.bundles` array in that directory's `package.json`.

## Remote usage

1. Open the Tailscale app on the device and confirm it is **online**.
2. Open `https://<machine>.<tailnet>.ts.net` in its browser — phone, tablet, or another computer.
3. Chat, tool calls, and deliverables stream **live** — the same session as the PC. Creating a workspace opens the plugin's remote browser — Windows drive letters, macOS volumes, or the home directory — to browse real folders, create one, and select it. The host PC's own page keeps the native OS folder dialog.
4. Same URL works away from home: Tailscale relays through DERP when there is no direct path.

Remote devices do **not** need to run DSH or any plugin — only Tailscale membership. Editing or verifying the mobile-fit layer (selector strategy, the two known traps, the verification suites) is documented in [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md).

## Configuration

Set in `cordis.patch.yml`, overridable from a profile `--patch`. Full semantics in [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md).

| key | default | meaning |
|---|---|---|
| `enabled` | `true` | Master switch. `false` keeps DSH on loopback only — no Serve route, no trust-fence entry, not even the plugin's RPC channel. |
| `https` | `true` | Tailscale HTTPS on port 443. `false` requests plain HTTP on port 80. |
| `hostname` | *(auto-detected)* | Optional `<machine>.<tailnet>.ts.net` URL hint. Normally omit it; the verified route's actual host always wins. |
| `keepOnExit` | `false` | Keep the plugin-applied Serve route after DSH exits. |
| `serveArgs` | *(omitted)* | Advanced override for the complete `tailscale serve` argument vector. |

## Security

The tailnet is the gate: Tailscale identity, ACLs, and TLS decide who can reach the page — the plugin adds no user-level auth of its own, so restrict your ACL to devices you trust with DSH and with that account's directories. DSH's config-plane methods stay loopback-only; the plugin re-exposes only a narrow, validated slice (directory browse/create, model discovery, the model-config save path, agent presets). Full boundary analysis: [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md).

## Troubleshooting

| Symptom | Fix |
|---|---|
| Phone loads but chat is dead / "not real-time" | **Restart DSH** so the trust-fence injection runs; look for the `added ... trust fence` startup line. |
| `pickDirectory` / HTTP 403 on the phone | The remote directory flow did not load — confirm the phone uses the `*.ts.net` URL and restart DSH. |
| Models/settings page fails with HTTP 403 | **Restart DSH after updating the plugin** so the server-side endpoints load. |
| Phone can't reach the URL at all | Phone Tailscale is offline, or not in the same tailnet. Check `tailscale status` on both devices. |
| Layout looks wrong after a DSH upgrade | Run `npm run verify` — it names every rule that no longer matches. |
| Layout suspect, unsure whether it is this plugin | Reload with `?nomobilefit=1` to disable the adaptation and compare. |

The full symptom table lives in [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md).

## Uninstall

```powershell
dsh plugin --profile web remove dsh-remote
```

`dsh plugin remove` forwards to pnpm **and** prunes the `dsh.profile.bundles` layer entry, so this one command is the complete uninstall. Two leftovers it cannot know about:

```powershell
# only if DSH crashed hard and left the route behind (a normal shutdown removes it);
# also needed when keepOnExit was true:
tailscale serve --yes --https=443 --set-path=/ off

# only if the plugin was installed from a tarball: drop the copied archive
Remove-Item "$env:USERPROFILE\.dsh\profiles\web\dsh-remote-*.tgz"
```

Then delete the plugin directory itself if you no longer want the source.

## License

MIT. See `LICENSE` for the full text.

## Publishing

Source lives at [github.com/RexVane/dsh-remote](https://github.com/RexVane/dsh-remote). `repository`, `homepage`, and `bugs` in `package.json` already point at it.
