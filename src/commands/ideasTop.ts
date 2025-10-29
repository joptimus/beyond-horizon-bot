import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from "discord.js";
import { listTopIdeas } from "../github.js";
import { rankIdeas } from "../ranking.js";

export const data = new SlashCommandBuilder()
  .setName("ideas")
  .setDescription("List top ideas")
  .addSubcommand(sc => sc
    .setName("top")
    .setDescription("Show top N ideas")
    .addIntegerOption(o => o
      .setName("count")
      .setDescription("How many ideas (default 5)")
      .setMinValue(1)
      .setMaxValue(20)
    )
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const sub = interaction.options.getSubcommand();
  if (sub !== "top") return interaction.reply({ content: "Unknown subcommand", ephemeral: true });

  const count = interaction.options.getInteger("count") ?? 5;
  await interaction.deferReply();

  try {
    const issues = await listTopIdeas(100);
    // For each issue, read the Discord vote comment
    const { readDiscordVoteCount } = await import("../github.js");
    const enriched = await Promise.all(
      issues.map(async i => {
        const votes = await readDiscordVoteCount(i.number);
        return { ...i, discordVotes: votes };
      })
    );

    // Rank by discordVotes desc, then by issue number asc
    const ranked = [...enriched].sort((a, b) => (b.discordVotes - a.discordVotes) || (a.number - b.number))
                                .slice(0, count);

    const lines = ranked.map((i, idx) =>
      `**${idx + 1}.** #${i.number} — ${i.title}  (Discord 👍 ${i.discordVotes})`
    );

    const embed = new EmbedBuilder()
      .setTitle(`Top ${count} Ideas (Discord votes)`)
      .setDescription(lines.join("\n\n"))
      .setColor(0x00ae86);

    await interaction.editReply({ embeds: [embed] });
  } catch (err: any) {
    await interaction.editReply({ content: `❌ Failed to fetch ideas: ${err.message || err}` });
  }
}

