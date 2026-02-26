import express from 'express';
import type { Client, Guild } from 'discord.js';
import { authMiddleware } from './middleware/auth.js';
import { loggerMiddleware } from './middleware/logger.js';
import statusRoute from './routes/status.js';
import channelsRoute from './routes/channels.js';
import messagesRoute from './routes/messages.js';
import moderateRoute from './routes/moderate.js';
import rolesRoute from './routes/roles.js';
import statsRoute, { trackMessage } from './routes/stats.js';
import leaderboardRoute from './routes/leaderboard.js';
import schedulesRoute from './routes/schedules.js';
import activityRoute from './routes/activity.js';

export function startApi(client: Client) {
	const app = express();
	const port = Number(process.env.API_PORT) || Number(process.env.PORT) || 3847;

	app.use(express.json());
	app.use(loggerMiddleware);
	app.use(authMiddleware);

	// Make discord client and guild available to routes
	const guildId = process.env.DISCORD_GUILD_ID;
	const guild = guildId ? client.guilds.cache.get(guildId) ?? null : null;
	app.set('discord', client);
	app.set('guild', guild);

	// Routes
	app.use('/status', statusRoute);
	app.use('/channels', channelsRoute);
	app.use('/messages', messagesRoute);
	app.use('/moderate', moderateRoute);
	app.use('/roles', rolesRoute);
	app.use('/stats', statsRoute);
	app.use('/leaderboard', leaderboardRoute);
	app.use('/schedules', schedulesRoute);
	app.use('/activity', activityRoute);

	app.listen(port, () => {
		console.log(`📡 API listening on port ${port}`);
	});

	// Wire up message tracking for stats
	client.on('messageCreate', () => trackMessage());
}
