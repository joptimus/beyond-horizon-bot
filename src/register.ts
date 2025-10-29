import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import * as Idea from './commands/idea.js';
import * as IdeasTop from './commands/ideasTop.js';
import * as Priority from './commands/priority.js';

async function main() {
  const token = process.env.DISCORD_TOKEN!;
  const appId = process.env.DISCORD_APP_ID!;
  const guildId = process.env.DISCORD_GUILD_ID!; // dev: fast updates

  const rest = new REST({ version: '10' }).setToken(token);

  const commands = [Idea.data, IdeasTop.data, Priority.data].map(c => c.toJSON());

  // Guild-scoped. For prod global, use Routes.applicationCommands(appId)
  await rest.put(Routes.applicationGuildCommands(appId, guildId), { body: commands });
  console.log('✅ Slash commands registered');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
