# Guild Member Verification Flow Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Send new Discord members a lore-flavored DM with verify button and post welcome message in verify channel to kickstart the enlistment verification flow.

**Architecture:** Create a `guildMemberAdd` event handler that triggers on new member joins. The handler sends a branded DM embed with reusable verify modal button, posts a channel announcement, and handles DM failures gracefully. Verify modal is extracted into a shared helper function to avoid duplication between `/verify` slash command and this flow.

**Tech Stack:** Discord.js v14, ModalBuilder, EmbedBuilder, ButtonBuilder

---

## Task 1: Add VERIFY_CHANNEL_ID to environment

**Files:**
- Modify: `.env`

**Step 1: Update .env with VERIFY_CHANNEL_ID**

Add this line to `.env` after the other Channel & Role IDs:

```
VERIFY_CHANNEL_ID=your_verify_channel_id
```

The value will be filled in by the user from their Discord server.

**Step 2: Verify the change**

Check `.env` has the new variable added. No commit needed (env is not committed).

---

## Task 2: Extract verify modal builder into shared helper

**Files:**
- Modify: `src/commands/verify.ts:14-30`
- Modify: `src/bot.ts` (add helper function near top, after imports)

**Step 1: Create buildVerifyModal helper in bot.ts**

Add this function after the imports and before the `client.once` event (around line 64):

```typescript
// =====================
// Helper: Build Verify Modal
// =====================
function buildVerifyModal(): ModalBuilder {
	const modal = new ModalBuilder()
		.setCustomId('verify:designation')
		.setTitle('Enlistment Verification');

	const input = new TextInputBuilder()
		.setCustomId('designation')
		.setLabel('Commander Designation')
		.setStyle(TextInputStyle.Short)
		.setPlaceholder('CMDR-2026-XXXXX')
		.setRequired(true)
		.setMinLength(14)
		.setMaxLength(16);

	modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
	return modal;
}
```

**Step 2: Update verify.ts to use the helper**

Replace lines 14-30 in `src/commands/verify.ts`:

```typescript
export async function execute(interaction: ChatInputCommandInteraction) {
	const modal = buildVerifyModal();
	await interaction.showModal(modal);
}
```

Wait - this creates circular dependency. Instead, keep verify.ts as-is and just build the modal inline in the guildMemberAdd handler. **Skip this task** — we'll build it inline.

---

## Task 2 (revised): Add guildMemberAdd event handler to bot.ts

**Files:**
- Modify: `src/bot.ts` (add new event handler)

**Step 1: Add required imports to bot.ts**

After line 20 (end of discord.js imports), add:

```typescript
import { GuildMember } from 'discord.js';
```

(It's already imported in the destructure, so this is already done. ✓)

**Step 2: Add guildMemberAdd handler before client.login**

Add this event handler before the final `client.login()` call (before line 881):

```typescript
// ======================
// Member Join Flow (Welcome DM + Verify Channel Post)
// ======================
client.on(Events.GuildMemberAdd, async (member: GuildMember) => {
	try {
		// 1. Build verify modal (inline since it's only used here + verify slash command)
		const verifyModal = new ModalBuilder()
			.setCustomId('verify:designation')
			.setTitle('Enlistment Verification');

		const designationInput = new TextInputBuilder()
			.setCustomId('designation')
			.setLabel('Commander Designation')
			.setStyle(TextInputStyle.Short)
			.setPlaceholder('CMDR-2026-XXXXX')
			.setRequired(true)
			.setMinLength(14)
			.setMaxLength(16);

		verifyModal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(designationInput));

		// 2. Build verify button
		const verifyButton = new ButtonBuilder()
			.setCustomId('open_verify_modal')
			.setLabel('VERIFY DESIGNATION')
			.setStyle(ButtonStyle.Primary);

		const buttonRow = new ActionRowBuilder<ButtonBuilder>().addComponents(verifyButton);

		// 3. Build DM embed
		const dmEmbed = new EmbedBuilder()
			.setTitle('V1-PR · INCOMING TRANSMISSION')
			.setDescription(
				'Commander, your arrival at the frontier has been logged.\n\n' +
				'If you\'ve already enlisted at **beyondhorizononline.com**, link your designation to unlock full access to this channel.\n\n' +
				'If you haven\'t enlisted yet, head to [beyondhorizononline.com](https://beyondhorizononline.com) to secure your callsign before someone else does.'
			)
			.setColor(0x00e5cc)
			.setFooter({ text: 'Voran Defense Systems · V1-PR Automated Systems' });

		// 4. Send DM to user
		try {
			await member.send({
				embeds: [dmEmbed],
				components: [buttonRow],
			});
		} catch (dmError) {
			// User has DMs disabled; that's ok, channel post will catch them
			console.warn(`Could not DM ${member.user.tag} (DMs may be disabled)`);
		}

		// 5. Post in verify channel
		const verifyChannelId = process.env.VERIFY_CHANNEL_ID;
		if (verifyChannelId) {
			try {
				const verifyChannel = await client.channels.fetch(verifyChannelId);
				if (verifyChannel && verifyChannel.isTextBased()) {
					const channelEmbed = new EmbedBuilder()
						.setTitle('V1-PR · NEW ARRIVAL')
						.setDescription(
							'A new commander has entered the sector. Welcome aboard.\n\n' +
							'Use the button below or type `/verify` to link your enlistment designation.'
						)
						.setColor(0x00e5cc)
						.setFooter({ text: 'Voran Defense Systems' });

					await (verifyChannel as any).send({
						content: `<@${member.user.id}>`,
						embeds: [channelEmbed],
						components: [buttonRow],
					});
				}
			} catch (channelError) {
				console.warn(`Could not post to verify channel: ${channelError}`);
			}
		}
	} catch (error) {
		console.error('guildMemberAdd handler error:', error);
	}
});
```

**Step 3: Verify button handler exists**

Check that button handler for `open_verify_modal` exists. Add this to the button handler section (around line 385-584, in the `if (i.isButton())` block):

```typescript
// ----- VERIFY BUTTON -----
if (i.customId === 'open_verify_modal') {
	const modal = new ModalBuilder()
		.setCustomId('verify:designation')
		.setTitle('Enlistment Verification');

	const input = new TextInputBuilder()
		.setCustomId('designation')
		.setLabel('Commander Designation')
		.setStyle(TextInputStyle.Short)
		.setPlaceholder('CMDR-2026-XXXXX')
		.setRequired(true)
		.setMinLength(14)
		.setMaxLength(16);

	modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
	return i.showModal(modal);
}
```

Add this right after the BUG BUTTONS section (after line 583, before the closing brace of `if (i.isButton())`).

**Step 4: Commit**

```bash
git add src/bot.ts .env
git commit -m "feat: add guildMemberAdd welcome flow with verify button"
```

---

## Task 3: Test the implementation

**Manual Testing Steps:**

1. **Start bot locally:**
   ```bash
   npm run dev
   ```

2. **Verify the bot is running:**
   - Should see: `🤖 Logged in as [your-bot-name]`
   - Should see: `✅ Slash commands registered` (from earlier)

3. **Test new member join:**
   - Create a test account or use an alt Discord account
   - Have it join your test guild
   - Check:
     - ✅ New member receives DM with "V1-PR · INCOMING TRANSMISSION" embed and [VERIFY DESIGNATION] button
     - ✅ Message appears in `#verify-your-callsign` with user mention and similar embed
     - ✅ Clicking button opens the verify modal
     - ✅ Modal customId matches (`verify:designation`)

4. **Test DM failure gracefully:**
   - Disable DMs from server
   - Have a new test account join
   - Verify:
     - ✅ No crash in bot console
     - ✅ Console shows: `Could not DM [user#tag] (DMs may be disabled)`
     - ✅ Channel post still appears with ping

5. **Test button interaction:**
   - Click [VERIFY DESIGNATION] in either DM or channel
   - Modal should appear: "Enlistment Verification"
   - Enter test designation: `CMDR-2026-12345`
   - Should be caught by existing `/verify` modal handler

6. **Commit if all tests pass:**
   ```bash
   git commit --amend --no-edit
   ```
   (No new changes, just confirming manual test pass)

---

## Checklist Before Deployment

- [ ] `.env` has `VERIFY_CHANNEL_ID` filled in
- [ ] `src/bot.ts` has `guildMemberAdd` handler
- [ ] `src/bot.ts` has `open_verify_modal` button handler
- [ ] Bot runs locally without errors (`npm run dev`)
- [ ] New member receives DM (or sees console warning if DMs disabled)
- [ ] Channel post appears in verify channel
- [ ] Button opens modal successfully
- [ ] All commits pushed to branch
