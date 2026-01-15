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
    .setColor(0xe11d48);
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
