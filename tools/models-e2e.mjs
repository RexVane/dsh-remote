/**
 * E2E regression for the phone's model-config save path.
 *
 * Opens 设置 → 模型 on the tailnet URL at phone width, edits the DeepSeek
 * provider's first model display name, saves, verifies the write persisted on
 * the server through the proxied `settings.mutate`, then reverts and
 * re-verifies. Fails loudly if the save hits DSH's loopback 403 (the
 * transport-failure bug this guards against).
 *
 * Requires the DSH web server to be running with this plugin active.
 * Usage: node tools/models-e2e.mjs [origin]
 */

import { spawn, execFileSync } from "node:child_process";
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
];
const binary = BROWSERS.find((b) => b && existsSync(b));
if (!binary) { console.log("FAIL — no Chrome or Edge found"); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "dsh-modelse2e-"));
const child = spawn(binary, [
	"--headless=new", "--disable-gpu", "--no-sandbox", "--no-proxy-server",
	"--user-data-dir=" + profile, "--window-size=390,844",
	"--remote-debugging-port=0", "about:blank",
], { stdio: ["ignore", "pipe", "pipe"] });
let port = null;
child.stderr.on("data", (d) => {
	const m = d.toString().match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/);
	if (m) port = m[1];
});
let ws = null, id = 0;
const pending = new Map();
const consoleErrors = [];
const send = (method, params = {}) => new Promise((resolve, reject) => {
	const i = ++id;
	pending.set(i, { resolve, reject, method });
	ws.send(JSON.stringify({ id: i, method, params }));
});
const evalJs = async (expression) => {
	const res = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
	if (res.exceptionDetails) return { __exc: (res.exceptionDetails.exception?.description || res.exceptionDetails.text || "").slice(0, 300) };
	return res.result.value;
};
async function boot() {
	for (let i = 0; i < 100 && !port; i++) await sleep(100);
	if (!port) throw new Error("no debug port");
	const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
	const page = targets.find((t) => t.type === "page");
	ws = new WebSocket(page.webSocketDebuggerUrl);
	await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
	ws.onmessage = (e) => {
		const msg = JSON.parse(e.data);
		if (msg.id && pending.has(msg.id)) {
			const slot = pending.get(msg.id);
			pending.delete(msg.id);
			msg.error ? slot.reject(new Error(`${slot.method}: ${msg.error.message}`)) : slot.resolve(msg.result);
		}
		if (msg.method === "Runtime.exceptionThrown") consoleErrors.push((msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text || "").slice(0, 300));
		if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 300));
	};
	await send("Runtime.enable");
	await send("Page.enable");
	await send("Security.enable");
	await send("Security.setIgnoreCertificateErrors", { ignore: true });
	await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
	await send("Page.navigate", { url: origin });
	await sleep(6000);
}

let checks = 0, failures = 0;
const report = (name, ok, detail = "") => {
	checks += 1;
	if (ok) console.log(`  ok    ${name}${detail ? ` — ${detail}` : ""}`);
	else { failures += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
};
const NEW_NAME = "DeepSeek-V4-Flash-TEST";
const ORIG_NAME = "DeepSeek-V4-Flash";

await boot();
await evalJs(`window.__mp = {
	visible: (el) => { if (!el) return false; const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; },
	click: (el) => { el.scrollIntoView({ block: "center" }); el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window })); },
	setValue: (input, value) => {
		const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
		Object.getOwnPropertyDescriptor(proto, "value").set.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
		input.dispatchEvent(new Event("change", { bubbles: true }));
	},
}; true;`);

console.log("\n[1] open settings → 模型, edit DeepSeek, save");
const opened = await evalJs(`(async () => {
	const state = (() => { const frame = [...document.querySelectorAll("div")].find((d) => d.querySelector(':scope > [class*="_sidebarCol"]')); return frame ? (frame.hasAttribute("data-sidebar-collapsed") ? "collapsed" : "expanded") : null; })();
	if (state !== "expanded") { const t = document.querySelector('[class*="_sidebarCol"] [class*="_toggle"]'); if (t) { __mp.click(t); await new Promise((r) => setTimeout(r, 1500)); } }
	const btn = [...document.querySelectorAll("button,[role=button]")].find((b) => (/设置|Settings/.test(b.getAttribute("aria-label") ?? "") || /设置/.test((b.textContent ?? "").trim())) && __mp.visible(b));
	if (!btn) return { err: "no settings button" };
	__mp.click(btn);
	await new Promise((r) => setTimeout(r, 2500));
	const panel = document.querySelector("[class*=_panel]:has([class*=_navList])");
	const cell = [...(panel?.querySelectorAll("[class*=_navCell]") ?? [])].find((el) => /模型/.test(el.textContent ?? "") && __mp.visible(el));
	if (!cell) return { err: "no models nav cell" };
	__mp.click(cell);
	await new Promise((r) => setTimeout(r, 3000));
	const rows = [...(panel?.querySelectorAll("[class*=_rowCard]") ?? [])].filter((el) => __mp.visible(el));
	const row = rows.find((el) => /DeepSeek/.test(el.textContent ?? ""));
	if (!row) return { err: "no DeepSeek row" };
	const editBtn = [...row.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === "编辑");
	if (!editBtn) return { err: "no edit button" };
	__mp.click(editBtn);
	await new Promise((r) => setTimeout(r, 2000));
	return { ok: true };
})()`);
report("models editor opens for DeepSeek", opened?.ok === true, opened?.err ?? "");

const saved = await evalJs(`(async () => {
	const panel = document.querySelector("[class*=_panel]:has([class*=_navList])");
	const name1 = panel?.querySelector('input[aria-label="显示名称 1"]');
	if (!name1) return { err: "display name input not found", inputs: [...(panel?.querySelectorAll("input") ?? [])].map((i) => i.getAttribute("aria-label")) };
	const before = name1.value;
	__mp.setValue(name1, ${JSON.stringify(NEW_NAME)});
	await new Promise((r) => setTimeout(r, 500));
	const saveBtn = [...(panel?.querySelectorAll("button") ?? [])].find((b) => (b.textContent ?? "").trim() === "保存" && __mp.visible(b));
	if (!saveBtn) return { err: "save button not found" };
	__mp.click(saveBtn);
	await new Promise((r) => setTimeout(r, 4000));
	const name1After = panel?.querySelector('input[aria-label="显示名称 1"]')?.value ?? null;
	return { before, after: name1After };
})()`);
report("display name field edited", saved?.err === undefined, `before=${saved?.before} → input=${NEW_NAME}`);
if (saved?.err) console.log("        detail:", JSON.stringify(saved));
const saveErr = consoleErrors.filter((e) => /transport failure|403|forbidden/i.test(e));
report("NO transport failure / 403 in console after save", saveErr.length === 0, saveErr.length ? saveErr[0] : "clean");
const reopened = await evalJs(`(async () => {
	const panel = document.querySelector("[class*=_panel]:has([class*=_navList])");
	const rows = [...(panel?.querySelectorAll("[class*=_rowCard]") ?? [])].filter((el) => __mp.visible(el));
	const row = rows.find((el) => /DeepSeek/.test(el.textContent ?? ""));
	if (!row) return { err: "DeepSeek row gone" };
	const editBtn = [...row.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === "编辑");
	if (!editBtn) return { err: "edit button gone" };
	__mp.click(editBtn);
	await new Promise((r) => setTimeout(r, 2000));
	const name1 = panel?.querySelector('input[aria-label="显示名称 1"]')?.value ?? null;
	return { name1 };
})()`);
report("editor reloads the saved value", reopened?.name1 === NEW_NAME, `after save, editor shows: ${reopened?.name1 ?? reopened?.err}`);

console.log("\n[2] verify persistence via server (tailnet path)");
const verify = () => {
	const body = JSON.stringify({ type: "client-request", rpcId: "v1", method: "settingsDescribe", payload: {} });
	const out = execFileSync("curl", ["-s", "--noproxy", "*", "-X", "POST", origin.replace(/\/$/, "") + "/tailscale-serve/settingsDescribe", "-H", "content-type: application/json", "-d", body], { encoding: "utf8" });
	const j = JSON.parse(out);
	const ns = (j.result?.value?.namespaces ?? []).find((n) => n.ns === "llm-deepseek");
	return ns?.value?.models?.[0]?.name ?? null;
};
const persistedNew = await verify();
report("server persisted the new name", persistedNew === NEW_NAME, `server reads: ${persistedNew}`);

console.log("\n[3] revert to original name and re-verify");
const reverted = await evalJs(`(async () => {
	const panel = document.querySelector("[class*=_panel]:has([class*=_navList])");
	const name1 = panel?.querySelector('input[aria-label="显示名称 1"]');
	if (!name1) return { err: "editor not open (was it closed?)" };
	__mp.setValue(name1, ${JSON.stringify(ORIG_NAME)});
	await new Promise((r) => setTimeout(r, 500));
	const saveBtn = [...(panel?.querySelectorAll("button") ?? [])].find((b) => (b.textContent ?? "").trim() === "保存" && __mp.visible(b));
	if (!saveBtn) return { err: "save button gone" };
	__mp.click(saveBtn);
	await new Promise((r) => setTimeout(r, 4000));
	return { ok: true };
})()`);
report("revert save fired", reverted?.ok === true, reverted?.err ?? "");
const revertErr = consoleErrors.filter((e) => /transport failure|403|forbidden/i.test(e));
report("NO transport failure / 403 after revert save", revertErr.length === 0, revertErr.length ? revertErr[0] : "clean");
const persistedBack = await verify();
report("server restored original name", persistedBack === ORIG_NAME, `server reads: ${persistedBack}`);
const finalCheck = await evalJs(`(async () => {
	const panel = document.querySelector("[class*=_panel]:has([class*=_navList])");
	const name1 = panel?.querySelector('input[aria-label="显示名称 1"]')?.value ?? null;
	if (name1 !== null) return { name1 };
	const rows = [...(panel?.querySelectorAll("[class*=_rowCard]") ?? [])].filter((el) => __mp.visible(el));
	const row = rows.find((el) => /DeepSeek/.test(el.textContent ?? ""));
	if (!row) return { err: "DeepSeek row gone" };
	const editBtn = [...row.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === "编辑");
	if (!editBtn) return { err: "edit button gone" };
	__mp.click(editBtn);
	await new Promise((r) => setTimeout(r, 2000));
	return { name1: panel?.querySelector('input[aria-label="显示名称 1"]')?.value ?? null };
})()`);
report("editor shows original name after revert", finalCheck?.name1 === ORIG_NAME, `editor shows: ${finalCheck?.name1 ?? finalCheck?.err}`);

console.log(`\nRESULT: ${failures === 0 ? "PASS" : "FAIL"} — ${checks - failures}/${checks} checks, ${consoleErrors.length} console errors total`);
if (consoleErrors.length > 0) console.log("console errors:", JSON.stringify(consoleErrors.slice(0, 5)));
child.kill();
try { rmSync(profile, { recursive: true, force: true, maxRetries: 3 }); } catch { /* profile lock on Windows is fine */ }
