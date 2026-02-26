import { Router } from 'express';
import { ChannelType } from 'discord.js';

const router = Router();

router.get('/', async (req, res) => {
	const guild = req.app.get('guild');
	if (!guild) return res.status(503).json({ error: 'Bot not connected' });

	const textChannels = guild.channels.cache
		.filter((c: any) => c.type === ChannelType.GuildText)
		.sort((a: any, b: any) => a.position - b.position);

	const grouped: Record<string, { id: string; name: string; type: string }[]> = {};
	textChannels.forEach((ch: any) => {
		const catName = ch.parent?.name?.toUpperCase() || 'UNCATEGORIZED';
		if (!grouped[catName]) grouped[catName] = [];
		grouped[catName].push({ id: ch.id, name: ch.name, type: 'text' });
	});

	const channels = Object.entries(grouped).map(([category, channels]) => ({
		category,
		channels,
	}));

	res.json({ channels });
});

export default router;
