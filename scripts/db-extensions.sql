-- Extensions the schema depends on (spec/platform.md §16.4).
-- Used by both scripts/local-db.sh and the CI workflow so the two cannot drift.
--
--   citext   — case-insensitive emails on players, registrations, attendees
--   pg_trgm  — trigram similarity for NAME_FUZZY player matching on import (§9.3)
--   pgcrypto — CSPRNG bytes for qr_token and ticket_code (§10.1)
create extension if not exists citext;
create extension if not exists pg_trgm;
create extension if not exists pgcrypto;
