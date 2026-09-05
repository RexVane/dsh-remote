/**
 * Phone QA: drive a real headless browser against the live tailnet DSH and
 * exercise every area the mobile-fit plugin touches.
 *
 * Covers, at phone widths (390/360/320):
 *   load (stylesheet, overflow, keyboard viewport)
 *   floating sidebar button (open drawer, list sessions, close)
 *   hero (greeting, model picker opens/dismisses, mode picker opens)
 *   workspace directory picker (drives, folders, breadcrumb, cancel)
 *   composer (type, send, message renders, action row, copy button)
 *   header on a completed session (name, preset badge unclipped, tabs,
 *     trajectory, details panel, session stats line)
 *   settings (nav, Agent-preset picker enabled and opens, theme cubes, scroll)
 *   marquee (long model labels tick)
 *   console errors collected throughout
 *
 * Read-only by default except one short message sent through the composer.
 * Menu selections are opened and dismissed without choosing, so defaults stay
 * put; the directory picker is opened and cancelled, never submitted.
 *
 * Usage:
 *   node tools/mobile-qa.mjs            # tailnet URL
 *   node tools/mobile-qa.mjs <origin>   # e.g. http://127.0.0.1:3080
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const origin = process.argv[2] ?? "https://windows.tail31253f.ts.net/";

const BROWSERS = [
	`${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
	`${process.env["ProgramFiles(x86)"]}\\Microsoft\\Edge\\Application\\msedge.exe`,
	`${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
	"/usr/bin/google-chrome",
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];
const binary = BROWSERS.find((b) => b && existsSync(b));
if (!binary) { console.log("FAIL — no Chrome or Edge found"); process.exit(1); }

let failures = 0;
let warnings = 0;
let checks = 0;
const report = (name, ok, detail = "") => {
	checks += 1;
	if (ok) { console.log(`  ok    ${name}${detail ? ` — ${detail}` : ""}`); }
	else { failures += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
};
const warn = (name, detail = "") => { warnings += 1; console.log(`  WARN  ${name}${detail ? ` — ${detail}` : ""}`); };
const info = (m) => console.log(`        ${m}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- CDP bootstrap ---------------------------------------------- */

const profile = mkdtempSync(join(tmpdir(), "dsh-mobileqa-"));
const child = spawn(binary, [
	"--headless=new", "--disable-gpu", "--no-sandbox", "--no-proxy-server",
	"--user-data-dir=" + profile,
	"--window-size=390,844",
	"--remote-debugging-port=0",
	"about:blank",
], { stdio: ["ignore", "pipe", "pipe"] });

let port = null;
child.stderr.on("data", (d) => {
	const m = d.toString().match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/);
	if (m) port = m[1];
});

let ws = null;
let id = 0;
const pending = new Map();
const consoleErrors = [];
const send = (method, params = {}) => new Promise((resolve, reject) => {
	if (ws?.readyState !== WebSocket.OPEN) return reject(new Error("CDP socket not open"));
	const i = ++id;
	pending.set(i, { resolve, reject, method });
	ws.send(JSON.stringify({ id: i, method, params }));
});

async function boot() {
	for (let i = 0; i < 100 && !port; i++) await sleep(100);
	if (!port) throw new Error("browser never exposed a debugging port");
	const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
	const page = targets.find((t) => t.type === "page");
	ws = new WebSocket(page.webSocketDebuggerUrl);
	await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
	ws.onmessage = (e) => {
		const msg = JSON.parse(e.data);
		if (msg.id && pending.has(msg.id)) {
			const slot = pending.get(msg.id);
			pending.delete(msg.id);
			if (msg.error) slot.reject(new Error(`${slot.method}: ${msg.error.message}`));
			else slot.resolve(msg.result);
		}
		if (msg.method === "Runtime.exceptionThrown") {
			consoleErrors.push((msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text || "").slice(0, 300));
		}
		if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
			consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 300));
		}
	};
	await send("Runtime.enable");
	await send("Page.enable");
	await send("Security.enable");
	await send("Security.setIgnoreCertificateErrors", { ignore: true });
	await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
	await send("Page.navigate", { url: origin });
}

async function evalJs(expression) {
	const res = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
	if (res.exceptionDetails) {
		return { __exc: (res.exceptionDetails.exception?.description || res.exceptionDetails.text || "").slice(0, 300) };
	}
	return res.result?.value;
}

/* Page-side helpers ------------------------------------------------------ */

const HELPERS = `
	window.__qa = {
		visible(el) {
			if (!el) return false;
			const s = getComputedStyle(el);
			if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
			const r = el.getBoundingClientRect();
			return r.width > 0 && r.height > 0 && r.top < innerHeight && r.bottom > 0;
		},
		box(el) {
			if (!el) return null;
			const r = el.getBoundingClientRect();
			return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom) };
		},
		click(el) {
			if (!el) return false;
			el.scrollIntoView({ block: "center", inline: "center" });
			const r = el.getBoundingClientRect();
			const opts = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
			for (const C of [PointerEvent, MouseEvent]) {
				for (const t of ["pointerdown", "pointerup", "mousedown", "mouseup"]) {
					try { el.dispatchEvent(new C(t, opts)); } catch {}
				}
			}
			try { el.dispatchEvent(new MouseEvent("click", opts)); } catch {}
			return true;
		},
		esc() {
			for (const el of [document.activeElement ?? document.body, document]) {
				try { el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true, cancelable: true })); } catch {}
			}
		},
		tapOutside() {
			const el = document.elementFromPoint(12, Math.max(80, Math.round(innerHeight * 0.18)));
			if (el) this.click(el.closest("button, [role=button]") ?? el);
		},
		menusOpen() {
			return [...document.querySelectorAll("[role=menu]")].some((el) => this.visible(el));
		},
		drawerState() {
			const frame = [...document.querySelectorAll("div")].find((d) => d.querySelector(':scope > [class*="_sidebarCol"]'));
			return frame ? (frame.hasAttribute("data-sidebar-collapsed") ? "collapsed" : "expanded") : null;
		},
		ensureDrawer(open) {
			const state = this.drawerState();
			const want = open ? "expanded" : "collapsed";
			if (state === want) return true;
			const t = document.querySelector('[class*="_sidebarCol"] [class*="_toggle"]');
			this.click(t);
			return true;
		},
		overflow() {
			const de = document.documentElement;
			const out = [];
			for (const el of document.querySelectorAll("body *")) {
				const r = el.getBoundingClientRect();
				if (r.width === 0 || r.height === 0) continue;
				if (r.right > window.innerWidth + 2 || r.left < -2) {
					const s = getComputedStyle(el);
					if (s.position === "fixed" || s.position === "absolute" || s.overflowX === "auto" || s.overflowX === "scroll") continue;
					out.push({ cls: String(el.className).slice(0, 50), w: Math.round(r.width), right: Math.round(r.right) });
					if (out.length >= 3) break;
				}
			}
			return { scrollWidth: de.scrollWidth, innerWidth: window.innerWidth, out };
		},
	};
`;

async function ready() {
	for (let i = 0; i < 80; i++) {
		const s = await evalJs(`({ len: document.body?.innerHTML.length ?? -1, shell: !!document.querySelector('[class*="_sidebarCol"]') })`);
		if (s && s.shell) return true;
		await sleep(500);
	}
	return false;
}

/* ---------- run --------------------------------------------------------- */

try {
	await boot();
	const booted = await ready();
	if (!booted) { report("shell renders at phone width", false, "no [class*=_sidebarCol] after 40s"); }
	else report("shell renders at phone width", true);

	await evalJs(HELPERS);
	await sleep(4000);
	// Dismiss any onboarding/consent dialog.
	await evalJs(`(() => {
		const b = [...document.querySelectorAll("button")].find((x) => /继续|确认|同意|了解|下一步|我知道了|开始使用/.test(x.textContent) && __qa.visible(x));
		if (b) __qa.click(b);
		return !!b;
	})()`);
	await sleep(1500);

	/* -- QA-01 load ----------------------------------------------------- */
	console.log("\n[01] load at 390px");

	const load = await evalJs(`(() => {
		const sheet = [...document.querySelectorAll("style")].some((s) => s.id === "dsh-tailscale-serve-mobile-fit");
		const meta = document.querySelector('meta[name="viewport"]')?.getAttribute("content") ?? "";
		const ov = __qa.overflow();
		const toggle = document.querySelector('[class*="_sidebarCol"] [class*="_toggle"]');
		return { sheet, meta, ...ov, toggleBox: __qa.box(toggle), toggleVisible: __qa.visible(toggle) };
	})()`);
	report("mobile-fit stylesheet mounted", load.sheet === true);
	report("keyboard-aware viewport applied", /interactive-widget=resizes-content/.test(load.meta), load.meta);
	report("no horizontal overflow", load.scrollWidth <= load.innerWidth + 2, `scrollWidth ${load.scrollWidth} / innerWidth ${load.innerWidth}${load.out.length ? " over: " + load.out.map((o) => o.cls).join(",") : ""}`);
	report("floating sidebar button visible", load.toggleVisible === true);
	report("floating sidebar button on screen", load.toggleBox && load.toggleBox.x >= 0 && load.toggleBox.x + load.toggleBox.w <= 390, JSON.stringify(load.toggleBox));

	/* -- QA-02 sidebar drawer ------------------------------------------- */
	console.log("\n[02] sidebar drawer");

	await evalJs(`(() => { const t = document.querySelector('[class*="_sidebarCol"] [class*="_toggle"]'); __qa.click(t); return true; })()`);
	await sleep(1500);
	const drawer = await evalJs(`(() => {
		const frame = [...document.querySelectorAll("div")].find((d) => d.querySelector(':scope > [class*="_sidebarCol"]'));
		const expanded = frame && !frame.hasAttribute("data-sidebar-collapsed");
		const sessions = [...document.querySelectorAll('[class*="_sidebarCol"] [role="treeitem"]')].filter((el) => __qa.visible(el) && (el.textContent ?? "").trim().length > 0).length;
		return { expanded, sessions, frame: !!frame };
	})()`);
	report("toggle opens the drawer", drawer.expanded === true);
	report("session list visible in drawer", drawer.sessions > 0, `${drawer.sessions} rows`);

	await evalJs(`(() => { const t = document.querySelector('[class*="_sidebarCol"] [class*="_toggle"]'); __qa.click(t); return true; })()`);
	await sleep(1200);
	const closed = await evalJs(`(() => {
		const frame = [...document.querySelectorAll("div")].find((d) => d.querySelector(':scope > [class*="_sidebarCol"]'));
		return frame ? frame.hasAttribute("data-sidebar-collapsed") : null;
	})()`);
	report("toggle closes the drawer again", closed === true);

	/* -- QA-03 hero pickers --------------------------------------------- */
	console.log("\n[03] hero (new conversation surface)");

	const hero = await evalJs(`(() => {
		const greeting = [...document.querySelectorAll("h1,h2,[class*=headlineText]")].find((el) => __qa.visible(el));
		const composer = document.querySelector("textarea, [contenteditable=true]");
		const modelTrigger = [...document.querySelectorAll("button")].find((el) => (el.getAttribute("aria-label") ?? "").startsWith("选择模型") && __qa.visible(el));
		const modeTrigger = [...document.querySelectorAll("button")].find((el) => __qa.visible(el) && /标准模式|极简模式|PTC|创造模式|Creative/.test(el.textContent ?? ""));
		return {
			greeting: greeting ? (greeting.textContent ?? "").trim().slice(0, 40) : null,
			composer: !!composer,
			modelText: modelTrigger ? (modelTrigger.textContent ?? "").trim().slice(0, 40) : null,
			modeText: modeTrigger ? (modeTrigger.textContent ?? "").trim().slice(0, 40) : null,
		};
	})()`);
	report("greeting visible", !!hero.greeting, hero.greeting ?? "none");
	report("composer input present", hero.composer === true);
	report("model picker label visible", !!hero.modelText, hero.modelText ?? "none");
	report("mode/preset picker visible on hero", !!hero.modeText, hero.modeText ?? "none");

	// Model picker: open, list, dismiss (Escape, then tap-outside as the
	// touch-screen fallback).
	const modelMenu = await evalJs(`(async () => {
		const trigger = [...document.querySelectorAll("button")].find((el) => (el.getAttribute("aria-label") ?? "").startsWith("选择模型") && __qa.visible(el));
		if (!trigger) return { err: "no model trigger" };
		__qa.click(trigger);
		await new Promise((r) => setTimeout(r, 1200));
		const menus = [...document.querySelectorAll("[role=menu]")].filter((el) => __qa.visible(el));
		const items = menus.length ? [...menus[0].querySelectorAll("[role=menuitem],[role=option],button")].filter((el) => __qa.visible(el)).map((el) => (el.textContent ?? "").trim().slice(0, 30)) : [];
		const inVp = menus.length ? __qa.box(menus[0]).bottom <= innerHeight : null;
		__qa.esc();
		await new Promise((r) => setTimeout(r, 800));
		let closed = !__qa.menusOpen();
		if (!closed) { __qa.tapOutside(); await new Promise((r) => setTimeout(r, 800)); closed = !__qa.menusOpen(); }
		return { opened: menus.length > 0, items, inVp, closed, dismissedHow: closed ? (items.length ? "esc/tap" : "") : "still open" };
	})()`);
	report("model picker opens a menu", modelMenu.opened === true, `${modelMenu.items?.length ?? 0} item(s)`);
	report("model menu shows the picker structure", (modelMenu.items?.length ?? 0) >= 1, (modelMenu.items ?? []).slice(0, 4).join(", "));
	report("model menu fits the viewport", modelMenu.inVp === true);
	report("model menu dismisses", modelMenu.closed === true, modelMenu.dismissedHow ?? "");

	// Mode picker (new-session preset): open and dismiss.
	const modeMenu = await evalJs(`(async () => {
		const trigger = [...document.querySelectorAll("button")].find((el) => __qa.visible(el) && /标准模式|极简模式|PTC|创造模式|Creative/.test(el.textContent ?? ""));
		if (!trigger) return { err: "no mode trigger" };
		__qa.click(trigger);
		await new Promise((r) => setTimeout(r, 1200));
		const menus = [...document.querySelectorAll("[role=menu]")].filter((el) => __qa.visible(el));
		const items = menus.length ? [...menus[0].querySelectorAll("[role=menuitem],[role=option],button")].filter((el) => __qa.visible(el)).map((el) => (el.textContent ?? "").trim().slice(0, 30)) : [];
		const inVp = menus.length ? __qa.box(menus[0]).bottom <= innerHeight : null;
		__qa.esc();
		await new Promise((r) => setTimeout(r, 800));
		let closed = !__qa.menusOpen();
		if (!closed) { __qa.tapOutside(); await new Promise((r) => setTimeout(r, 800)); closed = !__qa.menusOpen(); }
		return { opened: menus.length > 0, items, inVp, closed };
	})()`);
	report("mode picker opens a menu", modeMenu.opened === true, `${modeMenu.items?.length ?? 0} items: ${(modeMenu.items ?? []).slice(0, 4).join(", ")}`);
	report("mode menu fits the viewport", modeMenu.inVp === true);
	report("mode menu dismisses", modeMenu.closed === true);

	/* -- QA-04 workspace directory picker -------------------------------- */
	console.log("\n[04] workspace directory picker");

	const picker = await evalJs(`(async () => {
		__qa.ensureDrawer(false);
		await new Promise((r) => setTimeout(r, 800));
		const entry = [...document.querySelectorAll("button,[role=button]")].find((b) => (b.getAttribute("aria-label") ?? "").includes("选择工作区") && __qa.visible(b));
		if (!entry) return { err: "no picker entry" };
		__qa.click(entry);
		await new Promise((r) => setTimeout(r, 1500));
		// The workspace row opens a switcher menu; "添加工作区…" opens the picker.
		const add = [...document.querySelectorAll("[role=menu] button")].find((b) => __qa.visible(b) && /添加工作区|Add workspace/i.test(b.textContent ?? ""));
		if (!add) return { err: "no add-workspace item in the switcher menu" };
		__qa.click(add);
		await new Promise((r) => setTimeout(r, 2500));
		const dialog = document.querySelector(".dsh-ts-picker-dialog");
		if (!dialog) return { err: "picker dialog did not open" };
		const drives = [...dialog.querySelectorAll(".dsh-ts-picker-drive")].filter((b) => __qa.visible(b)).map((b) => (b.querySelector(".dsh-ts-picker-name")?.textContent ?? "").trim());
		const footer = dialog.querySelector(".dsh-ts-picker-footer");
		const body = dialog.querySelector(".dsh-ts-picker-body");
		const footerBox = footer ? __qa.box(footer) : null;
		const bodyBox = body ? __qa.box(body) : null;
		return { drives, dialogBox: __qa.box(dialog), footerBelowBody: footerBox && bodyBox ? footerBox.y >= bodyBox.y + bodyBox.h - 2 : null };
	})()`);
	if (picker?.err) { warn("directory picker", picker.err); }
	else {
		report("picker dialog opens", true, `dialog ${picker.dialogBox.w}x${picker.dialogBox.h}`);
		report("drive roots listed", (picker.drives ?? []).length >= 1, (picker.drives ?? []).join(", "));
		report("footer sits at the dialog bottom", picker.footerBelowBody === true);
	}

	const folders = await evalJs(`(async () => {
		const dialog = document.querySelector(".dsh-ts-picker-dialog");
		if (!dialog) return { err: "no dialog" };
		const drive = [...dialog.querySelectorAll(".dsh-ts-picker-drive")].find((b) => __qa.visible(b));
		if (!drive) return { err: "no drive" };
		__qa.click(drive);
		await new Promise((r) => setTimeout(r, 2500));
		const folderBtns = [...dialog.querySelectorAll(".dsh-ts-picker-folder")].filter((b) => __qa.visible(b));
		const crumbs = [...dialog.querySelectorAll(".dsh-ts-picker-path-button")].map((b) => (b.textContent ?? "").trim());
		return { folders: folderBtns.length, names: folderBtns.slice(0, 3).map((b) => (b.textContent ?? "").trim()), crumbs };
	})()`);
	if (folders?.err) { warn("folder list", folders.err); }
	else {
		report("drive opens to folder list", (folders.folders ?? 0) > 0, `${folders.folders} folders: ${(folders.names ?? []).join(", ")}`);
		report("breadcrumb shows entered drive", (folders.crumbs ?? []).some((c) => /^[A-Z]:/.test(c)), (folders.crumbs ?? []).join(" > "));
	}

	const entered = await evalJs(`(async () => {
		const dialog = document.querySelector(".dsh-ts-picker-dialog");
		const folder = dialog?.querySelector(".dsh-ts-picker-folder");
		if (!folder) return { err: "no folder to enter" };
		__qa.click(folder);
		await new Promise((r) => setTimeout(r, 2500));
		const crumbs = [...(dialog?.querySelectorAll(".dsh-ts-picker-path-button") ?? [])].map((b) => (b.textContent ?? "").trim());
		const cancel = [...(dialog?.querySelectorAll("button") ?? [])].find((b) => (b.textContent ?? "").trim() === "取消");
		if (cancel) __qa.click(cancel);
		await new Promise((r) => setTimeout(r, 1200));
		return { crumbs, closed: !document.querySelector(".dsh-ts-picker-dialog") };
	})()`);
	if (entered?.err) warn("enter folder / cancel", entered.err);
	else {
		report("entering a folder updates the breadcrumb", (entered.crumbs ?? []).length >= 2, (entered.crumbs ?? []).join(" > "));
		report("取消 closes the picker without side effects", entered.closed === true);
	}

	/* -- QA-05 composer -------------------------------------------------- */
	console.log("\n[05] composer send");

	const typed = await evalJs(`(async () => {
		const textarea = document.querySelector("textarea");
		if (!textarea) return { err: "no textarea" };
		textarea.focus();
		const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
		setter.call(textarea, "测试消息，验证手机端发送链路");
		textarea.dispatchEvent(new Event("input", { bubbles: true }));
		await new Promise((r) => setTimeout(r, 1000));
		const sendBtn = [...document.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") ?? "") === "发送消息");
		const enabled = sendBtn && sendBtn.disabled === false;
		const box = __qa.box(sendBtn);
		if (sendBtn) __qa.click(sendBtn);
		return { found: !!sendBtn, enabled, box };
	})()`);
	if (typed?.err) { report("composer typing", false, typed.err); }
	else {
		report("typing enables the send button", typed.enabled === true, typed.enabled ? "" : "send stayed disabled");
		report("send button visible in the composer row", !!typed.box && typed.box.y > 300 && typed.box.y < 900, JSON.stringify(typed.box));
	}
	let sent = false;
	for (let i = 0; i < 20; i++) {
		await sleep(500);
		sent = await evalJs(`(() => [...document.querySelectorAll("[class*=message], [class*=bubble], [class*=contentText]")].some((el) => __qa.visible(el) && (el.textContent ?? "").includes("测试消息")))()`);
		if (sent) break;
	}
	report("user message renders after send", sent === true);

	// The action row lives beside the bubble, inside the flow item: timing +
	// copy/branch buttons. The sheet hides timings, like/dislike and the note
	// button; copy and branch stay.
	const actionRow = await evalJs(`(() => {
		const msg = [...document.querySelectorAll("[class*=message], [class*=bubble], [class*=contentText]")].find((el) => __qa.visible(el) && (el.textContent ?? "").includes("测试消息"));
		if (!msg) return { err: "message gone" };
		let item = msg;
		for (let i = 0; i < 5 && item; i++) item = item.parentElement;
		const actions = item ? [...item.querySelectorAll("[class*=_actions]")].filter((el) => __qa.visible(el)) : [];
		const copy = [...(item?.querySelectorAll("button") ?? [])].find((b) => __qa.visible(b) && /copy|复制/i.test(b.getAttribute("aria-label") ?? ""));
		const likes = [...(item?.querySelectorAll("[aria-pressed]") ?? [])].filter((el) => __qa.visible(el));
		return { actions: actions.length, copyVisible: __qa.visible(copy), likesVisible: likes.length };
	})()`);
	if (actionRow?.err) warn("message action row", actionRow.err);
	else {
		report("message action row visible", actionRow.actions > 0, `${actionRow.actions} action row(s)`);
		report("copy button visible", actionRow.copyVisible === true);
		report("like/dislike hidden on phone", actionRow.likesVisible === 0, actionRow.likesVisible ? `${actionRow.likesVisible} visible` : "as designed");
	}

	let replied = false;
	for (let i = 0; i < 40; i++) {
		await sleep(1500);
		replied = await evalJs(`(() => {
			const msgs = [...document.querySelectorAll("[class*=message], [class*=bubble], [class*=contentText]")].filter((el) => __qa.visible(el));
			const done = [...document.querySelectorAll('[class*="_root"]:has(> [class*="_sep"])')].some((el) => __qa.visible(el) && /轮|步/.test(el.textContent ?? ""));
			return msgs.length >= 2 || done;
		})()`);
		if (replied) break;
	}
	if (!replied) warn("assistant reply", "no reply within 60s — LLM latency, not a layout concern");
	else info("assistant reply rendered");

	/* -- QA-06 header on a completed session ----------------------------- */
	console.log("\n[06] conversation header (completed session)");

	await evalJs(`(() => { const t = document.querySelector('[class*="_sidebarCol"] [class*="_toggle"]'); __qa.click(t); return true; })()`);
	await sleep(1500);
	await evalJs(`(() => __qa.ensureDrawer(true))()`);
	await sleep(1500);
	const picked = await evalJs(`(async () => {
		const rows = [...document.querySelectorAll('[class*="_sidebarCol"] [role="treeitem"]')].filter((el) => __qa.visible(el) && /_sessionRow/.test(el.className) && !/新会话|New session/.test(el.textContent ?? "") && /详细查看这个项目/.test(el.textContent ?? ""));
		const row = rows[0] ?? [...document.querySelectorAll('[class*="_sidebarCol"] [role="treeitem"]')].find((el) => __qa.visible(el) && /_sessionRow/.test(el.className) && !/新会话|New session/.test(el.textContent ?? ""));
		if (!row) return { err: "no session rows" };
		__qa.click(row);
		await new Promise((r) => setTimeout(r, 2500));
		const header = document.querySelector('[class*="_header"]:has([class*="_crumbs"])');
		if (!header) return { err: "no chat header", picked: (row.textContent ?? "").trim().slice(0, 30) };
		const label = [...header.querySelectorAll('[class*="_label"]')].find((el) => __qa.visible(el) && /模式|PTC|Creative/.test(el.textContent ?? ""));
		const tabs = [...header.querySelectorAll("[role=tab]")].filter((el) => __qa.visible(el)).map((el) => (el.textContent ?? "").trim());
		const labelBox = label ? __qa.box(label) : null;
		return {
			crumb: (header.querySelector('[class*="_crumbCurrent"], [class*="_crumbSeg"]:last-child')?.textContent ?? "").trim().slice(0, 30),
			label: label ? (label.textContent ?? "").trim() : null,
			labelBox,
			labelScroll: label ? label.scrollWidth : 0,
			tabs,
		};
	})()`);
	if (picked?.err) { warn("open a session", picked.err); }
	else {
		report("session opened, header present", true, `crumb: ${picked.crumb}`);
		report("header tabs present", (picked.tabs ?? []).includes("对话") || (picked.tabs ?? []).length >= 2, (picked.tabs ?? []).join(", "));
		report("preset badge visible", !!picked.label, picked.label ?? "none");
		if (picked.label) {
			const clipped = picked.labelScroll > picked.labelBox.w + 1;
			report("preset badge NOT clipped", !clipped, `box ${picked.labelBox.w}px / content ${picked.labelScroll}px`);
		}
	}

	// Session stats line (only exists once a turn completed). The sheet's rule
	// targets exactly the element that both carries _root and has a direct
	// _sep child, so query that shape and read its overflow.
	const stats = await evalJs(`(() => {
		const el = document.querySelector('[class*="_root"]:has(> [class*="_sep"])');
		if (!el) return null;
		const s = getComputedStyle(el);
		const r = el.getBoundingClientRect();
		return { text: (el.textContent ?? "").trim().slice(0, 70), overflowX: s.overflowX, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, y: Math.round(r.y), inVp: r.bottom <= innerHeight };
	})()`);
	if (!stats) warn("session stats line", "not found on this session");
	else {
		report("session stats line present", true, stats.text);
		report("stats line scrollable, not clipped", /auto|scroll/.test(stats.overflowX), `overflow-x: ${stats.overflowX} (scrollWidth ${stats.scrollWidth} / ${stats.clientWidth})`);
		report("stats line visible in viewport", stats.inVp === true);
	}

	// Trajectory tab.
	const trajectory = await evalJs(`(async () => {
		const tab = [...document.querySelectorAll('[class*="_header"]:has([class*="_crumbs"]) [role="tab"]')].find((el) => (el.textContent ?? "").trim() === "轨迹" || (el.textContent ?? "").trim() === "Trajectory");
		if (!tab) return { err: "no trajectory tab" };
		__qa.click(tab);
		await new Promise((r) => setTimeout(r, 2000));
		const pane = document.querySelector("[class*=_tablePane]");
		const rows = pane ? [...pane.querySelectorAll("[role=row], [class*=_eventInner]")].filter((el) => __qa.visible(el)) : [];
		return { pane: !!pane, rows: rows.length };
	})()`);
	if (trajectory?.err) warn("trajectory view", trajectory.err);
	else {
		report("trajectory table renders", trajectory.pane === true && trajectory.rows > 0, `${trajectory.rows} rows`);
	}

	// Details panel from a trajectory row.
	const details = await evalJs(`(async () => {
		const pane = document.querySelector("[class*=_tablePane]");
		const row = pane?.querySelector("[role=row], [class*=_eventInner]");
		if (!row) return { err: "no trajectory row" };
		__qa.click(row);
		await new Promise((r) => setTimeout(r, 2000));
		const split = document.querySelector("[class*=_split]");
		const detailsEl = split ? split.querySelector(':scope > [class*="_details"]') : null;
		if (!detailsEl) return { err: "no details panel" };
		const b = __qa.box(detailsEl);
		const close = detailsEl.querySelector("button[aria-label*=close i], button[aria-label*=关闭]");
		return { w: b.w, splitW: split ? Math.round(split.getBoundingClientRect().width) : 0, closeBtn: !!close, hasContent: (detailsEl.textContent ?? "").trim().length > 40 };
	})()`);
	if (details?.err) warn("trajectory details panel", details.err);
	else {
		report("details panel opens at full width", details.w >= details.splitW - 4, `${details.w}px of ${details.splitW}px`);
		report("details panel has content + close button", details.hasContent === true && details.closeBtn === true);
	}
	// Back to the conversation: close the details panel and the drawer.
	await evalJs(`(async () => {
		const split = document.querySelector("[class*=_split]");
		const close = split?.querySelector(":scope > [class*=_details] button[aria-label*=close i], :scope > [class*=_details] button[aria-label*=关闭]");
		if (close) __qa.click(close);
		await new Promise((r) => setTimeout(r, 1000));
		__qa.ensureDrawer(false);
		return true;
	})()`);
	await sleep(1000);

	/* -- QA-07 settings -------------------------------------------------- */
	console.log("\n[07] settings dialog");

	await evalJs(`(() => __qa.ensureDrawer(true))()`);
	await sleep(1500);
	const settings = await evalJs(`(async () => {
		const btn = [...document.querySelectorAll("button,[role=button]")].find((b) => (/设置|Settings/.test(b.getAttribute("aria-label") ?? "") || /设置/.test((b.textContent ?? "").trim())) && __qa.visible(b));
		if (!btn) return { err: "no settings button" };
		__qa.click(btn);
		await new Promise((r) => setTimeout(r, 2500));
		const panel = document.querySelector("[class*=_panel]:has([class*=_navList])");
		if (!panel) return { err: "settings panel not open" };
		const navCells = [...panel.querySelectorAll("[class*=_navCell]")].filter((el) => __qa.visible(el)).map((el) => (el.textContent ?? "").trim().slice(0, 20));
		const navScroll = panel.querySelector("[class*=_nav]");
		const sel = panel.querySelector('button[class*="_selector"]');
		const scrollable = panel.querySelector("[class*=_options]");
		const cubes = panel.querySelectorAll("[class*=_themeCube]").length;
		return { navCells, navScrollable: navScroll ? /auto|scroll/.test(getComputedStyle(navScroll).overflowX) : false, selectorText: sel ? (sel.textContent ?? "").trim().slice(0, 20) : null, selectorDisabled: sel?.disabled === true, cubes, optionsScrollable: scrollable ? /auto|scroll/.test(getComputedStyle(scrollable).overflowY) : false };
	})()`);
	if (settings?.err) { warn("settings", settings.err); }
	else {
		report("settings dialog opens", true, `${settings.navCells.length} nav sections`);
		report("section nav scrolls horizontally", settings.navScrollable === true);
		report("Agent-preset selector ENABLED on phone", settings.selectorDisabled === false, `text: ${settings.selectorText ?? "none"}`);
		report("theme cubes render", settings.cubes >= 2, `${settings.cubes} cubes`);
		report("options area scrolls", settings.optionsScrollable === true);
	}

	// Agent-preset selector: open menu (no selection).
	const presetMenu = await evalJs(`(async () => {
		const panel = document.querySelector("[class*=_panel]:has([class*=_navList])");
		const sel = panel?.querySelector('button[class*="_selector"]');
		if (!sel) return { err: "selector gone" };
		sel.scrollIntoView({ block: "center" });
		await new Promise((r) => setTimeout(r, 600));
		__qa.click(sel);
		await new Promise((r) => setTimeout(r, 1200));
		const menus = [...document.querySelectorAll("[role=menu]")].filter((el) => __qa.visible(el));
		const items = menus.length ? [...menus[0].querySelectorAll("[role=menuitem],[role=option],button")].filter((el) => __qa.visible(el)).map((el) => (el.textContent ?? "").trim().slice(0, 24)) : [];
		const inVp = menus.length ? __qa.box(menus[0]).bottom <= innerHeight : null;
		return { opened: menus.length > 0, expanded: sel.getAttribute("aria-expanded"), items, inVp };
	})()`);
	if (presetMenu?.err) warn("preset selector menu", presetMenu.err);
	else {
		report("preset selector opens menu", presetMenu.opened === true, `aria-expanded=${presetMenu.expanded}`);
		report("preset menu lists options", (presetMenu.items?.length ?? 0) >= 2, (presetMenu.items ?? []).slice(0, 5).join(", "));
		report("preset menu fully in viewport", presetMenu.inVp === true);
	}
	await evalJs(`(() => { const p = document.querySelector("[class*=_panel]:has([class*=_navList])"); const close = p?.querySelector("button[aria-label*=close i], button[aria-label*=关闭]"); if (close) __qa.click(close); return true; })()`);
	await sleep(1200);

	/* -- QA-08 marquee --------------------------------------------------- */
	console.log("\n[08] marquee");

	const marquee = await evalJs(`(() => {
		const labels = [...document.querySelectorAll('[class*="_triggerLabel"], [class*="_crumbCurrent"]')].filter((el) => __qa.visible(el));
		const marked = labels.filter((el) => el.hasAttribute("data-dsh-marquee"));
		const clipped = labels.filter((el) => el.scrollWidth > el.clientWidth + 1);
		return {
			total: labels.length,
			marked: marked.length,
			clippedButUnmarked: clipped.filter((el) => !el.hasAttribute("data-dsh-marquee")).length,
			examples: labels.slice(0, 4).map((el) => ({ txt: (el.textContent ?? "").trim().slice(0, 24), marked: el.hasAttribute("data-dsh-marquee"), sw: el.scrollWidth, cw: el.clientWidth })),
		};
	})()`);
	if (marquee.total === 0) warn("marquee", "no trigger labels on screen");
	else {
		report("every clipped label is marked for ticker", marquee.clippedButUnmarked === 0, `${marquee.marked}/${marquee.total} marked, ${marquee.clippedButUnmarked} clipped-but-unmarked`);
	}

	/* -- QA-09 narrow widths ---------------------------------------------- */
	console.log("\n[09] narrow widths (360 / 320)");

	for (const w of [360, 320]) {
		await send("Emulation.setDeviceMetricsOverride", { width: w, height: 700, deviceScaleFactor: 2, mobile: true });
		await sleep(2500);
		const m = await evalJs(`(() => {
			const ov = __qa.overflow();
			const sheet = [...document.querySelectorAll("style")].some((s) => s.id === "dsh-tailscale-serve-mobile-fit");
			const toggle = document.querySelector('[class*="_sidebarCol"] [class*="_toggle"]');
			return { ...ov, sheet, toggleVisible: __qa.visible(toggle), toggleBox: __qa.box(toggle) };
		})()`);
		report(`${w}px: no horizontal overflow`, m.scrollWidth <= m.innerWidth + 2, `scrollWidth ${m.scrollWidth} / ${m.innerWidth}`);
		report(`${w}px: stylesheet active`, m.sheet === true);
		report(`${w}px: floating button on screen`, m.toggleVisible === true && m.toggleBox && m.toggleBox.x >= 0 && m.toggleBox.x + m.toggleBox.w <= w);
	}
	await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
	await sleep(1500);

	/* -- QA-10 console errors -------------------------------------------- */
	console.log("\n[10] console");

	const realErrors = consoleErrors.filter((e) => !/favicon/i.test(e) && !/net::ERR_CERT/i.test(e));
	report("no uncaught page errors", realErrors.length === 0, realErrors.length ? realErrors.slice(0, 3).join(" | ") : "clean");
} catch (error) {
	failures += 1;
	console.log(`\n  FAIL  harness: ${error.message}`);
} finally {
	try { ws?.close(); } catch {}
	child.kill();
	await sleep(300);
	try { rmSync(profile, { recursive: true, force: true }); } catch {}
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${checks} checks, ${failures} failure(s), ${warnings} warning(s)\n`);
process.exit(failures === 0 ? 0 : 1);
