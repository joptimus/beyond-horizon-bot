// src/bot.ts
import 'dotenv/config';
import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	Client,
	EmbedBuilder,
	Events,
	GatewayIntentBits,
	GuildMember,
	Message,
	MessageReaction,
	MessageReactionEventDetails,
	ModalBuilder,
	PartialMessageReaction,
	PartialUser,
	Partials,
	TextInputBuilder,
	TextInputStyle,
	User,
} from 'discord.js';

import crypto from 'node:crypto';
import { startApi } from './api.js';

// ---- Slash command modules (keep these in ./commands) ----
import * as IdeaSlash from './commands/idea.js';
import * as IdeasTop from './commands/ideasTop.js';
import * as Priority from './commands/priority.js';
import * as BugSlash from './commands/bug.js';
import * as VerifySlash from './commands/verify.js';
import * as InviteSlash from './commands/invite.js';

// ---- AI & pending store for Q→A→Approval flow ----
import { enrichIdea, toIssueBody } from './ai.js';
import { enrichBug, toBugIssueBody } from './aiBug.js';
import { getPending, putPending, delPending } from './pending.js';
import { getIssueFromVoteMessage, linkVoteMessage } from './votes.js';
// ---- GitHub helpers (issue + vote sync) ----
import { createIdeaIssue, createBugIssue, upsertDiscordVoteComment, readDiscordVoteCount, listTopIdeas, extractSummaryFromIssueBody, fetchIssue } from './github.js';
import { verifyDesignation, checkDiscordVerified } from './gameServer.js';

// ======================
// Logging Setup
// ======================
const log = {
	info: (msg: string) => console.log(`[INFO] ${new Date().toISOString()} ${msg}`),
	warn: (msg: string, err?: any) => {
		if (err) console.warn(`[WARN] ${new Date().toISOString()} ${msg}`, err);
		else console.warn(`[WARN] ${new Date().toISOString()} ${msg}`);
	},
	error: (msg: string, err?: any) => {
		if (err) console.error(`[ERROR] ${new Date().toISOString()} ${msg}`, err);
		else console.error(`[ERROR] ${new Date().toISOString()} ${msg}`);
	},
	debug: (msg: string) => console.log(`[DEBUG] ${new Date().toISOString()} ${msg}`),
};

// ======================
// Client initialization
// ======================
const client = new Client({
	intents: [
		GatewayIntentBits.Guilds, // slash commands, guild info
		GatewayIntentBits.GuildMessages, // prefix messages
		GatewayIntentBits.MessageContent, // read "!idea ..." content (enable in Dev Portal)
		GatewayIntentBits.GuildMessageReactions, // 👍 add/remove
		GatewayIntentBits.GuildMembers, // new member join events
	],
	partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

log.info('Bot client created');

// Map slash names → modules
const CMDS: Record<string, any> = {
	[IdeaSlash.data.name]: IdeaSlash,
	[IdeasTop.data.name]: IdeasTop,
	[Priority.data.name]: Priority,
	[BugSlash.data.name]: BugSlash,
	[VerifySlash.data.name]: VerifySlash,
	[InviteSlash.data.name]: InviteSlash,
};

// =====================
// Helpers: Verify Modal & Button
// =====================
function buildVerifyModal(): ModalBuilder {
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

	return modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
}

function buildVerifyButton(): ActionRowBuilder<ButtonBuilder> {
	return new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder()
			.setCustomId('open_verify_modal')
			.setLabel('VERIFY DESIGNATION')
			.setStyle(ButtonStyle.Primary)
	);
}

client.once(Events.ClientReady, (c) => {
	console.log(`🤖 Logged in as ${c.user.tag}`);
	startApi(client);
});

// Create a public thread off the invoking message (prefix flow)
// Fallback: if the message is already in a thread, just reuse it.
async function getOrStartIdeaThread(message: Message, title: string) {
	if (message.channel.isThread()) {
		return message.channel;
	}
	// Thread name max ~100 chars
	const name = `[IDEA] ${title}`.slice(0, 95);
	const thread = await message.startThread({
		name,
		autoArchiveDuration: 1440, // 24h; adjust as you like
	});
	// (Optional) leave a tiny pointer in the parent channel then delete it
	// await message.reply({ content: `📌 Continued in thread: <#${thread.id}>` }).then(m => setTimeout(() => m.delete().catch(()=>{}), 5000)).catch(()=>{});
	return thread;
}

// ======================
// Slash command router
// ======================
client.on(Events.InteractionCreate, async (interaction) => {
	if (!interaction.isChatInputCommand()) return;
	log.info(`[SLASH CMD] ${interaction.commandName} called by ${interaction.user.tag} (${interaction.user.id})`);

	const mod = CMDS[interaction.commandName];
	if (!mod) {
		log.warn(`[SLASH CMD] Unknown command: ${interaction.commandName}`);
		return interaction.reply({ content: 'Unknown command', ephemeral: true });
	}
	try {
		log.debug(`[SLASH CMD] Executing ${interaction.commandName}`);
		await mod.execute(interaction);
		log.info(`[SLASH CMD] ${interaction.commandName} completed successfully`);
	} catch (e: any) {
		log.error(`[SLASH CMD] ${interaction.commandName} failed:`, e);
		if (interaction.deferred || interaction.replied) {
			await interaction.editReply({ content: `❌ Error: ${e?.message || String(e)}` }).catch(() => {});
		} else {
			await interaction.reply({ content: `❌ Error: ${e?.message || String(e)}`, ephemeral: true }).catch(() => {});
		}
	}
});

// ======================
// Prefix commands
// ======================
const PREFIX = '!';

client.on(Events.MessageCreate, async (message: Message) => {
	try {
		if (message.author.bot) return;
		if (!message.content.startsWith(PREFIX)) return;

		const args = message.content.slice(PREFIX.length).trim().split(/ +/);
		const command = (args.shift() || '').toLowerCase();

		// -------- !idea  (AI → openQuestions? modal : approval) --------
		if (command === 'idea') {
			if (!message.guild) return message.reply('❌ Use this in a server channel.');

			const rawText = args.join(' ').trim();
			if (!rawText) return message.reply('❗ Usage: `!idea <your idea>`');

			const submitterTag = `${message.author.username}#${message.author.discriminator}`;
			// 1) First pass enrichment
			const enriched = await enrichIdea(rawText, submitterTag);
			const id = crypto.randomUUID();

			// 2) If questions exist → ask to Answer or Skip (inside a thread)
			if (enriched.openQuestions?.length) {
				const questionsList = enriched.openQuestions
					.slice(0, 5)
					.map((q, i) => `**Q${i + 1}.** ${q}`)
					.join('\n');

				const qEmbed = new EmbedBuilder()
					.setTitle(enriched.title || 'Idea')
					.setDescription(`**Draft Summary**\n${enriched.summary}\n\n**Open Questions**\n${questionsList}`)
					.setColor(0x00ae86);

				const qRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
					new ButtonBuilder().setCustomId(`idea:answer:${id}`).setLabel('Answer questions').setStyle(ButtonStyle.Primary),
					new ButtonBuilder().setCustomId(`idea:skip:${id}`).setLabel('Skip to approval').setStyle(ButtonStyle.Secondary)
				);

				// 🔹 Create (or reuse) a thread for this idea
				const thread = await getOrStartIdeaThread(message, (enriched.title || rawText).slice(0, 80));

				// Post the prompt INSIDE the thread
				const promptMsg = await thread.send({
					content: `<@${message.author.id}> I have a few quick questions before finalizing. Answer now or skip:`,
					embeds: [qEmbed],
					components: [qRow],
				});

				// Save pending draft (single putPending), including thread+message ids
				putPending({
					type: 'idea',
					id,
					authorId: message.author.id,
					rawText,
					title: `[IDEA] ${(enriched.title || rawText).slice(0, 80)}`,
					body: toIssueBody(enriched, submitterTag, message.author.id, rawText),
					createdAt: Date.now(),
					openQuestions: enriched.openQuestions.slice(0, 5),
					phase: 'awaiting_answers',
					...({ enriched } as any),
					...({ sourceMessageId: promptMsg.id, sourceChannelId: thread.id, threadId: thread.id, parentChannelId: message.channelId } as any),
				});

				return; // stop here; later steps continue in the thread
			}

			// 3) No questions → go straight to approval (in a thread)
			const thread = await getOrStartIdeaThread(message, (enriched.title || rawText).slice(0, 80));

			putPending({
				type: 'idea',
				id,
				authorId: message.author.id,
				rawText,
				title: `[IDEA] ${(enriched.title || rawText).slice(0, 80)}`,
				body: toIssueBody(enriched, submitterTag, message.author.id, rawText),
				createdAt: Date.now(),
				phase: 'awaiting_approval',
				...({ enriched } as any),
				...({ sourceChannelId: thread.id, threadId: thread.id, parentChannelId: message.channelId } as any),
			});

			const previewImpl =
				Array.isArray(enriched.implementationNotes) && enriched.implementationNotes.length
					? enriched.implementationNotes.map((d) => `• ${d}`).join('\n')
					: '• (to be refined)';

			const previewTagLine =
				Array.isArray(enriched.tags) && enriched.tags.length ? `\n**Tags**\n${enriched.tags.map((t) => `\`${t}\``).join(' ')}` : '';

			const previewEmbed = new EmbedBuilder()
				.setTitle(enriched.title || 'Idea')
				.setDescription(
					[
						`**Summary**\n${enriched.summary || '(missing)'}`,
						`\n**Gameplay Impact**\n${enriched.gameplayImpact || '(unspecified)'}`,
						`\n**Key Implementation Notes**\n${previewImpl}`,
						previewTagLine,
					].join('\n')
				)
				.setColor(0x00ae86);

			const previewRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
				new ButtonBuilder().setCustomId(`idea:approve:${id}`).setLabel('Approve & Post').setStyle(ButtonStyle.Success),
				new ButtonBuilder().setCustomId(`idea:cancel:${id}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
			);

			// 🔹 Post approval card in the thread
			await thread.send({
				content: 'Here’s the AI-enriched draft. Approve to post.',
				embeds: [previewEmbed],
				components: [previewRow],
			});

			return;
		}

		// -------- !ideas [count]  (rank by Discord 👍 stored in GitHub comment) --------
		if (command === 'ideas') {
			const count = Number(args[0] || 5);

			const issues = await listTopIdeas(100);
			const withVotes = await Promise.all(issues.map(async (i) => ({ ...i, discordVotes: await readDiscordVoteCount(i.number) })));

			const ranked = withVotes.sort((a, b) => b.discordVotes - a.discordVotes || a.number - b.number).slice(0, count);

			const lines = ranked.map((i, idx) => `**${idx + 1}.** #${i.number} — ${i.title} (Discord 👍 ${i.discordVotes})\n${i.html_url}`);

			return message.reply(lines.join('\n\n') || 'No ideas found.');
		}
		if (command === 'explain') {
			const num = Number(args[0]);
			if (!num || !Number.isInteger(num) || num < 1) {
				return message.reply('❗ Usage: `!explain <issueNumber>` (e.g., `!explain 42`)');
			}

			try {
				const issue = await fetchIssue(num);
				const summary = extractSummaryFromIssueBody(issue.body || '');
				const desc = summary ? `**Summary**\n${summary}` : `**Summary**\n_(no summary found in issue body)_`;

				const embed = new EmbedBuilder()
					.setTitle(`Idea #${issue.number}: ${issue.title}`)
					.setURL(issue.html_url)
					.setDescription(desc)
					.setColor(0x00ae86);

				return message.reply({ embeds: [embed] });
			} catch (err: any) {
				// 404 or perms
				const msg = err?.status === 404 ? `❌ Issue #${num} not found.` : `❌ Could not fetch issue #${num}: ${err?.message || err}`;
				return message.reply(msg);
			}
		}

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
				content: 'Here\'s the bug report. Approve to post to GitHub.',
				embeds: [previewEmbed],
				components: [previewRow],
			});

			return;
		}
	} catch (e: any) {
		console.error('Prefix handler error:', e);
		if (message.channel?.isTextBased()) {
			message.reply(`❌ Error: ${e?.message || String(e)}`).catch(() => {});
		}
	}
});

// =========================================
// Buttons + Modal flow (Answer / Skip / Approve / Cancel)
// =========================================
client.on(Events.InteractionCreate, async (i) => {
	// ----- BUTTONS -----
	if (i.isButton()) {
		const [ns, action, id] = i.customId.split(':');
		log.info(`[BUTTON] ${i.customId} clicked by ${i.user.tag} (${i.user.id})`);

		// ----- IDEA BUTTONS -----
		if (ns === 'idea') {
			log.debug(`[BUTTON] Processing idea button: action=${action}, id=${id}`);
		const pending = getPending(id);
		if (!pending) return i.reply({ content: '❌ This draft expired. Please try again.', ephemeral: true });
		if (i.user.id !== pending.authorId) {
			return i.reply({ content: '⛔ Only the original submitter can continue this flow.', ephemeral: true });
		}

		// Show modal to answer questions
		if (action === 'answer') {
			const qs = (pending as any).openQuestions || [];
			if (!qs.length) return i.reply({ content: 'No questions to answer.', ephemeral: true });

			const modal = new ModalBuilder().setCustomId(`idea:answers:${id}`).setTitle('Answer questions (you can skip any)');

			qs.slice(0, 5).forEach((q: string, idx: number) => {
				const input = new TextInputBuilder()
					.setCustomId(`q${idx + 1}`)
					.setLabel(`Q${idx + 1}`) // <= short label (Discord limit is ~45 chars)
					.setStyle(TextInputStyle.Paragraph)
					.setRequired(false)
					.setPlaceholder(q) // <= full question visible here
					.setMaxLength(1000); // optional: allow longer answers

				modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
			});

			return i.showModal(modal);
		}

		// Skip questions → go to approval
		if (action === 'skip') {
			(pending as any).phase = 'awaiting_approval';
			putPending(pending);

			const embed = new EmbedBuilder()
				.setTitle((pending as any).title.replace(/^\[IDEA\]\s*/, ''))
				.setDescription('You chose to skip questions. Approve to post.')
				.setColor(0x00ae86);

			const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
				new ButtonBuilder().setCustomId(`idea:approve:${id}`).setLabel('Approve & Post').setStyle(ButtonStyle.Success),
				new ButtonBuilder().setCustomId(`idea:cancel:${id}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
			);

			return i.update({ content: 'Review the draft below.', embeds: [embed], components: [row] });
		}

		// Approve → Create issue + post voting message
		// Approve → Create issue + post vote in parent channel; post confirmation in thread
		if (action === 'approve') {
			await clearOldPromptComponents(pending);
			await i.update({ content: 'Posting your idea…', components: [], embeds: [] });

			const issue = await createIdeaIssue({ title: (pending as any).title, body: (pending as any).body });

			// Build the summary like !explain does
			const summary = extractSummaryFromIssueBody(issue.body || '');
			const desc = summary
				? `**Summary**\n${summary}\n\nReact with 👍 to vote.`
				: `**Summary**\n_(no summary found in issue body)_\n\nReact with 👍 to vote.`;

			// Resolve thread + parent
			const threadId = (pending as any).threadId || (pending as any).sourceChannelId;
			const thread = threadId ? await client.channels.fetch(threadId as string) : null;

			// Try to get parent channel id
			let parentChannel: any = null;
			try {
				if (thread && (thread as any).isThread?.()) {
					const parentId = (thread as any).parentId;
					if (parentId) parentChannel = await client.channels.fetch(parentId);
				}
				// fallback if we stored it when creating the thread
				if (!parentChannel && (pending as any).parentChannelId) {
					parentChannel = await client.channels.fetch((pending as any).parentChannelId as string);
				}
			} catch {}

			// 1) Post VOTE message in the PARENT CHANNEL (not in the thread)
			let voteMsg: Message | null = null;

			const voteEmbed = new EmbedBuilder()
				.setTitle(`Idea #${issue.number}: ${issue.title}`)
				.setURL(issue.html_url) // clickable -> GitHub issue
				.setDescription(desc) // uses the Summary like !explain
				.setColor(0x00ae86); // same color you use elsewhere

			if (parentChannel && (parentChannel as any).isTextBased?.()) {
				voteMsg = await(parentChannel as any).send({ embeds: [voteEmbed] });
			} else {
				// Last-resort fallback
				voteMsg = await i.followUp({ embeds: [voteEmbed], fetchReply: true } as any);
			}

			if (voteMsg && typeof (voteMsg as any).react === 'function') {
				await(voteMsg as any).react('👍');
				linkVoteMessage(voteMsg.id, issue.number);
			}

			await upsertDiscordVoteComment(issue.number, 0);

			// 2) Post CREATED notice INSIDE the THREAD
			if (thread && (thread as any).isTextBased?.()) {
				await(thread as any).send(`✅ Created idea **#${issue.number}** - ${issue.title}`);
			}

			delPending(id);

			// Optional: small confirmation to the approver (won’t spam channels)
			return i.followUp({ content: `Done. Idea #${issue.number} posted.`, ephemeral: true });
		}

		// Cancel
		if (action === 'cancel') {
			await clearOldPromptComponents(pending);
			delPending(id);
			return i.update({ content: 'Draft **canceled**.', components: [], embeds: [] });
		}
		} // end if (ns === 'idea')

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

		// ----- VERIFY BUTTON -----
		if (i.customId === 'open_verify_modal') {
			log.debug(`[VERIFY BUTTON] Opening verify modal for ${i.user.tag}`);
			try {
				const modal = buildVerifyModal();
				log.debug(`[VERIFY BUTTON] Modal created, showing to user`);
				return i.showModal(modal);
			} catch (err) {
				log.error(`[VERIFY BUTTON] Failed to show verify modal:`, err);
				if (!i.replied && !i.deferred) {
					return i.reply({
						content: 'Could not open verification form. Try again.',
						ephemeral: true
					}).catch(() => {});
				}
			}
		}
	}

	// ----- MODAL SUBMIT (answers) -----
	if (i.isModalSubmit()) {
		const [ns, action, id] = i.customId.split(':');
		log.info(`[MODAL] ${i.customId} submitted by ${i.user.tag} (${i.user.id})`);

		// ----- IDEA MODAL SUBMIT -----
		if (ns === 'idea' && action === 'answers') {
			log.debug(`[MODAL] Processing idea answers modal`);
			const pending = getPending(id);
			// We might need to reply regardless; handle gracefully
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

			// ✅ Acknowledge within ~3s to avoid "Unknown interaction"
			if (!i.replied && !i.deferred) {
				await i.deferReply({ ephemeral: false });
			}

			// Gather Q/A
			const qs = (pending as any).openQuestions || [];
			const qaLines: string[] = [];
			qs.slice(0, 5).forEach((q: string, idx: number) => {
				const ans = i.fields.getTextInputValue(`q${idx + 1}`) || '';
				if (q || ans) {
					qaLines.push(`Q${idx + 1}: ${q}`);
					if (ans.trim()) qaLines.push(`A${idx + 1}: ${ans.trim()}`);
				}
			});
			const answersText = qaLines.join('\n');

			// Re-enrich with answers → pass previous JSON for refinement
			const submitterTag = i.user.tag;
			const previous = (pending as any).enriched || undefined;
			const enriched2 = await enrichIdea((pending as any).rawText, submitterTag, answersText, previous);

			const finalTitle = `[IDEA] ${(enriched2.title || (pending as any).rawText).slice(0, 80)}`;
			const finalBody = toIssueBody(enriched2, submitterTag, i.user.id, (pending as any).rawText, answersText);

			(pending as any).title = finalTitle;
			(pending as any).body = finalBody;
			(pending as any).phase = 'awaiting_approval';
			(pending as any).enriched = enriched2; // keep latest structured JSON
			putPending(pending);

			const impl2 =
				Array.isArray(enriched2.implementationNotes) && enriched2.implementationNotes.length
					? enriched2.implementationNotes.map((d) => `• ${d}`).join('\n')
					: '• (to be refined)';

			const tagLine2 = Array.isArray(enriched2.tags) && enriched2.tags.length ? `\n**Tags**\n${enriched2.tags.map((t) => `\`${t}\``).join(' ')}` : '';

			const embed = new EmbedBuilder()
				.setTitle(enriched2.title || 'Idea')
				.setDescription(
					[
						`**Summary**\n${enriched2.summary || '(missing)'}`,
						`\n**Gameplay Impact**\n${enriched2.gameplayImpact || '(unspecified)'}`,
						`\n**Key Implementation Notes**\n${impl2}`,
						tagLine2,
					].join('\n')
				)
				.setColor(0x00ae86);

			const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
				new ButtonBuilder().setCustomId(`idea:approve:${id}`).setLabel('Approve & Post').setStyle(ButtonStyle.Success),
				new ButtonBuilder().setCustomId(`idea:cancel:${id}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
			);

			await clearOldPromptComponents(pending);

			// ✅ Finish the deferred response
			await i.editReply({
				content: "Thanks! Here's the refined draft. Approve to post.",
				embeds: [embed],
				components: [row],
			});
		}

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
				content: "Thanks! Here's the refined bug report. Approve to post.",
				embeds: [embed],
				components: [row],
			});
		}

		// ----- VERIFY MODAL SUBMIT -----
		if (ns === 'verify' && action === 'designation') {
			log.info(`[VERIFY MODAL] Verification started for ${i.user.tag} (${i.user.id})`);
			await i.deferReply({ ephemeral: true });

			try {
				// Check if user is already verified
				log.debug(`[VERIFY MODAL] Checking if user is already verified`);
				const check = await checkDiscordVerified(i.user.id);
				log.debug(`[VERIFY MODAL] Verification check result: verified=${check.verified}`);

				if (check.verified) {
					log.info(`[VERIFY MODAL] User already verified as ${check.callsign}`);
					return i.editReply({ content: "You're already verified, Commander." });
				}

				const designation = i.fields.getTextInputValue('designation').trim().toUpperCase();
				log.info(`[VERIFY MODAL] User submitted designation: ${designation}`);

				log.debug(`[VERIFY MODAL] Calling verifyDesignation API`);
				const result = await verifyDesignation(designation, i.user.id);
				log.info(`[VERIFY MODAL] API response: ok=${result.ok}, error=${result.error}`);

				if (!result.ok) {
					log.warn(`[VERIFY MODAL] Verification failed with error: ${result.error}`);
					const messages: Record<string, string> = {
						INVALID_FORMAT: 'Invalid designation format. Expected: `CMDR-2026-XXXXX`.',
						NOT_FOUND: 'Designation not recognized. Double-check your code from the verification email.',
						EMAIL_NOT_VERIFIED: "Your enlistment hasn't been confirmed yet. Check your email for the verification link.",
						ALREADY_CLAIMED: 'This designation is already linked to a Discord account. If this is an error, contact a moderator.',
						ALREADY_VERIFIED: "You're already verified, Commander.",
					};
					return i.editReply({ content: messages[result.error!] || 'Something went wrong. Try again later.' });
				}

				const callsign = result.callsign!;
				log.info(`[VERIFY MODAL] ✅ Verification successful! Callsign: ${callsign}`);

				// Grant @Verified role
				const roleId = process.env.VERIFIED_ROLE_ID;
				const guildId = process.env.DISCORD_GUILD_ID;
				log.debug(`[VERIFY MODAL] VERIFIED_ROLE_ID from env: ${roleId}`);

				if (roleId && guildId) {
					try {
						log.debug(`[VERIFY MODAL] Fetching guild member`);
						const guild = await client.guilds.fetch(guildId!);

					log.debug(`[VERIFY MODAL] Fetching guild member ${i.user.id}`);
					const member = await guild.members.fetch(i.user.id);

						log.debug(`[VERIFY MODAL] Adding verified role`);
						await member.roles.add(roleId).catch((e) => {
							log.error(`[VERIFY MODAL] Failed to add Verified role:`, e);
						});

						log.debug(`[VERIFY MODAL] Setting nickname to callsign: ${callsign}`);
						await member.setNickname(callsign).catch((e) => {
							log.error(`[VERIFY MODAL] Failed to set nickname:`, e);
						});
						log.info(`[VERIFY MODAL] ✅ Role and nickname updated for ${i.user.tag}`);
					} catch (roleError) {
						log.error(`[VERIFY MODAL] Error updating member:`, roleError);
					}
				} else {
					log.warn(`[VERIFY MODAL] ⚠️ Could not add role - VERIFIED_ROLE_ID=${roleId}, guildId=${guildId}`);
				}

				// Post welcome embed in enlistment log channel
				const logChannelId = process.env.ENLISTMENT_LOG_CHANNEL_ID;
				log.debug(`[VERIFY MODAL] ENLISTMENT_LOG_CHANNEL_ID from env: ${logChannelId}`);

				if (logChannelId) {
					try {
						log.debug(`[VERIFY MODAL] Fetching enlistment log channel`);
						const logChannel = await client.channels.fetch(logChannelId);
						if (logChannel?.isTextBased()) {
							log.debug(`[VERIFY MODAL] Posting welcome message to log channel`);
							const embed = new EmbedBuilder()
								.setColor(0x00e5cc)
								.setDescription(`⟫ Commander **${callsign}** [${designation}] has reported for duty.`);
							await (logChannel as any).send({ embeds: [embed] }).catch((e: any) => {
								log.error(`[VERIFY MODAL] Failed to post welcome message:`, e);
							});
							log.info(`[VERIFY MODAL] ✅ Welcome message posted to log channel`);
						} else {
							log.warn(`[VERIFY MODAL] ⚠️ Log channel not text-based`);
						}
					} catch (channelError) {
						log.error(`[VERIFY MODAL] Error accessing log channel:`, channelError);
					}
				} else {
					log.warn(`[VERIFY MODAL] ⚠️ ENLISTMENT_LOG_CHANNEL_ID not set`);
				}

				log.info(`[VERIFY MODAL] ✅ Verification complete for ${i.user.tag} as ${callsign}`);
				return i.editReply({ content: `Verification complete. Welcome aboard, Commander **${callsign}**.` });
			} catch (err) {
				log.error(`[VERIFY MODAL] ❌ Unexpected error:`, err);
				if (!i.replied) {
					return i.editReply({ content: 'Something went wrong. Try again later.' });
				}
			}
		}
	}
});

async function clearOldPromptComponents(pending: any) {
	try {
		const channelId = pending?.sourceChannelId;
		const messageId = pending?.sourceMessageId;
		if (!channelId || !messageId) return;

		const ch = await client.channels.fetch(channelId as string);
		// @ts-ignore - isTextBased exists at runtime
		if (!ch || !ch.isTextBased?.()) return;

		const msg = await (ch as any).messages.fetch(messageId);
		// Option A: remove buttons
		await msg.edit({ components: [] }).catch(() => {});
		// Option B: (optional) also add a small suffix:
		// await msg.edit({ content: `${msg.content}\n_(superseded)_`, components: [] });
	} catch (err) {
		console.warn('clearOldPromptComponents failed:', err);
	}
}
// =========================================
// Reaction sync: keep GitHub “Discord votes: N” updated
// =========================================
async function isIdeaVoteMessage(m: Message) {
	if (!m || !m.content) return false;
	return /^Idea\s*#\d+:/i.test(m.content) && /https:\/\/github\.com\/.+\/issues\/\d+/.test(m.content);
}
function extractIssueNumberFromMessage(m: Message): number | null {
	const match = m.content.match(/Idea\s*#(\d+):/i);
	return match ? Number(match[1]) : null;
}
async function recountThumbsUpAndUpdate(m: Message) {
	const issueNumber = extractIssueNumberFromMessage(m);
	if (!issueNumber) return;

	const up = m.reactions.cache.find((r) => r.emoji.name === '👍');
	let voters = 0;
	if (up) {
		const users = await up.users.fetch({ limit: 100 });
		voters = users.filter((u) => !u.bot).size;
	}
	await upsertDiscordVoteComment(issueNumber, voters);
}

client.on(Events.MessageReactionAdd, async (reaction, user) => {
	if (user.bot) return;
	if (reaction.emoji.name !== '👍') return;

	if (reaction.partial) await reaction.fetch();

	const issueNumber = getIssueFromVoteMessage(reaction.message.id);
	if (!issueNumber) return;

	const votes = Math.max((reaction.count || 1) - 1, 0); // minus bot seed
	await upsertDiscordVoteComment(issueNumber, votes);
});

client.on(Events.MessageReactionRemove, async (reaction, user) => {
	if (user.bot) return;
	if (reaction.emoji.name !== '👍') return;

	if (reaction.partial) await reaction.fetch();

	const issueNumber = getIssueFromVoteMessage(reaction.message.id);
	if (!issueNumber) return;

	const votes = Math.max((reaction.count || 1) - 1, 0);
	await upsertDiscordVoteComment(issueNumber, votes);
});

// ======================
// Member Join Flow (Welcome DM + Verify Channel Post)
// ======================
client.on(Events.GuildMemberAdd, async (member: GuildMember) => {
	log.info(`[MEMBER JOIN] ${member.user.tag} (${member.user.id}) joined guild ${member.guild.id}`);
	try {
		// 1. Build verify modal and button using helpers
		log.debug(`[MEMBER JOIN] Building verify modal and button`);
		const buttonRow = buildVerifyButton();

		// 3. Build DM embed
		log.debug(`[MEMBER JOIN] Creating DM embed`);
		const dmEmbed = new EmbedBuilder()
			.setTitle('V1-PR · INCOMING TRANSMISSION')
			.setDescription(
				'Commander, your arrival at the frontier has been logged.\n\n' +
				'If you\'ve already enlisted at **beyondhorizononline.com**, link your designation to unlock full access to this channel.\n\n' +
				'If you haven\'t enlisted yet, head to [beyondhorizononline.com](https://beyondhorizononline.com) to secure your callsign before someone else does.'
			)
			.setColor(0x00e5cc)
			.setFooter({ text: 'Voran Defense Systems · V1-PR Automated Systems' });

		// 4. Send DM to user
		log.debug(`[MEMBER JOIN] Attempting to send DM to ${member.user.tag}`);
		try {
			await member.send({
				embeds: [dmEmbed],
				components: [buttonRow],
			});
			log.info(`[MEMBER JOIN] ✅ DM sent successfully to ${member.user.tag}`);
		} catch (dmError) {
			// User has DMs disabled; that's ok, channel post will catch them
			log.warn(`[MEMBER JOIN] ❌ Could not DM ${member.user.tag} (likely DMs disabled):`, dmError);
		}

		// 5. Post in verify channel
		const verifyChannelId = process.env.VERIFY_CHANNEL_ID;
		log.debug(`[MEMBER JOIN] VERIFY_CHANNEL_ID from env: ${verifyChannelId}`);

		if (verifyChannelId) {
			try {
				log.debug(`[MEMBER JOIN] Fetching verify channel: ${verifyChannelId}`);
				const verifyChannel = await client.channels.fetch(verifyChannelId);
				if (!verifyChannel) {
					log.warn(`[MEMBER JOIN] ❌ Verify channel not found: ${verifyChannelId}`);
				} else if (!verifyChannel.isTextBased()) {
					log.warn(`[MEMBER JOIN] ❌ Verify channel is not text-based: ${verifyChannelId}`);
				} else {
					log.debug(`[MEMBER JOIN] Creating channel embed`);
					const channelEmbed = new EmbedBuilder()
						.setTitle('V1-PR · NEW ARRIVAL')
						.setDescription(
							'A new commander has entered the sector. Welcome aboard.\n\n' +
							'Use the button below or type `/verify` to link your enlistment designation.'
						)
						.setColor(0x00e5cc)
						.setFooter({ text: 'Voran Defense Systems' });

					log.debug(`[MEMBER JOIN] Sending message to verify channel`);
					await (verifyChannel as any).send({
						content: `<@${member.user.id}>`,
						embeds: [channelEmbed],
						components: [buttonRow],
					});
					log.info(`[MEMBER JOIN] ✅ Channel message sent to verify channel for ${member.user.tag}`);
				}
			} catch (channelError) {
				log.error(`[MEMBER JOIN] ❌ Failed to post to verify channel (${verifyChannelId}):`, channelError);
			}
		} else {
			log.warn(`[MEMBER JOIN] ⚠️ VERIFY_CHANNEL_ID not set in environment`);
		}
	} catch (error) {
		log.error(`[MEMBER JOIN] ❌ Unexpected error in guildMemberAdd handler:`, error);
	}
});

// ======================
// Start the bot
// ======================
client.login(process.env.DISCORD_TOKEN);
