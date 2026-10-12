(() => {
  const privateDataPatterns = [
    /\b[A-Z]{5}\d{4}[A-Z]\b/i,
    /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/,
    /\b(?:\+?91[\s-]?)?[6-9]\d{9}\b/,
    /\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/,
    /\b\d{9,18}\b/
  ];
  const history = [];
  const extractedPdfText = new Map();
  let busy = false;
  let pdfLoader;

  function hasPrivateData(text) {
    return privateDataPatterns.some(pattern => pattern.test(text));
  }
  function plain(value) {
    if (value == null) return '';
    const html = String(value).replace(/<\/(?:td|th)>/gi, '\t').replace(/<\/(?:p|li|tr|h[1-6]|div|section|details)>/gi, '\n');
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('script,style').forEach(el => el.remove());
    const links = [...doc.querySelectorAll('a[href]')].map(a => `${a.textContent.trim()}: ${a.href}`);
    return [doc.body.textContent || '', ...links].join('\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }
  function addSource(sources, title, content, url = '') {
    const text = plain(content);
    if (text) sources.push({ title: String(title || 'Repository source'), text, url });
  }
  async function readPdf(url, cacheKey) {
    if (extractedPdfText.has(cacheKey)) return extractedPdfText.get(cacheKey);
    const pending = (async () => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Could not read PDF source (${response.status})`);
      const blob = await response.blob();
      if (blob.size > 20 * 1024 * 1024) throw new Error('PDF is too large to index');
      const buffer = await blob.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      if (bytes[0] !== 37 || bytes[1] !== 80 || bytes[2] !== 68 || bytes[3] !== 70 || bytes[4] !== 45) throw new Error('Uploaded source is not a valid PDF');
      if (!window.pdfjsLib) {
        pdfLoader ||= (async () => {
          const base = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
          await pdfLoad(base + 'pdf.min.js');
          const worker = await (await fetch(base + 'pdf.worker.min.js')).text();
          pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([worker], { type: 'text/javascript' }));
        })();
        await pdfLoader;
      }
      const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
      const pages = Math.min(pdf.numPages, 300), text = [];
      let length = 0;
      for (let pageNumber = 1; pageNumber <= pages && length < 180000; pageNumber++) {
        const page = await pdf.getPage(pageNumber);
        const content = await page.getTextContent();
        const pageText = content.items.map(item => item.str || '').join(' ').trim();
        if (pageText) {
          text.push(`Page ${pageNumber}\n${pageText}`);
          length += pageText.length;
        }
      }
      if (pdf.numPages > pages) text.push(`[Only the first ${pages} pages were indexed.]`);
      return text.join('\n\n').slice(0, 180000);
    })();
    extractedPdfText.set(cacheKey, pending);
    try {
      const text = await pending;
      extractedPdfText.set(cacheKey, text);
      return text;
    } catch (error) {
      extractedPdfText.delete(cacheKey);
      throw error;
    }
  }
  async function addUploadedFile(sources, file, title) {
    const label = title || file.name || file.title || 'Uploaded reference';
    try {
      const blobId = file.assetId || file.id;
      const extension = String(file.name || '').split('.').pop().toLowerCase();
      const kind = String(file.kind || (extension === 'pdf' ? 'pdf' : extension)).toLowerCase();
      if (kind === 'link' || file.url && !blobId && !file.sheets?.length) {
        addSource(sources, label, file.desc || 'External reference link. Search the approved official source for its current content.', file.url || '');
        return;
      }
      if (Array.isArray(file.sheets) && file.sheets.length) {
        for (const sheet of file.sheets) {
          const response = await fetch(`/_blob/${encodeURIComponent(sheet.id)}`);
          if (!response.ok) throw new Error(`Could not load sheet "${sheet.n || 'data'}" (${response.status})`);
          addSource(sources, `${label} · ${sheet.n || 'sheet'}`, await response.text());
        }
        return;
      }
      if (kind === 'pdf' && blobId) {
        const text = await readPdf(`/_blob/${encodeURIComponent(blobId)}`, blobId);
        addSource(sources, label, `${file.desc || ''}\n${text}`);
        return;
      }
      if (blobId && ['csv', 'txt', 'md', 'json'].includes(kind)) {
        const response = await fetch(`/_blob/${encodeURIComponent(blobId)}`);
        if (!response.ok) throw new Error(`Could not load uploaded reference (${response.status})`);
        addSource(sources, label, `${file.desc || ''}\n${await response.text()}`);
        return;
      }
      if (blobId && ['xls', 'xlsx'].includes(kind)) {
        const response = await fetch(`/_blob/${encodeURIComponent(blobId)}`);
        if (!response.ok) throw new Error(`Could not load spreadsheet (${response.status})`);
        await fmLib();
        const workbook = XLSX.read(await response.arrayBuffer());
        for (const sheetName of workbook.SheetNames) {
          addSource(sources, `${label} · ${sheetName}`, XLSX.utils.sheet_to_csv(workbook.Sheets[sheetName]));
        }
      }
    } catch (error) {
      console.warn(`[chat] Could not index "${label}":`, error);
    }
  }
  async function buildSources(question) {
    await loadResourceData();
    await fmLoad(true);
    fmSync();
    await mrLoad();
    const sources = [];
    for (const item of R) {
      const sections = (item.s || []).map(section => `${section[0]}\n${section[1]}`).join('\n\n');
      addSource(sources, item.t, `${item.d}\n${sections}`, item.url || '');
    }
    for (const item of M) {
      addSource(sources, item.t, `${item.d}\n${(item.s || []).map(section => `${section[0]}\n${section[1]}`).join('\n\n')}`);
    }
    for (const item of PX) {
      addSource(sources, `Prohibited transaction: ${item.n}`, Object.entries(item).filter(([key]) => key !== 'n' && key !== 'k').map(([key, value]) => `${key}: ${value}`).join('\n'));
    }
    for (const item of SCAMS) addSource(sources, item.n, JSON.stringify(item));
    for (const item of QS.filter(item => ['Prohibited', 'Workflow', 'Case study'].includes(item.t))) {
      addSource(sources, `Quiz reference: ${item.t}`, `${item.q}\n${item.o.join('\n')}\n${item.e || ''}\n${item.c || ''}`);
    }
    for (const item of PV) addSource(sources, item.n, item.d, item.u);
    if (typeof PGTXT !== 'undefined') {
      for (const [key, text] of Object.entries(PGTXT)) {
        const title = typeof FM_BUILT !== 'undefined' && FM_BUILT[key] ? FM_BUILT[key] : key;
        const override = fm.ov && fm.ov[key];
        if (override && override.assetId) {
          try {
            addSource(sources, `Updated built-in PDF: ${title}`, await readPdf(`/_blob/${encodeURIComponent(override.assetId)}`, override.assetId));
          } catch (error) {
            console.warn(`[chat] Could not index updated PDF "${title}":`, error);
            addSource(sources, `Built-in PDF: ${title}`, text);
          }
        } else addSource(sources, `Built-in PDF: ${title}`, text);
      }
    }
    for (const file of fm.rows || []) await addUploadedFile(sources, file, `${file.title || file.name || 'Uploaded reference'} · ${fmModName(file.mod || 'library')}`);
    for (const rule of mr.rows || []) {
      addSource(sources, `Team rule: ${rule.title || 'Compliance rule'}`, rule.body || '');
      for (const attachment of rule.files || []) await addUploadedFile(sources, attachment, `Team rule attachment: ${attachment.name || rule.title || 'Reference'}`);
    }
    const terms = new Set(question.toLowerCase().match(/[a-z0-9]{2,}/g) || []);
    const stopWords = new Set(['the', 'and', 'for', 'with', 'what', 'when', 'where', 'does', 'can', 'how', 'are', 'from', 'this', 'that', 'into', 'about', 'should', 'would', 'could']);
    const tokens = [...terms].filter(token => !stopWords.has(token));
    const score = source => {
      const title = source.title.toLowerCase(), text = source.text.toLowerCase();
      const combined = `${title}\n${text}`;
      const tokenScore = tokens.reduce((total, token) => {
        const count = (text.match(new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
        return total + (title.includes(token) ? 5 : 0) + Math.min(count, 4) + (count > 0 ? 2 : 0);
      }, 0);
      const phrase = tokens.join(' ');
      return tokenScore + (phrase.length > 0 && combined.includes(phrase) ? 20 : 0);
    };
    const excerpt = (text, maxLength) => {
      if (text.length <= maxLength) return text;
      const blocks = text.split(/\n+/).map(value => value.trim()).filter(Boolean);
      const matching = blocks.map(value => ({ value, score: score({ title: '', text: value }) }))
        .filter(item => item.score > 0).sort((a, b) => b.score - a.score);
      if (matching.length) {
        let result = '';
        for (const item of matching) {
          const next = `${result ? '\n' : ''}${item.value}`;
          if (result.length + next.length > maxLength) continue;
          result += next;
        }
        if (result) return result;
      }
      const found = tokens.map(token => text.toLowerCase().indexOf(token)).filter(index => index >= 0).sort((a, b) => a - b);
      const start = found.length ? Math.max(0, found[0] - 500) : 0;
      return `${start ? '…' : ''}${text.slice(start, start + maxLength)}`;
    };
    return sources.map(source => ({ ...source, score: score(source) }))
      .filter(source => source.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 12)
      .map(({ title, text, url }) => ({ title, text: excerpt(text, 5000), url }));
  }
  function addMessage(role, text, sources = []) {
    const messages = document.getElementById('kbchat-messages');
    const bubble = document.createElement('div');
    bubble.className = `kbchat-message ${role}`;
    bubble.textContent = text;
    messages.appendChild(bubble);
    if (sources.length) {
      const citations = document.createElement('div');
      citations.className = 'kbchat-citations';
      sources.forEach(source => {
        const link = /^https:\/\//i.test(source.url || '') ? document.createElement('a') : document.createElement('span');
        if (link.tagName === 'A') {
          link.href = source.url;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
        }
        link.textContent = source.title;
        citations.appendChild(link);
      });
      bubble.appendChild(citations);
    }
    messages.scrollTop = messages.scrollHeight;
    return bubble;
  }
  async function send() {
    if (busy) return;
    const input = document.getElementById('kbchat-input');
    const question = input.value.trim();
    if (!question) return;
    if (hasPrivateData(question)) {
      addMessage('assistant', 'Please remove personal or financial identifiers (such as phone numbers, email addresses, PAN, Aadhaar, or account numbers). Do not enter customer-specific information.');
      return;
    }
    busy = true;
    document.getElementById('kbchat-send').disabled = true;
    input.value = '';
    addMessage('user', question);
    const pending = addMessage('assistant pending', 'Searching the repository and approved official sources…');
    try {
      const sources = await buildSources(question);
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, history: history.slice(-6), sources })
      });
      if (!(response.headers.get('content-type') || '').includes('application/json')) {
        throw new Error('The assistant service returned an invalid response. Please try again later.');
      }
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
      const answer = String(result.answer || 'I could not verify an answer from the available sources.');
      pending.remove();
      addMessage('assistant', answer, Array.isArray(result.sources) ? result.sources : []);
      history.push({ role: 'user', content: question }, { role: 'assistant', content: answer });
      if (history.length > 8) history.splice(0, history.length - 8);
    } catch (error) {
      pending.classList.remove('pending');
      pending.classList.add('kbchat-error');
      pending.textContent = error.message || 'Could not reach the assistant. Please try again.';
    } finally {
      busy = false;
      const button = document.getElementById('kbchat-send');
      if (button) button.disabled = false;
      input.focus();
    }
  }
  function startVoice() {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) {
      addMessage('assistant', 'Voice input is not supported in this browser. Try a recent version of Chrome or Edge, or type your question.');
      return;
    }
    const button = document.getElementById('kbchat-voice');
    const recognition = new Recognition();
    recognition.lang = 'en-IN';
    recognition.interimResults = false;
    recognition.onstart = () => button.classList.add('listening');
    recognition.onend = () => button.classList.remove('listening');
    recognition.onerror = () => addMessage('assistant', 'Could not capture voice input. Check microphone permission and try again.');
    recognition.onresult = event => {
      const input = document.getElementById('kbchat-input');
      input.value = event.results[0][0].transcript;
      input.focus();
    };
    recognition.start();
  }
  function mount() {
    if (cur.v !== 'overview' || cur.r || qs) return;
    const page = document.getElementById('pg');
    if (document.getElementById('kbchat')) return;
    const section = document.createElement('section');
    section.className = 'kbchat';
    section.id = 'kbchat';
    section.innerHTML = '<div class="kbchat-panel pn" id="kbchat-panel" role="dialog" aria-label="Knowledge assistant" aria-modal="false" hidden><div class="kbchat-head"><div><h2>Ask about Skydo and compliance</h2></div><button id="kbchat-close" class="kbchat-close" type="button" aria-label="Close chat">×</button></div><div id="kbchat-messages" class="kbchat-messages" aria-live="polite"></div><form id="kbchat-form" class="kbchat-form"><textarea id="kbchat-input" maxlength="1200" aria-label="Ask a question" placeholder="Type your question…"></textarea><button id="kbchat-voice" class="bt kbchat-voice" type="button" aria-label="Speak your question">🎙</button><button id="kbchat-send" class="bt on" type="submit">Ask</button></form></div><button id="kbchat-launcher" class="kbchat-launcher" type="button" aria-label="Open knowledge assistant" aria-expanded="false" aria-controls="kbchat-panel"><svg viewBox="0 0 48 48" aria-hidden="true"><path class="ear" d="M15.5 23.5C12 17 12.5 5 16 4c3.3-1 7.6 8 8.4 16.7M32.5 23.5C36 17 35.5 5 32 4c-3.3-1-7.6 8-8.4 16.7"/><path d="M11 29c0-7.2 5.8-13 13-13s13 5.8 13 13-5.8 14-13 14-13-6.8-13-14Z"/><path d="M18 29h.1M30 29h.1M21 34c2 2 4 2 6 0m-3-4v2"/><path class="whiskers" d="m18 34-8-2m8 5-8 2m22-5 8-2m-8 5 8 2"/></svg><span class="kbchat-bubble" aria-hidden="true">Ask me!</span></button>';
    page.appendChild(section);
    const panel = document.getElementById('kbchat-panel');
    const launcher = document.getElementById('kbchat-launcher');
    const toggle = open => {
      panel.hidden = !open;
      launcher.setAttribute('aria-expanded', String(open));
      if (open) document.getElementById('kbchat-input').focus();
      else launcher.focus();
    };
    launcher.addEventListener('click', () => toggle(panel.hidden));
    document.getElementById('kbchat-close').addEventListener('click', () => toggle(false));
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !panel.hidden) toggle(false);
    });
    document.getElementById('kbchat-form').addEventListener('submit', event => { event.preventDefault(); send(); });
    document.getElementById('kbchat-voice').addEventListener('click', startVoice);
  }
  const previousRender = render;
  render = function () {
    previousRender();
    mount();
  };
  mount();
})();
