// Keyboard hint targets for described Tern node trees: finds the actionable elements inside a block
// (buttons, links, commands, paths, code, output) and decorates a copy of the tree with out-of-flow ink tags.

export type HintAction =
	| { kind: "block" }
	| { kind: "copy"; text: string }
	| { kind: "link"; href: string }
	| { kind: "action"; key: string; act: string; title: string };

export interface HintTarget {
	/** Unique within one block's target list; stable across calls for the same node tree. */
	id: string;
	action: HintAction;
	/** Short human label for the HUD flash. */
	label: string;
}

interface Node {
	k?: string;
	p?: Record<string, unknown>;
	c?: unknown[];
	key?: string;
}

/** Where a node's own target labels are anchored in `decorate`. */
type Placement = "wrap" | "tool" | "md";

interface Owned {
	target: HintTarget;
	placement: Placement;
	/** Where an md target's label goes in the md node's original text. */
	md?: { at: number; fence?: FenceSite };
}

/** A fenced block's source span: label paragraph goes before the opening line at `at`; `end` is past the closing line. */
interface FenceSite {
	lang: string;
	/** Leading whitespace of the fence line (keeps the label inside list items). */
	indent: string;
	/** The preceding line is not blank, so the label paragraph needs a blank line before it. */
	gap: boolean;
	/** Offset just past the closing fence line (its newline excluded). */
	end: number;
}

interface MarkdownScan {
	links: { text: string; href: string; at: number }[];
	code: { lang: string; code: string; at: number; site: FenceSite }[];
}

const LABEL_MAX = 40;
const SENTINEL = "\u2063";
const KEY_ESCAPES: Record<string, string> = { "%": "%25", "/": "%2F", "^": "%5E" };
const KEY_UNESCAPES: Record<string, string> = { "%25": "%", "%2F": "/", "%5E": "^" };

/**
 * `count` new labels that keep `used` plus themselves prefix-free (no label starts another), so labels already on
 * screen stay as they are when the labelled window moves. The free prefixes (one letter where possible) are the first
 * candidates; the shortest is split into its one-letter-longer children until there are enough. Undefined when no
 * prefix is free (every letter is a label): then only relabelling everything can make room.
 */
export function hintLabels(used: readonly string[], count: number, alphabet: string): string[] | undefined {
	if (count <= 0) return [];
	const chars = [...alphabet.toUpperCase()];
	// The largest prefixes no used label equals, starts or is started by.
	const free = (prefix: string): string[] => {
		if (used.includes(prefix)) return [];
		if (!used.some(u => u.startsWith(prefix))) return [prefix];
		return chars.flatMap(ch => free(prefix + ch));
	};
	const queue = chars.flatMap(ch => free(ch)).sort((a, b) => a.length - b.length);
	if (queue.length === 0) return undefined;
	while (queue.length < count) {
		const shortest = queue.shift() as string;
		queue.push(...chars.map(ch => shortest + ch));
	}
	return queue.slice(0, count);
}

/** Links at their first counted occurrence, closed fences at their opening line. */
function scanMarkdown(md: string): MarkdownScan {
	const links: MarkdownScan["links"] = [];
	const code: MarkdownScan["code"] = [];
	const seen = new Set<string>();
	const lines = md.split("\n");
	const starts: number[] = [];
	let offset = 0;
	for (const line of lines) {
		starts.push(offset);
		offset += line.length + 1;
	}
	let prose: string[] = [];
	let proseStart = 0;
	const flushProse = () => {
		if (prose.length === 0) return;
		let text = prose.join("\n");
		prose = [];
		// Backticks inside a span are literal unless the whole run matches its opener.
		const runs = [...text.matchAll(/`+/g)];
		for (let r = 0; r < runs.length; r++) {
			let close = r + 1;
			while (close < runs.length && runs[close][0].length !== runs[r][0].length) close++;
			if (close === runs.length) continue;
			const at = runs[r].index;
			const end = runs[close].index + runs[close][0].length;
			text = text.slice(0, at) + " ".repeat(end - at) + text.slice(end);
			r = close;
		}
		text = text.replace(/^[ \t]*(?:>[ \t]*)*\[[^\]\n]+\]:[^\n]*/gm, line => " ".repeat(line.length));
		const re = /!?\[([^\]\n]*)\]\(|<(https?:\/\/[^\s>]+)>|(https?:\/\/[^\s<>`]+)/g;
		for (let m = re.exec(text); m; m = re.exec(text)) {
			let href: string;
			let label: string;
			if (m[1] !== undefined) {
				let cursor = re.lastIndex;
				while (/[ \t]/.test(text[cursor] ?? "") && cursor < text.length) cursor++;
				const start = cursor;
				let depth = 0;
				const angle = text[cursor] === "<";
				if (angle) cursor++;
				const destStart = cursor;
				while (cursor < text.length) {
					const ch = text[cursor];
					if (ch === "\\" && cursor + 1 < text.length) {
						cursor += 2;
						continue;
					}
					if (angle ? ch === ">" : (ch === ")" && depth === 0) || /\s/.test(ch)) break;
					if (!angle && ch === "(") depth++;
					if (!angle && ch === ")") depth--;
					cursor++;
				}
				const destEnd = cursor;
				if (angle && text[cursor++] !== ">") continue;
				if (depth !== 0 || cursor === start) continue;
				while (/[ \t]/.test(text[cursor] ?? "") && cursor < text.length) cursor++;
				if (text[cursor] === '"' || text[cursor] === "'" || text[cursor] === "(") {
					const closer = text[cursor] === "(" ? ")" : text[cursor];
					cursor++;
					while (cursor < text.length && text[cursor] !== closer && text[cursor] !== "\n") {
						cursor += text[cursor] === "\\" ? 2 : 1;
					}
					if (text[cursor++] !== closer) continue;
					while (/[ \t]/.test(text[cursor] ?? "") && cursor < text.length) cursor++;
				}
				if (text[cursor] !== ")") continue;
				re.lastIndex = cursor + 1;
				href = text.slice(destStart, destEnd).replace(/\\([\\()])/g, "$1");
				label = m[1].trim() || href;
			} else if (m[2] !== undefined) {
				href = m[2];
				label = href;
			} else {
				href = m[3];
				let balance = 0;
				for (const ch of href) {
					if (ch === "(") balance++;
					if (ch === ")") balance--;
				}
				while (/[.,;:\]>'"]$/.test(href) || (href.endsWith(")") && balance < 0)) {
					if (href.endsWith(")")) balance++;
					href = href.slice(0, -1);
				}
				label = href;
			}
			if (seen.has(href)) continue;
			seen.add(href);
			links.push({ text: label, href, at: proseStart + m.index });
		}
	};
	let i = 0;
	let quoteDepth = 0;
	const listIndents: number[] = [];
	while (i < lines.length) {
		const quote = /^ {0,3}(?:>[ \t]?)+/.exec(lines[i])?.[0] ?? "";
		const depth = (quote.match(/>/g) ?? []).length;
		if (depth !== quoteDepth) {
			listIndents.length = 0;
			quoteDepth = depth;
		}
		const content = lines[i].slice(quote.length);
		const leading = /^[ ]*/.exec(content)![0].length;
		if (content.trim()) {
			while (listIndents.length && leading < listIndents[listIndents.length - 1]) listIndents.pop();
		}
		const list = /^([ ]*)(?:[-+*]|\d{1,9}[.)])([ \t]+)(?=\S)/.exec(content);
		let containerIndent = listIndents[listIndents.length - 1] ?? 0;
		let fenceContent = content;
		let fenceIndent = leading;
		if (list && list[1].length - containerIndent <= 3) {
			containerIndent = list[0].length;
			listIndents.push(containerIndent);
			fenceContent = content.slice(containerIndent);
			fenceIndent = containerIndent + /^[ ]*/.exec(fenceContent)![0].length;
		} else {
			fenceContent = content.slice(containerIndent);
		}
		const open = /^ {0,3}(`{3,}|~{3,})([^\n]*)$/.exec(fenceContent);
		if (open && (open[1][0] !== "`" || !open[2].includes("`"))) {
			flushProse();
			const fence = open[1];
			const close = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t]*\\r?$`);
			let end = i + 1;
			while (end < lines.length) {
				const endQuote = /^ {0,3}(?:>[ \t]?)+/.exec(lines[end])?.[0] ?? "";
				const endDepth = (endQuote.match(/>/g) ?? []).length;
				const endContent = lines[end].slice(endQuote.length);
				if (endDepth === depth && endContent.startsWith(" ".repeat(containerIndent)) && close.test(endContent.slice(containerIndent))) break;
				end++;
			}
			// A fence inside a list item gets no target: its label would split it out of the list's markdown, which then
			// renders the indented fence as plain indented code and drops the rest of the item from the list.
			if (end < lines.length && containerIndent === 0) {
				// Exactly the fence's own quote depth comes off each line; a further `>` is code.
				const quotePrefix = new RegExp(`^ {0,3}(?:>[ \\t]?){${depth}}`);
				const body = lines.slice(i + 1, end).map(line => {
					if (depth > 0) line = line.slice(quotePrefix.exec(line)?.[0].length ?? 0);
					const spaces = /^[ ]*/.exec(line)![0].length;
					return line.slice(Math.min(spaces, fenceIndent));
				});
				const lang = open[2].trim().split(/\s+/)[0];
				code.push({
					lang,
					code: body.join("\n"),
					at: starts[i],
					site: {
						lang,
						indent: quote + " ".repeat(fenceIndent),
						gap: i > 0 && lines[i - 1].trim() !== "",
						end: starts[end] + lines[end].length,
					},
				});
			}
			// Even a streaming, unclosed fence owns its entire remaining body.
			i = end + 1;
			continue;
		}
		if (prose.length === 0) proseStart = starts[i];
		prose.push(lines[i]);
		i++;
	}
	flushProse();
	return { links, code };
}

/** Element targets inside one described block tree, in document order (not including the block itself). */
export function collectTargets(node: unknown): HintTarget[] {
	const out: HintTarget[] = [];
	if (!isNode(node)) return out;
	const seen = new Set<string>();
	const walk = (n: Node, path: string) => {
		for (const owned of ownTargets(n, path, seen)) out.push(owned.target);
		if (n.p?.collapsed === true || !n.c) return;
		const paths = childKeypaths(n.c, path);
		n.c.forEach((child, i) => {
			const childPath = paths[i];
			if (childPath !== null && isNode(child)) walk(child, childPath);
		});
	};
	walk(node, "");
	return out;
}

/** A copy of the tree with out-of-flow ink tags on labelled targets; untouched subtrees retain their identity. */
export function decorate(node: unknown, labels: ReadonlyMap<string, string>, typed = ""): unknown {
	if (!isNode(node)) return node;
	const seen = new Set<string>();
	const visit = (n: Node, path: string): Node | Node[] => {
		const owned = ownTargets(n, path, seen).filter(o => labels.has(o.target.id));
		let children = n.c;
		if (n.p?.collapsed !== true && n.c) {
			const paths = childKeypaths(n.c, path);
			let changed = false;
			let split = false;
			const next: unknown[] = [];
			n.c.forEach((child, i) => {
				const childPath = paths[i];
				if (childPath === null || !isNode(child)) {
					next.push(child);
					return;
				}
				const out = visit(child, childPath);
				if (Array.isArray(out)) {
					changed = split = true;
					next.push(...out);
					return;
				}
				if (out !== child) changed = true;
				// Once a child expanded into several nodes, later unkeyed siblings keep their keypath via an explicit
				// key equal to their original index (target ids were computed on the undecorated tree).
				next.push(split && out.key === undefined ? { ...out, key: String(i) } : out);
			});
			if (changed) children = next;
		}
		const result: Node = children === n.c ? n : { ...n, c: children };
		if (owned.length === 0) return result;

		const md = owned.filter(o => o.placement === "md");
		const tool = owned.filter(o => o.placement === "tool");
		const wrap = owned.filter(o => o.placement === "wrap");
		const labelled = md.length > 0 ? labelMarkdown(result, md, labels, typed) : result;
		if (Array.isArray(labelled)) return labelled;
		let single = labelled;
		if (tool.length > 0) {
			const tones = ["pending", "error", "pending"];
			const badges: unknown[] = Array.isArray(single.p?.badges) ? single.p.badges : [];
			const tags = tool.flatMap((o, i) => hintBadges(labels.get(o.target.id) ?? "", typed, tones[i]));
			single = { ...single, p: { ...single.p, badges: [...badges, ...tags] } };
		}
		if (wrap.length > 0) {
			if (Array.isArray(single.c)) {
				single = { ...single, c: [...wrap.map((o, i) => hintNode(labels.get(o.target.id) ?? "", typed, "omp.vimnav.hint", `vimnav-hint-${i}`)), ...keyHintChildren(single.c)] };
			} else if (single.k === "text") {
				const spans: unknown[] = Array.isArray(single.p?.spans) ? single.p.spans : [{ t: single.p?.text ?? "" }];
				const next: unknown[] = [];
				const placed = new Set<Owned>();
				for (const span of spans) {
					for (const o of wrap) {
						if (o.target.action.kind !== "link" || !span || typeof span !== "object" || !("href" in span) || span.href !== o.target.action.href || placed.has(o)) continue;
						next.push(...hintSpans(labels.get(o.target.id) ?? "", typed, "key ins"));
						placed.add(o);
					}
					next.push(span);
				}
				const leading = wrap.filter(o => !placed.has(o));
				const { text: _text, ...props } = single.p ?? {};
				single = { ...single, p: { ...props, spans: [...leading.flatMap(o => hintSpans(labels.get(o.target.id) ?? "", typed, "key ins")), ...next] } };
			} else {
				single = {
					k: "col",
					key: single.key,
					p: { role: "omp.vimnav.hint-anchor", gap: "none" },
					c: [{ ...single, key: "node" }, ...wrap.map((o, i) => hintNode(labels.get(o.target.id) ?? "", typed, "omp.vimnav.hint", `vimnav-hint-${i}`))],
				};
			}
		}
		return single;
	};
	const out = visit(node, "");
	return Array.isArray(out) ? { k: "col", p: { gap: "sm" }, key: node.key, c: out } : out;
}

/** A block label stays on its root: a margin node for containers, a zero-advance span for prose leaves. */
export function labelBlock(node: unknown, label: string, typed = "", cursor = false): unknown {
	if (!isNode(node)) return undefined;
	if (node.k === "tool") {
		const badges: unknown[] = Array.isArray(node.p?.badges) ? node.p.badges : [];
		return { ...node, p: { ...node.p, badges: [...badges, ...hintBadges(label, typed, cursor ? "accent" : "neutral")] } };
	}
	if (Array.isArray(node.c)) {
		return { ...node, c: [hintNode(label, typed, cursor ? "omp.vimnav.hint.block.cur" : "omp.vimnav.hint.block", "vimnav-hint"), ...keyHintChildren(node.c)] };
	}
	const spans = hintSpans(label, typed, cursor ? "key ins strong accent" : "key ins strong");
	if (node.k === "text") {
		const existing: unknown[] = Array.isArray(node.p?.spans) ? node.p.spans : [{ t: node.p?.text ?? "" }];
		const { text: _text, ...props } = node.p ?? {};
		return { ...node, p: { ...props, spans: [...spans, ...existing] } };
	}
	if (node.k === "md") {
		const text = typeof node.p?.text === "string" ? node.p.text : "";
		const lead = /^[ \t]*(?:(?:#{1,6}|[-*+]|\d+[.)]|>)[ \t]+)*/.exec(text)?.[0] ?? "";
		const marks: unknown[] = Array.isArray(node.p?.marks) ? node.p.marks : [];
		return { ...node, p: { ...node.p, text: lead + spans.map(s => s.t).join("") + text.slice(lead.length), marks: [...marks, ...spans] } };
	}
	return undefined;
}

function hintNode(label: string, typed: string, role: string, key: string): Node {
	const spans: { t: string; s?: string }[] = [];
	if (typed) spans.push({ t: typed, s: "em" });
	spans.push({ t: label.slice(typed.length) });
	return { k: "text", key, p: { role, spans } };
}

function hintBadges(label: string, typed: string, tone: string): { text: string; tone: string }[] {
	const badges = [{ text: label, tone }];
	if (typed) {
		const block = tone === "neutral" || tone === "accent";
		const overlayTone = block && label.length >= 3 ? "muted" : block && label.length === 2 ? "info" : tone;
		badges.push({ text: typed, tone: overlayTone });
	}
	return badges;
}

function keyHintChildren(children: unknown[]): unknown[] {
	// Prepending a tag must not change the reconciler path of an originally unkeyed child.
	return children.map((child, i) => {
		if (!isNode(child) || child.key !== undefined) return child;
		return { ...child, key: String(i) };
	});
}

function hintSpans(label: string, typed: string, tokens: string): { t: string; s: string }[] {
	const lengthTokens = label.length >= 3 ? " num path" : label.length === 2 ? " num" : "";
	const spans = [{ t: `${SENTINEL}${label}${SENTINEL}`, s: tokens + lengthTokens }];
	if (typed) {
		const typedTokens = typed.length >= 3 ? " num path" : typed.length === 2 ? " num" : "";
		// Block overlays also need the full label's width to share its margin offset.
		const blockTokens = tokens.includes("strong") ? (label.length >= 3 ? " muted dim" : label.length === 2 ? " muted" : "") : "";
		spans.push({ t: `\u2064${typed}\u2064`, s: `${tokens} em${typedTokens}${blockTokens}` });
	}
	return spans;
}

/** Markdown links use zero-advance marks; fences keep their existing split, with an out-of-flow label over the head. */
function labelMarkdown(node: Node, owned: Owned[], labels: ReadonlyMap<string, string>, typed: string): Node | Node[] {
	const text = node.p?.text;
	if (typeof text !== "string") return node;
	const marks: unknown[] = Array.isArray(node.p?.marks) ? [...node.p.marks] : [];
	const inserts: { at: number; text: string; remove: number }[] = [];
	const splits: { site: FenceSite; at: number; label: string }[] = [];
	for (const o of owned) {
		const label = labels.get(o.target.id);
		if (label === undefined || !o.md) continue;
		const fence = o.md.fence;
		if (fence) {
			splits.push({ site: fence, at: o.md.at, label });
			continue;
		}
		const spans = hintSpans(label, typed, "key ins");
		marks.push(...spans);
		const cap = spans.map(s => s.t).join("");
		const href = o.target.action.kind === "link" ? o.target.action.href : "";
		const bare = href !== "" && text.startsWith(href, o.md.at);
		inserts.push({ at: o.md.at, text: bare ? `${cap}<${href}>` : cap, remove: bare ? href.length : 0 });
	}
	if (inserts.length === 0 && splits.length === 0) return node;
	const prose = (from: number, to: number): string => {
		let out = text.slice(from, to);
		const inside = inserts.filter(ins => ins.at >= from && ins.at < to).sort((a, b) => b.at - a.at);
		for (const ins of inside) out = out.slice(0, ins.at - from) + ins.text + out.slice(ins.at - from + ins.remove);
		return out;
	};
	if (splits.length === 0) return { ...node, p: { ...node.p, text: prose(0, text.length), marks } };

	splits.sort((a, b) => a.at - b.at);
	const base = node.key ?? "md";
	const pieces: Node[] = [];
	const pushProse = (from: number, to: number) => {
		const part = prose(from, to);
		if (!part.trim()) return;
		pieces.push({ ...node, key: pieces.length === 0 ? node.key : `${base}:vimnav-md-${pieces.length}`, p: { ...node.p, text: part, marks } });
	};
	let from = 0;
	for (const split of splits) {
		pushProse(from, split.at);
		pieces.push({
			k: "col",
			p: { role: "omp.vimnav.hint-anchor", gap: "none" },
			key: pieces.length === 0 ? node.key : `${base}:vimnav-code-${pieces.length}`,
			c: [
				{ ...node, key: "md", p: { ...node.p, text: text.slice(split.at, split.site.end) } },
				hintNode(split.label, typed, "omp.vimnav.hint.code", "vimnav-hint"),
			],
		});
		from = split.site.end;
	}
	pushProse(from, text.length);
	return pieces;
}

function isNode(value: unknown): value is Node {
	return (
		typeof value === "object" &&
		value !== null &&
		!("render" in value && typeof value.render === "function") &&
		"k" in value &&
		typeof value.k === "string"
	);
}

/**
 * Tern's child keypaths: key (escaped) or index, "/"-joined, duplicates suffixed "~n"; null for component refs.
 * The same rule (and KEY_ESCAPES) as omp's TSP reconciler, so target ids match the ids omp gives Tern.
 */
function childKeypaths(children: unknown[], parent: string): (string | null)[] {
	const used = new Set<string>();
	return children.map((child, i) => {
		if (typeof child === "object" && child !== null && "render" in child && typeof child.render === "function") {
			return null;
		}
		const key = isNode(child) ? child.key : undefined;
		const segment = key === undefined ? String(i) : key.replace(/[%/^]/g, ch => KEY_ESCAPES[ch]);
		let path = parent === "" ? segment : `${parent}/${segment}`;
		if (children.length > 1) {
			if (used.has(path)) {
				let n = 2;
				while (used.has(`${path}~${n}`)) n++;
				path = `${path}~${n}`;
			}
			used.add(path);
		}
		return path;
	});
}

function truncate(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** First span text pointing at `href` below `node`, else the node's own title/text. */
function linkText(node: Node, href: string): string {
	const stack: unknown[] = [node];
	while (stack.length > 0) {
		const n = stack.shift();
		if (!isNode(n)) continue;
		const spans = n.p?.spans;
		if (Array.isArray(spans)) {
			for (const span of spans) {
				if (span?.href === href && typeof span.t === "string" && span.t.trim()) return span.t.trim();
			}
		}
		if (n.c) stack.push(...n.c);
	}
	const own = node.p?.title ?? node.p?.text;
	return typeof own === "string" && own.trim() ? own.trim() : href;
}

/** Targets owned by `node` itself (not its descendants); `seen` dedupes links by href across the block. */
function ownTargets(node: Node, path: string, seen: Set<string>): Owned[] {
	const p = node.p ?? {};
	const out: Owned[] = [];
	const addLink = (href: string, text: string, placement: Placement, id: string, at?: number) => {
		try {
			const url = new URL(href);
			if (url.protocol !== "http:" && url.protocol !== "https:") return;
		} catch {
			return;
		}
		if (seen.has(href)) return;
		seen.add(href);
		out.push({
			target: { id, action: { kind: "link", href }, label: `link · ${truncate(text, LABEL_MAX)}` },
			placement,
			md: at === undefined ? undefined : { at },
		});
	};

	const actions = p.actions;
	const click = typeof actions === "object" && actions !== null && "click" in actions ? actions.click : undefined;
	if (typeof click === "string") {
		const titleSource = p.title ?? p.text;
		const title = typeof titleSource === "string" && titleSource ? titleSource : click;
		out.push({
			target: {
				id: `act:${path}`,
				action: {
					kind: "action",
					key: path.split("/").map(segment => segment.replace(/%25|%2F|%5E/g, escape => KEY_UNESCAPES[escape])).join("/"),
					act: click,
					title,
				},
				label: title,
			},
			placement: node.k === "tool" ? "tool" : "wrap",
		});
	}

	if (node.k === "tool") {
		const name = typeof p.name === "string" && p.name ? p.name : "tool";
		if (typeof p.target === "string" && p.target) {
			if (p.targetKind === "command") {
				out.push({
					target: {
						id: `cmd:${path}`,
						action: { kind: "copy", text: p.target },
						label: `${name} command`,
					},
					placement: "tool",
				});
			} else if (p.targetKind === "path") {
				out.push({
					target: {
						id: `path:${path}`,
						action: { kind: "copy", text: p.target },
						label: `path · ${truncate(p.target, LABEL_MAX)}`,
					},
					placement: "tool",
				});
			}
		}
		if (typeof p.href === "string" && p.href) {
			addLink(p.href, typeof p.target === "string" && p.target ? p.target : p.href, "tool", `link:${p.href}`);
		}
		return out;
	}

	if (typeof p.href === "string" && p.href) addLink(p.href, linkText(node, p.href), "wrap", `link:${p.href}`);

	if (Array.isArray(p.spans)) {
		for (const span of p.spans) {
			if (typeof span?.href !== "string" || !span.href) continue;
			const text = typeof span.t === "string" && span.t.trim() ? span.t.trim() : span.href;
			addLink(span.href, text, "wrap", `link:${span.href}`);
		}
	}

	if (node.k === "code" && typeof p.text === "string" && p.text) {
		const lang = typeof p.lang === "string" && p.lang ? p.lang : "";
		out.push({
			target: {
				id: `code:${path}`,
				action: { kind: "copy", text: p.text },
				label: lang ? `${lang} code` : "code",
			},
			placement: "wrap",
		});
	}

	if (node.k === "ansi" && typeof p.text === "string" && p.text && typeof p.role === "string" && p.role.endsWith(".output")) {
		out.push({
			target: { id: `out:${path}`, action: { kind: "copy", text: p.text }, label: "output" },
			placement: "wrap",
		});
	}

	if (node.k === "md" && typeof p.text === "string" && p.text) {
		const md = scanMarkdown(p.text);
		const first = out.length;
		md.code.forEach((block, n) => {
			out.push({
				target: {
					id: `md:${path}:code:${n}`,
					action: { kind: "copy", text: block.code },
					label: block.lang ? `${block.lang} code` : "code",
				},
				placement: "md",
				md: { at: block.at, fence: block.site },
			});
		});
		for (const link of md.links) addLink(link.href, link.text, "md", `md:${path}:link:${link.href}`, link.at);
		// Reading order, so labels run top to bottom: code blocks and links interleave by position.
		const mdTargets = out.splice(first).sort((a, b) => (a.md?.at ?? 0) - (b.md?.at ?? 0));
		out.push(...mdTargets);
	}

	return out;
}
