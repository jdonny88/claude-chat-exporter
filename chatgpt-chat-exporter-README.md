# ChatGPT Chat Exporter

A JavaScript tool that exports ChatGPT conversations to **clean Markdown** by leveraging ChatGPT's native copy functionality. It's the sibling of [Claude Chat Exporter](./README.md) in this repo, using the same paste-in-console workflow.

## Features

- **🎯 High Markdown Fidelity** - Uses ChatGPT's copy button for exact output on assistant messages (tables, code, math, etc.)
- **🗣️ Correct Speaker Labels** - Reads each turn's `data-message-author-role` attribute, so no guessing who said what
- **⏩ True Conversation Order** - Captures turns in DOM order, preserving interleaving exactly
- **📁 Smart Filename Generation** - Uses the conversation title from the sidebar/document title
- **📈 Real-Time Status** - Visual progress indicator during export
- **🛡️ Graceful Fallback** - Falls back to reading a user message's text directly if no copy button is present
- **⚙️ Easy Maintenance** - Modular selectors for UI changes

## How It Works

1. **Find Turns** - Selects every conversation turn (`[data-testid^="conversation-turn"]`) in DOM order
2. **Identify Speaker** - Reads each turn's `data-message-author-role` (`user` or `assistant`)
3. **Capture Content** - Clicks the turn's copy button and captures the write via an intercepted `navigator.clipboard.writeText`; for user turns without a copy button, reads the plain text directly
4. **Perfect Output** - Combines all captured turns into a single Markdown file with `## You:` / `## ChatGPT:` headers

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
2. Scroll through the **entire** conversation once so every message is loaded into the DOM (ChatGPT virtualizes long chats).
3. Open the browser's developer console:
   - Chrome/Edge: Press F12 or Ctrl+Shift+J (Windows/Linux) or Cmd+Option+J (Mac)
   - Firefox: Press F12 or Ctrl+Shift+K (Windows/Linux) or Cmd+Option+K (Mac)
   - Safari: Enable the Develop menu in preferences, then press Cmd+Option+C
4. Copy the entire script in `chatgpt-chat-exporter.js` and paste it into the console.
5. Press Enter to run the script.
6. A progress indicator appears and a file named `{conversation-title}.md` is downloaded automatically.

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
  copy: 100,          // Pause between turns in ms (increase if messages are missed)
  clipboardWait: 2000 // Max wait for a single copy button's write in ms
};
```

### UI Selector Updates

If ChatGPT's interface changes, update the `SELECTORS` object:

```javascript
const SELECTORS = {
  conversationTurn: 'article[data-testid^="conversation-turn"], div[data-testid^="conversation-turn"]',
  authorRole: '[data-message-author-role]',
  copyButton: 'button[data-testid="copy-turn-action-button"], button[aria-label="Copy"]',
  userMessageText: '.whitespace-pre-wrap'
};
```

The `authorRole` selector is what distinguishes user from assistant turns — ChatGPT tags every message container with `data-message-author-role`.

## Troubleshooting

### Export Status Indicators

- `Exporting messages...` - Walking through turns
- `You: X | ChatGPT: Y` - Live capture counts
- `✅ Downloaded: filename.md` - Success!

### Common Issues

**No Messages Captured**

- Ensure the conversation is fully loaded and scrolled through top to bottom
- Check that messages are visible on screen
- ChatGPT virtualizes long chats — off-screen turns may be removed from the DOM

**Partial Export**

- Long conversations may drop off-screen turns; scroll through the whole chat first, then run the script
- If a mismatch persists, refresh the page and try again

## Comparison with the Claude Exporter

| Aspect | Claude Exporter | ChatGPT Exporter |
| --- | --- | --- |
| Speaker detection | Presence of a feedback button | `data-message-author-role` attribute |
| Capture order | Two phases (all human, then all Claude) | Single pass in true DOM order |
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
- **Visible Messages Only** - Only exports turns currently in the DOM (scroll through long chats first)
- **No Timestamps** - This auth-free version does not fetch message times
- **No Attachments / Artifacts** - Uploaded files, images, and canvas content are skipped

## Privacy & Security

- **Local Processing** - Everything runs in your browser
- **No Third-Party Services** - No network requests to anywhere but ChatGPT itself
- **Temporary Interception** - Clipboard write is restored after export
- **No Data Storage** - Messages are processed and downloaded immediately

## Disclaimer

This script is not officially associated with OpenAI or ChatGPT. It is a community-created tool to enhance the user experience. Use it responsibly and in accordance with OpenAI's terms of service.
