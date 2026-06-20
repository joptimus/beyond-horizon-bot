# Design: "Your Idea Shipped" Announcements

**Date:** 2026-06-20
**Status:** Validated, ready for implementation

## Goal

When a GitHub issue that originated from a Discord submission (idea / bug /
feature / feedback) is closed as completed, automatically notify the original
submitter — both publicly in a channel and privately via DM — that their
contribution has been fixed and will ship in an upcoming release. Closes the
feedback loop on the existing Discord → AI → GitHub pipeline.

## Why this is small

The bot already stores everything we need inside GitHub itself:

- **Submitter identity** is embedded in every issue body as
  `(Discord ID: <userId>)` (see `ai.ts:266`). We parse it back out — no local
  map needed.
- **"Already announced" state** is tracked with an `announced` GitHub label, not
  a local datastore. This survives the bot's frequent restarts.

Result: **no new database and no web server.**

## Decisions (from brainstorming)

| Decision | Choice |
|----------|--------|
| Detection mechanism | **Polling** (~5 min). No webhook / HTTP server. |
| Trigger | Issue **closed as completed** (`state_reason === 'completed'`). |
| Delivery | **Channel post (@mention) + DM** to submitter. |
| Dedup / state | `announced` label on the issue. |
| Backfill | **Silent seed on first run** — label all currently-closed issues without announcing. |

## Flow

```
setInterval (~5 min)
    ↓
listRecentlyCompletedIssues()  [github.ts]
    - state=closed, labels in {idea,bug,feature,feedback}
    - keep state_reason === 'completed'
    - skip issues with `announced` label
    ↓
for each candidate:
    - parse `Discord ID: (\d+)` from body  → skip if none (manual issue)
    - post themed embed to ANNOUNCE_CHANNEL_ID, mentioning <@submitterId>
    - DM submitter (try/catch; DM-disabled is non-fatal, like join flow)
    - on success: add `announced` label to the issue
```

## First-run seed (anti-spam)

Use **label existence as the first-run signal**:

- On startup, check whether the `announced` label exists in the repo.
  - **Not present:** create it, then add it to every currently closed+completed
    bot-originated issue *without announcing*. Then start polling.
  - **Present:** skip seed, just start polling.

This guarantees the backlog of already-shipped ideas never spam-pings old
submitters, and is idempotent across restarts.

## New / changed code

- **`github.ts`**
  - `listRecentlyCompletedIssues()` — query + filter described above.
  - `markIssueAnnounced(issueNumber)` — add `announced` label (create label if
    missing).
  - `ensureAnnouncedLabelSeeded()` — first-run silent seed.
- **`bot.ts`**
  - Polling loop (started after `ready`), calling the above and posting the
    channel embed + DM. Reuse the Voran embed style / color (`0x00e5cc`) and the
    DM try/catch pattern from the member-join flow.
  - Helper to extract the Discord ID from an issue body.
- **Env**
  - `ANNOUNCE_CHANNEL_ID` — channel for public "shipped" posts.
  - (optional) `SHIPPED_POLL_MINUTES` — override default 5 min.

## Edge cases / notes

- Only issues whose body contains a Discord ID are announced (filters out
  manually-created issues with no submitter).
- "Closed as not planned" is ignored by the `state_reason` filter.
- GitHub REST list calls are paginated; cap to recent/open-enough pages since
  seeded issues are already labeled and skipped.
- Reopened-then-reclosed: once `announced` is set we never re-announce. Acceptable.

## Out of scope (YAGNI)

- Release/milestone batching (chose "closed as completed" instead).
- Persistent leaderboards / trivia (separate future work).
- Webhook real-time delivery.
