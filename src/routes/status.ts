import { Router } from 'express';

const router = Router();

router.get('/', async (req, res) => {
	const client = req.app.get('discord');
	const guild = req.app.get('guild');

	if (!guild) {
		return res.json({ status: 'offline', botUser: null });
	}

	const onlineCount = guild.approximatePresenceCount
		|| guild.members.cache.filter((m: any) => m.presence?.status !== 'offline').size;

	res.json({
		status: 'online',
		botUser: client.user.tag,
		serverName: guild.name,
		serverIcon: guild.iconURL({ size: 128 }),
		memberCount: guild.memberCount,
		onlineCount,
		uptime: Math.floor(client.uptime / 1000),
	});
});

export default router;
