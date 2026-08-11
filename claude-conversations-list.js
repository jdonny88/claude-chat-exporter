function listClaudeConversations() {
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

  // Claude created_at / updated_at are ISO 8601 strings.
  function fmt(isoString) {
    if (!isoString) return '';
    return new Date(isoString).toLocaleString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit'
    });
  }

  function escapeCell(s) {
    return String(s || '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
  }

  function getOrgId() {
    return document.cookie.match(/lastActiveOrg=([^;]+)/)?.[1] || null;
  }

  async function fetchConversations(orgId) {
    // The endpoint returns the org's conversations. It's returned all-at-once
    // historically; if Claude paginates it later, add offset/limit here.
    const url = `/api/organizations/${orgId}/chat_conversations`;
    const res = await fetch(url, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' }
    });
    if (!res.ok) throw new Error(`List fetch failed (HTTP ${res.status})`);
    return res.json();
  }

  function flags(c) {
    const f = [];
    if (c.is_starred) f.push('⭐');
    if (c.project_uuid) f.push('📁');
    return f.join(' ');
  }

  // File 1: a compact index table (no summary).
  function buildTable(items) {
    const now = new Date().toLocaleString('en-US');
    let md = `# Claude Conversations\n\n`;
    md += `_${items.length} conversations · generated ${now}_\n\n`;
    md += `_Flags: ⭐ starred · 📁 in a project_\n\n`;
    md += `| # | Title | Model | Created | Updated | Flags | Link |\n`;
    md += `| - | ----- | ----- | ------- | ------- | ----- | ---- |\n`;
    items.forEach((c, i) => {
      const title = escapeCell(c.name || '(untitled)');
      const url = `https://claude.ai/chat/${c.uuid}`;
      md += `| ${i + 1} | ${title} | ${escapeCell(c.model || '')} | ${fmt(c.created_at)} | ${fmt(c.updated_at)} | ${flags(c)} | ${url} |\n`;
    });
    return md;
  }

  // File 2: one section per conversation with the FULL summary.
  function buildSummaries(items) {
    const now = new Date().toLocaleString('en-US');
    let md = `# Claude Conversation Summaries\n\n`;
    md += `_${items.length} conversations · generated ${now}_\n\n`;
    items.forEach((c, i) => {
      const title = c.name || '(untitled)';
      const url = `https://claude.ai/chat/${c.uuid}`;
      const meta = [c.model, `Created ${fmt(c.created_at)}`, `Updated ${fmt(c.updated_at)}`, flags(c)]
        .filter(Boolean).join(' · ');
      md += `## ${i + 1}. ${title}\n\n`;
      md += `_${meta}_ · [Open](${url})\n\n`;
      md += (c.summary ? String(c.summary).trim() : '_(no summary)_') + '\n\n';
      md += `---\n\n`;
    });
    return md;
  }

  async function run() {
    try {
      const orgId = getOrgId();
      if (!orgId) throw new Error('Could not read org id (lastActiveOrg cookie). Are you logged in?');

      setStatus('Fetching conversations...');
      let items = await fetchConversations(orgId);
      if (!Array.isArray(items)) items = items?.conversations || items?.items || [];

      if (items.length === 0) throw new Error('No conversations returned.');

      // Sort most-recently-updated first for readability.
      items.sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0));

      // Two files: the compact table, and the full summaries.
      download(buildTable(items), 'claude-conversations.md', 'text/markdown');
      download(buildSummaries(items), 'claude-conversations-summaries.md', 'text/markdown');

      // Quick in-console view.
      console.table(items.map(c => ({
        title: c.name || '(untitled)',
        model: c.model || '',
        created: fmt(c.created_at),
        updated: fmt(c.updated_at),
        starred: !!c.is_starred,
        project: !!c.project_uuid,
        url: `https://claude.ai/chat/${c.uuid}`
      })));

      setStatus(`✅ Listed ${items.length} conversations → 2 files (table + summaries)`, '#4CAF50');
      console.log(`🎉 ${items.length} conversations → claude-conversations.md + claude-conversations-summaries.md`);
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
listClaudeConversations();
