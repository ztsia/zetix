import { Construction } from 'lucide-react';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Badge } from '@/components/ui/badge';

/**
 * The empty state for a route that exists but whose screen belongs to a wave-2
 * module (spec/modules.md §3).
 *
 * Naming the owning module matters more than it looks: eight sessions run in
 * parallel against this skeleton, and a page that just says "coming soon" gives
 * a reviewer no way to tell an unbuilt screen from a broken one.
 */
export function ModulePlaceholder({
  title,
  description,
  module,
}: {
  title: string;
  description: string;
  module: string;
}) {
  return (
    <Empty className="border-border min-h-[60vh] rounded-lg border border-dashed">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Construction />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Badge variant="secondary">
          {module === 'V2' ? 'Deferred to V2' : `Built by module ${module}`}
        </Badge>
      </EmptyContent>
    </Empty>
  );
}
