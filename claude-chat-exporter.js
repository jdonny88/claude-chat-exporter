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

  // Render a message from its content blocks: text blocks carry the raw
  // Markdown Claude produced / the user typed; output tool calls (artifacts,
  // file creation) become a marker; thinking and tool-result blocks are
  // skipped. See extractText below.
  function basename(path) {
    return String(path || '').split('/').pop() || '';
  }

  // Derive the display title Claude's UI shows for a file: drop the extension,
  // turn separators into spaces, and sentence-case it.
  // "critique-and-evaluation-sherpa-note.md" -> "Critique and evaluation sherpa note"
  function prettyTitle(filename) {
    const words = basename(filename).replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim();
    return words ? words.charAt(0).toUpperCase() + words.slice(1) : '';
  }

  // Markers for output-producing tool calls, so the transcript records that a
  // response created/updated an artifact or file even though we don't embed
  // its content. Returns {key, text} entries (key is used to dedupe, e.g. a
  // create_file + present_files pair for the same file → one marker). File
  // markers carry both the filename and the derived title: "name.md | Title".
  function artifactMarkers(block) {
    const name = block.name;
    const input = block.input || {};
    const out = [];

    const fileMarker = (base) => ({
      key: `f:${base}`,
      text: `_[Artifact: ${base} | ${prettyTitle(base)}]_`
    });

    if (name === 'artifacts') {
      // Classic side-panel artifacts (documents, code, React, etc.).
      const title = input.title || input.id || 'artifact';
      const type = input.type ? ` (${input.type})` : '';
      out.push({ key: `a:${title}`, text: `_[Artifact: "${title}"${type}]_` });
    } else if (name === 'create_file' || name === 'update_file' || name === 'str_replace_file') {
      const base = basename(input.path || input.filename);
      if (base) out.push(fileMarker(base));
    } else if (name === 'present_files') {
      for (const p of (input.filepaths || [])) {
        const base = basename(p);
        if (base) out.push(fileMarker(base));
      }
    }

    return out;
  }

  // Build a message body from its content blocks: keep text blocks in order,
  // and collect artifact markers to append at the END of the message (mirroring
  // the UI, where produced files appear grouped below the response). Non-output
  // tool calls, tool results, and thinking blocks are skipped.
  function extractText(msg) {
    if (!Array.isArray(msg.content)) return '';

    const textParts = [];
    const markers = [];
    const seen = new Set();

    for (const block of msg.content) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        textParts.push(block.text.trim());
      } else if (block.type === 'tool_use') {
        for (const marker of artifactMarkers(block)) {
          if (seen.has(marker.key)) continue;
          seen.add(marker.key);
          markers.push(marker.text);
        }
      }
    }

    return [...textParts, ...markers].join('\n\n').trim();
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

  // The conversation is a tree: editing a prompt or regenerating a reply
  // creates branches, and chat_messages (with tree=true) contains ALL of them.
  // The thread that actually steers the conversation is the path from the
  // active leaf (current_leaf_message_uuid) up to the root. Walk parents and
  // reverse to get just that thread in order, dropping abandoned branches.
  function linearizeActiveBranch(data) {
    const messages = data?.chat_messages || [];
    const byUuid = new Map();
    for (const m of messages) byUuid.set(m.uuid, m);

    const chain = [];
    const guard = new Set(); // cycle protection
    let cur = data?.current_leaf_message_uuid;
    while (cur && byUuid.has(cur) && !guard.has(cur)) {
      guard.add(cur);
      chain.push(byUuid.get(cur));
      cur = byUuid.get(cur).parent_message_uuid;
    }
    chain.reverse();

    // Fallback to raw order if the leaf/parent fields aren't resolvable.
    return chain.length ? chain : messages;
  }

  function buildMarkdown(data) {
    const messages = linearizeActiveBranch(data);

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
