import { Router } from 'express';

const router = Router();

let cache: any = null;
let cacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000;

router.get('/', async (_req, res) => {
	const now = Date.now();
	if (cache && (now - cacheTime) < CACHE_TTL) {
		return res.json(cache);
	}

	try {
		const gameApiUrl = process.env.GAME_API_URL;
		if (gameApiUrl) {
			const response = await fetch(`${gameApiUrl}/alliances/leaderboard`);
			const data = await response.json();
			cache = data;
			cacheTime = now;
			return res.json(data);
		}

		res.json({
			entries: [],
			lastUpdated: new Date().toISOString(),
		});
	} catch (err: any) {
		res.status(500).json({ error: err.message });
	}
});

export default router;
