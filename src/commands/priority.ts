import { SlashCommandBuilder, ChatInputCommandInteraction, PermissionFlagsBits } from "discord.js";
import { setPriorityLabel } from "../github.js";

export const data = new SlashCommandBuilder()
  .setName("priority")
  .setDescription("Set priority label P1..P5 on an idea (maintainers only)")
  .addIntegerOption(o => o.setName("issue").setDescription("GitHub issue number").setRequired(true))
  .addIntegerOption(o => o.setName("level").setDescription("1..5 (1 highest)").setMinValue(1).setMaxValue(5).setRequired(true))
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

export async function execute(interaction: ChatInputCommandInteraction) {
  const issue = interaction.options.getInteger("issue", true);
  const level = interaction.options.getInteger("level", true) as 1|2|3|4|5;

  await interaction.deferReply({ ephemeral: false });
  try {
    await setPriorityLabel(issue, level);
    await interaction.editReply(`✅ Set priority **P${level}** on issue #${issue}`);
  } catch (err: any) {
    await interaction.editReply({ content: `❌ Failed to set priority: ${err.message || err}` });
  }
}
