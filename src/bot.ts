// src/bot.ts
import 'dotenv/config';
import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonInteraction,
	ButtonStyle,
	Client,
	EmbedBuilder,
	Events,
	GatewayIntentBits,
	GuildMember,
	Interaction,
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
import { getPending, putPending, delPending, setOnExpire, type PendingIdea } from './pending.js';
import { findCodePointers } from './aiCodeContext.js';
import { sendResearchNotice, renameThread } from './researchNotice.js';
import { findPossibleDuplicates, renderDuplicatesBlock, renderRelatedIssuesSection } from './dupeCheck.js';
import { testConnectionOnStartup } from './repowiseMcp.js';
import type { CodeContext } from './codeContextTypes.js';
import { getIssueFromVoteMessage, linkVoteMessage } from './votes.js';
// ---- GitHub helpers (issue + vote sync) ----
import { createIdeaIssue, createBugIssue, createFeatureIssue, createFeedbackIssue, upsertDiscordVoteComment, readDiscordVoteCount, listTopIdeas, extractSummaryFromIssueBody, fetchIssue, listClosedTrackedIssues, repoHasAnnouncedLabel, ensureAnnouncedLabel, markIssueAnnounced } from './github.js';
import { isAnnounceable, parseDiscordId, renderShippedMessage } from './shipped.js';
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

// ======================
// "Shipped" announcer — notify submitters when their issue closes as completed.
// Polls GitHub (no webhook/web server); state lives in the `announced` label so
// it survives restarts. See docs/plans/2026-06-20-shipped-announcements-design.md
// ======================

function buildShippedEmbed(issueTitle: string, issueNumber: number, memberId: string) {
	const msg = renderShippedMessage({ issueTitle, issueNumber, memberId });
	return new EmbedBuilder()
		.setTitle(msg.title)
		.setDescription(msg.description)
		.setColor(0x00e5cc)
		.setFooter({ text: 'Voran Defense Systems' });
}

// On first run (no `announced` label yet), stamp the existing closed-issue
// backlog as announced WITHOUT messaging anyone, so we never spam old submitters.
async function seedAnnouncedBacklogIfFirstRun() {
	if (await repoHasAnnouncedLabel()) {
		log.debug('[SHIPPED] `announced` label already exists — skipping backlog seed');
		return;
	}
	log.info('[SHIPPED] First run detected — seeding existing closed issues as announced (no messages sent)');
	await ensureAnnouncedLabel(); // create the label even if the backlog is empty
	const backlog = (await listClosedTrackedIssues()).filter(isAnnounceable);
	for (const issue of backlog) {
		try {
			await markIssueAnnounced(issue.number);
		} catch (e) {
			log.warn(`[SHIPPED] Seed: failed to label #${issue.number}:`, e);
		}
	}
	log.info(`[SHIPPED] Seed complete — ${backlog.length} backlog issue(s) marked announced`);
}

async function announceShippedIssue(issue: { number: number; title: string; html_url: string; body: string | null }) {
	const memberId = parseDiscordId(issue.body);
	if (!memberId) return; // no submitter to notify (isAnnounceable already guards this)

	const embed = buildShippedEmbed(issue.title, issue.number, memberId);
	let notified = false;

	// 1. Public channel post
	const channelId = process.env.ANNOUNCE_CHANNEL_ID;
	if (channelId) {
		try {
			const channel = await client.channels.fetch(channelId);
			if (channel && channel.isTextBased()) {
				await (channel as any).send({ content: `<@${memberId}>`, embeds: [embed] });
				notified = true;
				log.info(`[SHIPPED] Announced #${issue.number} in channel for <@${memberId}>`);
			} else {
				log.warn(`[SHIPPED] ANNOUNCE_CHANNEL_ID ${channelId} is missing or not text-based`);
			}
		} catch (e) {
			log.error(`[SHIPPED] Failed to post #${issue.number} to announce channel:`, e);
		}
	} else {
		log.warn('[SHIPPED] ANNOUNCE_CHANNEL_ID not set — falling back to DM only');
	}

	// 2. DM the submitter (non-fatal if DMs are disabled, like the join flow)
	try {
		const user = await client.users.fetch(memberId);
		await user.send({ embeds: [embed] });
		notified = true;
		log.info(`[SHIPPED] DM sent for #${issue.number} to ${memberId}`);
	} catch (e) {
		log.warn(`[SHIPPED] Could not DM ${memberId} for #${issue.number} (likely DMs disabled):`, e);
	}

	// 3. Only mark announced once the submitter was reached somehow, so a total
	//    failure retries next poll instead of being silently swallowed.
	if (notified) {
		try {
			await markIssueAnnounced(issue.number);
		} catch (e) {
			log.error(`[SHIPPED] Failed to mark #${issue.number} announced (may re-announce next poll):`, e);
		}
	}
}

async function pollShippedOnce() {
	const announceable = (await listClosedTrackedIssues()).filter(isAnnounceable);
	if (announceable.length) {
		log.info(`[SHIPPED] ${announceable.length} newly completed issue(s) to announce`);
	}
	for (const issue of announceable) {
		await announceShippedIssue(issue);
	}
}

async function startShippedAnnouncer() {
	try {
		await seedAnnouncedBacklogIfFirstRun();
		await pollShippedOnce(); // run once at startup
	} catch (e) {
		log.error('[SHIPPED] Startup seed/poll failed:', e);
	}
	const minutes = Number(process.env.SHIPPED_POLL_MINUTES) || 10;
	setInterval(() => {
		pollShippedOnce().catch((e) => log.error('[SHIPPED] Poll cycle failed:', e));
	}, minutes * 60_000);
	log.info(`[SHIPPED] Announcer running — polling every ${minutes} min`);
}

client.once(Events.ClientReady, (c) => {
	console.log(`🤖 Logged in as ${c.user.tag}`);
	// Register the expiry handler before startApi so a startup failure there can
	// never leave the sweep silently dropping drafts without auto-filing them.
	setOnExpire(async (draft: PendingIdea) => {
		// Auto-file drafts that reached a usable state. Both phases qualify per spec.
		// Only issue creation can throw (Discord side effects are best-effort inside
		// the helpers), so one retry covers a transient GitHub failure; after that,
		// tell the user their draft was lost instead of failing silently.
		const post = () => {
			switch (draft.type) {
				case 'bug':
					return postBugFromPending(draft, true);
				case 'feature':
					return postSimpleFromPending(draft, true, createFeatureIssue, 'feature request');
				case 'feedback':
					return postSimpleFromPending(draft, true, createFeedbackIssue, 'feedback');
				default:
					return postIdeaFromPending(draft, true);
			}
		};
		try {
			await post();
		} catch (err) {
			log.warn(`[expiry] auto-file failed for ${draft.id}, retrying once:`, err);
			try {
				await post();
			} catch (err2) {
				log.error(`[expiry] auto-file retry failed for ${draft.id}, draft dropped:`, err2);
				await notifyDraftThread(draft, '⚠️ This draft expired and auto-filing it to GitHub failed. Please re-submit it.');
			}
		}
	});
	startApi(client);
	// Diagnostic only — never blocks startup; logs CF Access / MCP connectivity.
	testConnectionOnStartup().catch((err) => console.error('[repowise] startup test crashed:', err));
	// Start the "shipped" announcer (seed backlog on first run, then poll).
	startShippedAnnouncer().catch((err) => log.error('[SHIPPED] Failed to start announcer:', err));
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

// =====================================================================
// !feature / !feedback — idea-like flows that reuse the idea AI
// enrichment (enrichIdea/toIssueBody) but file to GitHub WITHOUT a vote
// embed/reaction sync. They differ only by GitHub label, title/thread
// prefix, and embed color, so one config + one handler drives both.
// =====================================================================
type SimpleFlowKey = 'feature' | 'feedback';
const SIMPLE_FLOWS: Record<SimpleFlowKey, {
	prefix: string; // title + thread tag, e.g. "FEATURE"
	noun: string; // human label used in thread notices
	color: number; // embed color
	create: (p: { title: string; body: string }) => Promise<any>;
}> = {
	feature: { prefix: 'FEATURE', noun: 'feature request', color: 0x5865f2, create: createFeatureIssue },
	feedback: { prefix: 'FEEDBACK', noun: 'feedback', color: 0xfaa61a, create: createFeedbackIssue },
};

// Thread starter for the simple flows (mirrors getOrStartIdeaThread but with a
// configurable tag). Reuses the message's existing thread when there is one.
async function getOrStartFlowThread(message: Message, prefix: string, title: string) {
	if (message.channel.isThread()) return message.channel;
	const name = `[${prefix}] ${title}`.slice(0, 95);
	return message.startThread({ name, autoArchiveDuration: 1440 });
}

// Build the AI-enriched approval embed shared by the first-pass (no questions)
// and post-answers paths. enriched is the idea-shaped JSON from enrichIdea.
function buildSimpleApprovalEmbed(enriched: any, flow: { noun: string; color: number }): EmbedBuilder {
	const previewImpl =
		Array.isArray(enriched.implementationNotes) && enriched.implementationNotes.length
			? enriched.implementationNotes.map((d: string) => `• ${d}`).join('\n')
			: '• (to be refined)';
	const previewTagLine =
		Array.isArray(enriched.tags) && enriched.tags.length ? `\n**Tags**\n${enriched.tags.map((t: string) => `\`${t}\``).join(' ')}` : '';
	return new EmbedBuilder()
		.setTitle(enriched.title || flow.noun)
		.setDescription(
			[
				`**Summary**\n${enriched.summary || '(missing)'}`,
				`\n**Gameplay Impact**\n${enriched.gameplayImpact || '(unspecified)'}`,
				`\n**Key Implementation Notes**\n${previewImpl}`,
				previewTagLine,
			].join('\n')
		)
		.setColor(flow.color);
}

// Handle a !feature/!feedback submission: enrich, then either ask the open
// questions (Answer/Skip) or jump straight to the approval card — all inside a
// thread, exactly like !idea but using the flow's prefix/color/namespace.
async function handleSimpleFlowSubmission(message: Message, rawText: string, flowKey: SimpleFlowKey) {
	const flow = SIMPLE_FLOWS[flowKey];
	const submitterTag = `${message.author.username}#${message.author.discriminator}`;
	// Open the thread + post a "researching" notice BEFORE the slow work so the
	// player gets an immediate acknowledgement. Rename to the AI title afterward.
	const inThread = message.channel.isThread();
	const thread = await getOrStartFlowThread(message, flow.prefix, rawText.slice(0, 80));
	await sendResearchNotice(thread, message.author.id);

	const codeContext = await findCodePointers(rawText, 'idea');
	const enriched = await enrichIdea(rawText, submitterTag, { codeContext });
	const id = crypto.randomUUID();
	const titleText = (enriched.title || rawText).slice(0, 80);
	if (!inThread) await renameThread(thread, `[${flow.prefix}] ${titleText}`);

	// Questions exist → ask to Answer or Skip (inside a thread)
	if (enriched.openQuestions?.length) {
		const questionsList = enriched.openQuestions
			.slice(0, 5)
			.map((q, i) => `**Q${i + 1}.** ${q}`)
			.join('\n');

		const qEmbed = new EmbedBuilder()
			.setTitle(enriched.title || flow.noun)
			.setDescription(`**Draft Summary**\n${enriched.summary}\n\n**Open Questions**\n${questionsList}`)
			.setColor(flow.color);

		const qRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
			new ButtonBuilder().setCustomId(`${flowKey}:answer:${id}`).setLabel('Answer questions').setStyle(ButtonStyle.Primary),
			new ButtonBuilder().setCustomId(`${flowKey}:skip:${id}`).setLabel('Skip to approval').setStyle(ButtonStyle.Secondary)
		);

		const promptMsg = await thread.send({
			content: `<@${message.author.id}> I have a few quick questions before finalizing. Answer now or skip:`,
			embeds: [qEmbed],
			components: [qRow],
		});

		putPending({
			type: flowKey,
			id,
			authorId: message.author.id,
			rawText,
			title: `[${flow.prefix}] ${titleText}`,
			body: toIssueBody(enriched, submitterTag, message.author.id, rawText, { codeContext }),
			codeContext,
			createdAt: Date.now(),
			openQuestions: enriched.openQuestions.slice(0, 5),
			phase: 'awaiting_answers',
			...({ enriched } as any),
			...({ sourceMessageId: promptMsg.id, sourceChannelId: thread.id, threadId: thread.id, parentChannelId: message.channelId } as any),
		});

		return;
	}

	// No questions → straight to approval (in the thread opened above)
	putPending({
		type: flowKey,
		id,
		authorId: message.author.id,
		rawText,
		title: `[${flow.prefix}] ${titleText}`,
		body: toIssueBody(enriched, submitterTag, message.author.id, rawText, { codeContext }),
		codeContext,
		createdAt: Date.now(),
		phase: 'awaiting_approval',
		...({ enriched } as any),
		...({ sourceChannelId: thread.id, threadId: thread.id, parentChannelId: message.channelId } as any),
	});

	const previewRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder().setCustomId(`${flowKey}:approve:${id}`).setLabel('Approve & Post').setStyle(ButtonStyle.Success),
		new ButtonBuilder().setCustomId(`${flowKey}:cancel:${id}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
	);

	await thread.send({
		content: "Here's the AI-enriched draft. Approve to post.",
		embeds: [buildSimpleApprovalEmbed(enriched, flow)],
		components: [previewRow],
	});
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
			// Open the thread + post a "researching" notice BEFORE the slow work, so
			// the player gets an immediate acknowledgement (code search + enrichment
			// can take 20-40s on a reasoning model). Rename to the AI title afterward.
			const inThread = message.channel.isThread();
			const thread = await getOrStartIdeaThread(message, rawText.slice(0, 80));
			await sendResearchNotice(thread, message.author.id);

			// 1) First pass enrichment
			const codeContext = await findCodePointers(rawText, 'idea');
			const enriched = await enrichIdea(rawText, submitterTag, { codeContext });
			if (!inThread) await renameThread(thread, `[IDEA] ${(enriched.title || rawText).slice(0, 80)}`);
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

				// Post the prompt INSIDE the thread opened above
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
					body: toIssueBody(enriched, submitterTag, message.author.id, rawText, { codeContext }),
					codeContext,
					createdAt: Date.now(),
					openQuestions: enriched.openQuestions.slice(0, 5),
					phase: 'awaiting_answers',
					...({ enriched } as any),
					...({ sourceMessageId: promptMsg.id, sourceChannelId: thread.id, threadId: thread.id, parentChannelId: message.channelId } as any),
				});

				return; // stop here; later steps continue in the thread
			}

			// 3) No questions → go straight to approval (in the thread opened above)
			putPending({
				type: 'idea',
				id,
				authorId: message.author.id,
				rawText,
				title: `[IDEA] ${(enriched.title || rawText).slice(0, 80)}`,
				body: toIssueBody(enriched, submitterTag, message.author.id, rawText, { codeContext }),
				codeContext,
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
				content: "Here's the AI-enriched draft. Approve to post.",
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
			// Open the thread + post a "researching" notice BEFORE the slow work so
			// the player gets an immediate acknowledgement. Rename to the AI title
			// afterward (only for threads we created, not a channel we're already in).
			const inThread = message.channel.isThread();
			const thread = inThread
				? message.channel
				: await message.startThread({
						name: `[BUG] ${rawText.slice(0, 80)}`.slice(0, 95),
						autoArchiveDuration: 1440,
				  });
			await sendResearchNotice(thread, message.author.id);

			const codeContext = await findCodePointers(rawText, 'bug');
			const [enriched, dupes] = await Promise.all([
				enrichBug(rawText, submitterTag, { codeContext }),
				findPossibleDuplicates(rawText, 'bug'),
			]);
			const dupeBlock = renderDuplicatesBlock(dupes);
			const id = crypto.randomUUID();
			if (!inThread) await renameThread(thread, `[BUG] ${(enriched.title || rawText).slice(0, 80)}`);

			if (enriched.openQuestions?.length) {
				const questionsList = enriched.openQuestions
					.slice(0, 3)
					.map((q, i) => `**Q${i + 1}.** ${q}`)
					.join('\n');

				const qEmbed = new EmbedBuilder()
					.setTitle(enriched.title || 'Bug Report')
					.setDescription(`**Draft Summary**\n${enriched.summary}\n\n**Clarifying Questions**\n${questionsList}${dupeBlock}`)
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
					body: toBugIssueBody(enriched, submitterTag, message.author.id, { raw: rawText, codeContext }),
					codeContext,
					createdAt: Date.now(),
					openQuestions: enriched.openQuestions.slice(0, 3),
					phase: 'awaiting_answers',
					...({ enriched, relatedIssues: dupes } as any),
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
				body: toBugIssueBody(enriched, submitterTag, message.author.id, { raw: rawText, codeContext }),
				codeContext,
				createdAt: Date.now(),
				phase: 'awaiting_approval',
				...({ enriched, relatedIssues: dupes } as any),
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
					].join('\n') + dupeBlock
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

		// -------- !feature / !feedback (idea-like enrichment, no voting) --------
		if (command === 'feature' || command === 'feedback') {
			if (!message.guild) return message.reply('❌ Use this in a server channel.');

			const rawText = args.join(' ').trim();
			if (!rawText) return message.reply(`❗ Usage: \`!${command} <your ${SIMPLE_FLOWS[command].noun}>\``);

			await handleSimpleFlowSubmission(message, rawText, command);
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
	// Without this catch, a rejection (GitHub/OpenAI outage mid-flow) becomes an
	// unhandled promise rejection — fatal on Node 18 defaults — and the user is
	// left staring at a stripped-button "Posting..." message.
	try {
		await handleComponentInteraction(i);
	} catch (e: any) {
		log.error('[INTERACTION] Component handler failed:', e);
		if (i.isRepliable()) {
			const msg = { content: `❌ Something went wrong: ${e?.message || String(e)}`, ephemeral: true };
			if (i.deferred || i.replied) await i.followUp(msg).catch(() => {});
			else await i.reply(msg).catch(() => {});
		}
	}
});

// Discord caps text-input placeholders at 100 chars
function toPlaceholder(text: string): string {
	return text.length > 100 ? `${text.slice(0, 99)}…` : text;
}

async function handleComponentInteraction(i: Interaction) {
	// ----- BUTTONS -----
	if (i.isButton()) {
		const [ns, action, id] = i.customId.split(':');
		log.info(`[BUTTON] ${i.customId} clicked by ${i.user.tag} (${i.user.id})`);

		// ----- IDEA BUTTONS -----
		if (ns === 'idea') {
			log.debug(`[BUTTON] Processing idea button: action=${action}, id=${id}`);
		const pending = getPending(id);
		if (!pending) return i.reply({ content: '⌛ This draft is no longer pending — it expired (expired drafts are auto-filed to GitHub; check the thread) or was already posted.', ephemeral: true });
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
					.setPlaceholder(toPlaceholder(q)) // <= full question visible here
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

		if (action === 'approve') {
			// Claim the draft before any await so the expiry sweep can't file it concurrently.
			delPending(id);
			await clearOldPromptComponents(pending);
			await i.update({ content: 'Posting your idea...', components: [], embeds: [] });

			try {
				const issue = await postIdeaFromPending(pending, false, i);
				return i.followUp({ content: `Done. Idea #${issue.number} posted.`, ephemeral: true });
			} catch (err) {
				log.error('[BUTTON] idea approve failed:', err);
				// Hand the draft back with a fresh TTL so the user can retry (or expiry auto-files it).
				pending.createdAt = Date.now();
				putPending(pending);
				const retryRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
					new ButtonBuilder().setCustomId(`idea:approve:${id}`).setLabel('Approve & Post').setStyle(ButtonStyle.Success),
					new ButtonBuilder().setCustomId(`idea:cancel:${id}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
				);
				return i.editReply({ content: '⚠️ Posting to GitHub failed. Try again below.', components: [retryRow] }).catch(() => {});
			}
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
			if (!pending) return i.reply({ content: '⌛ This draft is no longer pending — it expired (expired drafts are auto-filed to GitHub; check the thread) or was already posted.', ephemeral: true });
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
						.setPlaceholder(toPlaceholder(q))
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
				// Claim the draft before any await so the expiry sweep can't file it concurrently.
				delPending(id);
				await clearOldPromptComponents(pending);
				await i.update({ content: 'Posting your bug report…', components: [], embeds: [] });

				try {
					const issue = await postBugFromPending(pending, false);
					return i.followUp({ content: `Done. Bug #${issue.number} posted.`, ephemeral: true });
				} catch (err) {
					log.error('[BUTTON] bug approve failed:', err);
					// Hand the draft back with a fresh TTL so the user can retry (or expiry auto-files it).
					pending.createdAt = Date.now();
					putPending(pending);
					const retryRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
						new ButtonBuilder().setCustomId(`bug:approve:${id}`).setLabel('Approve & Post').setStyle(ButtonStyle.Success),
						new ButtonBuilder().setCustomId(`bug:cancel:${id}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
					);
					return i.editReply({ content: '⚠️ Posting to GitHub failed. Try again below.', components: [retryRow] }).catch(() => {});
				}
			}

			// Cancel
			if (action === 'cancel') {
				await clearOldPromptComponents(pending);
				delPending(id);
				return i.update({ content: 'Bug report **canceled**.', components: [], embeds: [] });
			}
		}

			// ----- FEATURE / FEEDBACK BUTTONS -----
			if (ns === 'feature' || ns === 'feedback') {
				const flow = SIMPLE_FLOWS[ns as SimpleFlowKey];
				const pending = getPending(id);
				if (!pending) return i.reply({ content: '⌛ This draft is no longer pending — it expired (expired drafts are auto-filed to GitHub; check the thread) or was already posted.', ephemeral: true });
				if (i.user.id !== pending.authorId) {
					return i.reply({ content: '⛔ Only the original submitter can continue this flow.', ephemeral: true });
				}

				// Show modal to answer questions
				if (action === 'answer') {
					const qs = (pending as any).openQuestions || [];
					if (!qs.length) return i.reply({ content: 'No questions to answer.', ephemeral: true });

					const modal = new ModalBuilder().setCustomId(`${ns}:answers:${id}`).setTitle('Answer questions (you can skip any)');

					qs.slice(0, 5).forEach((q: string, idx: number) => {
						const input = new TextInputBuilder()
							.setCustomId(`q${idx + 1}`)
							.setLabel(`Q${idx + 1}`)
							.setStyle(TextInputStyle.Paragraph)
							.setRequired(false)
							.setPlaceholder(toPlaceholder(q))
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
						.setTitle((pending as any).title.replace(new RegExp(`^\\[${flow.prefix}\\]\\s*`), ''))
						.setDescription('You chose to skip questions. Approve to post.')
						.setColor(flow.color);

					const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
						new ButtonBuilder().setCustomId(`${ns}:approve:${id}`).setLabel('Approve & Post').setStyle(ButtonStyle.Success),
						new ButtonBuilder().setCustomId(`${ns}:cancel:${id}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
					);

					return i.update({ content: 'Review the draft below.', embeds: [embed], components: [row] });
				}

				if (action === 'approve') {
					// Claim the draft before any await so the expiry sweep can't file it concurrently.
					delPending(id);
					await clearOldPromptComponents(pending);
					await i.update({ content: `Posting your ${flow.noun}...`, components: [], embeds: [] });

					try {
						const issue = await postSimpleFromPending(pending, false, flow.create, flow.noun);
						return i.followUp({ content: `Done. ${flow.noun} #${issue.number} posted.`, ephemeral: true });
					} catch (err) {
						log.error(`[BUTTON] ${ns} approve failed:`, err);
						// Hand the draft back with a fresh TTL so the user can retry (or expiry auto-files it).
						pending.createdAt = Date.now();
						putPending(pending);
						const retryRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
							new ButtonBuilder().setCustomId(`${ns}:approve:${id}`).setLabel('Approve & Post').setStyle(ButtonStyle.Success),
							new ButtonBuilder().setCustomId(`${ns}:cancel:${id}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
						);
						return i.editReply({ content: '⚠️ Posting to GitHub failed. Try again below.', components: [retryRow] }).catch(() => {});
					}
				}

				// Cancel
				if (action === 'cancel') {
					await clearOldPromptComponents(pending);
					delPending(id);
					return i.update({ content: 'Draft **canceled**.', components: [], embeds: [] });
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
					return i.reply({ content: '⌛ This draft expired before you submitted — it was auto-filed to GitHub with the info we had. Check the thread for the link.', ephemeral: true });
				}
				return i.followUp({ content: '⌛ This draft expired before you submitted — it was auto-filed to GitHub with the info we had. Check the thread for the link.', ephemeral: true });
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
			const codeContext = ((pending as any).codeContext as CodeContext | null) || null;
			const enriched2 = await enrichIdea((pending as any).rawText, submitterTag, { answersText, previous, codeContext });

			// The sweep may have claimed and auto-filed this draft while we were
			// re-enriching; re-inserting it would resurrect a stale, already-filed copy.
			if (getPending(id) !== pending) {
				return i.editReply({
					content: '⌛ This draft expired while you were answering and was auto-filed to GitHub — check the thread for the issue link.',
					embeds: [],
					components: [],
				});
			}

			const finalTitle = `[IDEA] ${(enriched2.title || (pending as any).rawText).slice(0, 80)}`;
			const finalBody = toIssueBody(enriched2, submitterTag, i.user.id, (pending as any).rawText, { qa: answersText, codeContext });

			(pending as any).title = finalTitle;
			(pending as any).body = finalBody;
			(pending as any).phase = 'awaiting_approval';
			(pending as any).enriched = enriched2; // keep latest structured JSON
			pending.answersText = answersText; // answered — suppresses the expiry "unanswered" appendix
			pending.openQuestions = [];
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
					return i.reply({ content: '⌛ This draft expired before you submitted — it was auto-filed to GitHub with the info we had. Check the thread for the link.', ephemeral: true });
				}
				return i.followUp({ content: '⌛ This draft expired before you submitted — it was auto-filed to GitHub with the info we had. Check the thread for the link.', ephemeral: true });
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
			const codeContext = ((pending as any).codeContext as CodeContext | null) || null;
			const enriched2 = await enrichBug((pending as any).rawText, submitterTag, { answersText, previous, codeContext });

			// The sweep may have claimed and auto-filed this draft while we were
			// re-enriching; re-inserting it would resurrect a stale, already-filed copy.
			if (getPending(id) !== pending) {
				return i.editReply({
					content: '⌛ This draft expired while you were answering and was auto-filed to GitHub — check the thread for the issue link.',
					embeds: [],
					components: [],
				});
			}

			const finalTitle = `[BUG] ${(enriched2.title || (pending as any).rawText).slice(0, 80)}`;
			const finalBody = toBugIssueBody(enriched2, submitterTag, i.user.id, { raw: (pending as any).rawText, qa: answersText, codeContext });

			(pending as any).title = finalTitle;
			(pending as any).body = finalBody;
			(pending as any).phase = 'awaiting_approval';
			(pending as any).enriched = enriched2;
			pending.answersText = answersText; // answered — suppresses the expiry "unanswered" appendix
			pending.openQuestions = [];
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

		// ----- FEATURE / FEEDBACK MODAL SUBMIT -----
		if ((ns === 'feature' || ns === 'feedback') && action === 'answers') {
			const flow = SIMPLE_FLOWS[ns as SimpleFlowKey];
			const pending = getPending(id);
			if (!pending) {
				if (!i.replied && !i.deferred) {
					return i.reply({ content: '⌛ This draft expired before you submitted — it was auto-filed to GitHub with the info we had. Check the thread for the link.', ephemeral: true });
				}
				return i.followUp({ content: '⌛ This draft expired before you submitted — it was auto-filed to GitHub with the info we had. Check the thread for the link.', ephemeral: true });
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
			const codeContext = ((pending as any).codeContext as CodeContext | null) || null;
			const enriched2 = await enrichIdea((pending as any).rawText, submitterTag, { answersText, previous, codeContext });

			// The sweep may have claimed and auto-filed this draft while we were
			// re-enriching; re-inserting it would resurrect a stale, already-filed copy.
			if (getPending(id) !== pending) {
				return i.editReply({
					content: '⌛ This draft expired while you were answering and was auto-filed to GitHub — check the thread for the issue link.',
					embeds: [],
					components: [],
				});
			}

			const finalTitle = `[${flow.prefix}] ${(enriched2.title || (pending as any).rawText).slice(0, 80)}`;
			const finalBody = toIssueBody(enriched2, submitterTag, i.user.id, (pending as any).rawText, { qa: answersText, codeContext });

			(pending as any).title = finalTitle;
			(pending as any).body = finalBody;
			(pending as any).phase = 'awaiting_approval';
			(pending as any).enriched = enriched2; // keep latest structured JSON
			pending.answersText = answersText; // answered — suppresses the expiry "unanswered" appendix
			pending.openQuestions = [];
			putPending(pending);

			const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
				new ButtonBuilder().setCustomId(`${ns}:approve:${id}`).setLabel('Approve & Post').setStyle(ButtonStyle.Success),
				new ButtonBuilder().setCustomId(`${ns}:cancel:${id}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
			);

			await clearOldPromptComponents(pending);

			// ✅ Finish the deferred response
			await i.editReply({
				content: "Thanks! Here's the refined draft. Approve to post.",
				embeds: [buildSimpleApprovalEmbed(enriched2, flow)],
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
}

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
// Build an “Open Questions (unanswered)” appendix from a draft still carrying questions.
function unansweredAppendix(pending: any): string {
	const qs: string[] = (pending?.openQuestions as string[]) || [];
	// If the draft was answered, answersText exists and we skip the appendix.
	if (pending?.answersText || !qs.length) return '';
	const lines = qs.map((q) => `- ${q}`).join('\n');
	return `\n\n## Open Questions (unanswered)\n${lines}`;
}

// Create the GitHub issue exactly once per draft. The approve-retry and
// expiry-retry paths re-run the whole post helper, so a previously created
// issue is reused instead of duplicated.
async function fileIssueOnce(pending: any, auto: boolean, create: (p: { title: string; body: string }) => Promise<any>) {
	if (pending._postedIssue) return pending._postedIssue;
	const body = (pending.body as string) + renderRelatedIssuesSection(pending.relatedIssues) + (auto ? unansweredAppendix(pending) : '');
	const issue = await create({ title: pending.title, body });
	pending._postedIssue = issue;
	return issue;
}

async function resolveDraftThread(pending: any) {
	const threadId = pending.threadId || pending.sourceChannelId;
	return threadId ? await client.channels.fetch(threadId as string).catch(() => null) : null;
}

async function sendThreadNotice(thread: any, text: string) {
	if (thread && thread.isTextBased?.()) {
		await thread.send(text).catch((err: unknown) => console.warn('thread notice failed:', err));
	}
}

async function notifyDraftThread(pending: any, text: string) {
	await sendThreadNotice(await resolveDraftThread(pending), text);
}

// File an idea issue from a pending draft. Posts the vote embed + reaction sync,
// and a thread notice. `auto` toggles wording for the TTL-expiry path; `interaction`
// (approve path only) is the last-resort destination for the vote embed.
// Everything after issue creation is best-effort: a throw there would make the
// retry paths re-post embeds/notices for an issue that already exists.
async function postIdeaFromPending(pending: any, auto: boolean, interaction?: ButtonInteraction) {
	const issue = await fileIssueOnce(pending, auto, createIdeaIssue);

	const summary = extractSummaryFromIssueBody(issue.body || '');
	const desc = summary
		? `**Summary**\n${summary}\n\nReact with 👍 to vote.`
		: `**Summary**\n_(no summary found in issue body)_\n\nReact with 👍 to vote.`;

	const thread = await resolveDraftThread(pending);

	let parentChannel: any = null;
	try {
		if (thread && (thread as any).isThread?.()) {
			const parentId = (thread as any).parentId;
			if (parentId) parentChannel = await client.channels.fetch(parentId);
		}
		if (!parentChannel && pending.parentChannelId) {
			parentChannel = await client.channels.fetch(pending.parentChannelId as string);
		}
	} catch {}

	const voteEmbed = new EmbedBuilder()
		.setTitle(`Idea #${issue.number}: ${issue.title}`)
		.setURL(issue.html_url)
		.setDescription(desc)
		.setColor(0x00ae86);

	let voteMsg: Message | null = null;
	try {
		if (parentChannel && (parentChannel as any).isTextBased?.()) {
			voteMsg = await (parentChannel as any).send({ embeds: [voteEmbed] });
		} else if (thread && (thread as any).isTextBased?.()) {
			voteMsg = await (thread as any).send({ embeds: [voteEmbed] });
		} else if (interaction) {
			voteMsg = (await interaction.followUp({ embeds: [voteEmbed] })) as Message;
		}
	} catch (err) {
		console.warn('postIdeaFromPending: vote embed post failed:', err);
	}
	if (voteMsg) {
		// Link before seeding the reaction so vote syncing works even if react fails.
		linkVoteMessage(voteMsg.id, issue.number);
		await (voteMsg as any).react?.('👍')?.catch?.((err: unknown) => console.warn('vote seed react failed:', err));
	}
	await upsertDiscordVoteComment(issue.number, 0).catch((err: unknown) => console.warn('vote comment init failed:', err));

	await sendThreadNotice(
		thread,
		auto
			? `⏱️ Draft timed out — filed idea **#${issue.number}** with the info we had. ${issue.html_url}`
			: `✅ Created idea **#${issue.number}** - ${issue.title}`
	);
	return issue;
}

// File a bug issue from a pending draft + thread notice.
async function postBugFromPending(pending: any, auto: boolean) {
	const issue = await fileIssueOnce(pending, auto, createBugIssue);
	const thread = await resolveDraftThread(pending);
	await sendThreadNotice(
		thread,
		auto
			? `⏱️ Draft timed out — filed bug **#${issue.number}** with the info we had. ${issue.html_url}`
			: `✅ Bug report posted to GitHub as issue **#${issue.number}**`
	);
	return issue;
}

// File a no-vote issue (feature/feedback) from a pending draft + thread notice.
// Same shape as postBugFromPending; `create` and `noun` come from SIMPLE_FLOWS.
async function postSimpleFromPending(
	pending: any,
	auto: boolean,
	create: (p: { title: string; body: string }) => Promise<any>,
	noun: string
) {
	const issue = await fileIssueOnce(pending, auto, create);
	const thread = await resolveDraftThread(pending);
	await sendThreadNotice(
		thread,
		auto
			? `⏱️ Draft timed out — filed ${noun} **#${issue.number}** with the info we had. ${issue.html_url}`
			: `✅ Created ${noun} **#${issue.number}** — ${issue.title}`
	);
	return issue;
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

// Voran-themed welcome messages. One is picked per join so the welcome
// channel doesn't feel repetitive. `{member}` is replaced with the new
// member's mention. See pickWelcomeMessage() for the selection logic.
const WELCOME_MESSAGES: ReadonlyArray<{ title: string; body: string }> = [
	{
		title: 'A New Commander Arrives',
		body: 'Welcome aboard, {member}. The stars beyond the horizon are uncharted — and you\'re now part of the fleet that will claim them. Link your callsign to take your place among the commanders.',
	},
	{
		title: 'The Frontier Welcomes You',
		body: '{member} has crossed into the sector. Out here, every commander earns their legend — and yours starts now. Link your enlistment designation to unlock full access.',
	},
	{
		title: 'Signal Received',
		body: 'A new transponder lights up the grid — welcome, {member}. The Voran fleet grows stronger with every commander who answers the call. Link your callsign to join the ranks.',
	},
	{
		title: 'Another Star Claimed',
		body: '{member} drops out of warp into friendly space. The horizon is vast, but you won\'t chart it alone. Verify your enlistment and take your place among the fleet.',
	},
	{
		title: 'Welcome to the Sector',
		body: 'The fleet logs a new arrival: {member}. Beyond the known systems, fortunes are won and empires are built. Link your callsign and begin your campaign.',
	},
	{
		title: 'New Arrival Confirmed',
		body: 'Greetings, {member}. You\'ve reached the staging grounds of the Voran fleet, where commanders gather before the next push into the dark. Verify your enlistment to gain full access.',
	},
	{
		title: 'Your Journey Begins',
		body: 'Welcome, {member}. Every great commander started with a single jump — and this is yours. Link your designation and claim your place beyond the horizon.',
	},
	{
		title: 'The Fleet Grows',
		body: '{member} joins the ranks. The frontier rewards the bold, and there\'s a place for you among the stars. Link your callsign to step into the fold.',
	},
];

// Index of the last welcome message used. Pure Math.random() repeats the same
// message ~1-in-8 of the time, so we remember the last pick and choose a
// different one each join. In-memory only: after a restart the worst case is a
// single repeat of the pre-restart message, which is negligible.
let lastWelcomeIndex = -1;

function pickWelcomeMessage(): { title: string; body: string } {
	if (WELCOME_MESSAGES.length <= 1) {
		return WELCOME_MESSAGES[0];
	}
	let index = Math.floor(Math.random() * WELCOME_MESSAGES.length);
	if (index === lastWelcomeIndex) {
		// Skip forward one slot (wrapping) so we never repeat the last message.
		index = (index + 1) % WELCOME_MESSAGES.length;
	}
	lastWelcomeIndex = index;
	return WELCOME_MESSAGES[index];
}

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

		// 6. Post welcome embed in welcome channel
		const welcomeChannelId = process.env.WELCOME_CHANNEL_ID;
		log.debug(`[MEMBER JOIN] WELCOME_CHANNEL_ID from env: ${welcomeChannelId}`);

		if (welcomeChannelId) {
			try {
				log.debug(`[MEMBER JOIN] Fetching welcome channel: ${welcomeChannelId}`);
				const welcomeChannel = await client.channels.fetch(welcomeChannelId);
				if (!welcomeChannel) {
					log.warn(`[MEMBER JOIN] ❌ Welcome channel not found: ${welcomeChannelId}`);
				} else if (!welcomeChannel.isTextBased()) {
					log.warn(`[MEMBER JOIN] ❌ Welcome channel is not text-based: ${welcomeChannelId}`);
				} else {
					const welcomeMsg = pickWelcomeMessage();
					log.debug(`[MEMBER JOIN] Creating welcome embed: "${welcomeMsg.title}"`);
					const welcomeEmbed = new EmbedBuilder()
						.setTitle(welcomeMsg.title)
						.setDescription(welcomeMsg.body.replace('{member}', `<@${member.user.id}>`))
						.setColor(0x00e5cc)
						.setFooter({ text: 'Voran Defense Systems' });

					log.debug(`[MEMBER JOIN] Sending message to welcome channel`);
					await (welcomeChannel as any).send({
						content: `<@${member.user.id}>`,
						embeds: [welcomeEmbed],
						components: [buildVerifyButton()],
					});
					log.info(`[MEMBER JOIN] ✅ Welcome message sent to welcome channel for ${member.user.tag}`);
				}
			} catch (welcomeError) {
				log.error(`[MEMBER JOIN] ❌ Failed to post to welcome channel (${welcomeChannelId}):`, welcomeError);
			}
		} else {
			log.warn(`[MEMBER JOIN] ⚠️ WELCOME_CHANNEL_ID not set in environment`);
		}
	} catch (error) {
		log.error(`[MEMBER JOIN] ❌ Unexpected error in guildMemberAdd handler:`, error);
	}
});

// ======================
// Start the bot
// ======================
client.login(process.env.DISCORD_TOKEN);
