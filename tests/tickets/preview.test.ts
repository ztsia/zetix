import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb } from '../helpers/db';
import {
  createConcert,
  createRegistration,
  createSegment,
  createShow,
  withDirectAttendeeWrites,
} from '../helpers/fixtures';
import { previewOptions, previewTicketData } from '@/lib/tickets/preview';

/**
 * The two previews §10.3 asks for, and why the second one matters.
 *
 * "A **longest name in this show** preview so overflow is caught before a whole
 * show's tickets go out." The failure it prevents is discovering at four hundred
 * tickets that one name runs over the QR — by which point they are in four
 * hundred inboxes and the only fix is a reissue.
 */

let concertId: number;
let showId: number;
let segmentId: number;

beforeEach(async () => {
  await resetDb();
  concertId = await createConcert('Previews');
  showId = await createShow(concertId, 100);
  segmentId = await createSegment(showId, { capacity: 50, audienceMode: 'PUBLIC' });
});

/** Attendees with names of our choosing, which `seedAttendees` does not offer. */
async function named(...names: string[]): Promise<void> {
  const registrationId = await createRegistration({ showId, segmentId });
  await withDirectAttendeeWrites(async (tx) => {
    for (const name of names) {
      await tx`
        insert into attendees (
          registration_id, show_id, segment_id, full_name, name_source,
          allocation_type, status
        ) values (
          ${registrationId}, ${showId}, ${segmentId}, ${name}, 'PROVIDED',
          'BASE', 'CONFIRMED'
        )
      `;
    }
  });
}

describe('previewOptions', () => {
  it('offers the longest name as well as a real attendee', async () => {
    await named('Jo Ng', 'Wellington Mainwaring-Fitzgerald', 'Ali bin Hassan');

    const options = await previewOptions(concertId, showId);
    const longest = options.find((option) => option.subject === 'LONGEST_NAME');
    expect(longest?.fullName).toBe('Wellington Mainwaring-Fitzgerald');
    expect(options.find((option) => option.subject === 'FIRST')?.fullName).toBe('Jo Ng');
  });

  it('always offers sample data, so a concert before its first import is editable', async () => {
    const options = await previewOptions(concertId, showId);
    expect(options.map((option) => option.subject)).toEqual(['SAMPLE']);
    expect(options[0].attendeeId).toBeNull();
  });

  it('does not offer the same person twice under two names', async () => {
    await named('Only Attendee');
    const options = await previewOptions(concertId, showId);
    expect(options.filter((option) => option.attendeeId !== null)).toHaveLength(1);
    expect(options[0].label).toMatch(/only attendee in this show/i);
  });

  it('falls back to sample data for a show that is not this concert’s', async () => {
    const other = await createShow(await createConcert('Elsewhere'), 10);
    expect(await previewOptions(concertId, other)).toMatchObject([{ subject: 'SAMPLE' }]);
  });
});

describe('previewTicketData', () => {
  it('resolves the attendee the option names', async () => {
    await named('Jo Ng', 'Wellington Mainwaring-Fitzgerald');
    const options = await previewOptions(concertId, showId);
    const longest = options.find((option) => option.subject === 'LONGEST_NAME')!;

    const data = await previewTicketData({
      concertId,
      showId,
      subject: 'LONGEST_NAME',
      attendeeId: longest.attendeeId,
    });
    expect(data?.attendee.fullName).toBe('Wellington Mainwaring-Fitzgerald');
    expect(data?.concert.timezone).toBe('Asia/Singapore');
  });

  it('stands in for an empty show with a name long enough to be worth testing', async () => {
    const data = await previewTicketData({ concertId, showId, subject: 'SAMPLE' });
    // A short sample would let an admin lay out a template that only breaks at
    // import time, which is the failure the longest-name preview exists for.
    expect(data?.attendee.fullName.length).toBeGreaterThan(20);
    expect(data?.attendee.qrToken).toBeTruthy();
  });

  it('refuses a show belonging to another concert', async () => {
    const other = await createShow(await createConcert('Not ours'), 10);
    expect(await previewTicketData({ concertId, showId: other, subject: 'FIRST' })).toBeNull();
  });

  it('renders an unissued attendee rather than refusing', async () => {
    // The rows an admin most wants to preview have no ticket_code and no
    // qr_token yet — they are exactly who the template is being laid out for.
    await named('Not Yet Issued');
    const data = await previewTicketData({ concertId, showId, subject: 'FIRST' });
    expect(data?.attendee.fullName).toBe('Not Yet Issued');
    expect(data?.attendee.ticketCode).toBeNull();
  });
});
