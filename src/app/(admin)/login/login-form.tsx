'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { KeyRound } from 'lucide-react';
import { signInConsole } from '@/lib/auth/actions';
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
 * The console form: email and password, for a named `ADMIN` or `VIEWER`
 * account (spec/v3.md §28). Underneath it is an ordinary Supabase password
 * sign-in — no bespoke session.
 */
export function AdminLoginForm({ next }: { next: string | null }) {
  const [state, formAction] = useActionState(signInConsole, NO_STATE);
  const describedBy = state.error ? 'login-error' : undefined;

  return (
    <form action={formAction} className="flex flex-col gap-4">
      {next && <input type="hidden" name="next" value={next} />}

      <Field>
        <FieldLabel htmlFor="email">Email</FieldLabel>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          autoFocus
          required
          aria-invalid={state.error ? true : undefined}
          aria-describedby={describedBy}
        />
      </Field>

      <Field>
        <FieldLabel htmlFor="password">Password</FieldLabel>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          // Passwords are generated and pasted; a browser that "helpfully"
          // capitalises or corrects one makes it wrong.
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          aria-invalid={state.error ? true : undefined}
          aria-describedby={describedBy}
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
