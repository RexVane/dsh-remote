"use strict";

const { spawnSync } = require("node:child_process");
const http = require("node:http");
const { join } = require("node:path");

const DEFAULT_WINDOWS_PIPE = "\\\\.\\pipe\\ProtectedPrefix\\Administrators\\Tailscale\\tailscaled";
const WINDOWS_TRANSPORT_HELPER = join(__dirname, "tailscale-localapi-windows.ps1");
const WINDOWS_POWERSHELL = process.env.SystemRoot
	? join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
	: "powershell.exe";
const DEFAULT_UNIX_SOCKETS = [
	"/var/run/tailscaled.socket", // macOS standalone tailscaled
	"/var/run/tailscale/tailscaled.sock",
	"/run/tailscale/tailscaled.sock",
];

function readInput() {
	return new Promise((resolve, reject) => {
		let source = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk) => { source += chunk; });
		process.stdin.on("end", () => {
			try {
				resolve(JSON.parse(source || "{}"));
			} catch (error) {
				reject(new Error(`invalid helper input: ${error.message}`));
			}
		});
		process.stdin.on("error", reject);
	});
}

function requestBody(input) {
	return input.method === "POST" ? JSON.stringify(input.config ?? {}) : "";
}

function responseFromBody(status, headers, responseBody, input) {
	let config = null;
	if (input.method === "GET" && status === 200) {
		try {
			const parsed = JSON.parse(responseBody || "{}");
			config = parsed && typeof parsed === "object" ? parsed : {};
		} catch (error) {
			return { ok: false, status, body: responseBody, error: `invalid JSON: ${error.message}` };
		}
	}
	return {
		ok: status === 200,
		status,
		etag: headers.etag ?? "",
		config,
		body: responseBody.trim(),
	};
}

function requestUnix(socketPath, input) {
	return new Promise((resolve) => {
		const body = requestBody(input);
		const headers = {
			Host: "local-tailscaled.sock",
			Accept: "application/json",
		};
		if (body) {
			headers["Content-Type"] = "application/json";
			headers["Content-Length"] = Buffer.byteLength(body);
		}
		if (input.etag) headers["If-Match"] = input.etag;

		const req = http.request({
			method: input.method,
			path: "/localapi/v0/serve-config",
			socketPath,
			headers,
		}, (res) => {
			let responseBody = "";
			res.setEncoding("utf8");
			res.on("data", (chunk) => { responseBody += chunk; });
			res.on("end", () => {
				resolve(responseFromBody(res.statusCode, res.headers, responseBody, input));
			});
		});
		req.setTimeout(Number(input.timeoutMs) || 10_000, () => {
			req.destroy(new Error("Tailscale LocalAPI request timed out"));
		});
		req.on("error", (error) => resolve({ ok: false, status: null, error: error.message, code: error.code ?? null }));
		if (body) req.write(body);
		req.end();
	});
}

function decodeChunkedBody(source) {
	let offset = 0;
	const chunks = [];
	const crlf = Buffer.from("\r\n");
	while (true) {
		const lineEnd = source.indexOf(crlf, offset);
		if (lineEnd < 0) throw new Error("invalid chunked HTTP response: missing chunk size");
		const sizeText = source.subarray(offset, lineEnd).toString("ascii").split(";", 1)[0].trim();
		if (!/^[0-9a-f]+$/i.test(sizeText)) throw new Error("invalid chunked HTTP response: invalid chunk size");
		const size = Number.parseInt(sizeText, 16);
		offset = lineEnd + crlf.length;
		if (size === 0) return Buffer.concat(chunks);
		if (offset + size + crlf.length > source.length) {
			throw new Error("invalid chunked HTTP response: truncated chunk");
		}
		chunks.push(source.subarray(offset, offset + size));
		offset += size;
		if (!source.subarray(offset, offset + crlf.length).equals(crlf)) {
			throw new Error("invalid chunked HTTP response: missing chunk terminator");
		}
		offset += crlf.length;
	}
}

function parseRawHttpResponse(source, input) {
	const separator = Buffer.from("\r\n\r\n");
	const headerEnd = source.indexOf(separator);
	if (headerEnd < 0) return { ok: false, status: null, error: "invalid Tailscale LocalAPI HTTP response" };

	const lines = source.subarray(0, headerEnd).toString("latin1").split("\r\n");
	const statusMatch = /^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s|$)/i.exec(lines.shift() ?? "");
	if (!statusMatch) return { ok: false, status: null, error: "invalid Tailscale LocalAPI HTTP status line" };
	const status = Number(statusMatch[1]);
	const headers = {};
	for (const line of lines) {
		const colon = line.indexOf(":");
		if (colon <= 0) continue;
		const key = line.slice(0, colon).trim().toLowerCase();
		const value = line.slice(colon + 1).trim();
		headers[key] = headers[key] ? `${headers[key]}, ${value}` : value;
	}

	let body = source.subarray(headerEnd + separator.length);
	try {
		if (/\bchunked\b/i.test(headers["transfer-encoding"] ?? "")) {
			body = decodeChunkedBody(body);
		} else if (/^\d+$/.test(headers["content-length"] ?? "")) {
			const length = Number(headers["content-length"]);
			if (body.length < length) return { ok: false, status, error: "truncated Tailscale LocalAPI HTTP response" };
			body = body.subarray(0, length);
		}
	} catch (error) {
		return { ok: false, status, error: error.message };
	}
	return responseFromBody(status, headers, body.toString("utf8"), input);
}

function requestWindows(socketPath, input) {
	const body = requestBody(input);
	const child = spawnSync(WINDOWS_POWERSHELL, [
		"-NoLogo",
		"-NoProfile",
		"-NonInteractive",
		"-ExecutionPolicy",
		"Bypass",
		"-File",
		WINDOWS_TRANSPORT_HELPER,
	], {
		encoding: "utf8",
		input: JSON.stringify({
			method: input.method,
			socketPath,
			body,
			etag: input.etag ?? "",
			timeoutMs: Number(input.timeoutMs) || 10_000,
		}),
		maxBuffer: 16 * 1024 * 1024,
		timeout: Number(input.timeoutMs) || 10_000,
		windowsHide: true,
	});
	if (child.error) return { ok: false, status: null, error: child.error.message, code: child.error.code ?? null };
	let transport;
	try {
		transport = JSON.parse(child.stdout || "{}");
	} catch (error) {
		return {
			ok: false,
			status: null,
			error: `invalid Windows Tailscale LocalAPI transport response: ${error.message}`,
			body: child.stdout || child.stderr || "",
		};
	}
	if (!transport.ok) {
		return {
			ok: false,
			status: transport.status ?? null,
			error: transport.error ?? "Windows Tailscale LocalAPI transport failed",
			code: transport.code ?? null,
			body: transport.body ?? "",
		};
	}
	if (typeof transport.responseBase64 !== "string") {
		return { ok: false, status: null, error: "Windows Tailscale LocalAPI transport returned no HTTP response" };
	}
	try {
		return parseRawHttpResponse(Buffer.from(transport.responseBase64, "base64"), input);
	} catch (error) {
		return { ok: false, status: null, error: `could not decode Windows Tailscale LocalAPI response: ${error.message}` };
	}
}

function request(socketPath, input) {
	return process.platform === "win32"
		? requestWindows(socketPath, input)
		: requestUnix(socketPath, input);
}

async function main() {
	const input = await readInput();
	if (input.method !== "GET" && input.method !== "POST") {
		throw new Error("method must be GET or POST");
	}

	const candidates = input.socketPath
		? [input.socketPath]
		: process.platform === "win32"
			? [DEFAULT_WINDOWS_PIPE]
			: [process.env.TAILSCALE_SOCKET, ...DEFAULT_UNIX_SOCKETS].filter(Boolean);

	let result = null;
	for (const socketPath of candidates) {
		result = await request(socketPath, input);
		if (result.ok || !["ENOENT", "ECONNREFUSED"].includes(result.code)) break;
	}
	process.stdout.write(JSON.stringify(result ?? { ok: false, status: null, error: "no Tailscale socket candidate" }));
}

main().catch((error) => {
	process.stdout.write(JSON.stringify({ ok: false, status: null, error: error.message, code: error.code ?? null }));
	process.exitCode = 1;
});
