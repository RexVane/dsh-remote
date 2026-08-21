/**
 * Reproducible verification for lib/client.js (the mobile-fit stylesheet).
 *
 * Why this exists: the sheet is one big template literal injected into a live
 * DSH page, so `node --check` only proves the JavaScript parses — it says
 * nothing about whether the CSS inside is well formed, nothing about whether
 * the classes it targets still exist, and nothing about the behaviour of the
 * JavaScript half. DSH ships CSS modules with per-build hashed names, so an
 * upgrade can silently turn a working rule into a no-op. Those failure modes
 * are invisible in review and invisible on a desktop.
 *
 * Sections:
 *   1. The plugin loads under a stub browser and produces its stylesheet.
 *   2. The generated CSS is brace-balanced and every block has declarations.
 *   3. No stray backtick survived inside the CSS literal (a real mistake this
 *      file has seen: it ends the template early and breaks the whole plugin).
 *   4. Class selectors contain no build hashes, and every stable token still
 *      occurs in the bundles DSH serves.
 *   5. Regression: the marquee does not restart on a steady label.
 *   6. Regression: crossing the breakpoint installs the phone-only JS.
 *
 * Usage:  node tools/verify-mobile-fit.mjs [http://127.0.0.1:3080]
 * Section 4 is skipped with a notice when no DSH is reachable, so the script
 * stays useful offline.
 */

import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const origin = process.argv[2] ?? "http://127.0.0.1:3080";
// Overridable so the regression sections can be pointed at a deliberately
// broken copy to confirm they still fail on it. A check nobody has watched fail
// is not yet evidence of anything.
const sourcePath = process.env.MOBILE_FIT_SOURCE ?? join(root, "lib", "client.js");
const source = readFileSync(sourcePath, "utf8");

let failures = 0;
let warnings = 0;
const fail = (m) => { failures += 1; console.log(`  FAIL  ${m}`); };
const warn = (m) => { warnings += 1; console.log(`  WARN  ${m}`); };
const pass = (m) => { console.log(`  ok    ${m}`); };

const noopEvents = { addEventListener() {}, removeEventListener() {} };

/**
 * Load the plugin against a stub browser and return what it registered.
 * `overrides` is merged over the defaults so each section can shape the
 * environment it needs without repeating the whole stub.
 */
function loadPlugin(overrides = {}) {
	let captured = null;
	const styleNode = { id: "", textContent: "", remove() {} };
	const base = {
		window: {
			__ModuleLoader__: { load: (entry) => { captured = entry; } },
			location: { search: "" },
			matchMedia: () => ({ matches: true, ...noopEvents }),
			...noopEvents,
		},
		document: {
			getElementById: () => null,
			querySelector: () => null,
			querySelectorAll: () => [],
			createElement: () => styleNode,
			head: { appendChild() {} },
			documentElement: {},
			...noopEvents,
		},
		MutationObserver: class { observe() {} disconnect() {} },
		requestAnimationFrame: () => 0,
		performance: { now: () => 0 },
	};
	const sandbox = {
		...base,
		...overrides,
		window: { ...base.window, ...(overrides.window ?? {}) },
		document: { ...base.document, ...(overrides.document ?? {}) },
	};
	const run = new Function(...Object.keys(sandbox), source);
	run(...Object.values(sandbox));
	return { entry: captured, styleNode };
}

/* ---------- 1. load under a stub browser -------------------------------- */

console.log("\n[1] load client.js under a stub browser");

let css = "";
try {
	const { entry, styleNode } = loadPlugin();
	if (entry === null) fail("plugin never called window.__ModuleLoader__.load");
	else {
		pass(`registered module id "${entry.id}"`);
		const exported = entry.factory();
		if (typeof exported.apply !== "function") fail("factory did not export apply()");
		else {
			exported.apply();
			css = styleNode.textContent;
			if (css.length === 0) fail("apply() mounted no stylesheet text");
			else pass(`stylesheet produced (${css.length} chars)`);
		}
	}
} catch (error) {
	fail(`plugin threw while loading: ${error.message}`);
}

/* ---------- 1b. drive-aware directory flow ----------------------------- */

console.log("\n[1b] drive-aware directory flow is safe");

function fakeReact() {
	const state = [];
	let cursor = 0;
	const effects = [];
	const reset = () => { cursor = 0; };
	return {
		Fragment: Symbol("Fragment"),
		createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } }),
		useState(initial) {
			const index = cursor++;
			if (!(index in state)) state[index] = typeof initial === "function" ? initial() : initial;
			return [state[index], (next) => { state[index] = typeof next === "function" ? next(state[index]) : next; }];
		},
		useRef(initial) {
			const index = cursor++;
			if (!(index in state)) state[index] = { current: initial };
			return state[index];
		},
		useCallback(fn) { return fn; },
		useEffect(fn) { effects.push(fn); },
		render(Component, props) { reset(); return Component(props); },
		flushEffects() { for (const effect of effects.splice(0)) effect(); },
	};
}

function walkTree(node, visit) {
	if (node === null || node === undefined || typeof node === "boolean") return;
	if (Array.isArray(node)) {
		for (const child of node) walkTree(child, visit);
		return;
	}
	if (typeof node !== "object") return;
	visit(node);
	walkTree(node.props?.children, visit);
}

try {
	const react = fakeReact();
	const slots = [];
	const primitives = {
		Modal: "Modal", Button: "Button", IconChevronRightOutline14: "Chevron",
		IconFolderClose16: "Folder", IconPlusOutline16: "Plus",
	};
	const { entry } = loadPlugin({
		navigator: { language: "zh-CN" },
	});
	const exported = entry.factory((name) => name === "react" ? react : primitives);
	const ctx = {
		connection: { rpc: { call: async () => ({ ok: true, value: { drives: ["B:\\", "C:\\", "D:\\"] } }) } },
		workspaces: {
			listDirectory: async (path) => ({ path, home: "C:\\Users\\u", crumbs: [], entries: [], truncated: false }),
			createDirectory: async (path, name) => `${path}${name}`,
		},
		effect(factory) { factory(); },
		slots: {
			inject(_name, factory) {
				const result = factory();
				if (result?.next) for (const _value of result) { /* registrations happen eagerly */ }
			},
			register(options, Component) { slots.push({ options, Component }); return () => {}; },
		},
	};
	exported.apply(ctx);
	assert.equal(slots.length, 2);
	const injected = slots[0].options.inject();
	let picked = null;
	const props = { open: true, busy: false, onPicked: (path) => { picked = path; }, onCancel() {}, onError() {}, ...injected };
	let tree = react.render(slots[0].Component, props);
	react.flushEffects();
	await Promise.resolve();
	await Promise.resolve();
	tree = react.render(slots[0].Component, props);
	const buttons = [];
	walkTree(tree, (node) => { if (node.type === "button" || node.type === "Button") buttons.push(node); });
	const text = (value) => {
		if (typeof value === "string") return value;
		if (Array.isArray(value)) return value.map(text).join("");
		if (value && typeof value === "object") {
			if (value.props?.["aria-hidden"] === true) return "";
			return text(value.props?.children);
		}
		return "";
	};
	const driveButtons = buttons.filter((button) => /^[BCD]:\\$/u.test(text(button)));
	if (driveButtons.map(text).join(",") !== "B:\\,C:\\,D:\\") {
		fail("virtual This PC did not render the enumerated drive roots");
	}
	else pass("virtual This PC renders B:\\, C:\\ and D:\\");
	if (buttons.some((button) => text(button) === "此电脑" && typeof button.props.onClick !== "function")) fail("This PC breadcrumb is not navigable UI state");
	else pass("This PC remains UI navigation, not a submitted path");
	const open = buttons.find((button) => text(button) === "打开");
	open?.props.onClick?.();
	if (picked !== null) fail(`virtual drive root submitted ${JSON.stringify(picked)}`);
	else pass("Open cannot submit the virtual This PC root");
	const calls = [];
	ctx.workspaces.listDirectory = async (path) => { calls.push(path); return { path, home: "C:\\Users\\u", crumbs: [], entries: [], truncated: false }; };
	driveButtons.find((button) => text(button) === "D:\\")?.props.onClick?.();
	if (calls[0] !== "D:\\") fail(`D:\\ did not browse the real root (got ${JSON.stringify(calls[0])}); buttons=${buttons.map(text).join(" | ")}`);
	else pass('clicking D:\\ calls listDirectory("D:\\\\")');
} catch (error) {
	fail(`drive-aware flow verification threw: ${error.message}`);
}

/* ---------- 2. CSS structure ------------------------------------------- */

console.log("\n[2] generated CSS is structurally sound");

if (css.length > 0) {
	let depth = 0;
	let minDepth = 0;
	for (const ch of css) {
		if (ch === "{") depth += 1;
		else if (ch === "}") { depth -= 1; if (depth < minDepth) minDepth = depth; }
	}
	if (depth !== 0) fail(`unbalanced braces: ends at depth ${depth}`);
	else if (minDepth < 0) fail("a closing brace appears before its opener");
	else pass("braces balanced");

	const empty = [...css.matchAll(/([^{}]+)\{\s*\}/g)].map((m) => m[1].trim().split("\n").pop().trim());
	if (empty.length > 0) fail(`${empty.length} empty block(s): ${empty.slice(0, 3).join(" | ")}`);
	else pass("no empty rule blocks");

	const head = css.slice(0, css.indexOf("{"));
	if (/[a-z-]+\s*:\s*[^;]+;/.test(head)) fail("declarations found before the first block");
	else pass("no declarations outside a block");

	const mediaCount = (css.match(/@media/g) ?? []).length;
	pass(`${(css.match(/\{/g) ?? []).length - mediaCount} rules inside ${mediaCount} @media block(s)`);

	if (!css.trimStart().startsWith("@media")) fail("sheet does not open with @media — desktop would be affected");
	else pass("every rule is inside the mobile @media guard");
}

/* ---------- 3. CSS literal integrity ----------------------------------- */

console.log("\n[3] CSS literal integrity in the source");

const openIdx = source.indexOf("const CSS = `");
const closeIdx = source.indexOf("\n`;", openIdx);
if (openIdx < 0 || closeIdx < 0) fail("could not locate the CSS template literal");
else {
	const body = source.slice(openIdx + "const CSS = `".length, closeIdx);
	const stray = [...body].filter((c) => c === "`").length;
	if (stray > 0) fail(`${stray} stray backtick(s) inside the CSS literal — it ends early`);
	else pass("no stray backticks inside the CSS literal");
}

/* ---------- 4. selectors still match what DSH serves -------------------- */

console.log(`\n[4] selectors still exist in the bundles served by ${origin}`);

// Comments discuss selectors that were deliberately removed, so strip them
// first or the audit reports its own prose as a live dependency.
const cssRules = css.replace(/\/\*[\s\S]*?\*\//g, "");
const tokens = [...new Set([...cssRules.matchAll(/\[class\*="([^"]+)"\]/g)].map((m) => m[1]))];
pass(`${tokens.length} distinct [class*=…] tokens referenced`);

// DSH CSS modules use `hash_name`; a stable substring therefore begins at the
// `_name` suffix. Any other class substring pins the sheet to one DSH build and
// must fail even when that build is not running for the live corpus check.
const buildPinnedTokens = tokens.filter((token) => !token.startsWith("_"));
if (buildPinnedTokens.length > 0) {
	fail(`hard-coded build class(es) are forbidden: ${buildPinnedTokens.join(", ")}`);
} else {
	pass("no hard-coded CSS-module build hashes");
}

let corpus = "";
try {
	const html = await (await fetch(origin, { signal: AbortSignal.timeout(4000) })).text();
	// Two naming schemes must both be searched, and missing either one produces
	// false "dead selector" reports:
	//   plugin bundles  -> hash_name   (hHd-Xa_sidebarCol)
	//   the app shell   -> _name_hash  (_item_19372)
	// The shell classes back the shared menu primitives this sheet also styles.
	const pluginUrls = [...new Set([...html.matchAll(/\/plugins\/[^"'\\\s]+?client\.js[^"'\\\s]*/g)].map((m) => m[0]))]
		.filter((u) => !u.includes("dsh-tailscale-serve")); // exclude ourselves: we would self-match
	const shellUrls = [...new Set([...html.matchAll(/\/assets\/[A-Za-z0-9._-]+\.(?:css|js)/g)].map((m) => m[0]))];
	if (pluginUrls.length === 0) throw new Error("no client bundles listed in the boot payload");
	const urls = [...pluginUrls, ...shellUrls];
	const bodies = await Promise.all(urls.map(async (u) => (await fetch(origin + u)).text()));
	corpus = bodies.join("\n");
	pass(`fetched ${pluginUrls.length} plugin bundles + ${shellUrls.length} shell assets (${corpus.length} chars)`);
} catch (error) {
	warn(`skipped: could not read bundles (${error.message})`);
	warn("start DSH and re-run to validate selectors against the build you ship on");
}

if (corpus.length > 0) {
	const dead = tokens.filter((t) => !corpus.includes(t));
	if (dead.length > 0) fail(`${dead.length} selector(s) match nothing in DSH: ${dead.join(", ")}`);
	else pass("every [class*=…] token occurs in a DSH bundle");

}

/* ---------- 5. marquee does not restart -------------------------------- */

console.log("\n[5] regression: a steady label is measured once, not every pass");

/**
 * A label whose width genuinely differs between the two states, which is the
 * case the cache used to get wrong: while ticking, CSS pins it to the marquee
 * window; while idle, the composer row squeezes it narrower than that.
 */
function fakeLabel(ops) {
	const attrs = new Set();
	return {
		textContent: "some-very-long-model-name",
		get clientWidth() { return attrs.has("data-dsh-marquee") ? 109 : 80; },
		get scrollWidth() { return 240; },
		setAttribute(name) { attrs.add(name); ops.push(`+${name}`); },
		removeAttribute(name) { if (attrs.has(name)) ops.push(`-${name}`); attrs.delete(name); },
		style: { setProperty() {}, removeProperty() {} },
	};
}

try {
	const ops = [];
	const label = fakeLabel(ops);
	let onResize = null;
	const { entry } = loadPlugin({
		requestAnimationFrame: (cb) => { cb(); return 0; },
		window: {
			matchMedia: () => ({ matches: true, ...noopEvents }),
			addEventListener: (type, handler) => { if (type === "resize") onResize = handler; },
			removeEventListener() {},
		},
		document: {
			querySelectorAll: (sel) => (sel.includes("_triggerLabel") ? [label] : []),
		},
	});
	entry.factory().apply();

	const afterFirst = ops.length;
	if (!ops.includes("+data-dsh-marquee")) fail("an overflowing label was never marked");
	else pass(`first pass marked the label (${afterFirst} attribute ops)`);

	if (onResize === null) fail("watchMarquee never registered a resize listener");
	else {
		onResize();
		onResize();
		const added = ops.slice(afterFirst);
		if (added.length === 0) pass("two further passes made no attribute changes — animation keeps running");
		else fail(`later passes churned the mark (${added.join(" ")}) — the ticker restarts each time`);
	}
} catch (error) {
	fail(`marquee regression check threw: ${error.message}`);
}

/* ---------- 6. breakpoint crossing installs the phone-only JS ---------- */

console.log("\n[6] regression: rotating across the breakpoint installs phone-only JS");

try {
	const listeners = [];
	let matches = false; // start in landscape: 844px wide, past the 820px breakpoint
	const meta = {
		content: "width=device-width, initial-scale=1",
		getAttribute() { return this.content; },
		setAttribute(_name, value) { this.content = value; },
	};
	const { entry } = loadPlugin({
		window: {
			matchMedia: () => ({
				get matches() { return matches; },
				addEventListener: (_t, h) => listeners.push(h),
				removeEventListener() {},
			}),
			...noopEvents,
		},
		document: {
			querySelector: (sel) => (sel.includes("viewport") ? meta : null),
		},
	});
	entry.factory().apply();

	if (meta.content.includes("interactive-widget")) fail("viewport was tuned while past the breakpoint");
	else pass("landscape load leaves the page viewport untouched");

	if (listeners.length === 0) fail("no breakpoint listener registered — rotation cannot be noticed");
	else {
		matches = true; // rotate to portrait
		for (const h of listeners) h();
		if (meta.content.includes("interactive-widget=resizes-content") && meta.content.includes("viewport-fit=cover")) {
			pass("rotating into portrait applies the keyboard-aware viewport");
		} else fail(`rotation did not tune the viewport (content="${meta.content}")`);

		matches = false; // rotate back
		for (const h of listeners) h();
		if (meta.content === "width=device-width, initial-scale=1") pass("rotating back restores the original viewport");
		else fail(`rotating back left the viewport modified (content="${meta.content}")`);
	}
} catch (error) {
	fail(`breakpoint regression check threw: ${error.message}`);
}

/* ---------- summary ---------------------------------------------------- */

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${failures} failure(s), ${warnings} warning(s)\n`);
process.exit(failures === 0 ? 0 : 1);
