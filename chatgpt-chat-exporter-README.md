# ChatGPT Chat Exporter

A JavaScript tool that exports ChatGPT conversations to **clean Markdown** by reading ChatGPT's own conversation data through its backend API. It's the sibling of [Claude Chat Exporter](./README.md) in this repo, using the same paste-in-console workflow.

## Features

- **🎯 Authoritative content** - Reads the full conversation straight from ChatGPT's backend, so roles, ordering, and message text are exact — no DOM scraping
- **🧭 Correct ordering & branches** - Reconstructs the currently-visible thread from the message tree, so edits/regenerations resolve correctly and messages are always in order
- **🕐 Timestamps** - Per-message timestamps from the API
- **📁 Smart Filename Generation** - Uses the actual conversation title
- **⚡ Fast & complete** - One request; no scrolling, no virtualization gaps, no truncation
- **🔒 No manual auth** - Reuses your existing login via a same-origin request; nothing to paste

## How It Works

1. **Read the conversation id** from the page URL (`chatgpt.com/c/<id>`)
2. **Get your session token** from ChatGPT's own `/api/auth/session` endpoint (same-origin, uses your existing login cookies)
3. **Fetch the conversation** from `/backend-api/conversation/<id>` — the complete message tree in a single request
4. **Linearize the active branch** by walking from the current leaf (`current_node`) up to the root and reversing, so the export matches exactly what you see on screen
5. **Render Markdown** from each message's structured content (text, code blocks, images) with `## You:` / `## ChatGPT:` headers and timestamps

### Why the API approach?

An earlier version of this tool scraped the rendered page and clicked copy buttons, like the Claude exporter does. That works for Claude because claude.ai keeps the whole conversation in the DOM. **ChatGPT virtualizes long chats** — it removes off-screen messages from the page — so DOM scraping had to drive a fragile scroll loop and constantly hit ordering, truncation, and missed-message bugs.

Reading the backend API instead makes all of those problems disappear:

```
❌ DOM scraping (virtualized page):
- Must scroll a moving target; misses messages
- Ordering depends on capture timing
- Long answers get truncated
- Breaks whenever the UI markup changes

✅ Backend API:
- Whole conversation in one request
- Roles, order, timestamps are authoritative fields
- Nothing to scroll, nothing to miss
- Only depends on one stable endpoint
```

## Usage

1. Open the conversation you want to export on [chatgpt.com](https://chatgpt.com) (URL should look like `chatgpt.com/c/...`).
2. Open the browser's developer console:
   - Chrome/Edge: Press F12 or Ctrl+Shift+J (Windows/Linux) or Cmd+Option+J (Mac)
   - Firefox: Press F12 or Ctrl+Shift+K (Windows/Linux) or Cmd+Option+K (Mac)
   - Safari: Enable the Develop menu in preferences, then press Cmd+Option+C
3. Copy the entire script in `chatgpt-chat-exporter.js` and paste it into the console.
4. Press Enter to run the script.
5. A file named `{conversation-title}.md` downloads automatically. The status chip shows how many messages were exported.

> The first time you paste into the console, some browsers require you to type `allow pasting` and press Enter before they'll accept pasted code.

## File Output

- **Filename**: `{conversation-title}.md` (falls back to `chatgpt_conversation`)
- **Format**: Markdown with `## You:` / `## ChatGPT:` headers and per-message timestamps
- **Content**: The full active thread, in order

## Example Output

```markdown
# Sorting algorithms comparison

## You (Feb 23, 2026, 10:30 AM):

Can you create a comparison table of sorting algorithms?

---

## ChatGPT (Feb 23, 2026, 10:30 AM):

Here's a comparison table of sorting algorithms:

| Algorithm   | Best Case  | Average Case | Worst Case | Space    | Stable |
| ----------- | ---------- | ------------ | ---------- | -------- | ------ |
| Bubble Sort | O(n)       | O(n²)        | O(n²)      | O(1)     | Yes    |
| Quick Sort  | O(n log n) | O(n log n)   | O(n²)      | O(log n) | No     |
| Merge Sort  | O(n log n) | O(n log n)   | O(n log n) | O(n)     | Yes    |

---
```

## Troubleshooting

**`No conversation id in the URL`** - Open a specific chat first; the URL must contain `/c/<id>`. The script can't export the new-chat landing page.

**`Could not read your session token`** - You're not logged in, or the session endpoint changed. Make sure you're signed in to chatgpt.com in this tab.

**`Conversation fetch failed (HTTP 401/403)`** - The script retries with a workspace account id automatically. If it still fails on a Team/Enterprise workspace, the account-id endpoint may have changed — see [Maintenance](#maintenance).

**`Conversation fetch failed (HTTP 404)`** - The conversation id wasn't found for your account (wrong tab, or a shared link you don't own).

## Maintenance

The tool depends on three ChatGPT endpoints. If OpenAI renames them, update these constants in the script:

- Session token: `/api/auth/session` → `accessToken`
- Conversation: `/backend-api/conversation/<id>`
- Workspace account id (Team/Enterprise only): `/backend-api/accounts/check/...`

The message tree fields used are `mapping`, `current_node`, and per-message `author.role`, `content` (`content_type` + `parts`/`text`), `create_time`, `recipient`, and `metadata.is_visually_hidden_from_conversation`.

## Comparison with the Claude Exporter

| Aspect | Claude Exporter | ChatGPT Exporter |
| --- | --- | --- |
| Content source | Copy button + clipboard capture (DOM) | Backend conversation API |
| Ordering | DOM order of messages | `current_node` → root path (authoritative) |
| Virtualization | N/A (claude.ai keeps all in DOM) | N/A (API returns everything) |
| Timestamps | API (metadata) | API |
| Auth | Session cookies | Session token via `/api/auth/session` |

## Limitations

- **ChatGPT Web Only** - Works on the chatgpt.com web interface (uses your logged-in session)
- **Active branch only** - Exports the currently-visible thread; alternate branches from edits/regenerations aren't included (the full tree is available if you want to add this later)
- **Attachments** - Images and uploaded files are shown as `_[image]_` placeholders, not embedded
- **Endpoint churn** - If OpenAI renames the backend endpoints, the constants above need updating

## Privacy & Security

- **Local Processing** - Everything runs in your browser
- **Same-Origin Only** - Requests go only to ChatGPT's own backend using your existing session; no third-party services
- **No Data Storage** - The conversation is fetched, converted, and downloaded immediately

## Disclaimer

This script is not officially associated with OpenAI or ChatGPT. It is a community-created tool to enhance the user experience. Use it responsibly and in accordance with OpenAI's terms of service.
