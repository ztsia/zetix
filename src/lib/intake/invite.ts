import 'server-only';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { defineCommand, SkipItem, type AnyCommand, type Tx } from '@/lib/commands/define';
import { idSchema } from '@/lib/commands/selection';
import { defaultTemplateFor } from '@/lib/delivery/purposes';
import { escapeMergeValues, renderTemplate } from '@/lib/email/render';
import { draftSuperseding, MessageInFlightError } from '@/lib/email/supersede';
import { templateFor } from '@/lib/email/template-row';

/**
 * *Invite players* (spec/v3.md §25.2, §23.2): the optional `PLAYER_INVITE`
 * email, carrying each player's own prefilled link `/f/{slug}?k={token}`.
 *
 * Optional because the form's one public link, with its picker, already works
 * for everyone; the invite is the shortcut that names the player for them.
 * Queued rather than drafted — the command's preview is the review, as for a
 * verification reminder — and addressed to the player, never to a party.
 *
 * **Idempotent per form.** A player already sent (or about to be sent) this
 * form's link is skipped unless the admin asks to send again; a re-run does
 * only who is left.
 */

const filter = z
  .object({
    /** Every active player of the concert — the one filter this command needs. */
    active: z.literal(true).default(true),
  })
  .strict();

const params = z
  .object({
    formId: idSchema,
    again: z.boolean().default(false),
  })
  .strict();

type FormFacts = {
  slug: string;
  status: string;
  kind: string;
  segment_id: string;
  segment_name: string;
  show_name: string;
  concert_name: string;
  stored_template: string | null;
};

async function formFacts(tx: Tx, concertId: number, formId: number): Promise<FormFacts | null> {
  const [row] = await tx.execute<FormFacts>(sql`
    select f.slug, f.status::text as status, f.kind::text as kind, f.segment_id,
           g.name as segment_name, s.name as show_name, c.name as concert_name,
           d.template_key as stored_template
      from registration_forms f
      join show_segments g on g.id = f.segment_id
      join shows s on s.id = g.show_id
      join concerts c on c.id = s.concert_id
      left join segment_message_defaults d on d.segment_id = f.segment_id and d.purpose = 'PLAYER_INVITE'
     where f.id = ${formId} and s.concert_id = ${concertId} and f.deleted_at is null
  `);
  return row ?? null;
}

export function inviteUrl(slug: string, token: string): string {
  return `${process.env.APP_URL ?? ''}/f/${slug}?k=${encodeURIComponent(token)}`;
}

const invitePlayers = defineCommand({
  name: 'intake.invite_players',
  entityType: 'player',
  verb: 'Invite',
  noun: { one: 'player', many: 'players' },
  irreversible: false,
  filter,
  params,
  async match(tx, ctx) {
    const rows = await tx.execute<{ id: string }>(sql`
      select id from players
       where concert_id = ${ctx.concertId} and is_active and deleted_at is null
       order by full_name, id
    `);
    return rows.map((row) => Number(row.id));
  },
  async describe(tx, ctx, ids, { lock }) {
    if (ids.length === 0) return [];
    const form = await formFacts(tx, ctx.concertId, ctx.params.formId);
    const list = sql`${`{${ids.join(',')}}`}::bigint[]`;
    const rows = await tx.execute<{
      id: string;
      full_name: string;
      email: string | null;
      is_active: boolean;
      invited: boolean;
      sending: boolean;
    }>(sql`
      select p.id, p.full_name, p.email::text as email, p.is_active,
             exists (select 1 from email_outbox o
                      where o.player_id = p.id and o.purpose = 'PLAYER_INVITE'
                        and o.status in ('DRAFT', 'QUEUED', 'SENDING', 'SENT')
                        and o.deleted_at is null
                        and o.context ->> 'invite_url' = ${form ? inviteUrl(form.slug, '') : ''} || p.invite_token)
               as invited,
             exists (select 1 from email_outbox o
                      where o.player_id = p.id and o.purpose = 'PLAYER_INVITE' and o.status = 'SENDING')
               as sending
        from players p
       where p.id = any(${list}) and p.concert_id = ${ctx.concertId} and p.deleted_at is null
       order by p.full_name, p.id
       ${lock ? sql`for update of p` : sql``}
    `);
    const formSkip = !form
      ? 'That form is not in this concert.'
      : form.kind !== 'PLAYER'
        ? 'That is not a player form.'
        : form.status !== 'OPEN'
          ? 'That form is not open yet. Invite once it is, so the link works when it arrives.'
          : null;
    return rows.map((row) => ({
      id: Number(row.id),
      label: row.full_name,
      skip:
        formSkip ??
        (!row.is_active
          ? 'Not active.'
          : !row.email
            ? 'No email address.'
            : row.sending
              ? 'An invite is being sent right now.'
              : row.invited && !ctx.params.again
                ? 'Already invited to this form.'
                : null),
      detail: row.email,
    }));
  },
  async blastRadius(tx, ctx, ids) {
    const form = await formFacts(tx, ctx.concertId, ctx.params.formId);
    return form
      ? [
          {
            count: ids.length,
            text: `players are emailed their own link to ${form.segment_name} (${form.show_name}), queued to send at once.`,
            tone: 'neutral' as const,
          },
        ]
      : [];
  },
  async apply(tx, ctx, row) {
    const form = await formFacts(tx, ctx.concertId, ctx.params.formId);
    if (!form) throw new SkipItem('That form is not in this concert.');
    const [player] = await tx.execute<{ full_name: string; email: string; invite_token: string }>(sql`
      select full_name, email::text as email, invite_token from players where id = ${row.id}
    `);
    const templateKey = defaultTemplateFor('PLAYER_INVITE', 'PLAYER_INVITED', form.stored_template);
    const template = templateKey ? await templateFor(tx, templateKey) : null;
    if (!templateKey || !template) throw new SkipItem('There is no player invite template.');

    const context = escapeMergeValues({
      'player.name': player.full_name,
      'concert.name': form.concert_name,
      'show.name': form.show_name,
      'segment.name': form.segment_name,
      invite_url: inviteUrl(form.slug, player.invite_token),
    });
    try {
      const { id } = await draftSuperseding(
        tx,
        {
          addressee: { playerId: row.id },
          purpose: 'PLAYER_INVITE',
          templateKey,
          toEmail: player.email,
          toName: player.full_name,
          subject: renderTemplate(template.subject, context).text,
          bodyMd: renderTemplate(template.body_md, context).text,
          context,
          status: 'QUEUED',
        },
        ctx.audit,
      );
      await ctx.audit({
        action: 'player.invited',
        entityType: 'player',
        entityId: row.id,
        after: { formId: ctx.params.formId, messageId: id },
      });
      return { label: row.label, messageId: id };
    } catch (error) {
      if (error instanceof MessageInFlightError) throw new SkipItem(error.message);
      throw error;
    }
  },
});

export const INTAKE_INVITE_COMMANDS: AnyCommand[] = [invitePlayers];
