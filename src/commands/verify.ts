import {
	SlashCommandBuilder,
	ChatInputCommandInteraction,
	ModalBuilder,
	ActionRowBuilder,
	TextInputBuilder,
	TextInputStyle,
} from 'discord.js';

export const data = new SlashCommandBuilder()
	.setName('verify')
	.setDescription('Link your enlistment designation to your Discord account');

export async function execute(interaction: ChatInputCommandInteraction) {
	const modal = new ModalBuilder()
		.setCustomId('verify:designation')
		.setTitle('Enlistment Verification');

	const input = new TextInputBuilder()
		.setCustomId('designation')
		.setLabel('Commander Designation')
		.setStyle(TextInputStyle.Short)
		.setPlaceholder('CMDR-2026-XXXXX')
		.setRequired(true)
		.setMinLength(14)
		.setMaxLength(16);

	modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
	await interaction.showModal(modal);
}
