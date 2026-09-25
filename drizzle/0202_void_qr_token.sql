-- 0202 — Void and re-issue QR (module `S`, spec/v3.md §23.4, decision 55).
--
-- `qr_token` has been immutable for the life of an attendee since 0001
-- (decision 28). V3 narrows that by exactly one named command: *Void and
-- re-issue QR*, for a leaked or disputed ticket. It is explicit, audited, and
-- warns that any copy already printed stops working.
--
-- The trigger stays and keeps refusing every other writer. The command sets a
-- **transaction-local** flag, `zetix.voiding_qr`, for the one statement that
-- replaces the token, the same pattern `zetix.granting` uses for the seat guards
-- (0001). A flag set with `set_config(…, true)` cannot outlive the transaction
-- that set it, so no connection in the pool can be left able to rewrite tokens.
--
-- Clearing a token is still refused even under the flag: a void replaces the
-- token, it never leaves a confirmed seat with none.
--
-- Additive (`modules-v3.md` §3.3): one function body replaced, same trigger.

create or replace function tg_qr_token_immutable() returns trigger
language plpgsql as $$
begin
  if old.qr_token is not null and new.qr_token is distinct from old.qr_token then
    if coalesce(current_setting('zetix.voiding_qr', true), '') = 'on'
       and new.qr_token is not null then
      return new;
    end if;
    raise exception 'qr_token is immutable for the life of an attendee (attendee %)', old.id
      using hint = 'Reissuing re-renders the PDF and may repin the template version; it never mints a new token. Only the Void and re-issue QR command may replace one (decision 55).';
  end if;
  return new;
end;
$$;
