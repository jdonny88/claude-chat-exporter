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

  // A generated image carries dalle/generation metadata on its
  // image_asset_pointer. Figures extracted from an attached file (in an
  // api_tool file-parse message) are image_asset_pointers too but WITHOUT that
  // metadata — so this distinguishes a real generated image from file content.
  function isGeneratedImagePart(p) {
    return p && typeof p === 'object'
      && p.content_type === 'image_asset_pointer'
      && !!(p.metadata?.dalle || p.metadata?.generation);
  }

  function hasGeneratedImage(message) {
    return (message?.content?.parts || []).some(isGeneratedImagePart);
  }

  function isVisibleMessage(message) {
    if (!message) return false;
    if (message.metadata?.is_visually_hidden_from_conversation) return false;
    const role = message.author?.role;
    if (role === 'user') return true;
    // Assistant messages addressed to a tool (function calls) aren't shown.
    if (role === 'assistant') return !(message.recipient && message.recipient !== 'all');
    // Tool messages are noise (file parsing, search, browsing) EXCEPT genuine
    // generated images. Requiring generation metadata excludes file-parse
    // messages that merely contain figures extracted from an attachment.
    if (role === 'tool') return hasGeneratedImage(message);
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

  // Newer ChatGPT responses embed rich UI inside ordinary text as a small
  // JSX + Handlebars-style language: layout tags (<box>, <row>, <grid>,
  // <grid-item>, <text>, <caption>, <badge>, <divider>, ...), <table>s, <list>s,
  // and {#each}/{#if} template loops over inline data. The real content lives
  // inside all of this, so we expand the templates, turn tables and lists into
  // Markdown, keep each label/value on its own line (image groups -> _[Images]_,
  // single images -> _[Image]_, directional icons -> arrow glyphs so flow
  // diagrams keep their direction, other icons dropped) and unwrap the rest.
  // Code blocks and generated tables/lists are protected from the whitespace
  // tidy-up, and the pass only runs on messages that actually use these
  // constructs - so prose like List<String> or <https://...> autolinks is never
  // touched.

  // Flow diagrams connect their boxes with directional icons
  // (<icon name="arrow-down"/>, chevron-right, caret-up, ...). Map the direction
  // to a glyph so the flow survives; non-directional icons return '' (dropped).
  function iconGlyph(name) {
    const n = String(name || '').toLowerCase();
    // Bidirectional / decorative arrows (e.g. arrow-left-right, up-down) aren't
    // flow connectors, so drop them rather than emit a misleading single arrow.
    if (/left.*right|right.*left|up.*down|down.*up/.test(n)) return '';
    if (/\bdown\b/.test(n)) return '↓';
    if (/\bup\b/.test(n)) return '↑';
    if (/\bright\b/.test(n)) return '→';
    if (/\bleft\b/.test(n)) return '←';
    return '';
  }

  // Parse the (non-strict) array literal used by {#each ...}. Supports an array
  // of objects with unquoted keys ([{name:"a",sub:"b"}, ...]) and an array of
  // string arrays ([["1","a","b"], ...]). Returns an array, or null if not an
  // array literal.
  function parseArrayLiteral(src) {
    let s = String(src || '').trim();
    if (s[0] !== '[') return null;
    const inner = s.slice(1, s.lastIndexOf(']'));
    const elements = [];
    let depth = 0, quote = '', buf = '', started = false;
    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i];
      if (quote) {
        buf += ch;
        if (ch === quote && inner[i - 1] !== '\\') quote = '';
        continue;
      }
      if (ch === '"' || ch === "'") { quote = ch; buf += ch; started = true; continue; }
      if (ch === '{' || ch === '[') { depth++; buf += ch; started = true; continue; }
      if (ch === '}' || ch === ']') { depth--; buf += ch; continue; }
      if (ch === ',' && depth === 0) {
        if (started) elements.push(buf.trim());
        buf = ''; started = false; continue;
      }
      if (!/\s/.test(ch)) started = true;
      buf += ch;
    }
    if (buf.trim()) elements.push(buf.trim());

    return elements.map(el => {
      el = el.trim();
      if (el[0] === '{') {
        const obj = {};
        const re = /(["']?)([A-Za-z_]\w*)\1\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g;
        let m;
        while ((m = re.exec(el))) obj[m[2]] = m[3].slice(1, -1);
        return obj;
      }
      if (el[0] === '[') {
        const arr = [];
        const re = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g;
        let m;
        while ((m = re.exec(el))) arr.push(m[1] ?? m[2] ?? '');
        return arr;
      }
      const q = el.match(/^["'](.*)["']$/);
      return q ? q[1] : el;
    });
  }

  // Evaluate a simple {#if} condition such as "i<4". Only index/number
  // comparisons are supported; anything else keeps the block (returns true).
  function evalCond(expr, scope) {
    const m = String(expr || '').match(/^\s*(\w+)\s*(<=|>=|==|!=|<|>)\s*(\d+)\s*$/);
    if (!m) return true;
    const left = scope[m[1]];
    if (typeof left !== 'number') return true;
    const right = Number(m[3]);
    switch (m[2]) {
      case '<': return left < right;
      case '>': return left > right;
      case '<=': return left <= right;
      case '>=': return left >= right;
      case '==': return left == right;
      case '!=': return left != right;
    }
    return true;
  }

  // Render one {#each} body for a single element: resolve {#if}, then substitute
  // {var.key}, {var[n]}, {var} and the optional index variable.
  function renderEachBody(body, itemVar, el, idxVar, idx) {
    let out = body;
    const scope = { [itemVar]: el };
    if (idxVar) scope[idxVar] = idx;
    out = out.replace(/\{#if\s+([^}]*)\}([\s\S]*?)\{\/if\}/g,
      (_, cond, inner) => (evalCond(cond, scope) ? inner : ''));

    const V = itemVar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp('\\{\\s*' + V + '\\s*\\.\\s*(\\w+)\\s*\\}', 'g'),
      (_, k) => (el && el[k] != null ? el[k] : ''));
    out = out.replace(new RegExp('\\{\\s*' + V + '\\s*\\[\\s*(\\d+)\\s*\\]\\s*\\}', 'g'),
      (_, i) => (el && el[+i] != null ? el[+i] : ''));
    out = out.replace(new RegExp('\\{\\s*' + V + '\\s*\\}', 'g'),
      () => (typeof el === 'string' ? el : ''));
    if (idxVar) {
      const I = idxVar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out = out.replace(new RegExp('\\{\\s*' + I + '\\s*\\}', 'g'), () => String(idx));
    }
    return out;
  }

  // Expand {#each ARRAY as var[,idx]} ... {/each} loops over their inline data.
  function expandTemplates(text) {
    let t = text, prev, guard = 0;
    do {
      prev = t;
      t = t.replace(
        /\{#each\s+([\s\S]*?)\s+as\s+(\w+)(?:\s*,\s*(\w+))?\s*\}([\s\S]*?)\{\/each\}/g,
        (m, arrLit, itemVar, idxVar, body) => {
          const items = parseArrayLiteral(arrLit);
          if (!items) return m;
          return items.map((el, i) => renderEachBody(body, itemVar, el, idxVar, i)).join('\n');
        });
      guard++;
    } while (t !== prev && guard < 10);
    // Safety net: drop residual control tokens if a loop failed to parse.
    return t.replace(/\{#each\b[^}]*\}|\{\/each\}|\{#if\b[^}]*\}|\{\/if\}/g, '');
  }

  // Render one grid-item's inner markup into a single table-cell string: run the
  // same inline transforms the main pass uses, then join the resulting lines
  // with <br> so a card's title/subtitle/caption stack neatly inside one cell.
  function renderCell(html) {
    let s = html
      .replace(/<[A-Za-z][\w.-]*\b[^>]*?\bvalue=(?:"([^"]*)"|'([^']*)'|\{`?([^}`]*)`?\})[^>]*?\/>/g, (_, a, b, c) => a ?? b ?? c ?? '')
      .replace(/<(?:Async)?ImageGroup\b[^>]*>/gi, '_[Images]_')
      .replace(/<(?:Async)?Image\b[^>]*>/gi, '_[Image]_')
      .replace(/<Cite\b[^>]*>/gi, '')
      .replace(/<icon\b[^>]*?\bname=(?:"([^"]*)"|'([^']*)')[^>]*>/gi, (_, a, b) => iconGlyph(a ?? b))
      .replace(/<icon\b[^>]*>/gi, '')
      .replace(/<text\b([^>]*)>([\s\S]*?)<\/text>/gi, (_, at, inner) => {
        const x = inner.trim();
        if (!x) return '\n';
        return '\n' + (/weight\s*=\s*"?(?:medium|semibold|bold)/i.test(at) ? '**' + x + '**' : x) + '\n';
      })
      .replace(/<caption\b[^>]*>([\s\S]*?)<\/caption>/gi, (_, inner) => (inner.trim() ? '\n' + inner.trim() + '\n' : '\n'))
      .replace(/<badge\b[^>]*>([\s\S]*?)<\/badge>/gi, (_, inner) => (inner.trim() ? '\n_' + inner.trim() + '_\n' : '\n'))
      .replace(/<\/?[A-Za-z][\w.-]*(?:\s[^<>]*?)?\/?>/g, '\n');   // strip remaining tags
    const lines = s.split('\n').map(x => x.trim()).filter(Boolean).map(x => x.replace(/\|/g, '\\|'));
    return lines.join('<br>');
  }

  const DIAGRAM_START = '**⟦ ChatGPT visual block — flattened from a rich layout ⟧**';
  const DIAGRAM_END = '**⟦ end of visual block ⟧**';

  // Paired, block-level component tags. Inline/self-closing ones (<Entity/>,
  // <AsyncImage/>, <Cite/>, <icon/>, <divider/>) are NOT here, so a citation or
  // entity sitting in ordinary prose never looks like the start of a diagram.
  const BLOCK_TAG = /^(?:box|row|col|column|grid|grid-item|stack|card|text|caption|section|container|spacer|group|list|list-item|table|table-row|table-cell|badge)$/i;

  // Wrap each top-level rich-component region (a diagram / card grid / flow laid
  // out visually in the chat) with start/end markers, so a reader can tell where
  // a flattened block begins and ends instead of it bleeding into the prose.
  // Depth is tracked over paired block tags and {#each}/{#if}; a region is a span
  // where depth rises from 0 and returns to 0.
  function wrapDiagrams(text) {
    const tokenRe = /<\/?[A-Za-z][\w.-]*(?:\s[^<>]*?)?\/?>|\{#(?:each|if)\b[^}]*\}|\{\/(?:each|if)\}/g;
    let depth = 0, start = -1, m;
    const regions = [];
    while ((m = tokenRe.exec(text))) {
      const tok = m[0];
      let delta = 0;
      if (tok[0] === '{') {
        delta = tok[1] === '#' ? 1 : -1;
      } else if (/\/>$/.test(tok)) {
        delta = 0;                                   // self-closing: no nesting
      } else if (tok[1] === '/') {
        const name = tok.slice(2).match(/[A-Za-z][\w.-]*/);
        if (name && BLOCK_TAG.test(name[0])) delta = -1;
      } else {
        const name = tok.slice(1).match(/[A-Za-z][\w.-]*/);
        if (name && BLOCK_TAG.test(name[0])) delta = 1;
      }
      if (delta > 0 && depth === 0) start = m.index;
      depth += delta;
      if (depth <= 0) {
        if (delta < 0 && start >= 0) regions.push([start, m.index + tok.length]);
        depth = 0;
        start = -1;
      }
    }
    if (!regions.length) return text;
    let out = text;
    for (let i = regions.length - 1; i >= 0; i--) {
      const [s, e] = regions[i];
      out = out.slice(0, e) + `\n\n${DIAGRAM_END}\n\n` + out.slice(e);
      out = out.slice(0, s) + `\n\n${DIAGRAM_START}\n\n` + out.slice(s);
    }
    return out;
  }

  function cleanComponents(text) {
    if (!text) return text;
    if (!/<(?:box|row|col|column|grid|stack|card|text|icon|caption|section|container|spacer|divider|badge|table|list|Entity|Cite|(?:Async)?Image(?:Group)?|[a-z][\w]*-[\w-]*)\b|\{#(?:each|if)\b/i.test(text)) return text;

    // Protect code spans/blocks and (later) generated tables/lists from the
    // whitespace normalisation that follows.
    const code = [];
    const blocks = [];
    let t = text.replace(/```[\s\S]*?```|`[^`\n]+`/g,
      m => { code.push(m); return `${code.length - 1}`; });

    // 0b. Mark each top-level rich-component region (code already protected, so a
    //     code block that merely mentions <box> can't be mistaken for a diagram).
    t = wrapDiagrams(t);

    // 1. Expand {#each}/{#if} templates into concrete markup.
    t = expandTemplates(t);

    // 2. Convert <table> -> GitHub-flavoured Markdown table (protected block).
    t = t.replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi, (_, body) => {
      const rows = [...body.matchAll(/<table-row\b[^>]*>([\s\S]*?)<\/table-row>/gi)].map(r =>
        [...r[1].matchAll(/<table-cell\b[^>]*>([\s\S]*?)<\/table-cell>/gi)]
          .map(c => c[1].replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|')));
      if (!rows.length) return '';
      const ncol = Math.max(...rows.map(r => r.length));
      const line = cells => '| ' + cells.concat(Array(ncol - cells.length).fill('')).join(' | ') + ' |';
      const md = [line([]), '| ' + Array(ncol).fill('---').join(' | ') + ' |',
                  ...rows.map(line)].join('\n');
      blocks.push(md);
      return `\n\n${blocks.length - 1}\n\n`;
    });

    // 2b. Convert multi-column <grid> card grids -> Markdown table, so parallel
    //     cards stay side by side (preserving the "these are siblings" structure
    //     that a flat vertical list would lose).
    t = t.replace(/<grid\b([^>]*)>([\s\S]*?)<\/grid>/gi, (m, attrs, body) => {
      const cm = attrs.match(/columns\s*=\s*(?:"(\d+)"|\{?(\d+)\}?)/i);
      const cols = cm ? Number(cm[1] || cm[2]) : 2;
      const items = [...body.matchAll(/<grid-item\b[^>]*>([\s\S]*?)<\/grid-item>/gi)].map(x => renderCell(x[1]));
      if (items.length < 1 || cols < 2) return m; // leave 1-col grids to normal flow
      const rows = [];
      for (let i = 0; i < items.length; i += cols) rows.push(items.slice(i, i + cols));
      const line = cells => '| ' + cells.concat(Array(cols - cells.length).fill('')).join(' | ') + ' |';
      const md = [line([]), '| ' + Array(cols).fill('---').join(' | ') + ' |', ...rows.map(line)].join('\n');
      blocks.push(md);
      return `\n\n${blocks.length - 1}\n\n`;
    });

    // 3. Convert <list> -> Markdown list (protected block).
    t = t.replace(/<list\b([^>]*)>([\s\S]*?)<\/list>/gi, (_, attrs, body) => {
      const numbered = /marker\s*=\s*"?number/i.test(attrs);
      const items = [...body.matchAll(/<list-item\b[^>]*>([\s\S]*?)<\/list-item>/gi)].map(x => x[1]);
      if (!items.length) return '';
      let n = 0;
      const md = items.map(it => {
        n++;
        const marker = numbered ? `${n}. ` : '- ';
        const indent = ' '.repeat(marker.length);
        const lines = it.replace(/^\s*\n|\s+$/g, '').split('\n');
        return lines.map((ln, i) => {
          const s = ln.trim();
          if (i === 0) return marker + s;
          return s ? indent + s : '';
        }).join('\n');
      }).join('\n\n');
      blocks.push(md);
      return `\n\n${blocks.length - 1}\n\n`;
    });

    // 4. Inline/semantic components.
    t = t
      // Inline value components (e.g. <Entity value="Palantir Foundry"/>) keep
      // their label text rather than being dropped with the tag.
      .replace(/<[A-Za-z][\w.-]*\b[^>]*?\bvalue=(?:"([^"]*)"|'([^']*)'|\{`?([^}`]*)`?\})[^>]*?\/>/g, (_, a, b, c) => a ?? b ?? c ?? '')
      .replace(/<(?:Async)?ImageGroup\b[^>]*>/gi, '_[Images]_')            // image carousels (plural)
      .replace(/<(?:Async)?Image\b[^>]*>/gi, '_[Image]_')                  // single images (must follow the Group rule)
      .replace(/<Cite\b[^>]*>/gi, '')                                      // web-search citation chips
      .replace(/<icon\b[^>]*?\bname=(?:"([^"]*)"|'([^']*)')[^>]*>/gi,
               (_, a, b) => iconGlyph(a ?? b))                            // directional icons -> glyph
      .replace(/<icon\b[^>]*>/gi, '');                                     // other icons dropped

    // 5. Block text elements -> their own paragraph. <text weight=...> keeps its
    //    emphasis as **bold**; captions become plain and badges italic.
    t = t
      .replace(/<text\b([^>]*)>([\s\S]*?)<\/text>/gi, (_, attrs, inner) => {
        const s = inner.trim();
        if (!s) return '\n\n';
        const bold = /weight\s*=\s*"?(?:medium|semibold|bold)/i.test(attrs);
        return `\n\n${bold ? '**' + s + '**' : s}\n\n`;
      })
      .replace(/<caption\b[^>]*>([\s\S]*?)<\/caption>/gi, (_, inner) => {
        const s = inner.trim();
        return s ? `\n\n${s}\n\n` : '\n\n';
      })
      .replace(/<badge\b[^>]*>([\s\S]*?)<\/badge>/gi, (_, inner) => {
        const s = inner.trim();
        return s ? `\n\n_${s}_\n\n` : '\n\n';
      });

    // 6. Strip the remaining structural scaffolding. Block containers become a
    //    paragraph break so adjacent cells never mash together.
    t = t
      .replace(/<[A-Za-z][\w.-]*\s+[^<>]*?\/?>/g, '\n\n')                  // any tag WITH attributes
      .replace(/<\/[A-Za-z][\w.-]*\s*>/g, '\n\n')                         // closing tags
      .replace(/<[A-Za-z][\w.-]*\s*\/>/g, '')                            // self-closing, no attrs
      .replace(/<[A-Za-z][\w]*-[\w-]*\s*>/g, '\n\n')                     // bare hyphenated opens (e.g. <grid-item>)
      .replace(/<(?:box|row|col|column|grid|stack|card|caption|section|container|spacer|divider|group|list)\b\s*>/gi, '\n\n'); // bare structural opens

    // 7. De-indent nested content (so it isn't read as a code block), but leave
    //    list markers' own indentation alone.
    t = t.replace(/^[ \t]+(?=\S)/gm, (ws, offset, str) => {
      const rest = str.slice(offset + ws.length);
      return /^([-*+]\s|\d+[.)]\s)/.test(rest) ? ws : '';
    });

    // 8. Restore protected blocks and code, then tidy whitespace.
    t = t.replace(/(\d+)/g, (_, i) => blocks[+i]);
    t = t.replace(/(\d+)/g, (_, i) => code[+i]);
    t = t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
    return t.trim();
  }

  // ChatGPT embeds rich-content directives in the text as tokens delimited by
  // private-use characters: U+E200 <type> U+E202 <payload...> U+E201. In the app
  // these render as citation chips, image carousels, product cards; in raw text
  // they're noise. Strip citations, mark image groups and products.
  function cleanTokens(text) {
    if (!text) return text;
    text = cleanComponents(text); // strip rich-UI component tags first
    // Capture an optional preceding space so stripping a mid-line citation
    // doesn't leave a double space; markers keep the space.
    let out = text.replace(/( ?)([^]*)/g, (_, sp, inner) => {
      const segs = inner.split('');
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
    out = out.replace(/[-]/g, '');           // sweep stray delimiters
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
