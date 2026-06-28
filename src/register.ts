import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import * as Idea from './commands/idea.js';
import * as IdeasTop from './commands/ideasTop.js';
import * as Priority from './commands/priority.js';
import * as Bug from './commands/bug.js';
import * as Verify from './commands/verify.js';
import * as Invite from './commands/invite.js';
import * as ExportChat from './commands/exportChat.js';

async function main() {
  const token = process.env.DISCORD_TOKEN!;
  const appId = process.env.DISCORD_APP_ID!;
  const guildId = process.env.DISCORD_GUILD_ID!; // dev: fast updates

  const rest = new REST({ version: '10' }).setToken(token);

  const commands = [Idea.data, IdeasTop.data, Priority.data, Bug.data, Verify.data, Invite.data, ExportChat.data].map(c => c.toJSON());

  // Global registration: commands become available in every server the bot is
  // in (and future ones). Note: the first global publish can take up to ~1 hour
  // to propagate across Discord, unlike instant guild-scoped updates.
  await rest.put(Routes.applicationCommands(appId), { body: commands });
  console.log('✅ Global slash commands registered');

  // Clear any leftover guild-scoped copies so the dev/primary guild doesn't show
  // each command twice (one global + one guild). Safe to skip if unset.
  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(appId, guildId), { body: [] });
    console.log(`🧹 Cleared guild-scoped commands in ${guildId}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
