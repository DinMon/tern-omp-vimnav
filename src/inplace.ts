// In-place navigator for Tern: a block cursor drawn directly on omp's real transcript.
// The transcript's nativeBlocks() is overridden on the instance to add sibling markers next to omp's blocks; CSS
// draws the BLOCK / V-BLOCK cursor through them, so omp's blocks are never rewritten (a rewritten finished block is
// rebuilt by omp from scratch). TEXT modes hide the block behind a marker and show a code well with numbered rows and
// a grapheme caret beside it. HINT labels are the only change made inside blocks; search shows its matches in TEXT.
// The below-editor widget stays hidden; the find bar uses a native overlay; mode, position and the last key's result
// use the status chip; only failures are toasts.

import { type Component, extractPrintableText, matchesKey, type TUI } from "@oh-my-pi/pi-tui";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome";
import { collectTargets, decorate, type HintTarget, hintLabels, labelBlock } from "./hints";
import { occurrences, type Occurrence } from "./search";
import { displayColumn, firstNonBlank, graphemeColumn, graphemes, nextWordStart, paintCells, prevWordStart, wordEnd } from "./textops";

interface Theme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

const NAMED: readonly string[] = ["escape", "enter", "return", "tab", "backspace", "up", "down", "left", "right", "pageUp", "pageDown", "home", "end"];
const CTRL: readonly string[] = ["ctrl+c", "ctrl+d", "ctrl+u", "ctrl+f", "ctrl+b"];

function keyName(data: string): string | undefined {
	for (const name of NAMED) {
		if (matchesKey(data, name as never)) return name === "escape" ? "esc" : name === "return" ? "enter" : name;
	}
	for (const name of CTRL) if (matchesKey(data, name as never)) return name;
	if (data === "\r" || data === "\n") return "enter";
	if (data === "\x7f") return "backspace";
	const text = extractPrintableText(data);
	return text !== undefined && graphemes(text).length === 1 ? text : undefined;
}

export interface InPlaceHost {
	requestRender(): void;
	rows(): number;
	copy(text: string): Promise<void>;
	quote(text: string): void;
	close(): void;
	/** Updates the mode/position status chip; undefined restores the closed navigator status. */
	status(state: { mode: string; pos: string } | undefined): void;
	/** Shows a failure as a warning toast; ordinary results go to the status chip instead. */
	notify(text: string): void;
	/** omp's accent colour as #rrggbb (the colour Tern uses as the accent inside omp's regions). */
	accent(): string;
	getToolsExpanded(): boolean;
	setToolsExpanded(on: boolean): void;
	/**
	 * Shows a popup (in Tern a native dialog, like /btw or the model picker); returns how to close it. A `passive`
	 * popup does not take the keyboard (and so is not modal): the find bar floats while keys keep reaching vimnav.
	 */
	showOverlay(component: Component, options: { anchor: "center" | "top"; width: string; maxHeight: string; passive?: boolean }): { hide(): void };
	/** Opens `href` with the platform opener. */
	openUrl(href: string): void;
}

interface Cx {
	cols: number;
	supports(kind: string): boolean;
}

interface Blk {
	render(width: number): readonly string[];
	describe?(cx: Cx): unknown;
	setExpanded?(expanded: boolean): void;
	updateResult?: unknown;
	handleNativeEvent?(event: unknown): unknown;
}

interface Transcript {
	children: Blk[];
	nativeBlocks(): readonly unknown[];
}

interface Entry {
	block: Blk;
	kind: string;
	text: string;
}

/** A block's rendered rows at `cols`, with their plain text (ANSI stripped, trimEnd). */
interface Rows {
	cols: number;
	/** The block's own render output, for change detection. */
	raw: readonly string[];
	/** Rows as shown: background colours dropped, which would otherwise stripe the card. */
	rows: readonly string[];
	plain: string[];
	/** Grapheme clusters and lengths of each plain row. */
	clusters: readonly (readonly string[])[];
	len: number[];
}

/** A TEXT-mode position: navigable block index, row inside the block, column in the row's plain text. */
interface Pos {
	idx: number;
	row: number;
	col: number;
}

interface HintItem {
	label: string;
	block: Blk;
	target: HintTarget;
}

/** One `f` / `F` press: the labelled targets, the typed label prefix, and how to undo the in-place labels. */
interface HintSession {
	/** `F`: links and blocks are copied instead of opened / jumped to. */
	copy: boolean;
	typed: string;
	items: HintItem[];
	/** Per labelled block, the undo of its describe override. */
	restore: Map<Blk, () => void>;
	/** Session number, for nativeBlocks' memo stamp. */
	n: number;
}

interface BlockDecoration {
	describe: (cx: Cx) => unknown;
	ownDescribe: PropertyDescriptor | undefined;
	hint?: { own: string; labels: ReadonlyMap<string, string>; session: HintSession; sig: string };
}

/** line = TEXT (row/column cursor), visual = char-wise selection, vline = line-wise selection. */
type Mode = "block" | "vblock" | "line" | "visual" | "vline";

const MODE_LABEL: Record<Mode, string> = { block: "BLOCK", vblock: "V-BLOCK", line: "TEXT", visual: "VISUAL", vline: "V-LINE" };

/**
 * Whether omp's accent sits in a 30°-wide HSL hue window centred on Tern's find amber (#f5b13d, hue 38°): matches
 * must never look like the cursor, so search then uses Tern's violet. Over omp's 102 themes this picks the 20 amber,
 * gold and orange accents (hues 27-48°) and leaves the orange-reds (23° and below) on amber. Greys (saturation under
 * 20%) have no hue worth comparing.
 */
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

const SEQ_PREFIXES: Record<string, true> = { g: true, z: true, "[": true, "]": true };
const PAGE = 5;
/** Block kinds that ]t / [t treat as tool output. */
const TOOL_KINDS: Record<string, true> = { tool: true, bash: true, python: true };
const FALLBACK_COLS = 80;
/** How long a block move's top-edge reveal waits for Tern to apply its bottom-edge reveal (measured: 0ms loses it). */
const TOP_REVEAL_DELAY_MS = 100;
/** Monospace cells that fit inside the TEXT well in Tern's reading column (measured from shots). */
const READER_COLS = 80;

/** A key hint as Tern draws it: key caps (each chord like `ctrl+d` is one cap) then a muted label. */
interface Hint {
	keys: readonly string[];
	label: string;
}


/** Home-row-first hint letters without h/j/k/l (they move while hinting), topped up to 14 letters. */
const HINT_ALPHABET = "SADFEWCMPGRUIO";

/** Hint-mode movement: blocks to move the cursor by before the labels are placed again. */
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

const HELP_SECTIONS: readonly { title: string; hints: readonly Hint[] }[] = [
	{
		title: "Blocks",
		hints: [
			{ keys: ["j", "k"], label: "next / previous" },
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
			{ keys: ["l"], label: "expand the block, then enter" },
			{ keys: ["h", "h"], label: "at a line start: back to the block view" },
			{ keys: ["h"], label: "in the block view: collapse it again" },
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
			{ keys: ["f"], label: "jump / open / press" },
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
			{ keys: ["i"], label: "type in the prompt, vimnav stays; esc comes back" },
			{ keys: ["alt+k"], label: "switch between vimnav and the prompt" },
			{ keys: ["esc"], label: "back one step" },
			{ keys: ["q"], label: "close" },
		],
	},
];

const HELP_NAMED_KEYS: Readonly<Record<string, string>> = { pageUp: "pgup", pageDown: "pgdn", up: "↑", down: "↓", left: "←", right: "→" };

function helpKeyText(chord: string): string {
	if (HELP_NAMED_KEYS[chord]) return HELP_NAMED_KEYS[chord];
	if (chord.startsWith("shift+")) return chord.slice(6).toUpperCase();
	if (chord.startsWith("ctrl+")) return `⌃${chord.slice(5).toLowerCase()}`;
	if (chord.startsWith("alt+")) return `⌥${chord.slice(4).toLowerCase()}`;
	return chord;
}


/** The live transcript container under `tui`, or undefined when unavailable. */
export function findTranscript(tui: TUI): object | undefined {
	return tui.children.find(c => c instanceof TranscriptContainer);
}

/** Per transcript, where the cursor was when vimnav last closed (`newest`: on the newest block then). */
const lastCursor = new WeakMap<object, { block: Blk; newest: boolean; endInView: boolean }>();

export class InPlaceNavigator implements Component {
	#transcript: Transcript;
	#host: InPlaceHost;
	#original: () => readonly unknown[];
	#disposed = false;
	#cx: Cx | undefined;

	/** Navigable blocks as of the last key press. */
	#list: Entry[] = [];
	#kinds = new WeakMap<Blk, string>();
	#cur: Blk | undefined;
	#curIndex = 0;
	/** V-BLOCK anchor block; in VISUAL / V-LINE the selection anchor's block. */
	#anchor: Blk | undefined;
	#anchorIndex = 0;
	#mode: Mode = "block";
	#expanded = new WeakMap<Blk, boolean>();
	/** TEXT modes: cursor row/column inside the cursor block and the selection anchor's row/column. */
	#row = 0;
	#col = 0;
	/** Display-cell column j/k aim for (vim's curswant); Infinity after `$`. */
	#want = 0;
	#anchorRow = 0;
	#anchorCol = 0;
	/**
	 * Which part of the cursor block is in view: its end when vimnav opened at the live end (or reopened on a block
	 * whose end showed), else its top (a block move always reveals the top). TEXT starts there.
	 */
	#endInView = false;
	/** Where Esc left TEXT; `l` resumes there while the cursor has not left that block. */
	#leftLine: { block: Blk; row: number; col: number } | undefined;
	/** TEXT: the last key was h at a line start, so another h there leaves for the block view. */
	#atBorder = false;
	#rowCache = new WeakMap<Blk, Rows>();

	/** Bumped by every cursor move and zz/zt: the cursor node reveals itself in the next frame. */
	#revealN = 0;
	#revealStart = false;
	/**
	 * A block move reveals two markers, its bottom edge and then its top edge, so the block scrolls as a whole does
	 * with Tern's nearest reveal, except a block taller than the screen always shows its top. omp sends reveals in tree
	 * order, which would put the top first; and Tern applies a reveal on its next layout, so a second reveal arriving
	 * before then replaces the first. The top therefore waits TOP_REVEAL_DELAY_MS: #topN is the reveal number whose top
	 * edge has been released, #topScheduled the one whose release is pending.
	 */
	#topN = -1;
	#topScheduled = -1;
	/**
	 * Keep a sent reveal stable so later frames never repeat the move. Markers use object reveals;
	 * a newly added TEXT well uses a string reveal on its cursor row.
	 */
	#sent: { n: number; reveal: unknown; target: string } = { n: 0, reveal: undefined, target: "" };
	#lastWells = new Set<Blk>();
	/** Marker keys in the last emitted tree: omp honours an object reveal only on a node that is already mounted. */
	#lastMarkers = new Set<string>();

	#count = "";
	#pending = "";
	#search: { typing: boolean; query: string; shown: boolean; current: number } = { typing: false, query: "", shown: false, current: -1 };
	#matches: (Occurrence & { idx: number; row: number })[] = [];
	#matchQuery: string | undefined;
	#matchSources: readonly (readonly string[])[] = [];
	/** Bumped whenever #matches is recomputed, so the TEXT wells painted from it are rebuilt. */
	#matchRev = 0;
	#status: { mode: string; pos: string } | undefined;
	/** 1 = forward (`/`), -1 = backward (`?`); n repeats in this direction, N against it. */
	#searchDir = 1;
	/**
	 * Where the search being typed started: Esc returns here, and each query change searches from here again. The block
	 * is kept by identity (blocks can come and go meanwhile) with the TEXT memory that the preview's moves clear.
	 */
	#previousSearch:
		| {
				state: { typing: boolean; query: string; shown: boolean; current: number };
				dir: number;
				mode: Mode;
				block: Blk | undefined;
				pos: Pos;
				leftLine: { block: Blk; row: number; col: number } | undefined;
				endInView: boolean;
				want: number;
		  }
		| undefined;
	#help: { panel: HelpPanel; hide(): void } | undefined;
	#find: { panel: FindBar; hide(): void } | undefined;
	/** HINT mode; #mode keeps the (selection-free) mode that Esc returns to. */
	#hint: HintSession | undefined;
	#hintN = 0;
	/** Per block, its last labelled tree and the undecorated tree (object and JSON) it was made for. */
	#labelled = new WeakMap<Blk, { tree: unknown; shape: string; typed: string; sig: string; out: unknown }>();
	#decorations = new Map<Blk, BlockDecoration>();
	/** The prompt has the keyboard (`i`, Alt+K, `c`); vimnav remains active. */
	#promptFocus = false;
	/**
	 * Vim's message line: the result of the last key ("yanked 10 chars", "search wrapped"), shown in the status chip in
	 * place of the position until the next key, instead of a toast for each one.
	 */
	#message = "";

	#ids = new WeakMap<Blk, number>();
	#nextId = 1;
	#nodes = new WeakMap<Blk, { sig: string; rows: Rows; node: unknown }>();
	#lastBase: readonly unknown[] = [];
	#lastStamp = "";
	#lastRows: Rows[] = [];
	#lastOut: unknown[] | undefined;

	constructor(transcript: object, _theme: Theme, host: InPlaceHost) {
		this.#transcript = transcript as Transcript;
		this.#host = host;
		this.#original = this.#transcript.nativeBlocks.bind(this.#transcript);
		this.#refresh();
		const last = this.#list.length - 1;
		// Start where the cursor was when vimnav last closed, unless it was on the newest block then (start on the
		// newest again, replies that came in since included) or that block is gone.
		const before = lastCursor.get(this.#transcript);
		const at = before && !before.newest ? this.#list.findIndex(e => e.block === before.block) : -1;
		this.#curIndex = at >= 0 ? at : Math.max(0, last);
		this.#cur = this.#list[this.#curIndex]?.block;
		// At the live end the newest block shows its end.
		this.#endInView = at < 0 || before?.endInView === true;
		this.#anchor = this.#cur;
		this.#anchorIndex = this.#curIndex;
		// Opening must not scroll (Tern never says what is on screen): the open-time cursor counts as revealed already.
		this.#sent = { n: this.#revealN, reveal: undefined, target: "" };
		this.#transcript.nativeBlocks = () => this.#nativeBlocks();
		this.#updateStatus();
		this.#host.requestRender();
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#status = undefined;
		this.#host.status(undefined);
		this.#closeHelp();
		this.#find?.hide();
		this.#find = undefined;
		this.#endHints();
		for (const block of this.#decorations.keys()) this.#removeDecoration(block);
		if (this.#cur) lastCursor.set(this.#transcript, { block: this.#cur, newest: this.#curIndex === this.#list.length - 1, endInView: this.#endInView });
		// Drop the instance override so the prototype's nativeBlocks applies again.
		Reflect.deleteProperty(this.#transcript, "nativeBlocks");
		this.#host.requestRender();
	}

	invalidate(): void {
		this.#lastOut = undefined;
	}

	// ── transcript decoration ───────────────────────────────────────────────

	#nativeBlocks(): readonly unknown[] {
		this.#normalisePositions();
		this.#syncDecorations();
		const base = this.#original();
		const hint = this.#hint;
		const cur = this.#cur;
		const sel = this.#mode === "visual" || this.#mode === "vline" ? this.#selection() : undefined;
		const ranged = sel !== undefined || this.#mode === "vblock";
		const lo = ranged ? Math.min(this.#anchorIndex, this.#curIndex) : this.#curIndex;
		const hi = ranged ? Math.max(this.#anchorIndex, this.#curIndex) : this.#curIndex;
		const range = cur ? this.#list.slice(lo, hi + 1).map(e => e.block) : [];
		const text = !hint && this.#lineMode();
		const inRange = new Set<unknown>(range);
		// Every in-range TEXT block has the same well structure, including blocks with no rendered rows.
		const shown = new Map<unknown, Rows>();
		if (text) for (const block of range) shown.set(block, this.#rowsOf(block));
		// The wells paint the matches: refresh them against this frame's rows (a streaming block grows new ones).
		if (text && this.#search.shown && this.#search.query) this.#collectMatches();
		const curRows = cur ? shown.get(cur) : undefined;
		const row = curRows ? Math.min(this.#row, curRows.rows.length - 1) : -1;
		const chipMode = MODE_LABEL[this.#mode];
		const stamp = `${cur ? this.#id(cur) : 0}|${this.#mode}|${hint?.n ?? 0}:${hint?.typed ?? ""}|${range.map(b => `${this.#id(b)}:${this.#kinds.get(b)}`).join(",")}|${row}|${this.#col}|${this.#anchorIndex}:${this.#anchorRow}:${this.#anchorCol}|${this.#revealN}|${this.#topN}|${this.#revealStart}|${this.#search.shown}:${this.#search.query}:${this.#search.current}:${this.#matchRev}|${nearAmber(this.#host.accent())}`;
		const rowsList = [...shown.values()];
		if (
			this.#lastOut &&
			stamp === this.#lastStamp &&
			rowsList.length === this.#lastRows.length &&
			rowsList.every((r, i) => r === this.#lastRows[i]) &&
			base.length === this.#lastBase.length &&
			base.every((b, i) => b === this.#lastBase[i])
		)
			return this.#lastOut;

		const wells = new Set<Blk>();
		const markers = new Set<string>();
		const indices = new Map(this.#list.map((entry, idx) => [entry.block, idx]));
		const out: unknown[] = [];
		for (const b of base) {
			const block = b as Blk;
			const selected = block === cur;
			const idx = indices.get(block) ?? -1;
			const words = ["vimnav"];
			if (inRange.has(b) && !hint && ranged) {
				words.push("rng");
				if (idx === lo) words.push("rng-first");
				if (idx === hi) words.push("rng-last");
				if (idx > lo && idx < hi) words.push("rng-mid");
			}
			if (selected) words.push("cur");
			if (this.#decorations.get(block)?.hint) words.push("hint");
			const well = text && inRange.has(b);
			if (well && nearAmber(this.#host.accent())) words.push("fv");
			const key = well ? `vimnav:${this.#id(block)}` : "";
			const atKey = words.length > 1 ? selected && !(this.#mode === "vblock" && !hint) ? "vimnav-at" : `vimnav-at-${this.#id(block)}` : "";
			let reveal: unknown;
			if (selected) {
				const target = well ? (row >= 0 && !(this.#revealStart && row === 0) ? `${key}/r${row}` : key) : this.#revealStart ? atKey : "vimnav-end";
				const mounted = well ? this.#lastWells.has(block) : this.#lastMarkers.has(target);
				if (this.#sent.n !== this.#revealN) {
					const at = this.#revealStart ? "start" : "nearest";
					this.#sent = { n: this.#revealN, reveal: mounted ? { at, n: this.#revealN } : at, target };
				} else if (this.#sent.target !== target || (!mounted && typeof this.#sent.reveal === "string")) {
					this.#sent = { n: this.#revealN, reveal: undefined, target };
				}
				reveal = this.#sent.reveal;
			}
			if (words.length > 1) {
				const top = selected && !well && (this.#revealStart ? reveal : this.#topN === this.#revealN ? { at: "nearest", n: this.#topN } : undefined);
				markers.add(atKey);
				out.push({
					k: "col",
					key: atKey,
					p: { role: "omp.vimnav.at", aria: words.join(" "), gap: "none" },
					...(top ? { reveal: top } : {}),
				});
			}
			if (well) out.push({ k: "col", key: `vimnav-hide-${this.#id(block)}`, p: { role: "omp.vimnav.hide", hidden: true, gap: "none" } });
			out.push(b);
			if (!well) {
				if (selected) {
					const bottom = !this.#revealStart && reveal !== undefined;
					markers.add("vimnav-end");
					out.push({ k: "col", key: "vimnav-end", p: { role: "omp.vimnav.end", gap: "none" }, ...(bottom ? { reveal } : {}) });
					if (bottom && this.#topScheduled !== this.#revealN) {
						const n = (this.#topScheduled = this.#revealN);
						// A later move owns the reveal by then; its own timer releases its top.
						setTimeout(() => {
							if (this.#disposed || this.#revealN !== n) return;
							this.#topN = n;
							this.#host.requestRender();
						}, TOP_REVEAL_DELAY_MS);
					}
				}
				continue;
			}
			wells.add(block);
			const rows = shown.get(block)!;
			const blockKind = this.#kinds.get(block) ?? "note";
			const kind = blockKind.charAt(0).toUpperCase() + blockKind.slice(1);
			const sig = `${stamp}|${typeof reveal}`;
			const cached = this.#nodes.get(block);
			if (cached && cached.sig === sig && cached.rows === rows) {
				out.push(cached.node);
				continue;
			}
			const lines = this.#rowTexts(rows, idx, selected ? row : -1, sel);
			// Row count and geometry stay fixed: moving the cursor only changes ANSI text and roles.
			const rowNodes: Record<string, unknown>[] = lines.map((text, r) => {
				const cursor = selected && r === row;
				const selection = this.#mode === "vline" && sel && this.#spanAt(sel, idx, r, rows.len[r]) !== undefined;
				const role = `omp.vimnav.row${cursor ? ".cur" : ""}${selection ? ".sel" : ""}`;
				return { k: "ansi", p: { text, role }, key: `r${r}` };
			});
			const node: Record<string, unknown> = {
				k: "col",
				p: { gap: "none", role: "omp.vimnav.text", aria: words.join(" ") },
				key,
				c: [{
					k: "col",
					p: { gap: "none", role: "omp.vimnav.well" },
					c: [
						{
							k: "row",
							p: { gap: "sm", align: "center", role: "omp.vimnav.well-head" },
							c: [
								{ k: "text", p: { text: chipMode, role: "omp.vimnav.chip" } },
								{ k: "text", p: { text: kind, role: "omp.vimnav.kind" } },
								{ k: "row", p: { grow: 1 } },
								{ k: "text", p: { text: selected ? `row ${row + 1}/${rows.rows.length} · col ${this.#col + 1}` : `rows ${rows.rows.length}`, role: "omp.vimnav.pos" } },
							],
						},
						{ k: "col", p: { gap: "none", role: "omp.vimnav.rows" }, key: "rows", c: rowNodes },
					],
				}],
			};
			// A start reveal at the first row aligns the well itself, so its head stays in view.
			const revealed = selected && rowNodes[row] && !(this.#revealStart && row === 0) ? rowNodes[row] : node;
			if (reveal !== undefined) revealed.reveal = reveal;
			this.#nodes.set(block, { sig, rows, node });
			out.push(node);
		}
		this.#lastBase = base.slice();
		this.#lastWells = wells;
		this.#lastMarkers = markers;
		this.#lastStamp = stamp;
		this.#lastRows = rowsList;
		this.#lastOut = out;
		return out;
	}

	/** Relative line-number gutter, VISUAL cells and a caret; V-LINE tint is carried by row roles. */
	#rowTexts(rows: Rows, idx: number, cursorRow: number, sel: { a: Pos; b: Pos } | undefined): string[] {
		return rows.rows.map((text, r) => {
			const span = this.#mode === "visual" && sel ? this.#spanAt(sel, idx, r, rows.len[r]) : undefined;
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
				// Selection and caret take precedence; paintCells consumes disjoint ordered spans.
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

	#id(block: Blk): number {
		let id = this.#ids.get(block);
		if (id === undefined) {
			id = this.#nextId++;
			this.#ids.set(block, id);
		}
		return id;
	}

	/**
	 * Rows of `block` laid out for Tern's reading column (not the full terminal width, which made every
	 * row soft-wrap inside the well); the same object while the block's render output is unchanged.
	 */
	#rowsOf(block: Blk): Rows {
		const cols = Math.min(this.#cx?.cols ?? FALLBACK_COLS, READER_COLS) - 5; // 5-cell number gutter
		const rows = block.render(cols);
		const cached = this.#rowCache.get(block);
		if (cached && cached.cols === cols && (cached.raw === rows || (cached.raw.length === rows.length && cached.raw.every((r, i) => r === rows[i])))) return cached;
		const plain = rows.map(r => Bun.stripANSI(r).trimEnd());
		const clusters = plain.map(graphemes);
		const entry: Rows = { cols, raw: rows, rows: rows.map(prepareWellRow), plain, clusters, len: clusters.map(p => p.length) };
		this.#rowCache.set(block, entry);
		return entry;
	}

	// ── block list ──────────────────────────────────────────────────────────

	#refresh(): void {
		const width = this.#cx?.cols ?? FALLBACK_COLS;
		const list: Entry[] = [];
		for (const block of this.#transcript.children) {
			let role: unknown;
			// Only Tern's own context may describe a block: omp memoises a block's tree by its state, not by the context,
			// so a describe made with a stand-in (before Tern's first frame reaches vimnav) caches a non-native tree, and
			// the next real frame rebuilds every such finished block from scratch (a long thought then drew as an empty
			// gap at its full height). Before then, toasts are told apart by their own class name.
			if (this.#cx && typeof block.describe === "function") {
				const node = block.describe(this.#cx) as { k?: string; p?: { hidden?: boolean; role?: unknown } } | undefined;
				if (node?.k === "toast" || node?.p?.hidden) continue;
				role = node?.p?.role;
			} else if (block.constructor.name === "StatusNotice") continue;
			const lines = block.render(width);
			if (lines.length === 0) continue;
			const text = Bun.stripANSI(lines.join("\n"))
				.split("\n")
				.map(l => l.trimEnd())
				.join("\n")
				.replace(/^\n+|\n+$/g, "");
			if (!text) continue;
			const tool = typeof block.setExpanded === "function" && typeof block.updateResult === "function";
			const sub = typeof role === "string" && role.startsWith("omp.") ? role.split(".")[1] : undefined;
			const kind = sub && sub !== "block" ? sub : tool ? "tool" : "note";
			this.#kinds.set(block, kind);
			list.push({ block, kind, text });
		}
		this.#list = list;
		const resolve = (block: Blk | undefined, fallback: number): number => {
			const i = list.findIndex(e => e.block === block);
			return i >= 0 ? i : Math.min(fallback, Math.max(0, list.length - 1));
		};
		const curIndex = resolve(this.#cur, this.#curIndex);
		if (list[curIndex]?.block !== this.#cur) this.#revealN++;
		this.#curIndex = curIndex;
		this.#cur = list[curIndex]?.block;
		this.#anchorIndex = resolve(this.#anchor, this.#anchorIndex);
		this.#anchor = list[this.#anchorIndex]?.block;
		this.#normalisePositions();
	}

	/** Streaming, folds and resize can shorten both selection ends; curswant remains unchanged. */
	#normalisePositions(): void {
		if (this.#lineMode() && this.#cur) {
			const rows = this.#rowsOf(this.#cur);
			this.#row = Math.min(this.#row, Math.max(0, rows.rows.length - 1));
			this.#col = Math.min(this.#col, Math.max(0, (rows.len[this.#row] ?? 0) - 1));
			if (this.#anchor) {
				const anchor = this.#rowsOf(this.#anchor);
				this.#anchorRow = Math.min(this.#anchorRow, Math.max(0, anchor.rows.length - 1));
				this.#anchorCol = Math.min(this.#anchorCol, Math.max(0, (anchor.len[this.#anchorRow] ?? 0) - 1));
			}
		}
	}

	// ── input ───────────────────────────────────────────────────────────────

	handleInput(data: string): void {
		if (this.#disposed) return;
		this.#refresh();
		this.#message = "";
		// tmux and pastes can deliver several printable keys at once: replay them one by one.
		if (data.length > 1 && !data.includes("\x1b") && /^[\x20-\x7e]+$/.test(data)) {
			for (const ch of data) {
				this.#key(ch);
				this.#updateStatus();
			}
		} else {
			this.#key(data);
		}
		this.#updateStatus();
		this.#host.requestRender();
	}

	#key(data: string): void {
		if (this.#help) {
			if (this.#help.panel.handleInput(data)) this.#closeHelp();
			return;
		}
		const k = keyName(data);
		if (k === undefined) return;
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
				return this.#goto(n.given ? n.value - 1 : this.#list.length - 1);
			case "home":
				return line ? this.#setRow(0) : this.#goto(0);
			case "h":
			case "left":
				if (!line) {
					// h is the way back out of a block (TEXT, then the expanded output), never out of vimnav: only Esc
					// (or q) closes.
					if (this.#mode === "vblock") this.#mode = "block";
					else this.#collapse();
					return;
				}
				if (this.#col > 0) return this.#setCol(this.#col - n.value);
				// At a line start h has nowhere to go: a second one there goes back out to the block view, the way
				// `l` came in.
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
			case "^":
				if (line && this.#cur) this.#setCol(firstNonBlank(this.#rowsOf(this.#cur).plain[this.#row] ?? ""));
				return;
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
			case "?": {
				if (line) return this.#startSearch(-1);
				const panel = new HelpPanel(this.#mode);
				const overlay = this.#host.showOverlay(panel, { anchor: "center", width: "70%", maxHeight: "85%" });
				this.#help = { panel, hide: () => overlay.hide() };
				return;
			}
			case "n":
				return this.#findNext(this.#searchDir, n.value);
			case "N":
				return this.#findNext(-this.#searchDir, n.value);
			case "ctrl+f":
			case "ctrl+b":
			case "pageDown":
			case "pageUp": {
				const dir = k === "ctrl+f" || k === "pageDown" ? 1 : -1;
				if (line) return this.#moveRow(dir * Math.max(1, this.#host.rows()) * n.value);
				return this.#goto(this.#curIndex + dir * PAGE * 2 * n.value);
			}
			case "ctrl+d":
			case "ctrl+u": {
				const dir = k === "ctrl+d" ? 1 : -1;
				if (line) return this.#moveRow(dir * Math.max(1, Math.floor(this.#host.rows() / 2)) * n.value);
				return this.#goto(this.#curIndex + dir * PAGE * n.value);
			}
			case "q":
				return this.#host.close();
			case "i":
				return this.#focusPrompt();
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
			case "zM":
				this.#host.setToolsExpanded(seq === "zR");
				this.#expanded = new WeakMap();
				return;
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

	#startSearch(dir: number): void {
		this.#previousSearch = {
			state: { ...this.#search },
			dir: this.#searchDir,
			mode: this.#mode,
			block: this.#cur,
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

	/**
	 * Vim's incsearch: every query change shows the query's first match from where the search started, in TEXT with the
	 * caret on it; with no match the cursor is back where it started. `quiet` while typing: the wrap and not-found
	 * notices wait for Enter.
	 */
	#incsearch(quiet: boolean): void {
		this.#returnToSearchStart();
		this.#search.current = -1;
		if (this.#search.query) this.#findNext(this.#searchDir, 1, quiet);
	}

	#returnToSearchStart(): void {
		const start = this.#previousSearch;
		if (!start || this.#list.length === 0) return;
		const idx = start.block ? this.#list.findIndex(entry => entry.block === start.block) : -1;
		this.#mode = start.mode;
		this.#place(idx >= 0 ? idx : Math.min(start.pos.idx, this.#list.length - 1), start.pos.row, start.pos.col);
		this.#leftLine = start.leftLine;
		this.#endInView = start.endInView;
		this.#want = start.want;
	}

	// ── motions & actions ───────────────────────────────────────────────────

	/** TEXT, VISUAL or V-LINE: the cursor is a (row, column) inside the cursor block. */
	#lineMode(): boolean {
		return this.#mode === "line" || this.#mode === "visual" || this.#mode === "vline";
	}

	/** Puts the cursor at (block `idx`, row, col); a new block (or a new row in TEXT modes) restarts the reveal. */
	#place(idx: number, row: number, col: number): void {
		const block = this.#list[idx]?.block;
		if (!block) return;
		if (block !== this.#cur || (this.#lineMode() && row !== this.#row)) {
			this.#revealStart = false;
			this.#revealN++;
		}
		// A block move reveals the new block's top; the row Esc left TEXT on no longer matches what is in view.
		if (block !== this.#cur) {
			this.#endInView = false;
			this.#leftLine = undefined;
		}
		this.#curIndex = idx;
		this.#cur = block;
		this.#row = row;
		this.#col = col;
	}

	/** Moves the cursor to block `index`, at its first row and column; a selection keeps its anchor. */
	#goto(index: number): void {
		if (this.#list.length === 0) {
			this.#message = "no blocks";
			return;
		}
		this.#place(Math.max(0, Math.min(this.#list.length - 1, index)), 0, 0);
		this.#want = 0;
	}

	/** Moves the row cursor inside the cursor block (clamped), keeping the desired column. */
	#setRow(row: number): void {
		if (!this.#cur) return;
		const rows = this.#rowsOf(this.#cur);
		const r = Math.max(0, Math.min(rows.rows.length - 1, row));
		this.#place(this.#curIndex, r, graphemeColumn(rows.clusters[r] ?? [], this.#want));
	}

	/** Moves the column inside the cursor row (clamped to the row); Infinity (`$`) sticks to row ends on j/k. */
	#setCol(col: number): void {
		if (!this.#cur) return;
		const rows = this.#rowsOf(this.#cur);
		const len = rows.len[this.#row] ?? 0;
		this.#col = Math.max(0, Math.min(Math.max(0, len - 1), col));
		this.#want = Number.isFinite(col) ? displayColumn(rows.clusters[this.#row] ?? [], this.#col) : col;
	}

	/** The row after/before (block `idx`, `row`) in direction `dir`, crossing into neighbouring blocks. */
	#adjacent(idx: number, row: number, dir: number): { idx: number; row: number } | undefined {
		const count = this.#rowsOf(this.#list[idx].block).rows.length;
		if (row + dir >= 0 && row + dir < count) return { idx, row: row + dir };
		for (let i = idx + dir; i >= 0 && i < this.#list.length; i += dir) {
			const rows = this.#rowsOf(this.#list[i].block).rows.length;
			if (rows > 0) return { idx: i, row: dir > 0 ? 0 : rows - 1 };
		}
		return undefined;
	}

	/** TEXT row motion keeping the desired column; running off the block continues into the neighbouring block. */
	#moveRow(delta: number): void {
		if (!this.#cur || this.#list.length === 0) {
			this.#message = "no blocks";
			return;
		}
		let pos = { idx: this.#curIndex, row: this.#row };
		for (let left = Math.abs(delta); left > 0; left--) {
			const next = this.#adjacent(pos.idx, pos.row, Math.sign(delta));
			if (!next) break;
			pos = next;
		}
		const clusters = this.#rowsOf(this.#list[pos.idx].block).clusters[pos.row] ?? [];
		this.#place(pos.idx, pos.row, graphemeColumn(clusters, this.#want));
	}

	/** w / b / e on the cursor row; past the row's last (first) word they continue on the next (previous) rows. */
	#word(k: string): boolean {
		if (!this.#cur) return false;
		const plain = this.#rowsOf(this.#cur).plain[this.#row] ?? "";
		const here = k === "w" ? nextWordStart(plain, this.#col) : k === "e" ? wordEnd(plain, this.#col) : prevWordStart(plain, this.#col);
		if (here !== undefined) {
			const moved = here !== this.#col;
			this.#setCol(here);
			return moved;
		}
		const dir = k === "b" ? -1 : 1;
		for (let pos = this.#adjacent(this.#curIndex, this.#row, dir); pos; pos = this.#adjacent(pos.idx, pos.row, dir)) {
			const p = this.#rowsOf(this.#list[pos.idx].block).plain[pos.row] ?? "";
			// Like vim, `w` and `b` stop on empty rows; `e` skips them.
			const col = k === "w" ? firstNonBlank(p) : k === "e" ? wordEnd(p, -1) : p === "" ? 0 : prevWordStart(p, Number.POSITIVE_INFINITY);
			if (col === undefined) continue;
			this.#place(pos.idx, pos.row, col);
			this.#setCol(col);
			return true;
		}
		return false;
	}

	/**
	 * `l` in BLOCK mode goes one level in: a block with more to show (a collapsed tool output) expands first and stays
	 * in Tern's view, scrolled so the expanded part shows; `l` again, or on a block with nothing hidden, enters TEXT.
	 */
	#drillIn(): void {
		const cur = this.#cur;
		if (cur && typeof cur.setExpanded === "function" && !(this.#expanded.get(cur) ?? this.#host.getToolsExpanded())) {
			const width = this.#cx?.cols ?? FALLBACK_COLS;
			const before = cur.render(width).join("\n");
			this.#setExpanded(true);
			if (cur.render(width).join("\n") !== before) {
				this.#message = "expanded · l: text cursor · h: collapse";
				this.#revealStart = false;
				this.#endInView = false;
				this.#revealN++;
				return;
			}
			this.#setExpanded(false);
		}
		this.#enterLine();
	}

	/** `h` in BLOCK mode, the way back out of `l`: a block showing hidden output (expanded) collapses again. */
	#collapse(): void {
		const cur = this.#cur;
		if (cur && typeof cur.setExpanded === "function" && (this.#expanded.get(cur) ?? this.#host.getToolsExpanded())) {
			const width = this.#cx?.cols ?? FALLBACK_COLS;
			const before = cur.render(width).join("\n");
			this.#setExpanded(false);
			if (cur.render(width).join("\n") !== before) {
				// The card shrinks; when its end was in view it would leave the screen, so it is revealed again.
				this.#revealStart = false;
				this.#endInView = false;
				this.#revealN++;
				return;
			}
			this.#setExpanded(true);
		}
		this.#message = "nothing to collapse · esc closes";
	}

	#enterLine(): void {
		if (!this.#cur) {
			this.#message = "no blocks";
			return;
		}
		this.#mode = "line";
		// Start on the part of the block in view (no jump on the first move): the row Esc left this block on, else
		// the last row of a block taller than the screen whose end is showing, else the first row.
		const rows = this.#rowsOf(this.#cur);
		const lastRow = Math.max(0, rows.rows.length - 1);
		const left = this.#leftLine?.block === this.#cur ? this.#leftLine : undefined;
		const tall = rows.rows.length > this.#host.rows() - 10;
		this.#row = left ? Math.min(left.row, lastRow) : tall && this.#endInView ? lastRow : 0;
		this.#col = left ? Math.min(left.col, Math.max(0, (rows.len[this.#row] ?? 0) - 1)) : 0;
		this.#want = displayColumn(rows.clusters[this.#row] ?? [], this.#col);
		// A tall block whose top was in view gets its first row aligned to the top again: swapping the block for its
		// rows makes Tern lose its scroll anchor (it sat inside the block) and shift the view.
		this.#revealStart = !left && tall && !this.#endInView;
		this.#revealN++;
	}

	/** v / Space (char-wise) and V in TEXT modes (line-wise): start, switch kind, or cancel back to TEXT. */
	#select(kind: "visual" | "vline"): void {
		if (this.#mode === kind) {
			this.#mode = "line";
			return;
		}
		if (!this.#lineMode()) this.#enterLine();
		if (!this.#cur) return;
		if (this.#mode === "line") {
			this.#anchor = this.#cur;
			this.#anchorIndex = this.#curIndex;
			this.#anchorRow = this.#row;
			this.#anchorCol = this.#col;
		}
		this.#mode = kind;
	}

	/** Esc: selection → TEXT → BLOCK → close (V-BLOCK drops to BLOCK first). */
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

	/** Leaves the TEXT modes for the block's own view (the card stays mounted); `l` resumes at this row. */
	#leaveLine(): void {
		if (this.#cur) this.#leftLine = { block: this.#cur, row: this.#row, col: this.#col };
		this.#mode = "block";
	}

	#jumpKind(kind: string, count: number): void {
		const step = count > 0 ? 1 : -1;
		let i = this.#curIndex;
		for (let left = Math.abs(count); left > 0; ) {
			i += step;
			if (i < 0 || i >= this.#list.length) break;
			const k = this.#list[i].kind;
			if (kind === "tool" ? TOOL_KINDS[k] : k === kind) {
				left--;
				if (left === 0) return this.#goto(i);
			}
		}
		this.#message = `no ${step > 0 ? "next" : "previous"} ${kind === "user" ? "prompt" : kind}`;
	}

	/** V in BLOCK modes: whole-block range. */
	#visualBlock(): void {
		if (this.#mode === "vblock") {
			this.#mode = "block";
			return;
		}
		this.#mode = "vblock";
		this.#anchor = this.#cur;
		this.#anchorIndex = this.#curIndex;
	}

	#swap(): void {
		if (this.#mode === "visual" || this.#mode === "vline") {
			const anchor: Pos = { idx: this.#anchorIndex, row: this.#anchorRow, col: this.#anchorCol };
			this.#anchor = this.#cur;
			this.#anchorIndex = this.#curIndex;
			this.#anchorRow = this.#row;
			this.#anchorCol = this.#col;
			this.#place(anchor.idx, anchor.row, anchor.col);
			this.#setCol(anchor.col);
			return;
		}
		if (this.#mode !== "vblock") return;
		const anchor = this.#anchorIndex;
		this.#anchor = this.#cur;
		this.#anchorIndex = this.#curIndex;
		this.#goto(anchor);
	}

	/** The VISUAL / V-LINE selection's ends in document order. */
	#selection(): { a: Pos; b: Pos } {
		const anchor: Pos = { idx: this.#anchorIndex, row: this.#anchorRow, col: this.#anchorCol };
		const cursor: Pos = { idx: this.#curIndex, row: this.#row, col: this.#col };
		const order = anchor.idx - cursor.idx || anchor.row - cursor.row || anchor.col - cursor.col;
		return order <= 0 ? { a: anchor, b: cursor } : { a: cursor, b: anchor };
	}

	/**
	 * Selected columns [from, to) of row `r` (grapheme length `len`) in navigable block `idx`, or undefined when the
	 * row is outside the selection. V-LINE takes whole rows; VISUAL runs from the first end's column to the last
	 * end's column inclusive.
	 */
	#spanAt(sel: { a: Pos; b: Pos }, idx: number, r: number, len: number): [number, number] | undefined {
		const { a, b } = sel;
		if (idx < a.idx || idx > b.idx || (idx === a.idx && r < a.row) || (idx === b.idx && r > b.row)) return undefined;
		if (this.#mode === "vline") return [0, len];
		const from = idx === a.idx && r === a.row ? a.col : 0;
		const to = idx === b.idx && r === b.row ? b.col + 1 : len;
		return [from, to];
	}

	/** Text of the cursor block, V-BLOCK range, cursor row or VISUAL / V-LINE selection. */
	#selectionText(): { text: string; what: string } {
		if (this.#lineMode() && this.#cur) {
			if (this.#mode === "line") return { text: this.#rowsOf(this.#cur).plain[this.#row] ?? "", what: "1 line" };
			const sel = this.#selection();
			// One chunk per block, joined by a blank line.
			const chunks: string[] = [];
			let lines = 0;
			for (let i = sel.a.idx; i <= sel.b.idx; i++) {
				const { plain, len, clusters } = this.#rowsOf(this.#list[i].block);
				const picked: string[] = [];
				for (let r = 0; r < plain.length; r++) {
					const span = this.#spanAt(sel, i, r, len[r]);
					if (span) picked.push(clusters[r].slice(span[0], span[1]).join(""));
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
		const sel = this.#list.slice(a, b + 1);
		return { text: sel.map(e => e.text).join("\n\n"), what: sel.length === 1 ? `1 ${sel[0].kind} block` : `${sel.length} blocks` };
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

	/** Copies `text`, then reports `done` in the status chip (a failure is a toast: it must not go unnoticed). */
	#copy(text: string, done: string, verb: string): void {
		this.#host.copy(text).then(
			() => {
				// The copy settles after the key's own status update, so this one updates the chip itself.
				this.#message = done;
				this.#updateStatus();
				this.#host.requestRender();
			},
			(err: unknown) => this.#host.notify(`${verb} failed: ${err instanceof Error ? err.message : String(err)}`),
		);
	}

	// ── hints ───────────────────────────────────────────────────────────────

	/** `f` / `F`: labels the blocks around the cursor and the targets inside them; selections are dropped. */
	#startHints(copy: boolean): void {
		const cx = this.#cx;
		if (!cx) {
			this.#message = "hints need Tern";
			return;
		}
		if (!this.#cur) {
			this.#message = "no blocks";
			return;
		}
		if (this.#mode === "visual" || this.#mode === "vline") this.#mode = "line";
		else if (this.#mode === "vblock") this.#mode = "block";
		const hint: HintSession = { copy, typed: "", items: [], restore: new Map(), n: ++this.#hintN };
		this.#hint = hint;
		this.#labelWindow(hint, cx);
	}

	/**
	 * Labels the blocks around the cursor. Blocks already labelled keep their labels, blocks that left the window lose
	 * theirs, and new ones get labels that none of the current ones starts (or is started by). Any change to a
	 * finished block's labels makes omp rebuild the block's content from scratch (Tern drew a rebuilt collapsed output
	 * as an empty gap at its full height), so labels only change for blocks entering or leaving the window.
	 */
	#labelWindow(hint: HintSession, cx: Cx): void {
		// Window: neighbours on each side until their summed height passes about one visible screen. Heights are
		// measured at the full terminal width while Tern wraps prose in a ~80-column reading column (about twice
		// as many lines), so 0.75 × rows of measured height ≈ 1.5 screens as shown. Fewer targets = shorter labels.
		const limit = this.#host.rows() * 0.75;
		let lo = this.#curIndex;
		let hi = this.#curIndex;
		for (let sum = 0; lo > 0 && sum <= limit; ) sum += this.#list[--lo].block.render(cx.cols).length;
		for (let sum = 0; hi < this.#list.length - 1 && sum <= limit; ) sum += this.#list[++hi].block.render(cx.cols).length;
		const window = this.#list.slice(lo, hi + 1);
		const inWindow = new Set(window.map(e => e.block));
		for (const [block, restore] of hint.restore) {
			if (inWindow.has(block)) continue;
			restore();
			hint.restore.delete(block);
		}
		hint.items = hint.items.filter(i => inWindow.has(i.block));
		const labelled = new Set(hint.items.map(i => i.block));

		const found: { block: Blk; target: HintTarget }[] = [];
		const trees = new Map<Blk, unknown>();
		for (const { block, kind } of window) {
			if (labelled.has(block)) continue;
			found.push({ block, target: { id: "block", action: { kind: "block" }, label: kind } });
			const tree = typeof block.describe === "function" ? block.describe(cx) : undefined;
			trees.set(block, tree);
			if (tree !== undefined) for (const target of collectTargets(tree)) found.push({ block, target });
		}
		const labels = hintLabels(hint.items.map(i => i.label), found.length, HINT_ALPHABET);
		if (!labels) {
			// Every letter is a label already: start the window over.
			for (const restore of hint.restore.values()) restore();
			hint.restore.clear();
			hint.items = [];
			return this.#labelWindow(hint, cx);
		}
		const fresh = found.map((f, i) => ({ ...f, label: labels[i] }));
		hint.items.push(...fresh);
		for (const [block, tree] of trees) {
			let own = "";
			const inner = new Map<string, string>();
			for (const item of fresh) {
				if (item.block !== block) continue;
				if (item.target.action.kind === "block") own = item.label;
				else inner.set(item.target.id, item.label);
			}
			const inside = tree !== undefined && labelBlock(tree, own) !== undefined;
			if (tree !== undefined && (inside || inner.size > 0)) {
				const restore = this.#labelInPlace(block, inside ? own : "", inner, hint);
				if (restore) hint.restore.set(block, restore);
			}
		}
	}

	/** Labels the block through its decorated describe; the returned undo restores omp's own describe. */
	#labelInPlace(block: Blk, own: string, labels: ReadonlyMap<string, string>, hint: HintSession): (() => void) | undefined {
		const state = this.#decorateBlock(block);
		if (!state) return undefined;
		state.hint = { own, labels, session: hint, sig: `${own}|${[...labels].map(([id, label]) => `${id}=${label}`).join(",")}` };
		return () => this.#removeDecoration(block);
	}

	#decorateBlock(block: Blk): BlockDecoration | undefined {
		const existing = this.#decorations.get(block);
		if (existing) return existing;
		if (typeof block.describe !== "function") return undefined;
		const state: BlockDecoration = {
			describe: block.describe,
			ownDescribe: Object.getOwnPropertyDescriptor(block, "describe"),
		};
		this.#decorations.set(block, state);
		block.describe = (cx: Cx) => {
			const tree = state.describe.call(block, cx);
			if (!tree || typeof tree !== "object") return tree;
			const hint = state.hint;
			let base = tree;
			if (hint) {
				// Shared across sessions: a block relabelled with the same labels (the window moved past it) gives Tern the
				// same object, so nothing in it is sent again. A finished tool block describes a new tree on every call and
				// omp rebuilds such a block child by child, which Tern drew as an empty gap at the output's expanded height;
				// so the labelled tree is kept while the undecorated tree is structurally unchanged. Comparing the tree, not
				// the rendered text, keeps native-only changes (usage, role, rewind badge) visible.
				const memo = this.#labelled.get(block);
				const typed = hint.session.typed;
				const labelSig = `${hint.sig}|${block === this.#cur}`;
				const shape = memo?.tree === tree ? memo.shape : JSON.stringify(tree);
				if (memo && memo.shape === shape && memo.typed === typed && memo.sig === labelSig) base = memo.out as object;
				else {
					const matching = new Map<string, string>();
					for (const [id, label] of hint.labels) if (label.startsWith(typed)) matching.set(id, label);
					const decorated = decorate(tree, matching, typed);
					base = (hint.own && hint.own.startsWith(typed) ? (labelBlock(decorated, hint.own, typed, block === this.#cur) ?? decorated) : decorated) as object;
					this.#labelled.set(block, { tree, shape, typed, sig: labelSig, out: base });
				}
			}
			return base;
		};
		return state;
	}

	#removeDecoration(block: Blk): void {
		const state = this.#decorations.get(block);
		if (!state) return;
		if (state.ownDescribe) Object.defineProperty(block, "describe", state.ownDescribe);
		else Reflect.deleteProperty(block, "describe");
		this.#decorations.delete(block);
	}

	#syncDecorations(): void {
		for (const [block, state] of this.#decorations) if (!state.hint) this.#removeDecoration(block);
	}

	/** Leaves HINT mode: the window blocks describe themselves again (their labels are patched out). */
	#endHints(): void {
		for (const restore of this.#hint?.restore.values() ?? []) restore();
		this.#hint = undefined;
		if (!this.#disposed) this.#syncDecorations();
	}

	/**
	 * HINT mode keys: letters narrow (an exact label activates), Backspace widens, h/j/k/l and the arrows move the
	 * cursor and place the labels again around it, anything else cancels.
	 */
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
			this.#endHints();
			return;
		}
		const typed = hint.typed + k.toUpperCase();
		const matching = hint.items.filter(i => i.label.startsWith(typed));
		if (matching.length === 0) {
			this.#endHints();
			this.#message = `no hint ${typed}`;
			return;
		}
		// Labels are prefix-free: an exact match is the only match.
		if (matching[0].label === typed) return this.#activate(matching[0], hint.copy);
		hint.typed = typed;
	}

	/**
	 * Moves the cursor `delta` blocks while hinting, keeping `f` / `F`. Inside the labelled window only the cursor
	 * card moves; past its ends the window follows the cursor, and blocks that stay in it keep their labels (see
	 * #labelWindow).
	 */
	#hintMove(delta: number): void {
		const hint = this.#hint;
		const to = Math.max(0, Math.min(this.#list.length - 1, this.#curIndex + delta));
		if (!hint || to === this.#curIndex) {
			this.#message = delta > 0 ? "last block" : "first block";
			return;
		}
		this.#goto(to);
		hint.typed = "";
		if (this.#cx && !hint.items.some(i => i.block === this.#cur)) this.#labelWindow(hint, this.#cx);
	}

	/**
	 * Leaves HINT mode with the cursor (BLOCK mode) on `item`'s block, then performs its action. Only a block label
	 * scrolls: a link, code or button label was on screen, so its block takes the cursor where it is.
	 */
	#activate(item: HintItem, copy: boolean): void {
		this.#endHints();
		const idx = this.#list.findIndex(e => e.block === item.block);
		if (idx < 0) {
			this.#message = "that block is gone";
			return;
		}
		const target = item.target.action.kind === "block"
			? item.target
			: this.#cx && typeof item.block.describe === "function"
				? collectTargets(item.block.describe(this.#cx)).find(t => t.id === item.target.id)
				: undefined;
		if (!target) {
			this.#message = "that target is gone";
			return;
		}
		this.#mode = "block";
		this.#goto(idx);
		const { action, label } = target;
		if (action.kind === "block") {
			this.#revealStart = false;
			this.#revealN++;
		} else {
			this.#sent = { n: this.#revealN, reveal: undefined, target: "" };
		}
		switch (action.kind) {
			case "block": {
				const entry = this.#list[idx];
				if (copy) return this.#copy(entry.text, `copied 1 ${entry.kind} block`, "copy");
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
				item.block.handleNativeEvent?.({ type: "action", key: action.key, act: action.act, mods: [] });
				this.#host.requestRender();
				this.#message = action.title;
				return;
		}
	}

	/** `c`: the selection goes into the prompt as a quote, and the prompt gets the keyboard to write around it. */
	#quote(): void {
		const { text } = this.#selectionText();
		if (this.#mode === "visual" || this.#mode === "vline" ? text === "" : !text.trim()) return;
		if (this.#mode === "visual" || this.#mode === "vline") this.#mode = "line";
		else if (this.#mode === "vblock") this.#mode = "block";
		this.#host.quote(text);
		this.#focusPrompt();
	}

	/** True while the prompt has the keyboard; index.ts then passes every key but Alt+K through to it. */
	get promptFocused(): boolean {
		return this.#promptFocus;
	}

	/**
	 * Vimnav keeps its key listener while its help sheet owns TUI focus. The find bar is passive (it never takes focus),
	 * so it does not count: a selector opened while it shows gets its keys.
	 */
	get ownsFocus(): boolean {
		return this.#help !== undefined;
	}

	/** Alt+K: hands the keyboard to the prompt or takes it back; vimnav remains active either way. */
	toggleFocus(): void {
		if (this.#promptFocus) {
			this.#promptFocus = false;
		} else {
			this.#focusPrompt();
		}
		this.#updateStatus();
		this.#host.requestRender();
	}

	/** Esc from the prompt: the keyboard comes back to vimnav in the block view (a TEXT position is kept for `l`). */
	leavePrompt(): void {
		this.#promptFocus = false;
		if (this.#lineMode()) this.#leaveLine();
		else this.#mode = "block";
		this.#updateStatus();
		this.#host.requestRender();
	}

	/** Leaves whatever is half-typed (hints, search, counts, help) and gives the prompt the keyboard. */
	#focusPrompt(): void {
		this.#endHints();
		this.#closeHelp();
		if (this.#search.typing) this.#searchKey("esc");
		this.#count = "";
		this.#pending = "";
		this.#message = "";
		this.#promptFocus = true;
		this.#updateStatus();
	}

	#toggleExpand(): void {
		const cur = this.#cur;
		if (!cur || typeof cur.setExpanded !== "function") {
			this.#message = "nothing to expand here";
			return;
		}
		this.#setExpanded(!(this.#expanded.get(cur) ?? this.#host.getToolsExpanded()));
	}

	#setExpanded(on: boolean): void {
		const cur = this.#cur;
		if (!cur || typeof cur.setExpanded !== "function") {
			this.#message = "nothing to expand here";
			return;
		}
		cur.setExpanded(on);
		this.#expanded.set(cur, on);
	}

	/** Matches over every block's TEXT rows: what the TEXT view shows, highlights and steps through. */
	#collectMatches(): void {
		const query = this.#search.query;
		const sources = this.#list.map(entry => this.#rowsOf(entry.block).plain);
		// #rowsOf hands back the same rows while a block renders the same, so identity is enough to skip the scan.
		if (query === this.#matchQuery && sources.length === this.#matchSources.length && sources.every((rows, i) => rows === this.#matchSources[i])) return;
		this.#matchQuery = query;
		this.#matchSources = sources;
		this.#matches = [];
		this.#matchRev++;
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
		// Matches are words, which only TEXT can show without rewriting omp's blocks: from the block view a match opens
		// TEXT on it, searching from the start of the cursor block.
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
				const candidates = this.#matches.map((hit, i) => ({ hit, i })).filter(({ hit }) => {
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
		const hit = this.#matches[current];
		this.#place(hit.idx, hit.row, hit.from);
		this.#setCol(hit.from);
		// The well is new even when the match is on the row the cursor already had: reveal it.
		if (entering) {
			this.#revealStart = false;
			this.#revealN++;
		}
		if (wrapped && !quiet) this.#message = "search wrapped";
	}

	handleNativeEvent(event: unknown): void {
		if (!event || typeof event !== "object" || !("type" in event) || event.type !== "action" || !("act" in event)) return;
		if (event.act !== "vimnav.find.prev" && event.act !== "vimnav.find.next") return;
		this.#refresh();
		this.#search.typing = false;
		this.#message = "";
		this.#findNext(event.act === "vimnav.find.prev" ? -this.#searchDir : this.#searchDir, 1);
		this.#updateStatus();
		this.#host.requestRender();
	}

	// ── status ──────────────────────────────────────────────────────────────

	#updateStatus(): void {
		if (this.#disposed) return;
		this.#syncFind();
		const hint = this.#hint;
		const pending = this.#count + this.#pending;
		let mode = this.#promptFocus ? "PROMPT" : hint ? hint.copy ? "HINT · COPY" : "HINT" : MODE_LABEL[this.#mode];
		if (pending) mode += ` ${pending}`;
		let pos: string;
		if (this.#promptFocus) {
			pos = "esc or ⌥K back to vimnav";
		} else if (hint) {
			pos = `${hint.items.filter(item => item.label.startsWith(hint.typed)).length} labels`;
		} else if (this.#search.shown) {
			this.#collectMatches();
			pos = `/${this.#search.query}${this.#search.current >= 0 ? ` · ${this.#search.current + 1} of ${this.#matches.length}` : ""}`;
		} else if (this.#lineMode() && this.#cur) {
			pos = `row ${this.#row + 1}/${this.#rowsOf(this.#cur).rows.length} · col ${this.#col + 1}`;
		} else {
			const entry = this.#list[this.#curIndex];
			const index = entry ? this.#curIndex + 1 : 0;
			const kind = entry ? entry.kind.charAt(0).toUpperCase() + entry.kind.slice(1) : "Empty";
			const lead = this.#mode === "vblock" ? `${entry ? Math.abs(this.#curIndex - this.#anchorIndex) + 1 : 0} blocks` : kind;
			pos = `${lead} · ${index}/${this.#list.length}`;
		}
		if (this.#message && !this.#promptFocus) pos = this.#message;
		if (mode === this.#status?.mode && pos === this.#status.pos) return;
		this.#status = { mode, pos };
		this.#host.status(this.#status);
	}

	#syncFind(): void {
		if (!this.#search.shown) {
			this.#find?.hide();
			this.#find = undefined;
			return;
		}
		if (this.#find) return;
		const panel = new FindBar(() => {
			this.#collectMatches();
			return { query: this.#search.query, typing: this.#search.typing, current: this.#search.current, count: this.#matches.length };
		}, event => this.handleNativeEvent(event));
		const overlay = this.#host.showOverlay(panel, { anchor: "top", width: "90%", maxHeight: "85%", passive: true });
		this.#find = { panel, hide: () => overlay.hide() };
	}

	#closeHelp(): void {
		this.#help?.hide();
		this.#help = undefined;
	}


	describe(cx: Cx): unknown {
		this.#cx = cx;
		this.#refresh();
		this.#updateStatus();
		return { k: "col", p: { hidden: true } };
	}

	render(): readonly string[] {
		return [];
	}
}

interface FindState {
	query: string;
	typing: boolean;
	current: number;
	count: number;
}

class FindBar implements Component {
	nativeOverlay = { role: "omp.vimnav.find", anchor: "top", size: "sm", head: undefined };
	#state: () => FindState;
	#action: (event: unknown) => void;
	#stamp = "";
	#node: unknown;

	constructor(state: () => FindState, action: (event: unknown) => void) {
		this.#state = state;
		this.#action = action;
	}

	describe(): unknown {
		const { query, typing, current, count } = this.#state();
		const stamp = JSON.stringify([query, typing, current, count]);
		if (this.#node && stamp === this.#stamp) return this.#node;
		this.#stamp = stamp;
		const text = count === 0 ? "No matches" : current < 0 ? `${count} matches` : `${current + 1} of ${count}`;
		this.#node = {
			k: "row",
			p: { role: "omp.vimnav.find-bar", align: "center", gap: "none" },
			c: [
				{ k: "icon", p: { name: "search" } },
				{ k: "row", p: { role: "omp.vimnav.find-q", gap: "none", align: "center" }, c: [
					{ k: "text", p: { text: query } },
					...(typing ? [{ k: "text", p: { text: "", role: "omp.vimnav.find-caret" } }] : []),
				] },
				{ k: "text", p: { role: count ? "omp.vimnav.find-n" : "omp.vimnav.find-n.none", text } },
				{ k: "row", p: { role: "omp.vimnav.find-btn", title: "Previous match · N", actions: { click: "vimnav.find.prev" } }, c: [{ k: "icon", p: { name: "arrow-up" } }] },
				{ k: "row", p: { role: "omp.vimnav.find-btn", title: "Next match · n", actions: { click: "vimnav.find.next" } }, c: [{ k: "icon", p: { name: "arrow-down" } }] },
			],
		};
		return this.#node;
	}

	handleNativeEvent(event: unknown): void {
		this.#action(event);
	}

	render(): readonly string[] {
		return [];
	}
}

/** The native key sheet owns its query; unchanged queries reuse the described tree. */
class HelpPanel implements Component {
	nativeOverlay = { role: "omp.overlay.vimnav-help", anchor: "center", size: "lg", head: undefined };
	#current: string;
	#query = "";
	#describedQuery: string | undefined;
	#node: unknown;

	constructor(current: Mode | "hint") {
		this.#current = current === "hint" ? "Hints" : current === "block" || current === "vblock" ? "Blocks" : "Text cursor";
	}

	handleInput(data: string): boolean {
		const k = keyName(data);
		if (k === "esc" || k === "enter") return true;
		if (k === "backspace") {
			this.#query = graphemes(this.#query).slice(0, -1).join("");
		} else {
			const text = extractPrintableText(data);
			if (text !== undefined) this.#query += text;
		}
		return false;
	}

	describe(): unknown {
		if (this.#describedQuery !== this.#query) {
			this.#node = this.#build();
			this.#describedQuery = this.#query;
		}
		return this.#node;
	}

	#build(): unknown {
		const query = this.#query.toLowerCase();
		const pattern = query ? new RegExp(this.#query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu") : undefined;
		const spans = (text: string): { t: string; s?: string }[] => {
			if (!pattern) return [{ t: text }];
			const out: { t: string; s?: string }[] = [];
			let end = 0;
			for (const match of text.matchAll(pattern)) {
				const start = match.index;
				if (start > end) out.push({ t: text.slice(end, start) });
				out.push({ t: match[0], s: "mark" });
				end = start + match[0].length;
			}
			if (end < text.length) out.push({ t: text.slice(end) });
			return out;
		};
		const ordered = [
			...HELP_SECTIONS.filter(s => s.title === this.#current),
			...HELP_SECTIONS.filter(s => s.title !== this.#current),
		];
		let count = 1;
		const groups = ordered.map((s, n) => {
			const hints = s.hints.filter(h => !query || h.label.toLowerCase().includes(query) || h.keys.some(k => helpKeyText(k).toLowerCase().includes(query)));
			count += hints.reduce((total, h) => total + h.keys.length, 0);
			const now = s.title === this.#current;
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
		return {
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
								{ k: "text", p: { spans: [{ t: this.#query || "Type a key or action", ...(this.#query ? {} : { s: "muted" }) }] }, key: "query" },
								...(this.#query ? [{ k: "text", p: { role: "omp.vimnav.help-caret", spans: [{ t: "" }] }, key: "caret" }] : []),
							],
						},
					],
				},
				{
					k: "row",
					p: { role: "omp.vimnav.help-body" },
					key: "body",
					c: [0, 1, 2].map(n => ({ k: "col", p: { role: "omp.vimnav.help-column", grow: 1 }, key: `col${n}`, c: groups.slice(n * 2, n * 2 + 2) })),
				},
				{ k: "text", p: { role: "omp.vimnav.help-foot", spans: [{ t: "Case matters: zR and zM differ" }] }, key: "foot" },
			],
		};
	}

	render(): readonly string[] {
		return [];
	}

	invalidate(): void {}
}

/** Strips SGR backgrounds and folds bright content foregrounds into normal slots, reserving 9–15 for the well. */
function prepareWellRow(row: string): string {
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
			kept.push(n >= 91 && n <= 97 ? String(n - 60) : p[i]);
		}
		return kept.length > 0 ? `\x1b[${kept.join(";")}m` : "";
	});
}
