// dsh-tailscale-serve — expose the DSH web GUI over your Tailscale tailnet.
//
// DSH binds its browser UI to 127.0.0.1 and intentionally refuses --host 0.0.0.0
// (no TLS/auth/origin policy = remote code execution). `tailscale serve` bridges
// that safely: it terminates TLS with a tailnet cert, enforces tailnet-membership
// auth, and reverse-proxies to the loopback port. The same URL then reaches the
// phone over Wi-Fi (Tailscale direct path) or away (DERP relay).
//
// This plugin is a self-registering DSH bundle: it injects the `webServer`
// and `webRuntime` services, so it activates only after the HTTP server is
// listening (reading the real port, incl. OS-assigned 0) and after the web
// bundle's LAN-trust service exists. It discovers the `tailscale` CLI on PATH
// or in the common install locations (no PATH edit needed), runs
// an explicit background Serve command, verifies the resulting node-level
// route through Tailscale's ETag-protected LocalAPI, and appends the tailnet hostname to DSH's
// /api browser-trust fence so the phone's requests are accepted and the live
// stream works. On dispose it removes only the root handler it proved it owns.

import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { isIP } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const name = "tailscale-serve";
// Injecting "webServer" guarantees apply() runs only after the HTTP server has
// bound its port (Service.init resolves inside the listen callback), so
// ctx.webServer.port is already the OS-assigned value. Injecting "webRuntime"
// (the web-app bundle's LAN-trust service) additionally guarantees the
// webRuntime.trustedHosts array exists before we extend it — the /api fence
// holds the same array reference, so pushing the tailnet host here is visible
// to every request, with no --trusted-host flag and no ordering gamble.
// This plugin targets the web profile only; a non-web profile has no
// webRuntime service and would fail injection, which is correct fail-fast
// behavior for a web-GUI-only plugin.
const inject = ["webServer", "webRuntime", "connection"];
const LOCALAPI_HELPER = join(dirname(fileURLToPath(import.meta.url)), "tailscale-localapi.cjs");
const TAILSCALE_COMMAND_TIMEOUT_MS = 20_000;
const LOCALAPI_HELPER_TIMEOUT_MS = 15_000;

// Common install locations when `tailscale` is not on PATH (Windows GUI
// installs under Program Files; macOS ships the CLI inside the app bundle).
function tailscaleCandidates() {
	const home = process.env.LOCALAPPDATA ?? "";
	const pf = process.env.PROGRAMFILES ?? "C:\\Program Files";
	const pf86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
	return [
		"tailscale", // PATH lookup first
		`${pf}\\Tailscale\\tailscale.exe`,
		`${pf86}\\Tailscale\\tailscale.exe`,
		`${home}\\Programs\\Tailscale\\tailscale.exe`,
		`${home}\\Programs\\tailscale\\tailscale.exe`,
		"/Applications/Tailscale.app/Contents/MacOS/Tailscale",
		"/usr/local/bin/tailscale",
		"/usr/bin/tailscale",
	];
}

function selectTailscaleCandidate(candidates, deps = {}) {
	const exists = deps.exists ?? existsSync;
	const spawn = deps.spawn ?? spawnSync;
	let diagnosticFallback = null;
	for (const candidate of candidates) {
		if (candidate !== "tailscale" && !exists(candidate)) continue;
		try {
			const probe = spawn(candidate, ["version"], {
				encoding: "utf8",
				timeout: 5000,
				windowsHide: true,
			});
			if (probe?.error?.code === "ENOENT") continue;
			if (probe?.status === 0) return candidate;
			diagnosticFallback ??= candidate;
		} catch (error) {
			if (error?.code === "ENOENT") continue;
			diagnosticFallback ??= candidate;
		}
	}
	return diagnosticFallback ?? "tailscale";
}

let resolvedTailscale = null;
/** Prefer the first successful probe; retain a non-ENOENT failure for diagnosis if all probes fail. */
function resolveTailscale() {
	if (resolvedTailscale === null) {
		resolvedTailscale = selectTailscaleCandidate(tailscaleCandidates());
	}
	return resolvedTailscale;
}

/** True when the tailscale CLI exists and runs. */
function tailscaleAvailable(run = runTailscale) {
	const r = run(["version"]);
	const code = r?.error?.code ?? r?.code;
	// ENOENT is the one reliable signal that no executable was found.  A
	// timeout, EACCES/EPERM, or a service-side failure means the executable may
	// still be present; let the normal identity/LocalAPI diagnostics explain
	// that failure instead of misreporting it as "CLI not found".
	return code !== "ENOENT";
}

/**
 * Return the ready local Windows drive roots without reading their contents.
 * A missing/unready drive is skipped; non-Windows hosts keep the ordinary
 * home-rooted directory browser by returning an empty list.
 */
function listWindowsDrives(options = {}) {
	const platform = options.platform ?? process.platform;
	if (platform !== "win32") return [];
	const stat = options.stat ?? statSync;
	const drives = [];
	for (let code = 65; code <= 90; code += 1) {
		const root = `${String.fromCharCode(code)}:\\`;
		try {
			if (stat(root).isDirectory()) drives.push(root);
		} catch {
			// Empty removable drives and disconnected mappings are not useful roots.
		}
	}
	return drives;
}

/** Register the phone directory browser's read-only drive enumeration RPC. */
function registerDriveRpc(ctx, deps = {}) {
	const connection = ctx.connection ?? ctx.get?.("connection");
	if (!connection?.rpc?.handle) return;
	const enumerate = deps.listWindowsDrives ?? listWindowsDrives;
	return connection.rpc.handle(
		"/tailscale-serve",
		async (endpoint) => {
			if (endpoint !== "listDrives") {
				return {
					ok: false,
					error: { code: "bad-request", message: "unknown tailscale-serve endpoint", details: { issues: [] } },
				};
			}
			try {
				return { ok: true, value: { drives: enumerate() } };
			} catch (error) {
				return {
					ok: false,
					error: {
						code: "internal",
						message: error instanceof Error ? error.message : String(error),
						details: {},
					},
				};
			}
		},
		{ authority: "trusted-host" },
	);
}

/** Run the tailscale CLI once, returning {status, stdout, stderr, error}. */
function runTailscale(args, ctx) {
	const cmd = resolveTailscale();
	try {
		const result = spawnSync(cmd, args, {
			encoding: "utf8",
			// Tailscale status --json can be large; give it room.
			maxBuffer: 16 * 1024 * 1024,
			timeout: TAILSCALE_COMMAND_TIMEOUT_MS,
			windowsHide: true,
		});
		return {
			status: result.status,
			stdout: result.stdout ?? "",
			stderr: result.stderr ?? "",
			error: result.error ?? null,
		};
	} catch (error) {
		return { status: null, stdout: "", stderr: "", error };
	}
}

/** Pull the local node's identity from `tailscale status --json`. */
function selfInfo(run = runTailscale) {
	const r = run(["status", "--json"]);
	if (r.status !== 0 || !r.stdout) return null;
	try {
		const j = JSON.parse(r.stdout);
		// Newer output uses `Self` (capital); tolerate lowercase just in case.
		return j.Self ?? j.self ?? null;
	} catch {
		return null;
	}
}

/** Best-effort public URL for the served site. */
function resolveServeUrl(self, https) {
	if (!self) return null;
	const dnsName = self.DNSName;
	if (dnsName) {
		// DNSName comes with a trailing dot, e.g. "host.tailnet.ts.net."
		const host = String(dnsName).replace(/\.+$/, "");
		if (host) return https ? `https://${host}` : `http://${host}`;
	}
	const ips = self.TailscaleIPs;
	if (!https && Array.isArray(ips) && ips[0]) {
		const ip = String(ips[0]);
		const host = ip.includes(":") && !ip.startsWith("[") ? `[${ip}]` : ip;
		return https ? `https://${host}` : `http://${host}`;
	}
	return null;
}

/** Convert a configured hostname (with or without a scheme) into an origin. */
function resolveConfiguredUrl(hostname, https) {
	if (typeof hostname !== "string" || !hostname.trim()) return null;
	const scheme = https ? "https" : "http";
	const raw = hostname.trim();
	try {
		const parsed = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `${scheme}://${raw}`);
		const plainHost = parsed.hostname.replace(/^\[|\]$/g, "").replace(/\.+$/, "");
		if (!plainHost) return null;
		const host = plainHost.includes(":") ? `[${plainHost}]` : plainHost;
		return `${scheme}://${host}${parsed.port ? `:${parsed.port}` : ""}`;
	} catch {
		return null;
	}
}

/** Build the CLI arguments for the requested public transport. */
function buildServeArgs(config, serveTarget) {
	if (Array.isArray(config.serveArgs) && config.serveArgs.length > 0) {
		const args = config.serveArgs.map(String);
		const disallowed = new Set(["status", "reset", "clear", "drain", "advertise", "get-config", "set-config", "set-raw", "off"]);
		const unsupportedFlags = ["--service", "--set-path", "--tcp", "--tls-terminated-tcp", "--tun"];
		if (args[0] !== "serve") throw new Error("serveArgs must start with 'serve'");
		if (args.some((arg) => arg === "--help" || arg === "-h" || disallowed.has(arg))) {
			throw new Error("serveArgs must configure a proxy, not run a Serve subcommand, help, or cleanup action");
		}
		if (args.some((arg) => unsupportedFlags.some((flag) => arg === flag || arg.startsWith(`${flag}=`)))) {
			throw new Error("serveArgs must configure a node-level root HTTP(S) proxy that this plugin can verify and remove");
		}
		if (!args.some((arg) => arg === "--bg" || arg === "--bg=true") || args.includes("--bg=false")) {
			throw new Error("serveArgs must use background mode (--bg)");
		}
		if (args.at(-1) !== serveTarget) {
			throw new Error(`serveArgs must end with the actual DSH proxy target (${serveTarget})`);
		}
		return args;
	}
	return config.https === false
		? ["serve", "--bg", "--yes", "--http=80", serveTarget]
		: ["serve", "--bg", "--yes", "--https=443", serveTarget];
}

function servePublicPort(config, https) {
	if (Array.isArray(config.serveArgs) && config.serveArgs.length > 0) {
		const args = config.serveArgs.map(String);
		const expectedFlag = https ? "--https" : "--http";
		const oppositeFlag = https ? "--http" : "--https";
		const ports = [];
		for (let index = 0; index < args.length; index += 1) {
			const arg = args[index];
			if (arg === oppositeFlag || arg.startsWith(`${oppositeFlag}=`)) {
				throw new Error(`serveArgs transport does not match https:${String(https)}`);
			}
			if (arg === expectedFlag) {
				ports.push(args[index + 1]);
				index += 1;
			} else if (arg.startsWith(`${expectedFlag}=`)) {
				ports.push(arg.slice(expectedFlag.length + 1));
			}
		}
		if (ports.length !== 1) {
			throw new Error(`serveArgs must explicitly include exactly one ${expectedFlag}=<port> listener`);
		}
		if (!/^\d+$/.test(ports[0])) throw new Error(`${expectedFlag} requires a numeric port`);
		const port = Number(ports[0]);
		if (port < 1 || port > 65535) throw new Error(`${expectedFlag} port must be between 1 and 65535`);
		return port;
	}
	return https ? 443 : 80;
}

function commandOutput(result) {
	const error = typeof result?.error === "string" ? result.error : result?.error?.message;
	return String(result?.stderr || result?.stdout || result?.body || error || "").trim();
}

function permissionDenied(result) {
	const code = result?.code ?? result?.error?.code;
	if (result?.status === 401 || result?.status === 403) return true;
	if (code === "EACCES" || code === "EPERM") return true;
	return /access is denied|permission denied|operation not permitted|not authorized|administrator privileges|authentication failed|unable to impersonate/i.test(
		commandOutput(result),
	);
}

function stableJson(value) {
	if (Array.isArray(value)) return value.map(stableJson);
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableJson(value[key])]));
	}
	return value;
}

/** Canonical form used only to detect whether another process changed Serve. */
function canonicalServeConfig(source) {
	const value = typeof source === "string" ? JSON.parse(source) : source;
	return JSON.stringify(stableJson(value ?? {}));
}

function runTailscaleLocalApi(input, spawn = spawnSync) {
	const child = spawn(process.execPath, [LOCALAPI_HELPER], {
		encoding: "utf8",
		input: JSON.stringify({ timeoutMs: 10_000, ...input }),
		maxBuffer: 16 * 1024 * 1024,
		timeout: LOCALAPI_HELPER_TIMEOUT_MS,
		windowsHide: true,
	});
	if (child.error) {
		return { ok: false, status: null, error: child.error, code: child.error.code ?? null };
	}
	try {
		return JSON.parse(child.stdout || "{}");
	} catch (error) {
		return {
			ok: false,
			status: null,
			error: `invalid Tailscale LocalAPI helper response: ${error.message}`,
			body: child.stdout || child.stderr || "",
		};
	}
}

/** Raw node-level Serve config with ETag-backed compare-and-set writes. */
function createServeConfigStore(run = runTailscaleLocalApi) {
	return {
		capture(label) {
			const result = run({ method: "GET" });
			if (!result.ok || !result.etag || !result.config || typeof result.config !== "object") {
				return { ok: false, result };
			}
			const config = structuredClone(result.config);
			return {
				ok: true,
				result,
				snapshot: { label, config, etag: result.etag, canonical: canonicalServeConfig(config) },
			};
		},
		compareAndSet(config, etag) {
			return run({ method: "POST", config, etag });
		},
		cleanup() {},
	};
}

function jsonEqual(left, right) {
	return canonicalServeConfig(left) === canonicalServeConfig(right);
}

function hostPortNumber(hostPort) {
	const match = /:(\d+)$/.exec(String(hostPort));
	return match ? Number(match[1]) : null;
}

function hostPortHostname(hostPort) {
	const source = String(hostPort);
	if (source.startsWith("[")) return source.slice(1, source.lastIndexOf("]"));
	return source.slice(0, source.lastIndexOf(":"));
}

function proxyTargetForBind(bindHost, port) {
	let host = String(bindHost || "127.0.0.1").trim().replace(/^\[|\]$/g, "");
	if (host === "0.0.0.0") host = "127.0.0.1";
	if (host === "::" || host === "::1") host = "localhost";
	if (isIP(host) === 6) {
		throw new Error(
			`DSH is bound to IPv6 address ${host}; Tailscale 1.102.x cannot safely normalize that proxy target. ` +
				"Bind DSH to 127.0.0.1 or a DNS hostname.",
		);
	}
	return `http://${host}:${String(port)}`;
}

function expectedTcpMode(handler, https) {
	if (!handler || typeof handler !== "object") return false;
	if (handler.TCPForward || handler.TerminateTLS) return false;
	return https ? handler.HTTPS === true && handler.HTTP !== true : handler.HTTP === true && handler.HTTPS !== true;
}

function funnelStateAtPort(config, port) {
	return Object.fromEntries(
		Object.entries(config?.AllowFunnel ?? {})
			.filter(([hostPort]) => hostPortNumber(hostPort) === port)
			.map(([hostPort, enabled]) => [hostPort, structuredClone(enabled)]),
	);
}

function funnelAtPort(config, port) {
	return Object.entries(funnelStateAtPort(config, port)).find(([, enabled]) => Boolean(enabled))?.[0] ?? null;
}

function inspectServeConflict(config, port, https, target) {
	const tcp = config?.TCP?.[String(port)];
	if (tcp && !expectedTcpMode(tcp, https)) {
		return `Tailscale port ${String(port)} already has a different TCP/HTTP Serve mode`;
	}
	const webAtPort = Object.entries(config?.Web ?? {}).filter(([hostPort]) => hostPortNumber(hostPort) === port);
	if (!tcp) {
		if (webAtPort.some(([, web]) => Object.keys(web?.Handlers ?? {}).length > 0)) {
			return `Tailscale port ${String(port)} has Web handlers but no active listener; refusing to activate pre-existing routes`;
		}
	}
	for (const [hostPort, web] of webAtPort) {
		const handler = web?.Handlers?.["/"];
		if (handler) {
			if (jsonEqual(handler, { Proxy: target })) continue;
			return `Tailscale Serve already has a root handler at ${hostPort}; refusing to overwrite another application`;
		}
	}
	const funnelHostPort = funnelAtPort(config, port);
	if (funnelHostPort) {
		return `Tailscale Funnel is enabled at ${funnelHostPort}; refusing to replace its listener with Serve`;
	}
	return null;
}

function findOwnedExistingRoute(config, options) {
	const candidates = [];
	for (const [hostPort, web] of Object.entries(config?.Web ?? {})) {
		if (hostPortNumber(hostPort) !== options.port) continue;
		const handler = web?.Handlers?.["/"];
		if (!jsonEqual(handler, { Proxy: options.target })) continue;
		if (!expectedTcpMode(config?.TCP?.[String(options.port)], options.https)) continue;
		candidates.push({ hostPort, handler });
	}
	if (candidates.length > 1) {
		return { ok: false, reason: "multiple existing DSH proxy routes match this listener; ownership is ambiguous" };
	}
	if (candidates.length === 0) return { ok: true, ownership: null };
	const candidate = candidates[0];
	return {
		ok: true,
		ownership: {
			hostPort: candidate.hostPort,
			port: options.port,
			managedHandler: structuredClone(candidate.handler),
			managedTcp: structuredClone(config.TCP[String(options.port)]),
			beforeTcp: structuredClone(config.TCP[String(options.port)]),
			managedFunnel: funnelStateAtPort(config, options.port),
			removeOnExit: false,
		},
	};
}

function findManagedRoute(beforeConfig, managedConfig, options) {
	const candidates = [];
	for (const [hostPort, web] of Object.entries(managedConfig?.Web ?? {})) {
		if (hostPortNumber(hostPort) !== options.port) continue;
		const handler = web?.Handlers?.["/"];
		if (!jsonEqual(handler, { Proxy: options.target })) continue;
		candidates.push({ hostPort, handler });
	}
	if (candidates.length !== 1) {
		return {
			ok: false,
			reason: candidates.length === 0
				? "Serve exited successfully, but no matching DSH proxy route appeared in Tailscale's node-level config"
				: "multiple matching DSH proxy routes appeared; ownership is ambiguous",
		};
	}

	const candidate = candidates[0];
	const managedTcp = managedConfig?.TCP?.[String(options.port)];
	if (!expectedTcpMode(managedTcp, options.https)) {
		return { ok: false, reason: `the matching route did not enable the expected port ${String(options.port)} mode` };
	}
	const beforeWeb = beforeConfig?.Web?.[candidate.hostPort] ?? null;
	const beforeHandler = beforeWeb?.Handlers?.["/"] ?? null;
	if (beforeHandler && !jsonEqual(beforeHandler, candidate.handler)) {
		return { ok: false, reason: `the route at ${candidate.hostPort} changed while this plugin was configuring it` };
	}
	const beforeTcp = beforeConfig?.TCP?.[String(options.port)]
		? structuredClone(beforeConfig.TCP[String(options.port)])
		: null;
	const beforeHadExactRoute = Boolean(beforeHandler && jsonEqual(beforeHandler, candidate.handler));

	return {
		ok: true,
		ownership: {
			hostPort: candidate.hostPort,
			port: options.port,
			managedHandler: structuredClone(candidate.handler),
			managedTcp: structuredClone(managedTcp),
			beforeTcp,
			managedFunnel: funnelStateAtPort(managedConfig, options.port),
			removeOnExit: !beforeHadExactRoute,
		},
	};
}

function validateOwnedRoute(config, ownership, https) {
	const candidates = [];
	for (const [hostPort, web] of Object.entries(config?.Web ?? {})) {
		if (hostPortNumber(hostPort) !== ownership.port) continue;
		const handler = web?.Handlers?.["/"];
		if (!jsonEqual(handler, ownership.managedHandler)) continue;
		candidates.push({ hostPort, handler });
	}
	if (candidates.length !== 1) {
		return {
			ok: false,
			reason: candidates.length === 0
				? "the verified DSH proxy route disappeared before it could be announced"
				: "multiple matching DSH proxy routes are present; ownership is ambiguous",
		};
	}
	if (candidates[0].hostPort !== ownership.hostPort) {
		return { ok: false, reason: "the verified DSH proxy route moved to a different tailnet host" };
	}
	const managedTcp = config?.TCP?.[String(ownership.port)];
	if (!expectedTcpMode(managedTcp, https)) {
		return { ok: false, reason: "the verified DSH proxy route no longer has the expected listener mode" };
	}
	return {
		ok: true,
		managedTcp: structuredClone(managedTcp),
		managedFunnel: funnelStateAtPort(config, ownership.port),
	};
}

function endpointUrlFromHostPort(hostPort, https) {
	const host = hostPortHostname(hostPort);
	if (!host) return null;
	const wrapped = isIP(host) === 6 ? `[${host}]` : host;
	const port = hostPortNumber(hostPort);
	const portSuffix = port === (https ? 443 : 80) ? "" : `:${String(port)}`;
	return `${https ? "https" : "http"}://${wrapped}${portSuffix}`;
}

function removeOwnedRoute(currentConfig, ownership) {
	if (!ownership.removeOnExit) return { ok: true, changed: false, config: currentConfig };
	const currentFunnel = funnelStateAtPort(currentConfig, ownership.port);
	const funnelChanged = !jsonEqual(currentFunnel, ownership.managedFunnel ?? {});
	const currentHandler = currentConfig?.Web?.[ownership.hostPort]?.Handlers?.["/"];
	if (!jsonEqual(currentHandler, ownership.managedHandler)) {
		return { ok: false, reason: "the DSH root handler was changed by another process" };
	}
	// Funnel is another process's public listener. Remove only this plugin's
	// handler, preserving the current TCP/Funnel state instead of trying to
	// tear down a listener that the other process may now depend on.
	if (funnelChanged || funnelAtPort(currentConfig, ownership.port)) {
		const safe = removeOwnedHandlerOnly(currentConfig, ownership);
		return safe.ok ? { ...safe, funnelChanged: true } : safe;
	}
	const currentTcp = currentConfig?.TCP?.[String(ownership.port)];
	if (!jsonEqual(currentTcp, ownership.managedTcp)) {
		return { ok: false, reason: "the DSH listener mode was changed by another process" };
	}

	const next = structuredClone(currentConfig ?? {});
	delete next.Web[ownership.hostPort].Handlers["/"];
	if (Object.keys(next.Web[ownership.hostPort].Handlers).length === 0) delete next.Web[ownership.hostPort];
	if (Object.keys(next.Web).length === 0) delete next.Web;

	if (ownership.beforeTcp) next.TCP[String(ownership.port)] = structuredClone(ownership.beforeTcp);
	else {
		const portStillUsed = Object.entries(next.Web ?? {}).some(([hostPort, web]) =>
			hostPortNumber(hostPort) === ownership.port && Object.keys(web?.Handlers ?? {}).length > 0,
		);
		if (!portStillUsed) delete next.TCP[String(ownership.port)];
	}
	if (next.TCP && Object.keys(next.TCP).length === 0) delete next.TCP;

	return { ok: true, changed: !jsonEqual(next, currentConfig), config: next };
}

function removeOwnedHandlerOnly(currentConfig, ownership) {
	const currentHandler = currentConfig?.Web?.[ownership.hostPort]?.Handlers?.["/"];
	if (!jsonEqual(currentHandler, ownership.managedHandler)) {
		return { ok: false, reason: "the DSH root handler changed before the Funnel safety rollback" };
	}
	const next = structuredClone(currentConfig ?? {});
	delete next.Web[ownership.hostPort].Handlers["/"];
	if (Object.keys(next.Web[ownership.hostPort].Handlers).length === 0) delete next.Web[ownership.hostPort];
	if (Object.keys(next.Web).length === 0) delete next.Web;
	return { ok: true, changed: !jsonEqual(next, currentConfig), config: next };
}

function preconditionFailed(result) {
	return result?.status === 412 || /precondition|etag mismatch|another client is changing/i.test(commandOutput(result));
}

/**
 * Add the served tailnet host to DSH's `/api` browser-trust fence.
 *
 * DSH's web-app bundle wires the fence (dsh-client-connection) to
 * `trustedHosts: !!js ctx.webRuntime.trustedHosts` — a patch expression that
 * evaluates to the SAME array object the web-runtime service exposes. The
 * fence reads that array per request, so pushing the tailnet hostname here is
 * visible to the already-applied fence: no `--trusted-host` flag is required,
 * and the change is re-applied on every startup.
 *
 * @param ctx - plugin context carrying the `webRuntime` service (injected;
 * also probed via ctx.get for safety in unusual compositions).
 * @param url - the resolved serve URL, or null when unknown.
 */
function trustTailnetHost(ctx, url, log = note) {
	if (!url) return;
	let host;
	try {
		host = new URL(url).hostname;
	} catch {
		return;
	}
	if (!host) return;
	// Injected in the web profile; the ctx.get fallback keeps this harmless if
	// some composition ever mounts the plugin without the web bundle.
	const runtime = ctx.webRuntime ?? ctx.get?.("webRuntime");
	if (!runtime || !Array.isArray(runtime.trustedHosts)) return;
	if (runtime.trustedHosts.includes(host)) return;
	runtime.trustedHosts.push(host);
	log(ctx, `added ${host} to the DSH /api trust fence`);
}

const DEFAULT_RETRY_DELAYS_MS = [3000, 3000, 5000, 5000, 10000, 10000, 15000, 15000];

function applyWithDeps(ctx, config = {}, deps = {}) {
	const run = deps.runTailscale ?? runTailscale;
	const getSelfInfo = deps.selfInfo ?? (() => selfInfo(run));
	const schedule = deps.setTimeout ?? setTimeout;
	const cancelSchedule = deps.clearTimeout ?? clearTimeout;
	const retryDelays = deps.retryDelays ?? DEFAULT_RETRY_DELAYS_MS;
	const logNote = deps.note ?? note;
	const logWarn = deps.warn ?? warn;
	const makeConfigStore = deps.createServeConfigStore ?? createServeConfigStore;
	registerDriveRpc(ctx, deps);

	const enabled = config.enabled !== false;
	if (!enabled) {
		logNote(ctx, "disabled by config (enabled:false); DSH stays on loopback only");
		return;
	}

	const port = ctx.webServer?.port;
	if (!port) {
		logWarn(ctx, "webServer has no listening port; skipping serve");
		return;
	}

	if (!tailscaleAvailable(run)) {
		logWarn(
			ctx,
			"`tailscale` CLI not found — install Tailscale and log in (`tailscale up`), or add the CLI to PATH, then restart DSH",
		);
		return;
	}

	const https = config.https !== false;
	let publicPort;
	try {
		publicPort = servePublicPort(config, https);
	} catch (error) {
		logWarn(ctx, error.message);
		return;
	}

	const bindHost = typeof ctx.webServer?.host === "string" ? ctx.webServer.host : "";
	let serveTarget;
	let serveArgs;
	try {
		serveTarget = proxyTargetForBind(bindHost, port);
		serveArgs = buildServeArgs(config, serveTarget);
	} catch (error) {
		logWarn(ctx, error.message);
		return;
	}

	if (bindHost && bindHost !== "127.0.0.1" && bindHost !== "localhost") {
		logNote(ctx, `DSH is bound to ${bindHost}; proxying tailnet traffic to ${serveTarget}`);
	}

	const configuredUrl = resolveConfiguredUrl(config.hostname, https);
	if (config.hostname && !configuredUrl) {
		logWarn(ctx, `ignoring invalid hostname config: ${String(config.hostname)}`);
	}
	if (configuredUrl) trustTailnetHost(ctx, configuredUrl, logNote);

	let retryIndex = 0;
	let timer = null;
	let disposed = false;
	let beforeSnapshot = null;
	let ownership = null;
	let safetyRollbackFailed = false;
	const keepOnExit = config.keepOnExit === true;
	const state = {
		identityKnown: configuredUrl !== null,
		serveConfigured: false,
		routeVerified: false,
		endpointUrl: configuredUrl,
		settled: false,
		attempts: 0,
	};

	let configStore;
	try {
		configStore = makeConfigStore(deps.runTailscaleLocalApi);
	} catch (error) {
		logWarn(ctx, `could not initialize Tailscale's node-level Serve config client: ${error.message}`);
		return;
	}

	function discoverIdentity() {
		if (state.identityKnown) return;
		const discoveredUrl = resolveServeUrl(getSelfInfo(), https);
		if (!discoveredUrl) return;
		state.identityKnown = true;
		state.endpointUrl ??= discoveredUrl;
		trustTailnetHost(ctx, discoveredUrl, logNote);
	}

	function warnPermission(operation, result) {
		const detail = commandOutput(result);
		logWarn(
			ctx,
			`${operation} was denied by Tailscale${detail ? ` — ${detail}` : ""}. ` +
				"On Windows, run DSH from an Administrator shell or grant this user permission to manage Tailscale. " +
				"A DNS name from `tailscale status` does not mean Serve was configured.",
		);
	}

	function scheduleRetry() {
		if (retryIndex >= retryDelays.length) return false;
		const delay = retryDelays[retryIndex++];
		timer = schedule(() => attempt(true), delay);
		timer?.unref?.();
		return true;
	}

	function finalFailure(message) {
		if (scheduleRetry()) return;
		logWarn(ctx, message);
	}

	function settle(isRetry) {
		state.settled = true;
		logNote(
			ctx,
			isRetry
				? `Tailscale became ready; DSH web is now reachable on your tailnet: ${state.endpointUrl}`
				: `DSH web is now reachable on your tailnet: ${state.endpointUrl}`,
		);
		logNote(
			ctx,
			https
				? "TLS is handled by Tailscale. Phone: install Tailscale, join the same tailnet, open that URL."
				: "Plain HTTP. Phone: install Tailscale, join the same tailnet, open that URL.",
		);
	}

	function rollbackFunnelRace(nextOwnership, managedSnapshot, funnelHostPort) {
		let snapshot = managedSnapshot;
		for (let attemptIndex = 0; attemptIndex < 3; attemptIndex += 1) {
			const rollback = removeOwnedRoute(snapshot.config, nextOwnership);
			if (!rollback.ok || !rollback.changed) {
				safetyRollbackFailed = true;
				logWarn(
					ctx,
					`Tailscale Funnel became enabled at ${funnelHostPort}, but the DSH route could not be rolled back safely` +
						`${rollback.reason ? ` — ${rollback.reason}` : ""}. Inspect 'tailscale serve status --json' immediately.`,
				);
				return;
			}
			const updated = configStore.compareAndSet(rollback.config, snapshot.etag);
			if (updated.ok) break;
			if (preconditionFailed(updated) && attemptIndex < 2) {
				const current = configStore.capture("funnel-rollback-current");
				if (current.ok) {
					snapshot = current.snapshot;
					continue;
				}
			}
			safetyRollbackFailed = true;
			const detail = commandOutput(updated);
			logWarn(
				ctx,
				`Tailscale Funnel became enabled at ${funnelHostPort}, and the ETag-protected DSH route rollback failed` +
					`${detail ? ` — ${detail}` : ""}. Inspect 'tailscale serve status --json' immediately.`,
			);
			return;
		}
		ownership = null;
		state.serveConfigured = false;
		state.routeVerified = false;
		logWarn(
			ctx,
			`Tailscale Funnel became enabled at ${funnelHostPort} while the DSH route was being configured. ` +
				"The plugin removed its route without changing the concurrent Funnel state; no endpoint was announced.",
		);
	}

		function useVerifiedOwnership(nextOwnership, isRetry) {
			ownership = nextOwnership;
			state.serveConfigured = true;
			const latest = configStore.capture("latest");
			if (!latest.ok) {
				state.routeVerified = false;
				state.serveConfigured = false;
				beforeSnapshot = null;
				ownership = null;
				const detail = commandOutput(latest.result);
				logWarn(
					ctx,
					`the verified DSH route could not be rechecked before announcement${detail ? ` — ${detail}` : ""}; ` +
						"the endpoint is not being announced",
				);
				return;
			}

			const current = validateOwnedRoute(latest.snapshot.config, ownership, https);
			if (!current.ok) {
				state.routeVerified = false;
				state.serveConfigured = false;
				beforeSnapshot = null;
				ownership = null;
				logWarn(ctx, `${current.reason}; the endpoint is not being announced`);
				return;
			}

			ownership.managedTcp = current.managedTcp;
			ownership.managedFunnel = current.managedFunnel;
			state.routeVerified = true;

			const funnelHostPort = funnelAtPort({ AllowFunnel: ownership.managedFunnel }, ownership.port);
			if (funnelHostPort) {
				state.routeVerified = false;
				if (ownership.removeOnExit) {
					rollbackFunnelRace(ownership, latest.snapshot, funnelHostPort);
				} else {
					safetyRollbackFailed = true;
					logWarn(
						ctx,
						`Tailscale Funnel is enabled at ${funnelHostPort} for a pre-existing DSH route. ` +
							"The route was not changed or announced; inspect the existing Serve/Funnel configuration.",
					);
				}
				return;
			}

			const routeUrl = endpointUrlFromHostPort(ownership.hostPort, https);
			if (!routeUrl) {
				state.endpointUrl = null;
				logWarn(
					ctx,
					"the DSH Serve route was verified, but its public hostname could not be derived; " +
						"the endpoint is not being announced. Set hostname and restart DSH.",
				);
				return;
			}
			if (configuredUrl && new URL(configuredUrl).origin !== new URL(routeUrl).origin) {
				logWarn(
					ctx,
					`configured hostname resolved to ${configuredUrl}, but Tailscale owns the verified route at ${routeUrl}; using the actual route`,
				);
			}
			state.identityKnown = true;
			state.endpointUrl = routeUrl;
			trustTailnetHost(ctx, routeUrl, logNote);
			settle(isRetry);
		}

	function verifyConfiguredRoute(isRetry) {
		const captured = configStore.capture("managed");
		if (!captured.ok) {
			if (permissionDenied(captured.result)) {
				warnPermission("verifying the configured Serve route", captured.result);
				return;
			}
			const detail = commandOutput(captured.result);
			finalFailure(
				`Serve exited successfully, but its node-level route could not be verified${detail ? ` — ${detail}` : ""}. ` +
					"The plugin will not report a reachable endpoint or attempt destructive cleanup.",
			);
			return;
		}

		const found = findManagedRoute(beforeSnapshot.config, captured.snapshot.config, {
			https,
			port: publicPort,
			target: serveTarget,
		});
		if (!found.ok) {
			logWarn(
				ctx,
				`${found.reason}. The endpoint is not being announced; check serveArgs and 'tailscale serve status --json'.`,
			);
			return;
		}

			useVerifiedOwnership(found.ownership, isRetry);
	}

	function attempt(isRetry) {
		if (disposed || state.settled) return;
		state.attempts += 1;
		discoverIdentity();

		if (state.serveConfigured) {
			verifyConfiguredRoute(isRetry);
			return;
		}

		const captured = configStore.capture("before");
		if (!captured.ok) {
			if (permissionDenied(captured.result)) {
				warnPermission("reading the existing node-level Serve configuration", captured.result);
				return;
			}
			const detail = commandOutput(captured.result);
			if (!isRetry) {
				logWarn(
					ctx,
					`could not read the existing node-level Serve configuration${detail ? ` — ${detail}` : ""}; ` +
						"waiting for Tailscale before making any change",
				);
			}
			finalFailure("could not read Serve after all retries; no Serve change was made");
			return;
		}

		const conflict = inspectServeConflict(captured.snapshot.config, publicPort, https, serveTarget);
		if (conflict) {
			logWarn(ctx, `${conflict}. The existing configuration was left unchanged.`);
			return;
		}
		const existing = findOwnedExistingRoute(captured.snapshot.config, {
			https,
			port: publicPort,
			target: serveTarget,
		});
		if (!existing.ok) {
			logWarn(ctx, `${existing.reason}. The existing configuration was left unchanged.`);
			return;
		}
		if (existing.ownership) {
			beforeSnapshot = captured.snapshot;
				useVerifiedOwnership(existing.ownership, isRetry);
			return;
		}
		beforeSnapshot = captured.snapshot;

		const served = run(serveArgs, ctx);
		if (served.status !== 0) {
			beforeSnapshot = null;
			if (permissionDenied(served)) {
				warnPermission(`'tailscale ${serveArgs.join(" ")}'`, served);
				return;
			}
			if (!isRetry) {
				const detail = commandOutput(served);
				logWarn(
					ctx,
					`'tailscale ${serveArgs.join(" ")}' did not exit cleanly${detail ? ` — ${detail}` : ""}. Retrying while Tailscale finishes starting.`,
				);
			}
			finalFailure(
				"could not configure Tailscale Serve after all retries. DSH stays reachable on loopback; " +
					"a successful identity lookup alone is not evidence of a working remote endpoint.",
			);
			return;
		}

		state.serveConfigured = true;
		verifyConfiguredRoute(isRetry);
	}

	async function dispose() {
		disposed = true;
		if (timer) {
			cancelSchedule(timer);
			timer = null;
		}
		if (keepOnExit || safetyRollbackFailed || !ownership || !ownership.removeOnExit) return;

		try {
			for (let attemptIndex = 0; attemptIndex < 3; attemptIndex += 1) {
				const current = configStore.capture("cleanup-current");
				if (!current.ok) {
					const detail = commandOutput(current.result);
					if (permissionDenied(current.result)) warnPermission("reading Serve during cleanup", current.result);
					else logWarn(ctx, `could not read Serve during cleanup${detail ? ` — ${detail}` : ""}; leaving it unchanged`);
					return;
				}

				const removal = removeOwnedRoute(current.snapshot.config, ownership);
				if (!removal.ok) {
					logWarn(ctx, `${removal.reason}; leaving the current Serve configuration unchanged`);
					return;
				}
				if (!removal.changed) return;

				const updated = configStore.compareAndSet(removal.config, current.snapshot.etag);
				if (updated.ok) {
					logNote(ctx, `removed the DSH root handler at ${ownership.hostPort} without changing other Serve routes`);
					return;
				}
				if (preconditionFailed(updated) && attemptIndex < 2) continue;
				const detail = commandOutput(updated);
				if (permissionDenied(updated)) warnPermission("removing the DSH Serve route", updated);
				else if (preconditionFailed(updated)) {
					logWarn(ctx, "Serve kept changing during cleanup; leaving the latest configuration unchanged");
				} else {
					logWarn(ctx, `could not remove the DSH Serve route${detail ? ` — ${detail}` : ""}`);
				}
				return;
			}
		} finally {
			configStore.cleanup();
		}
	}

	ctx.effect(() => dispose, "tailscale-serve.cleanup");
	attempt(false);
	return { attempt, dispose, state };
}

function apply(ctx, config = {}) {
	return applyWithDeps(ctx, config);
}

function note(ctx, message) {
	// URL/info lines belong to the shell, like the built-in web-runtime does.
	process.stderr.write(`tailscale-serve: ${message}\n`);
	ctx.logger?.info?.(message);
}

function warn(ctx, message) {
	process.stderr.write(`tailscale-serve: warning: ${message}\n`);
	ctx.logger?.warn?.(message);
}

export {
	apply,
	applyWithDeps,
	buildServeArgs,
	canonicalServeConfig,
	createServeConfigStore,
	inject,
	listWindowsDrives,
	name,
	permissionDenied,
	registerDriveRpc,
	proxyTargetForBind,
	resolveConfiguredUrl,
	resolveServeUrl,
	runTailscaleLocalApi,
	selectTailscaleCandidate,
	servePublicPort,
	tailscaleAvailable,
};
