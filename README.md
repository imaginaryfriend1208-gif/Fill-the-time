# Fill the Time

A SillyTavern extension that maintains one cumulative story summary for each chat. New chapters merge into the active summary, while previous versions can be kept in a per-chat archive.

## Requirements

- SillyTavern 1.13.0 or newer
- Connection Manager extension when using a dedicated summarization profile

## Installation

### SillyTavern extension installer

1. Open **Extensions** in SillyTavern.
2. Choose **Install Extension**.
3. Paste:

```text
https://github.com/imaginaryfriend1208-gif/Fill-the-time
```

4. Reload SillyTavern after installation.

### Manual installation

From the SillyTavern directory:

```bash
cd public/scripts/extensions/third-party
git clone https://github.com/imaginaryfriend1208-gif/Fill-the-time.git fill-the-time
```

Reload SillyTavern. To update a manual installation, run `git pull` inside the `fill-the-time` directory and reload.

The installed extension version appears beside **Fill the Time** in its settings header and is read directly from `manifest.json`.

## Quick start

1. Open **Extensions → Fill the Time**.
2. Select a Connection Manager profile under **Summarization Connection**, or leave **No Override** to use the current connection.
3. Keep the built-in **Rolling Summary** preset or configure your own prompts.
4. Hover a chat message and click **⏹**, or enter an End Message ID and click **Create Chapter**.
5. Review the proposed cumulative summary. Edit it, choose **Re-summarize**, **Accept**, or **Cancel**.
6. Add `{{fillthetime}}` to a Prompt Manager entry, or enable **Inject at Depth**. Avoid using both unless duplicate context is intentional.

Use **Help** or **Start Tutorial** in the extension panel for the translated walkthrough.

## Languages

The extension UI supports:

- Auto (follows SillyTavern)
- English
- Tiếng Việt
- Français

The selector changes only Fill the Time. It does not change SillyTavern's global language. The choice persists in extension settings.

## Rolling summaries and chapters

The active summary is cumulative. When a new chapter is accepted:

- messages after the previous endpoint through the selected endpoint are summarized;
- the previous active summary is supplied as `{{previousSummary}}`;
- the accepted result replaces the active summary;
- the prior version can be archived;
- summarized messages can optionally be hidden from model context.

Long ranges can be split into chunks. Chunk progress is checkpointed so a failed operation can resume.

### Regenerate an accepted summary

Use **Regenerate** on the active summary card when the accepted result is unsatisfactory.

- If an older archive exists, the newest archive before the active endpoint is used as the base, and messages after that archive through the active endpoint are summarized again.
- If no suitable archive exists, the entire chat through the active endpoint is summarized with an empty base.
- The regenerated proposal opens for review.
- **Re-summarize** produces another proposal.
- **Replace** updates the active summary only after a stale-state check and chat backup.
- **Cancel**, Escape, API failure, or closing the popup preserves the current summary.

Regeneration does not alter archive entries, the active endpoint, chapter markers, or hidden-message state. Archive entries themselves are not regenerable.

## Prompt presets

Fill the Time includes Rolling Summary and diary-oriented presets. A preset stores:

- System Prompt
- User Prompt
- Connection profile
- Rate limit

To create one:

1. Edit **System Prompt** and **User Prompt**.
2. Keep both required User Prompt placeholders:
   - `{{previousSummary}}` — current cumulative summary, or the regeneration base
   - `{{content}}` — new messages or prepared chunk summaries
3. Click **Save New** and enter a name.
4. Select a preset and click **Update** to overwrite it.
5. Use **Export** and **Import** to share a preset as JSON.

Example User Prompt:

```text
<previous_summary>
{{previousSummary}}
</previous_summary>

<new_events>
{{content}}
</new_events>

Merge these into one cumulative plaintext story summary. Preserve established facts, relationships, resolved events, and open threads.
```

Changing either prompt makes the current configuration custom until it is saved or updated as a preset.

## Summary injection

The recommended Prompt Manager entry is:

```text
{{fillthetime}}
```

Alternatively, enable **Inject at Depth** and configure its role and depth. Its template supports:

| Macro | Meaning |
|---|---|
| `{{fillthetime}}` | Active cumulative summary |
| `{{lastMessageId}}` | Most recent message ID in the chat |
| `{{firstIncludedMessageId}}` | First message after the active summary endpoint |

The summarization User Prompt separately supports `{{previousSummary}}` and `{{content}}`.

## Active summary and archive

- Edit the active summary inline and click **Save**.
- Use the expand icon for a larger editor.
- **Clear / Restore** restores the newest archive when available or clears the active summary.
- Archive entries are scoped to the current chat and can be inspected or deleted.
- **Export Config / Import Config** backs up extension-wide settings and presets.

## Slash commands

| Command | Description |
|---|---|
| `/fillthetime-end` (alias `/chapter-end`) | Generate through a message ID; supports profile/quiet options |
| `/fillthetime-show` | Return the active summary |
| `/fillthetime-clear` | Open the clear/restore flow |
| `/remove-reasoning` | Remove reasoning blocks from a message or range |
| `/remove-tool-calls` | Remove tool-call messages from the chat |

## Data safety

Summary data and archives are stored in the current chat metadata. Settings and presets are stored in SillyTavern extension settings. Fill the Time creates a chat backup before chapter updates and before accepting active-summary regeneration. Proposal popups do not replace persisted data until explicitly accepted.

## License

AGPL-3.0. See [LICENSE](LICENSE).

## Support

Open issues or pull requests at <https://github.com/imaginaryfriend1208-gif/Fill-the-time>.
