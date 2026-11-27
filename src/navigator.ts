// Reactive pi-tui navigator for omp 19.x + Tern.
// Renders on Tern's native `omp.rewind` screen page (`page: { role: "omp.rewind", dock: 1 }`)
// so the reading column, typography, selection rail (`mark: "pick"`), caption (`omp.rewind.here`),
// and floating bottom pill bar (`omp.rewind.bar` with `<kbd>` hints and `<button>` actions)
// match Tern-omp's native Rewind aesthetic seamlessly.
//
// Supports BLOCK / V-BLOCK cursor & range selection, TEXT / VISUAL / V-LINE code well with
// grapheme caret, live incsearch (`/`/`?`), Vimium-style hints (`f`/`F`), searchable help sheet (`?`),
// click-to-select blocks, and a plain-terminal fallback.

import { jsx, type JSXNode, type KeyEvent, nativeRendering, nativeSupports, signal, type UiNode } from "@oh-my-pi/pi-tui";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { collectTargets, decorate, type HintTarget, hintLabels, labelBlock } from "./hints";
import { type Occurrence, occurrences } from "./search";
import { displayColumn, firstNonBlank, graphemeColumn, graphemes, nextWordStart, paintCells, prevWordStart, wordEnd } from "./textops";
import type { BlockKind, NavBlock, TspTreeNode } from "./transcript";

export interface NavigatorHost {
	size(): { readonly columns: number; readonly rows: number };
	theme(): Theme;
	copy(text: string): Promise<void>;
	quote(text: string): void;
	close(): void;
	notify(text: string): void;
	getToolsExpanded(): boolean;
	setToolsExpanded(on: boolean): void;
	openUrl(href: string): void;
	/** Optional session identifier used to remember the cursor block between opens. */
	sessionKey?: string;
}

/** A block's rendered rows at `cols`, with plain text and grapheme metadata. */
interface Rows {
	cols: number;
	expanded: boolean;
	raw: readonly string[];
	rows: readonly string[];
	plain: string[];
	clusters: readonly (readonly string[])[];
	len: number[];
}

/** A TEXT-mode position: block index, row inside the block, grapheme column in that row. */
interface Pos {
	idx: number;
	row: number;
	col: number;
}

interface HintItem {
	label: string;
	block: NavBlock;
	target: HintTarget;
}

interface HintSession {
	copy: boolean;
	typed: string;
	items: HintItem[];
	n: number;
}

type Mode = "block" | "vblock" | "line" | "visual" | "vline";

const MODE_LABEL: Record<Mode, string> = {
	block: "BLOCK",
	vblock: "V-BLOCK",
	line: "TEXT",
	visual: "VISUAL",
	vline: "V-LINE",
};

const SEQ_PREFIXES: Record<string, true> = { g: true, z: true, "[": true, "]": true };
const PAGE = 5;
const TOOL_KINDS: Record<string, true> = { tool: true, bash: true, python: true };
const FALLBACK_COLS = 80;
const READER_COLS = 80;
const TOP_REVEAL_DELAY_MS = 100;
const HINT_ALPHABET = "SADFEWCMPGRUIO";

const HINT_MOVES: Record<string, number> = {
	j: 1,
	down: 1,
	k: -1,
	up: -1,
	l: 5,
	right: 5,
	"ctrl+d": 5,
	pageDown: 5,
	h: -5,
	left: -5,
	"ctrl+u": -5,
	pageUp: -5,
};

interface HintSpec {
	keys: readonly string[];
	label: string;
}

const HELP_SECTIONS: readonly { title: string; hints: readonly HintSpec[] }[] = [
	{
		title: "Blocks",
		hints: [
			{ keys: ["j", "k", "down", "up"], label: "next / previous" },
			{ keys: ["gg", "G"], label: "first / last" },
			{ keys: ["]]", "[["], label: "your prompts" },
			{ keys: ["]t", "[t"], label: "tool blocks" },
			{ keys: ["ctrl+d", "ctrl+u"], label: "5 blocks" },
			{ keys: ["ctrl+f", "ctrl+b", "pageDown", "pageUp"], label: "10 blocks" },
			{ keys: ["V"], label: "select blocks" },
		],
	},
	{
		title: "Text cursor",
		hints: [
			{ keys: ["l", "right"], label: "expand the block, then enter" },
			{ keys: ["h", "h"], label: "at a line start: back to the block view" },
			{ keys: ["h", "left"], label: "in the block view: collapse it again" },
			{ keys: ["h", "j", "k", "l"], label: "move" },
			{ keys: ["w", "b", "e"], label: "words" },
			{ keys: ["0", "^", "$"], label: "line start / text / end" },
			{ keys: ["{", "}"], label: "previous / next block" },
		],
	},
	{
		title: "Select and copy",
		hints: [
			{ keys: ["v", "space"], label: "select text" },
			{ keys: ["V"], label: "select lines" },
			{ keys: ["o"], label: "swap ends" },
			{ keys: ["y"], label: "copy blocks or selected text" },
			{ keys: ["enter"], label: "copy in TEXT; expand / collapse in BLOCK" },
			{ keys: ["c"], label: "quote into the prompt" },
		],
	},
	{
		title: "Hints",
		hints: [
			{ keys: ["f"], label: "jump / open / copy" },
			{ keys: ["F"], label: "copy links and blocks" },
			{ keys: ["j", "k"], label: "while hinting: next / previous block" },
			{ keys: ["h", "l"], label: "while hinting: 5 blocks up / down" },
		],
	},
	{
		title: "View",
		hints: [
			{ keys: ["za", "tab"], label: "expand / collapse" },
			{ keys: ["zR", "zM"], label: "expand / collapse all" },
			{ keys: ["/"], label: "search forward, showing the match in TEXT as you type; Esc goes back" },
			{ keys: ["?"], label: "search backward (TEXT / VISUAL / V-LINE); help (BLOCK / V-BLOCK)" },
			{ keys: ["n", "N"], label: "next / previous match" },
			{ keys: ["zz", "zt"], label: "scroll to cursor / block top" },
		],
	},
	{
		title: "Prompt and leave",
		hints: [
			{ keys: ["i", "alt+k"], label: "return to the prompt (remembers position)" },
			{ keys: ["esc"], label: "back one step (twice in prompt reopens)" },
			{ keys: ["q"], label: "close" },
		],
	},
];

const HELP_NAMED_KEYS: Readonly<Record<string, string>> = {
	pageUp: "pgup",
	pageDown: "pgdn",
	up: "↑",
	down: "↓",
	left: "←",
	right: "→",
};

function helpKeyText(chord: string): string {
	if (HELP_NAMED_KEYS[chord]) return HELP_NAMED_KEYS[chord]!;
	if (chord.startsWith("shift+")) return chord.slice(6).toUpperCase();
	if (chord.startsWith("ctrl+")) return `⌃${chord.slice(5).toLowerCase()}`;
	if (chord.startsWith("alt+")) return `⌥${chord.slice(4).toLowerCase()}`;
	return chord;
}

/** Whether omp's accent sits in a 30°-wide HSL hue window centred on Tern's find amber (#f5b13d, hue 38°). */
function nearAmber(hex: string): boolean {
	if (!/^#[0-9a-f]{6}/i.test(hex)) return false;
	const n = Number.parseInt(hex.slice(1, 7), 16);
	const r = ((n >> 16) & 255) / 255;
	const g = ((n >> 8) & 255) / 255;
	const b = (n & 255) / 255;
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const d = max - min;
	const lightness = (max + min) / 2;
	const saturation = d === 0 ? 0 : d / (1 - Math.abs(2 * lightness - 1));
	if (saturation < 0.2) return false;
	let hue = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
	hue = (hue * 60 + 360) % 360;
	return Math.min(Math.abs(hue - 38), 360 - Math.abs(hue - 38)) < 15;
}

/** Normalize a pi-tui KeyEvent into vimnav's internal key token. */
export function keyEventName(key: KeyEvent): string | undefined {
	if (key.kind === "release") return undefined;
	switch (key.id) {
		case "escape":
			return "esc";
		case "enter":
		case "return":
			return "enter";
		case "tab":
		case "backspace":
		case "up":
		case "down":
		case "left":
		case "right":
		case "pageUp":
		case "pageDown":
		case "home":
		case "end":
		case "ctrl+c":
		case "ctrl+d":
		case "ctrl+u":
		case "ctrl+f":
		case "ctrl+b":
		case "alt+k":
			return key.id;
		case "space":
			return " ";
	}
	if (key.text !== undefined && graphemes(key.text).length === 1) return key.text;
	if (key.id.startsWith("shift+") && key.id.length === 7) return key.id.slice(6).toUpperCase();
	if (graphemes(key.id).length === 1) return key.id;
	return undefined;
}

/** Convert a plain TSP tree descriptor (used by hints.ts) into a live reactive pi-tui UiNode. */
export function treeToUiNode(node: TspTreeNode): UiNode {
	const props: Record<string, unknown> = { ...(node.p ?? {}) };
	if (node.key !== undefined) props.key = node.key;
	if (node.reveal !== undefined) props.reveal = node.reveal;
	if (node.c && node.c.length > 0) props.children = node.c.map(treeToUiNode);
	return jsx(node.k, props, node.key) as UiNode;
}

/** Strips SGR backgrounds and folds bright content foregrounds into normal slots, reserving 9–15 for the well. */
export function prepareWellRow(row: string): string {
	return row.replace(/\x1b\[([0-9;]*)m/g, (_seq, params: string) => {
		const p = params === "" ? ["0"] : params.split(";");
		const kept: string[] = [];
		for (let i = 0; i < p.length; i++) {
			const n = Number(p[i]);
			if (n === 48) {
				i += p[i + 1] === "2" ? 4 : 2;
				continue;
			}
			if (n === 38 || n === 58) {
				const len = p[i + 1] === "2" ? 5 : 3;
				if (n === 38 && p[i + 1] === "5" && Number(p[i + 2]) >= 9 && Number(p[i + 2]) <= 15) {
					kept.push("38", "5", String(Number(p[i + 2]) - 8));
				} else kept.push(...p.slice(i, i + len));
				i += len - 1;
				continue;
			}
			if ((n >= 40 && n <= 49) || (n >= 100 && n <= 107)) continue;
			kept.push(n >= 91 && n <= 97 ? String(n - 60) : p[i]!);
		}
		return kept.length > 0 ? `\x1b[${kept.join(";")}m` : "";
	});
}

/** Remember last cursor position per session so reopening returns where the user left off. */
const lastCursor = new Map<string, { blockId: string; newest: boolean; endInView: boolean }>();

export class ThreadNavigator {
	readonly #blocks: NavBlock[];
	readonly #host: NavigatorHost;
	readonly #rev = signal(0);
	#disposed = false;

	#curIndex = 0;
	#anchorIndex = 0;
	#mode: Mode = "block";
	#expanded = new Map<string, boolean>();
	#row = 0;
	#col = 0;
	#want = 0;
	#anchorRow = 0;
	#anchorCol = 0;
	#endInView = false;
	#leftLine: { blockId: string; row: number; col: number } | undefined;
	#atBorder = false;
	#rowCache = new Map<string, Rows>();

	#revealN = 1;
	#revealStart = false;
	#topN = -1;
	#topScheduled = -1;

	#count = "";
	#pending = "";
	#search: { typing: boolean; query: string; shown: boolean; current: number } = {
		typing: false,
		query: "",
		shown: false,
		current: -1,
	};
	#matches: (Occurrence & { idx: number; row: number })[] = [];
	#matchQuery: string | undefined;
	#matchSources: readonly (readonly string[])[] = [];
	#searchDir = 1;
	#previousSearch:
		| {
				state: { typing: boolean; query: string; shown: boolean; current: number };
				dir: number;
				mode: Mode;
				blockId: string | undefined;
				pos: Pos;
				leftLine: { blockId: string; row: number; col: number } | undefined;
				endInView: boolean;
				want: number;
		  }
		| undefined;

	#help: { current: string; query: string } | undefined;
	#hint: HintSession | undefined;
	#hintN = 0;
	#message = "";

	constructor(blocks: NavBlock[], host: NavigatorHost) {
		this.#blocks = blocks;
		this.#host = host;
		const last = Math.max(0, blocks.length - 1);
		const key = host.sessionKey ?? "default";
		const before = lastCursor.get(key);
		const at = before && !before.newest ? blocks.findIndex(b => b.id === before.blockId) : -1;
		this.#curIndex = at >= 0 ? at : last;
		this.#endInView = at < 0 || before?.endInView === true;
		this.#anchorIndex = this.#curIndex;
		this.#scheduleTopReveal(this.#revealN);
	}

	/** Current state snapshot (useful for tests and status display). */
	get state(): {
		mode: Mode;
		curIndex: number;
		row: number;
		col: number;
		message: string;
		hintActive: boolean;
		helpOpen: boolean;
		searchShown: boolean;
		searchQuery: string;
		matchCount: number;
	} {
		return {
			mode: this.#mode,
			curIndex: this.#curIndex,
			row: this.#row,
			col: this.#col,
			message: this.#message,
			hintActive: this.#hint !== undefined,
			helpOpen: this.#help !== undefined,
			searchShown: this.#search.shown,
			searchQuery: this.#search.query,
			matchCount: this.#matches.length,
		};
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		const cur = this.#cur();
		if (cur) {
			lastCursor.set(this.#host.sessionKey ?? "default", {
				blockId: cur.id,
				newest: this.#curIndex === this.#blocks.length - 1,
				endInView: this.#endInView,
			});
		}
	}

	/** Build the root pi-tui view for `ctx.ui.custom(..., { overlay: true, fullscreen: true })`. */
	buildView(): UiNode {
		const onKey = (key: KeyEvent): boolean => this.handleKey(key);
		const onAction = (act: string): void => this.handleAction(act);
		if (nativeRendering()) {
			return jsx(
				"overlay",
				{
					key: "vimnav",
					size: "full",
					role: "omp.app.screen",
					// Use Tern's native `omp.rewind` page role so the reading column, typography,
					// `mark: "pick"` accent rail, `omp.rewind.here` caption, and floating `omp.rewind.bar`
					// dock match omp's built-in Rewind screen natively.
					page: { role: "omp.rewind", dock: 1 },
					onKey,
					onAction,
					children: [
						// Stable first child keeps `ctx.ui.custom`'s focus anchored so every key reaches `onKey`.
						jsx("col", { key: "vimnav-focus", role: "omp.vimnav.focus", hidden: true }, "vimnav-focus"),
						() => {
							this.#rev();
							return this.#buildNativeMain();
						},
						// Direct `omp.rewind.bar` row as the lone `dock: 1` child so Tern styles it as the floating pill bar.
						jsx(
							"row",
							{
								key: "vimnav-bar",
								role: "omp.rewind.bar",
								align: "center",
								gap: "md",
								wrap: true,
								children: () => {
									this.#rev();
									return this.#buildNativeDockContent();
								},
							},
							"vimnav-bar",
						),
					],
				},
				"vimnav",
			) as UiNode;
		}
		return jsx(
			"col",
			{
				key: "vimnav-term",
				gap: "none",
				onKey,
				onAction,
				children: () => {
					this.#rev();
					return this.#buildTerminalView();
				},
			},
			"vimnav-term",
		) as UiNode;
	}

	handleKey(key: KeyEvent): boolean {
		if (this.#disposed) return false;
		const k = keyEventName(key);
		if (k === undefined) return true;
		if (k === "alt+k") {
			this.#host.close();
			return true;
		}
		this.#message = "";
		this.#dispatchKey(k, key.text);
		this.#bump();
		return true;
	}

	handleAction(act: string): void {
		if (this.#disposed) return;
		if (act === "vimnav.find.prev" || act === "vimnav.find.next") {
			this.#search.typing = false;
			this.#message = "";
			this.#findNext(act === "vimnav.find.prev" ? -this.#searchDir : this.#searchDir, 1);
			this.#bump();
		} else if (act === "vimnav.close") {
			this.#host.close();
		} else if (act === "vimnav.yank") {
			this.#message = "";
			this.#yank();
			this.#bump();
		} else if (act === "vimnav.text") {
			this.#message = "";
			if (!this.#lineMode()) this.#drillIn();
			else this.#leaveLine();
			this.#bump();
		} else if (act === "vimnav.quote") {
			this.#message = "";
			this.#quote();
			this.#bump();
		} else if (act.startsWith("vimnav.pick:")) {
			const idx = Number.parseInt(act.slice("vimnav.pick:".length), 10);
			if (Number.isInteger(idx) && idx >= 0 && idx < this.#blocks.length) {
				this.#message = "";
				this.#goto(idx);
				this.#bump();
			}
		}
	}

	#bump(): void {
		this.#rev.set(this.#rev.peek() + 1);
	}

	#cur(): NavBlock | undefined {
		return this.#blocks[this.#curIndex];
	}

	#isExpanded(block: NavBlock): boolean {
		return this.#expanded.get(block.id) ?? this.#host.getToolsExpanded();
	}

	#accentHex(): string {
		try {
			return this.#host.theme().hex("accent");
		} catch {
			return "#60a5fa";
		}
	}

	#rowsOf(block: NavBlock): Rows {
		const cols = Math.max(20, Math.min(this.#host.size().columns || FALLBACK_COLS, READER_COLS) - 5);
		const expanded = this.#isExpanded(block);
		const cached = this.#rowCache.get(block.id);
		if (cached && cached.cols === cols && cached.expanded === expanded) return cached;
		const raw = block.renderRows(cols, expanded, this.#host.theme());
		const plain = raw.map(r => Bun.stripANSI(r).trimEnd());
		const clusters = plain.map(graphemes);
		const entry: Rows = {
			cols,
			expanded,
			raw,
			rows: raw.map(prepareWellRow),
			plain,
			clusters,
			len: clusters.map(c => c.length),
		};
		this.#rowCache.set(block.id, entry);
		return entry;
	}

	#normalisePositions(): void {
		const cur = this.#cur();
		if (this.#lineMode() && cur) {
			const rows = this.#rowsOf(cur);
			this.#row = Math.min(this.#row, Math.max(0, rows.rows.length - 1));
			this.#col = Math.min(this.#col, Math.max(0, (rows.len[this.#row] ?? 0) - 1));
			const anchor = this.#blocks[this.#anchorIndex];
			if (anchor) {
				const aRows = this.#rowsOf(anchor);
				this.#anchorRow = Math.min(this.#anchorRow, Math.max(0, aRows.rows.length - 1));
				this.#anchorCol = Math.min(this.#anchorCol, Math.max(0, (aRows.len[this.#anchorRow] ?? 0) - 1));
			}
		}
	}

	#scheduleTopReveal(n: number): void {
		if (this.#revealStart || this.#topScheduled === n) return;
		this.#topScheduled = n;
		setTimeout(() => {
			if (this.#disposed || this.#revealN !== n) return;
			this.#topN = n;
			this.#bump();
		}, TOP_REVEAL_DELAY_MS);
	}

	// ── Native Tern rendering (`omp.rewind` style) ──────────────────────────

	#buildBlockCaption(block: NavBlock, lo: number, hi: number, revealObj: { at: "start" | "nearest"; n: number }): UiNode {
		const symbols = this.#host.theme().symbols;
		const dot = symbols.symbol("sep.dot") || " · ";
		const spans: { t: string; s?: string }[] = [];
		const mode = this.#hint ? (this.#hint.copy ? "HINT · COPY" : "HINT") : MODE_LABEL[this.#mode];
		spans.push({ t: "▸ ", s: "accent" });
		spans.push({ t: `${mode} `, s: "accent strong" });
		if (this.#mode === "vblock" && !this.#hint) {
			const count = hi - lo + 1;
			spans.push({ t: `${dot}${count} ${count === 1 ? "block" : "blocks"} selected`, s: "dim" });
			spans.push({ t: `${dot}y copy${dot}c quote${dot}o swap`, s: "dim" });
		} else {
			spans.push({ t: `${dot}${block.label}`, s: "dim" });
			if (this.#message) {
				spans.push({ t: `${dot}${this.#message}`, s: "accent" });
			} else if (block.collapsible && !this.#isExpanded(block)) {
				spans.push({ t: `${dot}→ expand${dot}y copy${dot}c quote`, s: "dim" });
			} else {
				spans.push({ t: `${dot}→ text cursor${dot}y copy${dot}c quote`, s: "dim" });
			}
		}
		return treeToUiNode({
			k: "text",
			key: `vimnav-here:${block.id}`,
			reveal: this.#revealStart ? revealObj : this.#topN === this.#revealN ? { at: "nearest", n: this.#topN } : undefined,
			p: { role: "omp.rewind.here", wrap: "none", spans },
		});
	}

	#buildNativeMain(): JSXNode[] {
		this.#normalisePositions();
		if (this.#blocks.length === 0) {
			return [
				jsx(
					"text",
					{
						key: "vimnav-empty",
						role: "omp.rewind.empty",
						spans: [{ t: "No messages in this thread yet — press Esc or q to close", s: "muted" }],
					},
					"vimnav-empty",
				),
			];
		}

		const hint = this.#hint;
		const sel = this.#mode === "visual" || this.#mode === "vline" ? this.#selection() : undefined;
		const ranged = sel !== undefined || this.#mode === "vblock";
		const lo = ranged ? Math.min(this.#anchorIndex, this.#curIndex) : this.#curIndex;
		const hi = ranged ? Math.max(this.#anchorIndex, this.#curIndex) : this.#curIndex;
		const textMode = !hint && this.#lineMode();
		if (textMode && this.#search.shown && this.#search.query) this.#collectMatches();

		const accentAmber = nearAmber(this.#accentHex());
		const chipMode = MODE_LABEL[this.#mode];
		const out: JSXNode[] = [];

		// Precompute hint label lookup per block when hint mode is active.
		const hintByBlock = new Map<string, { own: string; inner: Map<string, string> }>();
		if (hint) {
			for (const item of hint.items) {
				if (!item.label.startsWith(hint.typed)) continue;
				let entry = hintByBlock.get(item.block.id);
				if (!entry) {
					entry = { own: "", inner: new Map() };
					hintByBlock.set(item.block.id, entry);
				}
				if (item.target.action.kind === "block") entry.own = item.label;
				else entry.inner.set(item.target.id, item.label);
			}
		}

		const revealObj = { at: this.#revealStart ? ("start" as const) : ("nearest" as const), n: this.#revealN };

		for (let idx = 0; idx < this.#blocks.length; idx++) {
			const block = this.#blocks[idx]!;
			const selected = idx === this.#curIndex;
			const inRange = idx >= lo && idx <= hi;
			const blockHints = hintByBlock.get(block.id);
			const well = textMode && inRange;

			if (!well) {
				// Rewind-style caption right above the active block (or start of a V-BLOCK range).
				if (selected && !hint) {
					out.push(this.#buildBlockCaption(block, lo, hi, revealObj));
				}
				// Keep invisible hint anchor marker ONLY while hint tags are displayed so vimnav.css hint selectors apply.
				if (blockHints) {
					out.push(
						treeToUiNode({
							k: "col",
							key: `vimnav-hint-at-${block.id}`,
							p: { role: "omp.vimnav.at", aria: "vimnav hint", gap: "none" },
						}),
					);
				}

				let tree = block.describe(this.#isExpanded(block));
				if (blockHints && hint) {
					if (blockHints.inner.size > 0) tree = decorate(tree, blockHints.inner, hint.typed) as TspTreeNode;
					if (blockHints.own) {
						tree = (labelBlock(tree, blockHints.own, hint.typed, selected) as TspTreeNode | undefined) ?? tree;
					}
				}

				// Apply Tern's native `mark: "pick"` (the crisp vertical accent rail from Rewind)
				// and click-to-select on blocks without their own click handler.
				const props: Record<string, unknown> = { ...(tree.p ?? {}) };
				if (inRange && !hint) props.mark = "pick";
				else if (selected && hint) props.mark = "pick";
				if (!props.actions) props.actions = { click: `vimnav.pick:${idx}` };
				const markedTree: TspTreeNode = { ...tree, p: props };
				out.push(treeToUiNode(markedTree));

				if (selected) {
					const bottomReveal = !this.#revealStart ? revealObj : undefined;
					out.push(
						treeToUiNode({
							k: "col",
							key: "vimnav-end",
							p: { role: "omp.vimnav.end", gap: "none" },
							...(bottomReveal ? { reveal: bottomReveal } : {}),
						}),
					);
					if (bottomReveal) this.#scheduleTopReveal(this.#revealN);
				}
				continue;
			}

			// TEXT / VISUAL / V-LINE code well for blocks in range (aligned cleanly inside the reading column).
			const rows = this.#rowsOf(block);
			const row = selected ? Math.min(this.#row, Math.max(0, rows.rows.length - 1)) : -1;
			const lines = this.#rowTexts(rows, idx, row, sel);
			const wellKey = `vimnav:${block.id}`;
			const wellWords = ["vimnav", "text"];
			if (selected) wellWords.push("cur");
			if (accentAmber) wellWords.push("fv");

			const rowNodes: TspTreeNode[] = lines.map((text, r) => {
				const isCursor = selected && r === row;
				const isSel = this.#mode === "vline" && sel !== undefined && this.#spanAt(sel, idx, r, rows.len[r] ?? 0) !== undefined;
				const role = `omp.vimnav.row${isCursor ? ".cur" : ""}${isSel ? ".sel" : ""}`;
				const rNode: TspTreeNode = { k: "ansi", key: `r${r}`, p: { text, role } };
				if (isCursor && !(this.#revealStart && row === 0)) rNode.reveal = revealObj;
				return rNode;
			});

			const wellNode: TspTreeNode = {
				k: "col",
				key: wellKey,
				p: { gap: "none", role: "omp.vimnav.text", aria: wellWords.join(" "), mark: "pick" },
				...(selected && (row < 0 || (this.#revealStart && row === 0)) ? { reveal: revealObj } : {}),
				c: [
					{
						k: "col",
						p: { gap: "none", role: "omp.vimnav.well" },
						c: [
							{
								k: "row",
								p: { gap: "sm", align: "center", role: "omp.vimnav.well-head" },
								c: [
									{ k: "text", p: { text: chipMode, role: "omp.vimnav.chip" } },
									{ k: "text", p: { text: block.label, role: "omp.vimnav.kind" } },
									{ k: "row", p: { grow: 1 } },
									{
										k: "text",
										p: {
											text: selected
												? `row ${row + 1}/${rows.rows.length} · col ${this.#col + 1}`
												: `rows ${rows.rows.length}`,
											role: "omp.vimnav.pos",
										},
									},
								],
							},
							{ k: "col", key: "rows", p: { gap: "none", role: "omp.vimnav.rows" }, c: rowNodes },
						],
					},
				],
			};
			out.push(treeToUiNode(wellNode));
		}

		// Hoisted overlays live inside `main` so `dock: 1` stays the pure `omp.rewind.bar` row;
		// pi-tui's reconciler automatically hoists `overlay` nodes into the screen's `layer` region.
		if (this.#search.shown) out.push(this.#buildFindOverlay());
		if (this.#help) out.push(this.#buildHelpOverlay(this.#help.current, this.#help.query));

		return out;
	}

	/** Rewind-style floating pill bar content: title, counter/message, `<kbd>` hints, and pill action buttons. */
	#buildNativeDockContent(): JSXNode[] {
		const { mode, pos, isMessage } = this.#statusSnapshot();

		const kbdHint = (key: string, keys: readonly (readonly string[])[], label: string): JSXNode =>
			jsx(
				"row",
				{
					key,
					align: "center",
					gap: "xs",
					children: [
						...keys.map((chord, i) => jsx("kbd", { key: `k${i}`, keys: chord }, `k${i}`)),
						jsx("text", { key: "lbl", spans: [{ t: label, s: "muted" }] }, "lbl"),
					],
				},
				key,
			);

		const actionButton = (
			key: string,
			act: string,
			label: string,
			keys: readonly string[],
			primary = false,
		): JSXNode => {
			if (nativeSupports("button")) {
				return jsx(
					"button",
					{
						key,
						role: "omp.btn",
						text: label,
						actions: { click: act },
						keys,
						...(primary ? { variant: "primary", tone: "accent" } : {}),
					},
					key,
				);
			}
			return jsx(
				"row",
				{
					key,
					role: "omp.btn",
					align: "center",
					gap: "xs",
					actions: { click: act },
					...(primary ? { tone: "accent" } : {}),
					children: [
						jsx("text", { text: label }),
						...(keys.length > 0 ? [jsx("kbd", { keys })] : []),
					],
				},
				key,
			);
		};

		const hints: JSXNode[] = this.#lineMode()
			? [
					kbdHint("h-move", [["h"], ["j"], ["k"], ["l"]], "move"),
					kbdHint("h-sel", [["v"], ["V"]], "select"),
					kbdHint("h-search", [["/"]], "search"),
					kbdHint("h-back", [["escape"]], "blocks"),
				]
			: this.#hint
				? [
						kbdHint("h-move", [["up"], ["down"]], "move"),
						kbdHint("h-back", [["escape"]], "cancel"),
					]
				: [
						kbdHint("h-step", [["up"], ["down"]], "step"),
						kbdHint("h-text", [["right"]], "text"),
						kbdHint("h-sel", [["V"]], "select"),
						kbdHint("h-search", [["/"]], "search"),
						kbdHint("h-hints", [["f"]], "hints"),
						kbdHint("h-help", [["?"]], "keys"),
					];

		const primaryLabel = this.#lineMode()
			? this.#mode === "line"
				? "Copy line"
				: "Copy selection"
			: this.#mode === "vblock"
				? "Copy blocks"
				: "Copy block";

		return [
			jsx(
				"text",
				{
					key: "title",
					spans: [
						{ t: "▸ ", s: "accent" },
						{ t: mode, s: "strong" },
					],
					wrap: "none",
				},
				"title",
			),
			jsx(
				"text",
				{
					key: "pos",
					spans: [{ t: pos, s: isMessage ? "accent" : "dim" }],
					wrap: "none",
				},
				"pos",
			),
			jsx(
				"row",
				{
					key: "hints",
					gap: "md",
					role: "omp.overlay.hints",
					wrap: true,
					children: hints,
				},
				"hints",
			),
			jsx(
				"row",
				{
					key: "actions",
					align: "center",
					gap: "sm",
					role: "omp.actions",
					children: [
						jsx("spacer", { key: "sp", grow: 1 }, "sp"),
						actionButton("close", "vimnav.close", "Close", ["escape"]),
						actionButton("yank", "vimnav.yank", primaryLabel, ["y"], true),
					],
				},
				"actions",
			),
		];
	}

	#buildFindOverlay(): UiNode {
		this.#collectMatches();
		const count = this.#matches.length;
		const current = this.#search.current;
		const text = count === 0 ? "No matches" : current < 0 ? `${count} matches` : `${current + 1} of ${count}`;
		return treeToUiNode({
			k: "overlay",
			key: "vimnav-find",
			p: { role: "omp.vimnav.find", anchor: "top", size: "sm" },
			c: [
				{
					k: "row",
					p: { role: "omp.vimnav.find-bar", align: "center", gap: "none" },
					c: [
						{ k: "icon", p: { name: "search" } },
						{
							k: "row",
							p: { role: "omp.vimnav.find-q", gap: "none", align: "center" },
							c: [
								{ k: "text", p: { text: this.#search.query } },
								...(this.#search.typing ? [{ k: "text", p: { text: "", role: "omp.vimnav.find-caret" } }] : []),
							],
						},
						{ k: "text", p: { role: count ? "omp.vimnav.find-n" : "omp.vimnav.find-n.none", text } },
						{
							k: "row",
							p: { role: "omp.vimnav.find-btn", title: "Previous match · N", actions: { click: "vimnav.find.prev" } },
							c: [{ k: "icon", p: { name: "arrow-up" } }],
						},
						{
							k: "row",
							p: { role: "omp.vimnav.find-btn", title: "Next match · n", actions: { click: "vimnav.find.next" } },
							c: [{ k: "icon", p: { name: "arrow-down" } }],
						},
					],
				},
			],
		});
	}

	#buildHelpOverlay(current: string, queryRaw: string): UiNode {
		const query = queryRaw.toLowerCase();
		const pattern = query ? new RegExp(queryRaw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu") : undefined;
		const spans = (text: string): { t: string; s?: string }[] => {
			if (!pattern) return [{ t: text }];
			const out: { t: string; s?: string }[] = [];
			let end = 0;
			for (const match of text.matchAll(pattern)) {
				const start = match.index;
				if (start > end) out.push({ t: text.slice(end, start) });
				out.push({ t: match[0]!, s: "mark" });
				end = start + match[0]!.length;
			}
			if (end < text.length) out.push({ t: text.slice(end) });
			return out;
		};
		const ordered = [
			...HELP_SECTIONS.filter(s => s.title === current),
			...HELP_SECTIONS.filter(s => s.title !== current),
		];
		let count = 1;
		const groups: TspTreeNode[] = ordered.map((s, n) => {
			const hints = s.hints.filter(
				h => !query || h.label.toLowerCase().includes(query) || h.keys.some(k => helpKeyText(k).toLowerCase().includes(query)),
			);
			count += hints.reduce((total, h) => total + h.keys.length, 0);
			const now = s.title === current;
			return {
				k: "col",
				p: { role: "omp.vimnav.help-group", hidden: hints.length === 0 },
				key: `s${n}`,
				c: [
					{
						k: "row",
						p: { role: "omp.vimnav.help-group-head", align: "center" },
						key: "head",
						c: [
							{ k: "text", p: { role: now ? "omp.vimnav.help-group-title.now" : "omp.vimnav.help-group-title", spans: [{ t: s.title }] }, key: "title" },
							...(now ? [{ k: "text", p: { role: "omp.vimnav.help-now", spans: [{ t: "Now" }] }, key: "now" }] : []),
						],
					},
					...hints.map((h, i) => ({
						k: "row",
						p: { role: "omp.vimnav.help-row" },
						key: `r${i}`,
						c: [
							{
								k: "row",
								p: { role: "omp.vimnav.help-keys" },
								key: "keys",
								c: h.keys.map((k, j) => ({ k: "text", p: { role: "omp.vimnav.key", spans: spans(helpKeyText(k)) }, key: `k${j}` })),
							},
							{ k: "text", p: { role: "omp.vimnav.help-label", spans: spans(h.label) }, key: "label" },
						],
					})),
				],
			};
		});

		return treeToUiNode({
			k: "overlay",
			key: "vimnav-help",
			p: { role: "omp.overlay.vimnav-help", anchor: "center", size: "lg", modal: true },
			c: [
				{
					k: "col",
					p: { role: "omp.vimnav.help" },
					key: "help",
					c: [
						{
							k: "row",
							p: { role: "omp.vimnav.help-head", align: "center" },
							key: "head",
							c: [
								{ k: "icon", p: { name: "keyboard" }, key: "icon" },
								{ k: "text", p: { role: "omp.vimnav.help-title", spans: [{ t: "vimnav keys" }] }, key: "title" },
								{ k: "spacer", p: { grow: 1 }, key: "gap" },
								{ k: "text", p: { role: "omp.vimnav.help-count", spans: [{ t: `${count} keys` }] }, key: "count" },
								{ k: "text", p: { role: "omp.vimnav.key", spans: [{ t: "esc" }] }, key: "esc" },
								{
									k: "row",
									p: { role: "omp.vimnav.help-search", align: "center" },
									key: "search",
									c: [
										{
											k: "text",
											p: { spans: [{ t: queryRaw || "Type a key or action", ...(queryRaw ? {} : { s: "muted" }) }] },
											key: "query",
										},
										...(queryRaw ? [{ k: "text", p: { role: "omp.vimnav.help-caret", spans: [{ t: "" }] }, key: "caret" }] : []),
									],
								},
							],
						},
						{
							k: "row",
							p: { role: "omp.vimnav.help-body" },
							key: "body",
							c: [0, 1, 2].map(n => ({
								k: "col",
								p: { role: "omp.vimnav.help-column", grow: 1 },
								key: `col${n}`,
								c: groups.slice(n * 2, n * 2 + 2),
							})),
						},
						{ k: "text", p: { role: "omp.vimnav.help-foot", spans: [{ t: "Case matters: zR and zM differ" }] }, key: "foot" },
					],
				},
			],
		});
	}

	// ── Plain-terminal fallback rendering ───────────────────────────────────

	#buildTerminalView(): JSXNode[] {
		this.#normalisePositions();
		const { rows: screenRows, columns: screenCols } = this.#host.size();
		const bodyHeight = Math.max(4, screenRows - 3);
		const { mode, pos } = this.#statusSnapshot();
		const out: JSXNode[] = [];

		out.push(
			jsx("row", {
				key: "term-head",
				gap: "sm",
				children: [
					jsx("text", { spans: [{ t: ` ${mode} `, s: "strong accent inverse" }] }),
					jsx("text", { spans: [{ t: pos, s: "muted" }] }),
				],
			}),
		);

		const cur = this.#cur();
		if (!cur) {
			out.push(jsx("text", { spans: [{ t: "No blocks in transcript — press Esc or q to close", s: "muted" }] }));
			return out;
		}

		if (this.#lineMode()) {
			const sel = this.#mode === "visual" || this.#mode === "vline" ? this.#selection() : undefined;
			const rows = this.#rowsOf(cur);
			const lines = this.#rowTexts(rows, this.#curIndex, this.#row, sel);
			const start = Math.max(0, Math.min(this.#row - Math.floor(bodyHeight / 2), Math.max(0, lines.length - bodyHeight)));
			const slice = lines.slice(start, start + bodyHeight);
			out.push(jsx("ansi", { key: "term-text", text: slice.join("\n") }));
		} else {
			const lo = this.#mode === "vblock" ? Math.min(this.#anchorIndex, this.#curIndex) : this.#curIndex;
			const hi = this.#mode === "vblock" ? Math.max(this.#anchorIndex, this.#curIndex) : this.#curIndex;
			const start = Math.max(0, Math.min(this.#curIndex - Math.floor(bodyHeight / 2), Math.max(0, this.#blocks.length - bodyHeight)));
			const visible = this.#blocks.slice(start, start + bodyHeight);
			for (let i = 0; i < visible.length; i++) {
				const idx = start + i;
				const b = visible[i]!;
				const isCur = idx === this.#curIndex;
				const inRange = idx >= lo && idx <= hi;
				const preview = b.text(this.#isExpanded(b)).split("\n")[0]?.slice(0, Math.max(20, screenCols - 20)) ?? "";
				const prefix = isCur ? "▶ " : inRange ? "│ " : "  ";
				out.push(
					jsx("text", {
						key: `tb-${idx}`,
						spans: [
							{ t: prefix, s: isCur ? "accent strong" : "muted" },
							{ t: `[${b.label}] `, s: isCur ? "strong accent" : "muted" },
							{ t: preview, s: isCur ? "strong" : undefined },
						],
					}),
				);
			}
		}

		const footer = this.#search.typing
			? `/${this.#search.query}▏`
			: "j/k/↑↓ move · l/→ text · v/V select · y copy · c quote · / search · q close";
		out.push(jsx("text", { key: "term-foot", spans: [{ t: footer, s: "dim" }] }));
		return out;
	}

	// ── TEXT row painting ───────────────────────────────────────────────────

	#rowTexts(rows: Rows, idx: number, cursorRow: number, sel: { a: Pos; b: Pos } | undefined): string[] {
		return rows.rows.map((text, r) => {
			const span = this.#mode === "visual" && sel ? this.#spanAt(sel, idx, r, rows.len[r] ?? 0) : undefined;
			const cursor = r === cursorRow;
			const paints: { from: number; to: number; sgr: string }[] = [];
			if (span) {
				if (!cursor) paints.push({ from: span[0], to: span[1], sgr: "105" });
				else {
					if (span[0] < this.#col) paints.push({ from: span[0], to: Math.min(span[1], this.#col), sgr: "105" });
					paints.push({ from: this.#col, to: this.#col + 1, sgr: "103;94" });
					if (span[1] > this.#col + 1) paints.push({ from: Math.max(span[0], this.#col + 1), to: span[1], sgr: "105" });
				}
			} else if (cursor) paints.push({ from: this.#col, to: this.#col + 1, sgr: "103;94" });
			if (this.#search.shown && this.#search.query) {
				const current = this.#matches[this.#search.current];
				const extra: { from: number; to: number; sgr: string }[] = [];
				for (const hit of this.#matches) {
					if (hit.idx !== idx || hit.row !== r) continue;
					const sgr = hit === current ? "107" : "106";
					let at = hit.from;
					for (const paint of paints) {
						if (paint.to <= at || paint.from >= hit.to) continue;
						if (at < paint.from) extra.push({ from: at, to: paint.from, sgr });
						at = Math.max(at, paint.to);
					}
					if (at < hit.to) extra.push({ from: at, to: hit.to, sgr });
				}
				paints.push(...extra);
				paints.sort((a, b) => a.from - b.from);
			}
			const number = Math.min(999, cursor || cursorRow < 0 ? r + 1 : Math.abs(r - cursorRow));
			const gutter = `\x1b[${cursor ? "1;92" : "91"}m${String(number).padStart(3)}\x1b[22;39m  `;
			return gutter + paintCells(text, paints);
		});
	}

	// ── Key handling ────────────────────────────────────────────────────────

	#dispatchKey(k: string, rawText?: string): void {
		if (this.#help) {
			if (k === "esc" || k === "enter") {
				this.#help = undefined;
				return;
			}
			if (k === "backspace") {
				this.#help.query = graphemes(this.#help.query).slice(0, -1).join("");
				return;
			}
			if (rawText !== undefined && rawText.length > 0) this.#help.query += rawText;
			else if (graphemes(k).length === 1) this.#help.query += k;
			return;
		}

		const atBorder = this.#atBorder;
		this.#atBorder = false;
		if (this.#hint) return this.#hintKey(k);
		if (this.#search.typing) return this.#searchKey(k);
		if (k === "ctrl+c") return this.#host.close();

		if (this.#pending) {
			const seq = this.#pending + k;
			this.#pending = "";
			return this.#sequence(seq);
		}
		if (/^[1-9]$/.test(k) || (k === "0" && this.#count)) {
			this.#count = String(Math.min(9999, Number(this.#count + k)));
			return;
		}
		if (SEQ_PREFIXES[k]) {
			this.#pending = k;
			return;
		}
		const n = this.#takeCount();
		const line = this.#lineMode();
		switch (k) {
			case "j":
			case "down":
				return line ? this.#moveRow(n.value) : this.#goto(this.#curIndex + n.value);
			case "k":
			case "up":
				return line ? this.#moveRow(-n.value) : this.#goto(this.#curIndex - n.value);
			case "}":
				return this.#goto(this.#curIndex + n.value);
			case "{":
				return this.#goto(this.#curIndex - n.value);
			case "G":
			case "end":
				if (line) return this.#setRow(n.given ? n.value - 1 : Number.POSITIVE_INFINITY);
				return this.#goto(n.given ? n.value - 1 : this.#blocks.length - 1);
			case "home":
				return line ? this.#setRow(0) : this.#goto(0);
			case "h":
			case "left":
				if (!line) {
					if (this.#mode === "vblock") this.#mode = "block";
					else this.#collapse();
					return;
				}
				if (this.#col > 0) return this.#setCol(this.#col - n.value);
				if (atBorder) {
					this.#leaveLine();
					return;
				}
				this.#atBorder = true;
				this.#message = "h again for the block view";
				return;
			case "l":
			case "right":
				return line ? this.#setCol(this.#col + n.value) : this.#drillIn();
			case "w":
			case "b":
			case "e":
				if (line) for (let t = 0; t < n.value; t++) if (!this.#word(k)) break;
				return;
			case "0":
				if (line) this.#setCol(0);
				return;
			case "$":
				if (line) this.#setCol(Number.POSITIVE_INFINITY);
				return;
			case "^": {
				const cur = this.#cur();
				if (line && cur) this.#setCol(firstNonBlank(this.#rowsOf(cur).plain[this.#row] ?? ""));
				return;
			}
			case "v":
			case " ":
				return this.#select("visual");
			case "V":
				return line ? this.#select("vline") : this.#visualBlock();
			case "esc":
				if (this.#search.shown) {
					this.#search.shown = false;
					return;
				}
				return this.#back();
			case "o":
				return this.#swap();
			case "y":
				return this.#yank();
			case "f":
			case "F":
				return this.#startHints(k === "F");
			case "c":
				return this.#quote();
			case "enter":
				return line ? this.#yank() : this.#toggleExpand();
			case "tab":
				return this.#toggleExpand();
			case "/":
				return this.#startSearch(1);
			case "?":
				if (line) return this.#startSearch(-1);
				this.#help = {
					current: this.#mode === "block" || this.#mode === "vblock" ? "Blocks" : "Text cursor",
					query: "",
				};
				return;
			case "n":
				return this.#findNext(this.#searchDir, n.value);
			case "N":
				return this.#findNext(-this.#searchDir, n.value);
			case "ctrl+f":
			case "ctrl+b":
			case "pageDown":
			case "pageUp": {
				const dir = k === "ctrl+f" || k === "pageDown" ? 1 : -1;
				if (line) return this.#moveRow(dir * Math.max(1, this.#host.size().rows) * n.value);
				return this.#goto(this.#curIndex + dir * PAGE * 2 * n.value);
			}
			case "ctrl+d":
			case "ctrl+u": {
				const dir = k === "ctrl+d" ? 1 : -1;
				if (line) return this.#moveRow(dir * Math.max(1, Math.floor(this.#host.size().rows / 2)) * n.value);
				return this.#goto(this.#curIndex + dir * PAGE * n.value);
			}
			case "q":
			case "i":
				return this.#host.close();
		}
	}

	#sequence(seq: string): void {
		const n = this.#takeCount();
		switch (seq) {
			case "gg":
				if (this.#lineMode()) return this.#setRow(n.given ? n.value - 1 : 0);
				return this.#goto(n.given ? n.value - 1 : 0);
			case "]]":
				return this.#jumpKind("user", n.value);
			case "[[":
				return this.#jumpKind("user", -n.value);
			case "]t":
				return this.#jumpKind("tool", n.value);
			case "[t":
				return this.#jumpKind("tool", -n.value);
			case "za":
				return this.#toggleExpand();
			case "zo":
				return this.#setExpanded(true);
			case "zc":
				return this.#setExpanded(false);
			case "zR":
			case "zM": {
				const on = seq === "zR";
				this.#host.setToolsExpanded(on);
				this.#expanded.clear();
				this.#rowCache.clear();
				this.#message = on ? "expanded all" : "collapsed all";
				return;
			}
			case "zz":
			case "zt":
				this.#revealStart = seq === "zt";
				if (seq === "zt") this.#endInView = false;
				this.#revealN++;
				return;
		}
	}

	#takeCount(): { value: number; given: boolean } {
		const given = this.#count !== "";
		const value = given ? Math.min(9999, Math.max(1, Number.parseInt(this.#count, 10))) : 1;
		this.#count = "";
		return { value, given };
	}

	// ── Search ──────────────────────────────────────────────────────────────

	#startSearch(dir: number): void {
		this.#previousSearch = {
			state: { ...this.#search },
			dir: this.#searchDir,
			mode: this.#mode,
			blockId: this.#cur()?.id,
			pos: { idx: this.#curIndex, row: this.#row, col: this.#col },
			leftLine: this.#leftLine,
			endInView: this.#endInView,
			want: this.#want,
		};
		this.#searchDir = dir;
		this.#search = { typing: true, query: "", shown: true, current: -1 };
	}

	#searchKey(k: string): void {
		const start = this.#previousSearch;
		if (k === "esc") {
			if (start) {
				this.#search = start.state;
				this.#searchDir = start.dir;
				this.#returnToSearchStart();
			}
			return;
		}
		if (k === "enter") {
			if (!this.#search.query) this.#search.query = start?.state.query ?? "";
			this.#incsearch(false);
			this.#search.typing = false;
			return;
		}
		if (k === "backspace") this.#search.query = graphemes(this.#search.query).slice(0, -1).join("");
		else if (graphemes(k).length === 1) this.#search.query += k;
		else return;
		this.#incsearch(true);
	}

	#incsearch(quiet: boolean): void {
		this.#returnToSearchStart();
		this.#search.current = -1;
		if (this.#search.query) this.#findNext(this.#searchDir, 1, quiet);
	}

	#returnToSearchStart(): void {
		const start = this.#previousSearch;
		if (!start || this.#blocks.length === 0) return;
		const idx = start.blockId ? this.#blocks.findIndex(b => b.id === start.blockId) : -1;
		this.#mode = start.mode;
		this.#place(idx >= 0 ? idx : Math.min(start.pos.idx, this.#blocks.length - 1), start.pos.row, start.pos.col);
		this.#leftLine = start.leftLine;
		this.#endInView = start.endInView;
		this.#want = start.want;
	}

	#collectMatches(): void {
		const query = this.#search.query;
		const sources = this.#blocks.map(block => this.#rowsOf(block).plain);
		if (query === this.#matchQuery && sources.length === this.#matchSources.length && sources.every((rows, i) => rows === this.#matchSources[i])) {
			return;
		}
		this.#matchQuery = query;
		this.#matchSources = sources;
		this.#matches = [];
		for (const [idx, rows] of sources.entries()) {
			for (const [row, text] of rows.entries()) {
				for (const hit of occurrences(text, query)) this.#matches.push({ ...hit, idx, row });
			}
		}
		if (this.#search.current >= this.#matches.length) this.#search.current = -1;
	}

	#findNext(dir: number, times: number, quiet = false): void {
		if (!this.#search.query) {
			this.#message = "no search pattern (use / or ?)";
			return;
		}
		this.#collectMatches();
		const count = this.#matches.length;
		if (!count) {
			if (!quiet) this.#message = `pattern not found: ${this.#search.query}`;
			return;
		}
		this.#search.shown = true;
		let current = this.#search.current;
		const entering = !this.#lineMode();
		if (entering) {
			this.#mode = "line";
			this.#row = 0;
			this.#col = dir > 0 ? -1 : 0;
			current = -1;
		}
		let wrapped = false;
		const match = this.#matches[current];
		if (!match || match.idx !== this.#curIndex || match.row !== this.#row || match.from !== this.#col) current = -1;
		for (let step = 0; step < times; step++) {
			if (current < 0) {
				const candidates = this.#matches
					.map((hit, i) => ({ hit, i }))
					.filter(({ hit }) => {
						const relative = hit.idx - this.#curIndex || hit.row - this.#row || hit.from - this.#col;
						return dir > 0 ? relative > 0 : relative < 0;
					});
				current = (dir > 0 ? candidates[0] : candidates[candidates.length - 1])?.i ?? -1;
				if (current < 0) {
					current = dir > 0 ? 0 : count - 1;
					wrapped = true;
				}
			} else {
				const next = current + dir;
				if (next < 0 || next >= count) wrapped = true;
				current = (next + count) % count;
			}
		}
		this.#search.current = current;
		const hit = this.#matches[current]!;
		this.#place(hit.idx, hit.row, hit.from);
		this.#setCol(hit.from);
		if (entering) {
			this.#revealStart = false;
			this.#revealN++;
		}
		if (wrapped && !quiet) this.#message = "search wrapped";
	}

	// ── Motions & Actions ───────────────────────────────────────────────────

	#lineMode(): boolean {
		return this.#mode === "line" || this.#mode === "visual" || this.#mode === "vline";
	}

	#place(idx: number, row: number, col: number): void {
		const block = this.#blocks[idx];
		if (!block) return;
		const changedBlock = idx !== this.#curIndex;
		if (changedBlock || (this.#lineMode() && row !== this.#row)) {
			this.#revealStart = false;
			this.#revealN++;
		}
		if (changedBlock) {
			this.#endInView = false;
			this.#leftLine = undefined;
		}
		this.#curIndex = idx;
		this.#row = row;
		this.#col = col;
	}

	#goto(index: number): void {
		if (this.#blocks.length === 0) {
			this.#message = "no blocks";
			return;
		}
		this.#place(Math.max(0, Math.min(this.#blocks.length - 1, index)), 0, 0);
		this.#want = 0;
	}

	#setRow(row: number): void {
		const cur = this.#cur();
		if (!cur) return;
		const rows = this.#rowsOf(cur);
		const r = Math.max(0, Math.min(rows.rows.length - 1, row));
		this.#place(this.#curIndex, r, graphemeColumn(rows.clusters[r] ?? [], this.#want));
	}

	#setCol(col: number): void {
		const cur = this.#cur();
		if (!cur) return;
		const rows = this.#rowsOf(cur);
		const len = rows.len[this.#row] ?? 0;
		this.#col = Math.max(0, Math.min(Math.max(0, len - 1), col));
		this.#want = Number.isFinite(col) ? displayColumn(rows.clusters[this.#row] ?? [], this.#col) : col;
	}

	#adjacent(idx: number, row: number, dir: number): { idx: number; row: number } | undefined {
		const count = this.#rowsOf(this.#blocks[idx]!).rows.length;
		if (row + dir >= 0 && row + dir < count) return { idx, row: row + dir };
		for (let i = idx + dir; i >= 0 && i < this.#blocks.length; i += dir) {
			const rows = this.#rowsOf(this.#blocks[i]!).rows.length;
			if (rows > 0) return { idx: i, row: dir > 0 ? 0 : rows - 1 };
		}
		return undefined;
	}

	#moveRow(delta: number): void {
		if (!this.#cur() || this.#blocks.length === 0) {
			this.#message = "no blocks";
			return;
		}
		let pos = { idx: this.#curIndex, row: this.#row };
		for (let left = Math.abs(delta); left > 0; left--) {
			const next = this.#adjacent(pos.idx, pos.row, Math.sign(delta));
			if (!next) break;
			pos = next;
		}
		const clusters = this.#rowsOf(this.#blocks[pos.idx]!).clusters[pos.row] ?? [];
		this.#place(pos.idx, pos.row, graphemeColumn(clusters, this.#want));
	}

	#word(k: string): boolean {
		const cur = this.#cur();
		if (!cur) return false;
		const plain = this.#rowsOf(cur).plain[this.#row] ?? "";
		const here = k === "w" ? nextWordStart(plain, this.#col) : k === "e" ? wordEnd(plain, this.#col) : prevWordStart(plain, this.#col);
		if (here !== undefined) {
			const moved = here !== this.#col;
			this.#setCol(here);
			return moved;
		}
		const dir = k === "b" ? -1 : 1;
		for (let pos = this.#adjacent(this.#curIndex, this.#row, dir); pos; pos = this.#adjacent(pos.idx, pos.row, dir)) {
			const p = this.#rowsOf(this.#blocks[pos.idx]!).plain[pos.row] ?? "";
			const col = k === "w" ? firstNonBlank(p) : k === "e" ? wordEnd(p, -1) : p === "" ? 0 : prevWordStart(p, Number.POSITIVE_INFINITY);
			if (col === undefined) continue;
			this.#place(pos.idx, pos.row, col);
			this.#setCol(col);
			return true;
		}
		return false;
	}

	#drillIn(): void {
		const cur = this.#cur();
		if (cur && cur.collapsible && !this.#isExpanded(cur)) {
			this.#setExpanded(true);
			this.#message = "expanded · l: text cursor · h: collapse";
			this.#revealStart = false;
			this.#endInView = false;
			this.#revealN++;
			return;
		}
		this.#enterLine();
	}

	#collapse(): void {
		const cur = this.#cur();
		if (cur && cur.collapsible && this.#isExpanded(cur)) {
			this.#setExpanded(false);
			this.#revealStart = false;
			this.#endInView = false;
			this.#revealN++;
			return;
		}
		this.#message = "nothing to collapse · esc closes";
	}

	#enterLine(): void {
		const cur = this.#cur();
		if (!cur) {
			this.#message = "no blocks";
			return;
		}
		this.#mode = "line";
		const rows = this.#rowsOf(cur);
		const lastRow = Math.max(0, rows.rows.length - 1);
		const left = this.#leftLine?.blockId === cur.id ? this.#leftLine : undefined;
		const tall = rows.rows.length > this.#host.size().rows - 10;
		this.#row = left ? Math.min(left.row, lastRow) : tall && this.#endInView ? lastRow : 0;
		this.#col = left ? Math.min(left.col, Math.max(0, (rows.len[this.#row] ?? 0) - 1)) : 0;
		this.#want = displayColumn(rows.clusters[this.#row] ?? [], this.#col);
		this.#revealStart = !left && tall && !this.#endInView;
		this.#revealN++;
	}

	#select(kind: "visual" | "vline"): void {
		if (this.#mode === kind) {
			this.#mode = "line";
			return;
		}
		if (!this.#lineMode()) this.#enterLine();
		if (!this.#cur()) return;
		if (this.#mode === "line") {
			this.#anchorIndex = this.#curIndex;
			this.#anchorRow = this.#row;
			this.#anchorCol = this.#col;
		}
		this.#mode = kind;
	}

	#back(): void {
		switch (this.#mode) {
			case "visual":
			case "vline":
				this.#mode = "line";
				return;
			case "line":
				return this.#leaveLine();
			case "vblock":
				this.#mode = "block";
				return;
			case "block":
				return this.#host.close();
		}
	}

	#leaveLine(): void {
		const cur = this.#cur();
		if (cur) this.#leftLine = { blockId: cur.id, row: this.#row, col: this.#col };
		this.#mode = "block";
	}

	#jumpKind(kind: BlockKind | "tool", count: number): void {
		const step = count > 0 ? 1 : -1;
		let i = this.#curIndex;
		for (let left = Math.abs(count); left > 0; ) {
			i += step;
			if (i < 0 || i >= this.#blocks.length) break;
			const k = this.#blocks[i]!.kind;
			if (kind === "tool" ? TOOL_KINDS[k] : k === kind) {
				left--;
				if (left === 0) return this.#goto(i);
			}
		}
		this.#message = `no ${step > 0 ? "next" : "previous"} ${kind === "user" ? "prompt" : kind}`;
	}

	#visualBlock(): void {
		if (this.#mode === "vblock") {
			this.#mode = "block";
			return;
		}
		this.#mode = "vblock";
		this.#anchorIndex = this.#curIndex;
	}

	#swap(): void {
		if (this.#mode === "visual" || this.#mode === "vline") {
			const anchor: Pos = { idx: this.#anchorIndex, row: this.#anchorRow, col: this.#anchorCol };
			this.#anchorIndex = this.#curIndex;
			this.#anchorRow = this.#row;
			this.#anchorCol = this.#col;
			this.#place(anchor.idx, anchor.row, anchor.col);
			this.#setCol(anchor.col);
			return;
		}
		if (this.#mode !== "vblock") return;
		const anchor = this.#anchorIndex;
		this.#anchorIndex = this.#curIndex;
		this.#goto(anchor);
	}

	#selection(): { a: Pos; b: Pos } {
		const anchor: Pos = { idx: this.#anchorIndex, row: this.#anchorRow, col: this.#anchorCol };
		const cursor: Pos = { idx: this.#curIndex, row: this.#row, col: this.#col };
		const order = anchor.idx - cursor.idx || anchor.row - cursor.row || anchor.col - cursor.col;
		return order <= 0 ? { a: anchor, b: cursor } : { a: cursor, b: anchor };
	}

	#spanAt(sel: { a: Pos; b: Pos }, idx: number, r: number, len: number): [number, number] | undefined {
		const { a, b } = sel;
		if (idx < a.idx || idx > b.idx || (idx === a.idx && r < a.row) || (idx === b.idx && r > b.row)) return undefined;
		if (this.#mode === "vline") return [0, len];
		const from = idx === a.idx && r === a.row ? a.col : 0;
		const to = idx === b.idx && r === b.row ? b.col + 1 : len;
		return [from, to];
	}

	#selectionText(): { text: string; what: string } {
		const cur = this.#cur();
		if (this.#lineMode() && cur) {
			if (this.#mode === "line") return { text: this.#rowsOf(cur).plain[this.#row] ?? "", what: "1 line" };
			const sel = this.#selection();
			const chunks: string[] = [];
			let lines = 0;
			for (let i = sel.a.idx; i <= sel.b.idx; i++) {
				const { plain, len, clusters } = this.#rowsOf(this.#blocks[i]!);
				const picked: string[] = [];
				for (let r = 0; r < plain.length; r++) {
					const span = this.#spanAt(sel, i, r, len[r] ?? 0);
					if (span) picked.push(clusters[r]!.slice(span[0], span[1]).join(""));
				}
				if (picked.length === 0) continue;
				chunks.push(picked.join("\n"));
				lines += picked.length;
			}
			const text = chunks.join("\n\n");
			if (this.#mode === "vline") return { text, what: lines === 1 ? "1 line" : `${lines} lines` };
			const chars = graphemes(text).length;
			return { text, what: chars === 1 ? "1 char" : `${chars} chars` };
		}
		const a = this.#mode === "vblock" ? Math.min(this.#anchorIndex, this.#curIndex) : this.#curIndex;
		const b = this.#mode === "vblock" ? Math.max(this.#anchorIndex, this.#curIndex) : this.#curIndex;
		const slice = this.#blocks.slice(a, b + 1);
		return {
			text: slice.map(e => e.text(this.#isExpanded(e))).join("\n\n"),
			what: slice.length === 1 ? `1 ${slice[0]!.kind} block` : `${slice.length} blocks`,
		};
	}

	#yank(): void {
		const { text, what } = this.#selectionText();
		if (this.#mode === "visual" || this.#mode === "vline" ? text === "" : !text.trim()) {
			this.#message = "nothing to yank";
			return;
		}
		if (this.#mode === "visual" || this.#mode === "vline") this.#mode = "line";
		else if (this.#mode === "vblock") this.#mode = "block";
		this.#copy(text, `yanked ${what}`, "yank");
	}

	#copy(text: string, done: string, verb: string): void {
		this.#host.copy(text).then(
			() => {
				if (this.#disposed) return;
				this.#message = done;
				this.#bump();
			},
			(err: unknown) => this.#host.notify(`${verb} failed: ${err instanceof Error ? err.message : String(err)}`),
		);
	}

	#quote(): void {
		const { text } = this.#selectionText();
		if (this.#mode === "visual" || this.#mode === "vline" ? text === "" : !text.trim()) return;
		if (this.#mode === "visual" || this.#mode === "vline") this.#mode = "line";
		else if (this.#mode === "vblock") this.#mode = "block";
		this.#host.quote(text);
		this.#host.close();
	}

	#toggleExpand(): void {
		const cur = this.#cur();
		if (!cur || !cur.collapsible) {
			this.#message = "nothing to expand here";
			return;
		}
		this.#setExpanded(!this.#isExpanded(cur));
	}

	#setExpanded(on: boolean): void {
		const cur = this.#cur();
		if (!cur || !cur.collapsible) {
			this.#message = "nothing to expand here";
			return;
		}
		this.#expanded.set(cur.id, on);
		this.#rowCache.delete(cur.id);
	}

	// ── Hints ───────────────────────────────────────────────────────────────

	#startHints(copy: boolean): void {
		if (!this.#cur()) {
			this.#message = "no blocks";
			return;
		}
		if (this.#mode === "visual" || this.#mode === "vline") this.#mode = "line";
		else if (this.#mode === "vblock") this.#mode = "block";
		const hint: HintSession = { copy, typed: "", items: [], n: ++this.#hintN };
		this.#hint = hint;
		this.#labelWindow(hint);
	}

	#labelWindow(hint: HintSession): void {
		const limit = Math.max(15, this.#host.size().rows * 0.75);
		let lo = this.#curIndex;
		let hi = this.#curIndex;
		for (let sum = 0; lo > 0 && sum <= limit; ) sum += this.#rowsOf(this.#blocks[--lo]!).rows.length;
		for (let sum = 0; hi < this.#blocks.length - 1 && sum <= limit; ) sum += this.#rowsOf(this.#blocks[++hi]!).rows.length;
		const window = this.#blocks.slice(lo, hi + 1);
		const inWindow = new Set(window.map(b => b.id));
		hint.items = hint.items.filter(i => inWindow.has(i.block.id));
		const labelled = new Set(hint.items.map(i => i.block.id));

		const found: { block: NavBlock; target: HintTarget }[] = [];
		for (const block of window) {
			if (labelled.has(block.id)) continue;
			found.push({ block, target: { id: "block", action: { kind: "block" }, label: block.kind } });
			const tree = block.describe(this.#isExpanded(block));
			for (const target of collectTargets(tree)) found.push({ block, target });
		}
		const labels = hintLabels(hint.items.map(i => i.label), found.length, HINT_ALPHABET);
		if (!labels) {
			hint.items = [];
			return this.#labelWindow(hint);
		}
		hint.items.push(...found.map((f, i) => ({ ...f, label: labels[i]! })));
	}

	#hintKey(k: string): void {
		const hint = this.#hint;
		if (!hint) return;
		if (k === "backspace") {
			hint.typed = hint.typed.slice(0, -1);
			return;
		}
		const move = HINT_MOVES[k];
		if (move !== undefined) return this.#hintMove(move);
		if (!/^[a-z]$/i.test(k)) {
			this.#hint = undefined;
			return;
		}
		const typed = hint.typed + k.toUpperCase();
		const matching = hint.items.filter(i => i.label.startsWith(typed));
		if (matching.length === 0) {
			this.#hint = undefined;
			this.#message = `no hint ${typed}`;
			return;
		}
		if (matching[0]!.label === typed) return this.#activate(matching[0]!, hint.copy);
		hint.typed = typed;
	}

	#hintMove(delta: number): void {
		const hint = this.#hint;
		const to = Math.max(0, Math.min(this.#blocks.length - 1, this.#curIndex + delta));
		if (!hint || to === this.#curIndex) {
			this.#message = delta > 0 ? "last block" : "first block";
			return;
		}
		this.#goto(to);
		hint.typed = "";
		if (!hint.items.some(i => i.block.id === this.#cur()?.id)) this.#labelWindow(hint);
	}

	#activate(item: HintItem, copy: boolean): void {
		this.#hint = undefined;
		const idx = this.#blocks.findIndex(b => b.id === item.block.id);
		if (idx < 0) {
			this.#message = "that block is gone";
			return;
		}
		this.#mode = "block";
		this.#goto(idx);
		const { action, label } = item.target;
		switch (action.kind) {
			case "block": {
				const b = this.#blocks[idx]!;
				if (copy) return this.#copy(b.text(this.#isExpanded(b)), `copied 1 ${b.kind} block`, "copy");
				return;
			}
			case "copy":
				return this.#copy(action.text, `copied ${label}`, "copy");
			case "link":
				if (copy) return this.#copy(action.href, `copied ${label}`, "copy");
				this.#host.openUrl(action.href);
				this.#message = `opening ${URL.canParse(action.href) ? new URL(action.href).host : action.href}`;
				return;
			case "action":
				this.#message = action.title;
				return;
		}
	}

	// ── Status text ─────────────────────────────────────────────────────────

	#statusSnapshot(): { mode: string; pos: string; isMessage: boolean } {
		const hint = this.#hint;
		const pending = this.#count + this.#pending;
		let mode = hint ? (hint.copy ? "HINT · COPY" : "HINT") : MODE_LABEL[this.#mode];
		if (pending) mode += ` ${pending}`;
		let pos: string;
		const cur = this.#cur();
		if (hint) {
			pos = `${hint.items.filter(item => item.label.startsWith(hint.typed)).length} labels`;
		} else if (this.#search.shown) {
			this.#collectMatches();
			pos = `/${this.#search.query}${this.#search.current >= 0 ? ` · ${this.#search.current + 1} of ${this.#matches.length}` : ""}`;
		} else if (this.#lineMode() && cur) {
			pos = `row ${this.#row + 1}/${this.#rowsOf(cur).rows.length} · col ${this.#col + 1}`;
		} else {
			const index = cur ? this.#curIndex + 1 : 0;
			pos = `${index}/${this.#blocks.length}`;
		}
		if (this.#message) return { mode, pos: this.#message, isMessage: true };
		return { mode, pos, isMessage: false };
	}
}
