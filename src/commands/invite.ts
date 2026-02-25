import { SlashCommandBuilder, ChatInputCommandInteraction, PermissionFlagsBits, ChannelType } from "discord.js";

export const data = new SlashCommandBuilder()
	.setName("invite")
	.setDescription("Generate a permanent invite link to the welcome channel")
	.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

export async function execute(interaction: ChatInputCommandInteraction) {
	await interaction.deferReply({ ephemeral: true });

	const channelId = process.env.WELCOME_CHANNEL_ID;
	if (!channelId) {
		return interaction.editReply("WELCOME_CHANNEL_ID is not configured.");
	}

	const channel = await interaction.client.channels.fetch(channelId);
	if (!channel || channel.type !== ChannelType.GuildText) {
		return interaction.editReply("Welcome channel not found or is not a text channel.");
	}

	const invite = await channel.createInvite({
		maxAge: 0,
		maxUses: 0,
		unique: false,
	});

	await interaction.editReply(`Permanent invite: ${invite.url}`);
}
