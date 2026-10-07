import { graphemes } from "./textops";

/** A match as grapheme columns [from, to) of its text. */
export interface Occurrence {
	from: number;
	to: number;
}

/** Match only complete graphemes; lowercase offsets may expand (for example İ). */
export function occurrences(text: string, query: string): Occurrence[] {
	if (!query) return [];
	const clusters = graphemes(text);
	const folded = [0];
	let low = "";
	for (const cluster of clusters) {
		low += cluster.toLowerCase();
		folded.push(low.length);
	}
	const boundaries = new Map(folded.map((offset, col) => [offset, col]));
	// Fold the query grapheme by grapheme like the text: a whole-string lowercase applies context rules (final sigma).
	const q = graphemes(query).map(cluster => cluster.toLowerCase()).join("");
	const out: Occurrence[] = [];
	for (let at = low.indexOf(q); at >= 0; at = low.indexOf(q, at + q.length)) {
		const from = boundaries.get(at);
		const to = boundaries.get(at + q.length);
		if (from !== undefined && to !== undefined) out.push({ from, to });
	}
	return out;
}
