/**
 * tern-omp-vimnav — Vim-style navigation of the chat thread in the Tern terminal.
 *
 * Off by default. `/vimnav on|off` toggles it and persists the choice in ~/.omp/agent/vimnav.json;
 * in Tern the composer shows "VIMNAV" while it is on. Alt+K (or `/vimnav` with no argument) opens the
 * navigator on omp's real transcript in Tern (native rendering). Outside Tern it notifies and does nothing.
 *
 * `l` expands a block, then enters line selection (TEXT); `h` moves left there, and pressed twice at column 0
 * returns to the block; Esc also returns to the block, and `h` on a block collapses it. `i` focuses the prompt while vimnav
 * stays visible; Esc there (once the editor is done with it, e.g. out of helix Insert mode) comes back to the block view,
 * and Alt+K switches focus between the two. `f` shows hints, Esc/q in block view closes the navigator,
 * and `?` in block view shows the full key list.
 *
 * In Tern, the companion plugin in ./tern takes over Ctrl+A < (`tidy_tab_title`) and adds action
 * `plugin.vimnav.open`; both type Alt+K into the focused pane.
 *
 * Install from a clone (see README.md): omp plugin link <clone>; tern plugin install <clone>/tern
 * Uninstall: omp plugin uninstall tern-omp-vimnav; tern plugin remove vimnav
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { copyToClipboard } from "@oh-my-pi/pi-coding-agent";
import { isKeyRelease, matchesKey } from "@oh-my-pi/pi-tui";
import type { ComposerFacts, ComposerFactsSource } from "@oh-my-pi/pi-tui/status-line";
import { findTranscript, InPlaceNavigator } from "./src/inplace";

const STATE_FILE = join(homedir(), ".omp", "agent", "vimnav.json");
const SHORTCUT = "alt+k";
// omp's own test for expecting Tern (pi-tui terminal.ts `tspExpected`, multiplexers per terminal-multiplexer.ts, which
// omp does not expose to extensions): a multiplexer started from Tern keeps TERM_PROGRAM=tern but renders rows. Outside
// Tern omp prints each extension status as a bare line under the editor, and vimnav does nothing there, so the label
// is published only here.
const IN_TERN =
	Bun.env.TERM_PROGRAM?.toLowerCase() === "tern" &&
	Bun.env.HERDR_ENV !== "1" &&
	Bun.env.WMUX !== "1" &&
	!["HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID", "TMUX", "STY", "ZELLIJ", "CMUX_WORKSPACE_ID", "CMUX_SURFACE_ID", "CMUX_REMOTE_TRANSPORT", "WMUX_SURFACE_ID"].some(name => Bun.env[name]) &&
	!/^(tmux|screen)/i.test(Bun.env.TERM ?? "");

function loadEnabled(): boolean {
	try {
		return existsSync(STATE_FILE) && JSON.parse(readFileSync(STATE_FILE, "utf8")).enabled === true;
	} catch {
		return false;
	}
}

/** omp's prompt editor: the composer-facts source behind the status chip, and whether Esc is its own right now. */
interface PromptEditor {
	composerFacts: ComposerFactsSource;
	vimConsumesEscape?(): boolean;
	isShowingAutocomplete?(): boolean;
}

function findEditor(component: unknown): PromptEditor | undefined {
	if (!component || typeof component !== "object") return undefined;
	const candidate = component as Partial<PromptEditor> & { children?: readonly unknown[] };
	if (typeof candidate.composerFacts?.describeComposerFacts === "function") return candidate as PromptEditor;
	if (Array.isArray(candidate.children)) {
		for (const child of candidate.children) {
			const editor = findEditor(child);
			if (editor) return editor;
		}
	}
	return undefined;
}

export default function ternOmpVimnav(pi: ExtensionAPI) {
	let enabled = loadEnabled();
	// `active` guards against a second open while the navigator is mounted.
	let active = false;
	// Closes the in-place navigator (listener + widget) while it is mounted.
	let closeActiveInPlace: (() => void) | undefined;

	const showStatus = (ctx: ExtensionContext) => ctx.ui.setStatus("vimnav", enabled && IN_TERN ? "VIMNAV" : undefined);

	const setEnabled = (ctx: ExtensionContext, on: boolean) => {
		enabled = on;
		if (!on) closeActiveInPlace?.();
		mkdirSync(dirname(STATE_FILE), { recursive: true });
		writeFileSync(STATE_FILE, `${JSON.stringify({ enabled })}\n`);
		showStatus(ctx);
		ctx.ui.notify(on ? "vimnav on: Alt+K opens the thread navigator" : "vimnav off", "info");
	};

	const quoteIntoPrompt = (ctx: ExtensionContext, text: string) => {
		const quoted = text
			.split("\n")
			.map(line => (line ? `> ${line}` : ">"))
			.join("\n");
		const draft = ctx.ui.getEditorText();
		ctx.ui.setEditorText(`${draft.trimEnd() ? `${draft.trimEnd()}\n\n` : ""}${quoted}\n\n`);
	};

	// Same opener choice as omp's own (utils/open.ts), but URLs also go through wslview under WSL so they open
	// in the Windows browser; omp does not expose its opener to extensions. Only http(s) URLs are opened: hrefs
	// come from transcript content, and file:// or custom schemes would hand local files to their OS handler.
	const openUrl = (ctx: ExtensionContext, href: string) => {
		const url = URL.parse(href);
		if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) {
			ctx.ui.notify(`vimnav: not opening non-web link ${href}`, "warning");
			return;
		}
		const command = process.platform === "darwin" ? ["open", url.href] : Bun.which("wslview") ? ["wslview", url.href] : ["xdg-open", url.href];
		try {
			Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
		} catch (err) {
			ctx.ui.notify(`vimnav: could not open ${url.href}: ${err instanceof Error ? err.message : String(err)}`, "warning");
		}
	};

	const openNavigator = async (ctx: ExtensionContext) => {
		if (!ctx.hasUI || ctx.mode !== "tui" || active) return;
		active = true;
		try {
			// Resolves once the in-place navigator is closed, or when it cannot mount.
			await new Promise<void>(resolve => {
				let off: (() => void) | undefined;
				let closed = false;
				let restoreStatusChip: (() => void) | undefined;
				const closeInPlace = () => {
					if (closed) return;
					closed = true;
					off?.();
					restoreStatusChip?.();
					restoreStatusChip = undefined;
					ctx.ui.setWidget("vimnav", undefined);
					showStatus(ctx);
					closeActiveInPlace = undefined;
					resolve();
				};
				closeActiveInPlace = closeInPlace;
				// The in-place decision needs `tui`, which only the widget factory receives.
				ctx.ui.setWidget(
					"vimnav",
					(tui, theme) => {
						const transcript = tui.nativeRendering === true ? findTranscript(tui) : undefined;
						if (!transcript) {
							queueMicrotask(() => {
								closeInPlace();
								ctx.ui.notify("vimnav works in Tern only", "info");
							});
							return { render: () => [] };
						}
						restoreStatusChip?.();
						restoreStatusChip = undefined;
						let statusState: { mode: string; pos: string } | undefined;
						const editor = findEditor(tui);
						const source = editor?.composerFacts;
						if (source) {
							const own = Object.getOwnPropertyDescriptor(source, "describeComposerFacts");
							const original = source.describeComposerFacts;
							let memo: { facts: ComposerFacts; mode: string; pos: string; patched: ComposerFacts } | undefined;
							Object.defineProperty(source, "describeComposerFacts", {
								configurable: true,
								writable: true,
								enumerable: own?.enumerable ?? false,
								value: () => {
									const facts = original.call(source);
									if (!statusState) return facts;
									const { mode, pos } = statusState;
									if (memo?.facts === facts && memo.mode === mode && memo.pos === pos) return memo.patched;
									const extras = facts.extras;
									// omp normalises status text (runs of spaces collapse); with its `status` segment configured, all
									// statuses share one segment, which must keep the others' text, so only vimnav's own one is replaced.
									const published = `VIMNAV · ${mode} ${pos}`.replace(/ +/g, " ").trim();
									const index = extras.c?.findIndex(child =>
										"k" in child && child.k === "seg" &&
										child.p?.spans?.map(part => part.t).join("").replace(/ +/g, " ").trim() === published,
									) ?? -1;
									if (index < 0 || !extras.c) return facts;
									const children = extras.c.slice();
									const segment = children[index];
									if (!segment || !("k" in segment) || segment.k !== "seg") return facts;
									children[index] = {
										...segment,
										p: {
											...segment.p,
											role: "omp.vimnav.status",
											spans: [{ t: mode, s: "strong accent" }, { t: pos, s: "mono" }],
										},
									};
									const patched = { ...facts, extras: { ...extras, c: children } };
									memo = { facts, mode, pos, patched };
									return patched;
								},
							});
							restoreStatusChip = () => {
								if (own) Object.defineProperty(source, "describeComposerFacts", own);
								else Reflect.deleteProperty(source, "describeComposerFacts");
							};
						}
						const navigator = new InPlaceNavigator(transcript, theme, {
							requestRender: () => tui.requestRender(),
							rows: () => tui.terminal.rows,
							copy: text => copyToClipboard(text),
							quote: text => quoteIntoPrompt(ctx, text),
							close: closeInPlace,
							getToolsExpanded: () => ctx.ui.getToolsExpanded(),
							setToolsExpanded: on => ctx.ui.setToolsExpanded(on),
							showOverlay: (component, { passive, ...options }) => {
								const focused = tui.getFocused();
								const handle = tui.showOverlay(component, options);
								if (passive) {
									// omp gives a shown overlay the keyboard and draws a focused overlay as modal. A released entry
									// (what omp does for a sheet the user clicked away from) stops holding the keys, so focus can go back.
									const entry = tui.overlayStack.find(e => e.component === component);
									if (entry) {
										entry.released = true;
										tui.setFocus(focused);
									}
								}
								return handle;
							},
							openUrl: href => openUrl(ctx, href),
							status: state => {
								statusState = state ? { mode: state.mode, pos: state.pos } : undefined;
								if (state) ctx.ui.setStatus("vimnav", `VIMNAV · ${state.mode}  ${state.pos}`);
								else showStatus(ctx);
							},
							notify: text => ctx.ui.notify(text, "warning"),
							accent: () => theme.getColorHex("accent"),
						});
						const dispose = navigator.dispose.bind(navigator);
						navigator.dispose = () => {
							try {
								dispose();
							} finally {
								closeInPlace();
							}
						};
						// Keys go to vimnav, or to the prompt while it has focus (`i`); Alt+K moves them between the two, and an Esc
						// the editor has no use for (omp's own rule for its interrupt: not leaving helix/vim Insert mode, not
						// cancelling an operator or closing autocomplete) brings them back to vimnav's block view.
						// A selector opened from the transcript (rewind, model picker) takes TUI focus: its keys pass through
						// until focus returns. vimnav's own help popup also takes focus, so it is exempt.
						const home = tui.getFocused();
						off?.();
						off = ctx.ui.onTerminalInput(data => {
							if (isKeyRelease(data)) return undefined;
							if (tui.getFocused() !== home && !navigator.ownsFocus) return undefined;
							if (matchesKey(data, SHORTCUT)) {
								navigator.toggleFocus();
								return { consume: true };
							}
							if (navigator.promptFocused) {
								if (!matchesKey(data, "escape") || editor?.vimConsumesEscape?.() || editor?.isShowingAutocomplete?.()) return undefined;
								navigator.leavePrompt();
								return { consume: true };
							}
							navigator.handleInput(data);
							return { consume: true };
						});
						return navigator;
					},
					{ placement: "belowEditor" },
				);
			});
		} finally {
			closeActiveInPlace?.();
			active = false;
		}
	};

	pi.on("session_start", (_event, ctx) => showStatus(ctx));
	pi.on("session_shutdown", () => closeActiveInPlace?.());
	pi.on("session_switch", () => closeActiveInPlace?.());

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
