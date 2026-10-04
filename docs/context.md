# Context — an example orchestra, an example concert

**This concert is fictional.** It is what the demo seed builds (`scripts/seed-demo.ts`), and it stands
where a real install keeps its own concert's facts. Every name, number and date below is invented.

**This file holds facts, not rules.** Everything here is data the system stores and an admin can change
through the UI. Nothing in this file may become a constant, a default, or a branch in application code.
`spec/` defines the system and must stay free of these numbers. If you find yourself wanting to write
`320`, `60` or a date into code, the value belongs in the database, seeded from this file.

Read order for a new session: `CLAUDE.md` → `spec/README.md` → this file → `ref.md` if needed.

---

## 1. The organisation

The **Lakeside Community Orchestra**: about sixty volunteer players. Concerts are free admission, with
no ticket revenue and unreserved seating. Registration used to run on a shared form and a spreadsheet;
this system replaces both, though one round of the spreadsheet is still imported (§3).

---

## 2. Concert: *Autumn Serenade*

Two shows in one concert, a month apart. Dates are relative to the day the seed runs, so the demo
always has one show behind it and one ahead.

| Show | When | Hall | Segments |
|---|---|---|---|
| **Open rehearsal** | 9 days before the seed, 15:00–16:45 | 200 | Public only |
| **Gala evening** | 21 days after the seed, 19:30–21:45, doors 18:45 | 320 | Public and player invited |

### 2.1 The open rehearsal — already happened

A public-only matinee, so the door, the scan log, walk-ins, the portal's post-show phase and feedback
all have something to show.

| Segment | Mode | Capacity |
|---|---|---|
| Public | `PUBLIC` | 200 |

About 150 seats ticketed in parties of one to four; most of them admitted across the doors window, the
rest no-shows. Walk-ins are on, and a handful came in. Feedback was requested and some came back.

### 2.2 The gala — still ahead

Total hall capacity 320, split into two segments (`spec/allocation.md` §7.1):

| Segment | Mode | Capacity | Base quota | Notes |
|---|---|---|---|---|
| Public | `PUBLIC` | 240 | — | Self-registration on the native form, first-come-first-served |
| Player invited | `PLAYER_INVITED` | 80 | **1** | 60 active players |

```
player segment:  60 players × 1 base = 60 entitled seats
                 80 capacity − 60 entitled = 20 in the extras pool from the start
public segment:  240 seats, all first-come-first-served
```

60 × 1 ≤ 80, so the base-entitlement check (`spec/allocation.md` §7.4) passes. 240 + 80 = 320, so no
seats are held.

---

## 3. Registration

- **The gala's public segment** runs on the native registration form, with a party cap of 4 and a
  receipt on submit. Most parties are ticketed; some still wait in *Needs review*, one or two are
  flagged as likely duplicates, and one address bounced.
- **The gala's player segment** runs on the player form: each player claims their base seat and may
  ask for extras, which an admin reviews.
- **The open rehearsal** was registered on a spreadsheet and imported (`spec/import.md` §9), so the
  import history has a real batch in it.

---

## 4. Operations

| | |
|---|---|
| Email | **None leaves the demo.** It has no SMTP account, and every send path fails closed without one (`spec/v3.md` §31) |
| Timezone | Asia/Kuala_Lumpur (UTC+8) |
| Ushers | Three, each assigned to both shows |
| Ticket artwork | The seeded default designs |
| Booklet | A short programme, published for both shows |

---

## 5. Values to seed

**None of them belongs in code.** `scripts/seed-demo.ts` enters them as an admin would.

```
concert
  name                          Autumn Serenade
  timezone                      Asia/Kuala_Lumpur
  walk-ins                      on, at most 4 per entry

show "Open rehearsal"
  starts_at / ends_at           seed day − 9, 15:00 → 16:45
  doors_open_at                 14:30
  venue                         Lakeside Arts Centre, Studio Hall
  capacity                      200
  segment "Public"              PUBLIC, capacity 200, AUTO_FCFS, max 4 per response

show "Gala evening"
  starts_at / ends_at           seed day + 21, 19:30 → 21:45
  doors_open_at                 18:45
  venue                         Lakeside Arts Centre, Main Hall
  capacity                      320
  segment "Public"              PUBLIC, capacity 240, AUTO_FCFS, max 4 per response
  segment "Player invited"      PLAYER_INVITED, capacity 80, base quota 1,
                                base claim deadline seed day + 7, extras REVIEW

players                         60, invented names, a mix of sections
operators                       3 ushers, each assigned to both shows
console                         an ADMIN for the person running the demo, and a VIEWER whose
                                password is published, for visitors (spec/v3.md §28)
```
