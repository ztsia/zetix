'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { KeyRound } from 'lucide-react';
import { signInAdmin } from '@/lib/auth/actions';
import { NO_STATE } from '@/lib/auth/login-state';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Alert, AlertTitle } from '@/components/ui/alert';
import { Field, FieldLabel } from '@/components/ui/field';
import { Spinner } from '@/components/ui/spinner';

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" className="w-full" disabled={pending}>
      {pending ? <Spinner /> : <KeyRound />}
      {pending ? 'Checking…' : 'Sign in'}
    </Button>
  );
}

/**
 * The admin form asks for the code and nothing else.
 *
 * There is one shared committee account and its address is a server-side
 * constant, so nobody has to remember an email (spec/admin.md §14.3). Underneath
 * it is still an ordinary Supabase password sign-in — no bespoke session.
 */
export function AdminLoginForm({ next }: { next: string | null }) {
  const [state, formAction] = useActionState(signInAdmin, NO_STATE);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      {next && <input type="hidden" name="next" value={next} />}

      <Field>
        <FieldLabel htmlFor="code">Admin code</FieldLabel>
        <Input
          id="code"
          name="code"
          type="password"
          autoComplete="current-password"
          autoFocus
          required
          // The committee pastes a long generated passphrase; a browser that
          // "helpfully" capitalises or corrects it makes the code wrong.
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          aria-invalid={state.error ? true : undefined}
          aria-describedby={state.error ? 'login-error' : undefined}
        />
      </Field>

      {state.error && (
        <Alert variant="destructive" id="login-error" role="alert">
          <AlertTitle>{state.error}</AlertTitle>
        </Alert>
      )}

      <SubmitButton />
    </form>
  );
}
