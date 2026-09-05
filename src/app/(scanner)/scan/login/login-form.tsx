'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { LogIn } from 'lucide-react';
import { signInOperator } from '@/lib/auth/actions';
import { NO_STATE } from '@/lib/auth/login-state';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Alert, AlertTitle } from '@/components/ui/alert';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Spinner } from '@/components/ui/spinner';

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" className="h-12 w-full text-base" disabled={pending}>
      {pending ? <Spinner /> : <LogIn />}
      {pending ? 'Signing in…' : 'Sign in'}
    </Button>
  );
}

/**
 * The usher's sign-in: a display name and an access code, both issued by the
 * admin (spec/checkin.md §12.1).
 *
 * **There is no email in the operator's world.** The synthetic
 * `<slug>@operators.invalid` address is derived on the server and never shown or
 * typed. Controls are sized for a thumb in a dim foyer, not a desk.
 */
export function OperatorLoginForm({ next }: { next: string | null }) {
  const [state, formAction] = useActionState(signInOperator, NO_STATE);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      {next && <input type="hidden" name="next" value={next} />}

      <Field>
        <FieldLabel htmlFor="displayName">Display name</FieldLabel>
        <Input
          id="displayName"
          name="displayName"
          autoComplete="username"
          autoFocus
          required
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className="h-12 text-base"
          aria-describedby="name-hint"
        />
        <FieldDescription id="name-hint">
          The name the admin gave you, exactly as written.
        </FieldDescription>
      </Field>

      <Field>
        <FieldLabel htmlFor="code">Access code</FieldLabel>
        <Input
          id="code"
          name="code"
          type="password"
          autoComplete="current-password"
          required
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className="h-12 text-base"
          aria-invalid={state.error ? true : undefined}
          aria-describedby={state.error ? 'scan-login-error' : undefined}
        />
      </Field>

      {state.error && (
        <Alert variant="destructive" id="scan-login-error" role="alert">
          <AlertTitle>{state.error}</AlertTitle>
        </Alert>
      )}

      <SubmitButton />
    </form>
  );
}
