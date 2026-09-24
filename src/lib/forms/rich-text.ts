/**
 * The markdown subset a form's copy may use, parsed to a tree.
 *
 * **No HTML string is produced anywhere, and that is the point.** `description_md`
 * and `help_md` are admin-authored and render on a **public** page — unlike
 * `src/lib/email/render.ts`, whose output lands in a mail client that executes
 * nothing. Running admin markdown through a markdown-to-HTML library and into
 * `dangerouslySetInnerHTML` would put the registration surface one compromised
 * admin session, or one clever `[link](javascript:…)`, away from executing
 * script in a stranger's browser.
 *
 * The alternative to sanitising is not needing to: this parses to a small tree
 * of nodes the renderer turns into React elements, so there is no HTML string
 * to sanitise and no sanitiser to get wrong. What it costs is markdown a form
 * description does not need — tables, images, raw HTML — and what it buys is a
 * boundary that cannot be bypassed by an input this module did not anticipate.
 *
 * Pure, so `L`'s preview, `M`'s public form and the tests all see the same tree.
 */

export type InlineNode =
  | { kind: 'text'; text: string }
  | { kind: 'strong'; children: InlineNode[] }
  | { kind: 'em'; children: InlineNode[] }
  | { kind: 'link'; href: string; children: InlineNode[] };

export type BlockNode =
  | { kind: 'paragraph'; children: InlineNode[] }
  | { kind: 'list'; items: InlineNode[][] };

/**
 * Schemes a link may use.
 *
 * A link whose href is anything else — `javascript:`, `data:`, a scheme nobody
 * has thought of yet — renders as its **text, with no anchor at all**. Dropping
 * the link rather than the whole node keeps the sentence readable; rendering a
 * disabled-looking anchor would invite someone to "fix" it by relaxing this
 * list.
 */
const SAFE_SCHEMES = ['http:', 'https:', 'mailto:'];

export function isSafeHref(href: string): boolean {
  const trimmed = href.trim();
  // A same-origin path is safe and needs no parsing. `//host` is not a path —
  // it is a protocol-relative URL to another origin — so it is excluded.
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) return true;
  try {
    return SAFE_SCHEMES.includes(new URL(trimmed).protocol);
  } catch {
    return false;
  }
}

/** Parse one piece of copy. Empty or whitespace-only input yields no blocks. */
export function parseRichText(markdown: string): BlockNode[] {
  const blocks: BlockNode[] = [];
  // A blank line ends a paragraph or a list, as it does in markdown.
  for (const chunk of markdown.replace(/\r\n/g, '\n').split(/\n\s*\n/)) {
    const lines = chunk.split('\n').map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0) continue;

    let run: string[] = [];
    let items: string[] = [];

    const flushParagraph = () => {
      if (run.length === 0) return;
      blocks.push({ kind: 'paragraph', children: parseInline(run.join(' ')) });
      run = [];
    };
    const flushList = () => {
      if (items.length === 0) return;
      blocks.push({ kind: 'list', items: items.map(parseInline) });
      items = [];
    };

    for (const line of lines) {
      const bullet = /^[-*]\s+(.*)$/.exec(line);
      if (bullet) {
        flushParagraph();
        items.push(bullet[1] ?? '');
      } else {
        flushList();
        run.push(line);
      }
    }
    flushParagraph();
    flushList();
  }

  return blocks;
}

/**
 * `**strong**`, `*emphasis*` and `[text](href)`, nested.
 *
 * Scanned left to right taking whichever construct opens first, rather than by
 * regex replacement, so `**bold with a [link](https://example.com)**` nests
 * instead of one pattern eating the other's delimiters.
 */
function parseInline(source: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  let plain = '';

  const flush = () => {
    if (plain) nodes.push({ kind: 'text', text: plain });
    plain = '';
  };

  let i = 0;
  while (i < source.length) {
    const rest = source.slice(i);

    const strong = /^\*\*([\s\S]+?)\*\*/.exec(rest);
    if (strong) {
      flush();
      nodes.push({ kind: 'strong', children: parseInline(strong[1] ?? '') });
      i += strong[0].length;
      continue;
    }

    // After `**`, so a bold run is never read as two emphases.
    const em = /^\*([^*\n]+?)\*/.exec(rest);
    if (em) {
      flush();
      nodes.push({ kind: 'em', children: parseInline(em[1] ?? '') });
      i += em[0].length;
      continue;
    }

    /**
     * `[text](href)`, where `href` may contain one level of balanced
     * parentheses — `…/Concerto_(music)` is a real URL, and stopping at the
     * first `)` would truncate it and leave a stray bracket in the sentence.
     */
    const link = /^\[([^\]]*)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/.exec(rest);
    if (link) {
      flush();
      const [, text = '', href = ''] = link;
      const children = parseInline(text);
      nodes.push(
        isSafeHref(href)
          ? { kind: 'link', href: href.trim(), children }
          : // Not an anchor. The words survive; the scheme does not.
            { kind: 'text', text },
      );
      i += link[0].length;
      continue;
    }

    plain += source[i];
    i += 1;
  }

  flush();
  return nodes;
}

/** The copy with every mark removed — for a `title` attribute or a plain-text export. */
export function richTextToPlain(markdown: string): string {
  return parseRichText(markdown)
    .map((block) =>
      block.kind === 'paragraph'
        ? inlineToPlain(block.children)
        : block.items.map((item) => `• ${inlineToPlain(item)}`).join('\n'),
    )
    .join('\n\n');
}

function inlineToPlain(nodes: readonly InlineNode[]): string {
  return nodes
    .map((node) => (node.kind === 'text' ? node.text : inlineToPlain(node.children)))
    .join('');
}
