/**
 * tern-omp-vimnav — Vim-style navigation of the chat thread in omp + Tern.
 *
 * Off by default. `/vimnav on|off` toggles it and persists the choice in ~/.omp/agent/vimnav.json;
 * in Tern the composer shows "VIMNAV" while it is on.
 *
 * Open the thread navigator with:
 * - Double-Esc in the prompt (when idle)
 * - Alt+K (or Tern's `open_scrollback` / `plugin.vimnav.open` palette command)
 * - `/vimnav`
 *
 * Inside the navigator:
 * - `j`/`k`/arrows move block by block; `l`/`→` expands a block then enters TEXT cursor mode
 * - In TEXT mode: `h`/`j`/`k`/`l`/arrows, `w`/`b`/`e`, `0`/`^`/`$`, `v`/`Space` char visual, `V` line visual
 * - `y` copies selected text or blocks, `c` quotes into the prompt, `/` searches, `f`/`F` shows hints
 * - `Esc` steps back one level (selection → TEXT → BLOCK → close); `q` / `i` / `Alt+K` closes immediately
 *
 * Install from a clone (see README.md): omp plugin link <clone>; tern plugin install <clone>/tern
 * Uninstall: omp plugin uninstall tern-omp-vimnav; tern plugin remove vimnav
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { copyToClipboard } from "@oh-my-pi/pi-coding-agent";
import { decodeKey } from "@oh-my-pi/pi-tui/driver/input/keys";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { ThreadNavigator } from "./src/navigator";
import { extractTranscriptBlocks } from "./src/transcript";

const STATE_FILE = join(homedir(), ".omp", "agent", "vimnav.json");
const SHORTCUT = "alt+k";
const DOUBLE_ESC_MAX_MS = 550;
const DECODE_CTX = { kitty: true, backspaceIsCtrl: false } as const;

const IN_TERN =
	Bun.env.TERM_PROGRAM?.toLowerCase() === "tern" &&
	Bun.env.HERDR_ENV !== "1" &&
	Bun.env.WMUX !== "1" &&
	![
		"HERDR_PANE_ID",
		"HERDR_TAB_ID",
		"HERDR_WORKSPACE_ID",
		"TMUX",
		"STY",
		"ZELLIJ",
		"CMUX_WORKSPACE_ID",
		"CMUX_SURFACE_ID",
		"CMUX_REMOTE_TRANSPORT",
		"WMUX_SURFACE_ID",
	].some(name => Bun.env[name]) &&
	!/^(tmux|screen)/i.test(Bun.env.TERM ?? "");

function loadEnabled(): boolean {
	try {
		return existsSync(STATE_FILE) && JSON.parse(readFileSync(STATE_FILE, "utf8")).enabled === true;
	} catch {
		return false;
	}
}

export default function ternOmpVimnav(pi: ExtensionAPI) {
	let enabled = loadEnabled();
	let active = false;
	let closeActive: (() => void) | undefined;
	let removeTerminalInputListener: (() => void) | undefined;
	let lastEscAt = 0;

	const showStatus = (ctx: ExtensionContext) => ctx.ui.setStatus("vimnav", enabled && IN_TERN ? "VIMNAV" : undefined);

	const setEnabled = (ctx: ExtensionContext, on: boolean) => {
		enabled = on;
		if (!on) closeActive?.();
		mkdirSync(dirname(STATE_FILE), { recursive: true });
		writeFileSync(STATE_FILE, `${JSON.stringify({ enabled })}\n`);
		showStatus(ctx);
		ctx.ui.notify(on ? "vimnav on: double-Esc or Alt+K opens the thread navigator" : "vimnav off", "info");
	};

	const quoteIntoPrompt = (ctx: ExtensionContext, text: string) => {
		const quoted = text
			.split("\n")
			.map(line => (line ? `> ${line}` : ">"))
			.join("\n");
		const draft = ctx.ui.getEditorText();
		ctx.ui.setEditorText(`${draft.trimEnd() ? `${draft.trimEnd()}\n\n` : ""}${quoted}\n\n`);
	};

	const openUrl = (ctx: ExtensionContext, href: string) => {
		const url = URL.parse(href);
		if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) {
			ctx.ui.notify(`vimnav: not opening non-web link ${href}`, "warning");
			return;
		}
		const command =
			process.platform === "darwin"
				? ["open", url.href]
				: Bun.which("wslview")
					? ["wslview", url.href]
					: ["xdg-open", url.href];
		try {
			Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
		} catch (err) {
			ctx.ui.notify(`vimnav: could not open ${url.href}: ${err instanceof Error ? err.message : String(err)}`, "warning");
		}
	};

	const openNavigator = async (ctx: ExtensionContext) => {
		if (!ctx.hasUI || ctx.mode !== "tui" || active) return;
		const entries = ctx.sessionManager.getBranch();
		const blocks = extractTranscriptBlocks(entries);
		if (blocks.length === 0) {
			ctx.ui.notify("vimnav: no messages in thread yet", "info");
			return;
		}
		active = true;
		lastEscAt = 0;
		let navigator: ThreadNavigator | undefined;
		try {
			await ctx.ui.custom<void>(
				(ui, _theme, _keybindings, done) => {
					const close = () => {
						navigator?.dispose();
						closeActive = undefined;
						done();
					};
					closeActive = close;
					navigator = new ThreadNavigator(blocks, {
						size: () => ui.size(),
						theme: () => currentTheme(),
						copy: text => copyToClipboard(text),
						quote: text => quoteIntoPrompt(ctx, text),
						close,
						notify: text => ctx.ui.notify(text, "warning"),
						getToolsExpanded: () => ctx.ui.getToolsExpanded(),
						setToolsExpanded: on => ctx.ui.setToolsExpanded(on),
						openUrl: href => openUrl(ctx, href),
						sessionKey: ctx.sessionManager.getSessionId?.() ?? "default",
					});
					return navigator.buildView();
				},
				{ overlay: true, fullscreen: true },
			);
		} finally {
			navigator?.dispose();
			closeActive = undefined;
			active = false;
			showStatus(ctx);
		}
	};

	// Hook terminal input (Shell.interceptInput) rather than composer.addKeyHandler:
	// omp's own InputController registers its composer key handler before session_start and
	// consumes `escape` for `app.interrupt` / `doubleEscapeAction` (Rewind) before extension
	// composer handlers ever see it. Intercepting the second Esc press here lets single-Esc
	// keep working normally (autocomplete, Vim Insert exit, interrupt) while double-Esc opens
	// vimnav instead of omp's Rewind screen whenever vimnav is enabled.
	const bindDoubleEscape = (ctx: ExtensionContext) => {
		removeTerminalInputListener?.();
		removeTerminalInputListener = undefined;
		lastEscAt = 0;
		removeTerminalInputListener = ctx.ui.onTerminalInput(data => {
			if (!enabled || active || !ctx.isIdle()) {
				lastEscAt = 0;
				return undefined;
			}
			// Ignore bracketed pastes.
			if (data.startsWith("\x1b[200~")) {
				lastEscAt = 0;
				return undefined;
			}
			const key = decodeKey(data, DECODE_CTX);
			if (!key) {
				lastEscAt = 0;
				return undefined;
			}
			if (key.kind === "release") return undefined;
			if (key.id !== "escape") {
				lastEscAt = 0;
				return undefined;
			}
			if (key.kind !== "press") return undefined;
			const now = Date.now();
			if (lastEscAt > 0 && now - lastEscAt <= DOUBLE_ESC_MAX_MS) {
				lastEscAt = 0;
				void openNavigator(ctx);
				return { consume: true };
			}
			lastEscAt = now;
			return undefined;
		});
	};

	pi.on("session_start", (_event, ctx) => {
		showStatus(ctx);
		bindDoubleEscape(ctx);
	});
	pi.on("session_shutdown", () => {
		closeActive?.();
		removeTerminalInputListener?.();
		removeTerminalInputListener = undefined;
	});
	pi.on("session_switch", (_event, ctx) => {
		closeActive?.();
		showStatus(ctx);
		bindDoubleEscape(ctx);
	});

	pi.registerShortcut(SHORTCUT, {
		description: "Open the vimnav thread navigator",
		handler: async ctx => {
			if (!enabled) {
				ctx.ui.notify("vimnav is off — /vimnav on to enable", "info");
				return;
			}
			await openNavigator(ctx);
		},
	});

	pi.registerCommand("vimnav", {
		description: "Vim navigation of the thread: /vimnav on|off, or /vimnav to open it",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "on" || arg === "off") return setEnabled(ctx, arg === "on");
			if (arg !== "") {
				ctx.ui.notify("usage: /vimnav [on|off]", "warning");
				return;
			}
			if (!enabled) {
				ctx.ui.notify("vimnav is off — /vimnav on to enable", "info");
				return;
			}
			await openNavigator(ctx);
		},
	});
}
