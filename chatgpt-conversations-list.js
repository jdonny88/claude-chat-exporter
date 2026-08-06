function listChatGPTConversations() {
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

  const PAGE_LIMIT = 100;   // Max items per request the API allows
  const MAX_PAGES = 200;    // Safety cap (200 * 100 = 20k conversations)

  function download(content, filename, type) {
    const blob = new Blob([content], { type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  }

  // The conversations LIST endpoint returns create_time / update_time as ISO
  // strings, while the single-conversation endpoint uses epoch seconds. Handle
  // both: numbers are epoch seconds, strings are parsed directly.
  function fmt(value) {
    if (value == null || value === '') return '';
    const d = typeof value === 'number' ? new Date(value * 1000) : new Date(value);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit'
    });
  }

  function escapeCell(s) {
    return String(s || '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
  }

  async function getAccessToken() {
    try {
      const res = await fetch('/api/auth/session', { credentials: 'include' });
      if (!res.ok) return null;
      return (await res.json()).accessToken || null;
    } catch (e) {
      return null;
    }
  }

  async function getAccountId(token) {
    const endpoints = ['/backend-api/accounts/check/v4-2023-04-27', '/backend-api/accounts/check'];
    for (const url of endpoints) {
      try {
        const res = await fetch(url, { credentials: 'include', headers: { 'Authorization': 'Bearer ' + token } });
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

  async function fetchPage(offset, headers) {
    const url = `/backend-api/conversations?offset=${offset}&limit=${PAGE_LIMIT}&order=updated`;
    return fetch(url, { credentials: 'include', headers });
  }

  function buildMarkdown(items) {
    const now = new Date().toLocaleString('en-US');
    let md = `# ChatGPT Conversations\n\n`;
    md += `_${items.length} conversations · generated ${now}_\n\n`;
    md += `| # | Title | Created | Updated | Link |\n`;
    md += `| - | ----- | ------- | ------- | ---- |\n`;
    items.forEach((c, i) => {
      const title = escapeCell(c.title || '(untitled)');
      const url = `https://chatgpt.com/c/${c.id}`;
      md += `| ${i + 1} | ${title} | ${fmt(c.create_time)} | ${fmt(c.update_time)} | ${url} |\n`;
    });
    return md;
  }

  async function run() {
    try {
      setStatus('Authenticating...');
      const token = await getAccessToken();
      if (!token) throw new Error('Could not read session token from /api/auth/session. Are you logged in?');

      const headers = { 'Authorization': 'Bearer ' + token };

      // One probe request; add an account id header if the plain call is rejected.
      let probe = await fetchPage(0, headers);
      if (probe.status === 401 || probe.status === 403) {
        const accountId = await getAccountId(token);
        if (accountId) headers['Chatgpt-Account-Id'] = accountId;
        probe = await fetchPage(0, headers);
      }
      if (!probe.ok) throw new Error(`List fetch failed (HTTP ${probe.status})`);

      const first = await probe.json();
      const items = [...(first.items || [])];
      const total = first.total ?? items.length;

      // Remaining pages.
      for (let page = 1; page < MAX_PAGES && items.length < total; page++) {
        setStatus(`Fetching conversations... (${items.length}/${total})`);
        const res = await fetchPage(page * PAGE_LIMIT, headers);
        if (!res.ok) break;
        const json = await res.json();
        const batch = json.items || [];
        if (batch.length === 0) break;
        items.push(...batch);
      }

      if (items.length === 0) throw new Error('No conversations returned.');

      const md = buildMarkdown(items);
      download(md, 'chatgpt-conversations.md', 'text/markdown');

      // Quick in-console view.
      console.table(items.map(c => ({
        title: c.title || '(untitled)',
        created: fmt(c.create_time),
        updated: fmt(c.update_time),
        url: `https://chatgpt.com/c/${c.id}`
      })));

      setStatus(`✅ Listed ${items.length} conversations → chatgpt-conversations.md`, '#10a37f');
      console.log(`🎉 ${items.length} conversations exported to chatgpt-conversations.md`);
    } catch (error) {
      setStatus(`Error: ${error.message}`, '#f44336');
      console.error('List failed:', error);
    } finally {
      setTimeout(() => {
        if (document.body.contains(statusDiv)) document.body.removeChild(statusDiv);
      }, 6000);
    }
  }

  run();
}

// Run the lister
listChatGPTConversations();
