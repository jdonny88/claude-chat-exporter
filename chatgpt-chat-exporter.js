function setupChatGPTExporter() {
  const originalWriteText = navigator.clipboard.writeText;
  const messages = [];
  let interceptorActive = true;
  let clipboardResolver = null;

  // DOM Selectors - easily modifiable if ChatGPT's UI changes
  const SELECTORS = {
    // Each conversation turn is an <article> (older builds used a plain div).
    conversationTurn: 'article[data-testid^="conversation-turn"], div[data-testid^="conversation-turn"]',
    // The role attribute lives on the message container inside each turn.
    authorRole: '[data-message-author-role]',
    // Assistant (and, on newer builds, user) turns expose a copy button.
    copyButton: 'button[data-testid="copy-turn-action-button"], button[aria-label="Copy"]',
    // Fallback for reading a user message directly when it has no copy button.
    userMessageText: '.whitespace-pre-wrap'
  };

  const DELAYS = {
    copy: 100,          // Pause between turns so the clipboard write can land
    clipboardWait: 2000 // Max time to wait for a single copy button's write
  };

  function downloadMarkdown(content, filename) {
    const blob = new Blob([content], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  }

  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function sanitizeTitle(raw) {
    return raw
      .replace(/[<>:"/\\|?*]/g, '_')
      .replace(/\s+/g, '_')
      .replace(/_{2,}/g, '_')
      .replace(/^_+|_+$/g, '')
      .toLowerCase()
      .substring(0, 100);
  }

  function getConversationTitle() {
    // Prefer the active conversation entry in the sidebar.
    const activeNav = document.querySelector('nav a[data-active], nav a[aria-current="page"]');
    const navTitle = activeNav?.textContent?.trim();
    if (navTitle) {
      const clean = sanitizeTitle(navTitle);
      if (clean) return clean;
    }

    // Fall back to the document title (ChatGPT sets it to the chat name).
    const docTitle = document.title?.replace(/\s*[-|]\s*ChatGPT.*$/i, '').trim();
    if (docTitle && docTitle.toLowerCase() !== 'chatgpt') {
      const clean = sanitizeTitle(docTitle);
      if (clean) return clean;
    }

    return 'chatgpt_conversation';
  }

  // Intercept clipboard writes so a copy button click can be captured, then
  // still forward to the real clipboard so the user's clipboard is untouched
  // in spirit (restored fully on cleanup).
  navigator.clipboard.writeText = function(text) {
    if (interceptorActive && text && clipboardResolver) {
      const resolve = clipboardResolver;
      clipboardResolver = null;
      resolve(text);
    }
    return originalWriteText.apply(this, arguments);
  };

  // Resolve with the next intercepted clipboard write, or null on timeout.
  function captureNextClipboard(timeoutMs) {
    return new Promise(resolve => {
      let settled = false;
      clipboardResolver = (text) => {
        if (settled) return;
        settled = true;
        resolve(text);
      };
      setTimeout(() => {
        if (settled) return;
        settled = true;
        clipboardResolver = null;
        resolve(null);
      }, timeoutMs);
    });
  }

  // Status indicator
  const statusDiv = document.createElement('div');
  statusDiv.style.cssText = `
    position: fixed; top: 10px; right: 10px; z-index: 10000;
    background: #10a37f; color: white; padding: 10px 15px;
    border-radius: 5px; font-family: monospace; font-size: 12px;
    box-shadow: 0 2px 10px rgba(0,0,0,0.3); max-width: 300px;
  `;
  document.body.appendChild(statusDiv);

  function updateStatus() {
    const you = messages.filter(m => m.role === 'user').length;
    const gpt = messages.filter(m => m.role === 'assistant').length;
    statusDiv.textContent = `You: ${you} | ChatGPT: ${gpt}`;
  }

  function getRole(turn) {
    const roleEl = turn.querySelector(SELECTORS.authorRole);
    return roleEl?.getAttribute('data-message-author-role') || null;
  }

  // Capture one turn's content. Assistant turns are copied via the button for
  // perfect markdown fidelity; user turns use the button when present and
  // otherwise fall back to reading their plain-text content directly.
  async function captureTurn(turn, role) {
    const copyBtn = turn.querySelector(SELECTORS.copyButton);

    if (copyBtn) {
      if (copyBtn.scrollIntoView) {
        copyBtn.scrollIntoView({ behavior: 'instant', block: 'nearest' });
      }
      const pending = captureNextClipboard(DELAYS.clipboardWait);
      copyBtn.click();
      const text = await pending;
      if (text) return text;
    }

    // Fallback: read user message text straight from the DOM.
    if (role === 'user') {
      const textEl = turn.querySelector(SELECTORS.userMessageText) ||
                     turn.querySelector(SELECTORS.authorRole);
      const text = textEl?.innerText?.trim();
      if (text) return text;
    }

    return null;
  }

  function buildMarkdown() {
    let markdown = "# Conversation with ChatGPT\n\n";

    for (const msg of messages) {
      if (!msg.content) continue;
      const header = msg.role === 'user' ? '## You:' : '## ChatGPT:';
      markdown += `${header}\n\n${msg.content}\n\n---\n\n`;
    }

    return markdown;
  }

  async function startExport() {
    try {
      const turns = Array.from(document.querySelectorAll(SELECTORS.conversationTurn));

      if (turns.length === 0) {
        throw new Error('No conversation turns found! Make sure the chat is fully loaded.');
      }

      statusDiv.textContent = 'Exporting messages...';

      // Walk turns in DOM order so the transcript preserves interleaving.
      for (let i = 0; i < turns.length; i++) {
        const turn = turns[i];
        const role = getRole(turn);
        if (role !== 'user' && role !== 'assistant') continue;

        const content = await captureTurn(turn, role);
        if (content) {
          messages.push({ role, content });
          console.log(`📋 Captured ${role} message ${messages.length}`);
          updateStatus();
        } else {
          console.warn(`⚠️ Could not capture ${role} turn (${i + 1}/${turns.length})`);
        }

        if (i < turns.length - 1) {
          await delay(DELAYS.copy);
        }
      }

      completeExport();

    } catch (error) {
      statusDiv.textContent = `Error: ${error.message}`;
      statusDiv.style.background = '#f44336';
      console.error('Export failed:', error);
    } finally {
      setTimeout(cleanup, 3000);
    }
  }

  function completeExport() {
    interceptorActive = false;

    if (messages.length === 0) {
      statusDiv.textContent = 'No messages captured!';
      statusDiv.style.background = '#f44336';
      return;
    }

    const markdown = buildMarkdown();
    const filename = `${getConversationTitle()}.md`;
    downloadMarkdown(markdown, filename);

    statusDiv.textContent = `✅ Downloaded: ${filename}`;
    statusDiv.style.background = '#10a37f';

    console.log('🎉 Export complete!');
  }

  function cleanup() {
    navigator.clipboard.writeText = originalWriteText;
    if (document.body.contains(statusDiv)) {
      document.body.removeChild(statusDiv);
    }
  }

  // Initialize
  updateStatus();
  setTimeout(startExport, 1000);
}

// Run the exporter
setupChatGPTExporter();
