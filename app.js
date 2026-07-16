/* =========================================================================
   DocBot — Static AI Documentation Assistant
   PDF.js + Fuse.js + Marked.js + Highlight.js + Gemini API (free tier)
   No backend. No build step. Everything lives in the browser.
   ========================================================================= */

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

/* -------------------------------------------------------------------------
   0. CONSTANTS
------------------------------------------------------------------------- */
const DB_NAME = "docbot_db";
const DB_VERSION = 1;
const CHUNK_SIZE = 900;
const CHUNK_OVERLAP = 150;

// Google periodically retires free-tier model IDs. If the selected model
// returns a 404 "no longer available" error, we walk down this list and
// retry automatically, then remember whichever one worked.
const MODEL_FALLBACK_CHAIN = [
  "gemini-3.5-flash",
  "gemini-3.1-flash-lite",
  "gemini-3-flash-preview",
  "gemini-2.5-flash-lite",
  "gemini-2.5-pro",
];

const SYSTEM_PROMPT_STRICT = `You are an expert documentation assistant.

Answer ONLY from the provided document context below. If multiple context snippets contain relevant information, combine them into one complete, well-structured answer.

For scenario-based or "how would you troubleshoot / how would you handle" questions, use logical, step-by-step reasoning built ONLY from facts present in the provided context. Do not invent facts, transaction codes, or steps that are not supported by the context.

If the context does not contain enough information to answer, respond exactly with:
"I could not find sufficient information in the uploaded documents to answer this question."

Formatting rules:
- Use headings, bullet points, numbered steps, and tables where helpful.
- Bold key terms.
- Keep interview-style answers crisp and structured.
- Always mention which source document(s) and page number(s) you drew from, inline or at the end, using the document names and page numbers exactly as given in the context.
- Do not repeat the raw context verbatim at length; synthesize it in your own words.`;

const SYSTEM_PROMPT_BALANCED = `You are an expert documentation assistant and an experienced SAP Security / GRC Access Control practitioner.

Treat the provided document context as your primary and authoritative source — always ground your answer in it first, and cite the specific document name(s) and page number(s) you used.

For scenario-based, troubleshooting, or "how would you handle X" interview questions, you don't need the exact scenario to appear verbatim in the documents. Instead:
1. Pull out whatever relevant concepts, transaction codes, steps, or rules the context DOES contain.
2. Use standard, well-established SAP Security/GRC professional reasoning and best practice to connect those pieces into a coherent, logical, step-by-step answer — the way an experienced consultant would reason through the problem in an interview.
3. Clearly label any part of the answer that relies on general professional knowledge rather than the uploaded documents, using a short inline note like "(general best practice — not explicitly in your documents)". Never contradict something the documents actually say.
4. Never fabricate a specific fact (a transaction code, table name, exact setting, or system behavior) that isn't in the context and isn't extremely well-established, common knowledge in the field. When unsure, say so instead of guessing.

Only say "I could not find sufficient information in the uploaded documents to answer this question" if the context is genuinely unrelated to the question — not merely because the exact scenario wasn't spelled out.

Formatting rules:
- Use headings, bullet points, numbered steps, and tables where helpful.
- Bold key terms.
- Keep interview-style answers crisp, structured, and confident.
- Always mention which source document(s) and page number(s) grounded the factual parts of your answer.
- Do not repeat the raw context verbatim at length; synthesize it in your own words.`;

/* -------------------------------------------------------------------------
   1. DOM REFERENCES
------------------------------------------------------------------------- */
const $ = (id) => document.getElementById(id);

const sidebar = $("sidebar");
const dropzone = $("dropzone");
const pdfInput = $("pdfInput");
const docList = $("docList");
const docStats = $("docStats");
const uploadProgress = $("uploadProgress");
const progressFill = $("progressFill");
const progressLabel = $("progressLabel");

const chatWindow = $("chatWindow");
const emptyState = $("emptyState");
const messageInput = $("messageInput");
const sendBtn = $("sendBtn");
const composerHint = $("composerHint");
const chatTitle = $("chatTitle");
const chatHistoryList = $("chatHistoryList");
const searchChatsInput = $("searchChats");

const settingsModal = $("settingsModal");
const apiKeyInput = $("apiKeyInput");
const modelSelect = $("modelSelect");
const reasoningModeSelect = $("reasoningModeSelect");
const topKInput = $("topKInput");

/* -------------------------------------------------------------------------
   2. INDEXEDDB HELPERS  (persistent, large-capacity storage for PDF chunks)
------------------------------------------------------------------------- */
let dbPromise = new Promise((resolve, reject) => {
  const req = indexedDB.open(DB_NAME, DB_VERSION);
  req.onupgradeneeded = (e) => {
    const db = e.target.result;
    if (!db.objectStoreNames.contains("docs")) {
      db.createObjectStore("docs", { keyPath: "id" });
    }
    if (!db.objectStoreNames.contains("chunks")) {
      const store = db.createObjectStore("chunks", { keyPath: "id" });
      store.createIndex("docId", "docId", { unique: false });
    }
  };
  req.onsuccess = (e) => resolve(e.target.result);
  req.onerror = (e) => reject(e.target.error);
});

async function idbAll(storeName) {
  const db = await dbPromise;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const store = tx.objectStore(storeName);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(storeName, value) {
  const db = await dbPromise;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDeleteByDocId(docId) {
  const db = await dbPromise;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["docs", "chunks"], "readwrite");
    tx.objectStore("docs").delete(docId);
    const idx = tx.objectStore("chunks").index("docId");
    const req = idx.openCursor(IDBKeyRange.only(docId));
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbClearAll() {
  const db = await dbPromise;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["docs", "chunks"], "readwrite");
    tx.objectStore("docs").clear();
    tx.objectStore("chunks").clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/* -------------------------------------------------------------------------
   3. APP STATE
------------------------------------------------------------------------- */
const state = {
  docs: [],          // [{id, name, pageCount, chunkCount, addedAt}]
  chunks: [],        // [{id, docId, docName, page, text}]
  fuse: null,
  chats: [],         // [{id, title, messages:[], createdAt}]
  currentChatId: null,
  settings: {
    apiKey: "",
    model: "gemini-3.5-flash",
    topK: 8,
    reasoningMode: "balanced",
  },
  theme: "dark",
};

function loadSettings() {
  try {
    const raw = localStorage.getItem("docbot_settings");
    if (raw) Object.assign(state.settings, JSON.parse(raw));
  } catch (e) {}
  apiKeyInput.value = state.settings.apiKey || "";
  modelSelect.value = state.settings.model || "gemini-3.5-flash";
  reasoningModeSelect.value = state.settings.reasoningMode || "balanced";
  topKInput.value = state.settings.topK || 8;
}

function saveSettings() {
  state.settings.apiKey = apiKeyInput.value.trim();
  state.settings.model = modelSelect.value;
  state.settings.reasoningMode = reasoningModeSelect.value;
  state.settings.topK = parseInt(topKInput.value, 10) || 8;
  localStorage.setItem("docbot_settings", JSON.stringify(state.settings));
}

function loadChats() {
  try {
    const raw = localStorage.getItem("docbot_chats");
    state.chats = raw ? JSON.parse(raw) : [];
  } catch (e) {
    state.chats = [];
  }
  state.currentChatId = localStorage.getItem("docbot_current_chat") || null;
}

function persistChats() {
  localStorage.setItem("docbot_chats", JSON.stringify(state.chats));
  if (state.currentChatId) {
    localStorage.setItem("docbot_current_chat", state.currentChatId);
  }
}

function getCurrentChat() {
  return state.chats.find((c) => c.id === state.currentChatId) || null;
}

/* -------------------------------------------------------------------------
   4. THEME
------------------------------------------------------------------------- */
function applyTheme() {
  document.body.className = state.theme === "dark" ? "theme-dark" : "theme-light";
  $("themeToggleBtn").textContent = state.theme === "dark" ? "🌙" : "☀️";
  $("hljs-theme").href =
    state.theme === "dark"
      ? "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css"
      : "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css";
}

$("themeToggleBtn").addEventListener("click", () => {
  state.theme = state.theme === "dark" ? "light" : "dark";
  localStorage.setItem("docbot_theme", state.theme);
  applyTheme();
});

/* -------------------------------------------------------------------------
   5. SIDEBAR TOGGLE (mobile)
------------------------------------------------------------------------- */
$("openSidebarBtn").addEventListener("click", () => sidebar.classList.remove("collapsed"));
$("closeSidebarBtn").addEventListener("click", () => sidebar.classList.add("collapsed"));

/* -------------------------------------------------------------------------
   6. PDF UPLOAD & PROCESSING
------------------------------------------------------------------------- */
pdfInput.addEventListener("change", (e) => handleFiles(e.target.files));

["dragenter", "dragover"].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.add("dragover");
  })
);
["dragleave", "drop"].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
  })
);
dropzone.addEventListener("drop", (e) => {
  const files = Array.from(e.dataTransfer.files).filter((f) => f.type === "application/pdf");
  if (files.length) handleFiles(files);
});
dropzone.addEventListener("click", () => pdfInput.click());

function chunkText(text, page) {
  const chunks = [];
  let start = 0;
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return chunks;
  while (start < clean.length) {
    const end = Math.min(start + CHUNK_SIZE, clean.length);
    chunks.push(clean.slice(start, end));
    if (end === clean.length) break;
    start = end - CHUNK_OVERLAP;
  }
  return chunks;
}

async function extractPdf(file, onPageProgress) {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const text = content.items.map((it) => it.str).join(" ");
    pages.push({ page: i, text });
    if (onPageProgress) onPageProgress(i, pdf.numPages);
  }
  return pages;
}

async function handleFiles(fileList) {
  const files = Array.from(fileList);
  if (!files.length) return;
  uploadProgress.classList.remove("hidden");

  for (let fi = 0; fi < files.length; fi++) {
    const file = files[fi];
    const docId = "doc_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
    progressLabel.textContent = `Processing ${file.name} (${fi + 1}/${files.length})…`;
    progressFill.style.width = "5%";

    try {
      const pages = await extractPdf(file, (cur, total) => {
        progressFill.style.width = Math.round((cur / total) * 100) + "%";
        progressLabel.textContent = `Extracting ${file.name}: page ${cur}/${total}`;
      });

      let chunkCount = 0;
      const newChunks = [];
      pages.forEach(({ page, text }) => {
        chunkText(text, page).forEach((ct) => {
          const chunkId = docId + "_c" + chunkCount;
          newChunks.push({ id: chunkId, docId, docName: file.name, page, text: ct });
          chunkCount++;
        });
      });

      const docMeta = {
        id: docId,
        name: file.name,
        pageCount: pages.length,
        chunkCount,
        addedAt: Date.now(),
      };

      await idbPut("docs", docMeta);
      for (const c of newChunks) await idbPut("chunks", c);

      state.docs.push(docMeta);
      state.chunks.push(...newChunks);
    } catch (err) {
      console.error(err);
      alert(`Failed to process ${file.name}: ${err.message}`);
    }
  }

  rebuildFuseIndex();
  renderDocList();
  uploadProgress.classList.add("hidden");
  progressFill.style.width = "0%";
  pdfInput.value = "";
  updateComposerHint();
}

function rebuildFuseIndex() {
  state.fuse = new Fuse(state.chunks, {
    keys: ["text"],
    includeScore: true,
    threshold: 0.4,
    ignoreLocation: true,
    minMatchCharLength: 3,
    useExtendedSearch: true,
  });
}

/* -------------------------------------------------------------------------
   7. DOCUMENT LIST RENDERING
------------------------------------------------------------------------- */
function renderDocList() {
  docList.innerHTML = "";
  state.docs.forEach((doc) => {
    const li = document.createElement("li");
    li.className = "doc-item";
    li.innerHTML = `
      <span class="doc-icon">📄</span>
      <span class="doc-name" title="${escapeHtml(doc.name)}">${escapeHtml(doc.name)}</span>
      <span class="doc-remove" data-id="${doc.id}" title="Remove">✕</span>
    `;
    docList.appendChild(li);
  });
  docStats.textContent = state.docs.length
    ? `${state.docs.length} document${state.docs.length > 1 ? "s" : ""} • ${state.chunks.length} chunks indexed`
    : "No documents yet";

  docList.querySelectorAll(".doc-remove").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const docId = e.currentTarget.dataset.id;
      if (!confirm("Remove this document and its indexed content?")) return;
      await idbDeleteByDocId(docId);
      state.docs = state.docs.filter((d) => d.id !== docId);
      state.chunks = state.chunks.filter((c) => c.docId !== docId);
      rebuildFuseIndex();
      renderDocList();
      updateComposerHint();
    });
  });
}

function updateComposerHint() {
  composerHint.textContent = state.docs.length
    ? "Answers are grounded strictly in your uploaded documents."
    : "No documents loaded yet — upload PDFs from the sidebar to get started.";
}

/* -------------------------------------------------------------------------
   8. CHAT SESSION MANAGEMENT
------------------------------------------------------------------------- */
function createNewChat() {
  const chat = { id: "chat_" + Date.now(), title: "New Chat", messages: [], createdAt: Date.now() };
  state.chats.unshift(chat);
  state.currentChatId = chat.id;
  persistChats();
  renderChatHistory();
  renderMessages();
  chatTitle.textContent = chat.title;
}

function renderChatHistory(filter = "") {
  chatHistoryList.innerHTML = "";
  const list = state.chats.filter((c) => {
    if (!filter) return true;
    const hay = (c.title + " " + c.messages.map((m) => m.content).join(" ")).toLowerCase();
    return hay.includes(filter.toLowerCase());
  });
  list.forEach((chat) => {
    const li = document.createElement("li");
    li.className = "chat-history-item" + (chat.id === state.currentChatId ? " active" : "");
    li.textContent = chat.title || "Untitled chat";
    li.addEventListener("click", () => {
      state.currentChatId = chat.id;
      persistChats();
      renderChatHistory(searchChatsInput.value);
      renderMessages();
      chatTitle.textContent = chat.title;
      sidebar.classList.add("collapsed");
    });
    chatHistoryList.appendChild(li);
  });
}

searchChatsInput.addEventListener("input", () => renderChatHistory(searchChatsInput.value));

$("newChatBtn").addEventListener("click", () => {
  createNewChat();
});

$("clearChatBtn").addEventListener("click", () => {
  const chat = getCurrentChat();
  if (!chat) return;
  if (!confirm("Clear all messages in this chat?")) return;
  chat.messages = [];
  chat.title = "New Chat";
  persistChats();
  renderMessages();
  chatTitle.textContent = chat.title;
});

/* -------------------------------------------------------------------------
   9. MESSAGE RENDERING
------------------------------------------------------------------------- */
function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

function renderMarkdown(md) {
  const html = marked.parse(md || "");
  const wrapper = document.createElement("div");
  wrapper.innerHTML = html;
  wrapper.querySelectorAll("pre code").forEach((block) => hljs.highlightElement(block));
  return wrapper.innerHTML;
}

function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function renderMessages() {
  const chat = getCurrentChat();
  chatWindow.innerHTML = "";
  if (!chat || chat.messages.length === 0) {
    chatWindow.appendChild(emptyState);
    return;
  }
  chat.messages.forEach((msg, idx) => renderSingleMessage(msg, idx));
  chatWindow.scrollTop = chatWindow.scrollHeight;
}

function renderSingleMessage(msg, idx) {
  const row = document.createElement("div");
  row.className = "msg-row " + msg.role;

  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = msg.role === "user" ? "🧑" : "🤖";

  const col = document.createElement("div");
  col.className = "bubble-col";

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  if (msg.thinking) {
    bubble.innerHTML = `<div class="thinking-dots"><span></span><span></span><span></span></div>`;
  } else {
    bubble.innerHTML = renderMarkdown(msg.content);
    if (msg.sources && msg.sources.length) {
      const src = document.createElement("div");
      src.className = "sources-block";
      src.innerHTML =
        "<strong>Sources:</strong><br>" +
        msg.sources.map((s) => `• ${escapeHtml(s.docName)} (Page ${s.page})`).join("<br>");
      bubble.appendChild(src);
    }
  }
  col.appendChild(bubble);

  if (!msg.thinking) {
    const meta = document.createElement("div");
    meta.className = "msg-meta";
    const time = document.createElement("span");
    time.textContent = formatTime(msg.timestamp);
    meta.appendChild(time);

    const actions = document.createElement("div");
    actions.className = "msg-actions";

    const copyBtn = document.createElement("button");
    copyBtn.className = "msg-action-btn";
    copyBtn.textContent = "📋 Copy";
    copyBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(msg.content);
      copyBtn.textContent = "✅ Copied";
      setTimeout(() => (copyBtn.textContent = "📋 Copy"), 1200);
    });
    actions.appendChild(copyBtn);

    if (msg.role === "assistant") {
      const regenBtn = document.createElement("button");
      regenBtn.className = "msg-action-btn";
      regenBtn.textContent = "🔄 Regenerate";
      regenBtn.addEventListener("click", () => regenerateMessage(idx));
      actions.appendChild(regenBtn);
    }

    meta.appendChild(actions);
    col.appendChild(meta);
  }

  row.appendChild(avatar);
  row.appendChild(col);
  chatWindow.appendChild(row);
}

/* -------------------------------------------------------------------------
   10. RAG RETRIEVAL + GEMINI CALL
------------------------------------------------------------------------- */
const STOPWORDS = new Set([
  "the","a","an","is","are","was","were","how","would","you","your","i","me","my","mine",
  "to","of","in","on","for","and","or","what","which","this","that","these","those",
  "do","does","did","can","could","should","from","with","by","as","if","it","its",
  "be","been","being","not","no","after","before","when","then","there","here","also",
  "more","most","some","such","any","all","each","other","than","so","just","because",
  "about","into","out","up","down","over","under","again","further","once","only","own",
  "same","will","shall","must","may","might","have","has","had","having","am","explain",
  "describe","tell","give","provide","example","step","steps","please",
]);

function extractKeywords(query) {
  return query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

function chunkOrderNum(id) {
  const m = id.match(/_c(\d+)$/);
  return m ? parseInt(m[1], 10) : 0;
}

function neighborChunkId(id, targetNum) {
  if (targetNum < 0) return null;
  return id.replace(/_c\d+$/, "_c" + targetNum);
}

function retrieveContext(query, topK) {
  if (!state.fuse || state.chunks.length === 0) return { contextText: "", sources: [] };

  // Pass 1: fuzzy match on the raw question as typed.
  // Pass 2: OR-match on extracted keywords — this is what rescues scenario-style
  // questions ("I accidentally removed an auth object...") whose exact wording
  // rarely matches the source text, but whose key terms (role, authorization
  // object, PFCG, etc.) do.
  const resultMap = new Map(); // chunk id -> { item, score }

  state.fuse.search(query).forEach((r) => {
    const prev = resultMap.get(r.item.id);
    if (!prev || r.score < prev.score) resultMap.set(r.item.id, { item: r.item, score: r.score });
  });

  const keywords = extractKeywords(query).slice(0, 12);
  if (keywords.length) {
    const orQuery = keywords.map((k) => `'${k}`).join(" | ");
    state.fuse.search(orQuery).forEach((r) => {
      const prev = resultMap.get(r.item.id);
      if (!prev || r.score < prev.score) resultMap.set(r.item.id, { item: r.item, score: r.score });
    });
  }

  let ranked = Array.from(resultMap.values())
    .sort((a, b) => a.score - b.score)
    .slice(0, topK);

  // Pull in the immediate neighboring chunk(s) of each hit — procedures and
  // multi-step explanations often straddle a chunk boundary, so grabbing the
  // next/previous slice of the same document gives the model fuller context.
  const chunkById = new Map(state.chunks.map((c) => [c.id, c]));
  const included = new Set(ranked.map((r) => r.item.id));
  const expansions = [];
  ranked.forEach((r) => {
    const n = chunkOrderNum(r.item.id);
    [n - 1, n + 1].forEach((neighborNum) => {
      const nid = neighborChunkId(r.item.id, neighborNum);
      if (nid && chunkById.has(nid) && !included.has(nid)) {
        included.add(nid);
        expansions.push({ item: chunkById.get(nid), score: r.score + 0.001 });
      }
    });
  });
  ranked = ranked.concat(expansions);

  // Present chunks in natural reading order (by document, then page/position)
  // rather than raw relevance order, so the model can follow a procedure
  // start-to-finish instead of seeing it shuffled.
  ranked.sort((a, b) => {
    if (a.item.docName !== b.item.docName) return a.item.docName.localeCompare(b.item.docName);
    if (a.item.page !== b.item.page) return a.item.page - b.item.page;
    return chunkOrderNum(a.item.id) - chunkOrderNum(b.item.id);
  });

  const sources = [];
  const seenSource = new Set();
  const parts = ranked.map((r) => {
    const c = r.item;
    const key = c.docName + "|" + c.page;
    if (!seenSource.has(key)) {
      seenSource.add(key);
      sources.push({ docName: c.docName, page: c.page });
    }
    return `[Document: ${c.docName} | Page ${c.page}]\n${c.text}`;
  });
  return { contextText: parts.join("\n\n---\n\n"), sources };
}

async function requestGemini(model, apiKey, contents) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const systemPrompt =
    state.settings.reasoningMode === "strict" ? SYSTEM_PROMPT_STRICT : SYSTEM_PROMPT_BALANCED;
  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents,
    generationConfig: { temperature: 0.3, maxOutputTokens: 2048 },
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify(body),
  });
  return res;
}

function isRetiredModelError(status, errText) {
  if (status !== 404) return false;
  const t = errText.toLowerCase();
  return t.includes("no longer available") || t.includes("not found") || t.includes("not_found");
}

async function callGemini(historyMessages, userTurnText) {
  const { apiKey } = state.settings;
  if (!apiKey) throw new Error("NO_API_KEY");

  const contents = historyMessages
    .filter((m) => !m.thinking)
    .slice(-12)
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));
  contents.push({ role: "user", parts: [{ text: userTurnText }] });

  // Build the ordered list of models to try: the user's chosen model first,
  // then the rest of the fallback chain (skipping duplicates).
  const tryOrder = [state.settings.model, ...MODEL_FALLBACK_CHAIN].filter(
    (m, i, arr) => m && arr.indexOf(m) === i
  );

  let lastError = null;
  for (let i = 0; i < tryOrder.length; i++) {
    const model = tryOrder[i];
    let res;
    try {
      res = await requestGemini(model, apiKey, contents);
    } catch (networkErr) {
      lastError = networkErr;
      continue;
    }

    if (res.ok) {
      const data = await res.json();
      const text =
        data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ||
        "I could not find sufficient information in the uploaded documents to answer this question.";

      if (model !== state.settings.model) {
        // The originally selected model was unavailable; remember the one that worked.
        state.settings.model = model;
        localStorage.setItem("docbot_settings", JSON.stringify(state.settings));
        modelSelect.value = model;
        return `${text}\n\n> ⓘ Note: the previously selected Gemini model was retired/unavailable, so this answer used **${model}** instead. Settings have been updated automatically.`;
      }
      return text;
    }

    const errText = await res.text();
    if (isRetiredModelError(res.status, errText) && i < tryOrder.length - 1) {
      // Try the next model in the chain.
      lastError = new Error(`Gemini API error (${res.status}): ${errText.slice(0, 300)}`);
      continue;
    }
    throw new Error(`Gemini API error (${res.status}): ${errText.slice(0, 300)}`);
  }

  throw lastError || new Error("All fallback models failed.");
}

/* -------------------------------------------------------------------------
   11. SEND FLOW
------------------------------------------------------------------------- */
async function sendMessage(rawText) {
  const text = (rawText !== undefined ? rawText : messageInput.value).trim();
  if (!text) return;

  if (!state.settings.apiKey) {
    openSettings();
    alert("Please add your free Gemini API key in Settings first.");
    return;
  }
  if (state.docs.length === 0) {
    alert("Please upload at least one PDF document first.");
    return;
  }

  let chat = getCurrentChat();
  if (!chat) {
    createNewChat();
    chat = getCurrentChat();
  }

  if (chat.messages.length === 0) {
    chat.title = text.length > 42 ? text.slice(0, 42) + "…" : text;
    chatTitle.textContent = chat.title;
  }

  const userMsg = { role: "user", content: text, timestamp: Date.now() };
  chat.messages.push(userMsg);
  persistChats();
  renderMessages();
  renderChatHistory(searchChatsInput.value);

  messageInput.value = "";
  autoResize();

  const thinkingMsg = { role: "assistant", content: "", thinking: true, timestamp: Date.now() };
  chat.messages.push(thinkingMsg);
  renderMessages();

  try {
    const topK = state.settings.topK || 6;
    const { contextText, sources } = retrieveContext(text, topK);

    const userTurnText = contextText
      ? `Context from uploaded documents:\n\n${contextText}\n\nQuestion: ${text}`
      : `No relevant context was found in the uploaded documents.\n\nQuestion: ${text}`;

    const answer = await callGemini(
      chat.messages.slice(0, -1),
      userTurnText
    );

    thinkingMsg.thinking = false;
    thinkingMsg.content = answer;
    thinkingMsg.sources = sources;
    thinkingMsg.timestamp = Date.now();
  } catch (err) {
    thinkingMsg.thinking = false;
    if (err.message === "NO_API_KEY") {
      thinkingMsg.content = "⚠️ No Gemini API key set. Please add one in Settings.";
    } else {
      thinkingMsg.content = `⚠️ Error contacting Gemini API: ${err.message}`;
    }
    thinkingMsg.timestamp = Date.now();
  }

  persistChats();
  renderMessages();
}

async function regenerateMessage(idx) {
  const chat = getCurrentChat();
  if (!chat) return;
  // find the preceding user message
  let userIdx = idx - 1;
  while (userIdx >= 0 && chat.messages[userIdx].role !== "user") userIdx--;
  if (userIdx < 0) return;
  const userText = chat.messages[userIdx].content;

  // remove the old assistant message and everything after it, then resend
  chat.messages = chat.messages.slice(0, idx);
  persistChats();
  await sendMessage(userText);
}

sendBtn.addEventListener("click", () => sendMessage());
messageInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});
messageInput.addEventListener("input", autoResize);
function autoResize() {
  messageInput.style.height = "auto";
  messageInput.style.height = Math.min(messageInput.scrollHeight, 160) + "px";
}

document.querySelectorAll(".chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    messageInput.value = chip.textContent;
    sendMessage();
  });
});

/* -------------------------------------------------------------------------
   12. SETTINGS MODAL
------------------------------------------------------------------------- */
function openSettings() {
  settingsModal.classList.remove("hidden");
}
function closeSettings() {
  settingsModal.classList.add("hidden");
}
$("settingsBtn").addEventListener("click", openSettings);
$("closeSettingsBtn").addEventListener("click", closeSettings);
$("saveSettingsBtn").addEventListener("click", () => {
  saveSettings();
  closeSettings();
});
$("toggleKeyVisibility").addEventListener("click", () => {
  apiKeyInput.type = apiKeyInput.type === "password" ? "text" : "password";
});
$("wipeDataBtn").addEventListener("click", async () => {
  if (!confirm("This deletes ALL uploaded documents and ALL chats from this browser. Continue?")) return;
  await idbClearAll();
  localStorage.removeItem("docbot_chats");
  localStorage.removeItem("docbot_current_chat");
  state.docs = [];
  state.chunks = [];
  state.chats = [];
  rebuildFuseIndex();
  renderDocList();
  createNewChat();
  renderChatHistory();
  closeSettings();
});

/* -------------------------------------------------------------------------
   13. DOWNLOAD CHAT (TXT / PDF)
------------------------------------------------------------------------- */
$("downloadTxtBtn").addEventListener("click", () => {
  const chat = getCurrentChat();
  if (!chat || !chat.messages.length) return alert("No messages to export yet.");
  let out = `Ansuha's Personal AI Chat Export — ${chat.title}\n${new Date().toLocaleString()}\n\n`;
  chat.messages.forEach((m) => {
    if (m.thinking) return;
    out += `[${formatTime(m.timestamp)}] ${m.role === "user" ? "You" : "Ansuha's Personal AI"}:\n${m.content}\n`;
    if (m.sources && m.sources.length) {
      out += "Sources:\n" + m.sources.map((s) => ` - ${s.docName} (Page ${s.page})`).join("\n") + "\n";
    }
    out += "\n";
  });
  const blob = new Blob([out], { type: "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${chat.title.replace(/[^a-z0-9]+/gi, "_")}.txt`;
  a.click();
});

$("downloadPdfBtn").addEventListener("click", () => {
  const chat = getCurrentChat();
  if (!chat || !chat.messages.length) return alert("No messages to export yet.");
  const printArea = $("printArea");
  let html = `<h2>${escapeHtml(chat.title)}</h2><p style="color:#666;font-size:12px;">${new Date().toLocaleString()}</p><hr>`;
  chat.messages.forEach((m) => {
    if (m.thinking) return;
    html += `<div style="margin-bottom:16px;">
      <div style="font-weight:700;font-size:12px;color:#444;">${m.role === "user" ? "You" : "Ansuha's Personal AI"} — ${formatTime(m.timestamp)}</div>
      <div style="font-size:13px;line-height:1.5;">${renderMarkdown(m.content)}</div>`;
    if (m.sources && m.sources.length) {
      html += `<div style="font-size:11px;color:#666;margin-top:4px;">Sources: ${m.sources
        .map((s) => `${escapeHtml(s.docName)} (Page ${s.page})`)
        .join("; ")}</div>`;
    }
    html += `</div>`;
  });
  printArea.innerHTML = html;
  window.print();
});

/* -------------------------------------------------------------------------
   14. BOOT
------------------------------------------------------------------------- */
async function boot() {
  state.theme = localStorage.getItem("docbot_theme") || "light";
  applyTheme();
  loadSettings();
  loadChats();

  try {
    state.docs = await idbAll("docs");
    state.chunks = await idbAll("chunks");
  } catch (e) {
    console.error("IndexedDB load failed", e);
  }
  rebuildFuseIndex();
  renderDocList();
  updateComposerHint();

  if (!state.currentChatId || !getCurrentChat()) {
    createNewChat();
  } else {
    renderChatHistory();
    renderMessages();
    chatTitle.textContent = getCurrentChat().title;
  }

  if (window.innerWidth <= 860) sidebar.classList.add("collapsed");
}

boot();