# Bug Reporting Feature Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `/bug` and `!bug` commands that let users report bugs through AI-assisted conversation, then post to GitHub with "bug" label.

**Architecture:** Parallel module approach - create `aiBug.ts` for bug-specific AI prompts and `commands/bug.ts` for the slash command. Modify `pending.ts` to add a `type` field, `github.ts` for `createBugIssue()`, and `bot.ts` for prefix command + button/modal handlers.

**Tech Stack:** TypeScript, discord.js v14, OpenAI API, Octokit

---

## Task 1: Add type field to pending store

**Files:**
- Modify: `src/pending.ts`

**Step 1: Add type field to PendingIdea interface**

In `src/pending.ts`, update the type definition:

```typescript
export type PendingIdea = {
  type: 'idea' | 'bug';  // ADD THIS LINE
  id: string;
  authorId: string;
  rawText: string;
  title: string;
  body: string;
  createdAt: number;
  openQuestions?: string[];
  answersText?: string;
  phase?: "awaiting_answers" | "awaiting_approval";
};
```

**Step 2: Verify no type errors**

Run: `npx tsc --noEmit`
Expected: Type errors in files that create PendingIdea without `type` field

**Step 3: Commit**

```bash
git add src/pending.ts
git commit -m "feat(pending): add type field to distinguish ideas from bugs"
```

---

## Task 2: Update existing idea code to include type field

**Files:**
- Modify: `src/bot.ts` (lines 152, 171)
- Modify: `src/commands/idea.ts` (lines 100, 122)

**Step 1: Update bot.ts prefix command pending calls**

In `src/bot.ts`, find the two `putPending` calls in the `!idea` handler and add `type: 'idea'`:

First call (~line 152):
```typescript
putPending({
  type: 'idea',  // ADD THIS
  id,
  authorId: message.author.id,
  // ... rest unchanged
});
```

Second call (~line 171):
```typescript
putPending({
  type: 'idea',  // ADD THIS
  id,
  authorId: message.author.id,
  // ... rest unchanged
});
```

**Step 2: Update commands/idea.ts pending calls**

In `src/commands/idea.ts`, find the two `putPending` calls and add `type: 'idea'`:

First call (~line 100):
```typescript
putPending({
  type: 'idea',  // ADD THIS
  id,
  authorId: interaction.user.id,
  // ... rest unchanged
});
```

Second call (~line 122):
```typescript
putPending({
  type: 'idea',  // ADD THIS
  id,
  authorId: interaction.user.id,
  // ... rest unchanged
});
```

**Step 3: Verify no type errors**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 4: Commit**

```bash
git add src/bot.ts src/commands/idea.ts
git commit -m "feat(idea): add type field to all putPending calls"
```

---

## Task 3: Create aiBug.ts module

**Files:**
- Create: `src/aiBug.ts`

**Step 1: Create the file with full implementation**

Create `src/aiBug.ts`:

```typescript
// src/aiBug.ts
import OpenAI from "openai";

const API_KEY = process.env.OPENAI_API_KEY;
if (!API_KEY) throw new Error("Missing OPENAI_API_KEY in .env");

const client = new OpenAI({ apiKey: API_KEY });
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionCreateParams["messages"][number];

const SYSTEM_PREFACE = `
You are assisting a small team building a persistent, space-based MMO/RTS in Unity with a Node.js backend.
Your task is to help structure bug reports from players into clear, actionable format for developers.
Focus on extracting reproduction steps, expected vs actual behavior, and frequency.
`;

const JSON_SHAPE = `
Return ONLY valid JSON with this exact shape:
{
  "title": "Short, clear bug title (<= 80 chars)",
  "summary": "1-2 sentence description of the bug",
  "stepsToReproduce": ["Step 1", "Step 2", "..."] or [] if unknown,
  "expectedBehavior": "What should happen",
  "actualBehavior": "What actually happens",
  "frequency": "always" | "sometimes" | "once" | null,
  "openQuestions": ["Up to 3 clarifying questions about reproduction"]
}
Rules:
- Focus questions on reproduction: steps, frequency, conditions
- If reproduction steps are unclear, ask about them
- Keep openQuestions to at most 3
- Output only JSON
`;

function firstPassPrompt(raw: string, author: string) {
  return `
Given the bug report below, produce a structured bug report as JSON.
- Extract any reproduction steps mentioned
- Identify expected vs actual behavior (may be implicit)
- Note frequency if mentioned
- Ask up to 3 questions to clarify reproduction details

<author>${author}</author>

${JSON_SHAPE}

Bug report:
"""${raw}"""
`;
}

function secondPassPrompt(raw: string, answers: string, author: string, previousJSON: string) {
  return `
Refine the bug report based on player clarifications.
Remove any openQuestions that are now answered.

Existing bug report JSON:
\`\`\`json
${previousJSON}
\`\`\`

Player clarifications:
\`\`\`
${answers}
\`\`\`

Update the bug report to reflect the clarifications.
Return JSON in this shape:

${JSON_SHAPE}

Original bug report:
"""${raw}"""
Submitted by: ${author}
`;
}

export type EnrichedBug = {
  title: string;
  summary: string;
  stepsToReproduce: string[];
  expectedBehavior: string;
  actualBehavior: string;
  frequency: string | null;
  openQuestions: string[];
};

function stripFences(s: string) {
  return s.replace(/```(?:json)?\s*|```/gi, "").trim();
}

function toArray(x: unknown): string[] {
  return Array.isArray(x) ? x.filter(Boolean).map(String) : [];
}

function sanitize(e: Partial<EnrichedBug>, raw: string): EnrichedBug {
  return {
    title: (e.title && String(e.title).trim()) || raw.slice(0, 80),
    summary: (e.summary && String(e.summary).trim()) || raw,
    stepsToReproduce: toArray(e.stepsToReproduce),
    expectedBehavior: (e.expectedBehavior && String(e.expectedBehavior).trim()) || "Not specified",
    actualBehavior: (e.actualBehavior && String(e.actualBehavior).trim()) || "Not specified",
    frequency: e.frequency ? String(e.frequency).trim() : null,
    openQuestions: toArray(e.openQuestions).slice(0, 3),
  };
}

async function callOnce(messages: ChatMessage[]) {
  const res = await client.chat.completions.create({
    model: MODEL,
    temperature: 0.2,
    response_format: { type: "json_object" } as any,
    messages,
  });
  return res.choices[0]?.message?.content || "{}";
}

export async function enrichBug(
  rawText: string,
  author: string,
  answersText?: string,
  previous?: EnrichedBug
): Promise<EnrichedBug> {
  const previousJSON = previous ? JSON.stringify(previous, null, 2) : "{}";
  const userPrompt = answersText
    ? secondPassPrompt(rawText, answersText, author, previousJSON)
    : firstPassPrompt(rawText, author);

  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PREFACE },
    { role: "user", content: userPrompt },
  ];

  // Try 1
  let content = await callOnce(messages);
  try {
    return sanitize(JSON.parse(stripFences(content)), rawText);
  } catch (err1) {
    console.error("[AI Bug] JSON parse failed (try 1). Raw content:", content);
  }

  // Try 2
  content = await callOnce(messages);
  try {
    return sanitize(JSON.parse(stripFences(content)), rawText);
  } catch (err2) {
    console.error("[AI Bug] JSON parse failed (try 2). Raw content:", content);
    return sanitize(previous ?? {}, rawText);
  }
}

export function toBugIssueBody(bug: EnrichedBug, userTag: string): string {
  const steps = bug.stepsToReproduce.length
    ? bug.stepsToReproduce.map((s, i) => `${i + 1}. ${s}`).join("\n")
    : "Not specified";

  return `## Summary
${bug.summary}

## Steps to Reproduce
${steps}

## Expected Behavior
${bug.expectedBehavior}

## Actual Behavior
${bug.actualBehavior}

## Frequency
${bug.frequency || "Not specified"}

---
*Reported via Discord by ${userTag}*
`;
}
```

**Step 2: Verify no type errors**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/aiBug.ts
git commit -m "feat(ai): add aiBug.ts module for bug report enrichment"
```

---

## Task 4: Add createBugIssue to github.ts

**Files:**
- Modify: `src/github.ts`

**Step 1: Add createBugIssue function**

At the end of `src/github.ts` (before the closing), add:

```typescript
export async function createBugIssue({ title, body }: { title: string; body: string }) {
  const res = await octokit.request("POST /repos/{owner}/{repo}/issues", {
    owner,
    repo,
    title,
    body,
    labels: ["bug"]
  });
  return res.data;
}
```

**Step 2: Verify no type errors**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/github.ts
git commit -m "feat(github): add createBugIssue function"
```

---

## Task 5: Create bug slash command

**Files:**
- Create: `src/commands/bug.ts`

**Step 1: Create the slash command file**

Create `src/commands/bug.ts`:

```typescript
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import { enrichBug, toBugIssueBody, EnrichedBug } from "../aiBug.js";
import { putPending } from "../pending.js";
import crypto from "node:crypto";

export const data = new SlashCommandBuilder()
  .setName("bug")
  .setDescription("Report a bug (AI will help clarify details before posting to GitHub)")
  .addStringOption((opt) =>
    opt.setName("description").setDescription("Describe the bug you encountered").setRequired(true)
  );

function bugPreviewEmbed(bug: EnrichedBug) {
  const steps = bug.stepsToReproduce.length
    ? bug.stepsToReproduce.map((s, i) => `${i + 1}. ${s}`).join("\n")
    : "_(not yet specified)_";

  return new EmbedBuilder()
    .setTitle(bug.title || "Bug Report")
    .setDescription(
      [
        `**Summary**\n${bug.summary || "(missing)"}`,
        `\n**Steps to Reproduce**\n${steps}`,
        `\n**Expected:** ${bug.expectedBehavior || "(not specified)"}`,
        `\n**Actual:** ${bug.actualBehavior || "(not specified)"}`,
        bug.frequency ? `\n**Frequency:** ${bug.frequency}` : "",
      ].join("\n")
    )
    .setColor(0xe11d48); // Red for bugs
}

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!interaction.inGuild()) {
    await interaction.reply({ content: "❌ Use this in a server channel.", ephemeral: true });
    return;
  }

  const rawText = interaction.options.getString("description", true).trim();
  const submitterTag = interaction.user.tag;

  await interaction.deferReply({ ephemeral: true });

  const enriched = await enrichBug(rawText, submitterTag);

  const ch = interaction.channel;
  if (!ch || !(ch as any).isTextBased?.()) {
    await interaction.editReply("❌ Cannot create a thread in this channel.");
    return;
  }

  const threadName = `[BUG] ${(enriched.title || rawText).slice(0, 80)}`.slice(0, 95);
  const thread = await (ch as any).threads.create({
    name: threadName,
    autoArchiveDuration: 1440,
  });

  const id = crypto.randomUUID();

  if (enriched.openQuestions && enriched.openQuestions.length > 0) {
    const questionsList = enriched.openQuestions
      .slice(0, 3)
      .map((q, i) => `**Q${i + 1}.** ${q}`)
      .join("\n");

    const embed = new EmbedBuilder()
      .setTitle(enriched.title || "Bug Report")
      .setDescription(`**Draft Summary**\n${enriched.summary}\n\n**Clarifying Questions**\n${questionsList}`)
      .setColor(0xe11d48);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`bug:answer:${id}`).setLabel("Answer questions").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`bug:skip:${id}`).setLabel("Skip to approval").setStyle(ButtonStyle.Secondary)
    );

    const promptMsg = await thread.send({
      content: `<@${interaction.user.id}> I have a few questions to help clarify the bug:`,
      embeds: [embed],
      components: [row],
    });

    putPending({
      type: 'bug',
      id,
      authorId: interaction.user.id,
      rawText,
      title: `[BUG] ${(enriched.title || rawText).slice(0, 80)}`,
      body: toBugIssueBody(enriched, submitterTag),
      createdAt: Date.now(),
      openQuestions: enriched.openQuestions.slice(0, 3),
      phase: "awaiting_answers",
      ...({ enriched } as any),
      ...({ sourceMessageId: promptMsg.id, sourceChannelId: thread.id, threadId: thread.id, parentChannelId: interaction.channelId } as any),
    });

    await interaction.editReply({ content: `🧵 Thread opened: <#${thread.id}>` });
    return;
  }

  // No questions - go straight to approval
  putPending({
    type: 'bug',
    id,
    authorId: interaction.user.id,
    rawText,
    title: `[BUG] ${(enriched.title || rawText).slice(0, 80)}`,
    body: toBugIssueBody(enriched, submitterTag),
    createdAt: Date.now(),
    phase: "awaiting_approval",
    ...({ enriched } as any),
    ...({ sourceChannelId: thread.id, threadId: thread.id, parentChannelId: interaction.channelId } as any),
  });

  const embed = bugPreviewEmbed(enriched);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`bug:approve:${id}`).setLabel("Approve & Post").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`bug:cancel:${id}`).setLabel("Cancel").setStyle(ButtonStyle.Secondary)
  );

  await thread.send({
    content: `<@${interaction.user.id}> Here's the bug report. Approve to post to GitHub.`,
    embeds: [embed],
    components: [row],
  });

  await interaction.editReply({ content: `🧵 Thread opened: <#${thread.id}>` });
}
```

**Step 2: Verify no type errors**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/commands/bug.ts
git commit -m "feat(commands): add /bug slash command"
```

---

## Task 6: Register bug slash command

**Files:**
- Modify: `src/register.ts`

**Step 1: Import and register bug command**

Update `src/register.ts`:

```typescript
import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import * as Idea from './commands/idea.js';
import * as IdeasTop from './commands/ideasTop.js';
import * as Priority from './commands/priority.js';
import * as Bug from './commands/bug.js';  // ADD THIS

async function main() {
  const token = process.env.DISCORD_TOKEN!;
  const appId = process.env.DISCORD_APP_ID!;
  const guildId = process.env.DISCORD_GUILD_ID!;

  const rest = new REST({ version: '10' }).setToken(token);

  const commands = [Idea.data, IdeasTop.data, Priority.data, Bug.data].map(c => c.toJSON());  // ADD Bug.data

  await rest.put(Routes.applicationGuildCommands(appId, guildId), { body: commands });
  console.log('✅ Slash commands registered');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

**Step 2: Verify no type errors**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/register.ts
git commit -m "feat(register): add bug command to slash command registration"
```

---

## Task 7: Add bug command routing to bot.ts

**Files:**
- Modify: `src/bot.ts`

**Step 1: Import bug command module**

At the top of `src/bot.ts`, after the other command imports (~line 28), add:

```typescript
import * as BugSlash from './commands/bug.js';
```

**Step 2: Add bug to CMDS map**

Update the CMDS object (~line 51):

```typescript
const CMDS: Record<string, any> = {
  [IdeaSlash.data.name]: IdeaSlash,
  [IdeasTop.data.name]: IdeasTop,
  [Priority.data.name]: Priority,
  [BugSlash.data.name]: BugSlash,  // ADD THIS
};
```

**Step 3: Verify no type errors**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 4: Commit**

```bash
git add src/bot.ts
git commit -m "feat(bot): add bug slash command routing"
```

---

## Task 8: Add !bug prefix command handler

**Files:**
- Modify: `src/bot.ts`

**Step 1: Import aiBug functions**

After the ai.js import (~line 31), add:

```typescript
import { enrichBug, toBugIssueBody } from './aiBug.js';
```

**Step 2: Add !bug handler in MessageCreate event**

In the `MessageCreate` event handler, after the `!explain` block (~line 254) and before the closing `catch`, add:

```typescript
    // -------- !bug (AI → openQuestions? modal : approval) --------
    if (command === 'bug') {
      if (!message.guild) return message.reply('❌ Use this in a server channel.');

      const rawText = args.join(' ').trim();
      if (!rawText) return message.reply('❗ Usage: `!bug <description>`');

      const submitterTag = message.author.tag;
      const enriched = await enrichBug(rawText, submitterTag);
      const id = crypto.randomUUID();

      // Create thread for bug report
      const threadName = `[BUG] ${(enriched.title || rawText).slice(0, 80)}`.slice(0, 95);
      let thread;
      if (message.channel.isThread()) {
        thread = message.channel;
      } else {
        thread = await message.startThread({
          name: threadName,
          autoArchiveDuration: 1440,
        });
      }

      if (enriched.openQuestions?.length) {
        const questionsList = enriched.openQuestions
          .slice(0, 3)
          .map((q, i) => `**Q${i + 1}.** ${q}`)
          .join('\n');

        const qEmbed = new EmbedBuilder()
          .setTitle(enriched.title || 'Bug Report')
          .setDescription(`**Draft Summary**\n${enriched.summary}\n\n**Clarifying Questions**\n${questionsList}`)
          .setColor(0xe11d48);

        const qRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`bug:answer:${id}`).setLabel('Answer questions').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`bug:skip:${id}`).setLabel('Skip to approval').setStyle(ButtonStyle.Secondary)
        );

        const promptMsg = await thread.send({
          content: `<@${message.author.id}> I have a few questions to help clarify the bug:`,
          embeds: [qEmbed],
          components: [qRow],
        });

        putPending({
          type: 'bug',
          id,
          authorId: message.author.id,
          rawText,
          title: `[BUG] ${(enriched.title || rawText).slice(0, 80)}`,
          body: toBugIssueBody(enriched, submitterTag),
          createdAt: Date.now(),
          openQuestions: enriched.openQuestions.slice(0, 3),
          phase: 'awaiting_answers',
          ...({ enriched } as any),
          ...({ sourceMessageId: promptMsg.id, sourceChannelId: thread.id, threadId: thread.id, parentChannelId: message.channelId } as any),
        });

        return;
      }

      // No questions - straight to approval
      putPending({
        type: 'bug',
        id,
        authorId: message.author.id,
        rawText,
        title: `[BUG] ${(enriched.title || rawText).slice(0, 80)}`,
        body: toBugIssueBody(enriched, submitterTag),
        createdAt: Date.now(),
        phase: 'awaiting_approval',
        ...({ enriched } as any),
        ...({ sourceChannelId: thread.id, threadId: thread.id, parentChannelId: message.channelId } as any),
      });

      const steps = enriched.stepsToReproduce.length
        ? enriched.stepsToReproduce.map((s, i) => `${i + 1}. ${s}`).join('\n')
        : '_(not yet specified)_';

      const previewEmbed = new EmbedBuilder()
        .setTitle(enriched.title || 'Bug Report')
        .setDescription(
          [
            `**Summary**\n${enriched.summary || '(missing)'}`,
            `\n**Steps to Reproduce**\n${steps}`,
            `\n**Expected:** ${enriched.expectedBehavior || '(not specified)'}`,
            `\n**Actual:** ${enriched.actualBehavior || '(not specified)'}`,
            enriched.frequency ? `\n**Frequency:** ${enriched.frequency}` : '',
          ].join('\n')
        )
        .setColor(0xe11d48);

      const previewRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`bug:approve:${id}`).setLabel('Approve & Post').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`bug:cancel:${id}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
      );

      await thread.send({
        content: 'Here's the bug report. Approve to post to GitHub.',
        embeds: [previewEmbed],
        components: [previewRow],
      });

      return;
    }
```

**Step 3: Verify no type errors**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 4: Commit**

```bash
git add src/bot.ts
git commit -m "feat(bot): add !bug prefix command handler"
```

---

## Task 9: Add bug button handlers

**Files:**
- Modify: `src/bot.ts`

**Step 1: Import createBugIssue**

Update the github.js import (~line 35) to include createBugIssue:

```typescript
import { createIdeaIssue, createBugIssue, upsertDiscordVoteComment, readDiscordVoteCount, listTopIdeas, extractSummaryFromIssueBody, fetchIssue } from './github.js';
```

**Step 2: Add bug button handler block**

In the button handler section (inside `if (i.isButton())`), after the idea button handling (~line 389, after the `if (action === 'cancel')` block for ideas), add:

```typescript
    // ----- BUG BUTTONS -----
    if (ns === 'bug') {
      const pending = getPending(id);
      if (!pending) return i.reply({ content: '❌ This draft expired. Please try again.', ephemeral: true });
      if (i.user.id !== pending.authorId) {
        return i.reply({ content: '⛔ Only the original submitter can continue this flow.', ephemeral: true });
      }

      // Show modal to answer questions
      if (action === 'answer') {
        const qs = (pending as any).openQuestions || [];
        if (!qs.length) return i.reply({ content: 'No questions to answer.', ephemeral: true });

        const modal = new ModalBuilder().setCustomId(`bug:answers:${id}`).setTitle('Answer questions');

        qs.slice(0, 3).forEach((q: string, idx: number) => {
          const input = new TextInputBuilder()
            .setCustomId(`q${idx + 1}`)
            .setLabel(`Q${idx + 1}`)
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(false)
            .setPlaceholder(q)
            .setMaxLength(1000);

          modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
        });

        return i.showModal(modal);
      }

      // Skip questions → go to approval
      if (action === 'skip') {
        (pending as any).phase = 'awaiting_approval';
        putPending(pending);

        const embed = new EmbedBuilder()
          .setTitle((pending as any).title.replace(/^\[BUG\]\s*/, ''))
          .setDescription('You chose to skip questions. Approve to post.')
          .setColor(0xe11d48);

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`bug:approve:${id}`).setLabel('Approve & Post').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`bug:cancel:${id}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
        );

        return i.update({ content: 'Review the bug report below.', embeds: [embed], components: [row] });
      }

      // Approve → Create GitHub issue with bug label
      if (action === 'approve') {
        await clearOldPromptComponents(pending);
        await i.update({ content: 'Posting your bug report…', components: [], embeds: [] });

        const issue = await createBugIssue({ title: (pending as any).title, body: (pending as any).body });

        // Post confirmation in thread
        const threadId = (pending as any).threadId || (pending as any).sourceChannelId;
        const thread = threadId ? await client.channels.fetch(threadId as string) : null;

        if (thread && (thread as any).isTextBased?.()) {
          await (thread as any).send(`✅ Bug report posted to GitHub as issue **#${issue.number}**`);
        }

        delPending(id);

        return i.followUp({ content: `Done. Bug #${issue.number} posted.`, ephemeral: true });
      }

      // Cancel
      if (action === 'cancel') {
        await clearOldPromptComponents(pending);
        delPending(id);
        return i.update({ content: 'Bug report **canceled**.', components: [], embeds: [] });
      }
    }
```

**Step 3: Verify no type errors**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 4: Commit**

```bash
git add src/bot.ts
git commit -m "feat(bot): add bug button handlers (answer, skip, approve, cancel)"
```

---

## Task 10: Add bug modal handler

**Files:**
- Modify: `src/bot.ts`

**Step 1: Add bug modal submit handler**

In the modal submit handler section (inside `if (i.isModalSubmit())`), after the idea modal handling (~line 474), add:

```typescript
    // ----- BUG MODAL SUBMIT -----
    if (ns === 'bug' && action === 'answers') {
      const pending = getPending(id);
      if (!pending) {
        if (!i.replied && !i.deferred) {
          return i.reply({ content: '❌ This draft expired.', ephemeral: true });
        }
        return i.followUp({ content: '❌ This draft expired.', ephemeral: true });
      }
      if (i.user.id !== pending.authorId) {
        if (!i.replied && !i.deferred) {
          return i.reply({ content: '⛔ Only the original submitter can continue this flow.', ephemeral: true });
        }
        return i.followUp({ content: '⛔ Only the original submitter can continue this flow.', ephemeral: true });
      }

      if (!i.replied && !i.deferred) {
        await i.deferReply({ ephemeral: false });
      }

      // Gather Q/A
      const qs = (pending as any).openQuestions || [];
      const qaLines: string[] = [];
      qs.slice(0, 3).forEach((q: string, idx: number) => {
        const ans = i.fields.getTextInputValue(`q${idx + 1}`) || '';
        if (q || ans) {
          qaLines.push(`Q${idx + 1}: ${q}`);
          if (ans.trim()) qaLines.push(`A${idx + 1}: ${ans.trim()}`);
        }
      });
      const answersText = qaLines.join('\n');

      // Re-enrich with answers
      const submitterTag = i.user.tag;
      const previous = (pending as any).enriched || undefined;
      const enriched2 = await enrichBug((pending as any).rawText, submitterTag, answersText, previous);

      const finalTitle = `[BUG] ${(enriched2.title || (pending as any).rawText).slice(0, 80)}`;
      const finalBody = toBugIssueBody(enriched2, submitterTag);

      (pending as any).title = finalTitle;
      (pending as any).body = finalBody;
      (pending as any).phase = 'awaiting_approval';
      (pending as any).enriched = enriched2;
      putPending(pending);

      const steps = enriched2.stepsToReproduce.length
        ? enriched2.stepsToReproduce.map((s, i) => `${i + 1}. ${s}`).join('\n')
        : '_(not yet specified)_';

      const embed = new EmbedBuilder()
        .setTitle(enriched2.title || 'Bug Report')
        .setDescription(
          [
            `**Summary**\n${enriched2.summary || '(missing)'}`,
            `\n**Steps to Reproduce**\n${steps}`,
            `\n**Expected:** ${enriched2.expectedBehavior || '(not specified)'}`,
            `\n**Actual:** ${enriched2.actualBehavior || '(not specified)'}`,
            enriched2.frequency ? `\n**Frequency:** ${enriched2.frequency}` : '',
          ].join('\n')
        )
        .setColor(0xe11d48);

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`bug:approve:${id}`).setLabel('Approve & Post').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`bug:cancel:${id}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
      );

      await clearOldPromptComponents(pending);

      await i.editReply({
        content: 'Thanks! Here's the refined bug report. Approve to post.',
        embeds: [embed],
        components: [row],
      });
    }
```

**Step 2: Verify no type errors**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/bot.ts
git commit -m "feat(bot): add bug modal submit handler"
```

---

## Task 11: Build and test

**Step 1: Build the project**

Run: `npm run build`
Expected: No errors, `dist/` folder updated

**Step 2: Register slash commands**

Run: `npx tsx src/register.ts`
Expected: `✅ Slash commands registered`

**Step 3: Start the bot**

Run: `npm run dev`
Expected: `🤖 Logged in as <bot-name>`

**Step 4: Test in Discord**

1. Test `/bug the game crashes when I click the menu button`
   - Should create a thread
   - Should show AI-enriched summary with questions
   - Answer or skip, then approve
   - Should create GitHub issue with "bug" label

2. Test `!bug ships disappear after docking`
   - Same flow as above

**Step 5: Final commit**

```bash
git add -A
git commit -m "feat: complete bug reporting feature implementation"
```

---

## Summary

Files created:
- `src/aiBug.ts` - Bug-specific AI enrichment
- `src/commands/bug.ts` - /bug slash command

Files modified:
- `src/pending.ts` - Added `type` field
- `src/github.ts` - Added `createBugIssue()`
- `src/register.ts` - Added bug command registration
- `src/bot.ts` - Added routing, !bug handler, button handlers, modal handler
- `src/commands/idea.ts` - Added `type: 'idea'` to putPending calls
