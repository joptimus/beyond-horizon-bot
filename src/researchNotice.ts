// src/researchNotice.ts
// Early-acknowledgement helpers for the submission flows. Code search + AI
// enrichment take 20-40s on a reasoning model before the bot can post its
// clarifying questions. To keep the player engaged (and reduce drop-off), each
// flow now opens its thread UP FRONT and drops a canned "I'm researching this"
// notice as the first message, then does the slow work.
//
// The thread can't be named from the AI title yet (it doesn't exist), so callers
// create it from the raw submission text and rename it once enrichment finishes.

// `thread` is typed loosely (any) because callers pass discord.js ThreadChannel
// instances obtained through several differently-typed paths (Message.startThread,
// TextChannel.threads.create); the two methods we use exist on all of them.

const RESEARCH_NOTICE = (authorId: string) =>
  `<@${authorId}> 🔎 Got it — I'm researching this against the codebase and drafting it up. ` +
  `I'll be right back with a draft (and maybe a couple of quick questions) in just a moment...`;

/** Post the canned "researching" notice as the thread's first message. Best-effort. */
export async function sendResearchNotice(thread: any, authorId: string): Promise<void> {
  try {
    await thread.send({ content: RESEARCH_NOTICE(authorId) });
  } catch (err) {
    console.warn("[researchNotice] failed to send notice:", (err as Error).message);
  }
}

/**
 * Rename an already-open thread to its final AI-titled name. Best-effort: a
 * failed rename just leaves the raw-text name in place. Discord allows 2 renames
 * per 10 min per thread and we rename at most once, so we're well within limits.
 */
export async function renameThread(thread: any, name: string): Promise<void> {
  try {
    await thread.setName(name.slice(0, 95));
  } catch (err) {
    console.warn("[researchNotice] failed to rename thread:", (err as Error).message);
  }
}
