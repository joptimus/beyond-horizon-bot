import { Router } from 'express';
import { EmbedBuilder } from 'discord.js';
import { push } from '../services/activityLog.js';

const router = Router();

router.post('/', async (req, res) => {
	const guild = req.app.get('guild');
	if (!guild) return res.status(503).json({ error: 'Bot not connected' });

	const { channelId, content, embed, pin } = req.body;

	if (!channelId) {
		return res.status(400).json({ error: 'channelId is required' });
	}
	if (!content && !embed) {
		return res.status(400).json({ error: 'content or embed is required' });
	}

	const channel = guild.channels.cache.get(channelId);
	if (!channel) {
		return res.status(404).json({ error: 'Channel not found' });
	}

	try {
		const messagePayload: any = {};

		if (content && !embed) {
			messagePayload.content = content;
		}

		if (embed) {
			const embedBuilder = new EmbedBuilder();
			if (embed.title) embedBuilder.setTitle(embed.title);
			if (embed.description) embedBuilder.setDescription(embed.description || content);
			if (embed.color) embedBuilder.setColor(embed.color);
			if (embed.footer) embedBuilder.setFooter({ text: embed.footer });
			if (embed.timestamp) embedBuilder.setTimestamp();
			messagePayload.embeds = [embedBuilder];

			if (content && embed.description) {
				messagePayload.content = content;
			}
		}

		const sent = await channel.send(messagePayload);

		if (pin) {
			await sent.pin().catch(() => {});
		}

		push({
			text: `Message sent to #${channel.name}`,
			tag: 'MSG',
			color: '#748ffc',
		});

		res.json({
			success: true,
			messageId: sent.id,
			channelId: channel.id,
		});
	} catch (err: any) {
		res.status(500).json({ error: err.message });
	}
});

export default router;
