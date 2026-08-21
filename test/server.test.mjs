import assert from "node:assert/strict";
import test from "node:test";

import {
	applyWithDeps,
	buildServeArgs,
	canonicalServeConfig,
	listWindowsDrives,
	permissionDenied,
	proxyTargetForBind,
	registerDriveRpc,
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

test("drive enumeration is empty outside Windows without probing the filesystem", () => {
	let statCalls = 0;
	const drives = listWindowsDrives({
		platform: "linux",
		stat: () => {
			statCalls += 1;
			throw new Error("must not probe drives");
		},
	});
	assert.deepEqual(drives, []);
	assert.equal(statCalls, 0);
});

test("Windows drive enumeration returns only ready directory roots", () => {
	const ready = new Set(["B:\\", "D:\\"]);
	const probed = [];
	const drives = listWindowsDrives({
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

test("drive RPC is registered behind trusted-host authority and returns enumerated roots", async () => {
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
	const result = registerDriveRpc(ctx, { listWindowsDrives: () => ["C:\\", "D:\\"] });
	assert.equal(result, "drive-rpc-disposer");
	assert.equal(registration.channel, "/tailscale-serve");
	assert.deepEqual(registration.options, { authority: "trusted-host" });
	assert.deepEqual(await registration.handler("listDrives"), {
		ok: true,
		value: { drives: ["C:\\", "D:\\"] },
	});
});

test("drive RPC rejects unknown endpoints without enumerating drives", async () => {
	let handler = null;
	let enumerateCalls = 0;
	registerDriveRpc({
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
	});
	assert.deepEqual(await handler("not-listDrives"), {
		ok: false,
		error: {
			code: "bad-request",
			message: "unknown tailscale-serve endpoint",
			details: { issues: [] },
		},
	});
	assert.equal(enumerateCalls, 0);
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
