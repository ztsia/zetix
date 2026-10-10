import { cn } from '@/lib/utils';
import { TEAR_STUB_TRANSFORM, TEAR_UPPER } from '../_lib/tear';

/**
 * The Tear mark, coloured by the house lights: ink and coral on paper, warm white and the lighter
 * coral on ink, as in `public/brand/`.
 */
export function Mark({ className, label }: { className?: string; label?: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      className={cn('zx-mark', className)}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <path className="zx-mark__ticket" d={TEAR_UPPER} />
      <path className="zx-mark__stub" d={TEAR_UPPER} transform={TEAR_STUB_TRANSFORM} />
    </svg>
  );
}

/** "zetix", set in Sora as in the lockup. */
export function Wordmark({ className }: { className?: string }) {
  return <span className={cn('zx-wordmark', className)}>zetix</span>;
}
