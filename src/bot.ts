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

// ---- Slash command modules (keep these in ./commands) ----
import * as IdeaSlash from './commands/idea.js';
import * as IdeasTop from './commands/ideasTop.js';
import * as Priority from './commands/priority.js';

// ---- AI & pending store for Q→A→Approval flow ----
import { enrichIdea, toIssueBody } from './ai.js';
import { getPending, putPending, delPending } from './pending.js';
import { getIssueFromVoteMessage, linkVoteMessage } from "./votes.js";
// ---- GitHub helpers (issue + vote sync) ----
import { createIdeaIssue, upsertDiscordVoteComment, readDiscordVoteCount, listTopIdeas } from './github.js';

// ======================
// Client initialization
// ======================
const client = new Client({
	intents: [
		GatewayIntentBits.Guilds, // slash commands, guild info
		GatewayIntentBits.GuildMessages, // prefix messages
		GatewayIntentBits.MessageContent, // read "!idea ..." content (enable in Dev Portal)
		GatewayIntentBits.GuildMessageReactions, // 👍 add/remove
	],
	partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

// Map slash names → modules
const CMDS: Record<string, any> = {
	[IdeaSlash.data.name]: IdeaSlash,
	[IdeasTop.data.name]: IdeasTop,
	[Priority.data.name]: Priority,
};

client.once(Events.ClientReady, (c) => {
	console.log(`🤖 Logged in as ${c.user.tag}`);
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
	const mod = CMDS[interaction.commandName];
	if (!mod) {
		return interaction.reply({ content: 'Unknown command', ephemeral: true });
	}
	try {
		await mod.execute(interaction);
	} catch (e: any) {
		console.error('Slash command error:', e);
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
		if (ns !== 'idea') return;

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
			if (parentChannel && (parentChannel as any).isTextBased?.()) {
				voteMsg = await (parentChannel as any).send({
					content: `Idea #${issue.number}: ${issue.title}\n(React with 👍 to vote)`,
				});
			} else {
				// Last-resort fallback
				voteMsg = await i.followUp({
					content: `Idea #${issue.number}: ${issue.title}\n(React with 👍 to vote)`,
					fetchReply: true,
				} as any);
			}

			if (voteMsg && typeof (voteMsg as any).react === 'function') {
				await (voteMsg as any).react('👍');
        linkVoteMessage(voteMsg.id, issue.number);
			}

			await upsertDiscordVoteComment(issue.number, 0);

			// 2) Post CREATED notice INSIDE the THREAD
			if (thread && (thread as any).isTextBased?.()) {
				await (thread as any).send(`✅ Created idea **#${issue.number}** - ${issue.title}`);
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
	}

	// ----- MODAL SUBMIT (answers) -----
	if (i.isModalSubmit()) {
		const [ns, action, id] = i.customId.split(':');
		if (ns !== 'idea' || action !== 'answers') return;

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
			content: 'Thanks! Here’s the refined draft. Approve to post.',
			embeds: [embed],
			components: [row],
		});
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
// Start the bot
// ======================
client.login(process.env.DISCORD_TOKEN);
