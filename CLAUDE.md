# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Discord bot that creates a pipeline for game idea submissions: Discord → AI enrichment → GitHub issues. Built for a space-MMO/RTS game community.

## Commands

```bash
npm run dev      # Run locally with tsx (hot-reload)
npm run build    # Compile TypeScript to dist/
npm run start    # Run compiled bot
```

No test or lint commands are configured.

## Architecture

### Data Flow: Idea Submission Pipeline

```
User submits idea (/idea or !idea)
    ↓
AI enrichment (ai.ts) → generates structured JSON
    ↓
If openQuestions exist → show modal for Q&A → re-enrich with answers
    ↓
Awaiting approval (inline buttons in thread)
    ↓
User approves → createIdeaIssue() posts to GitHub
    ↓
Vote embed posted → Discord reactions sync to GitHub comment
```

### Core Modules

- **bot.ts** - Main orchestrator. Handles slash/prefix commands, button/modal flows, reaction→GitHub vote syncing, thread creation.
- **ai.ts** - OpenAI integration. `enrichIdea()` converts raw text to structured JSON (title, summary, scope, risks, etc.). `toIssueBody()` formats for GitHub markdown.
- **github.ts** - Octokit wrapper. Creates issues with "idea" label, maintains vote-tracking comments, manages P1-P5 priority labels.
- **pending.ts** - In-memory Map storing draft ideas with 10-minute TTL. Tracks phase: `awaiting_answers` or `awaiting_approval`.
- **votes.ts** - Maps Discord message IDs to GitHub issue numbers for vote syncing.
- **ranking.ts** - Sorts ideas by combined Discord votes + priority weight (P1=50 down to P5=1).

### Slash Commands (src/commands/)

- `/idea <text>` - Submit new idea
- `/ideas top [count]` - List top ideas by votes
- `/priority <issue> <level>` - Set P1-P5 priority (requires ManageGuild)

## Key Technical Details

- **Runtime**: Node.js 18+
- **Discord**: discord.js v14 with MessageContent, GuildMessages, GuildMessageReactions intents
- **AI**: OpenAI API (gpt-4o-mini default)
- **GitHub**: Octokit REST client

## Environment Variables

Required in `.env` (see `.env.example`):
- `DISCORD_TOKEN`, `DISCORD_APP_ID`, `DISCORD_GUILD_ID`
- `GITHUB_TOKEN`, `GITHUB_OWNER`, `GITHUB_REPO`
- `OPENAI_API_KEY`
