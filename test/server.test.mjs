import assert from "node:assert/strict";
import test from "node:test";

import {
	explorerEntryCompare,
	applyWithDeps,
	buildServeArgs,
	canonicalServeConfig,
	createHostDirectory,
	fullyQualifiedDirectoryPath,
	installStaticEnhancer,
	listHostDirectory,
	listWindowsDrives,
	permissionDenied,
	proxyTargetForBind,
	registerDirectoryRpc,
	resolveConfiguredUrl,
	resolveServeUrl,
	selectTailscaleCandidate,
	servePublicPort,
	tailscaleAvailable,
} from "../lib/index.js";

const ok = (stdout = "") => ({ status: 0, stdout, stderr: "", error: null });
const failed = (stderr = "failed") => ({ status: 1, stdout: "", stderr, error: null });

function makeContext(overrides = {}) {
	let disposer = null;
	const ctx = {
		webServer: { port: 3080, host: "127.0.0.1" },
		webRuntime: { trustedHosts: [] },
		connection: { trustedHosts: [], rpc: { handle: () => "drive-rpc-disposer" } },
		effect(factory) { disposer = factory(); },
		...overrides,
	};
	return { ctx, getDisposer: () => disposer };
}

function makeLogs() {
	const notes = [];
	const warnings = [];
	return {
		notes,
		warnings,
		deps: {
			note: (_ctx, message) => notes.push(message),
			warn: (_ctx, message) => warnings.push(message),
		},
	};
}

function routeConfig(host = "host.tailnet.ts.net", port = 443, target = "http://127.0.0.1:3080", https = true) {
	return {
		TCP: { [String(port)]: https ? { HTTPS: true } : { HTTP: true } },
		Web: { [`${host}:${String(port)}`]: { Handlers: { "/": { Proxy: target } } } },
	};
}

function makeStore({ before = {}, managed, current, currentEtag = "managed-etag", onPost } = {}) {
	const captures = [];
	const posts = [];
	let cleaned = false;
	let currentConfig = structuredClone(current ?? managed ?? before);
	let currentTag = currentEtag;
	const snapshots = { before, managed: managed ?? before };
	return {
		store: {
			capture(label) {
				captures.push(label);
				const config = label === "cleanup-current" ? currentConfig : snapshots[label] ?? snapshots.managed;
				if (config === undefined) return { ok: false, result: failed("missing snapshot") };
				return {
					ok: true,
					result: ok(),
					snapshot: {
						label,
						config: structuredClone(config),
						etag: label === "cleanup-current" ? currentTag : `${label}-etag`,
						canonical: canonicalServeConfig(config),
					},
				};
			},
			compareAndSet(config, etag) {
				posts.push({ config: structuredClone(config), etag });
				if (onPost) return onPost(config, etag);
				currentConfig = structuredClone(config);
				currentTag = "after-post";
				return { ok: true, status: 200 };
			},
			cleanup() { cleaned = true; },
		},
		captures,
		posts,
		setCurrent(config, etag = currentTag) {
			currentConfig = structuredClone(config);
			currentTag = etag;
		},
		wasCleaned: () => cleaned,
	};
}

function commonDeps(logs, storeFactory, run, selfInfo, extra = {}) {
	return {
		...logs.deps,
		runTailscale: run,
		selfInfo,
		createServeConfigStore: storeFactory,
		retryDelays: [],
		...extra,
	};
}

test("drive enumeration is empty outside Windows without probing the filesystem", async () => {
	let statCalls = 0;
	const drives = await listWindowsDrives({
		platform: "linux",
		stat: () => {
			statCalls += 1;
			throw new Error("must not probe drives");
		},
	});
	assert.deepEqual(drives, []);
	assert.equal(statCalls, 0);
});

test("Windows drive enumeration returns only ready directory roots", async () => {
	const ready = new Set(["B:\\", "D:\\"]);
	const probed = [];
	const drives = await listWindowsDrives({
		platform: "win32",
		stat: (root) => {
			probed.push(root);
			if (ready.has(root)) return { isDirectory: () => true };
			if (root === "C:\\") return { isDirectory: () => false };
			throw Object.assign(new Error("drive unavailable"), { code: "ENOENT" });
		},
	});
	assert.deepEqual(drives, ["B:\\", "D:\\"]);
	assert.equal(probed.length, 26);
	assert.equal(probed[0], "A:\\");
	assert.equal(probed.at(-1), "Z:\\");
});

test("a drive probe that misses its deadline is dropped, and its late failure stays handled", async () => {
	const started = Date.now();
	const drives = await listWindowsDrives({
		platform: "win32",
		probeTimeoutMs: 15,
		stat: (root) => {
			if (root === "C:\\") {
				// Loses the race, then rejects late: the race already attached a
				// handler, so this must surface as an unhandled rejection — which
				// fails the suite — rather than pass silently.
				return new Promise((_, reject) => {
					setTimeout(() => reject(new Error("late probe failure")), 60);
				});
			}
			return Promise.reject(Object.assign(new Error("drive unavailable"), { code: "ENOENT" }));
		},
	});
	assert.deepEqual(drives, []);
	assert.ok(Date.now() - started < 1_000);
	await new Promise((resolve) => setTimeout(resolve, 100));
});

test("directory path validation rejects drive-relative Windows paths", () => {
	assert.equal(fullyQualifiedDirectoryPath("D:\\work", "win32"), true);
	assert.equal(fullyQualifiedDirectoryPath("\\\\server\\share\\work", "win32"), true);
	assert.equal(fullyQualifiedDirectoryPath("D:work", "win32"), false);
	assert.equal(fullyQualifiedDirectoryPath("\\work", "win32"), false);
	assert.equal(fullyQualifiedDirectoryPath("/work", "linux"), true);
});

test("private directory listing returns sorted folders, crumbs and bounded rows", async () => {
	const closed = [];
	const dirents = [
		{ name: "zeta", isDirectory: () => true, isSymbolicLink: () => false },
		{ name: "file.txt", isDirectory: () => false, isSymbolicLink: () => false },
		{ name: ".hidden", isDirectory: () => true, isSymbolicLink: () => false },
		{ name: "link", isDirectory: () => false, isSymbolicLink: () => true },
	];
	let readIndex = 0;
	const listing = await listHostDirectory("D:\\projects", {
		platform: "win32",
		home: "C:\\Users\\u",
		maxEntries: 2,
		opendir: async (target) => ({
			async read() { return dirents[readIndex++] ?? null; },
			async close() { closed.push(target); },
		}),
		stat: async () => ({ isDirectory: () => true }),
	});
	assert.equal(listing.path, "D:\\projects");
	assert.equal(listing.home, "C:\\Users\\u");
	assert.deepEqual(listing.crumbs.map((entry) => entry.path), ["D:\\", "D:\\projects"]);
	assert.deepEqual(listing.entries.map((entry) => [entry.name, entry.hidden]), [[".hidden", true], ["link", false]]);
	assert.equal(listing.truncated, true);
	assert.deepEqual(closed, ["D:\\projects"]);
});

test("an aborted directory open closes a handle that resolves late", async () => {
	let resolveOpen;
	const closed = [];
	const controller = new AbortController();
	const directory = {
		async read() { return null; },
		async close() { closed.push(true); },
	};
	const listing = listHostDirectory("D:\\projects", {
		platform: "win32",
		home: "C:\\Users\\u",
		opendir: () => new Promise((resolve) => { resolveOpen = resolve; }),
		signal: controller.signal,
	});
	controller.abort();
	await assert.rejects(listing);
	resolveOpen(directory);
	await Promise.resolve();
	await Promise.resolve();
	assert.deepEqual(closed, [true]);
});

test("an aborted directory read returns promptly and starts closing its handle", async () => {
	let resolveRead;
	let closeCalls = 0;
	const controller = new AbortController();
	const listing = listHostDirectory("D:\\projects", {
		platform: "win32",
		home: "C:\\Users\\u",
		opendir: async () => ({
			read: () => new Promise((resolve) => { resolveRead = resolve; }),
			async close() { closeCalls += 1; },
		}),
		signal: controller.signal,
	});
	await Promise.resolve();
	await Promise.resolve();
	controller.abort();
	await assert.rejects(listing);
	assert.equal(closeCalls, 1);
	resolveRead(null);
});

test("private directory creation accepts one child segment and reports conflicts", async () => {
	const created = [];
	assert.equal(await createHostDirectory("D:\\projects", "new", {
		platform: "win32",
		mkdir: async (target) => { created.push(target); },
	}), "D:\\projects\\new");
	assert.deepEqual(created, ["D:\\projects\\new"]);
	await assert.rejects(
		() => createHostDirectory("D:\\projects", "..", { platform: "win32", mkdir: async () => {} }),
		(error) => error.directoryCode === "directory-create-failed",
	);
	await assert.rejects(
		() => createHostDirectory("D:\\projects", "exists", {
			platform: "win32",
			mkdir: async () => { throw Object.assign(new Error("exists"), { code: "EEXIST" }); },
		}),
		(error) => error.directoryCode === "directory-exists" && error.directoryPath === "D:\\projects\\exists",
	);
});

test("directory RPC is trusted-host only and serves drives, listing and creation", async () => {
	let registration = null;
	const ctx = {
		connection: {
			rpc: {
				handle(channel, handler, options) {
					registration = { channel, handler, options };
					return "drive-rpc-disposer";
				},
			},
		},
	};
	const calls = [];
	const result = registerDirectoryRpc(ctx, {
		listWindowsDrives: () => ["C:\\", "D:\\"],
		listHostDirectory: async (path, options) => {
			calls.push(["list", path, options.signal]);
			return { path: path ?? "C:\\Users\\u", home: "C:\\Users\\u", crumbs: [], entries: [], truncated: false };
		},
		createHostDirectory: async (path, name, options) => {
			calls.push(["create", path, name, options.signal]);
			return `${path}${name}`;
		},
	});
	assert.equal(result, "drive-rpc-disposer");
	assert.equal(registration.channel, "/tailscale-serve");
	assert.deepEqual(registration.options, { authority: "trusted-host" });
	assert.deepEqual(await registration.handler("listDrives", {}), {
		ok: true,
		value: { drives: ["C:\\", "D:\\"] },
	});
	const signal = new AbortController().signal;
	assert.deepEqual(await registration.handler("listDirectory", { path: "D:\\" }, signal), {
		ok: true,
		value: { path: "D:\\", home: "C:\\Users\\u", crumbs: [], entries: [], truncated: false },
	});
	assert.deepEqual(await registration.handler("createDirectory", { path: "D:\\", name: "work" }, signal), {
		ok: true,
		value: { path: "D:\\work" },
	});
	assert.deepEqual(calls, [["list", "D:\\", signal], ["create", "D:\\", "work", signal]]);
});

test("directory RPC rejects malformed and unknown endpoints without filesystem work", async () => {
	let handler = null;
	let enumerateCalls = 0;
	let listCalls = 0;
	registerDirectoryRpc({
		connection: {
			rpc: {
				handle(_channel, registeredHandler) {
					handler = registeredHandler;
				},
			},
		},
	}, {
		listWindowsDrives: () => {
			enumerateCalls += 1;
			return ["C:\\"];
		},
		listHostDirectory: async () => { listCalls += 1; },
	});
	assert.deepEqual(await handler("listDirectory", { path: 7 }), {
		ok: false,
		error: {
			code: "bad-request",
			message: "listDirectory requires an optional string path",
			details: { issues: [] },
		},
	});
	assert.deepEqual(await handler("not-listDrives", {}), {
		ok: false,
		error: {
			code: "bad-request",
			message: "unknown tailscale-serve endpoint",
			details: { issues: [] },
		},
	});
	assert.equal(enumerateCalls, 0);
	assert.equal(listCalls, 0);
});

test("a DNS identity cannot turn a failed Serve command into success", () => {
	const { ctx } = makeContext();
	const logs = makeLogs();
	const fake = makeStore({ before: {}, managed: {} });
	const commands = [];
	const run = (args) => {
		commands.push(args);
		if (args[0] === "version") return ok("1.102.2");
		if (args[0] === "serve") return failed("serve syntax rejected");
		throw new Error(`unexpected command: ${args.join(" ")}`);
	};
	const controller = applyWithDeps(ctx, { keepOnExit: true }, commonDeps(
		logs, () => fake.store, run, () => ({ DNSName: "windows.example.ts.net." }),
	));
	assert.equal(controller.state.identityKnown, true);
	assert.equal(controller.state.serveConfigured, false);
	assert.equal(controller.state.settled, false);
	assert.deepEqual(ctx.webRuntime.trustedHosts, ["windows.example.ts.net"]);
	assert.deepEqual(ctx.connection.trustedHosts, ["windows.example.ts.net"]);
	assert.equal(logs.notes.some((line) => line.includes("now reachable")), false);
	assert.equal(logs.warnings.some((line) => line.includes("could not configure Tailscale Serve")), true);
	assert.equal(commands.filter((args) => args[0] === "serve").length, 1);
});

test("Serve success is accepted only after the matching node-level route is verified", () => {
	const { ctx } = makeContext();
	const logs = makeLogs();
	const managed = routeConfig();
	const fake = makeStore({ before: {}, managed });
	const controller = applyWithDeps(ctx, {}, commonDeps(
		logs, () => fake.store, (args) => args[0] === "version" ? ok("1.102.2") : ok(),
		() => ({ DNSName: "host.tailnet.ts.net." }),
	));
	assert.equal(controller.state.serveConfigured, true);
	assert.equal(controller.state.routeVerified, true);
	assert.equal(controller.state.settled, true);
	assert.equal(controller.state.endpointUrl, "https://host.tailnet.ts.net");
	assert.deepEqual(ctx.connection.trustedHosts, ["host.tailnet.ts.net"]);
	assert.equal(logs.notes.some((line) => line.includes("DSH web is now reachable")), true);
	assert.equal(logs.warnings.length, 0);
});

test("a denied identity lookup does not hide the LocalAPI permission diagnosis", () => {
	const { ctx } = makeContext();
	const logs = makeLogs();
	const deniedStore = {
		capture: () => ({ ok: false, result: { status: 403, body: "serve config denied" } }),
		compareAndSet: () => ({ ok: true, status: 200 }),
		cleanup() {},
	};
	const controller = applyWithDeps(ctx, {}, commonDeps(
		logs,
		() => deniedStore,
		(args) => args[0] === "version" ? ok("1.102.2") : ok(),
		() => null,
	));
	assert.equal(controller.state.settled, false);
	assert.equal(logs.warnings.some((line) => line.includes("reading the existing node-level Serve configuration")), true);
	assert.equal(logs.warnings.some((line) => line.includes("Administrator")), true);
});

test("when identity JSON is unavailable, the verified route supplies the endpoint URL", () => {
	const { ctx } = makeContext();
	const logs = makeLogs();
	const fake = makeStore({ before: {}, managed: routeConfig("derived.tailnet.ts.net") });
	const controller = applyWithDeps(ctx, {}, commonDeps(
		logs,
		() => fake.store,
		(args) => args[0] === "version" ? ok("1.102.2") : ok(),
		() => null,
	));
	assert.equal(controller.state.identityKnown, true);
	assert.equal(controller.state.endpointUrl, "https://derived.tailnet.ts.net");
	assert.equal(controller.state.settled, true);
	assert.deepEqual(ctx.webRuntime.trustedHosts, ["derived.tailnet.ts.net"]);
});

test("a verified route without a usable host is not announced as null", () => {
	const { ctx } = makeContext();
	const logs = makeLogs();
	const fake = makeStore({ before: {}, managed: routeConfig("", 443) });
	const controller = applyWithDeps(ctx, {}, commonDeps(
		logs,
		() => fake.store,
		(args) => args[0] === "version" ? ok("1.102.2") : ok(),
		() => null,
	));
	assert.equal(controller.state.routeVerified, true);
	assert.equal(controller.state.settled, false);
	assert.equal(logs.notes.some((line) => line.includes("now reachable")), false);
	assert.equal(logs.warnings.some((line) => line.includes("public hostname could not be derived")), true);
});

test("a configured hostname cannot substitute for an unverifiable route host", () => {
	const { ctx } = makeContext();
	const logs = makeLogs();
	const fake = makeStore({ before: {}, managed: routeConfig("", 443) });
	const controller = applyWithDeps(ctx, { hostname: "hint.tailnet.ts.net" }, commonDeps(
		logs,
		() => fake.store,
		(args) => args[0] === "version" ? ok("1.102.2") : ok(),
		() => null,
	));
	assert.equal(controller.state.routeVerified, true);
	assert.equal(controller.state.settled, false);
	assert.equal(controller.state.endpointUrl, null);
	assert.equal(logs.notes.some((line) => line.includes("now reachable")), false);
	assert.equal(logs.warnings.some((line) => line.includes("public hostname could not be derived")), true);
});

test("a successful command with no matching route is not a success", () => {
	const { ctx } = makeContext();
	const logs = makeLogs();
	const fake = makeStore({ before: {}, managed: {} });
	const controller = applyWithDeps(ctx, {}, commonDeps(
		logs, () => fake.store, (args) => args[0] === "version" ? ok("1.102.2") : ok(),
		() => ({ DNSName: "host.tailnet.ts.net." }),
	));
	assert.equal(controller.state.serveConfigured, true);
	assert.equal(controller.state.routeVerified, false);
	assert.equal(controller.state.settled, false);
	assert.equal(logs.notes.some((line) => line.includes("now reachable")), false);
	assert.equal(logs.warnings.some((line) => line.includes("no matching DSH proxy route")), true);
});

test("default Serve arguments explicitly select HTTPS or HTTP and the actual target", () => {
	assert.deepEqual(buildServeArgs({}, "http://127.0.0.1:3080"), [
		"serve", "--bg", "--yes", "--https=443", "http://127.0.0.1:3080",
	]);
	assert.deepEqual(buildServeArgs({ https: false }, "http://127.0.0.1:3080"), [
		"serve", "--bg", "--yes", "--http=80", "http://127.0.0.1:3080",
	]);
	assert.equal(servePublicPort({ serveArgs: ["serve", "--bg", "--https=8443", "http://127.0.0.1:3080"] }, true), 8443);
	assert.equal(servePublicPort({ serveArgs: ["serve", "--bg", "--https", "8443", "http://127.0.0.1:3080"] }, true), 8443);
	assert.throws(
		() => servePublicPort({ serveArgs: ["serve", "--bg", "http://127.0.0.1:3080"] }, false),
		/explicitly include exactly one --http/,
	);
	assert.throws(
		() => buildServeArgs({ serveArgs: ["serve", "--help", "http://127.0.0.1:3080"] }, "http://127.0.0.1:3080"),
		/configure a proxy/,
	);
	assert.throws(
		() => buildServeArgs(
			{ serveArgs: ["serve", "--bg", "--https=443", "--service=svc:dsh", "http://127.0.0.1:3080"] },
			"http://127.0.0.1:3080",
		),
		/node-level root HTTP\(S\) proxy/,
	);
});

test("non-loopback binds use a full proxy target and are verified", () => {
	const { ctx } = makeContext({ webServer: { port: 3080, host: "192.0.2.25" } });
	const logs = makeLogs();
	const target = "http://192.0.2.25:3080";
	const fake = makeStore({ before: {}, managed: routeConfig("host.tailnet.ts.net", 443, target, true) });
	let serveArgs = null;
	applyWithDeps(ctx, { hostname: "host.tailnet.ts.net" }, commonDeps(
		logs,
		() => fake.store,
		(args) => {
			if (args[0] === "version") return ok("1.102.2");
			serveArgs = args;
			return ok();
		},
		() => null,
	));
	assert.deepEqual(serveArgs, ["serve", "--bg", "--yes", "--https=443", target]);
});

test("IPv6 listener targets are rejected instead of producing a false endpoint", () => {
	assert.throws(() => proxyTargetForBind("fd00::25", 3080), /IPv6 address/);
	assert.equal(proxyTargetForBind("::1", 3080), "http://localhost:3080");
});

test("permission errors explain the Windows prerequisite and make no Serve change", () => {
	const { ctx } = makeContext();
	const logs = makeLogs();
	let serveCalls = 0;
	const deniedStore = {
		capture: () => ({ ok: false, result: { status: 403, body: "Access is denied." } }),
		compareAndSet: () => ({ ok: true, status: 200 }),
		cleanup() {},
	};
	const controller = applyWithDeps(ctx, { hostname: "host.tailnet.ts.net" }, commonDeps(
		logs,
		() => deniedStore,
		(args) => {
			if (args[0] === "version") return ok("1.102.2");
			serveCalls += 1;
			return ok();
		},
		() => ({ DNSName: "host.tailnet.ts.net." }),
	));
	assert.equal(serveCalls, 0);
	assert.equal(controller.state.serveConfigured, false);
	assert.equal(logs.notes.some((line) => line.includes("now reachable")), false);
	assert.equal(logs.warnings.some((line) => line.includes("Administrator")), true);
	assert.equal(logs.warnings.some((line) => line.includes("DNS name")), true);
});

test("a Tailscale timeout is diagnosed later, not misreported as a missing CLI", () => {
	const { ctx } = makeContext();
	const logs = makeLogs();
	const timedOut = { status: null, stdout: "", stderr: "", error: { code: "ETIMEDOUT", message: "timed out" } };
	const controller = applyWithDeps(ctx, {}, commonDeps(
		logs,
		() => makeStore({ before: {}, managed: {} }).store,
		() => timedOut,
		() => null,
	));
	assert.equal(controller.state.settled, false);
	assert.equal(logs.warnings.some((line) => line.includes("CLI not found")), false);
	assert.equal(logs.warnings.some((line) => line.includes("could not configure Tailscale Serve")), true);
});

test("only ENOENT is treated as a missing Tailscale CLI", () => {
	assert.equal(tailscaleAvailable(() => ({ status: null, error: { code: "ENOENT" } })), false);
	assert.equal(tailscaleAvailable(() => ({ status: 1, stdout: "", stderr: "broken", error: null })), true);
	assert.equal(tailscaleAvailable(() => ({ status: null, error: { code: "EACCES" } })), true);
});

test("CLI discovery keeps an existing absolute path when its probe times out or is denied", () => {
	const absolute = "C:\\Program Files\\Tailscale\\tailscale.exe";
	for (const code of ["ETIMEDOUT", "EACCES", "EPERM"]) {
		const probed = [];
		const selected = selectTailscaleCandidate(["tailscale", absolute], {
			exists: (candidate) => candidate === absolute,
			spawn: (candidate) => {
				probed.push(candidate);
				return candidate === "tailscale"
					? { status: null, error: { code: "ENOENT" } }
					: { status: null, error: { code } };
			},
		});
		assert.equal(selected, absolute);
		assert.deepEqual(probed, ["tailscale", absolute]);
	}
});

test("CLI discovery prefers a later healthy absolute path over a broken PATH shim", () => {
	const absolute = "C:\\Program Files\\Tailscale\\tailscale.exe";
	const probed = [];
	const selected = selectTailscaleCandidate(["tailscale", absolute], {
		exists: (candidate) => candidate === absolute,
		spawn: (candidate) => {
			probed.push(candidate);
			return candidate === "tailscale"
				? { status: 1, stdout: "", stderr: "shim failed", error: null }
				: { status: 0, stdout: "1.102.2", stderr: "", error: null };
		},
	});
	assert.equal(selected, absolute);
	assert.deepEqual(probed, ["tailscale", absolute]);
});

test("an incompatible existing root handler prevents Serve from overwriting it", () => {
	const { ctx } = makeContext();
	const logs = makeLogs();
	const existing = routeConfig("host.tailnet.ts.net", 443, "http://127.0.0.1:9999");
	const fake = makeStore({ before: existing, managed: existing });
	let serveCalls = 0;
	applyWithDeps(ctx, { hostname: "host.tailnet.ts.net" }, commonDeps(
		logs,
		() => fake.store,
		(args) => {
			if (args[0] === "version") return ok("1.102.2");
			serveCalls += 1;
			return ok();
		},
		() => null,
	));
	assert.equal(serveCalls, 0);
	assert.equal(logs.warnings.some((line) => line.includes("refusing to overwrite another application")), true);
});

test("a pre-existing identical route is not claimed or removed on dispose", async () => {
	const { ctx, getDisposer } = makeContext();
	const existing = routeConfig();
	const logs = makeLogs();
	const fake = makeStore({ before: existing, managed: existing });
	let serveCalls = 0;
	const controller = applyWithDeps(ctx, {}, commonDeps(
		logs,
		() => fake.store,
		(args) => {
			if (args[0] === "version") return ok("1.102.2");
			serveCalls += 1;
			return ok();
		},
		() => ({ DNSName: "host.tailnet.ts.net." }),
	));
	assert.equal(serveCalls, 0);
	assert.equal(controller.state.routeVerified, true);
	assert.equal(controller.state.settled, true);
	assert.deepEqual(fake.captures, ["before", "latest"]);
	await getDisposer()();
	assert.equal(fake.posts.length, 0);
});

test("multiple pre-existing identical routes are rejected as ambiguous", () => {
	const { ctx } = makeContext();
	const logs = makeLogs();
	const existing = routeConfig("first.tailnet.ts.net");
	existing.Web["second.tailnet.ts.net:443"] = {
		Handlers: { "/": { Proxy: "http://127.0.0.1:3080" } },
	};
	const fake = makeStore({ before: existing, managed: existing });
	let serveCalls = 0;
	const controller = applyWithDeps(ctx, {}, commonDeps(
		logs,
		() => fake.store,
		(args) => {
			if (args[0] === "version") return ok("1.102.2");
			serveCalls += 1;
			return ok();
		},
		() => null,
	));
	assert.equal(serveCalls, 0);
	assert.equal(controller.state.settled, false);
	assert.equal(logs.warnings.some((line) => line.includes("ownership is ambiguous")), true);
});

test("a stale configured hostname does not hide or orphan the actual route", async () => {
	const { ctx, getDisposer } = makeContext();
	const logs = makeLogs();
	const managed = routeConfig("actual.tailnet.ts.net");
	const fake = makeStore({ before: {}, managed });
	let serveCalls = 0;
	const controller = applyWithDeps(ctx, { hostname: "stale.tailnet.ts.net" }, commonDeps(
		logs,
		() => fake.store,
		(args) => {
			if (args[0] === "version") return ok("1.102.2");
			serveCalls += 1;
			return ok();
		},
		() => null,
	));
	assert.equal(serveCalls, 1);
	assert.equal(controller.state.routeVerified, true);
	assert.equal(controller.state.settled, true);
	assert.equal(controller.state.endpointUrl, "https://actual.tailnet.ts.net");
	assert.deepEqual(ctx.webRuntime.trustedHosts, ["stale.tailnet.ts.net", "actual.tailnet.ts.net"]);
	assert.deepEqual(ctx.connection.trustedHosts, ["stale.tailnet.ts.net", "actual.tailnet.ts.net"]);
	assert.equal(logs.warnings.some((line) => line.includes("using the actual route")), true);
	await getDisposer()();
	assert.equal(fake.posts.length, 1);
	assert.deepEqual(fake.posts[0].config, {});
});

test("a dormant Web handler is not activated when no listener exists", async () => {
	const { ctx } = makeContext();
	const logs = makeLogs();
	const before = {
		Web: { "host.tailnet.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3080" } } } },
	};
	const managed = routeConfig();
	const fake = makeStore({ before, managed });
	let serveCalls = 0;
	const controller = applyWithDeps(ctx, {}, commonDeps(
		logs,
		() => fake.store,
		(args) => {
			if (args[0] === "version") return ok("1.102.2");
			serveCalls += 1;
			return ok();
		},
		() => null,
	));
	assert.equal(serveCalls, 0);
	assert.equal(controller.state.routeVerified, false);
	assert.equal(controller.state.settled, false);
	assert.equal(fake.posts.length, 0);
});

test("a Funnel enabled while Serve is being configured triggers an ETag safety rollback", async () => {
	const { ctx, getDisposer } = makeContext();
	const logs = makeLogs();
	const managed = routeConfig();
	managed.AllowFunnel = { "host.tailnet.ts.net:443": true };
	const fake = makeStore({ before: {}, managed });
	const controller = applyWithDeps(ctx, {}, commonDeps(
		logs,
		() => fake.store,
		(args) => args[0] === "version" ? ok("1.102.2") : ok(),
		() => ({ DNSName: "host.tailnet.ts.net." }),
	));
	assert.equal(controller.state.routeVerified, false);
	assert.equal(controller.state.settled, false);
	assert.equal(logs.notes.some((line) => line.includes("now reachable")), false);
	assert.equal(logs.warnings.some((line) => line.includes("Funnel became enabled")), true);
	assert.equal(fake.posts.length, 1);
	assert.equal(fake.posts[0].etag, "latest-etag");
	assert.deepEqual(fake.posts[0].config, {
		TCP: { "443": { HTTPS: true } },
		AllowFunnel: { "host.tailnet.ts.net:443": true },
	});
	await getDisposer()();
	assert.equal(fake.posts.length, 1);
});

test("cleanup removes only the plugin-owned root route with an ETag compare-and-set", async () => {
	const { ctx, getDisposer } = makeContext();
	const logs = makeLogs();
	const before = { TCP: { "443": { HTTPS: true } } };
	const managed = routeConfig();
	const fake = makeStore({ before, managed });
	applyWithDeps(ctx, {}, commonDeps(
		logs, () => fake.store, (args) => args[0] === "version" ? ok("1.102.2") : ok(),
		() => ({ DNSName: "host.tailnet.ts.net." }),
	));
	await getDisposer()();
	assert.deepEqual(fake.captures, ["before", "managed", "latest", "cleanup-current"]);
	assert.equal(fake.posts.length, 1);
	assert.equal(fake.posts[0].etag, "managed-etag");
	assert.deepEqual(fake.posts[0].config, before);
	assert.equal(fake.wasCleaned(), true);
	assert.equal(logs.notes.some((line) => line.includes("without changing other Serve routes")), true);
});

test("cleanup retries ETag conflicts and never performs a blind restore", async () => {
	const { ctx, getDisposer } = makeContext();
	const logs = makeLogs();
	let posts = 0;
	const fake = makeStore({
		before: {},
		managed: routeConfig(),
		onPost: () => {
			posts += 1;
			return { ok: false, status: 412, body: "precondition failed" };
		},
	});
	applyWithDeps(ctx, {}, commonDeps(
		logs, () => fake.store, (args) => args[0] === "version" ? ok("1.102.2") : ok(),
		() => ({ DNSName: "host.tailnet.ts.net." }),
	));
	await getDisposer()();
	assert.equal(posts, 3);
	assert.equal(logs.warnings.some((line) => line.includes("kept changing during cleanup")), true);
});

test("cleanup preserves unrelated routes added after Serve", async () => {
	const { ctx, getDisposer } = makeContext();
	const logs = makeLogs();
	const managed = routeConfig();
	const fake = makeStore({ before: {}, managed });
	applyWithDeps(ctx, {}, commonDeps(
		logs,
		() => fake.store,
		(args) => args[0] === "version" ? ok("1.102.2") : ok(),
		() => ({ DNSName: "host.tailnet.ts.net." }),
	));
	const current = structuredClone(managed);
	current.Web["other.tailnet.ts.net:443"] = { Handlers: { "/health": { Text: "ok" } } };
	current.Services = { "svc:demo": { Web: { "demo.tailnet.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:9000" } } } } } };
	fake.setCurrent(current, "concurrent-etag");
	await getDisposer()();
	assert.equal(fake.posts.length, 1);
	assert.deepEqual(fake.posts[0].config.Web["other.tailnet.ts.net:443"], current.Web["other.tailnet.ts.net:443"]);
	assert.deepEqual(fake.posts[0].config.TCP, current.TCP);
	assert.deepEqual(fake.posts[0].config.Services, current.Services);
	assert.equal(fake.posts[0].etag, "concurrent-etag");
});

test("cleanup does not write when another process replaces the owned handler", async () => {
	const { ctx, getDisposer } = makeContext();
	const logs = makeLogs();
	const managed = routeConfig();
	const fake = makeStore({ before: {}, managed });
	applyWithDeps(ctx, {}, commonDeps(
		logs,
		() => fake.store,
		(args) => args[0] === "version" ? ok("1.102.2") : ok(),
		() => ({ DNSName: "host.tailnet.ts.net." }),
	));
	const replaced = routeConfig("host.tailnet.ts.net", 443, "http://127.0.0.1:9999");
	fake.setCurrent(replaced, "replaced-etag");
	await getDisposer()();
	assert.equal(fake.posts.length, 0);
	assert.equal(logs.warnings.some((line) => line.includes("root handler was changed")), true);
});

test("cleanup removes the owned handler while preserving Funnel enabled after verification", async () => {
	const { ctx, getDisposer } = makeContext();
	const logs = makeLogs();
	const managed = routeConfig();
	const fake = makeStore({ before: {}, managed });
	applyWithDeps(ctx, {}, commonDeps(
		logs,
		() => fake.store,
		(args) => args[0] === "version" ? ok("1.102.2") : ok(),
		() => ({ DNSName: "host.tailnet.ts.net." }),
	));
	const current = structuredClone(managed);
	current.AllowFunnel = { "host.tailnet.ts.net:443": true };
	fake.setCurrent(current, "funnel-etag");
	await getDisposer()();
	assert.equal(fake.posts.length, 1);
	assert.equal(fake.posts[0].etag, "funnel-etag");
	assert.deepEqual(fake.posts[0].config, {
		TCP: { "443": { HTTPS: true } },
		AllowFunnel: { "host.tailnet.ts.net:443": true },
	});
});

test("failed Serve retries and announces only after the retry succeeds", () => {
	const { ctx } = makeContext();
	const logs = makeLogs();
	const fake = makeStore({ before: {}, managed: routeConfig("custom.tailnet.ts.net") });
	const queue = [];
	let serveCalls = 0;
	const controller = applyWithDeps(ctx, { keepOnExit: true, hostname: "custom.tailnet.ts.net" }, commonDeps(
		logs,
		() => fake.store,
		(args) => {
			if (args[0] === "version") return ok("1.102.2");
			serveCalls += 1;
			return serveCalls === 1 ? failed("backend NoState") : ok();
		},
		() => null,
		{
			setTimeout: (callback) => { queue.push(callback); return { unref() {} }; },
			clearTimeout: () => {},
			retryDelays: [1],
		},
	));
	assert.equal(controller.state.settled, false);
	assert.equal(logs.notes.some((line) => line.includes("now reachable")), false);
	assert.equal(queue.length, 1);
	queue.shift()();
	assert.equal(controller.state.settled, true);
	assert.equal(controller.state.endpointUrl, "https://custom.tailnet.ts.net");
	assert.equal(logs.notes.filter((line) => line.includes("now reachable")).length, 1);
});

test("URL and config helpers normalize edge cases", () => {
	assert.equal(resolveServeUrl({ DNSName: "node.tailnet.ts.net..." }, true), "https://node.tailnet.ts.net");
	assert.equal(resolveServeUrl({ TailscaleIPs: ["fd7a:115c:a1e0::1"] }, false), "http://[fd7a:115c:a1e0::1]");
	assert.equal(resolveServeUrl({ TailscaleIPs: ["100.64.0.1"] }, true), null);
	assert.equal(resolveConfiguredUrl("https://node.tailnet.ts.net/path", false), "http://node.tailnet.ts.net");
	assert.equal(resolveConfiguredUrl("[fd7a:115c:a1e0::1]", true), "https://[fd7a:115c:a1e0::1]");
	assert.equal(canonicalServeConfig('{"b":2,"a":{"d":4,"c":3}}'), '{"a":{"c":3,"d":4},"b":2}');
	assert.equal(permissionDenied({ status: 403, body: "Access is denied." }), true);
	assert.equal(permissionDenied(failed("backend NoState")), false);
});

test("directory entries sort like Windows Explorer (natural, case-insensitive, Latin first)", () => {
	const names = ["文件夹10", "文件夹2", "项目", "项目10", "项目2", "a10", "a2", "B", "b1", "Folder 10", "Folder 2", "zebra"];
	const sorted = [...names].sort(explorerEntryCompare);
	assert.deepEqual(sorted, ["a2", "a10", "B", "b1", "Folder 2", "Folder 10", "zebra", "文件夹2", "文件夹10", "项目", "项目2", "项目10"]);
	// the bounded-insert path uses the same comparator on {name} objects
	assert.equal(explorerEntryCompare({ name: "a2" }, { name: "a10" }) < 0, true);
	assert.equal(explorerEntryCompare({ name: "Folder 10" }, { name: "Folder 2" }) > 0, true);
	assert.equal(explorerEntryCompare("项目", "zebra") > 0, true);
});

test("static enhancer gzips, tags and caches /assets and /plugins responses", async () => {
	const listeners = [];
	const server = {
		listeners: () => listeners.slice(),
		removeAllListeners: (event) => { if (event === "request") listeners.length = 0; },
		on: (event, fn) => { if (event === "request") listeners.push(fn); },
	};
	// the downstream handler stands in for DSH's static/fallback serving
	let downstreamCalls = 0;
	let sseRes = null;
	const downstream = (req, res) => {
		downstreamCalls += 1;
		if (req.url === "/plugins/events") {
			sseRes = res;
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.end();
			return;
		}
		res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
		res.end(Buffer.from("const x = 1;\n".repeat(400)));
	};
	listeners.push(downstream);
	const dispose = installStaticEnhancer({ webServer: { server } });
	assert.equal(listeners.length, 1);
	const enhanced = listeners[0];
	const makeRes = () => ({ destroyed: false, status: null, headers: null, chunks: [], writeHead(s, h) { this.status = s; this.headers = h ?? {}; }, end(c) { if (c) this.chunks.push(Buffer.from(c)); } });
	const gzipGet = { method: "GET", headers: { "accept-encoding": "gzip", host: "windows.tail31253f.ts.net" }, destroyed: false };

	const first = makeRes();
	await enhanced({ ...gzipGet, url: "/assets/index-abc123.js" }, first);
	assert.equal(first.status, 200);
	assert.equal(first.headers["content-encoding"], "gzip");
	assert.equal(first.headers["cache-control"], "public, max-age=31536000, immutable");
	const etag = first.headers.etag;
	assert.match(etag, /^W\//);
	const plain = Buffer.concat(first.chunks).length;
	assert.ok(plain < 5200 && plain > 0, "gzipped body present");
	assert.equal(downstreamCalls, 1);

	// a loopback Host (the PC's own browser) gets byte-exact stock responses
	const pc = makeRes();
	await enhanced({ method: "GET", url: "/assets/index-abc123.js", headers: { host: "127.0.0.1:3080" }, destroyed: false }, pc);
	assert.equal(pc.headers["content-encoding"], undefined);
	assert.equal(pc.headers["cache-control"], undefined);
	assert.equal(pc.headers.etag, undefined);
	assert.equal(Buffer.concat(pc.chunks).toString().startsWith("const x = 1;"), true);

	// repeat with a validator: 304 from cache, downstream untouched
	const servedBefore = downstreamCalls;
	const second = makeRes();
	await enhanced({ ...gzipGet, url: "/assets/index-abc123.js", headers: { "accept-encoding": "gzip", "if-none-match": etag } }, second);
	assert.equal(second.status, 304);
	assert.equal(second.chunks.length, 0);
	assert.equal(downstreamCalls, servedBefore);

	// repeat without a validator: full 200 from cache, still no downstream call
	const third = makeRes();
	await enhanced({ ...gzipGet, url: "/assets/index-abc123.js" }, third);
	assert.equal(third.status, 200);
	assert.equal(downstreamCalls, servedBefore);

	// a client without gzip support gets the raw bytes
	const fourth = makeRes();
	await enhanced({ method: "GET", url: "/assets/index-abc123.js", headers: {}, destroyed: false }, fourth);
	assert.equal(fourth.headers["content-encoding"], undefined);
	assert.equal(Buffer.concat(fourth.chunks).length > plain, true);

	// plugin bundle urls with a rev parameter are immutable too
	const fifth = makeRes();
	await enhanced({ ...gzipGet, url: "/plugins/@deepseek-ai/dsh-x/client.js?rev=abc" }, fifth);
	assert.equal(fifth.headers["cache-control"], "public, max-age=31536000, immutable");

	// non-hashed names stay revalidating (no-cache) but still carry an ETag
	const sixth = makeRes();
	await enhanced({ ...gzipGet, url: "/assets/plain.js" }, sixth);
	assert.equal(sixth.headers["cache-control"], "no-cache");
	assert.ok(sixth.headers.etag);

	// /api and SSE paths pass through untouched — the downstream receives the
	// REAL response object (no buffering shim), so streams keep streaming
	const seventh = makeRes();
	await enhanced({ method: "GET", url: "/plugins/events", headers: { "accept-encoding": "gzip" }, destroyed: false }, seventh);
	assert.notEqual(sseRes, null, "SSE reached the downstream handler directly");
	assert.equal(sseRes, seventh, "SSE downstream received the real response object");
	assert.equal(seventh.status, 200);
	assert.equal(seventh.headers["content-encoding"], undefined);

	// dispose restores the original listener set
	dispose();
	assert.equal(listeners.includes(enhanced), false);
	assert.equal(listeners.includes(downstream), true);
});

test("static enhancer leaves non-cacheable and /api responses byte-identical", async () => {
	const listeners = [];
	const server = {
		listeners: () => listeners.slice(),
		removeAllListeners: (event) => { if (event === "request") listeners.length = 0; },
		on: (event, fn) => { if (event === "request") listeners.push(fn); },
	};
	listeners.push((req, res) => {
		if (req.url === "/api/thing") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end('{"ok":true}');
			return;
		}
		res.writeHead(200, { "content-type": "image/png" });
		res.end(Buffer.alloc(2048, 7));
	});
	const dispose = installStaticEnhancer({ webServer: { server } });
	const enhanced = listeners[0];
	const makeRes = () => ({ destroyed: false, status: null, headers: null, chunks: [], writeHead(s, h) { this.status = s; this.headers = h ?? {}; }, end(c) { if (c) this.chunks.push(Buffer.from(c)); } });

	const api = makeRes();
	await enhanced({ method: "POST", url: "/api/thing", headers: { "accept-encoding": "gzip", host: "windows.tail31253f.ts.net" }, destroyed: false }, api);
	assert.equal(api.status, 200);
	// below the gzip threshold, so raw bytes — but unary /api JSON carries an
	// ETag now (0.3.0): revalidation without re-downloading
	assert.equal(api.headers["content-encoding"], undefined);
	assert.ok(api.headers.etag);
	assert.equal(Buffer.concat(api.chunks).toString(), '{"ok":true}');

	const png = makeRes();
	await enhanced({ method: "GET", url: "/plugins/some/icon.png", headers: { "accept-encoding": "gzip", host: "windows.tail31253f.ts.net" }, destroyed: false }, png);
	assert.equal(png.headers["content-encoding"], undefined);
	assert.equal(png.headers.etag, undefined);
	assert.equal(png.headers["cache-control"], undefined);
	assert.equal(png.chunks[0].length, 2048);
	dispose();
});

test("static enhancer compresses unary /api JSON and passes streams through", async () => {
	const listeners = [];
	const server = {
		listeners: () => listeners.slice(),
		removeAllListeners: (event) => { if (event === "request") listeners.length = 0; },
		on: (event, fn) => { if (event === "request") listeners.push(fn); },
	};
	listeners.push((req, res) => {
		if (req.url === "/api/sessions.history") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ history: Array.from({ length: 400 }, (_, i) => `消息 ${i} 一些聊天内容`).join("\n") }));
			return;
		}
		if (req.url === "/api/stream") {
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write("data: one\n\n");
			res.write("data: two\n\n");
			res.end();
			return;
		}
		res.writeHead(200, { "content-type": "application/json" });
		res.end('{"small":true}');
	});
	const dispose = installStaticEnhancer({ webServer: { server } });
	const enhanced = listeners[0];
	const makeRes = () => ({ destroyed: false, status: null, headers: null, chunks: [], writeHead(s, h) { this.status = s; this.headers = h ?? {}; }, write(c) { this.chunks.push(Buffer.from(c)); }, end(c) { if (c) this.chunks.push(Buffer.from(c)); } });
	const phone = { "accept-encoding": "gzip", host: "windows.tail31253f.ts.net" };

	// a big unary JSON response from a phone host: gzipped with an ETag
	const history = makeRes();
	await enhanced({ method: "POST", url: "/api/sessions.history", headers: { ...phone }, destroyed: false }, history);
	assert.equal(history.status, 200);
	assert.equal(history.headers["content-encoding"], "gzip");
	assert.ok(history.headers.etag);
	assert.ok(Number(history.headers["content-length"]) < 6000, "gzipped body is much smaller than the ~7KB JSON");

	// conditional re-request with the ETag: 304, zero bytes
	const history304 = makeRes();
	await enhanced({ method: "POST", url: "/api/sessions.history", headers: { ...phone, "if-none-match": history.headers.etag }, destroyed: false }, history304);
	assert.equal(history304.status, 304);
	assert.equal(history304.chunks.length, 0);

	// a loopback host gets the raw, unenhanced response
	const pcApi = makeRes();
	await enhanced({ method: "POST", url: "/api/sessions.history", headers: { "accept-encoding": "gzip", host: "127.0.0.1:3080" }, destroyed: false }, pcApi);
	assert.equal(pcApi.headers["content-encoding"], undefined);
	assert.equal(pcApi.headers.etag, undefined);

	// small JSON: no gzip (below threshold), still tagged
	const small = makeRes();
	await enhanced({ method: "GET", url: "/api/small", headers: { ...phone }, destroyed: false }, small);
	assert.equal(small.headers["content-encoding"], undefined);
	assert.ok(small.headers.etag);
	assert.equal(Buffer.concat(small.chunks).toString(), '{"small":true}');

	// the stream guard: an event-stream response is forwarded live, unbuffered
	const stream = makeRes();
	await enhanced({ method: "GET", url: "/api/stream", headers: { ...phone }, destroyed: false }, stream);
	assert.equal(stream.status, 200);
	assert.equal(stream.headers["content-encoding"], undefined);
	assert.equal(Buffer.concat(stream.chunks).toString().includes("data: two"), true);
	dispose();
});

test("static enhancer keeps gzip on slow-to-build session.list but bails to live for real streams", async () => {
	const listeners = [];
	const server = {
		listeners: () => listeners.slice(),
		removeAllListeners: (event) => { if (event === "request") listeners.length = 0; },
		on: (event, fn) => { if (event === "request") listeners.push(fn); },
	};
	let payload = "session list json placeholder";
	listeners.push((req, res) => {
		if (req.url === "/api/session.list") {
			// slower than the default 400ms guard, faster than the 5s slow-unary guard
			setTimeout(() => {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(payload.repeat(200));
			}, 600);
			return;
		}
		if (req.url === "/api/slowjsonstream") {
			// slower than the 400ms default guard: exercises the watchdog's live switch
			setTimeout(() => {
				res.writeHead(200, { "content-type": "application/json" });
				res.write('{"partial":');
				setTimeout(() => res.end('true}'), 100);
			}, 900);
			return;
		}
		res.writeHead(200, { "content-type": "application/json" });
		res.end('{"ok":true}');
	});
	const dispose = installStaticEnhancer({ webServer: { server } });
	const enhanced = listeners[0];
	const makeRes = () => ({ destroyed: false, status: null, headers: null, chunks: [], writeHead(s, h) { this.status = s; this.headers = h ?? {}; }, write(c) { this.chunks.push(Buffer.from(c)); }, end(c) { if (c) this.chunks.push(Buffer.from(c)); } });
	const phone = { "accept-encoding": "gzip", host: "windows.tail31253f.ts.net" };

	const listing = makeRes();
	await enhanced({ method: "POST", url: "/api/session.list", headers: { ...phone }, destroyed: false }, listing);
	// the deferred 600ms build lands after forward() returns synchronously
	await sleep(900);
	assert.equal(listing.status, 200);
	assert.equal(listing.headers["content-encoding"], "gzip", "session.list must stay buffered past the 400ms default guard so it ships gzipped");
	assert.equal(listing.headers["cache-control"], undefined, "api responses get no caching headers");

	// a stalled stream on the default guard is flushed live by the watchdog,
	// and the downstream's late body still lands (live forwarding)
	const stream = makeRes();
	enhanced({ method: "GET", url: "/api/slowjsonstream", headers: { ...phone }, destroyed: false }, stream);
	await sleep(700);
	assert.equal(stream.status, 200, "watchdog flushed the stalled response live");
	await sleep(700);
	assert.equal(Buffer.concat(stream.chunks).toString().includes('"partial"'), true, "post-watchdog body forwarded live");
	dispose();
});
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
