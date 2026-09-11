// dsh-remote — expose the DSH web GUI over your Tailscale tailnet.
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
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, opendir, readdir, stat } from "node:fs/promises";
import http from "node:http";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { dirname, join, posix, win32 } from "node:path";
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const name = "dsh-remote";
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

const DRIVE_PROBE_TIMEOUT_MS = 2_000;

/**
 * Return the ready local Windows drive roots without reading their contents.
 * A missing/unready drive is skipped; non-Windows hosts keep the ordinary
 * home-rooted directory browser by returning an empty list. Probes run
 * concurrently and each is time-bounded: a disconnected network mapping can
 * stat for seconds, and this must never freeze the shared DSH event loop.
 */
async function listWindowsDrives(options = {}) {
	const platform = options.platform ?? process.platform;
	if (platform !== "win32") return [];
	const probe = options.stat ?? stat;
	const timeoutMs = options.probeTimeoutMs ?? DRIVE_PROBE_TIMEOUT_MS;
	const letters = Array.from({ length: 26 }, (_, index) => String.fromCharCode(65 + index));
	const roots = await Promise.all(letters.map(async (letter) => {
		const root = `${letter}:\\`;
		try {
			const entry = await boundedDriveProbe(probe(root), timeoutMs);
			return entry?.isDirectory() === true ? root : null;
		} catch {
			// Empty removable drives, disconnected mappings and slow probes are
			// not useful roots.
			return null;
		}
	}));
	return roots.filter((root) => root !== null);
}

/** Bound one drive probe in time; a probe that loses never yields a drive. */
function boundedDriveProbe(pending, timeoutMs) {
	if (!(timeoutMs > 0)) return pending;
	let timer;
	const deadline = new Promise((resolve) => {
		timer = setTimeout(() => resolve(null), timeoutMs);
	});
	return Promise.race([pending, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Ready macOS volume roots under /Volumes, the Unix analogue of drive letters.
 * Hidden entries (dot-prefixed, e.g. timemachine staging) are skipped and each
 * volume must stat as a directory within the same time bound as the Windows
 * probes; any failure degrades to the ordinary home-rooted browser.
 */
async function listMacVolumeRoots(options = {}) {
	const platform = options.platform ?? process.platform;
	if (platform !== "darwin") return [];
	const timeoutMs = options.probeTimeoutMs ?? DRIVE_PROBE_TIMEOUT_MS;
	let entries;
	try {
		entries = await boundedDriveProbe((options.readdir ?? readdir)("/Volumes"), timeoutMs);
	} catch {
		return [];
	}
	if (!Array.isArray(entries)) return [];
	const roots = [];
	for (const entry of entries) {
		if (isHiddenEntry(entry.name)) continue;
		const root = posix.join("/Volumes", entry.name);
		try {
			const info = await boundedDriveProbe((options.stat ?? stat)(root), timeoutMs);
			if (info?.isDirectory() === true) roots.push(root);
		} catch {
			// An unmounted or slow volume is not a useful root.
		}
	}
	return roots.sort();
}

/**
 * Platform entry point for the picker's root list: Windows drive letters,
 * macOS volumes, and an empty list elsewhere so the browser falls back to the
 * host account's home directory.
 */
async function listHostRoots(options = {}) {
	const platform = options.platform ?? process.platform;
	if (platform === "win32") return listWindowsDrives(options);
	if (platform === "darwin") return listMacVolumeRoots(options);
	return [];
}

const DIRECTORY_ENTRY_LIMIT = 1000;

/**
 * Windows system folders that Explorer hides by default. Node's fs does not
 * expose the Hidden/System attributes, so these well-known names carry the
 * same hidden flag as dot-prefixed entries — the phone picker would otherwise
 * show them unconditionally while the PC's own dialog does not. The picker's
 * 显示隐藏文件 toggle reveals them again.
 */
const WINDOWS_SYSTEM_DIRS = new Set([
	"$RECYCLE.BIN",
	"SYSTEM VOLUME INFORMATION",
	"CONFIG.MSI",
	"DELIVERYOPTIMIZATION",
	"RECOVERY",
	"$WINREAGENT",
	"MSOCACHE",
	"WINDOWSAPPS",
	"WPSYSTEM",
	"EFI",
	// legacy compatibility junctions (hidden in Explorer; e.g.
	// "Documents and Settings" -> C:\Users) whose content confuses the picker
	"DOCUMENTS AND SETTINGS",
	"APPLICATION DATA",
	"LOCAL SETTINGS",
	"MY DOCUMENTS",
	"COOKIES",
	"NETHOOD",
	"PRINTHOOD",
	"RECENT",
	"SENDTO",
	"TEMPLATES",
	"START MENU",
	"开始菜单",
]);

function isHiddenEntry(name) {
	return name.startsWith(".") || WINDOWS_SYSTEM_DIRS.has(name.toUpperCase());
}

function directoryPathApi(platform) {
	return platform === "win32" ? win32 : posix;
}

/** Windows rooted paths must include a drive or a complete UNC authority. */
function fullyQualifiedDirectoryPath(value, platform = process.platform) {
	if (typeof value !== "string") return false;
	if (platform !== "win32") return posix.isAbsolute(value);
	return win32.isAbsolute(value) && /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/]+[^\\/]+)/u.test(value);
}

function directoryError(code, path, message) {
	const error = new Error(message);
	error.directoryCode = code;
	error.directoryPath = path;
	return error;
}

function directoryCrumbs(target, pathApi) {
	const crumbs = [];
	let current = target;
	for (;;) {
		const parent = pathApi.dirname(current);
		crumbs.unshift({
			name: parent === current ? current : pathApi.basename(current),
			path: current,
			hidden: false,
		});
		if (parent === current) return crumbs;
		current = parent;
	}
}

/**
 * Windows Explorer-style entry order: Latin/digit names first, then everything
 * else (CJK and symbols), case-insensitive and numeric-aware ("2" before
 * "10"). Plain lexicographic localeCompare puts "10" before "2" and, under
 * the ICU zh-CN default, CJK names before Latin ones — neither matches what
 * the PC's Explorer shows. The pre-sort by first-character class reproduces
 * Explorer's script ordering, and the shared Collator applies natural order.
 */
const explorerCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const HAN_FIRST_RE = /^\p{Script=Han}/u;
function explorerEntryCompare(left, right) {
	const a = typeof left === "string" ? left : left?.name ?? "";
	const b = typeof right === "string" ? right : right?.name ?? "";
	// Explorer keeps punctuation/numbers/Latin before Han (zh-CN sorts CJK by
	// pinyin, after Latin), while ICU's zh collation alone places Han first —
	// the one-script-class tie-break reproduces Explorer's script ordering.
	const aHan = HAN_FIRST_RE.test(a) ? 1 : 0;
	const bHan = HAN_FIRST_RE.test(b) ? 1 : 0;
	if (aHan !== bHan) return aHan - bHan;
	return explorerCollator.compare(a, b);
}

function boundedDirectoryInsert(window, candidate, keep) {
	if (window.length === keep && explorerEntryCompare(candidate.name, window.at(-1).name) >= 0) return true;
	let low = 0;
	let high = window.length;
	while (low < high) {
		const middle = low + high >>> 1;
		if (explorerEntryCompare(candidate.name, window[middle].name) < 0) high = middle;
		else low = middle + 1;
	}
	window.splice(low, 0, candidate);
	if (window.length <= keep) return false;
	window.pop();
	return true;
}

async function abortableDirectoryOperation(operation, signal) {
	if (signal === undefined) return operation;
	const pending = Promise.resolve(operation);
	if (signal.aborted) {
		pending.catch(() => {});
		throw signal.reason ?? new Error("directory request aborted");
	}
	return await new Promise((resolve, reject) => {
		const onAbort = () => {
			pending.catch(() => {});
			reject(signal.reason ?? new Error("directory request aborted"));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		pending.then((value) => {
			signal.removeEventListener("abort", onAbort);
			resolve(value);
		}, (error) => {
			signal.removeEventListener("abort", onAbort);
			reject(error);
		});
	});
}

/** List one host directory level for the phone-only browser. */
async function listHostDirectory(path, options = {}) {
	const platform = options.platform ?? process.platform;
	const pathApi = directoryPathApi(platform);
	const home = pathApi.resolve(options.home ?? homedir());
	const source = path ?? home;
	if (!fullyQualifiedDirectoryPath(source, platform)) {
		throw directoryError("directory-unreadable", String(source), `cannot list "${String(source)}": not a fully qualified path`);
	}
	const target = pathApi.resolve(source);
	const signal = options.signal;
	const openDirectory = options.opendir ?? opendir;
	const statDirectory = options.stat ?? stat;
	const keep = (options.maxEntries ?? DIRECTORY_ENTRY_LIMIT) + 1;
	const candidates = [];
	let truncated = false;
	let directory;
	try {
		const opening = Promise.resolve(openDirectory(target));
		try {
			directory = await abortableDirectoryOperation(opening, signal);
		} catch (error) {
			opening.then((lateDirectory) => Promise.resolve(lateDirectory?.close?.()).catch(() => {}), () => {});
			throw error;
		}
		for (;;) {
			const dirent = await abortableDirectoryOperation(directory.read(), signal);
			if (dirent === null) break;
			if (!dirent.isDirectory() && !dirent.isSymbolicLink()) continue;
			if (boundedDirectoryInsert(candidates, { name: dirent.name, dirent }, keep)) truncated = true;
		}
	} catch (error) {
		signal?.throwIfAborted();
		if (error?.directoryCode) throw error;
		throw directoryError("directory-unreadable", target, `cannot list ${target}: ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		if (directory !== undefined) {
			try {
				const closing = Promise.resolve(directory.close());
				if (signal?.aborted) closing.catch(() => {});
				else await closing;
			} catch { /* an aborted read owns the close result */ }
		}
	}

	const entries = [];
	for (const candidate of candidates) {
		signal?.throwIfAborted();
		let enterable = candidate.dirent.isDirectory();
		if (!enterable && candidate.dirent.isSymbolicLink()) {
			try {
				enterable = (await abortableDirectoryOperation(statDirectory(pathApi.join(target, candidate.name)), signal)).isDirectory();
			} catch (error) {
				signal?.throwIfAborted();
				continue;
			}
		}
		if (!enterable) continue;
		if (entries.length === (options.maxEntries ?? DIRECTORY_ENTRY_LIMIT)) {
			truncated = true;
			break;
		}
		entries.push({
			name: candidate.name,
			path: pathApi.join(target, candidate.name),
			hidden: isHiddenEntry(candidate.name),
		});
	}
	return {
		path: target,
		home,
		crumbs: directoryCrumbs(target, pathApi),
		entries,
		truncated,
	};
}

/** Create one child directory for the phone-only browser. */
async function createHostDirectory(path, name, options = {}) {
	const platform = options.platform ?? process.platform;
	const pathApi = directoryPathApi(platform);
	if (!fullyQualifiedDirectoryPath(path, platform)) {
		throw directoryError("directory-create-failed", String(path), `cannot create under "${String(path)}": not a fully qualified parent path`);
	}
	if (typeof name !== "string" || name.trim() === "" || name === "." || name === ".." || /[\\/]/u.test(name)) {
		throw directoryError("directory-create-failed", pathApi.join(pathApi.resolve(path), String(name)), `"${String(name)}" is not a single path segment`);
	}
	const target = pathApi.join(pathApi.resolve(path), name);
	try {
		await (options.mkdir ?? mkdir)(target);
		return target;
	} catch (error) {
		if (error?.code === "EEXIST") throw directoryError("directory-exists", target, `${target} already exists`);
		throw directoryError("directory-create-failed", target, `cannot create ${target}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function rpcDirectoryError(error, signal) {
	if (signal?.aborted) return { code: "cancelled", message: "directory request was aborted", details: {} };
	if (error?.directoryCode) return {
		code: error.directoryCode,
		message: error.message,
		details: { path: error.directoryPath },
	};
	return { code: "internal", message: error instanceof Error ? error.message : String(error), details: {} };
}

/** Error envelope for the model-discovery endpoint; keeps LlmError codes. */
function rpcLlmError(error) {
	return {
		code: typeof error?.code === "string" && error.code.length > 0 ? error.code : "internal",
		message: error instanceof Error ? error.message : String(error),
		details: {},
	};
}

/** Error envelope for the credentials-plane endpoints; keeps seam error codes. */
function rpcCredentialsError(error) {
	return {
		code: typeof error?.code === "string" && error.code.length > 0 ? error.code : "credential-rejected",
		message: error instanceof Error ? error.message : String(error),
		details: {},
	};
}

/** Error envelope for the settings-plane endpoints; keeps seam error codes. */
function rpcSettingsError(error) {
	return {
		code: typeof error?.code === "string" && error.code.length > 0 ? error.code : "settings-rejected",
		message: error instanceof Error ? error.message : String(error),
		details: {},
	};
}

/**
 * Map one settings descriptor to the wire view the settings page parses,
 * mirroring DSH's own namespaceView (secrets already redacted by the provider).
 */
function settingsNamespaceView(descriptor) {
	return {
		ns: String(descriptor.ns),
		schema: descriptor.schema,
		value: descriptor.value,
		...(descriptor.base === undefined ? {} : { base: descriptor.base }),
		...(descriptor.user === undefined ? {} : { user: descriptor.user }),
		applies: descriptor.applies,
		secrets: (descriptor.secrets ?? []).map((secret) => ({
			path: [...secret.path],
			set: secret.set,
		})),
		revision: descriptor.revision,
	};
}

/** Register the phone directory browser's trusted private RPC channel. */
function registerDirectoryRpc(ctx, deps = {}) {
	const enumerate = deps.listHostRoots ?? listHostRoots;
	const list = deps.listHostDirectory ?? listHostDirectory;
	const create = deps.createHostDirectory ?? createHostDirectory;
	const handler = async (endpoint, payload, signal) => {
			if (endpoint === "listDrives") {
				try {
					return { ok: true, value: { drives: await enumerate() } };
				} catch (error) {
					return { ok: false, error: rpcDirectoryError(error, signal) };
				}
			}
			if (endpoint === "listDirectory") {
				if (payload !== undefined && (typeof payload !== "object" || payload === null || Array.isArray(payload) || ("path" in payload && payload.path !== undefined && typeof payload.path !== "string"))) {
					return { ok: false, error: { code: "bad-request", message: "listDirectory requires an optional string path", details: { issues: [] } } };
				}
				try {
					return { ok: true, value: await list(payload?.path, { signal }) };
				} catch (error) {
					return { ok: false, error: rpcDirectoryError(error, signal) };
				}
			}
			if (endpoint === "createDirectory") {
				if (typeof payload !== "object" || payload === null || Array.isArray(payload) || typeof payload.path !== "string" || typeof payload.name !== "string") {
					return { ok: false, error: { code: "bad-request", message: "createDirectory requires string path and name", details: { issues: [] } } };
				}
				try {
					return { ok: true, value: { path: await create(payload.path, payload.name, { signal }) } };
				} catch (error) {
					return { ok: false, error: rpcDirectoryError(error, signal) };
				}
			}
			if (endpoint === "discoverModels") {
				// DSH pins llm.discoverModels to loopback because it carries a draft
				// credential and makes the host probe a caller-chosen URL. The phone
				// reaches this channel through tailnet-membership auth, so the plugin
				// proxies it on behalf of the settings page (see README security
				// boundary). The DSH llm service is resolved lazily so this stays
				// optional when the LLM stack is absent.
				if (typeof payload !== "object" || payload === null || Array.isArray(payload) || typeof payload.settingsNs !== "string" || payload.settingsNs.length === 0) {
					return { ok: false, error: { code: "bad-request", message: "discoverModels requires a non-empty settingsNs string", details: { issues: [] } } };
				}
				const llm = ctx.get?.("llm") ?? ctx.llm;
				if (typeof llm?.discoverModels !== "function") {
					return { ok: false, error: { code: "unavailable", message: "the DSH llm service is not available", details: { issues: [] } } };
				}
				try {
					const request = {};
					for (const key of ["provider", "baseURL", "api", "apiKey"]) {
						if (typeof payload[key] === "string" && payload[key].length > 0) request[key] = payload[key];
					}
					const models = await llm.discoverModels(payload.settingsNs, request);
					if (!Array.isArray(models)) throw new Error("llm.discoverModels returned an invalid result");
					return { ok: true, value: { models } };
				} catch (error) {
					return { ok: false, error: rpcLlmError(error) };
				}
			}
			if (endpoint === "settingsDescribe") {
				// Read-only mirror of DSH's settings.describe, which DSH pins to
				// loopback. The provider redacts secret values (only presence flags
				// cross), and the settings page needs the writable flag and namespace
				// views to render correctly on the phone.
				const settings = ctx.get?.("settings") ?? ctx.settings;
				if (typeof settings?.describe !== "function") {
					return { ok: false, error: { code: "unavailable", message: "the DSH settings service is not available", details: { issues: [] } } };
				}
				try {
					const namespaces = settings.describe({ redactSecrets: true }).map(settingsNamespaceView);
					return {
						ok: true,
						value: {
							writable: settings.writable,
							hasDocument: settings.documentPath !== undefined,
							namespaces,
						},
					};
				} catch (error) {
					return { ok: false, error: rpcSettingsError(error) };
				}
			}
			if (endpoint === "settingsMutate") {
				// The model-config page's save path: DSH pins settings.mutate to
				// loopback. Proxy only provider namespaces (llm-*); every other
				// namespace stays loopback-only (see README security boundary).
				if (typeof payload !== "object" || payload === null || Array.isArray(payload)
					|| typeof payload.ns !== "string" || !/^llm-[a-z0-9-]+$/i.test(payload.ns)
					|| !Array.isArray(payload.ops) || payload.ops.length === 0
					|| !payload.ops.every((op) => typeof op === "object" && op !== null && !Array.isArray(op)
						&& (op.op === "set" || op.op === "unset")
						&& Array.isArray(op.path) && op.path.every((part) => typeof part === "string"))) {
					return { ok: false, error: { code: "bad-request", message: "settingsMutate allows only llm-* namespaces with valid path ops", details: { issues: [] } } };
				}
				const settings = ctx.get?.("settings") ?? ctx.settings;
				if (typeof settings?.mutate !== "function") {
					return { ok: false, error: { code: "unavailable", message: "the DSH settings service is not available", details: { issues: [] } } };
				}
				try {
					await settings.mutate(payload.ns, payload.ops, payload.expectedRevision);
					const descriptor = settings.describe({ redactSecrets: true }).find((candidate) => candidate.ns === payload.ns);
					if (descriptor === undefined) throw new Error(`settings namespace "${payload.ns}" was disposed after the mutate`);
					return { ok: true, value: settingsNamespaceView(descriptor) };
				} catch (error) {
					return { ok: false, error: rpcSettingsError(error) };
				}
			}
			if (endpoint === "credentialsDescribe") {
				// Read-only: the models page shows configured/missing dots per key.
				// Values never cross this wire — only configured flags.
				if (typeof payload !== "object" || payload === null || Array.isArray(payload)
					|| !Array.isArray(payload.refs)
					|| !payload.refs.every((ref) => typeof ref === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(ref))) {
					return { ok: false, error: { code: "bad-request", message: "credentialsDescribe requires an array of credential refs", details: { issues: [] } } };
				}
				const credentials = ctx.get?.("credentials") ?? ctx.credentials;
				if (typeof credentials?.describe !== "function") {
					return { ok: false, error: { code: "unavailable", message: "the DSH credentials service is not available", details: { issues: [] } } };
				}
				try {
					const entries = await Promise.all(payload.refs.map(async (ref) => {
						const info = await credentials.describe(ref);
						return [ref, {
							configured: info.configured,
							...(info.source === undefined ? {} : { source: info.source }),
							writable: info.writable,
						}];
					}));
					return { ok: true, value: { credentials: Object.fromEntries(entries) } };
				} catch (error) {
					return { ok: false, error: rpcCredentialsError(error) };
				}
			}
			if (endpoint === "credentialsSet" || endpoint === "credentialsUnset") {
				// The model-config page stores the API key value through
				// credentials.set / credentials.unset, both loopback-only in DSH.
				// Only env-var-shaped refs are accepted; the value itself is the
				// user's own key typed on the authenticated tailnet page.
				const setting = endpoint === "credentialsSet";
				if (typeof payload !== "object" || payload === null || Array.isArray(payload)
					|| typeof payload.ref !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(payload.ref)
					|| (setting && (typeof payload.value !== "string" || payload.value.length === 0))) {
					return { ok: false, error: { code: "bad-request", message: setting ? "credentialsSet requires a credential ref and a non-empty value" : "credentialsUnset requires a credential ref", details: { issues: [] } } };
				}
				const credentials = ctx.get?.("credentials") ?? ctx.credentials;
				if (typeof credentials?.[setting ? "set" : "unset"] !== "function") {
					return { ok: false, error: { code: "unavailable", message: "the DSH credentials service is not available", details: { issues: [] } } };
				}
				try {
					if (setting) await credentials.set(payload.ref, payload.value);
					else await credentials.unset(payload.ref);
					return { ok: true, value: {} };
				} catch (error) {
					return { ok: false, error: rpcCredentialsError(error) };
				}
			}
			if (endpoint === "settingsUpdateAgentPreset") {
				// Narrow write surface: only the agent-presets namespace may be
				// updated over this channel. Everything else in the settings plane
				// stays loopback-only (see README security boundary).
				if (typeof payload !== "object" || payload === null || Array.isArray(payload) || payload.ns !== "agent-presets" || typeof payload.patch !== "object" || payload.patch === null || Array.isArray(payload.patch)) {
					return { ok: false, error: { code: "bad-request", message: "only the agent-presets namespace may be updated over this channel", details: { issues: [] } } };
				}
				const settings = ctx.get?.("settings") ?? ctx.settings;
				if (typeof settings?.update !== "function") {
					return { ok: false, error: { code: "unavailable", message: "the DSH settings service is not available", details: { issues: [] } } };
				}
				try {
					await settings.update("agent-presets", payload.patch, payload.expectedRevision);
					const descriptor = settings.describe({ redactSecrets: true }).find((candidate) => candidate.ns === "agent-presets");
					if (descriptor === undefined) throw new Error("agent-presets namespace was disposed after the update");
					return { ok: true, value: settingsNamespaceView(descriptor) };
				} catch (error) {
					return { ok: false, error: rpcSettingsError(error) };
				}
			}
			return {
				ok: false,
				error: { code: "bad-request", message: "unknown dsh-remote endpoint", details: { issues: [] } },
			};
	};
	// dsh >= 0.1.5-rc registers the channel inside an effect fiber whose
	// webServer resolution requires an active inject scope on the owning
	// context, so register from one; plain contexts (tests, older dsh)
	// keep the direct path.
	const register = (ownerCtx) => {
		const connection = ownerCtx.connection ?? ownerCtx.get?.("connection");
		if (!connection?.rpc?.handle) return;
		return connection.rpc.handle("/dsh-remote", handler, { authority: "trusted-host" });
	};
	return typeof ctx.inject === "function" ? ctx.inject(["connection", "webServer"], register) : register(ctx);
}

const registerDriveRpc = registerDirectoryRpc;

// Static transport enhancement limits: per-response buffering cap and the
// response-cache budget (raw + gzipped copies live in the cache).
const STATIC_ENHANCER_MAX_BODY = 8 * 1024 * 1024;
const STATIC_ENHANCER_CACHE_BYTES = 48 * 1024 * 1024;
const STATIC_ENHANCER_STREAM_GUARD_MS = 400;
// Slow-to-build but bounded unary endpoints: buffering them a little longer
// keeps gzip on the wire (e.g. /api/session.list builds in ~0.7s and would
// otherwise ship ~190KB raw over the phone's radio).
const STATIC_ENHANCER_SLOW_UNARY = new Set(["/api/session.list"]);
const STATIC_ENHANCER_SLOW_UNARY_GUARD_MS = 5000;
const STATIC_ENHANCER_COMPRESSIBLE = /^(?:text\/(?:javascript|css|html|plain)|application\/(?:json|javascript|manifest\+json)|image\/svg\+xml)\b/;
const STATIC_ENHANCER_IMMUTABLE = /-[A-Za-z0-9_-]{6,}\.(?:js|mjs|css|svg|woff2?|png|jpe?g|webp|map)$/;

/**
 * Brotli (quality 5) beats gzip level 6 by a further ~15% on the same text and
 * every current browser advertises it. Only the cached static path pays the
 * compression cost — once per entry — and keeps a gzip copy for clients that
 * do not send `br`; unary /api responses stay on gzip because there they are
 * compressed per response, where br's 2-3x slower compression costs real time.
 */
function brotliSync(body) {
	return brotliCompressSync(body, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } });
}

/**
 * Asset URLs referenced by the served index.html, in document order,
 * de-duplicated. Only compressible kinds are collected — the enhancer caches
 * nothing else, so fetching more would be pure waste. Query strings (the
 * plugin bundles' `rev=`) are kept: the cache key includes the search.
 */
function collectAssetUrls(html) {
	const urls = [];
	const pattern = /(?:src|href)="((?:\/assets\/|\/plugins\/)[^"]+\.(?:js|mjs|css|svg)(?:\?[^"]*)?)"/gu;
	for (const match of String(html ?? "").matchAll(pattern)) urls.push(match[1]);
	return [...new Set(urls)];
}

/**
 * Wrap the webServer's request listener so `/assets` and `/plugins` GET
 * responses gain gzip compression, an ETag, and caching headers — the DSH
 * static paths ship neither, and over a DERP relay the phone re-downloaded
 * the full ~4.4MB boot payload on every page load. Successful responses are
 * buffered once, cached per URL (raw + gzipped), and answered from memory:
 * a repeat load costs one 304 handshake per non-immutable URL and zero
 * transfer for fingerprinted ones. Everything else — `/api`, streams, other
 * methods — passes through untouched.
 * @param ctx - plugin context carrying the webServer service.
 * @param deps - test seams: `server` overrides `ctx.webServer.server`.
 * @returns disposer restoring the original request listeners.
 */
function installStaticEnhancer(ctx, deps = {}) {
	const server = deps.server ?? ctx?.webServer?.server;
	if (!server || typeof server.listeners !== "function" || typeof server.removeAllListeners !== "function") return () => {};
	const originals = server.listeners("request").slice();
	if (originals.length === 0) return () => {};
	const cache = new Map();
	let cacheBytes = 0;

	function cacheControlFor(pathname, search) {
		if (STATIC_ENHANCER_IMMUTABLE.test(pathname) || (pathname.startsWith("/plugins/") && search.includes("rev="))) return "public, max-age=31536000, immutable";
		return "no-cache";
	}

	function store(key, entry) {
		const bytes = (entry) => entry.raw.length + (entry.gzip?.length ?? 0) + (entry.br?.length ?? 0);
		const previous = cache.get(key);
		if (previous) cacheBytes -= bytes(previous);
		cache.set(key, entry);
		cacheBytes += bytes(entry);
		while (cacheBytes > STATIC_ENHANCER_CACHE_BYTES && cache.size > 0) {
			const oldest = cache.keys().next().value;
			const evicted = cache.get(oldest);
			cacheBytes -= bytes(evicted);
			cache.delete(oldest);
		}
	}

	function lower(headers) {
		const out = {};
		for (const [key, value] of Object.entries(headers ?? {})) out[key.toLowerCase()] = value;
		return out;
	}

	function respond(res, req, entry) {
		const accept = String(req.headers["accept-encoding"] ?? "");
		const useBr = /\bbr\b/i.test(accept) && entry.br !== undefined;
		const useGzip = !useBr && /\bgzip\b/i.test(accept) && entry.gzip !== undefined;
		const body = useBr ? entry.br : useGzip ? entry.gzip : entry.raw;
		const headers = {
			"content-type": entry.type,
			"content-length": body.length,
			etag: entry.etag,
			"cache-control": entry.cacheControl,
			vary: "Accept-Encoding",
		};
		if (useBr) headers["content-encoding"] = "br";
		else if (useGzip) headers["content-encoding"] = "gzip";
		res.writeHead(200, headers);
		if (req.method === "HEAD") {
			res.end();
			return;
		}
		res.end(body);
	}

	function enhanced(req, res) {
		const method = req.method;
		if (method !== "GET" && method !== "HEAD" && method !== "POST") return forward(req, res);
		// Phone pages only, same boundary as the client half: a loopback Host
		// (the PC's own browser) keeps DSH's byte-exact stock responses.
		const host = String(req.headers.host ?? "");
		if (/^(127\.0\.0\.1|localhost|\[::1\])(:|$)/i.test(host)) return forward(req, res);
		let url;
		try {
			url = new URL(req.url ?? "/", "http://x");
		} catch {
			return forward(req, res);
		}
		const pathname = url.pathname;
		const isApi = method !== "HEAD" && (method === "GET" || method === "POST") && pathname.startsWith("/api/");
		const isStatic = (method === "GET" || method === "HEAD") && (pathname.startsWith("/assets/") || pathname.startsWith("/plugins/")) && pathname.endsWith("/events") === false && /\.[A-Za-z0-9]{2,8}$/.test(pathname);
		if (!isApi && !isStatic) return forward(req, res);
		if (isStatic) {
			const key = pathname + url.search;
			const entry = cache.get(key);
			if (entry) {
				cache.delete(key);
				cache.set(key, entry);
				const inm = req.headers["if-none-match"];
				if (typeof inm === "string" && inm === entry.etag) {
					res.writeHead(304, { etag: entry.etag, "cache-control": entry.cacheControl, vary: "Accept-Encoding" });
					res.end();
					return;
				}
				respond(res, req, entry);
				return;
			}
			return forward(req, res, { key, pathname, search: url.search });
		}
		return forward(req, res, { api: true, pathname, search: url.search });
	}

	function forward(req, res, capture) {
		const state = { status: 200, headers: {}, headWritten: false, settled: false, live: false, chunks: [], watchdog: undefined };
		const shim = Object.create(res);
		shim.writeHead = (s, h) => {
			state.status = s;
			state.headers = lower(h);
			state.headWritten = true;
			// A stream (chat events, anything not unary JSON) must never be
			// buffered: switch to live forwarding the moment the content type
			// says so, replaying what was captured so far. Not while already
			// live — the watchdog replay already committed the head.
			if (capture !== undefined && capture.api && !state.live && !STATIC_ENHANCER_COMPRESSIBLE.test(String(state.headers["content-type"] ?? ""))) {
				state.live = true;
				if (state.watchdog !== undefined) clearTimeout(state.watchdog);
				replayCaptured(res, state);
			}
		};
		shim.setHeader = (k, v) => { state.headers[String(k).toLowerCase()] = v; };
		shim.getHeader = (k) => state.headers[String(k).toLowerCase()];
		shim.removeHeader = (k) => { delete state.headers[String(k).toLowerCase()]; };
		Object.defineProperty(shim, "headersSent", { get: () => state.headWritten });
		Object.defineProperty(shim, "statusCode", {
			get: () => state.status,
			set: (v) => { state.status = v; },
		});
		shim.flushHeaders = () => {};
		shim.cork = () => {};
		shim.uncork = () => {};
		if (capture === undefined) {
			for (const listener of originals) listener.call(server, req, res);
			return;
		}
		shim.write = (chunk) => {
			if (chunk == null) return true;
			if (state.live) return res.write(chunk);
			state.chunks.push(Buffer.from(chunk));
			return true;
		};
		shim.end = (chunk) => {
			if (state.settled) return;
			state.settled = true;
			if (state.watchdog !== undefined) clearTimeout(state.watchdog);
			if (chunk != null && state.live) {
				res.end(chunk);
				return;
			}
			if (chunk != null) state.chunks.push(Buffer.from(chunk));
			else if (state.live) res.end();
			if (!state.live) finish(req, res, capture, state);
		};
		try {
			for (const listener of originals) listener.call(server, req, shim);
		} catch (error) {
			if (state.settled) return;
			state.settled = true;
			if (state.watchdog !== undefined) clearTimeout(state.watchdog);
			ctx?.logger?.warn?.(error instanceof Error ? error : new Error(String(error)));
			res.writeHead(500);
			res.end();
		}
		if (capture.api) {
			// A handler that keeps writing past this guard is streaming, not
			// unary: flush everything captured and forward live from here on.
			const guardMs = STATIC_ENHANCER_SLOW_UNARY.has(capture.pathname) ? STATIC_ENHANCER_SLOW_UNARY_GUARD_MS : STATIC_ENHANCER_STREAM_GUARD_MS;
			state.watchdog = setTimeout(() => {
				if (state.settled || state.live) return;
				state.live = true;
				replayCaptured(res, state);
			}, guardMs);
		}
	}

	function replayCaptured(res, state) {
		res.writeHead(state.status, state.headWritten ? state.headers : undefined);
		for (const chunk of state.chunks) res.write(chunk);
	}

	function finish(req, res, where, state) {
		const body = Buffer.concat(state.chunks);
		if (where.api) {
			if (res.destroyed) return;
			// only successful unary responses are enhanced; errors and redirects
			// replay exactly as the gateway wrote them
			if (state.status < 200 || state.status > 299) return replay(res, state, body);
			const etag = `W/"${createHash("sha1").update(body).digest("base64url").slice(0, 24)}-${body.length}"`;
			if (typeof req.headers["if-none-match"] === "string" && req.headers["if-none-match"] === etag) {
				res.writeHead(304, { etag, vary: "Accept-Encoding" });
				res.end();
				return;
			}
			const useGzip = body.length >= 1024 && /\bgzip\b/i.test(String(req.headers["accept-encoding"] ?? ""));
			const out = useGzip ? gzipSync(body, { level: 6 }) : body;
			const headers = { ...state.headers };
			delete headers["content-length"];
			delete headers["transfer-encoding"];
			headers["content-length"] = out.length;
			headers.etag = etag;
			headers.vary = "Accept-Encoding";
			if (useGzip) headers["content-encoding"] = "gzip";
			res.writeHead(state.status, headers);
			if (req.method === "HEAD") {
				res.end();
				return;
			}
			res.end(out);
			return;
		}
		const type = String(state.headers["content-type"] ?? "");
		const cacheable = state.status === 200 && body.length > 0 && body.length <= STATIC_ENHANCER_MAX_BODY && STATIC_ENHANCER_COMPRESSIBLE.test(type);
		if (!cacheable) return replay(res, state, body);
		const etag = `W/"${createHash("sha1").update(body).digest("base64url").slice(0, 24)}-${body.length}"`;
		const entry = {
			etag,
			type,
			cacheControl: cacheControlFor(where.pathname, where.search),
			raw: body,
			gzip: body.length >= 1024 ? gzipSync(body, { level: 6 }) : undefined,
			br: body.length >= 1024 ? brotliSync(body) : undefined,
		};
		store(where.key, entry);
		if (res.destroyed) return;
		respond(res, req, entry);
	}

	function replay(res, state, body) {
		if (res.destroyed) return;
		res.writeHead(state.status, state.headWritten ? state.headers : undefined);
		res.end(body.length > 0 ? body : undefined);
	}

	/**
	 * Pre-populate the response cache so the phone's first load after a DSH
	 * restart never pays on-demand compression of a large asset. DSH's own
	 * dist is read over HTTP with a non-loopback Host header — the same gate
	 * the enhancer itself uses — so the responses flow through the normal
	 * capture path and land in the cache under the very URLs real phone
	 * requests will use. Best-effort by design: any failure just means the
	 * first real request compresses on demand, exactly as before this existed.
	 */
	const PREWARM_TIMEOUT_MS = 10_000;
	const PREWARM_CONCURRENCY = 3;
	const PREWARM_MAX_URLS = 64;
	const PREWARM_HOST = "dsh-remote.prewarm.invalid";
	let prewarmTimer = null;
	function prewarmGet(webPort, pathname) {
		return new Promise((resolve) => {
			const request = http.get({ host: "127.0.0.1", port: webPort, path: pathname, headers: { host: PREWARM_HOST } }, (response) => {
				response.resume();
				response.on("end", resolve);
				response.on("error", resolve);
			});
			request.on("error", resolve);
			request.setTimeout(PREWARM_TIMEOUT_MS, () => request.destroy());
		});
	}
	async function prewarm() {
		const webPort = deps.prewarmPort ?? ctx?.webServer?.port;
		if (!webPort) return;
		try {
			const html = await new Promise((resolve) => {
				let body = "";
				const request = http.get({ host: "127.0.0.1", port: webPort, path: "/", headers: { host: PREWARM_HOST } }, (response) => {
					response.setEncoding("utf8");
					response.on("data", (chunk) => { body += chunk; });
					response.on("end", () => resolve(body));
					response.on("error", () => resolve(body));
				});
				request.on("error", () => resolve(""));
				request.setTimeout(PREWARM_TIMEOUT_MS, () => request.destroy());
			});
			const urls = collectAssetUrls(html).slice(0, PREWARM_MAX_URLS);
			let index = 0;
			await Promise.all(Array.from({ length: Math.min(PREWARM_CONCURRENCY, urls.length) }, async () => {
				while (index < urls.length) await prewarmGet(webPort, urls[index++]);
			}));
		} catch { /* best-effort: on-demand compression remains the fallback */ }
	}
	if (deps.prewarm === true) {
		prewarmTimer = setTimeout(() => { prewarm().catch(() => {}); }, deps.prewarmDelayMs ?? 2_000);
		prewarmTimer.unref?.();
	}

	const dispose = () => {
		if (prewarmTimer !== null) clearTimeout(prewarmTimer);
		server.removeAllListeners("request");
		for (const listener of originals) server.on("request", listener);
		cache.clear();
	};
	server.removeAllListeners("request");
	server.on("request", enhanced);
	return dispose;
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
 * The fence lives in `dsh-client-connection`, whose bundle-patch config
 * expression `trustedHosts: !!js ctx.webRuntime.trustedHosts` reads the
 * `webRuntime` service array. But Cordis resolves that expression through a
 * Zod schema (`z.array(String).default([])`), and Zod validation returns a
 * **copy** of the array — so pushing to `webRuntime.trustedHosts` alone is
 * invisible to the fence. The `HostConnectionService` (registered as the
 * `"connection"` service) stores the validated copy in `this.trustedHosts`
 * and reads it on every `/api` and WebSocket request. This plugin injects
 * `"connection"`, so it can push to that live array directly.
 *
 * Both arrays are updated: `webRuntime.trustedHosts` for any later reader of
 * the service, and `connection.trustedHosts` for the fence that is already
 * applied. No `--trusted-host` flag is required, and the change is re-applied
 * on every startup.
 *
 * @param ctx - plugin context carrying the `webRuntime` and `connection`
 * services (injected; also probed via ctx.get for safety in unusual
 * compositions).
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
	const connection = ctx.connection ?? ctx.get?.("connection");
	let added = false;
	// The connection service holds the array the /api fence actually reads.
	// Zod validation copies the config expression's array, so this is the
	// only array whose mutation is visible to the already-applied fence.
	if (connection && Array.isArray(connection.trustedHosts) && !connection.trustedHosts.includes(host)) {
		connection.trustedHosts.push(host);
		added = true;
	}
	// Keep the webRuntime array in sync for any later reader of the service.
	if (runtime && Array.isArray(runtime.trustedHosts) && !runtime.trustedHosts.includes(host)) {
		runtime.trustedHosts.push(host);
		added = true;
	}
	if (added) log(ctx, `added ${host} to the DSH /api trust fence`);
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
	const enabled = config.enabled !== false;
	if (!enabled) {
		// No phone surface at all: not even the /dsh-remote channel exists,
		// so enabled:false leaves the running DSH byte-for-byte stock.
		logNote(ctx, "disabled by config (enabled:false); DSH stays on loopback only");
		return;
	}
	registerDirectoryRpc(ctx, deps);
	// Transport-level, phone-relevant but behavior-neutral on the PC: the same
	// bytes leave the server, compressed and with honest validators attached.
	// Prewarm is a production default but stays opt-in for direct callers so
	// unit tests against a fake server never open real sockets.
	installStaticEnhancer(ctx, { ...deps, prewarm: deps.prewarm ?? true });

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

	ctx.effect(() => dispose, "dsh-remote.cleanup");
	attempt(false);
	return { attempt, dispose, state };
}

function apply(ctx, config = {}) {
	return applyWithDeps(ctx, config);
}

function note(ctx, message) {
	// URL/info lines belong to the shell, like the built-in web-runtime does.
	process.stderr.write(`dsh-remote: ${message}\n`);
	ctx.logger?.info?.(message);
}

function warn(ctx, message) {
	process.stderr.write(`dsh-remote: warning: ${message}\n`);
	ctx.logger?.warn?.(message);
}

export {
	apply,
	applyWithDeps,
	buildServeArgs,
	canonicalServeConfig,
	collectAssetUrls,
	createHostDirectory,
	createServeConfigStore,
	explorerEntryCompare,
	fullyQualifiedDirectoryPath,
	inject,
	installStaticEnhancer,
	listHostDirectory,
	listHostRoots,
	listWindowsDrives,
	name,
	permissionDenied,
	registerDriveRpc,
	registerDirectoryRpc,
	proxyTargetForBind,
	resolveConfiguredUrl,
	resolveServeUrl,
	runTailscaleLocalApi,
	selectTailscaleCandidate,
	servePublicPort,
	tailscaleAvailable,
};
