// src/gameNews.ts
// Posts a release note to the game-server launcher news feed. The /api/admin/news
// route is guarded by an admin JWT (verifyToken + isAdmin), so we do a fresh
// admin-login per call — at the once-per-release cadence an 8h cached token is
// almost always expired, and a stateless login keeps no token store.
const BASE_URL = process.env.GAME_SERVER_URL!;

const log = {
	info: (msg: string) => console.log(`[GameNews] ${new Date().toISOString()} ${msg}`),
	error: (msg: string, err?: any) => console.error(`[GameNews ERROR] ${new Date().toISOString()} ${msg}`, err || ''),
};

async function adminLogin(): Promise<string> {
	const username = process.env.ADMIN_USER;
	const password = process.env.ADMIN_PASS;
	if (!username || !password) throw new Error('Missing ADMIN_USER/ADMIN_PASS in env');

	const res = await fetch(`${BASE_URL}/api/admin/login`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ username, password }),
	});
	const data = (await res.json()) as { success?: boolean; token?: string; error?: string };
	if (!res.ok || !data.token) throw new Error(`admin login failed (${res.status}): ${data.error || 'no token'}`);
	return data.token;
}

export interface NewsPost {
	title: string;
	body: string;
	version_tag: string;
	category?: string;
}

export interface NewsResult {
	id: number | null;
	deduped: boolean;
}

export async function postLauncherNews(post: NewsPost): Promise<NewsResult> {
	const token = await adminLogin();
	log.info(`-> POST /api/admin/news (version_tag=${post.version_tag})`);

	const res = await fetch(`${BASE_URL}/api/admin/news`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
		body: JSON.stringify({
			title: post.title,
			body: post.body,
			category: post.category || 'patch',
			version_tag: post.version_tag,
		}),
	});

	const data = (await res.json()) as { ok?: boolean; id?: number; deduped?: boolean; error?: string };
	if (!res.ok || !data.ok) throw new Error(`create news failed (${res.status}): ${data.error || 'unknown'}`);

	log.info(`<- news id=${data.id} deduped=${data.deduped === true}`);
	return { id: data.id ?? null, deduped: data.deduped === true };
}
