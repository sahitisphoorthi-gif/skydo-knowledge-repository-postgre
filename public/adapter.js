/* Compatibility bridge: keeps the supplied frontend working without a login provider. */
(function () {
  const json = async (url, options = {}) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    let response;
    try {
      response = await fetch(url, { ...options, signal: controller.signal, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) { let message = `Request failed (${response.status})`; try { const body = await response.json(); message = body.error || message; } catch {} throw new Error(message); }
    if (response.status === 204) return null;
    return response.json();
  };
  const enc = encodeURIComponent;
  const collection = name => {
    const base = `/api/collections/${enc(name)}`;
    const doc = id => {
      const url = `${base}/doc/${enc(id)}`;
      return {
        async get() { const r = await json(url); return { exists: !!r.exists, data: () => r.data }; },
        async set(data) { return json(url, { method: 'PUT', body: JSON.stringify(data || {}) }); },
        async update(data) { return json(url, { method: 'PATCH', body: JSON.stringify(data || {}) }); },
        async delete() { return json(url, { method: 'DELETE' }); }
      };
    };
    return {
      doc,
      async get() { const r = await json(base); return { docs: (r.docs || []).map(x => ({ id: x.id, data: () => x.data })) }; },
      async add(data) { const id = `d_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`; await doc(id).set(data); return { id }; }
    };
  };
  const assets = {
    async upload(file) {
      const fd = new FormData(); fd.append('file', file, file.name || 'upload.bin');
      const r = await fetch('/api/blobs', { method: 'POST', body: fd });
      if (!r.ok) { let m = 'Upload failed'; try { m = (await r.json()).error || m; } catch {} throw new Error(m); }
      return r.json();
    },
    async delete(id) { const r = await fetch(`/api/blobs/${enc(id)}`, { method: 'DELETE' }); if (!r.ok) throw new Error('Could not delete uploaded file'); return r.json(); }
  };
  window.claude = {
    use: async type => {
      if (type === 'db') return { collection };
      if (type === 'assets') return assets;
      if (type === 'user') return { id: async () => 'shared-team' };
      if (type === 'downloads') return { save: async ({ filename, data }) => {
        const blob = data instanceof Blob ? data : new Blob([data]);
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename || 'download'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      } };
      if (type === 'sample') return null;
      return null;
    }
  };
})();
