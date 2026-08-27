function setupChatGPTExporter() {
  // Status indicator
  const statusDiv = document.createElement('div');
  statusDiv.style.cssText = `
    position: fixed; top: 10px; right: 10px; z-index: 10000;
    background: #10a37f; color: white; padding: 10px 15px;
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

  // ChatGPT create_time is a Unix epoch in (fractional) seconds.
  function formatTimestamp(epochSeconds) {
    if (!epochSeconds) return null;
    return new Date(epochSeconds * 1000).toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit'
    });
  }

  // --- Data source: ChatGPT's own backend API -----------------------------

  function getConversationId() {
    // URLs look like /c/<uuid> or /g/g-xxxx/c/<uuid>.
    const m = location.pathname.match(/\/c\/([^/?#]+)/);
    return m ? m[1] : null;
  }

  // The web app authenticates backend-api calls with a Bearer token it reads
  // from the NextAuth session endpoint. Same-origin fetch reuses the user's
  // existing login cookies — no manual token handling.
  async function getAccessToken() {
    try {
      const res = await fetch('/api/auth/session', { credentials: 'include' });
      if (!res.ok) return null;
      const json = await res.json();
      return json.accessToken || null;
    } catch (e) {
      return null;
    }
  }

  // Team/Enterprise workspaces scope requests to an account id. Best-effort:
  // only needed if the plain request is rejected.
  async function getAccountId(token) {
    const endpoints = [
      '/backend-api/accounts/check/v4-2023-04-27',
      '/backend-api/accounts/check'
    ];
    for (const url of endpoints) {
      try {
        const res = await fetch(url, {
          credentials: 'include',
          headers: { 'Authorization': 'Bearer ' + token }
        });
        if (!res.ok) continue;
        const json = await res.json();
        const accounts = json.accounts || {};
        const ordering = json.account_ordering || Object.keys(accounts);
        for (const key of ordering) {
          const id = accounts[key]?.account?.account_id;
          if (id) return id;
        }
      } catch (e) { /* try next */ }
    }
    return null;
  }

  async function fetchConversation(convId, token) {
    const headers = { 'Authorization': 'Bearer ' + token };
    const url = '/backend-api/conversation/' + convId;

    let res = await fetch(url, { credentials: 'include', headers });
    if (res.status === 401 || res.status === 403) {
      const accountId = await getAccountId(token);
      if (accountId) {
        headers['Chatgpt-Account-Id'] = accountId;
        res = await fetch(url, { credentials: 'include', headers });
      }
    }
    if (!res.ok) {
      throw new Error(`Conversation fetch failed (HTTP ${res.status})`);
    }
    return res.json();
  }

  // --- Reconstruct the visible conversation from the message tree ----------

  // The conversation is a tree (edits/regenerations create branches). The
  // currently-visible thread is the path from the active leaf (current_node)
  // up to the root. Walk parents and reverse to get chronological order.
  function linearizeActiveBranch(data) {
    const mapping = data.mapping || {};

    let leafId = data.current_node;
    if (!leafId || !mapping[leafId]) {
      // Fallback: from the root, follow the last child down to a leaf.
      let rootId = Object.keys(mapping).find(id => mapping[id] && !mapping[id].parent);
      let id = rootId;
      while (id && mapping[id]?.children?.length) {
        id = mapping[id].children[mapping[id].children.length - 1];
      }
      leafId = id;
    }

    const nodes = [];
    let id = leafId;
    while (id && mapping[id]) {
      if (mapping[id].message) nodes.push(mapping[id]);
      id = mapping[id].parent;
    }
    nodes.reverse();
    return nodes;
  }

  // Whether a message node should appear in the exported transcript.
  function hasImagePart(message) {
    return (message?.content?.parts || [])
      .some(p => p && typeof p === 'object' && p.content_type === 'image_asset_pointer');
  }

  function isVisibleMessage(message) {
    if (!message) return false;
    if (message.metadata?.is_visually_hidden_from_conversation) return false;
    const role = message.author?.role;
    if (role === 'user') return true;
    // Assistant messages addressed to a tool (function calls) aren't shown.
    if (role === 'assistant') return !(message.recipient && message.recipient !== 'all');
    // Tool messages are noise (search, browsing) EXCEPT generated images.
    if (role === 'tool') return hasImagePart(message);
    return false; // system, etc.
  }

  // Markers for files attached to a message. Uploads live in
  // metadata.attachments; image uploads are skipped here because they already
  // come through the image_asset_pointer path (avoiding a double marker).
  function attachmentMarkers(message) {
    const markers = [];
    for (const a of (message?.metadata?.attachments || [])) {
      const mime = String(a?.mime_type || '').toLowerCase();
      if (mime.startsWith('image/')) continue;
      markers.push(`_[file: ${a?.name || 'file'}]_`);
    }
    return markers;
  }

  // ChatGPT embeds rich-content directives in the text as tokens delimited by
  // private-use characters: U+E200 <type> U+E202 <payload…> U+E201. In the app
  // these render as citation chips, image carousels, product cards; in raw text
  // they're noise. Strip citations, mark image groups and products.
  function cleanTokens(text) {
    if (!text) return text;
    // Capture an optional preceding space so stripping a mid-line citation
    // doesn't leave a double space; markers keep the space.
    let out = text.replace(/( ?)\uE200([^\uE201]*)\uE201/g, (_, sp, inner) => {
      const segs = inner.split('\uE202');
      const type = segs[0] || '';
      if (type === 'image_group') return sp + '_[Images]_';
      if (type === 'product') {
        let name = '';
        try {
          name = (JSON.parse(segs[1]) || []).find(x => typeof x === 'string' && !/^turn\d/.test(x)) || '';
        } catch (e) { /* ignore */ }
        return sp + (name ? `_[Product: ${name}]_` : '_[Product]_');
      }
      return ''; // cite / filecite / unknown directives (drop the space too)
    });
    out = out.replace(/[\uE200-\uE206]/g, '');           // sweep stray delimiters
    out = out.replace(/ +\n/g, '\n').replace(/\n{3,}/g, '\n\n'); // tidy whitespace
    return out;
  }

  // Turn a message's content object into Markdown text.
  function extractContent(message) {
    const c = message.content;
    if (!c) return '';
    const type = c.content_type;

    // Hidden chain-of-thought / reasoning summaries — not part of the answer.
    if (type === 'thoughts' || type === 'reasoning_recap') return '';

    if (type === 'text') {
      return cleanTokens((c.parts || []).filter(p => typeof p === 'string').join('\n\n').trim());
    }

    if (type === 'code') {
      const lang = c.language && c.language !== 'unknown' ? c.language : '';
      return '```' + lang + '\n' + (c.text || '') + '\n```';
    }

    if (type === 'multimodal_text') {
      const s = (c.parts || []).map(p => {
        if (typeof p === 'string') return p;
        if (p && p.content_type === 'image_asset_pointer') {
          // A dalle/generation metadata block marks an AI-produced image.
          const generated = p.metadata?.dalle || p.metadata?.generation;
          return generated ? '_[Generated image]_' : '_[image]_';
        }
        if (p && p.content_type === 'audio_transcription' && p.text) return p.text;
        return '';
      }).filter(Boolean).join('\n\n').trim();
      return cleanTokens(s);
    }

    // Reasonable fallbacks for less common content types.
    if (Array.isArray(c.parts)) {
      return cleanTokens(c.parts.filter(p => typeof p === 'string').join('\n\n').trim());
    }
    if (typeof c.text === 'string') return cleanTokens(c.text.trim());
    return '';
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

  function buildMarkdown(data, nodes) {
    const title = data.title?.trim();

    // Collect the renderable messages first so we can number them and group
    // them into exchanges.
    const rendered = [];
    for (const node of nodes) {
      const message = node.message;
      if (!isVisibleMessage(message)) continue;
      const content = extractContent(message);
      const files = attachmentMarkers(message);
      // Attachment markers first (they appear above the message in the UI).
      const body = [files.join('\n'), content].filter(Boolean).join('\n\n');
      if (!body) continue;
      rendered.push({
        role: message.author.role, // 'user' | 'assistant' | 'tool' (generated image)
        who: message.author.role === 'user' ? 'You' : 'ChatGPT',
        ts: formatTimestamp(message.create_time),
        content: body
      });
    }

    const markdown = renderConversation(`# ${title || 'Conversation with ChatGPT'}\n\n`, rendered);
    return { markdown, count: rendered.length };
  }

  function getFilename(data) {
    const title = sanitizeTitle(data.title);
    return `${title || 'chatgpt_conversation'}.md`;
  }

  // --- Orchestration -------------------------------------------------------

  async function startExport() {
    try {
      const convId = getConversationId();
      if (!convId) {
        throw new Error('No conversation id in the URL. Open a specific chat (chatgpt.com/c/...) first.');
      }

      setStatus('Authenticating...');
      const token = await getAccessToken();
      if (!token) {
        throw new Error('Could not read your session token from /api/auth/session. Are you logged in?');
      }

      setStatus('Fetching conversation...');
      const data = await fetchConversation(convId, token);

      setStatus('Building Markdown...');
      const nodes = linearizeActiveBranch(data);
      const { markdown, count } = buildMarkdown(data, nodes);

      if (count === 0) {
        throw new Error('No messages found in the conversation payload.');
      }

      const filename = getFilename(data);
      downloadMarkdown(markdown, filename);

      setStatus(`✅ Downloaded ${count} messages: ${filename}`, '#10a37f');
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
setupChatGPTExporter();
