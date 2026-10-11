import { cn } from '@/lib/utils';

/**
 * A row of perforation dots, punched one after another when the page opens, as the film's overture
 * punches the mark's cut. Pure CSS, so it runs before hydration and costs nothing after.
 */
export function Perforation({ count = 34, className }: { count?: number; className?: string }) {
  return (
    <div className={cn('zx-perf', className)} aria-hidden>
      {Array.from({ length: count }, (_, index) => (
        <i key={index} style={{ '--i': index } as React.CSSProperties} />
      ))}
    </div>
  );
}
