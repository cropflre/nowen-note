# AI conversation archives (v1.6.0 development)

[中文](ai-memory.md) · [Architecture](../architecture/ai-memory-hub.md) · [Validation](../qa/ai-memory-hub-2026-11-05.md)

This MVP archives raw conversations. Long-term memories, confirmation, context insertion and memory-specific MCP tools are not available. ChatGPT/Doubao adapters have local fixture coverage; real websites, accounts and installed clients still require acceptance.

## Capture a conversation

Log into your own Nowen HTTP instance in Web Clipper and select an existing personal notebook. Open a ChatGPT `/c/<id>` or Doubao `/chat/<id>` conversation, name the source, authorize a preview, inspect the text and warnings, then save. Optional automatic capture applies to this exact conversation. Other conversations require separate consent. Without stable message IDs, only an initial manual snapshot is supported.

Web captures are marked partial. Unloaded history and missing attachments are not claimed as saved. Streaming replies remain transient. Local queuing is distinct from a matching durable server receipt and from another device receiving the data. Desktop pairing-only transport and mobile device-only mode are currently unsupported.

Pause a conversation or source, revoke the source, or explicitly clear the current Nowen account's pending queue. Online capture rechecks source authorization. Offline capture can continue within seven days of explicit consent/verification; revocation on another device cannot be discovered immediately while offline. See [extension limits and permissions](../../packages/nowen-clipper/AI_CONVERSATION_CAPTURE.md).

## Import history

Open **AI Memory → Connections & sync**, create a source with a personal notebook and explicit consent, and select a file. Review the preview, selected branch and missing-content warnings, then confirm import. Progress, cancellation, retry of unsaved items, reports and staging cleanup are available. Interrupted jobs require explicit retry after restart; cancellation retains completed items. Staging expires after 24 hours.

Supported inputs are ChatGPT ZIP exports containing `conversations.json` or numbered shards, standard JSON, Markdown/TXT, and native `nowen-ai-conversation` v1 JSON exports. ChatGPT imports follow `current_node` and report omitted branches. Attachments are not fetched and imported scripts are never executed. Markdown/TXT become one unknown-role message.

Standard JSON is one object, or an array of objects, with `externalConversationId`, optional `title`, and `messages: [{externalMessageId, role, text}]`. Native exports preserve content blocks, roles, message states, timestamps and source URLs. Importing into a different source explicitly reports the original and target identities.

Limits: 64 MiB upload, 128 MiB ZIP expansion, 32 MiB per JSON, 2,000 conversations per job, 1,000 messages / 2 MiB per imported conversation and 256 KiB per message. A growing archive is capped at 10,000 messages / 16 MiB of text and blocks. A native export exceeding single-import limits remains readable evidence but cannot be reimported as one item. Keep full SQLite backups for complete instance recovery.

## Manage the archive

Search/filter archives, view raw messages, open the note projection or export native JSON. Edited notes or notes that have entered collaborative editing are protected from automatic replacement; rebuild creates a separate copy.

Trash affects only the Nowen copy and supports archive restoration. Modified note copies are preserved. **Permanently deleting a source's personal notebook also permanently deletes its bound raw archive, source and operation records.** User notes already moved elsewhere remain intact.

Raw archives and source configuration remain on the receiving instance and do not yet participate in Sync V2. Note projections use existing note sync. Administrative account ownership transfer is rejected when AI sources exist, preserving all original data; export and import into the recipient first. Explicit full account deletion retains its existing semantics.

No conversation content is sent to the developer's servers. The feature does not read third-party cookies, passwords or tokens, call hidden APIs, or send AI messages. Existing broad ordinary-clipper website permissions remain; AI capture requires separate consent. Optional host-permission migration is not completed.
