import { BookOpenIcon, DownloadIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

/**
 * §13.3 item 2 — the programme booklet, in a mobile viewer with a download link.
 *
 * **The `<iframe>` is the viewer, and that is deliberate.** Every phone browser
 * ships a PDF reader; embedding one from npm would add a megabyte of JavaScript
 * to a page whose whole brief is "loads on 3G" (spec/surfaces.md §15.3) and
 * would render worse than the native one on the two platforms that matter.
 *
 * **The download link is not a fallback, it is the point.** A browser that will
 * not render a PDF inline — several Android ones still will not — must still
 * give the guest their programme, and a reader who wants to keep it should not
 * have to find a menu. So the frame is the convenience and the button is the
 * guarantee, rather than the other way round.
 */
export function BookletSection({
  title,
  href,
}: {
  title: string;
  href: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <BookOpenIcon className="size-4 text-muted-foreground" />
          {title}
        </CardTitle>
        <CardDescription>Tonight&rsquo;s programme.</CardDescription>
      </CardHeader>
      <CardContent>
        {/*
         * A phone-shaped box, sized by aspect ratio so the page does not jump
         * when the PDF paints — layout shift on a slow connection is what this
         * ratio is buying, not the shape itself.
         *
         * `loading="lazy"` keeps a multi-megabyte download off the critical
         * path: the booklet is the heaviest thing this page can offer and the
         * ticket above it is the thing the guest came for.
         */}
        <iframe
          src={href}
          title={title}
          loading="lazy"
          className="aspect-[3/4] w-full rounded-lg border bg-muted"
        />
      </CardContent>
      <CardFooter>
        <Button
          variant="outline"
          size="lg"
          className="w-full"
          render={<a href={`${href}?download=1`} target="_blank" rel="noreferrer noopener" />}
        >
          <DownloadIcon data-icon="inline-start" />
          Download the programme
        </Button>
      </CardFooter>
    </Card>
  );
}
