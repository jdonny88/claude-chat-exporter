function setupChatGPTExporter() {
  const clipboard = navigator.clipboard;
  const originalWriteText = clipboard.writeText.bind(clipboard);
  const originalWrite = clipboard.write ? clipboard.write.bind(clipboard) : null;
  const messages = [];
  let interceptorActive = true;
  let clipboardResolver = null;

  // DOM Selectors - easily modifiable if ChatGPT's UI changes.
  // The primary anchor is data-message-author-role, which ChatGPT puts on
  // every message container and has kept stable across many UI revisions.
  const SELECTORS = {
    message: '[data-message-author-role]',
    // Ancestors searched (nearest first) to find a turn's copy button.
    copyButton: 'button[data-testid="copy-turn-action-button"], button[aria-label="Copy"]',
    // Fallbacks for reading content directly from the DOM.
    assistantMarkdown: '.markdown, .prose',
    userMessageText: '.whitespace-pre-wrap'
  };

  const DELAYS = {
    copy: 100,           // Pause between turns so the clipboard write can land
    clipboardWait: 2000, // Max time to wait for a single copy button's write
    scrollSettle: 400    // Pause after each scroll step so new turns can render
  };

  const SCROLL = {
    maxSteps: 400,       // Hard cap on scroll iterations (safety valve)
    stableRounds: 3      // Stop once no new turns appear this many rounds at the bottom
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

  function deliverCapture(text) {
    if (interceptorActive && text && clipboardResolver) {
      const resolve = clipboardResolver;
      clipboardResolver = null;
      resolve(text);
      return true;
    }
    return false;
  }

  // Pull the text/plain payload out of a clipboard.write() ClipboardItem list.
  async function extractText(items) {
    try {
      for (const item of items || []) {
        if (item.types?.includes('text/plain')) {
          const blob = await item.getType('text/plain');
          return await blob.text();
        }
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  // Intercept clipboard writes to capture copy-button output. While exporting
  // we do NOT forward to the real clipboard: the browser blocks it when the
  // page isn't focused (DevTools has focus), which spams NotAllowedError, and
  // forwarding would also clobber the user's actual clipboard. Both originals
  // are restored on cleanup.
  clipboard.writeText = function(text) {
    if (interceptorActive) {
      deliverCapture(text);
      return Promise.resolve();
    }
    return originalWriteText(text);
  };

  if (originalWrite) {
    clipboard.write = function(items) {
      if (interceptorActive) {
        extractText(items).then(deliverCapture);
        return Promise.resolve();
      }
      return originalWrite(items);
    };
  }

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

  // Log how many elements each candidate selector matches, so a "nothing
  // found" failure tells us exactly which selector needs updating.
  function diagnoseSelectors() {
    const candidates = [
      '[data-message-author-role]',
      'article[data-testid^="conversation-turn"]',
      '[data-testid^="conversation-turn"]',
      'main article',
      'button[data-testid="copy-turn-action-button"]',
      'button[aria-label="Copy"]'
    ];
    console.group('🔎 ChatGPT exporter selector diagnostics');
    candidates.forEach(sel => {
      let n = 0;
      try { n = document.querySelectorAll(sel).length; } catch (e) { n = -1; }
      console.log(`${String(n).padStart(4)}  ${sel}`);
    });
    console.groupEnd();
  }

  function getMessages() {
    return Array.from(document.querySelectorAll(SELECTORS.message));
  }

  function getRole(msgEl) {
    return msgEl.getAttribute('data-message-author-role') || null;
  }

  // A stable identifier so we never capture a turn twice and never lose
  // ordering as ChatGPT adds/removes turns from the DOM while we scroll.
  // Prefer the message UUID; fall back to role + a slice of its text.
  function getTurnKey(msgEl, role) {
    const id = msgEl.getAttribute('data-message-id');
    if (id) return id;
    const text = msgEl.textContent?.trim().slice(0, 120) || '';
    return `${role}:${text}`;
  }

  // Find a turn's copy button by walking up from the message element and
  // returning the nearest ancestor whose subtree contains one. Walking from
  // the message outward means we hit that message's own action bar first.
  function findCopyButton(msgEl) {
    let el = msgEl;
    for (let i = 0; i < 6 && el; i++) {
      const btn = el.querySelector?.(SELECTORS.copyButton);
      if (btn) return btn;
      el = el.parentElement;
    }
    return null;
  }

  // Find the scrollable conversation container so we can drive it top to
  // bottom. ChatGPT virtualizes long chats, removing off-screen turns.
  // Detection is BEHAVIORAL rather than CSS-based: among the message's
  // scrollable-looking ancestors, pick the first whose scrollTop actually
  // moves when we nudge it. This is robust to class/style changes.
  function getScrollContainer() {
    let el = getMessages()[0]?.parentElement;
    const candidates = [];
    while (el && el !== document.body && el !== document.documentElement) {
      if (el.scrollHeight > el.clientHeight + 20) candidates.push(el);
      el = el.parentElement;
    }
    candidates.push(document.scrollingElement || document.documentElement);

    for (const c of candidates) {
      const orig = c.scrollTop;
      c.scrollTop = orig + 20;
      const moved = c.scrollTop !== orig;
      c.scrollTop = orig;
      if (moved) return c;
    }
    return candidates[candidates.length - 1];
  }

  // ChatGPT collapses very long messages behind a "Show more" toggle and may
  // keep the hidden portion out of the DOM until expanded. Click any such
  // toggle within the turn so the full content is present before we capture.
  function expandCollapsed(msgEl) {
    const scope = msgEl.closest('article') || msgEl.parentElement || msgEl;
    let expanded = false;
    for (const btn of scope.querySelectorAll('button')) {
      const label = (btn.textContent || '').trim().toLowerCase();
      if (label === 'show more' || label === 'read more' || label === 'see more') {
        try { btn.click(); expanded = true; } catch (e) { /* ignore */ }
      }
    }
    return expanded;
  }

  // Capture one message's content. Assistant turns are copied via the button
  // for markdown fidelity; if no button is available we fall back to reading
  // the rendered text directly (degraded, but better than losing the turn).
  async function captureTurn(msgEl, role) {
    if (expandCollapsed(msgEl)) {
      await delay(DELAYS.copy); // let the expanded content render
    }

    const copyBtn = findCopyButton(msgEl);

    if (copyBtn) {
      // Note: no scrollIntoView here — clicking works even when the button is
      // off-screen, and scrolling during capture fights the main scroll loop.
      const pending = captureNextClipboard(DELAYS.clipboardWait);
      copyBtn.click();
      const text = await pending;
      if (text) return text;
    }

    // Fallbacks: read rendered text straight from the DOM.
    const fallbackEl = role === 'user'
      ? (msgEl.querySelector(SELECTORS.userMessageText) || msgEl)
      : (msgEl.querySelector(SELECTORS.assistantMarkdown) || msgEl);
    const text = fallbackEl?.innerText?.trim();
    return text || null;
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

  // Scroll the conversation top to bottom, capturing turns as they render.
  // Turns above AND below the viewport get removed from the DOM, so we capture
  // each turn the moment it is present, deduping by getTurnKey to stay
  // complete and ordered.
  // Capture every not-yet-seen message currently in the DOM, in order.
  async function captureVisible(seen) {
    for (const msgEl of getMessages()) {
      const role = getRole(msgEl);
      if (role !== 'user' && role !== 'assistant') continue;

      const key = getTurnKey(msgEl, role);
      if (seen.has(key)) continue;
      seen.add(key);

      const content = await captureTurn(msgEl, role);

      if (content) {
        messages.push({ role, content });
        console.log(`📋 Captured ${role} message ${messages.length}`);
        updateStatus();
      } else {
        console.warn(`⚠️ Could not capture ${role} turn (key ${key})`);
      }

      await delay(DELAYS.copy);
    }
  }

  async function scrollAndCapture() {
    const container = getScrollContainer();
    const seen = new Set();
    const maxScrollNow = () => Math.max(0, container.scrollHeight - container.clientHeight);
    console.log('📜 Scroll container:', container.tagName, container.className || '(no class)');
    console.log(`📜 Start: DOM messages=${getMessages().length}, scrollHeight=${container.scrollHeight}, clientHeight=${container.clientHeight}, maxScroll=${maxScrollNow()}`);

    container.scrollTop = 0;
    await delay(DELAYS.scrollSettle);

    let stableRounds = 0;

    for (let step = 0; step < SCROLL.maxSteps; step++) {
      const sizeBefore = seen.size;
      await captureVisible(seen);

      // Advance STRICTLY downward, one chunk at a time, clamped to the bottom.
      // No scrollIntoView anywhere — monotonic scrolling prevents the
      // oscillation that stalled loading. Recompute the max each step since
      // scrollHeight changes as turns render/unrender.
      const topBefore = container.scrollTop;
      const target = Math.min(topBefore + Math.max(container.clientHeight * 0.6, 300), maxScrollNow());
      container.scrollTop = target;
      await delay(DELAYS.scrollSettle);

      const grew = seen.size > sizeBefore;
      const atBottom = container.scrollTop >= maxScrollNow() - 4;

      if (step % 5 === 0 || atBottom) {
        console.log(`📜 step ${step}: scrollTop=${Math.round(container.scrollTop)}/${Math.round(maxScrollNow())}, DOM=${getMessages().length}, captured=${messages.length}, atBottom=${atBottom}`);
      }

      statusDiv.textContent = `Scanning... (${messages.length} captured)`;

      // Stop only once we're actually at the bottom and nothing new is being
      // captured for a few consecutive rounds.
      if (atBottom && !grew) {
        stableRounds++;
        if (stableRounds >= SCROLL.stableRounds) break;
      } else {
        stableRounds = 0;
      }
    }

    // Final sweep in case the last turns rendered after the loop's last capture.
    await captureVisible(seen);
    console.log(`📜 Finished scanning: ${messages.length} messages captured`);
  }

  async function startExport() {
    try {
      if (getMessages().length === 0) {
        diagnoseSelectors();
        throw new Error(
          'No messages found via [data-message-author-role]. ChatGPT may have ' +
          'changed its DOM — see the selector diagnostics logged above.'
        );
      }

      // Auto-scroll through the whole conversation, capturing turns as they
      // render so virtualized (off-screen) messages are not missed.
      await scrollAndCapture();

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
    clipboard.writeText = originalWriteText;
    if (originalWrite) clipboard.write = originalWrite;
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
