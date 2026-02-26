import { Router } from 'express';
import { AuditLogEvent } from 'discord.js';
import { push } from '../services/activityLog.js';

const router = Router();

function parseDuration(str: string): number | null {
	const map: Record<string, number> = { m: 60000, h: 3600000, d: 86400000 };
	const match = str.match(/^(\d+)(m|h|d)$/);
	if (!match) return null;
	return parseInt(match[1]) * map[match[2]];
}

router.post('/', async (req, res) => {
	const guild = req.app.get('guild');
	if (!guild) return res.status(503).json({ error: 'Bot not connected' });

	const { action, userId, duration, reason } = req.body;

	if (!action || !userId) {
		return res.status(400).json({ error: 'action and userId are required' });
	}
	if (!['mute', 'kick', 'ban'].includes(action)) {
		return res.status(400).json({ error: 'action must be mute, kick, or ban' });
	}
	if (action === 'mute' && !duration) {
		return res.status(400).json({ error: 'duration is required for mute' });
	}

	try {
		const member = await guild.members.fetch(userId).catch(() => null);
		if (!member) {
			return res.status(404).json({ error: 'User not found in server' });
		}

		const username = member.user.tag;
		const auditReason = reason || 'Action by Afterglow admin';

		switch (action) {
			case 'mute': {
				const ms = parseDuration(duration);
				if (!ms) return res.status(400).json({ error: 'Invalid duration format' });
				await member.timeout(ms, auditReason);
				push({ text: `${username} muted for ${duration}`, tag: 'MOD', color: '#ff6b6b' });
				break;
			}
			case 'kick': {
				await member.kick(auditReason);
				push({ text: `${username} kicked`, tag: 'MOD', color: '#ff6b6b' });
				break;
			}
			case 'ban': {
				await member.ban({ reason: auditReason, deleteMessageSeconds: 0 });
				push({ text: `${username} banned`, tag: 'MOD', color: '#ff6b6b' });
				break;
			}
		}

		res.json({
			success: true,
			action,
			userId,
			username,
			duration: action === 'mute' ? duration : undefined,
		});
	} catch (err: any) {
		res.status(500).json({ error: err.message });
	}
});

router.get('/mod-log', async (req, res) => {
	const guild = req.app.get('guild');
	if (!guild) return res.status(503).json({ error: 'Bot not connected' });

	const limit = Math.min(parseInt(req.query.limit as string) || 10, 50);

	try {
		const auditLogs = await guild.fetchAuditLogs({ limit });

		const modActions = [
			AuditLogEvent.MemberBanAdd,
			AuditLogEvent.MemberBanRemove,
			AuditLogEvent.MemberKick,
			AuditLogEvent.MemberUpdate,
		];

		const entries = auditLogs.entries
			.filter((e: any) => modActions.includes(e.action))
			.map((e: any) => ({
				action: e.action === AuditLogEvent.MemberBanAdd ? 'ban'
					: e.action === AuditLogEvent.MemberKick ? 'kick'
					: 'mute',
				targetUser: e.target?.tag || 'Unknown',
				targetId: e.target?.id,
				moderator: e.executor?.tag || 'Unknown',
				reason: e.reason || null,
				timestamp: e.createdAt.toISOString(),
			}));

		res.json({ entries });
	} catch (err: any) {
		res.status(500).json({ error: err.message });
	}
});

export default router;
