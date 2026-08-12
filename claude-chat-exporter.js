function setupClaudeExporter() {
  // Status indicator
  const statusDiv = document.createElement('div');
  statusDiv.style.cssText = `
    position: fixed; top: 10px; right: 10px; z-index: 10000;
    background: #2196F3; color: white; padding: 10px 15px;
    border-radius: 5px; font-family: monospace; font-size: 12px;
    box-shadow: 0 2px 10px rgba(0,0,0,0.3); max-width: 320px;
  `;
  document.body.appendChild(statusDiv);
  function setStatus(text, color) {
    statusDiv.textContent = text;
    if (color) statusDiv.style.background = color;
  }

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

  function sanitizeTitle(raw) {
    return String(raw || '')
      .replace(/[<>:"/\\|?*]/g, '_')
      .replace(/\s+/g, '_')
      .replace(/_{2,}/g, '_')
      .replace(/^_+|_+$/g, '')
      .toLowerCase()
      .substring(0, 100);
  }

  // Format ISO timestamp to readable format
  function formatTimestamp(isoString) {
    if (!isoString) return null;
    return new Date(isoString).toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit'
    });
  }

  // --- Data source: Claude's own conversation API --------------------------

  async function fetchConversationData() {
    const conversationId = window.location.pathname.split('/').pop();
    const orgId = document.cookie.match(/lastActiveOrg=([^;]+)/)?.[1];

    if (!conversationId || !orgId) {
      throw new Error('Could not read conversation/org id. Open a specific chat first.');
    }

    const url = `/api/organizations/${orgId}/chat_conversations/${conversationId}?tree=true&rendering_mode=messages&render_all_tools=true`;

    const response = await fetch(url, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' }
    });

    if (!response.ok) {
      throw new Error(`Conversation fetch failed (HTTP ${response.status})`);
    }
    return response.json();
  }

  // --- Reconstruct the transcript from the message list --------------------

  // Join the text of a message's content blocks. Text blocks carry `.text`
  // (the raw Markdown Claude produced / the user typed); thinking, tool_use,
  // tool_result and artifact blocks have no `.text` and are skipped, which
  // matches the exporter's long-standing behavior.
  function extractText(msg) {
    if (!Array.isArray(msg.content)) return '';
    return msg.content
      .map(block => (typeof block.text === 'string' ? block.text : ''))
      .filter(Boolean)
      .join('\n\n')
      .trim();
  }

  // Claude's data doesn't return image bytes inline the way ChatGPT's does, so
  // we emit a placeholder for anything image-like. Uploads can appear either as
  // `image` content blocks or (more commonly on claude.ai) in message-level
  // file arrays, so check both. Best-effort across the likely field names.
  function extractImagePlaceholders(msg) {
    const placeholders = [];

    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block && block.type === 'image') placeholders.push('_[image]_');
      }
    }

    const fileArrays = [msg.files_v2, msg.files, msg.attachments].filter(Array.isArray);
    for (const arr of fileArrays) {
      for (const f of arr) {
        const name = f?.file_name || f?.name || '';
        const kind = String(f?.file_kind || f?.type || f?.file_type || '').toLowerCase();
        const looksImage = kind.includes('image') || /\.(png|jpe?g|gif|webp|bmp|svg|heic)$/i.test(name);
        if (looksImage) placeholders.push(name ? `_[image: ${name}]_` : '_[image]_');
      }
    }

    return placeholders;
  }

  function getConversationTitle(data) {
    const name = sanitizeTitle(data?.name);
    if (name && name !== 'new_conversation') return name;
    return 'claude_conversation';
  }

  // Render an ordered list of {who, role, ts, content} into Markdown, grouping
  // messages into exchanges and numbering both. An exchange begins at each
  // user message (and at the first message if it isn't a user message). A
  // horizontal rule separates exchanges; there is none between messages within
  // an exchange.
  function renderConversation(headerBlock, rendered) {
    let e = 0;
    rendered.forEach((m, i) => {
      if (m.role === 'user' || i === 0) e++;
      m.exchange = e;
    });
    const totalExchanges = e;
    const total = rendered.length;

    let md = headerBlock;
    rendered.forEach((m, i) => {
      if (i === 0 || m.exchange !== rendered[i - 1].exchange) {
        if (i !== 0) md += `---\n\n`;
        md += `## Exchange ${m.exchange}/${totalExchanges}\n\n`;
      }
      const num = `${i + 1}/${total}`;
      const header = m.ts ? `## Message ${num} - ${m.who} (${m.ts}):` : `## Message ${num} - ${m.who}:`;
      md += `${header}\n\n${m.content}\n\n`;
    });
    return md;
  }

  function buildMarkdown(data) {
    const messages = data?.chat_messages || [];

    // Collect the renderable messages first so we can number them and group
    // them into exchanges.
    const rendered = [];
    for (const msg of messages) {
      const sender = msg.sender; // 'human' | 'assistant'
      if (sender !== 'human' && sender !== 'assistant') continue;

      const text = extractText(msg);
      const images = extractImagePlaceholders(msg);
      // Image placeholders first (they're attached above the message text).
      const body = [images.join('\n'), text].filter(Boolean).join('\n\n');
      if (!body) continue;

      rendered.push({
        role: sender === 'human' ? 'user' : 'assistant',
        who: sender === 'human' ? 'You' : 'Claude',
        ts: formatTimestamp(msg.created_at),
        content: body
      });
    }

    const markdown = renderConversation('# Conversation with Claude\n\n', rendered);
    return { markdown, count: rendered.length };
  }

  // --- Orchestration -------------------------------------------------------

  async function startExport() {
    try {
      setStatus('Fetching conversation...');
      const data = await fetchConversationData();

      setStatus('Building Markdown...');
      const { markdown, count } = buildMarkdown(data);

      if (count === 0) {
        throw new Error('No messages found in the conversation payload.');
      }

      const filename = `${getConversationTitle(data)}.md`;
      downloadMarkdown(markdown, filename);

      setStatus(`✅ Downloaded ${count} messages: ${filename}`, '#4CAF50');
      console.log(`🎉 Export complete — ${count} messages → ${filename}`);
    } catch (error) {
      setStatus(`Error: ${error.message}`, '#f44336');
      console.error('Export failed:', error);
    } finally {
      setTimeout(() => {
        if (document.body.contains(statusDiv)) document.body.removeChild(statusDiv);
      }, 6000);
    }
  }

  startExport();
}

// Run the exporter
setupClaudeExporter();
