import { Fragment } from 'react';
import { parseRichText, type BlockNode, type InlineNode } from '@/lib/forms/rich-text';

/**
 * A form's copy, rendered from the markdown subset in
 * `src/lib/forms/rich-text.ts`.
 *
 * **There is no `dangerouslySetInnerHTML` here and there must never be one.**
 * This copy is admin-authored and this page is public; the parser produces a
 * tree precisely so the renderer never has an HTML string to trust. See that
 * module for the full argument.
 *
 * Not a client component: it holds no state, so both surfaces can render it on
 * the server and send no JavaScript for the words.
 */
export function RichText({
  markdown,
  className,
}: {
  markdown: string | undefined;
  className?: string;
}) {
  const blocks = markdown ? parseRichText(markdown) : [];
  if (blocks.length === 0) return null;

  return (
    <div className={className}>
      {blocks.map((block, index) => (
        <RichBlock key={index} block={block} />
      ))}
    </div>
  );
}

function RichBlock({ block }: { block: BlockNode }) {
  if (block.kind === 'list') {
    return (
      <ul className="my-2 list-disc space-y-1 pl-5">
        {block.items.map((item, index) => (
          <li key={index}>
            <Inline nodes={item} />
          </li>
        ))}
      </ul>
    );
  }

  return (
    <p className="my-2 first:mt-0 last:mb-0">
      <Inline nodes={block.children} />
    </p>
  );
}

function Inline({ nodes }: { nodes: readonly InlineNode[] }) {
  return (
    <>
      {nodes.map((node, index) => (
        <Fragment key={index}>
          {node.kind === 'text' ? (
            node.text
          ) : node.kind === 'strong' ? (
            <strong className="font-semibold">
              <Inline nodes={node.children} />
            </strong>
          ) : node.kind === 'em' ? (
            <em>
              <Inline nodes={node.children} />
            </em>
          ) : (
            <a
              href={node.href}
              className="underline underline-offset-2 hover:no-underline"
              /**
               * Every link in a form's copy leaves the form. `noopener` because
               * the new tab must not reach back into this one, and `nofollow`
               * because the page carries a token and is `noindex` anyway
               * (`ref.md` §7).
               */
              target="_blank"
              rel="noopener noreferrer nofollow"
            >
              <Inline nodes={node.children} />
            </a>
          )}
        </Fragment>
      ))}
    </>
  );
}
