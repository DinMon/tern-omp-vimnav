// Extracts navigable transcript blocks from omp's session branch entries,
// providing both native TSP node descriptions (for Tern rendering and hints)
// and ANSI-styled wrapped rows (for TEXT mode, visual selection, and search).

import { highlightCode } from "@oh-my-pi/pi-tui/text/highlight";
import { wrap } from "@oh-my-pi/pi-tui/text/width";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";

export type BlockKind = "user" | "assistant" | "thinking" | "tool" | "bash" | "python" | "note";

export interface TspTreeNode {
	k: string;
	p?: Record<string, unknown>;
	c?: TspTreeNode[];
	key?: string;
	reveal?: "start" | "end" | "nearest" | { at: "start" | "end" | "nearest"; n: number };
}

export interface NavBlock {
	/** Stable identifier across refreshes for cursor restoration and node keying. */
	readonly id: string;
	readonly kind: BlockKind;
	/** Display label shown in the TEXT well header and status bar. */
	readonly label: string;
	readonly collapsible: boolean;
	/** Full plain text of the block (for BLOCK-mode yank and quote). */
	text(expanded: boolean): string;
	/** ANSI-styled rows wrapped to `cols` (for TEXT mode and search). */
	renderRows(cols: number, expanded: boolean, theme?: Theme): string[];
	/** Native TSP node tree for Tern rendering and hint target discovery. */
	describe(expanded: boolean): TspTreeNode;
}

interface ContentPart {
	type?: string;
	text?: string;
	thinking?: string;
	id?: string;
	name?: string;
	arguments?: Record<string, unknown>;
	mimeType?: string;
}

interface ToolResultInfo {
	content: unknown;
	details?: unknown;
	isError?: boolean;
}

const PREVIEW_LINES = 6;
const THINKING_PREVIEW_LINES = 3;

function extractTextContent(content: unknown, sep = "\n"): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const item of content) {
		if (typeof item === "string") {
			if (item) parts.push(item);
			continue;
		}
		if (!item || typeof item !== "object") continue;
		const part = item as ContentPart;
		if (part.type === "text" && typeof part.text === "string") {
			parts.push(part.text);
		} else if (part.type === "image") {
			parts.push(`[Image${part.mimeType ? `: ${part.mimeType}` : ""}]`);
		}
	}
	return parts.join(sep);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstLine(text: string): string {
	return (text.split("\n").find(line => line.trim().length > 0) ?? "").replace(/\s+/g, " ").trim();
}

function capitalize(text: string): string {
	return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

function toolTargetInfo(name: string, args: Record<string, unknown> | undefined): {
	target?: string;
	targetKind?: "command" | "path" | "pattern" | "query" | "text";
	lang?: string;
	command?: string;
} {
	if (!args) return {};
	const str = (key: string): string | undefined => {
		const v = args[key];
		return typeof v === "string" && v.trim() ? v.trim() : undefined;
	};
	if (name === "bash" || name === "shell") {
		const cmd = str("command");
		return cmd ? { target: cmd, targetKind: "command", lang: "bash", command: cmd } : {};
	}
	if (name === "python" || name === "eval") {
		const code = str("code") ?? str("script") ?? str("command");
		const lang = name === "python" ? "python" : str("language") ?? "python";
		return code ? { target: firstLine(code), targetKind: "command", lang, command: code } : {};
	}
	const path = str("path") ?? str("file_path") ?? str("filePath") ?? str("file");
	if (path) return { target: path, targetKind: "path" };
	const pattern = str("pattern") ?? str("glob");
	if (pattern) return { target: pattern, targetKind: "pattern" };
	const query = str("query") ?? str("q") ?? str("url");
	if (query) return { target: query, targetKind: "query" };
	const command = str("command") ?? str("cmd");
	if (command) return { target: command, targetKind: "command", command };
	const summary = str("description") ?? str("prompt") ?? str("task");
	if (summary) return { target: firstLine(summary), targetKind: "text" };
	return {};
}

function langFromPath(filePath: string | undefined): string | undefined {
	if (!filePath) return undefined;
	const clean = filePath.split("#")[0]?.split(":")[0] ?? filePath;
	const ext = clean.split(".").pop()?.toLowerCase();
	if (!ext || ext === clean.toLowerCase()) return undefined;
	const map: Record<string, string> = {
		ts: "typescript",
		tsx: "tsx",
		js: "javascript",
		jsx: "jsx",
		mjs: "javascript",
		cjs: "javascript",
		py: "python",
		rs: "rust",
		go: "go",
		sh: "bash",
		bash: "bash",
		zsh: "bash",
		json: "json",
		yml: "yaml",
		yaml: "yaml",
		toml: "toml",
		md: "markdown",
		css: "css",
		html: "html",
		sql: "sql",
		luau: "lua",
		lua: "lua",
		c: "c",
		h: "c",
		cpp: "cpp",
		cc: "cpp",
		rb: "ruby",
		java: "java",
	};
	return map[ext] ?? ext;
}

function wrapSafe(text: string, cols: number): string[] {
	const width = Math.max(10, cols);
	const out: string[] = [];
	for (const line of text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")) {
		if (line === "") {
			out.push("");
			continue;
		}
		const wrapped = wrap(line, width);
		if (wrapped.length === 0) out.push("");
		else out.push(...wrapped);
	}
	return out.length > 0 ? out : [""];
}

/** Render markdown text into ANSI rows with syntax-highlighted fenced code blocks. */
function renderMarkdownRows(markdown: string, cols: number, theme?: Theme): string[] {
	const width = Math.max(10, cols);
	const lines = markdown.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
	const out: string[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i]!;
		const open = /^([ \t]*)(`{3,}|~{3,})([^\n]*)$/.exec(line);
		if (open && (open[2]![0] !== "`" || !open[3]!.includes("`"))) {
			const fence = open[2]!;
			const lang = open[3]!.trim().split(/\s+/)[0] || undefined;
			const closeRe = new RegExp(`^[ \\t]*${fence[0]}{${fence.length},}[ \\t]*$`);
			let end = i + 1;
			while (end < lines.length && !closeRe.test(lines[end]!)) end++;
			out.push(...wrapSafe(theme ? theme.fg("dim", line) : line, width));
			const body = lines.slice(i + 1, end).join("\n");
			if (body.length > 0) {
				let highlighted: string[];
				if (theme && lang) {
					try {
						highlighted = highlightCode(body, lang, theme);
					} catch {
						highlighted = body.split("\n");
					}
				} else {
					highlighted = body.split("\n");
				}
				for (const codeLine of highlighted) out.push(...wrapSafe(codeLine, width));
			}
			if (end < lines.length) {
				const closeLine = lines[end]!;
				out.push(...wrapSafe(theme ? theme.fg("dim", closeLine) : closeLine, width));
			}
			i = end + 1;
			continue;
		}
		if (theme && /^#{1,6}\s+/.test(line)) {
			out.push(...wrapSafe(theme.style("strong accent", line), width));
		} else if (theme && /^\s*>\s?/.test(line)) {
			out.push(...wrapSafe(theme.fg("muted", line), width));
		} else {
			out.push(...wrapSafe(line, width));
		}
		i++;
	}
	return out.length > 0 ? out : [""];
}

function makeMarkdownBlock(
	id: string,
	kind: "user" | "assistant" | "thinking" | "note",
	label: string,
	source: string,
	opts?: { head?: string; collapsible?: boolean },
): NavBlock {
	const trimmed = source.replace(/^\n+|\n+$/g, "");
	const collapsible = opts?.collapsible === true;
	const rawLines = trimmed.split("\n");
	const hasHidden = collapsible && rawLines.length > THINKING_PREVIEW_LINES;

	return {
		id,
		kind,
		label,
		collapsible: hasHidden,
		text() {
			return trimmed;
		},
		renderRows(cols, expanded, theme) {
			if (hasHidden && !expanded) {
				const preview = rawLines.slice(0, THINKING_PREVIEW_LINES).join("\n");
				const rows = renderMarkdownRows(preview, cols, theme);
				const hidden = rawLines.length - THINKING_PREVIEW_LINES;
				const note = `… ${hidden} more ${hidden === 1 ? "line" : "lines"} (l / za to expand)`;
				rows.push(theme ? theme.fg("muted", note) : note);
				return rows;
			}
			return renderMarkdownRows(trimmed, cols, theme);
		},
		describe(expanded) {
			if (kind === "user") {
				return {
					k: "card",
					key: id,
					p: { role: "omp.user", tone: "user" },
					c: [{ k: "md", key: "md", p: { text: trimmed } }],
				};
			}
			if (kind === "thinking") {
				return {
					k: "section",
					key: id,
					p: {
						role: "omp.thinking",
						head: opts?.head ?? "Thinking",
						collapsible: true,
						collapsed: !expanded,
					},
					c: [{ k: "md", key: "md", p: { text: trimmed } }],
				};
			}
			if (kind === "note") {
				if (collapsible) {
					return {
						k: "section",
						key: id,
						p: {
							role: "omp.note",
							head: opts?.head ?? label,
							collapsible: true,
							collapsed: !expanded,
						},
						c: [{ k: "md", key: "md", p: { text: trimmed } }],
					};
				}
				return {
					k: "card",
					key: id,
					p: { role: "omp.note", ...(opts?.head ? { head: opts.head } : {}) },
					c: [{ k: "md", key: "md", p: { text: trimmed } }],
				};
			}
			return {
				k: "md",
				key: id,
				p: { role: "omp.assistant", text: trimmed },
			};
		},
	};
}

function makeToolBlock(params: {
	id: string;
	name: string;
	args?: Record<string, unknown>;
	result?: ToolResultInfo;
	userRun?: boolean;
}): NavBlock {
	const { id, name, args, result, userRun } = params;
	const kind: BlockKind = name === "bash" || name === "shell" ? "bash" : name === "python" ? "python" : "tool";
	const title = capitalize(name.replace(/^mcp__/, "").replace(/__/g, " · "));
	const info = toolTargetInfo(name, args);
	const outputRaw = result ? extractTextContent(result.content, "\n").replace(/\r\n/g, "\n").replace(/\n+$/, "") : "";
	const outputPlain = Bun.stripANSI(outputRaw);
	const outputLines = outputRaw ? outputRaw.split("\n") : [];
	const hasArgsDetail =
		!info.command &&
		args &&
		Object.keys(args).length > 0 &&
		(name === "write" || name === "edit" || (!info.target && Object.keys(args).length > 0));
	const argsDetail = hasArgsDetail ? formatToolArgs(name, args) : "";

	const bodyLines = outputLines.length > 0 ? outputLines : argsDetail ? argsDetail.split("\n") : [];
	const collapsible = bodyLines.length > PREVIEW_LINES;
	const status = result?.isError ? "error" : result ? "ok" : "pending";
	const codeLang = info.lang ?? langFromPath(info.targetKind === "path" ? info.target : undefined);
	const hasAnsi = /\x1b\[/.test(outputRaw);

	const headerText = [title, info.target].filter(Boolean).join(" ");

	return {
		id,
		kind,
		label: title,
		collapsible,
		text(expanded) {
			const chunks: string[] = [];
			if (info.command) chunks.push(info.command);
			else if (headerText) chunks.push(headerText);
			if (outputPlain) {
				if (!expanded && outputLines.length > PREVIEW_LINES) {
					chunks.push(outputLines.map(l => Bun.stripANSI(l)).join("\n"));
				} else {
					chunks.push(outputPlain);
				}
			} else if (argsDetail) {
				chunks.push(argsDetail);
			}
			return chunks.join("\n").trim();
		},
		renderRows(cols, expanded, theme) {
			const rows: string[] = [];
			const head = theme
				? `${theme.style("toolTitle strong", title)}${info.target ? ` ${theme.fg("muted", info.target)}` : ""}`
				: headerText;
			rows.push(...wrapSafe(head, cols));

			if (info.command && info.command.includes("\n")) {
				const cmdLines = theme && info.lang ? highlightSafe(info.command, info.lang, theme) : info.command.split("\n");
				for (const line of cmdLines) rows.push(...wrapSafe(line, cols));
			}

			if (bodyLines.length === 0) return rows;

			const shown = !expanded && collapsible ? bodyLines.slice(0, PREVIEW_LINES) : bodyLines;
			let styledLines: string[];
			if (hasAnsi || !theme || !codeLang || outputLines.length === 0) {
				styledLines = shown;
			} else {
				styledLines = highlightSafe(shown.join("\n"), codeLang, theme);
			}
			for (const line of styledLines) rows.push(...wrapSafe(line, cols));

			if (!expanded && collapsible) {
				const hidden = bodyLines.length - PREVIEW_LINES;
				const note = `… ${hidden} more ${hidden === 1 ? "line" : "lines"} (l / za to expand)`;
				rows.push(theme ? theme.fg("muted", note) : note);
			}
			return rows;
		},
		describe(expanded) {
			const meta: string[] = [];
			if (outputLines.length > 0) meta.push(`${outputLines.length} ${outputLines.length === 1 ? "line" : "lines"}`);
			const badges: { text: string; tone?: string }[] = [];
			if (userRun) badges.push({ text: "you", tone: "muted" });
			if (result?.isError) badges.push({ text: "error", tone: "error" });

			const children: TspTreeNode[] = [];
			if (outputRaw) {
				const shownText = !expanded && collapsible ? outputLines.slice(0, PREVIEW_LINES).join("\n") : outputRaw;
				if (hasAnsi || kind === "bash") {
					children.push({
						k: "ansi",
						key: "output",
						p: { role: `omp.tool.${name}.output`, text: shownText },
					});
				} else if (codeLang) {
					children.push({
						k: "code",
						key: "output",
						p: { role: `omp.tool.${name}.output`, text: shownText, lang: codeLang },
					});
				} else {
					children.push({
						k: "ansi",
						key: "output",
						p: { role: `omp.tool.${name}.output`, text: shownText },
					});
				}
				if (!expanded && collapsible) {
					const hidden = outputLines.length - PREVIEW_LINES;
					children.push({
						k: "text",
						key: "more",
						p: { spans: [{ t: `… ${hidden} more ${hidden === 1 ? "line" : "lines"}`, s: "muted" }] },
					});
				}
			} else if (argsDetail) {
				const shownArgs = !expanded && collapsible ? bodyLines.slice(0, PREVIEW_LINES).join("\n") : argsDetail;
				children.push({
					k: "code",
					key: "args",
					p: { text: shownArgs, lang: codeLang ?? "json" },
				});
			}

			return {
				k: "tool",
				key: id,
				p: {
					name,
					title,
					...(info.target ? { target: info.target } : {}),
					...(info.targetKind ? { targetKind: info.targetKind } : {}),
					...(info.lang ? { lang: info.lang } : {}),
					...(info.command ? { command: info.command } : {}),
					...(meta.length > 0 ? { meta } : {}),
					...(badges.length > 0 ? { badges } : {}),
					status,
					collapsible: children.length > 0,
					collapsed: false,
				},
				...(children.length > 0 ? { c: children } : {}),
			};
		},
	};
}

function highlightSafe(code: string, lang: string, theme: Theme): string[] {
	try {
		return highlightCode(code, lang, theme);
	} catch {
		return code.split("\n");
	}
}

function formatToolArgs(name: string, args: Record<string, unknown>): string {
	if (name === "write" && typeof args.content === "string") return args.content;
	if (name === "edit") {
		if (typeof args.new_str === "string" || typeof args.old_str === "string") {
			const parts: string[] = [];
			if (typeof args.old_str === "string") parts.push(`--- old\n${args.old_str}`);
			if (typeof args.new_str === "string") parts.push(`+++ new\n${args.new_str}`);
			return parts.join("\n");
		}
		if (Array.isArray(args.edits)) {
			try {
				return JSON.stringify(args.edits, null, 2);
			} catch {
				return "";
			}
		}
	}
	try {
		return JSON.stringify(args, null, 2);
	} catch {
		return "";
	}
}

/**
 * Convert omp's session branch (`ctx.sessionManager.getBranch()`) into the ordered
 * list of navigable transcript blocks.
 */
export function extractTranscriptBlocks(entries: readonly unknown[]): NavBlock[] {
	// Index toolResult messages by toolCallId so each toolCall pairs cleanly with its output.
	const toolResults = new Map<string, ToolResultInfo>();
	for (const raw of entries) {
		if (!isRecord(raw) || raw.type !== "message" || !isRecord(raw.message)) continue;
		const msg = raw.message;
		if (msg.role === "toolResult" && typeof msg.toolCallId === "string") {
			toolResults.set(msg.toolCallId, {
				content: msg.content,
				details: msg.details,
				isError: msg.isError === true,
			});
		}
	}

	const blocks: NavBlock[] = [];
	const seenToolResults = new Set<string>();

	for (let entryIdx = 0; entryIdx < entries.length; entryIdx++) {
		const raw = entries[entryIdx];
		if (!isRecord(raw)) continue;
		const entryId = typeof raw.id === "string" && raw.id ? raw.id : `e${entryIdx}`;

		if (raw.type === "custom_message") {
			if (raw.display === false) continue;
			const text = extractTextContent(raw.content, "\n").trim();
			if (!text) continue;
			const label = typeof raw.customType === "string" && raw.customType ? raw.customType : "Note";
			blocks.push(makeMarkdownBlock(`custom:${entryId}`, "note", capitalize(label), text, { head: label }));
			continue;
		}

		if (raw.type === "compaction" || raw.type === "branch_summary") {
			const summary = typeof raw.summary === "string" ? raw.summary.trim() : "";
			if (!summary) continue;
			const head = raw.type === "compaction" ? "Compaction summary" : "Branch summary";
			blocks.push(
				makeMarkdownBlock(`${raw.type}:${entryId}`, "note", "Summary", summary, {
					head,
					collapsible: true,
				}),
			);
			continue;
		}

		if (raw.type !== "message" || !isRecord(raw.message)) continue;
		const msg = raw.message;

		if (msg.role === "user") {
			const text = extractTextContent(msg.content, "\n").trim();
			if (!text) continue;
			blocks.push(makeMarkdownBlock(`user:${entryId}`, "user", "User", text));
			continue;
		}

		if (msg.role === "bashExecution") {
			const command = typeof msg.command === "string" ? msg.command : "";
			const output = typeof msg.output === "string" ? msg.output : "";
			if (!command && !output) continue;
			blocks.push(
				makeToolBlock({
					id: `bash:${entryId}`,
					name: "bash",
					args: { command },
					result: { content: output, isError: msg.exitCode !== 0 && msg.exitCode !== undefined },
					userRun: true,
				}),
			);
			continue;
		}

		if (msg.role === "pythonExecution") {
			const code = typeof msg.code === "string" ? msg.code : "";
			const output = typeof msg.output === "string" ? msg.output : "";
			if (!code && !output) continue;
			blocks.push(
				makeToolBlock({
					id: `python:${entryId}`,
					name: "python",
					args: { code },
					result: { content: output, isError: msg.exitCode !== 0 && msg.exitCode !== undefined },
					userRun: true,
				}),
			);
			continue;
		}

		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			const parts = msg.content as ContentPart[];
			parts.forEach((part, idx) => {
				if (!part || typeof part !== "object") return;
				if (part.type === "thinking") {
					const thinking = (typeof part.thinking === "string" ? part.thinking : part.text ?? "").trim();
					if (!thinking) return;
					blocks.push(
						makeMarkdownBlock(`thinking:${entryId}:${idx}`, "thinking", "Thinking", thinking, {
							head: "Thinking",
							collapsible: true,
						}),
					);
				} else if (part.type === "text") {
					const text = (part.text ?? "").trim();
					if (!text) return;
					blocks.push(makeMarkdownBlock(`assistant:${entryId}:${idx}`, "assistant", "Assistant", text));
				} else if (part.type === "toolCall") {
					const callId = typeof part.id === "string" && part.id ? part.id : `${entryId}:${idx}`;
					const toolName = typeof part.name === "string" && part.name ? part.name : "tool";
					const result = toolResults.get(callId);
					if (result) seenToolResults.add(callId);
					blocks.push(
						makeToolBlock({
							id: `tool:${callId}`,
							name: toolName,
							args: isRecord(part.arguments) ? part.arguments : undefined,
							result,
						}),
					);
				}
			});
			continue;
		}

		if (msg.role === "toolResult") {
			const callId = typeof msg.toolCallId === "string" ? msg.toolCallId : "";
			if (callId && seenToolResults.has(callId)) continue;
			const toolName = typeof msg.toolName === "string" && msg.toolName ? msg.toolName : "tool";
			const output = extractTextContent(msg.content, "\n").trim();
			if (!output) continue;
			blocks.push(
				makeToolBlock({
					id: `toolResult:${entryId}`,
					name: toolName,
					result: { content: msg.content, details: msg.details, isError: msg.isError === true },
				}),
			);
			continue;
		}

		if (msg.role === "custom" || msg.role === "hookMessage") {
			const text = extractTextContent(msg.content, "\n").trim();
			if (!text) continue;
			const label = typeof msg.customType === "string" && msg.customType ? msg.customType : "Note";
			blocks.push(makeMarkdownBlock(`msg:${entryId}`, "note", capitalize(label), text, { head: label }));
		}
	}

	return blocks;
}
