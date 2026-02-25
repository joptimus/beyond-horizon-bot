const BASE_URL = process.env.GAME_SERVER_URL!;
const API_KEY = process.env.GAME_SERVER_API_KEY!;

const headers = {
	'Content-Type': 'application/json',
	Authorization: `Bearer ${API_KEY}`,
};

export async function verifyDesignation(designation: string, discordId: string) {
	const res = await fetch(`${BASE_URL}/api/v1/discord/verify`, {
		method: 'POST',
		headers,
		body: JSON.stringify({ designation, discordId }),
	});
	return res.json() as Promise<{
		ok: boolean;
		error?: string;
		callsign?: string;
		designation?: string;
	}>;
}

export async function checkDiscordVerified(discordId: string) {
	const res = await fetch(`${BASE_URL}/api/v1/discord/check/${discordId}`, { headers });
	return res.json() as Promise<{
		ok: boolean;
		verified: boolean;
		callsign?: string;
		designation?: string;
	}>;
}
