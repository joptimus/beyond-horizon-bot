import { Router } from 'express';

const router = Router();

let messagesToday = 0;
let lastResetDate = new Date().toDateString();

export function trackMessage() {
	const today = new Date().toDateString();
	if (today !== lastResetDate) {
		messagesToday = 0;
		lastResetDate = today;
	}
	messagesToday++;
}

router.get('/', async (req, res) => {
	const guild = req.app.get('guild');
	if (!guild) return res.status(503).json({ error: 'Bot not connected' });

	try {
		const bans = await guild.bans.fetch().catch(() => new Map());

		res.json({
			onlineCount: guild.approximatePresenceCount || 0,
			memberCount: guild.memberCount,
			messagesToday,
			activeBans: bans.size,
			boostCount: guild.premiumSubscriptionCount || 0,
			boostTier: guild.premiumTier,
			channelCount: guild.channels.cache.size,
			roleCount: guild.roles.cache.size - 1,
		});
	} catch (err: any) {
		res.status(500).json({ error: err.message });
	}
});

export default router;
