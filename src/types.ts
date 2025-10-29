export type Env = {
  DISCORD_TOKEN: string;
  DISCORD_APP_ID: string;
  DISCORD_GUILD_ID: string; // for guild-scoped commands during dev
  GITHUB_TOKEN: string;
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
  MIN_REACTIONS_FOR_IDEA?: string; // string from process.env
};

export type IdeaIssue = {
  number: number;
  title: string;
//  html_url: string;
  reactions: { '+1': number };
  labels: { name?: string }[];
};
