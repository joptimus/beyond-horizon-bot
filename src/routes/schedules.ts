import { Router } from 'express';
import { push } from '../services/activityLog.js';

const router = Router();

interface Schedule {
	id: string;
	name: string;
	channelId: string | null;
	interval: string;
	enabled: boolean;
	lastRun: string | null;
	nextRun: string | null;
}

const schedules: Schedule[] = [
	{ id: 'leaderboard', name: 'Leaderboard', channelId: null, interval: '6h', enabled: true, lastRun: null, nextRun: null },
	{ id: 'server-status', name: 'Server Status', channelId: null, interval: '1h', enabled: true, lastRun: null, nextRun: null },
	{ id: 'daily-summary', name: 'Daily Summary', channelId: null, interval: '24h', enabled: false, lastRun: null, nextRun: null },
	{ id: 'lore-post', name: 'Auto Lore', channelId: null, interval: '48h', enabled: false, lastRun: null, nextRun: null },
];

function parseDuration(str: string): number | null {
	const map: Record<string, number> = { m: 60000, h: 3600000, d: 86400000 };
	const match = str.match(/^(\d+)(m|h|d)$/);
	if (!match) return null;
	return parseInt(match[1]) * map[match[2]];
}

router.get('/', (req, res) => {
	const guild = req.app.get('guild');
	const result = schedules.map(s => {
		const clean: any = { ...s };
		if (guild && s.channelId) {
			const ch = guild.channels.cache.get(s.channelId);
			clean.channelName = ch?.name || 'unknown';
		}
		return clean;
	});
	res.json({ schedules: result });
});

router.patch('/:id', (req, res) => {
	const schedule = schedules.find(s => s.id === req.params.id);
	if (!schedule) {
		return res.status(404).json({ error: 'Schedule not found' });
	}

	const { enabled, interval, channelId } = req.body;

	if (typeof enabled === 'boolean') schedule.enabled = enabled;
	if (interval && parseDuration(interval)) schedule.interval = interval;
	if (channelId) schedule.channelId = channelId;

	if (schedule.enabled && schedule.channelId) {
		const ms = parseDuration(schedule.interval);
		schedule.nextRun = ms ? new Date(Date.now() + ms).toISOString() : null;
	} else {
		schedule.nextRun = null;
	}

	push({
		text: `Schedule "${schedule.name}" ${schedule.enabled ? 'enabled' : 'disabled'}`,
		tag: 'AUTO',
		color: '#e5c07b',
	});

	res.json({ success: true, schedule });
});

export default router;
