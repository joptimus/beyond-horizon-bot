import { Router } from 'express';
import { EmbedBuilder } from 'discord.js';
import { push } from '../services/activityLog.js';

const router = Router();

router.post('/', async (req, res) => {
	console.log('[API/MESSAGES] POST request received');
	console.log('[API/MESSAGES] Request body:', JSON.stringify(req.body, null, 2));

	const guild = req.app.get('guild');
	if (!guild) return res.status(503).json({ error: 'Bot not connected' });

	const { channelId, content, embed, pin } = req.body;

	console.log('[API/MESSAGES] Parsed fields - channelId:', channelId, 'content:', content, 'embed:', embed, 'pin:', pin);

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
			if (embed.footer) {
				// Handle both string and object footer formats
				const footerData = typeof embed.footer === 'string' ? { text: embed.footer } : embed.footer;
				embedBuilder.setFooter(footerData);
			}
			if (embed.timestamp) embedBuilder.setTimestamp();
			messagePayload.embeds = [embedBuilder];

			if (content && embed.description) {
				messagePayload.content = content;
			}
		}

		console.log('[API/MESSAGES] Message payload to send:', JSON.stringify(messagePayload, null, 2));
		const sent = await channel.send(messagePayload);

		if (pin) {
			await sent.pin().catch(() => {});
		}

		push({
			text: `Message sent to #${channel.name}`,
			tag: 'MSG',
			color: '#748ffc',
		});

		console.log('[API/MESSAGES] ✅ Message sent successfully. ID:', sent.id);
		res.json({
			success: true,
			messageId: sent.id,
			channelId: channel.id,
		});
	} catch (err: any) {
		console.error('[API/MESSAGES] ❌ Error sending message:');
		console.error('[API/MESSAGES] Error message:', err.message);
		console.error('[API/MESSAGES] Error code:', err.code);
		console.error('[API/MESSAGES] Full error:', err);
		res.status(500).json({ error: err.message });
	}
});

export default router;
