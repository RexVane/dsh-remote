/**
 * Live phone-geometry matrix for the mobile-fit stylesheet.
 *
 * Companion to verify-mobile-fit.mjs. That script proves the sheet's selectors
 * resolve; this one drives a real headless browser against a running DSH and
 * measures what the page actually lays out at phone widths — the part no static
 * check can reach.
 *
 * It speaks CDP over Node's built-in WebSocket, so it needs no Playwright and
 * no npm install. Chrome or Edge on the machine is enough.
 *
 * It is strictly read-only: it resizes, measures and screenshots. It never
 * clicks anything that would create a session or mutate state.
 *
 * Usage:
 *   node tools/verify-mobile-geometry.mjs [origin] [--keep-shots]
 *   node tools/verify-mobile-geometry.mjs http://127.0.0.1:3080
 *   node tools/verify-mobile-geometry.mjs http://127.0.0.1:3080 --no-sandbox
 */

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const origin = args.find((a) => a.startsWith("http")) ?? "http://127.0.0.1:3080";
const keepShots = args.includes("--keep-shots");
// Opt-in only: some managed/CI Windows sessions terminate headless Chrome as
// soon as CDP enables the page domain unless the browser sandbox is disabled.
// Normal local verification keeps Chrome's sandbox enabled.
const noSandbox = args.includes("--no-sandbox");
const shotDir = join(root, "gui-test-screenshots");

const BROWSERS = [
	`${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
	`${process.env["ProgramFiles(x86)"]}\\Microsoft\\Edge\\Application\\msedge.exe`,
	`${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
	"/usr/bin/google-chrome",
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

/** Phone widths worth checking, with a realistic height for each. */
const MATRIX = [
	{ w: 320, h: 568, note: "smallest supported" },
	{ w: 340, h: 720, note: "narrow android" },
	{ w: 360, h: 780, note: "common android" },
	{ w: 375, h: 667, note: "iPhone SE" },
	{ w: 390, h: 844, note: "iPhone 14/15" },
	{ w: 412, h: 915, note: "Pixel" },
	{ w: 430, h: 932, note: "iPhone Pro Max" },
	{ w: 440, h: 956, note: "largest phone" },
	{ w: 820, h: 1180, note: "breakpoint edge (sheet still on)" },
	{ w: 1200, h: 900, note: "desktop (sheet must be OFF)" },
];

let failures = 0;
const fail = (m) => { failures += 1; console.log(`  FAIL  ${m}`); };
const pass = (m) => console.log(`  ok    ${m}`);
const info = (m) => console.log(`        ${m}`);

/* ---------- minimal CDP client ----------------------------------------- */

const CDP_OPEN_TIMEOUT_MS = 10_000;
const CDP_COMMAND_TIMEOUT_MS = 15_000;

class CDP {
	constructor(url) {
		this.ws = new WebSocket(url);
		this.id = 0;
		this.pending = new Map();
		this.openSlot = null;
		this.closedError = null;
		this.didOpen = false;
		this.lastMethod = null;

		this.ws.addEventListener("open", () => {
			this.didOpen = true;
			if (this.openSlot === null) return;
			clearTimeout(this.openSlot.timer);
			this.openSlot.resolve();
			this.openSlot = null;
		});
		this.ws.addEventListener("message", (event) => {
			let msg;
			try {
				msg = JSON.parse(event.data);
			} catch {
				this.disconnect(new Error("CDP sent an invalid message"));
				this.close();
				return;
			}
			const slot = this.pending.get(msg.id);
			if (slot === undefined) return;
			this.pending.delete(msg.id);
			clearTimeout(slot.timer);
			if (msg.error) slot.reject(new Error(`${slot.method}: ${msg.error.message}`));
			else slot.resolve(msg.result);
		});
		this.ws.addEventListener("error", (event) => {
			const message = event.message || event.error?.message;
			const detail = message ? `: ${message}` : "";
			const phase = this.didOpen
				? `after opening${this.lastMethod ? ` (last command: ${this.lastMethod})` : ""}`
				: "while opening";
			this.disconnect(new Error(`CDP socket error ${phase}${detail}`));
		});
		this.ws.addEventListener("close", (event) => {
			const detail = event.reason || (event.code !== 1000 ? `code ${event.code}` : "");
			this.disconnect(new Error(`CDP socket closed${detail ? ` (${detail})` : ""}`));
		});
	}
	disconnect(error) {
		if (this.closedError === null) this.closedError = error;
		const reason = this.closedError;
		if (this.openSlot !== null) {
			clearTimeout(this.openSlot.timer);
			this.openSlot.reject(reason);
			this.openSlot = null;
		}
		for (const slot of this.pending.values()) {
			clearTimeout(slot.timer);
			slot.reject(reason);
		}
		this.pending.clear();
	}
	open() {
		if (this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
		if (this.closedError !== null) return Promise.reject(this.closedError);
		if (this.openSlot !== null) return this.openSlot.promise;

		const promise = new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.disconnect(new Error(`CDP socket did not open within ${CDP_OPEN_TIMEOUT_MS}ms`));
				try { this.ws.close(); } catch { /* already gone */ }
			}, CDP_OPEN_TIMEOUT_MS);
			this.openSlot = { resolve, reject, timer, promise: null };
		});
		this.openSlot.promise = promise;
		return promise;
	}
	send(method, params = {}) {
		if (this.closedError !== null) return Promise.reject(this.closedError);
		if (this.ws.readyState !== WebSocket.OPEN) {
			return Promise.reject(new Error(`cannot send ${method}: CDP socket is not open`));
		}
		const id = ++this.id;
		this.lastMethod = method;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				if (!this.pending.delete(id)) return;
				reject(new Error(`${method} timed out after ${CDP_COMMAND_TIMEOUT_MS}ms`));
			}, CDP_COMMAND_TIMEOUT_MS);
			this.pending.set(id, { resolve, reject, timer, method });
			try {
				this.ws.send(JSON.stringify({ id, method, params }));
			} catch (error) {
				this.pending.delete(id);
				clearTimeout(timer);
				reject(error);
			}
		});
	}
	async eval(fn, ...fnArgs) {
		const expression = `(${fn.toString()})(...${JSON.stringify(fnArgs)})`;
		const res = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
		if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? "page threw");
		return res.result.value;
	}
	close() {
		this.disconnect(new Error("CDP client closed"));
		try { this.ws.close(); } catch { /* already gone */ }
	}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- in-page measurement ---------------------------------------- */

/** Runs inside the page. Returns only plain JSON. */
function measure() {
	const visible = (el) => {
		if (!el) return false;
		const s = getComputedStyle(el);
		if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
		const r = el.getBoundingClientRect();
		return r.width > 0 && r.height > 0;
	};
	const box = (el) => {
		if (!el) return null;
		const r = el.getBoundingClientRect();
		return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
	};
	const de = document.documentElement;
	const frame = [...document.querySelectorAll("div")].find((d) => d.querySelector(':scope > [class*="_sidebarCol"]')) ?? null;
	const toggle = document.querySelector('[class*="_sidebarCol"] [class*="_toggle"]');
	const sheetOn = [...document.querySelectorAll("style")].some((s) => s.id === "dsh-tailscale-serve-mobile-fit");

	// Anything sticking out past the right edge is what makes a page rock sideways.
	const overflowing = [];
	if (frame) {
		for (const el of document.querySelectorAll("body *")) {
			const r = el.getBoundingClientRect();
			if (r.width === 0 || r.height === 0) continue;
			if (r.right > window.innerWidth + 2 || r.left < -2) {
				const s = getComputedStyle(el);
				if (s.position === "fixed" || s.position === "absolute" || s.overflowX === "auto" || s.overflowX === "scroll") continue;
				overflowing.push({ cls: String(el.className).slice(0, 60), ...box(el) });
				if (overflowing.length >= 5) break;
			}
		}
	}

	return {
		innerWidth: window.innerWidth,
		docScrollWidth: de.scrollWidth,
		bodyScrollWidth: document.body.scrollWidth,
		sheetOn,
		mediaMatches: window.matchMedia("(max-width: 820px)").matches,
		frameFound: frame !== null,
		collapsed: frame ? frame.hasAttribute("data-sidebar-collapsed") : null,
		gridColumns: frame ? getComputedStyle(frame).gridTemplateColumns : null,
		toggle: box(toggle),
		toggleVisible: visible(toggle),
		togglePosition: toggle ? getComputedStyle(toggle).position : null,
		// The fix under test: DSH swaps these two only on :hover, which touch never gives.
		railMarkVisible: visible(toggle?.querySelector('[class*="_railMark"]')),
		panelIconVisible: visible(toggle?.querySelector('[class*="_panelIcon"]')),
		viewportMeta: document.querySelector('meta[name="viewport"]')?.getAttribute("content") ?? null,
		overflowing,
	};
}

/* ---------- run --------------------------------------------------------- */

const binary = BROWSERS.find((b) => b && existsSync(b));
if (!binary) { console.log("\nFAIL — no Chrome or Edge found\n"); process.exit(1); }

console.log(`\nbrowser : ${binary}`);
console.log(`origin  : ${origin}\n`);

const profile = mkdtempSync(join(tmpdir(), "dsh-mobilefit-"));
const port = 9411;
const browserArgs = [
	"--headless=new",
	`--remote-debugging-port=${port}`,
	`--user-data-dir=${profile}`,
	"--no-first-run", "--no-default-browser-check", "--disable-gpu",
	"--hide-scrollbars", "about:blank",
];
if (noSandbox) browserArgs.splice(-1, 0, "--no-sandbox");
const child = spawn(binary, browserArgs, { stdio: "ignore" });

let cdp = null;
try {
	// Wait for the debugging endpoint, then attach to the page target directly.
	let target = null;
	for (let i = 0; i < 50 && target === null; i += 1) {
		await sleep(200);
		try {
			const list = await (await fetch(`http://127.0.0.1:${port}/json/list`, {
				signal: AbortSignal.timeout(1_000),
			})).json();
			target = list.find((t) => t.type === "page") ?? null;
		} catch { /* not up yet */ }
	}
	if (target === null) throw new Error("browser never exposed a page target");

	cdp = new CDP(target.webSocketDebuggerUrl);
	await cdp.open();
	await cdp.send("Page.enable");
	await cdp.send("Runtime.enable");

	// Boot the app once at a phone size, then only resize between checks.
	await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
	const navigation = await cdp.send("Page.navigate", { url: origin });
	if (navigation.errorText) {
		throw new Error(`DSH is not running or reachable at ${origin} (${navigation.errorText})`);
	}

	let booted = false;
	for (let i = 0; i < 60 && !booted; i += 1) {
		await sleep(500);
		const state = await cdp.eval(() => ({
			booted: document.querySelector('[class*="_sidebarCol"]') !== null,
			href: window.location.href,
		}));
		if (state.href.startsWith("chrome-error://")) {
			throw new Error(`DSH is not running or reachable at ${origin} (browser loaded a network error page)`);
		}
		booted = state.booted;
	}
	if (!booted) throw new Error("DSH never rendered its shell — is it running and reachable?");
	pass("DSH shell rendered in headless browser");

	const sheet = await cdp.eval(() => [...document.querySelectorAll("style")].some((s) => s.id === "dsh-tailscale-serve-mobile-fit"));
	if (!sheet) fail("the mobile-fit stylesheet is not present — plugin not loaded in this DSH");
	else pass("mobile-fit stylesheet is mounted by the running DSH");

	if (keepShots) mkdirSync(shotDir, { recursive: true });

	for (const { w, h, note } of MATRIX) {
		const phone = w <= 820;
		await cdp.send("Emulation.setDeviceMetricsOverride", {
			width: w, height: h, deviceScaleFactor: 2, mobile: phone,
		});
		// Poll for the resize to actually land instead of guessing at a delay: a
		// large jump (phone -> desktop) needs the media query, React's own resize
		// handling and the sheet's teardown to settle, and a fixed sleep made this
		// check flaky in exactly that step.
		let settled = false;
		for (let i = 0; i < 30 && !settled; i += 1) {
			await sleep(120);
			settled = await cdp.eval(
				(width, wantPhone) => window.innerWidth === width
					&& window.matchMedia("(max-width: 820px)").matches === wantPhone,
				w, phone,
			);
		}
		await sleep(250); // let layout and the marquee measurement finish
		const m = await cdp.eval(measure);
		const tag = `${w}x${h} (${note})`;
		console.log(`\n  -- ${tag}`);
		if (!settled) fail(`${tag}: viewport never settled (innerWidth ${m.innerWidth}, media ${m.mediaMatches})`);

		if (m.mediaMatches !== phone) fail(`${tag}: media query reports ${m.mediaMatches}, expected ${phone}`);

		// 1. No sideways rocking.
		const slack = m.docScrollWidth - m.innerWidth;
		if (slack > 2) {
			fail(`${tag}: document is ${slack}px wider than the viewport`);
			for (const o of m.overflowing) info(`overflow: ${o.cls} @ x=${o.x} w=${o.w}`);
		} else pass(`${tag}: no horizontal overflow (scrollWidth ${m.docScrollWidth} <= ${m.innerWidth})`);

		if (!phone) {
			// Desktop must be untouched: the rail keeps its real width.
			if (m.togglePosition === "fixed") fail(`${tag}: toggle is fixed at desktop width — sheet leaked past its breakpoint`);
			else pass(`${tag}: desktop layout unaffected (toggle position: ${m.togglePosition})`);
			continue;
		}

		// 2. The floating opener must be reachable and on screen.
		if (m.collapsed === true) {
			if (!m.toggleVisible) fail(`${tag}: collapsed, but the floating sidebar button is not visible`);
			else if (m.toggle.x < 0 || m.toggle.y < 0 || m.toggle.x + m.toggle.w > m.innerWidth) {
				fail(`${tag}: floating button out of bounds ${JSON.stringify(m.toggle)}`);
			} else pass(`${tag}: floating button on screen at ${m.toggle.x},${m.toggle.y} (${m.toggle.w}x${m.toggle.h})`);

			// 3. The fix under test — exactly one glyph, and it must be the panel icon.
			if (m.railMarkVisible) fail(`${tag}: fish mark still visible behind the panel icon (the _railFish/_railMark defect)`);
			else pass(`${tag}: fish mark hidden`);
			if (!m.panelIconVisible) fail(`${tag}: panel icon not visible — button reads as a logo, not "open menu"`);
			else pass(`${tag}: panel icon visible`);

			if (m.gridColumns && !/^0px/.test(m.gridColumns)) {
				fail(`${tag}: collapsed rail still occupies a track (${m.gridColumns})`);
			} else pass(`${tag}: collapsed rail track is 0px`);
		} else info(`${tag}: sidebar is expanded — floating-button checks skipped`);

		// 4. The keyboard-aware viewport must be installed at phone width.
		if (!m.viewportMeta?.includes("interactive-widget=resizes-content")) {
			fail(`${tag}: viewport meta lacks interactive-widget (got "${m.viewportMeta}")`);
		} else pass(`${tag}: keyboard-aware viewport applied`);

		if (keepShots && (w === 360 || w === 390)) {
			const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
			const file = join(shotDir, `${w}x${h}-verified.png`);
			writeFileSync(file, Buffer.from(shot.data, "base64"));
			info(`screenshot: ${file}`);
		}
	}
} catch (error) {
	fail(error.message);
} finally {
	cdp?.close();
	child.kill();
	await sleep(300);
	try { rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${failures} failure(s)\n`);
process.exit(failures === 0 ? 0 : 1);
