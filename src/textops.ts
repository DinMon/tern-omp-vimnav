// Pure text helpers for in-place copy mode: ANSI-aware highlighting and vim word motions.
// Columns index grapheme clusters of the plain text, not code points or display cells.

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const clusterCache = new Map<string, readonly string[]>();

/** Cached clusters shared by row positioning, selection and word motions. */
export function graphemes(plain: string): readonly string[] {
	const cached = clusterCache.get(plain);
	if (cached) return cached;
	const clusters = Array.from(segmenter.segment(plain), part => part.segment);
	if (clusterCache.size >= 256) clusterCache.delete(clusterCache.keys().next().value!);
	clusterCache.set(plain, clusters);
	return clusters;
}

/** Display-cell offset of a grapheme column. */
export function displayColumn(clusters: readonly string[], col: number): number {
	let cells = 0;
	for (let i = 0; i < col && i < clusters.length; i++) cells += Bun.stringWidth(clusters[i]);
	return cells;
}

/** Grapheme covering a desired display cell, clamped to the row. Infinity means its last grapheme. */
export function graphemeColumn(clusters: readonly string[], want: number): number {
	let cells = 0;
	for (let i = 0; i < clusters.length; i++) {
		cells += Bun.stringWidth(clusters[i]);
		if (cells > want) return i;
	}
	return Math.max(0, clusters.length - 1);
}

/** Length of the escape sequence starting at i. */
function escapeLength(row: string, i: number): number {
	const kind = row[i + 1];
	if (kind === "[") {
		let j = i + 2;
		while (j < row.length) {
			const code = row.charCodeAt(j);
			if (code >= 0x40 && code <= 0x7e) return j + 1 - i;
			j++;
		}
		return row.length - i;
	}
	if (kind === "]") {
		let j = i + 2;
		while (j < row.length) {
			if (row[j] === "\x07") return j + 1 - i;
			if (row[j] === "\x1b" && row[j + 1] === "\\") return j + 2 - i;
			j++;
		}
		return row.length - i;
	}
	return kind === undefined ? 1 : 2;
}

/** Paint sorted, non-overlapping grapheme spans, restoring source foreground/bold and padding past the row. */
export function paintCells(row: string, paints: readonly { from: number; to: number; sgr: string }[]): string {
	if (paints.length === 0) return row;
	const clusters = graphemes(Bun.stripANSI(row));
	let out = "";
	let foreground = "39";
	let bold = false;
	let col = 0;
	let offset = 0;
	let boundary = clusters[0]?.length ?? 0;
	let paintIndex = 0;
	let active = false;
	for (let i = 0; i < row.length;) {
		if (row[i] === "\x1b") {
			const len = escapeLength(row, i);
			const seq = row.slice(i, i + len);
			if (seq.startsWith("\x1b[") && seq.endsWith("m")) {
				const params = seq.slice(2, -1).split(";");
				for (let p = 0; p < params.length; p++) {
					const n = Number(params[p]);
					if (n === 38 || n === 48 || n === 58) {
						const count = params[p + 1] === "2" ? 5 : params[p + 1] === "5" ? 3 : 1;
						if (n === 38) foreground = params.slice(p, p + count).join(";");
						p += count - 1;
					} else if (n === 0) {
						foreground = "39";
						bold = false;
					} else if (n === 1) bold = true;
					else if (n === 22) bold = false;
					else if ((n >= 30 && n <= 37) || (n >= 90 && n <= 97) || n === 39) foreground = String(n);
				}
			}
			out += seq;
			if (active && seq.startsWith("\x1b[") && seq.endsWith("m")) out += `\x1b[${paints[paintIndex].sgr}m`;
			i += len;
			continue;
		}
		while (paintIndex < paints.length && col >= paints[paintIndex].to) paintIndex++;
		const paint = paints[paintIndex];
		if (!active && paint && col >= paint.from && col < paint.to) {
			out += `\x1b[${paint.sgr}m`;
			active = true;
		}
		const ch = String.fromCodePoint(row.codePointAt(i)!);
		out += ch;
		offset += ch.length;
		i += ch.length;
		if (offset === boundary) {
			col++;
			boundary += clusters[col]?.length ?? 0;
			if (active && paint && col >= paint.to) {
				out += `\x1b[49;${foreground};${bold ? "1" : "22"}m`;
				active = false;
			}
		}
	}
	for (; paintIndex < paints.length; paintIndex++) {
		const paint = paints[paintIndex];
		if (col >= paint.to) continue;
		if (col < paint.from) {
			out += " ".repeat(paint.from - col);
			col = paint.from;
		}
		if (!active) out += `\x1b[${paint.sgr}m`;
		out += " ".repeat(paint.to - col);
		out += `\x1b[49;${foreground};${bold ? "1" : "22"}m`;
		active = false;
		col = paint.to;
	}
	return out;
}

type CharClass = 0 | 1 | 2;

/** Classify by the cluster's first code point: whitespace, word, or punctuation. */
function charClass(ch: string): CharClass {
	const first = String.fromCodePoint(ch.codePointAt(0)!);
	if (/\s/u.test(first)) return 0;
	if (/[\p{L}\p{N}_]/u.test(first)) return 1;
	return 2;
}

/** Next word start (vim w), or undefined if exhausted. */
export function nextWordStart(plain: string, col: number): number | undefined {
	const cls = graphemes(plain).map(charClass);
	let i = Math.max(0, col);
	if (i >= cls.length) return undefined;
	const start = cls[i];
	if (start !== 0) while (i < cls.length && cls[i] === start) i++;
	while (i < cls.length && cls[i] === 0) i++;
	return i < cls.length ? i : undefined;
}

/** End of the word at/after col (vim e), or undefined if exhausted. */
export function wordEnd(plain: string, col: number): number | undefined {
	const cls = graphemes(plain).map(charClass);
	let i = Math.max(0, col + 1);
	while (i < cls.length && cls[i] === 0) i++;
	if (i >= cls.length) return undefined;
	while (i + 1 < cls.length && cls[i + 1] === cls[i]) i++;
	return i;
}

/** Start of the previous word (vim b), or undefined if exhausted. */
export function prevWordStart(plain: string, col: number): number | undefined {
	const cls = graphemes(plain).map(charClass);
	let i = Math.min(col, cls.length) - 1;
	while (i >= 0 && cls[i] === 0) i--;
	if (i < 0) return undefined;
	while (i > 0 && cls[i - 1] === cls[i]) i--;
	return i;
}

/** First nonblank grapheme column (0 if none). */
export function firstNonBlank(plain: string): number {
	const i = graphemes(plain).findIndex(ch => !/\s/u.test(String.fromCodePoint(ch.codePointAt(0)!)));
	return i < 0 ? 0 : i;
}
