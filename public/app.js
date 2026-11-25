(() => {
  const $ = (sel) => document.querySelector(sel);
  const escapeHtml = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  async function api(path, options = {}) {
    const res = await fetch(path, {
      ...options,
      headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  async function loadCategories() {
    const { categories } = await api('/api/categories');
    const opts = categories.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
    $('#category-select').insertAdjacentHTML('beforeend', opts);
    $('#enquiry-category').innerHTML = `<option value="" disabled selected>Category चुनें</option>${opts}`;
  }

  function renderResults(results) {
    $('#results').innerHTML = results.length
      ? results
          .map(
            (r) => `<li class="card">
              <strong>${escapeHtml(r.title)}</strong>
              <div>${escapeHtml(r.category)} · ${escapeHtml(r.company_city)}</div>
              <div>${escapeHtml(r.composition)} ${escapeHtml(r.pack_size)} · MOQ ${r.moq}</div>
              <div>${escapeHtml(r.company_name)}</div>
            </li>`,
          )
          .join('')
      : '<li>कोई result नहीं मिला। Requirement भेजें।</li>';
  }

  $('#search-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const params = new URLSearchParams(new FormData(e.target));
    for (const [k, v] of [...params]) if (!v) params.delete(k);
    try {
      const { results } = await api(`/api/search?${params}`);
      renderResults(results);
    } catch (err) {
      $('#results').innerHTML = `<li>${escapeHtml(err.message)}</li>`;
    }
  });

  $('#enquiry-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const fd = new FormData(form);
    const body = Object.fromEntries(fd.entries());
    body.category_id = Number(body.category_id);
    body.consent = fd.get('consent') === 'on';
    if (!body.quantity) delete body.quantity;
    else body.quantity = Number(body.quantity);
    const status = $('#enquiry-status');
    status.textContent = 'भेजा जा रहा है...';
    try {
      await api('/api/enquiries', { method: 'POST', body: JSON.stringify(body) });
      form.reset();
      status.textContent = 'आपकी requirement मिल गई है। संबंधित suppliers आपसे संपर्क करेंगे।';
    } catch (err) {
      status.textContent = err.message;
    }
  });

  loadCategories().catch(() => {});
})();
