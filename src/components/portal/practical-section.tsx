import { InfoIcon } from 'lucide-react';
import { RichText } from '@/components/forms/rich-text';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * §13.3 item 5 — per-concert practical info: parking, latecomers, the interval.
 *
 * **Rendered through `RichText`, never through `dangerouslySetInnerHTML`.**
 * `concerts.practical_info_md` is admin-authored Markdown landing on a page a
 * stranger opens with a token, which is exactly the boundary
 * `lib/forms/rich-text.ts` was written for: it parses to a tree of React nodes
 * so there is no HTML string to sanitise and no sanitiser to get wrong. The
 * alternative — `marked` into `innerHTML`, as the *email* renderer may safely do
 * because a mail client executes nothing — would put this surface one clever
 * `[link](javascript:…)` away from running script in a guest's browser.
 *
 * Reused rather than reimplemented: the component lives under `components/forms/`
 * because `K` built it, but nothing about it is form-specific.
 */
export function PracticalSection({ markdown }: { markdown: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle role="heading" aria-level={2} className="flex items-center gap-2 text-base">
          <InfoIcon className="size-4 text-muted-foreground" />
          Before you come
        </CardTitle>
      </CardHeader>
      <CardContent>
        <RichText markdown={markdown} className="text-sm leading-relaxed" />
      </CardContent>
    </Card>
  );
}
