import { EyeIcon } from 'lucide-react';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';

/**
 * Stands in for a screen that is nothing but a mutation — an upload flow, a
 * provisioning form — when a viewer opens it (spec/v3.md §28). The screen is
 * still reachable, so the nav stays the same for everyone; it just says what
 * it is for rather than offering steps the server would refuse.
 */
export function ReadOnlyNotice({ title, description }: { title: string; description: string }) {
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <EyeIcon />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
