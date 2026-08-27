# Claude Chat Exporter

A JavaScript tool that exports Claude.ai conversations to **clean Markdown** by reading Claude's own conversation data through its internal API. Get the complete conversation — both human and Claude messages, with full Markdown fidelity and timestamps — from a single request.

## Features

- **🎯 Authoritative content** - Reads the conversation straight from Claude's backend, so roles, ordering, and message text are exact — no DOM scraping
- **📊 Full Markdown fidelity** - Text blocks carry the original Markdown (tables, code, math, formatting)
- **🕐 Timestamps** - Per-message timestamps from the API
- **📁 Smart Filename Generation** - Uses the actual conversation title
- **⚡ Fast & complete** - One request; no scrolling, no copy-button clicking, nothing to miss
- **🔒 No manual auth** - Reuses your existing login via a same-origin request

## How It Works

1. **Read the conversation & org id** from the page URL and your `lastActiveOrg` cookie
2. **Fetch the conversation** from `/api/organizations/{org}/chat_conversations/{id}?tree=true&rendering_mode=messages&render_all_tools=true` — the full rendered message list in one request, using your existing session
3. **Render Markdown** from each message's content blocks, mapping `sender` to `## You:` / `## Claude:` headers with timestamps

### Why the API approach?

Earlier versions of this tool clicked Claude's per-message copy button and captured the clipboard output. That worked, but it depended on Claude's exact DOM markup (button selectors, action-bar structure) and broke every time the interface changed — the classic "No copy buttons found!" failure.

The internal API is the same source the page itself renders from, and the exporter **already called it** for timestamps. Reading the message content from it too removes the entire class of DOM-selector breakage:

```
❌ Copy-button / DOM scraping:
- Breaks whenever Claude reskins the UI
- Needs selector maintenance for every change
- Only sees messages currently in the DOM

✅ Internal API:
- Whole conversation in one request
- Roles, order, timestamps, content are authoritative
- One stable endpoint to maintain
```

## Usage

1. Open the conversation you want to export at [claude.ai](https://claude.ai) (URL should look like `claude.ai/chat/...`).
2. Open the browser's developer console:
   - Chrome/Edge: Press F12 or Ctrl+Shift+J (Windows/Linux) or Cmd+Option+J (Mac)
   - Firefox: Press F12 or Ctrl+Shift+K (Windows/Linux) or Cmd+Option+K (Mac)
   - Safari: Enable the Develop menu in preferences, then press Cmd+Option+C
3. Copy the entire script in `claude-chat-exporter.js` and paste it into the console.
4. Press Enter to run the script.
5. A file named `{conversation-title}.md` downloads automatically. The status chip shows how many messages were exported.

> The first time you paste into the console, some browsers require you to type `allow pasting` and press Enter before they'll accept pasted code.

## File Output

- **Filename**: `{conversation-title}.md` (falls back to `claude_conversation`)
- **Format**: Markdown with `## You:` / `## Claude:` headers and per-message timestamps
- **Content**: The full conversation, in order

## Example Output

Messages are grouped into **exchanges** (one of your messages plus the reply
that follows) and numbered globally, so you can navigate and reference specific
turns. A horizontal rule separates exchanges.

```markdown
# Zero trust strategy without strategic focus

## Exchange 1/12

## Message 1/24 - You (Feb 23, 2026, 10:30 AM):

Can you create a comparison table of sorting algorithms?

## Message 2/24 - Claude (Feb 23, 2026, 10:30 AM):

Here's a comprehensive comparison table of sorting algorithms:

| Algorithm   | Best Case  | Average Case | Worst Case | Space    | Stable |
| ----------- | ---------- | ------------ | ---------- | -------- | ------ |
| Bubble Sort | O(n)       | O(n²)        | O(n²)      | O(1)     | Yes    |
| Quick Sort  | O(n log n) | O(n log n)   | O(n²)      | O(log n) | No     |
| Merge Sort  | O(n log n) | O(n log n)   | O(n log n) | O(n)     | Yes    |

---

## Exchange 2/12

## Message 3/24 - You (Feb 23, 2026, 10:32 AM):

...
```

## Troubleshooting

**`Could not read conversation/org id`** - Open a specific conversation first; the export needs a chat URL and your `lastActiveOrg` cookie.

**`Conversation fetch failed (HTTP 401/403)`** - Make sure you're logged in to claude.ai in this tab.

**`Conversation fetch failed (HTTP 404)`** - The conversation id wasn't found for your account (wrong tab, or a chat you don't own).

## Maintenance

If Claude changes its API, update these in the script:

- Endpoint: `/api/organizations/{org}/chat_conversations/{id}` (query: `tree=true&rendering_mode=messages&render_all_tools=true`)
- Org id source: the `lastActiveOrg` cookie
- Message fields used: `chat_messages[]`, per-message `sender` (`human`/`assistant`), `content[].text`, `created_at`, and the conversation `name`

## List all conversations

Want an index of every conversation rather than one chat's contents? Run
[`claude-conversations-list.js`](./claude-conversations-list.js) the same way
(open claude.ai, paste into the console). It downloads **two** files:

- `claude-conversations.md` — a compact table of every conversation (title,
  model, created/updated timestamps, flags ⭐ starred · 📁 in a project, link)
- `claude-conversations-summaries.md` — one section per conversation with its
  **full** generated summary

It also prints a `console.table`. It lists conversations only; it does not
export their messages. (Your browser may ask to allow multiple downloads.)

## Sibling: ChatGPT Exporter

This repo also ships [`chatgpt-chat-exporter.js`](./chatgpt-chat-exporter.js), which does the same thing for chatgpt.com using ChatGPT's backend API. See [chatgpt-chat-exporter-README.md](./chatgpt-chat-exporter-README.md).

## Limitations

- **Claude Web Only** - Works on the claude.ai web interface (uses your logged-in session)
- **Active branch only** - Editing a prompt or regenerating a reply creates branches; only the surviving thread (from the active leaf up to the root) is exported, so edited-away versions don't inflate the counts
- **Text content** - Thinking blocks and tool results are skipped; message text is exported
- **Artifacts / files** - Outputs (artifacts, created/presented files) are listed with `_[Artifact: filename | Title]_` markers grouped at the end of the response (as in the UI), but their content is not embedded
- **Attachments** - Uploaded files are shown as placeholders, not embedded: `_[image: name]_` for images and `_[file: name]_` for other files
- **Endpoint churn** - If Claude renames the endpoint or fields, the constants above need updating

## Privacy & Security

What these scripts guarantee:

- **Local processing** - Everything runs in your browser; the conversation is fetched, converted, and downloaded immediately with no external processing.
- **Same-origin only** - Every request is a relative path back to claude.ai's own backend, using your existing session cookies. Nothing is ever sent to a third-party server.
- **No secrets in output** - Your session credentials are never written into the downloaded `.md` files, `localStorage`, or anywhere persistent — the files contain conversation content only.

The real thing to be careful about is **not this code, but the habit of pasting code into the browser console** (sometimes called "Self-XSS"):

- **Only run this from a source you trust.** Copy it from your own copy of this repo, not from a link someone sends you.
- **Never paste console snippets other people give you** into a logged-in claude.ai (or any) tab — a malicious script pasted there could read your session and send it elsewhere. That's the actual attack vector, and it applies to any console tool, not just this one.
- **Skim before you paste** — the scripts are short. The safety check: every `fetch(...)` targets a relative `/api/...` path on the current site. If you ever see a fetch to some other domain, don't run it.

## License

This project is open source and available under the [MIT License](LICENSE).

## Disclaimer

This script is not officially associated with Anthropic or Claude AI. It is a community-created tool to enhance the user experience. Use it responsibly and in accordance with Anthropic's terms of service.
