import type { Request, Response, NextFunction } from 'express';

export function loggerMiddleware(req: Request, res: Response, next: NextFunction) {
	const start = Date.now();

	res.on('finish', () => {
		const duration = Date.now() - start;
		const status = res.statusCode;
		const tag = status >= 400 ? '❌' : '✅';
		console.log(`${tag} ${req.method} ${req.path} → ${status} (${duration}ms)`);
	});

	next();
}
