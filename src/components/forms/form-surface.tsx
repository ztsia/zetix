import { cn } from '@/lib/utils';

/**
 * The pieces a form page is built from, drawn the way Google Forms draws them
 * (spec/v2.md §8.2).
 *
 * **Why Google Forms, specifically.** Every round of this concert so far was
 * collected there, so the people answering already know how a form looks: a
 * tinted page, a header card with a coloured band along the top, one white card
 * per question, a red asterisk for required, and Submit bottom-left with "Clear
 * form" opposite. Matching that costs nothing and means nobody has to learn a
 * new form. The builder draws its cards from these same pieces, so what an admin
 * edits is what a registrant sees.
 *
 * Every colour is a `--form-*` token from `globals.css` — the accent, the canvas
 * and the card — so the look is set in one place and has a dark variant.
 *
 * Server-safe: nothing here holds state, so the confirmation and closed pages
 * can use them without shipping JavaScript.
 */

/** A white card on the form canvas: 8px radius, hairline border, 24px padding. */
export function FormCard({
  className,
  invalid,
  children,
  ...props
}: React.ComponentProps<'div'> & { invalid?: boolean }) {
  return (
    <div
      data-slot="form-card"
      data-invalid={invalid || undefined}
      className={cn(
        'bg-form-card text-card-foreground rounded-lg border border-form-line p-6',
        'data-invalid:border-form-error',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

/**
 * The card at the top of every form: a 10px accent band, the title, the
 * introduction, and — when anything is required — the line that says what the
 * asterisk means.
 *
 * `children` sits under the introduction, above the rule, which is where
 * anything the reader should see before the first question goes: the seat
 * indicator, a "we did not recognise that link" note.
 */
export function FormHeaderCard({
  title,
  description,
  requiredNote = false,
  children,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  requiredNote?: boolean;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      data-slot="form-header-card"
      className={cn(
        'bg-form-card text-card-foreground overflow-hidden rounded-lg border border-form-line',
        className,
      )}
    >
      <div className="bg-form-accent h-2.5" aria-hidden />
      <div className="flex flex-col gap-3 px-6 pt-5 pb-5">
        <h1 className="text-[28px] leading-9 font-normal text-balance sm:text-[32px] sm:leading-10">
          {title}
        </h1>
        {description ? <div className="text-sm leading-6">{description}</div> : null}
        {children}
      </div>
      {requiredNote ? (
        <p className="text-form-error border-t border-form-line px-6 py-3 text-sm">
          * Indicates required question
        </p>
      ) : null}
    </div>
  );
}

/**
 * A section's heading, between two runs of questions.
 *
 * Google Forms draws a section as its own card with a small accent tab reading
 * "Section 2 of 3" sitting on its top edge; that tab is what tells a reader the
 * questions below belong together. The tab is left off when there is only one
 * section, where it would count to one.
 */
export function SectionHeaderCard({
  index,
  total,
  title,
  children,
}: {
  index: number;
  total: number;
  title: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div data-slot="form-section-header" className="flex flex-col">
      {total > 1 ? (
        <div className="bg-form-accent text-form-accent-foreground self-start rounded-t-lg px-4 py-2 text-sm font-medium">
          Section {index + 1} of {total}
        </div>
      ) : null}
      <div
        className={cn(
          'bg-form-card text-card-foreground flex flex-col gap-2 rounded-lg border border-form-line px-6 py-5',
          total > 1 && 'rounded-tl-none border-t-form-accent border-t-[3px]',
        )}
      >
        <h2 className="text-xl leading-7 font-normal">{title}</h2>
        {children}
      </div>
    </div>
  );
}

/** The red asterisk. `aria-hidden`, because the control itself says `required`. */
export function RequiredMark({ required }: { required: boolean }) {
  if (!required) return null;
  return (
    <span className="text-form-error ml-1" aria-hidden>
      *
    </span>
  );
}

/**
 * A question's error, as Google Forms shows it: a red line under the answer
 * with a warning mark in front.
 */
export function QuestionError({ id, children }: { id?: string; children: React.ReactNode }) {
  return (
    <p
      id={id}
      role="alert"
      data-slot="field-error"
      className="text-form-error mt-3 flex items-center gap-2 text-xs"
    >
      <svg viewBox="0 0 24 24" className="size-5 shrink-0 fill-current" aria-hidden>
        <path d="M11 15h2v2h-2zm0-8h2v6h-2zm.99-5C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8z" />
      </svg>
      {children}
    </p>
  );
}

/**
 * The accent-filled button Google Forms uses for Submit and Next. A plain
 * element rather than `Button`, because `Button`'s variants are the console's
 * neutral palette and this one has to wear the form's accent.
 */
export function FormPrimaryButton({ className, ...props }: React.ComponentProps<'button'>) {
  return (
    <button
      className={cn(
        'bg-form-accent text-form-accent-foreground inline-flex h-9 items-center justify-center gap-2 rounded px-6 text-sm font-medium',
        'shadow-sm transition-shadow hover:shadow-md focus-visible:ring-form-accent focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none',
        'disabled:pointer-events-none disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

/** The accent-coloured text button — "Clear form", "Back". */
export function FormTextButton({ className, ...props }: React.ComponentProps<'button'>) {
  return (
    <button
      type="button"
      className={cn(
        'text-form-accent hover:bg-form-accent-soft inline-flex h-9 items-center justify-center rounded px-3 text-sm font-medium',
        'focus-visible:ring-form-accent focus-visible:ring-2 focus-visible:outline-none',
        'disabled:pointer-events-none disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}
