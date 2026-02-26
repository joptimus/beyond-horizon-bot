import { Router } from 'express';

const router = Router();

router.get('/', async (req, res) => {
	const guild = req.app.get('guild');
	if (!guild) return res.status(503).json({ error: 'Bot not connected' });

	try {
		await guild.members.fetch();

		const roles = guild.roles.cache
			.filter((r: any) => r.id !== guild.id)
			.sort((a: any, b: any) => b.position - a.position)
			.map((r: any) => ({
				id: r.id,
				name: r.name,
				color: r.hexColor === '#000000' ? '#5c6370' : r.hexColor,
				memberCount: r.members.size,
				position: r.position,
				managed: r.managed,
			}));

		res.json({ roles });
	} catch (err: any) {
		res.status(500).json({ error: err.message });
	}
});

export default router;
