/**
 * core.js - Shared Foundation for Handyman Manager Platform
 * Handles IndexedDB local caching, Supabase cloud sync & PDF storage,
 * centralised branding, Workspace navigation, and consistent PDF layout/pagination.
 */
"use strict";

// ============================================================================
// 1. GLOBAL CONFIGURATION & SHARED CONSTANTS
// ============================================================================
const APP_CONFIG = {
  dbName: 'handyman-manager-complete',
  dbVersion: 3,
  storageBucket: 'documents',
  stores: [
    'customers',
    'jobs',
    'qaReports',
    'quotes',
    'invoices',
    'payments',
    'docs',
    'templates',
    'settings',
    'counters'
  ],
  pages: {
    home: 'index.html',
    customers: 'customers.html',
    tasks: 'tasks.html',
    legal: 'legal.html',
    qa: 'qa.html',
    invoices: 'invoices.html',
    peripherals: 'peripherals.html',
    archive: 'archive.html'
  }
};

const DEFAULT_BRAND = {
  name: 'David Kennedy Handyman Services',
  slogan: '',
  address: '',
  phone: '',
  email: '',
  website: '',
  color: '#0f5c5c',
  footer: '',
  bankDetails: '',
  logo: ''
};

const DEFAULT_SUPABASE = {
  url: '',
  anonKey: '',
  autoSync: true,
  lastSync: ''
};

let db = null;
let brand = { ...DEFAULT_BRAND };
let supabaseConfig = { ...DEFAULT_SUPABASE };
let syncInProgress = false;

// ============================================================================
// 2. DOM, FORMATTING, REFERENCE NUMBER & FILE UTILITIES
// ============================================================================
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const esc = (str) =>
  String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]));

const uid = () =>
  crypto.randomUUID
    ? crypto.randomUUID()
    : String(Date.now()) + Math.random().toString(16).slice(2);

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const GBP = (n) => '£' + (Number(n) || 0).toFixed(2);

const dateFmt = (d) =>
  d ? new Date(d + 'T12:00:00').toLocaleDateString('en-GB') : '';

/**
 * Extracts the shared numeric/core reference code (e.g. "121" from "121", "quo121", or "TSK-121")
 * and formats it with the requested document prefix ("quo", "con", "qa", "inv", "tsk").
 */
function extractRefCode(rawRef) {
  const s = String(rawRef || '').trim();
  const numMatch = s.match(/(\d+)/);
  if (numMatch) return numMatch[1];
  const cleaned = s.replace(/^(quo|con|qa|inv|tsk|job)[-_\s]*/i, '').trim();
  return cleaned || String(Math.floor(100 + Math.random() * 900));
}

function formatDocRef(prefix, rawRef) {
  const code = extractRefCode(rawRef);
  return `${String(prefix || '').toLowerCase()}${code}`;
}

/**
 * Sanitises strings for PDFLib StandardFonts (WinAnsi / Windows-1252) so characters
 * like ✓, em-dashes, or smart quotes never throw encoding errors.
 */
function pdfSafeText(str) {
  return String(str ?? '')
    .replace(/✓|✔/g, '[X]')
    .replace(/✗|✘/g, '[ ]')
    .replace(/—|–/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, '...')
    .replace(/·/g, '-')
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, '');
}

function formData(formId) {
  const form = typeof formId === 'string' ? $('#' + formId) : formId;
  if (!form) return {};
  return Object.fromEntries(new FormData(form).entries());
}

function fileData(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function presentPdf(blob, filename, win) {
  const url = URL.createObjectURL(blob);
  if (win && !win.closed) {
    win.location.href = url;
  } else {
    downloadBlob(blob, filename);
  }
  setTimeout(() => URL.revokeObjectURL(url), 120000);
}

function saveText(text, filename, type = 'text/plain') {
  downloadBlob(new Blob([text], { type }), filename);
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      if (existing.dataset.loaded === 'true') return resolve();
      existing.addEventListener('load', resolve);
      existing.addEventListener('error', reject);
      return;
    }
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => {
      s.dataset.loaded = 'true';
      resolve();
    };
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

// ============================================================================
// 3. INDEXEDDB ENGINE & MIGRATION HANDLER
// ============================================================================
function dbRequest(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function store(storeName, mode = 'readonly') {
  if (!db) throw new Error('Database not initialized');
  return db.transaction(storeName, mode).objectStore(storeName);
}

const all = (storeName) => dbRequest(store(storeName).getAll());
const get = (storeName, id) => dbRequest(store(storeName).get(id));

async function put(storeName, obj, options = {}) {
  const record = {
    ...obj,
    updatedAt: obj.updatedAt || Date.now()
  };
  const res = await dbRequest(store(storeName, 'readwrite').put(record));

  if (!options.skipSync && isSupabaseConfigured() && supabaseConfig.autoSync) {
    syncStoreRecordToSupabase(storeName, record).catch((e) =>
      console.warn(`Background sync failed for ${storeName}:`, e.message)
    );
  }
  return res;
}

async function del(storeName, id, options = {}) {
  const res = await dbRequest(store(storeName, 'readwrite').delete(id));

  if (!options.skipSync && isSupabaseConfigured() && supabaseConfig.autoSync) {
    deleteStoreRecordFromSupabase(storeName, id).catch((e) =>
      console.warn(`Background delete failed for ${storeName}:`, e.message)
    );
  }
  return res;
}

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(APP_CONFIG.dbName, APP_CONFIG.dbVersion);

    req.onupgradeneeded = (event) => {
      const database = req.result;
      const oldVersion = event.oldVersion;

      APP_CONFIG.stores.forEach((storeName) => {
        if (!database.objectStoreNames.contains(storeName)) {
          database.createObjectStore(storeName, { keyPath: 'id' });
        }
      });

      if (oldVersion < 3) {
        console.info('Database migrated to v3 (7-part workflow & Supabase sync support)');
      }
    };

    req.onsuccess = () => {
      db = req.result;
      resolve(db);
    };

    req.onerror = () => reject(req.error);
  });
}

// ============================================================================
// 4. SUPABASE SYNC & PDF STORAGE ENGINE
// ============================================================================
function isSupabaseConfigured() {
  return Boolean(
    supabaseConfig &&
      typeof supabaseConfig.url === 'string' &&
      supabaseConfig.url.trim().startsWith('http') &&
      typeof supabaseConfig.anonKey === 'string' &&
      supabaseConfig.anonKey.trim().length > 10
  );
}

async function loadSupabaseConfig() {
  try {
    const saved = await get('settings', 'supabase');
    supabaseConfig = { ...DEFAULT_SUPABASE, ...(saved || {}) };
  } catch (e) {
    supabaseConfig = { ...DEFAULT_SUPABASE };
  }
  updateSyncBadge();
  return supabaseConfig;
}

function supabaseHeaders(extra = {}) {
  const cleanKey = supabaseConfig.anonKey.trim();
  return {
    apikey: cleanKey,
    Authorization: `Bearer ${cleanKey}`,
    'Content-Type': 'application/json',
    ...extra
  };
}

function supabaseRestUrl(tableName, query = '') {
  const base = supabaseConfig.url.trim().replace(/\/+$/, '');
  return `${base}/rest/v1/${tableName}${query}`;
}

function supabaseStorageUrl(bucket, objectPath, isPublic = true) {
  const base = supabaseConfig.url.trim().replace(/\/+$/, '');
  const cleanPath = String(objectPath)
    .split('/')
    .map(encodeURIComponent)
    .join('/');
  if (isPublic) {
    return `${base}/storage/v1/object/public/${encodeURIComponent(bucket)}/${cleanPath}`;
  }
  return `${base}/storage/v1/object/${encodeURIComponent(bucket)}/${cleanPath}`;
}

async function uploadPdfToSupabase(blob, objectPath) {
  if (!isSupabaseConfigured()) return null;
  const cleanPath = objectPath.replace(/^\/+/, '');
  const res = await fetch(supabaseStorageUrl(APP_CONFIG.storageBucket, cleanPath, false), {
    method: 'POST',
    headers: {
      apikey: supabaseConfig.anonKey.trim(),
      Authorization: `Bearer ${supabaseConfig.anonKey.trim()}`,
      'Content-Type': 'application/pdf',
      'x-upsert': 'true'
    },
    body: blob
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText);
    throw new Error(`PDF upload failed (${res.status}): ${errText}`);
  }
  return {
    bucket: APP_CONFIG.storageBucket,
    path: cleanPath,
    publicUrl: supabaseStorageUrl(APP_CONFIG.storageBucket, cleanPath, true)
  };
}

async function fetchPdfBlobFromSupabase(storageInfo) {
  if (!storageInfo) return null;
  if (storageInfo.publicUrl) {
    const pubRes = await fetch(storageInfo.publicUrl);
    if (pubRes.ok) return await pubRes.blob();
  }
  if (!isSupabaseConfigured() || !storageInfo.path) return null;
  const authRes = await fetch(
    supabaseStorageUrl(storageInfo.bucket || APP_CONFIG.storageBucket, storageInfo.path, false),
    {
      headers: {
        apikey: supabaseConfig.anonKey.trim(),
        Authorization: `Bearer ${supabaseConfig.anonKey.trim()}`
      }
    }
  );
  if (!authRes.ok) return null;
  return await authRes.blob();
}

async function syncStoreRecordToSupabase(storeName, record) {
  if (!isSupabaseConfigured() || !record || !record.id) return;
  const payload = {
    id: String(record.id),
    data: record,
    updated_at: new Date(Number(record.updatedAt || Date.now())).toISOString()
  };
  const res = await fetch(supabaseRestUrl(storeName, '?on_conflict=id'), {
    method: 'POST',
    headers: supabaseHeaders({
      Prefer: 'resolution=merge-duplicates,return=minimal'
    }),
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(msg);
  }
}

async function deleteStoreRecordFromSupabase(storeName, id) {
  if (!isSupabaseConfigured() || !id) return;
  const res = await fetch(
    supabaseRestUrl(storeName, `?id=eq.${encodeURIComponent(String(id))}`),
    {
      method: 'DELETE',
      headers: supabaseHeaders({ Prefer: 'return=minimal' })
    }
  );
  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(msg);
  }
}

async function syncWithSupabase(options = { quiet: false }) {
  if (!isSupabaseConfigured()) {
    if (!options.quiet) toast('Configure Supabase URL & Anon Key in Peripherals first');
    return false;
  }
  if (syncInProgress) return false;
  syncInProgress = true;
  updateSyncBadge('syncing');

  try {
    for (const storeName of APP_CONFIG.stores) {
      const localItems = await all(storeName);
      const localMap = new Map(localItems.map((item) => [String(item.id), item]));

      const getRes = await fetch(supabaseRestUrl(storeName, '?select=id,data,updated_at'), {
        headers: supabaseHeaders()
      });
      if (!getRes.ok) {
        const errBody = await getRes.text().catch(() => getRes.statusText);
        throw new Error(`${storeName}: ${errBody}`);
      }
      const remoteRows = await getRes.json();
      const remoteMap = new Map();

      for (const row of remoteRows || []) {
        if (!row || !row.id || !row.data) continue;
        const remoteRec = { ...row.data, id: row.id };
        const remoteTs =
          Number(remoteRec.updatedAt) ||
          (row.updated_at ? Date.parse(row.updated_at) : 0) ||
          0;
        remoteRec.updatedAt = remoteTs;
        remoteMap.set(String(row.id), remoteRec);

        const localRec = localMap.get(String(row.id));
        const localTs = Number(localRec?.updatedAt || localRec?.created || 0);
        if (!localRec || remoteTs > localTs) {
          await put(storeName, remoteRec, { skipSync: true });
        }
      }

      for (const localRec of localItems) {
        if (!localRec || !localRec.id) continue;
        const localTs = Number(localRec.updatedAt || localRec.created || Date.now());
        const remoteRec = remoteMap.get(String(localRec.id));
        const remoteTs = Number(remoteRec?.updatedAt || 0);
        if (!remoteRec || localTs > remoteTs) {
          await syncStoreRecordToSupabase(storeName, { ...localRec, updatedAt: localTs });
        }
      }
    }

    supabaseConfig.lastSync = new Date().toISOString();
    await put('settings', { id: 'supabase', ...supabaseConfig }, { skipSync: true });
    await loadBrand();
    updateSyncBadge('online');
    if (!options.quiet) toast('Synced with Supabase');
    return true;
  } catch (err) {
    console.error('Supabase sync error:', err);
    updateSyncBadge('error');
    if (!options.quiet) toast('Sync issue: ' + err.message);
    return false;
  } finally {
    syncInProgress = false;
  }
}

function updateSyncBadge(state = null) {
  const pill = $('#syncStatusPill');
  if (!pill) return;

  if (state === 'syncing') {
    pill.textContent = 'Syncing...';
    pill.className = 'sync-pill';
    return;
  }
  if (state === 'error') {
    pill.textContent = 'Sync Error';
    pill.className = 'sync-pill';
    return;
  }
  if (isSupabaseConfigured()) {
    pill.textContent = 'Supabase Sync';
    pill.className = 'sync-pill online';
  } else {
    pill.textContent = 'Local Only';
    pill.className = 'sync-pill';
  }
}

// ============================================================================
// 5. BRANDING LOADER & THEME ENGINE
// ============================================================================
async function loadBrand() {
  try {
    const saved = await get('settings', 'brand');
    brand = { ...DEFAULT_BRAND, ...(saved || {}) };
  } catch (e) {
    console.warn('Could not load saved brand, using default:', e);
    brand = { ...DEFAULT_BRAND };
  }

  const accent = brand.color || '#0f5c5c';
  document.documentElement.style.setProperty('--ac', accent);
  const metaTheme = $('meta[name="theme-color"]');
  if (metaTheme) metaTheme.setAttribute('content', accent);

  const nameEl = $('#brandName');
  const sloganEl = $('#brandSlogan');
  const logoEl = $('#brandHeaderLogo');
  if (nameEl) nameEl.textContent = brand.name || DEFAULT_BRAND.name;
  if (sloganEl) {
    sloganEl.textContent = brand.slogan || '';
    sloganEl.style.display = brand.slogan ? 'block' : 'none';
  }
  if (logoEl) {
    if (brand.logo) {
      logoEl.src = brand.logo;
      logoEl.style.display = 'block';
    } else {
      logoEl.style.display = 'none';
    }
  }

  return brand;
}

// ============================================================================
// 6. SHARED SHELL (HEADER, WORKSPACE MENU, TOAST & MODALS)
// ============================================================================
function toast(message, duration = 2800) {
  let el = $('#toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.style.display = 'block';
  clearTimeout(el._timer);
  el._timer = setTimeout(() => {
    el.style.display = 'none';
  }, duration);
}

function modal(contentHtml, showClose = true) {
  let dlg = $('#modal');
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'modal';
    document.body.appendChild(dlg);
  }
  dlg.innerHTML =
    contentHtml +
    (showClose
      ? '<button class="secondary w" type="button" onclick="closeModal()">Close</button>'
      : '');
  if (!dlg.open) {
    dlg.showModal();
  }
}

function closeModal() {
  const dlg = $('#modal');
  if (dlg && dlg.open) {
    dlg.close();
  }
}

function openWorkspaceMenu(activeSection = '') {
  const items = [
    { id: 'home', step: '1', label: 'Home Overview', sub: 'Dashboard & recent tasks', href: APP_CONFIG.pages.home },
    { id: 'customers', step: '2', label: 'Customers', sub: 'Register & manage clients', href: APP_CONFIG.pages.customers },
    { id: 'tasks', step: '3', label: 'Tasks & Quotations', sub: 'Assign tasks & build quotes', href: APP_CONFIG.pages.tasks },
    { id: 'legal', step: '4', label: 'Legal Contracts', sub: 'Contracts from task & quote', href: APP_CONFIG.pages.legal },
    { id: 'qa', step: '5', label: 'QA Assessments', sub: 'Quality checks & sign-off', href: APP_CONFIG.pages.qa },
    { id: 'invoices', step: '6', label: 'Invoices', sub: 'Billing & payment tracking', href: APP_CONFIG.pages.invoices },
    { id: 'peripherals', step: '7', label: 'Peripherals', sub: 'Branding, Supabase & backup', href: APP_CONFIG.pages.peripherals }
  ];

  modal(`
    <h2>Workspace</h2>
    <p class="m">Jump to any stage of your workflow or sync with Supabase.</p>
    <div style="display:grid;gap:8px;margin-bottom:12px">
      ${items
        .map(
          (item) => `
          <button
            type="button"
            class="${activeSection === item.id ? '' : 'secondary'} w"
            style="text-align:left;display:flex;justify-content:space-between;align-items:center;margin:0"
            onclick="navigateTo('${item.href}')"
          >
            <span><b>${item.step}. ${esc(item.label)}</b><br><span style="font-size:12px;font-weight:400;opacity:.85">${esc(item.sub)}</span></span>
            <span>&rarr;</span>
          </button>`
        )
        .join('')}
    </div>
    ${
      isSupabaseConfigured()
        ? `<button type="button" class="w" onclick="closeModal();syncWithSupabase()">Sync Now with Supabase</button>`
        : `<button type="button" class="secondary w" onclick="navigateTo('${APP_CONFIG.pages.peripherals}')">Configure Supabase</button>`
    }
  `);
}

function renderAppShell(activeSection) {
  if (!$('header')) {
    const header = document.createElement('header');
    header.innerHTML = `
      <div class="brand-wrap">
        <img id="brandHeaderLogo" class="hdr-logo" src="" alt="Logo" style="display:none">
        <div style="min-width:0">
          <b id="brandName">${esc(brand.name)}</b>
          <small id="brandSlogan">${esc(brand.slogan)}</small>
        </div>
      </div>
      <span id="syncStatusPill" class="sync-pill" onclick="openWorkspaceMenu('${esc(activeSection)}')">Local Only</span>
    `;
    document.body.prepend(header);
  }

  if (!$('#toast')) {
    const t = document.createElement('div');
    t.id = 'toast';
    document.body.appendChild(t);
  }
  if (!$('#modal')) {
    const m = document.createElement('dialog');
    m.id = 'modal';
    document.body.appendChild(m);
  }

  let nav = $('nav');
  if (!nav) {
    nav = document.createElement('nav');
    document.body.appendChild(nav);
  }

  const navItems = [
    { id: 'home', label: 'Home', href: APP_CONFIG.pages.home },
    { id: 'tasks', label: 'Tasks & Quotes', href: APP_CONFIG.pages.tasks },
    { id: 'qa', label: 'QA & Legal', href: APP_CONFIG.pages.qa },
    { id: 'workspace', label: 'Workspace', action: `openWorkspaceMenu('${activeSection}')` }
  ];

  nav.innerHTML = navItems
    .map((item) => {
      const isOn =
        activeSection === item.id ||
        (item.id === 'qa' && activeSection === 'legal') ||
        (item.id === 'workspace' &&
          ['customers', 'invoices', 'peripherals'].includes(activeSection));
      const clickHandler = item.action
        ? item.action
        : `navigateTo('${item.href}')`;
      return `
        <button
          type="button"
          data-section="${item.id}"
          class="${isOn ? 'on' : ''}"
          onclick="${clickHandler}"
        >${esc(item.label)}</button>`;
    })
    .join('');

  updateSyncBadge();
}

// ============================================================================
// 7. UNIFIED PDF HEADER, FOOTER & PAGINATION ENGINE
// ============================================================================
function hexToRgbTuple(hex) {
  const clean = String(hex || '#0f5c5c').replace('#', '').trim();
  const full =
    clean.length === 3
      ? clean
          .split('')
          .map((ch) => ch + ch)
          .join('')
      : clean.padEnd(6, '0').slice(0, 6);
  return [
    Math.min(1, Math.max(0, parseInt(full.slice(0, 2), 16) / 255)),
    Math.min(1, Math.max(0, parseInt(full.slice(2, 4), 16) / 255)),
    Math.min(1, Math.max(0, parseInt(full.slice(4, 6), 16) / 255))
  ];
}

async function createBrandedPdfDocument() {
  await loadScript('https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js');
  const pdf = await PDFLib.PDFDocument.create();
  const font = await pdf.embedFont(PDFLib.StandardFonts.Helvetica);
  const bold = await pdf.embedFont(PDFLib.StandardFonts.HelveticaBold);
  let logo = null;

  if (brand.logo) {
    try {
      const bytes = Uint8Array.from(atob(brand.logo.split(',')[1]), (c) => c.charCodeAt(0));
      logo = brand.logo.startsWith('data:image/png')
        ? await pdf.embedPng(bytes)
        : await pdf.embedJpg(bytes);
    } catch (e) {
      logo = null;
    }
  }

  return {
    pdf,
    font,
    bold,
    logo,
    width: 595,
    height: 842,
    margin: 46,
    headerHeight: 100,
    footerHeight: 62
  };
}

function drawStandardPdfHeader(docCtx, page, docTitle = 'DOCUMENT', docRef = '') {
  const { width: W, height: H, margin, headerHeight, font, bold, logo } = docCtx;
  const [r, g, b] = hexToRgbTuple(brand.color || '#0f5c5c');
  const accentColor = PDFLib.rgb(r, g, b);
  const tapeColor = PDFLib.rgb(0.95, 0.76, 0.19);
  const white = PDFLib.rgb(1, 1, 1);

  page.drawRectangle({
    x: 0,
    y: H - headerHeight,
    width: W,
    height: headerHeight,
    color: accentColor
  });
  page.drawRectangle({
    x: 0,
    y: H - headerHeight - 4,
    width: W,
    height: 4,
    color: tapeColor
  });

  let x = margin;
  if (logo) {
    const scale = Math.min(44 / logo.width, 44 / logo.height);
    const lw = logo.width * scale;
    const lh = logo.height * scale;
    page.drawImage(logo, { x, y: H - 72, width: lw, height: lh });
    x += lw + 12;
  }

  page.drawText(pdfSafeText(String(brand.name || DEFAULT_BRAND.name).slice(0, 52)), {
    x,
    y: H - 40,
    size: 15,
    font: bold,
    color: white
  });

  if (brand.slogan) {
    page.drawText(pdfSafeText(String(brand.slogan).slice(0, 75)), {
      x,
      y: H - 57,
      size: 9,
      font,
      color: white
    });
  }

  const contactLine = [brand.phone, brand.email, brand.website].filter(Boolean).join(' - ');
  if (contactLine) {
    page.drawText(pdfSafeText(contactLine.slice(0, 95)), {
      x: margin,
      y: H - 88,
      size: 8,
      font,
      color: white
    });
  }

  page.drawText(pdfSafeText(String(docTitle || 'DOCUMENT').toUpperCase().slice(0, 26)), {
    x: W - margin - 155,
    y: H - 40,
    size: 13,
    font: bold,
    color: white
  });

  if (docRef) {
    page.drawText(pdfSafeText(String(docRef).slice(0, 32)), {
      x: W - margin - 155,
      y: H - 57,
      size: 9.5,
      font,
      color: white
    });
  }

  return H - headerHeight - 24;
}

function applyStandardPdfFooters(docCtx, extraFooterNote = '') {
  const { pdf, width: W, height: H, margin, font } = docCtx;
  const pages = pdf.getPages();
  const total = pages.length;
  const lineCol = PDFLib.rgb(0.78, 0.82, 0.85);
  const mutCol = PDFLib.rgb(0.36, 0.42, 0.47);
  const footerLeft = pdfSafeText(
    [brand.footer, extraFooterNote, brand.address?.replace(/\n/g, ', ')]
      .filter(Boolean)
      .join(' - ')
      .slice(0, 105)
  );

  pages.forEach((pg, idx) => {
    pg.drawLine({
      start: { x: margin, y: 56 },
      end: { x: W - margin, y: 56 },
      thickness: 0.75,
      color: lineCol
    });

    if (footerLeft) {
      pg.drawText(footerLeft, {
        x: margin,
        y: 41,
        size: 8,
        font,
        color: mutCol
      });
    }

    pg.drawText(`Page ${idx + 1} of ${total}`, {
      x: W - margin - 58,
      y: 26,
      size: 8,
      font,
      color: mutCol
    });
  });
}

// ============================================================================
// 8. CROSS-PAGE NAVIGATION & SHARING HELPER
// ============================================================================
function navigateTo(pageFile, params = {}) {
  const url = new URL(pageFile, window.location.href);
  Object.entries(params).forEach(([key, val]) => {
    if (val !== undefined && val !== null && val !== '') {
      url.searchParams.set(key, String(val));
    }
  });
  window.location.href = url.toString();
}

function getQueryParams() {
  const params = {};
  new URLSearchParams(window.location.search).forEach((val, key) => {
    params[key] = val;
  });
  return params;
}

function clearQueryParams() {
  const cleanUrl = window.location.pathname;
  window.history.replaceState({}, document.title, cleanUrl);
}

async function shareOrDownloadFile(blob, filename, title = 'Task Document') {
  const file = new File([blob], filename, { type: blob.type || 'application/pdf' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({
        title,
        files: [file]
      });
      return true;
    } catch (err) {
      if (err.name === 'AbortError') return false;
    }
  }
  downloadBlob(blob, filename);
  return true;
}

// ============================================================================
// 9. PLATFORM BOOTSTRAPPER
// ============================================================================
async function initCore(activeSection = 'home') {
  try {
    await openDB();
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().catch(() => {});
    }
    await loadSupabaseConfig();
    await loadBrand();
    renderAppShell(activeSection);
    await loadBrand();

    if (isSupabaseConfigured() && supabaseConfig.autoSync && navigator.onLine) {
      syncWithSupabase({ quiet: true }).catch(() => {});
    }

    return { db, brand, supabase: supabaseConfig, params: getQueryParams() };
  } catch (err) {
    console.error('Core initialization failed:', err);
    const view = $('#view');
    if (view) {
      view.innerHTML = `<div class="c"><b style="color:#b3261e">Storage Error:</b> Your browser could not open local IndexedDB storage. Please ensure you are not in Private Browsing mode and try Safari or Chrome.</div>`;
    }
    throw err;
  }
}
