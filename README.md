# Beyond Horizon – Idea Bot

Discord → AI → GitHub pipeline for capturing, refining, approving, and voting on player ideas for a space-MMO/RTS.  
- Creates a **thread** per idea (keeps channels clean)  
- Uses OpenAI to **enrich** the idea and ask up to **3 clarifying questions**  
- Lets the submitter **Approve & Post** to GitHub  
- Posts a **vote message** in the parent channel (👍 to vote)  
- **Syncs vote counts** back to the GitHub issue comment in real time

---

## ✨ Features

- **Dual command styles**: `/idea` (slash) or `!idea` (prefix)
- **Threaded flow**: all Q&A and approval happen in a dedicated thread
- **Auto-enrichment**: OpenAI summarizes, scopes, and proposes implementation notes
- **Clarifications**: Bot asks **≤ 3** short questions when needed
- **Approval gate**: submitter must approve before posting to GitHub
- **Voting message stays in channel** (no GitHub URL visible)
- **Live GitHub sync**: 👍 reactions update a “Discord Votes” issue comment

---

## 🧱 Project Structure

```
src/
  bot.ts                 # main entry (prefix + slash interactions)
  ai.ts                  # OpenAI prompting & JSON structuring logic
  commands/
    idea.ts              # /idea slash command implementation
  pending.ts             # in-progress idea storage (answering / approval)
  votes.ts               # messageId <-> issueNumber tracking for votes
  github.ts              # create issue + upsert reaction-synced comment
```

---

## 🔧 Requirements

- Node 18+
- Discord Bot with:
  - Scopes: `bot`, `applications.commands`
  - Privileged Intent: **Message Content**
  - Permissions: Send Messages, Create Public Threads, Add Reactions, Read History
- GitHub Personal Access Token (`repo` scope) *or* GitHub App
- OpenAI API Key

---

## 🔐 Environment Variables

Create `.env` (not committed) and commit `.env.example`:

```
DISCORD_TOKEN=
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4o-mini

GITHUB_TOKEN=
GITHUB_OWNER=Christ139
GITHUB_REPO=SpaceMMORPG
```

---

## 🚀 Running Locally

```
npm install
npm run dev      # runs src/bot.ts
npm run build
npm start        # runs dist/bot.js
```

Recommended `package.json` scripts:
```
"scripts": {
  "dev": "tsx src/bot.ts",
  "build": "tsc -p tsconfig.json",
  "start": "node dist/bot.js"
}
```

---

## 🧵 How the Idea Flow Works

1. User submits:
   ```
   /idea <text>
   ```
   or
   ```
   !idea <text>
   ```
2. Bot creates a **thread**
3. Bot enriches the idea using AI
4. If needed, bot asks **up to 3** clarifying questions
5. User answers → AI refines draft → Bot asks for **Approve & Post**
6. Upon approval:
   - A **GitHub issue** is created
   - A **vote message** is posted in the parent channel
   - Users vote by reacting 👍
   - Vote counts sync automatically to GitHub

---

## 🗳️ Vote Syncing

- A 👍 reaction on the vote message increments the vote count in GitHub
- Removing 👍 reduces the count
- A single GitHub issue comment tracks the total
- Mapping is stored in `votes.ts`

Client requires:
```
partials: [Partials.Message, Partials.Reaction, Partials.Channel]
intents: [
  Guilds,
  GuildMessages,
  GuildMessageReactions,
  MessageContent
]
```

---


## 📄 License

MIT — free to modify and use.

---
