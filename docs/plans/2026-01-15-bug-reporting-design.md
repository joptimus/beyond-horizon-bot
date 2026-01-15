# Bug Reporting Feature Design

## Overview

Add a bug reporting feature where users can use `/bug` or `!bug` to report bugs. The bot gathers reproduction details through AI-driven conversation, then creates a GitHub issue with the "bug" label upon approval.

## Design Decisions

- **Input style:** Minimal - user provides description, AI identifies gaps and asks follow-ups
- **AI focus:** Reproduction details (steps, expected vs actual, frequency)
- **Severity labels:** None - maintainers triage priority later
- **Vote message:** None - bugs don't need community voting
- **Follow-up questions:** Up to 3, same as ideas

## Flow

1. User submits `/bug <description>` or `!bug <description>`
2. Bot creates thread titled "Bug: [short summary]"
3. AI enriches description, extracts what it can, identifies gaps
4. Bot asks up to 3 follow-up questions (reproduction-focused)
5. User answers via modal or skips
6. Bot presents final summary with Approve/Cancel buttons
7. On approval: GitHub issue created with "bug" label, confirmation posted in thread

## Data Structures

### EnrichedBug Schema

```typescript
interface EnrichedBug {
  title: string;              // Short, clear bug title
  summary: string;            // 1-2 sentence description
  stepsToReproduce: string[]; // Numbered steps (may be empty if unknown)
  expectedBehavior: string;   // What should happen
  actualBehavior: string;     // What actually happens
  frequency: string | null;   // "always", "sometimes", "once"
  openQuestions: string[];    // Up to 3 questions to fill gaps
}
```

### Pending Store Update

Add `type` field to existing `PendingIdea` interface:

```typescript
interface PendingIdea {
  type: 'idea' | 'bug';  // NEW
  authorId: string;
  rawText: string;
  title: string;
  body: string;
  phase: 'awaiting_answers' | 'awaiting_approval';
  openQuestions: string[];
}
```

## Files to Create

### `src/commands/bug.ts`
Slash command handler for `/bug`. Calls `enrichBug()`, creates thread, stores in pending, shows appropriate buttons.

### `src/aiBug.ts`
Bug-specific AI module with:
- `enrichBug(description, answers?)` - Returns structured EnrichedBug JSON
- `toBugIssueBody(bug, username)` - Formats bug as GitHub issue markdown

## Files to Modify

### `src/bot.ts`
- Add `!bug` prefix command handler in `messageCreate` event
- Add button handlers: `bug_answer_{id}`, `bug_skip_{id}`, `bug_approve_{id}`, `bug_cancel_{id}`
- Add modal handler: `bug_answers_{id}`

### `src/pending.ts`
- Add `type: 'idea' | 'bug'` field to interface

### `src/github.ts`
- Add `createBugIssue(title, body)` function that creates issue with "bug" label

### `src/register.ts`
- Add `/bug` command registration

## GitHub Issue Format

```markdown
## Summary
{summary}

## Steps to Reproduce
1. {step1}
2. {step2}
...

## Expected Behavior
{expectedBehavior}

## Actual Behavior
{actualBehavior}

## Frequency
{frequency or "Not specified"}

---
*Reported via Discord by @{username}*
```

## Thread Confirmation

After approval:
```
✓ Bug report posted to GitHub as issue #{number}
```

No vote embed, no GitHub link (consistent with idea flow).
