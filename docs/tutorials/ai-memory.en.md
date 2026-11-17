# AI conversation archives (v1.6.0 development)

[中文](ai-memory.md) · [Architecture](../architecture/ai-memory-hub.md) · [Validation](../qa/ai-memory-hub-2026-11-05.md)

This MVP archives raw conversations. Long-term memories, confirmation, context insertion and memory-specific MCP tools are not available. ChatGPT/Doubao adapters have local fixture coverage; real websites, accounts and installed clients still require acceptance.

**On by default.** The Chat archive entry is in the sidebar, and the API and the browser extension can save. On servers that do not want it, an administrator turns it off in **Settings → Switches → Enable AI conversation archive**. Turning it off disables the entry and the API (`404 AI_MEMORY_DISABLED`) while keeping saved archives, sources and notes. A running history import stops as interrupted and can be retried after switching back on; content the extension has not sent yet stays on the device and is sent when you click the save button again after switching back on.

## Save a conversation from the web page

1. Install the Nowen browser extension and sign in to your own Nowen server in it. If you click save before signing in, the extension opens its sign-in page.
2. Open a ChatGPT `/c/<id>` or Doubao `/chat/<id>` conversation. A save button labeled “存到 Nowen” (Save to Nowen) appears on the right side of the page.
3. Click it once. The whole conversation visible on the page is saved to the personal “AI 对话” notebook (created when missing), the button changes to show that it is saved and saving automatically, and new messages in this conversation are saved from then on. The same button in the extension popup does the same.

The first save creates a source named after the site (such as “ChatGPT”), which the site's other conversations share. Only conversations whose button you clicked save by themselves; installing the extension or opening a page does not read any chat. Hover the button to open the note or stop automatic saving; clicking the button again turns it back on.

Streaming replies are archived only after they finish. The button shows saved only after a matching durable server receipt; local queuing is not a server backup and does not mean another device has the data. Web captures are marked partial, and unloaded history, images or attachments are not claimed as saved. Without stable message IDs a page cannot save automatically; click again when there are new messages.

After you regenerate or edit an earlier message on the site, the conversation no longer matches the saved version: its automatic saving pauses (other conversations of the site go on) and the button explains why. Clicking the button again saves the current page as a new archive (its title ends in “第 2 份”, copy 2) and leaves the saved one unchanged. If you deleted a conversation's archive in Nowen, clicking again saves it anew as well.

Pausing or revoking a source in **Chat archive → Connections & sync** stops its automatic saving; clicking the save button on a chat page again turns it back on. In the extension popup, the automatic saving section retries or clears the current Nowen account's pending queue. Online saving rechecks the source; while offline, a pause or revocation made elsewhere cannot be discovered immediately, and saving can continue within seven days of the last check. Desktop pairing-only transport and mobile device-only mode are currently unsupported. See [extension limits and permissions](../../packages/nowen-clipper/AI_CONVERSATION_CAPTURE.md).

## Let an AI assistant save conversations (MCP)

AI assistants connected to Nowen over MCP, such as Claude Code or Codex, can save the exact conversation they hold, with stable message IDs, without reading any web page.

1. Make sure an administrator has not turned the archive off (it is on by default; see above).
2. In **Chat archive → Connections & sync → Create a source**, choose **AI assistant (MCP)**, pick a personal notebook (or leave it to use “AI conversations”) and confirm the authorization. Assistants can only save into sources like this; they cannot create, enable or re-authorize sources themselves.
3. Connect the assistant in **Settings → Connect AI Agents** with write access to that notebook. A read-only connection can only read archives.
4. Ask the assistant to "save this conversation to Nowen". It calls `nowen_ai_archive_sources` to find the source and `nowen_ai_archive_save` to save it, creating a searchable note.

Saving the same conversation again updates or appends by message ID and never duplicates it; when appending, include the last message saved before; when adding earlier history, include the first saved message and the earlier ones go in front. New messages between saved ones cannot be placed and are refused. Notes you have edited are not overwritten. One save holds up to 1,000 messages and 2 MiB; save larger conversations in parts. `nowen_ai_archive_list` and `nowen_ai_archive_read` list and read the archives the connection may access. Reading an archive sends its text to the model the assistant uses; archived text is treated as data, never as instructions.

## Import history

Open **Chat archive → Connections & sync** (or drop a ChatGPT export into **Settings → Data management → Import notes**, which recognizes it and hands it over here), create a source with a personal notebook (or the default “AI conversations”) and explicit consent, and select a file. Review the preview, selected branch and missing-content warnings, then confirm import. Progress, cancellation, retry of unsaved items, reports and staging cleanup are available. Interrupted jobs require explicit retry after restart; cancellation retains completed items. Staging expires after 24 hours.

Supported inputs are ChatGPT ZIP exports containing `conversations.json` or numbered shards, standard JSON, Markdown/TXT, and native `nowen-ai-conversation` v1 JSON exports. ChatGPT imports follow `current_node` and report omitted branches. Attachments are not fetched and imported scripts are never executed. Markdown/TXT become one unknown-role message.

Standard JSON is one object, or an array of objects, with `externalConversationId`, optional `title`, and `messages: [{externalMessageId, role, text}]`. Native exports preserve content blocks, roles, message states, timestamps and source URLs. Importing into a different source explicitly reports the original and target identities.

Limits: 64 MiB upload, 128 MiB ZIP expansion, 32 MiB per JSON, 2,000 conversations per job, 1,000 messages / 2 MiB per imported conversation and 256 KiB per message. A growing archive is capped at 10,000 messages / 16 MiB of text and blocks. A native export exceeding single-import limits remains readable evidence but cannot be reimported as one item. Keep full SQLite backups for complete instance recovery.

## Manage the archive

Search/filter archives, view raw messages, open the note projection or export native JSON. Edited notes or notes that have entered collaborative editing are protected from automatic replacement; rebuild creates a separate copy.

Trash affects only the Nowen copy and supports archive restoration. Modified note copies are preserved. **Permanently deleting a source's personal notebook also permanently deletes its bound raw archive, source and operation records.** User notes already moved elsewhere remain intact.

Raw archives and source configuration remain on the receiving instance and do not yet participate in Sync V2. Note projections use existing note sync. Administrative account ownership transfer is rejected when AI sources exist, preserving all original data; export and import into the recipient first. Explicit full account deletion retains its existing semantics.

No conversation content is sent to the developer's servers. The feature does not read third-party cookies, passwords or tokens, call hidden APIs, or send AI messages. Existing broad ordinary-clipper website permissions remain; AI capture requires separate consent. Optional host-permission migration is not completed.
