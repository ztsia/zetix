\set ON_ERROR_STOP on
insert into concerts (id, name, slug, status, timezone) overriding system value values (1,'C','c','ACTIVE','Asia/Singapore');
insert into shows (id, concert_id, name, status, capacity) overriding system value values (1,1,'S','OPEN',100);
insert into show_segments (id, show_id, name, audience_mode, capacity, extras_policy) overriding system value values (1,1,'Public','PUBLIC',50,'AUTO_FCFS');
insert into players (id, concert_id, full_name, email, invite_token) overriding system value values (1,1,'P','p@example.test','tok-p');
insert into registrations (id, show_id, segment_id, source, contact_name, contact_email, status, requested_at, created_at) overriding system value values
 (1,1,1,'IMPORT','A','a@example.test','CONFIRMED','2026-09-01T10:00Z','2026-09-02T08:00Z'),
 (2,1,1,'IMPORT','B','b@example.test','CONFIRMED','2026-09-01T11:00Z','2026-09-02T09:00Z'),
 (3,1,1,'IMPORT','C','c@example.test','CONFIRMED','2026-09-01T12:00Z','2026-09-02T10:00Z'),
 (4,1,1,'IMPORT','D','d@example.test','CANCELLED','2026-09-01T13:00Z','2026-09-02T11:00Z');
begin;
select set_config('zetix.granting','on',true);
insert into attendees (registration_id, show_id, segment_id, full_name, name_source, allocation_type, status) values
 (1,1,1,'a1','PROVIDED','EXTRA','CONFIRMED'),(1,1,1,'a2','PROVIDED','EXTRA','CONFIRMED'),
 (2,1,1,'b1','PROVIDED','EXTRA','CONFIRMED'),(3,1,1,'c1','PROVIDED','EXTRA','WAITLIST'),
 (4,1,1,'d1','PROVIDED','EXTRA','CANCELLED');
commit;
-- outbox: every template, plus the edge cases
insert into email_outbox (registration_id, player_id, template_key, to_email, subject, body_md, status, created_at, updated_at) values
 -- reg 1: two SENDING rows of the same purpose (both in the dispatcher's hands)
 (1,null,'public_ticket','a@example.test','s','b','SENDING','2026-09-05T00:00Z','2026-09-05T00:00Z'),
 (1,null,'player_confirmation','a@example.test','s','b','SENDING','2026-09-06T00:00Z','2026-09-06T00:00Z'),
 -- reg 2: an older QUEUED (admin confirmed) and a newer DRAFT (nobody confirmed) of the same purpose
 (2,null,'public_ticket','b@example.test','s','b','QUEUED','2026-09-05T00:00Z','2026-09-05T00:00Z'),
 (2,null,'player_confirmation','b@example.test','s','b','DRAFT','2026-09-06T00:00Z','2026-09-06T00:00Z'),
 -- reg 3: extras granted + declined both pending
 (3,null,'extras_granted','c@example.test','s','b','DRAFT','2026-09-05T00:00Z','2026-09-05T00:00Z'),
 (3,null,'extras_declined','c@example.test','s','b','DRAFT','2026-09-05T00:00Z','2026-09-05T00:00Z'),
 -- player: two pending digests are impossible under the V2 index (same template), so one
 (null,1,'player_notes_digest','p@example.test','s','b','DRAFT','2026-09-05T00:00Z','2026-09-05T00:00Z'),
 -- sent history of every key
 (1,null,'public_verify','a@example.test','s','b','SENT','2026-09-01T00:00Z','2026-09-01T00:00Z'),
 (1,null,'registration_cancelled','a@example.test','s','b','SENT','2026-09-01T00:00Z','2026-09-01T00:00Z'),
 (1,null,'reminder','a@example.test','s','b','FAILED','2026-09-01T00:00Z','2026-09-01T00:00Z'),
 (1,null,'feedback_request','a@example.test','s','b','SENT','2026-09-01T00:00Z','2026-09-01T00:00Z'),
 (2,null,'feedback_form_link','b@example.test','s','b','SENT','2026-09-01T00:00Z','2026-09-01T00:00Z');
select count(*) as outbox_rows from email_outbox;
