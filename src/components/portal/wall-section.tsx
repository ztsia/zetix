import { QuoteIcon } from 'lucide-react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Item, ItemContent, ItemDescription, ItemGroup } from '@/components/ui/item';
import type { WallNote } from '@/lib/portal/wall';

/**
 * §13.4's public wall, as a ticket holder sees it.
 *
 * **A Server Component with no state**, unlike the notes form beside it. It
 * takes a list and prints it, which is the whole section — marking it
 * `'use client'` would ship a renderer to the browser to draw text that never
 * changes after paint.
 *
 * **Anonymity was applied by the query, not here** (`lib/portal/wall.ts`). A
 * withheld name is absent from this component's props rather than present and
 * unprinted, so it never reaches the browser at all.
 *
 * `"{body}" — from {display_name}` is `admin.md` §14.2's own rendering, kept
 * identical on both surfaces so that an admin reading the console sees a note
 * the way the audience will.
 */
export function WallSection({ notes }: { notes: WallNote[] }) {
  /**
   * An empty wall draws nothing at all. Every other section on this page
   * renders its own empty state, because each one is a thing the guest can act
   * on; the wall is other people's words, and "no notes yet" on a page whose
   * own form is three sections up reads as a prompt to go back and write one.
   */
  if (notes.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <QuoteIcon className="size-4 text-muted-foreground" />
          From the audience
        </CardTitle>
        <CardDescription>What others said about tonight.</CardDescription>
      </CardHeader>
      <CardContent>
        <ItemGroup className="gap-3">
          {notes.map((note) => (
            <Item key={note.id} variant="muted" size="sm">
              <ItemContent>
                <p className="text-sm whitespace-pre-wrap">{note.body}</p>
                <ItemDescription>
                  {note.displayName ? `— ${note.displayName}` : '— Anonymous'}
                </ItemDescription>
              </ItemContent>
            </Item>
          ))}
        </ItemGroup>
      </CardContent>
    </Card>
  );
}
