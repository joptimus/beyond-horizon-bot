import { Router } from 'express';
import { getRecent, getSince } from '../services/activityLog.js';

const router = Router();

router.get('/', (_req, res) => {
	const limit = Math.min(parseInt(_req.query.limit as string) || 20, 50);
	const since = _req.query.since as string | undefined;

	const entries = since
		? getSince(since)
		: getRecent(limit);

	res.json({ entries });
});

export default router;
