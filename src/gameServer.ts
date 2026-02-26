const BASE_URL = process.env.GAME_SERVER_URL!;
const API_KEY = process.env.GAME_SERVER_API_KEY!;

const headers = {
	'Content-Type': 'application/json',
	Authorization: `Bearer ${API_KEY}`,
};

const log = {
	info: (msg: string) => console.log(`[API] ${new Date().toISOString()} ${msg}`),
	error: (msg: string, err?: any) => console.error(`[API ERROR] ${new Date().toISOString()} ${msg}`, err || ''),
	debug: (msg: string) => console.log(`[API DEBUG] ${new Date().toISOString()} ${msg}`),
};

export async function verifyDesignation(designation: string, discordId: string) {
	log.info(`→ POST /api/v1/discord/verify (designation=${designation}, discordId=${discordId})`);
	log.debug(`BASE_URL: ${BASE_URL}`);

	try {
		const res = await fetch(`${BASE_URL}/api/v1/discord/verify`, {
			method: 'POST',
			headers,
			body: JSON.stringify({ designation, discordId }),
		});

		log.debug(`← Response status: ${res.status}`);
		const data = (await res.json()) as {
			ok: boolean;
			error?: string;
			callsign?: string;
			designation?: string;
		};

		if (data.ok) {
			log.info(`✅ Verification successful: callsign=${data.callsign}`);
		} else {
			log.error(`❌ Verification failed: ${data.error}`);
		}

		return data;
	} catch (err) {
		log.error(`❌ API call failed:`, err);
		throw err;
	}
}

export async function checkDiscordVerified(discordId: string) {
	log.info(`→ GET /api/v1/discord/check/${discordId}`);
	log.debug(`BASE_URL: ${BASE_URL}`);

	try {
		const res = await fetch(`${BASE_URL}/api/v1/discord/check/${discordId}`, { headers });

		log.debug(`← Response status: ${res.status}`);
		const data = (await res.json()) as {
			ok: boolean;
			verified: boolean;
			callsign?: string;
			designation?: string;
		};

		if (data.verified) {
			log.info(`✅ User already verified: callsign=${data.callsign}`);
		} else {
			log.info(`ℹ️ User not yet verified`);
		}

		return data;
	} catch (err) {
		log.error(`❌ API call failed:`, err);
		throw err;
	}
}
