import { cn } from '@/lib/utils';

/**
 * The film's caption plate: a ticket, notched at both ends, with a coral stub behind a perforation
 * on the left. The phrase in `<em>` is the one in coral. It takes the opposite of the house lights:
 * ink on paper, paper on ink.
 */
export function Plate({
  children,
  size = 'md',
  as: Tag = 'p',
  className,
}: {
  children: React.ReactNode;
  size?: 'md' | 'lg';
  as?: 'p' | 'h2' | 'h3';
  className?: string;
}) {
  return <Tag className={cn('zx-plate', size === 'lg' && 'zx-plate--lg', className)}>{children}</Tag>;
}
