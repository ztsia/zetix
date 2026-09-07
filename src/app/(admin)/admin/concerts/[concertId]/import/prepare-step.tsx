'use client';

import { ArrowRight, Download, Info } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  TEMPLATE_EXAMPLE_ROWS,
  TEMPLATE_HEADERS,
  TEMPLATE_WIDE_EXAMPLE,
} from '@/lib/import/template';

/**
 * Step 1 — Prepare your sheet (spec/import.md §9.6).
 *
 * **This step is the price of decision 33.** The wide-to-long reshaping moved
 * out of the importer and onto the admin, and a step the system depends on but
 * never explains is a step that gets done wrong — silently, because a
 * mis-grouped party looks like a successful import until four separate emails
 * land in one person's inbox.
 *
 * So it teaches three ways, in descending order of how much it can be ignored:
 * a worked before-and-after, a template that maps itself once filled in, and one
 * standing warning about the thing a careful admin would otherwise tidy away.
 */
export function PrepareStep({ concertId }: { concertId: number }) {
  const headers = Object.values(TEMPLATE_HEADERS);

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h2 className="text-lg font-semibold">Prepare your sheet</h2>
        <p className="text-muted-foreground max-w-2xl text-sm">
          The importer reads <strong>one row per attendee</strong>. A Google Form that asked for
          several guest names puts them all on one wide row, so reshape it in your spreadsheet
          first — a formula does it in a minute, and you can see the result before uploading.
        </p>
      </div>

      {/*
        The one thing that is not obvious and cannot be recovered from after
        commit: the contact columns repeat on every row of a party, because that
        repetition is what tells the importer which rows belong together (§9.2).
      */}
      <Alert>
        <Info />
        <AlertTitle>Repeat the contact columns on every row of a party</AlertTitle>
        <AlertDescription>
          Rows are grouped into one registration — one email, one PDF per seat — when they share
          the same <strong>Contact Email</strong> and the same <strong>Timestamp</strong>. Do not
          fill those in on only the first row of each party: each row would become its own
          registration, and a family of four would get four separate emails.
        </AlertDescription>
      </Alert>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="space-y-2">
          <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            Before — what the form exports
          </h3>
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  {TEMPLATE_WIDE_EXAMPLE.headers.map((h) => (
                    <TableHead key={h} className="text-xs whitespace-nowrap">
                      {h}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {TEMPLATE_WIDE_EXAMPLE.rows.map((row, i) => (
                  <TableRow key={i}>
                    {row.map((cell, j) => (
                      <TableCell key={j} className="text-xs whitespace-nowrap">
                        {cell || <span className="text-muted-foreground">—</span>}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <p className="text-muted-foreground text-xs">
            Two registrations, four seats, spread across columns.
          </p>
        </section>

        <section className="space-y-2">
          <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            After — what to upload
          </h3>
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  {headers.map((h) => (
                    <TableHead key={h} className="text-xs whitespace-nowrap">
                      {h}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {TEMPLATE_EXAMPLE_ROWS.map((row, i) => (
                  <TableRow key={i}>
                    {headers.map((h) => (
                      <TableCell key={h} className="text-xs whitespace-nowrap">
                        {row[h] || <span className="text-muted-foreground">—</span>}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <p className="text-muted-foreground text-xs">
            The same two registrations, one row per seat. Alice&rsquo;s three rows repeat her
            contact details and timestamp; the third has no name and will ticket as &ldquo;Guest of
            Alice Tan&rdquo;.
          </p>
        </section>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <ButtonGroup>
          {/* Base UI takes `render`, not Radix's `asChild` (spec/platform.md §16). */}
          <Button
            variant="outline"
            render={<a href={`/api/import/template?format=xlsx&concertId=${concertId}`} />}
          >
            <Download />
            Download template (.xlsx)
          </Button>
          <Button
            variant="outline"
            render={<a href={`/api/import/template?format=csv&concertId=${concertId}`} />}
          >
            .csv
          </Button>
        </ButtonGroup>
        <p className="text-muted-foreground text-xs">
          Fill this in and the columns map themselves on the next step.
        </p>
      </div>

      {/*
        Progressive disclosure: the common path above stays short, and the cases
        that are not it are one click away rather than in the way.
      */}
      <Accordion className="max-w-3xl">
        <AccordionItem value="counts">
          <AccordionTrigger>My form asked how many tickets, not for names</AccordionTrigger>
          <AccordionContent className="text-muted-foreground space-y-2 text-sm">
            <p>
              Repeat the row that many times and leave <strong>Attendee Name</strong> blank. Each
              blank name becomes a seat ticketed as &ldquo;Guest of {'{'}contact name{'}'}&rdquo;,
              which is not an error — the door searches on that string, and a party that registered
              together arrives together.
            </p>
            <p>You can fill the real names in later; before the blast, nothing else changes.</p>
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="no-email">
          <AccordionTrigger>Someone in my sheet has no email address</AccordionTrigger>
          <AccordionContent className="text-muted-foreground space-y-2 text-sm">
            <p>
              That row cannot be grouped by the rule above, so it becomes a registration of its own
              and the dry run counts it separately. If it genuinely belongs to a party, add a{' '}
              <strong>Group</strong> column and put the same value on every row of that party — a
              mapped group column overrides the email-and-timestamp rule entirely.
            </p>
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="round-two">
          <AccordionTrigger>This is a second round, and some people registered twice</AccordionTrigger>
          <AccordionContent className="text-muted-foreground space-y-2 text-sm">
            <p>
              That is handled: the grouping key includes the timestamp, so the same person&rsquo;s
              two submissions stay two registrations rather than merging into one oversized party.
            </p>
            <p>
              Import only the new responses. A player who already has a registration for this show
              is reported as blocking and skipped, so a re-import of the whole sheet will not
              duplicate them — but it will not update them either.
            </p>
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="hybrid">
          <AccordionTrigger>My show has both a public and a player-invited audience</AccordionTrigger>
          <AccordionContent className="text-muted-foreground space-y-2 text-sm">
            <p>
              Run the import twice, once per segment, with one file each. A single file cannot be
              split: nothing in a spreadsheet row reliably says which audience it belongs to, and
              guessing would put someone in the wrong block.
            </p>
          </AccordionContent>
        </AccordionItem>
      </Accordion>

      <p className="text-muted-foreground flex items-center gap-2 text-sm">
        <ArrowRight className="size-4" />
        When your sheet looks like the one on the right, continue.
      </p>
    </div>
  );
}
