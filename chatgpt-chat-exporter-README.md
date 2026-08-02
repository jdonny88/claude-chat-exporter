# ChatGPT Chat Exporter

A JavaScript tool that exports ChatGPT conversations to **clean Markdown** by leveraging ChatGPT's native copy functionality. It's the sibling of [Claude Chat Exporter](./README.md) in this repo, using the same paste-in-console workflow.

## Features

- **🎯 High Markdown Fidelity** - Uses ChatGPT's copy button for exact output on assistant messages (tables, code, math, etc.)
- **🗣️ Correct Speaker Labels** - Reads each turn's `data-message-author-role` attribute, so no guessing who said what
- **📜 Auto-Scroll (handles virtualization)** - Scrolls the whole conversation for you, capturing turns as they render, so off-screen messages in long chats aren't missed
- **⏩ True Conversation Order** - Captures turns in order and dedupes by `data-message-id`, preserving interleaving exactly
- **📁 Smart Filename Generation** - Uses the conversation title from the sidebar/document title
- **📈 Real-Time Status** - Visual progress indicator during export
- **🛡️ Graceful Fallback** - Falls back to reading a user message's text directly if no copy button is present
- **⚙️ Easy Maintenance** - Modular selectors for UI changes

## How It Works

1. **Auto-Scroll** - Scrolls the conversation from top to bottom, letting ChatGPT render turns that were virtualized (removed from the DOM while off-screen)
2. **Find Turns** - Selects every conversation turn (`[data-testid^="conversation-turn"]`) as it renders
3. **Identify Speaker** - Reads each turn's `data-message-author-role` (`user` or `assistant`)
4. **Capture Content** - Clicks the turn's copy button and captures the write via an intercepted `navigator.clipboard.writeText`; for user turns without a copy button, reads the plain text directly. Each turn is deduped by its `data-message-id` so nothing is captured twice or lost as the DOM changes
5. **Perfect Output** - Combines all captured turns into a single Markdown file with `## You:` / `## ChatGPT:` headers

### Why the Copy Button Approach?

Instead of manually parsing HTML into Markdown (which mangles tables, code fences, and math), this tool uses **ChatGPT's own copy button** for assistant messages to get accurate Markdown for the hard cases.

```
❌ Manual HTML Parsing:
- Misses tables and complex elements
- Requires constant updates for new features
- Error-prone formatting conversion

✅ Copy Button Method:
- High markdown fidelity
- Automatic support for most elements
- Fewer formatting edge cases
```

> **Note:** This is an intentionally auth-free, DOM-only approach. ChatGPT also exposes a structured JSON payload at `/backend-api/conversation/{id}` that would be even more robust, but reading it requires the session access token. That's a possible future upgrade — see [Roadmap](#roadmap).

## Usage

1. Open your conversation on [chatgpt.com](https://chatgpt.com) in your web browser.
2. Open the browser's developer console:
   - Chrome/Edge: Press F12 or Ctrl+Shift+J (Windows/Linux) or Cmd+Option+J (Mac)
   - Firefox: Press F12 or Ctrl+Shift+K (Windows/Linux) or Cmd+Option+K (Mac)
   - Safari: Enable the Develop menu in preferences, then press Cmd+Option+C
3. Copy the entire script in `chatgpt-chat-exporter.js` and paste it into the console.
4. Press Enter to run the script.
5. The script **auto-scrolls** through the whole conversation (you'll see the page scroll and the counter climb), then downloads a file named `{conversation-title}.md` automatically.

> **Tip:** You no longer need to scroll manually first — the script does it for you. Just leave the tab focused and let it run; very long chats take a bit longer while it walks through every turn.

## File Output

- **Filename**: `{conversation-title}.md` (from sidebar/document title, falls back to `chatgpt_conversation`)
- **Format**: Markdown matching ChatGPT's copy output
- **Content**: Complete conversation in order with `## You:` / `## ChatGPT:` headers
- **Encoding**: UTF-8 with standard line endings

## Example Output

```markdown
# Conversation with ChatGPT

## You:

Can you create a comparison table of sorting algorithms?

---

## ChatGPT:

Here's a comparison table of sorting algorithms:

| Algorithm   | Best Case  | Average Case | Worst Case | Space    | Stable |
| ----------- | ---------- | ------------ | ---------- | -------- | ------ |
| Bubble Sort | O(n)       | O(n²)        | O(n²)      | O(1)     | Yes    |
| Quick Sort  | O(n log n) | O(n log n)   | O(n²)      | O(log n) | No     |
| Merge Sort  | O(n log n) | O(n log n)   | O(n log n) | O(n)     | Yes    |

---
```

## Configuration

### Performance Tuning

Adjust the delays in the `DELAYS` object:

```javascript
const DELAYS = {
  copy: 100,           // Pause between turns in ms (increase if messages are missed)
  clipboardWait: 2000, // Max wait for a single copy button's write in ms
  scrollSettle: 400    // Pause after each scroll step so new turns can render
};

const SCROLL = {
  maxSteps: 400,   // Hard cap on scroll iterations (safety valve)
  stableRounds: 3  // Stop once no new turns appear this many rounds at the bottom
};
```

On slow connections, increase `scrollSettle` so virtualized turns have time to render before the next scroll step. For very long chats, raise `maxSteps` if the export stops before reaching the bottom.

### UI Selector Updates

If ChatGPT's interface changes, update the `SELECTORS` object:

```javascript
const SELECTORS = {
  message: '[data-message-author-role]',
  copyButton: 'button[data-testid="copy-turn-action-button"], button[aria-label="Copy"]',
  assistantMarkdown: '.markdown, .prose',
  userMessageText: '.whitespace-pre-wrap'
};
```

The `message` selector is the backbone: ChatGPT tags every message container with `data-message-author-role` (`user` / `assistant`) and a `data-message-id`, which the script uses both to label speakers and to dedupe turns while scrolling. If an export fails with "No messages found", the script logs **selector diagnostics** to the console showing which candidate selectors matched — use that to spot what changed.

## Troubleshooting

### Export Status Indicators

- `Loading messages...` / `Scanning... (N captured)` - Auto-scrolling and capturing turns
- `You: X | ChatGPT: Y` - Live capture counts
- `✅ Downloaded: filename.md` - Success!

### Common Issues

**No Messages Captured**

- Ensure the conversation is open and at least the first messages are visible
- Keep the tab focused while the script runs (background tabs may throttle scrolling)

**Partial Export**

- If the export stops before the bottom on a very long chat, increase `SCROLL.maxSteps`
- On slow connections, increase `DELAYS.scrollSettle` so turns have time to render
- If a mismatch persists, refresh the page and try again

**`NotAllowedError: ... Document is not focused` in the console**

- Harmless and handled: while exporting, the script captures copy-button output without forwarding it to the real clipboard (so it never touches your actual clipboard and doesn't need page focus). If you still see these, you're likely on an older copy of the script — re-grab the latest.

## Comparison with the Claude Exporter

| Aspect | Claude Exporter | ChatGPT Exporter |
| --- | --- | --- |
| Speaker detection | Presence of a feedback button | `data-message-author-role` attribute |
| Capture order | Two phases (all human, then all Claude) | Single pass in true DOM order, deduped by `data-message-id` |
| Virtualization | Manual "scroll first" advice | Automatic top-to-bottom auto-scroll |
| Timestamps | Fetched from Claude's API | Not included (auth-free, DOM-only) |
| Content source | Copy button + clipboard intercept | Copy button + clipboard intercept (user fallback to text) |

## Roadmap

- **API-first mode** - Optionally read `/backend-api/conversation/{id}` (with the session access token from `/api/auth/session`) to remove DOM fragility and add timestamps and branch handling
- **Artifacts / attachments** - Export uploaded files and images
- **Branch selection** - Handle edited-message / regenerated branches explicitly

## Limitations

- **Requires JavaScript** - Must be enabled in browser
- **ChatGPT Web Only** - Works only on the chatgpt.com web interface
- **Susceptible to DOM changes** - Interface changes may require selector updates
- **No Timestamps** - This auth-free version does not fetch message times
- **No Attachments / Artifacts** - Uploaded files, images, and canvas content are skipped

## Privacy & Security

- **Local Processing** - Everything runs in your browser
- **No Third-Party Services** - No network requests to anywhere but ChatGPT itself
- **Temporary Interception** - Clipboard write is restored after export
- **No Data Storage** - Messages are processed and downloaded immediately

## Disclaimer

This script is not officially associated with OpenAI or ChatGPT. It is a community-created tool to enhance the user experience. Use it responsibly and in accordance with OpenAI's terms of service.
