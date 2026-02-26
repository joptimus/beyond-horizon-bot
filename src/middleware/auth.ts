import type { Request, Response, NextFunction } from 'express';

export function authMiddleware(req: Request, res: Response, next: NextFunction) {
	if (req.method === 'OPTIONS') return next();

	const header = req.headers.authorization;
	if (!header || !header.startsWith('Bearer ')) {
		res.status(401).json({ error: 'Missing authorization header' });
		return;
	}

	const token = header.slice(7);
	if (token !== process.env.API_KEY) {
		res.status(403).json({ error: 'Invalid API key' });
		return;
	}

	next();
}
