import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import { enrichIdea, toIssueBody, Enriched } from "../ai.js";
import { putPending } from "../pending.js";
import { findCodePointers } from "../aiCodeContext.js";
import { sendResearchNotice, renameThread } from "../researchNotice.js";
import crypto from "node:crypto";

export const data = new SlashCommandBuilder()
  .setName("idea")
  .setDescription("Submit a new idea (AI will enrich it; you can answer questions before approval)")
  .addStringOption((opt) =>
    opt.setName("text").setDescription("Describe your idea").setRequired(true)
  );

function ideaPreviewEmbed(e: Enriched) {
  const impl =
    Array.isArray(e.implementationNotes) && e.implementationNotes.length
      ? e.implementationNotes.map((d) => `• ${d}`).join("\n")
      : "• (to be refined)";

  const tagLine =
    Array.isArray(e.tags) && e.tags.length
      ? `\n**Tags**\n${e.tags.map((t) => `\`${t}\``).join(" ")}`
      : "";

  return new EmbedBuilder()
    .setTitle(e.title || "Idea")
    .setDescription(
      [
        `**Summary**\n${e.summary || "(missing)"}`,
        `\n**Gameplay Impact**\n${e.gameplayImpact || "(unspecified)"}`,
        `\n**Key Implementation Notes**\n${impl}`,
        tagLine,
      ].join("\n"),
    )
    .setColor(0x00ae86);
}

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!interaction.inGuild()) {
    await interaction.reply({ content: "❌ Use this in a server channel.", ephemeral: true });
    return;
  }

  const rawText = interaction.options.getString("text", true).trim();
  const submitterTag = `${interaction.user.username}#${interaction.user.discriminator}`;

  // Ephemeral pointer while we work + create a thread
  await interaction.deferReply({ ephemeral: true });

  // Open the thread + post a "researching" notice BEFORE the slow work so the
  // player sees immediate progress. Rename to the AI title once enrichment ends.
  const ch = interaction.channel;
  // @ts-ignore runtime has isTextBased
  if (!ch || !ch.isTextBased?.()) {
    await interaction.editReply("❌ Cannot create a thread in this channel.");
    return;
  }
  // threads.create is available on text/news/forum parents; cast to any for safety
  const thread = await (ch as any).threads.create({
    name: `[IDEA] ${rawText.slice(0, 80)}`.slice(0, 95),
    autoArchiveDuration: 1440, // 24h; tweak as desired
  });
  await sendResearchNotice(thread, interaction.user.id);

  const codeContext = await findCodePointers(rawText, "idea");

  // First pass enrichment
  const enriched = await enrichIdea(rawText, submitterTag, { codeContext });
  await renameThread(thread, `[IDEA] ${(enriched.title || rawText).slice(0, 80)}`);

  // If there are open questions → show Answer / Skip buttons (inside the thread)
  if (enriched.openQuestions && enriched.openQuestions.length > 0) {
    const id = crypto.randomUUID();

    const questionsList = enriched.openQuestions
      .slice(0, 5)
      .map((q, i) => `**Q${i + 1}.** ${q}`)
      .join("\n");

    const embed = new EmbedBuilder()
      .setTitle(enriched.title || "Idea")
      .setDescription(`**Draft Summary**\n${enriched.summary}\n\n**Open Questions**\n${questionsList}`)
      .setColor(0x00ae86);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`idea:answer:${id}`).setLabel("Answer questions").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`idea:skip:${id}`).setLabel("Skip to approval").setStyle(ButtonStyle.Secondary),
    );

    const promptMsg = await thread.send({
      content: `<@${interaction.user.id}> I have a few quick questions before finalizing. Answer now or skip:`,
      embeds: [embed],
      components: [row],
    });

    // Save pending with enriched + thread/message references
    putPending({
      type: 'idea',
      id,
      authorId: interaction.user.id,
      rawText,
      title: `[IDEA] ${(enriched.title || rawText).slice(0, 80)}`,
      body: toIssueBody(enriched, submitterTag, interaction.user.id, rawText, { codeContext }),
      createdAt: Date.now(),
      openQuestions: enriched.openQuestions.slice(0, 5),
      phase: "awaiting_answers",
      codeContext,
      ...( { enriched } as any ),
      ...( { sourceMessageId: promptMsg.id, sourceChannelId: thread.id, threadId: thread.id } as any ),
        ...( { parentChannelId: interaction.channelId } as any ),
    });

    // Point the user to the thread (ephemeral)
    await interaction.editReply({ content: `🧵 Thread opened: <#${thread.id}>` });
    return;
  }

  // No questions → go straight to approval (inside the thread)
  const id = crypto.randomUUID();

  putPending({
    type: 'idea',
    id,
    authorId: interaction.user.id,
    rawText,
    title: `[IDEA] ${(enriched.title || rawText).slice(0, 80)}`,
    body: toIssueBody(enriched, submitterTag, interaction.user.id, rawText, { codeContext }),
    createdAt: Date.now(),
    phase: "awaiting_approval",
    codeContext,
    ...( { enriched } as any ),
    ...( { sourceChannelId: thread.id, threadId: thread.id } as any ),
      ...( { parentChannelId: interaction.channelId } as any ),
  });

  const embed = ideaPreviewEmbed(enriched);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`idea:approve:${id}`).setLabel("Approve & Post").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`idea:cancel:${id}`).setLabel("Cancel").setStyle(ButtonStyle.Secondary),
  );

  await thread.send({
    content: `<@${interaction.user.id}> Here’s the AI-enriched draft. Approve to post.`,
    embeds: [embed],
    components: [row],
  });

  // Ephemeral pointer to the thread
  await interaction.editReply({ content: `🧵 Thread opened: <#${thread.id}>` });
}
