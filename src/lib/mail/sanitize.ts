import sanitizeHtml from 'sanitize-html';

/**
 * Mail HTML, made safe to render in the console (spec/v3.md §26, P's note on
 * `email_messages.html`).
 *
 * It is mail from strangers, so the rules are narrow on purpose:
 *
 * - **No scripts, styles, forms, frames or event handlers** — `sanitize-html`'s
 *   defaults already refuse these; nothing below widens them.
 * - **No images.** A remote image is a read receipt: rendering a guest's
 *   reply would tell whoever wrote the pixel that an admin opened it, and
 *   when. A `cid:` image would not resolve anyway, since attachments are not
 *   stored.
 * - **Links open in a new tab without an opener**, so a link in a reply can
 *   neither navigate the console nor reach back into it.
 */
export function sanitizeMailHtml(html: string | null | undefined): string | null {
  if (!html) return null;
  const clean = sanitizeHtml(html, {
    allowedTags: sanitizeHtml.defaults.allowedTags.filter((tag) => tag !== 'img'),
    allowedAttributes: { a: ['href', 'title', 'target', 'rel'], td: ['colspan', 'rowspan'], th: ['colspan', 'rowspan'] },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowProtocolRelative: false,
    transformTags: {
      a: sanitizeHtml.simpleTransform('a', { target: '_blank', rel: 'noopener noreferrer nofollow' }),
    },
    // `<style>` and `<script>` contents are dropped with their tags, not kept as text.
    nonTextTags: ['style', 'script', 'textarea', 'option', 'noscript', 'title', 'head'],
  }).trim();
  return clean.length > 0 ? clean : null;
}
