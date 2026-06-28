import {
	SlashCommandBuilder,
	ChatInputCommandInteraction,
	PermissionFlagsBits,
	ChannelType,
	AttachmentBuilder,
	type TextBasedChannel,
	type GuildTextBasedChannel,
	type Message,
} from "discord.js";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// Channel types we allow exporting from — guild text-based channels only.
// (DMs are deliberately excluded; we never export private messages.)
const ALLOWED_CHANNEL_TYPES = [
	ChannelType.GuildText,
	ChannelType.GuildAnnouncement,
	ChannelType.PublicThread,
	ChannelType.PrivateThread,
	ChannelType.AnnouncementThread,
] as const;

const DEFAULT_DAYS = 2;
const MAX_DAYS = 14;
const FETCH_BATCH = 100; // Discord's hard cap per messages.fetch call.
// Safety backstop so a pathological loop can never run forever. 14 days of a
// very busy channel is realistically well under this.
const MAX_MESSAGES = 50_000;
// Conservative Discord upload ceiling for non-boosted guilds. We pre-check
// against this and also catch the API error (40005) as a backstop.
const UPLOAD_LIMIT_BYTES = 25 * 1024 * 1024;

export const data = new SlashCommandBuilder()
	.setName("export-chat")
	.setDescription("Export recent messages from a channel for feedback/bug/feature review")
	.addChannelOption(o =>
		o.setName("channel")
			.setDescription("Text channel to export")
			.addChannelTypes(...ALLOWED_CHANNEL_TYPES)
			.setRequired(true),
	)
	.addIntegerOption(o =>
		o.setName("days")
			.setDescription(`Days back to export (default ${DEFAULT_DAYS}, max ${MAX_DAYS})`)
			.setMinValue(1)
			.setMaxValue(MAX_DAYS),
	)
	.addStringOption(o =>
		o.setName("format")
			.setDescription("Output format (default json)")
			.addChoices(
				{ name: "json", value: "json" },
				{ name: "txt", value: "txt" },
			),
	)
	// Restrict to Manage Server; Administrators always satisfy this gate too.
	.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

type ExportedAttachment = {
	filename: string;
	url: string;
	contentType: string | null;
	size: number;
};

type ExportedEmbed = {
	title: string | null;
	description: string | null;
	url: string | null;
};

type ExportedMessage = {
	messageId: string;
	channelId: string;
	channelName: string;
	authorId: string;
	authorUsername: string;
	authorDisplayName: string | null;
	createdAt: string;
	content: string;
	attachments: ExportedAttachment[];
	embeds: ExportedEmbed[];
	replyTo: string | null;
};

export async function execute(interaction: ChatInputCommandInteraction) {
	// Ephemeral so the export (which may contain member chatter) is only ever
	// shown to the requesting moderator, never posted publicly.
	await interaction.deferReply({ ephemeral: true });

	// --- Guard: guild-only (never export DMs) ---
	if (!interaction.inGuild()) {
		return interaction.editReply("This command can only be used inside a server.");
	}

	const channel = interaction.options.getChannel("channel", true);
	const days = interaction.options.getInteger("days") ?? DEFAULT_DAYS;
	const format = (interaction.options.getString("format") ?? "json") as "json" | "txt";

	// --- Guard: valid channel type ---
	// addChannelTypes restricts the picker, but validate at runtime too in case
	// the channel resolves to something unexpected.
	if (!channel || !ALLOWED_CHANNEL_TYPES.includes(channel.type as any)) {
		return interaction.editReply("Please choose a text-based channel in this server.");
	}

	// Resolve to a live channel object with a message manager.
	const resolved = await interaction.client.channels.fetch(channel.id).catch(() => null);
	if (!resolved || !resolved.isTextBased() || resolved.isDMBased()) {
		return interaction.editReply("That channel could not be resolved as a server text channel.");
	}
	const textChannel = resolved as GuildTextBasedChannel;

	// --- Guard: the BOT's permissions in the target channel ---
	// We do not bypass Discord permissions — confirm the bot can actually see
	// and read the channel, and attach the resulting file.
	const me = interaction.guild?.members.me ?? null;
	const perms = me ? textChannel.permissionsFor(me) : null;
	const required = [
		{ flag: PermissionFlagsBits.ViewChannel, label: "View Channel" },
		{ flag: PermissionFlagsBits.ReadMessageHistory, label: "Read Message History" },
		{ flag: PermissionFlagsBits.AttachFiles, label: "Attach Files" },
	];
	const missing = required.filter(r => !perms?.has(r.flag)).map(r => r.label);
	if (missing.length) {
		return interaction.editReply(
			`I'm missing required permission(s) in ${channelMention(textChannel.id)}: **${missing.join(", ")}**.`,
		);
	}

	// Cutoff: anything created before this instant is out of range.
	const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

	let collected: ExportedMessage[];
	try {
		collected = await fetchMessagesSince(textChannel, cutoff);
	} catch (err: any) {
		// Discord rate limits surface as HTTP 429. discord.js retries internally,
		// but if one bubbles up we report it cleanly rather than crashing.
		if (err?.status === 429 || err?.code === 429) {
			return interaction.editReply("Discord is rate-limiting this export right now. Please try again in a minute.");
		}
		console.error("[export-chat] fetch failed:", err?.message ?? err);
		return interaction.editReply("Failed to read message history from that channel.");
	}

	// --- Guard: nothing to export ---
	if (collected.length === 0) {
		return interaction.editReply(
			`No messages found in ${channelMention(textChannel.id)} within the last **${days}** day(s).`,
		);
	}

	// Build the file contents in the requested format.
	const channelName = "name" in textChannel && textChannel.name ? textChannel.name : textChannel.id;
	const fileBody =
		format === "json"
			? JSON.stringify(collected, null, 2)
			: renderTranscript(collected, channelName, days);

	// Write to a temp file, attach it, then always clean it up.
	const safeName = channelName.replace(/[^a-z0-9-_]/gi, "_").slice(0, 40) || "channel";
	const fileName = `export-${safeName}-${days}d.${format}`;
	const tmpPath = path.join(os.tmpdir(), `bhb-${fileName}`);

	let wrote = false;
	try {
		await fs.writeFile(tmpPath, fileBody, "utf8");
		wrote = true;

		// --- Guard: file too large to attach ---
		const { size } = await fs.stat(tmpPath);
		if (size > UPLOAD_LIMIT_BYTES) {
			return interaction.editReply(
				`The export is too large to attach (${formatBytes(size)} > ${formatBytes(UPLOAD_LIMIT_BYTES)}). ` +
					`Try a smaller \`days\` range or the \`txt\` format.`,
			);
		}

		const attachment = new AttachmentBuilder(tmpPath, { name: fileName });
		const range = `<t:${Math.floor(cutoff / 1000)}:f> → now`;
		const summary =
			`**Channel:** ${channelMention(textChannel.id)} (\`${channelName}\`)\n` +
			`**Date range:** last ${days} day(s) (${range})\n` +
			`**Messages exported:** ${collected.length}\n` +
			`**Format:** ${format}`;

		await interaction.editReply({ content: summary, files: [attachment] });
	} catch (err: any) {
		// 40005 = Request entity too large (file exceeded the upload limit).
		if (err?.code === 40005) {
			return interaction.editReply(
				"The export file is too large for Discord to accept. Try a smaller `days` range or the `txt` format.",
			);
		}
		console.error("[export-chat] send failed:", err?.message ?? err);
		return interaction.editReply("Built the export, but failed to send the file.");
	} finally {
		// Always remove the temp file, success or failure.
		if (wrote) await fs.unlink(tmpPath).catch(() => {});
	}
}

/**
 * Page backwards through a channel's history until messages predate `cutoff`.
 *
 * Pagination logic:
 *  - Discord returns at most 100 messages per fetch, newest-first.
 *  - We start with no `before` cursor (latest messages), then on each loop set
 *    `before` to the OLDEST id from the previous batch to walk further back.
 *  - We keep only messages newer than `cutoff`, and stop as soon as a batch
 *    contains a message at/older than the cutoff (history is time-ordered, so
 *    everything beyond it is also too old).
 *  - We also stop when a batch returns fewer than the limit (no more history)
 *    or is empty, and respect a hard MAX_MESSAGES backstop.
 * Returns messages in chronological order (oldest → newest).
 */
async function fetchMessagesSince(channel: TextBasedChannel, cutoff: number): Promise<ExportedMessage[]> {
	const out: ExportedMessage[] = [];
	let before: string | undefined = undefined;

	while (out.length < MAX_MESSAGES) {
		const batch = await channel.messages.fetch({ limit: FETCH_BATCH, before });

		// No more history — safe stop.
		if (batch.size === 0) break;

		// Collection is newest-first; track the oldest id for the next cursor.
		let oldestId: string | undefined;
		let reachedCutoff = false;

		for (const msg of batch.values()) {
			oldestId = msg.id; // values() iterates newest→oldest, so this ends on the oldest.
			if (msg.createdTimestamp < cutoff) {
				reachedCutoff = true;
				continue; // too old — skip, and we'll stop after this batch.
			}
			out.push(mapMessage(msg));
		}

		// Hit a message older than the cutoff, or exhausted history (partial batch).
		if (reachedCutoff || batch.size < FETCH_BATCH) break;

		before = oldestId;
	}

	// We collected newest→oldest across batches; flip to chronological order.
	out.reverse();
	return out;
}

function mapMessage(msg: Message): ExportedMessage {
	return {
		messageId: msg.id,
		channelId: msg.channelId,
		channelName: "name" in msg.channel && (msg.channel as any).name ? (msg.channel as any).name : msg.channelId,
		authorId: msg.author.id,
		authorUsername: msg.author.username,
		// Prefer the per-guild nickname, fall back to global display name.
		authorDisplayName: msg.member?.displayName ?? msg.author.globalName ?? null,
		createdAt: new Date(msg.createdTimestamp).toISOString(),
		content: msg.content ?? "",
		attachments: [...msg.attachments.values()].map(a => ({
			filename: a.name ?? "unknown",
			url: a.url,
			contentType: a.contentType ?? null,
			size: a.size,
		})),
		embeds: msg.embeds.map(e => ({
			title: e.title ?? null,
			description: e.description ?? null,
			url: e.url ?? null,
		})),
		replyTo: msg.reference?.messageId ?? null,
	};
}

/** Render a human-readable transcript for the txt format. */
function renderTranscript(messages: ExportedMessage[], channelName: string, days: number): string {
	const lines: string[] = [];
	lines.push(`# Chat export — #${channelName}`);
	lines.push(`# Range: last ${days} day(s) | Messages: ${messages.length}`);
	lines.push("");

	for (const m of messages) {
		const name = m.authorDisplayName || m.authorUsername;
		lines.push(`[${m.createdAt}] ${name} (@${m.authorUsername})`);
		if (m.replyTo) lines.push(`  ↪ reply to ${m.replyTo}`);
		if (m.content) lines.push(`  ${m.content.replace(/\n/g, "\n  ")}`);
		for (const a of m.attachments) lines.push(`  [attachment] ${a.filename} — ${a.url}`);
		for (const e of m.embeds) {
			const parts = [e.title, e.url, e.description].filter(Boolean);
			if (parts.length) lines.push(`  [embed] ${parts.join(" | ")}`);
		}
		lines.push("");
	}

	return lines.join("\n");
}

function channelMention(id: string): string {
	return `<#${id}>`;
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
