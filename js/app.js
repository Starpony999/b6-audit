import { api, clearToken, getToken, scriptConfigured, sendKeepalive, setToken } from "./api.js";
import {
  auditQuestionHtml,
  defaultDueDate,
  escapeHtml,
  groupQuestionsBySection,
  mergeSectionAnswers,
  stepSection,
} from "./audit-ui.js";
import { bindBuilderControls, loadBuilderHome, openBuilderTemplate, registerBuilder } from "./builder.js";
import { AUTOSAVE_INTERVAL_MS, buildPausePayload, createAutosaveController, shouldSaveAudit } from "./autosave.js";
import {
  DEFAULT_PAST_DUE_FILTERS,
  DUE_MODES,
  TODO_STATUSES,
  cloneFilters,
  filterChips,
  filterPastDueItems,
  groupPastDueItems,
  loadPastDueFilters,
  normalizeTodoStatus,
  removeFilterChip,
  savePastDueFilters,
  statusLabel,
} from "./past-due-filters.js";
import { mediaPickerSpecs, uploadAuditFile } from "./media.js";
import {
  NEXT_KEY,
  clearDraft,
  draftForUser,
  hashForRoute,
  routeFromHash,
  saveDraft,
} from "./routes.js";

const VIEWS = ["login", "password", "home", "links", "templates", "users", "audit", "todos", "mytodos", "pastdue", "builder", "builder-detail"];

const state = {
  user: null,
  stores: [],
  sections: [],
  sectionIndex: 0,
  answers: {},
  media: {},
  audit: null,
  submitting: false,
  todosLocked: false,
  lastResult: null,
  builderTemplateId: null,
  builderQuestionIds: [],
  saveAllBusy: false,
  ready: false,
};

registerBuilder({
  state,
  showView,
  setStatus,
});

function setStatus(id, message, isError) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = message || "";
  el.className = isError ? "error" : "muted";
}

function showView(name, extra) {
  extra = extra || {};
  if (name === "builder-detail" && extra.templateId) state.builderTemplateId = extra.templateId;
  const route = {
    name,
    store: name === "templates" ? (extra.store != null ? extra.store : storeValue()) : "",
    auditId: name === "todos"
      ? ((state.lastResult && state.lastResult.auditId) || (state.audit && state.audit.auditId) || "")
      : (state.audit && state.audit.auditId) || "",
    section: state.sectionIndex || 0,
    templateId: extra.templateId || state.builderTemplateId || "",
  };
  go(route);
}

function storeValue() {
  const select = document.getElementById("auditStore");
  return select ? select.value.trim() : "";
}

function rememberDraft() {
  if (state.audit && state.user) saveDraft(localStorage, state, state.user.email);
  autosave.touch();
}

function auditViewIsActive() {
  const view = document.getElementById("view-audit");
  return !!(view && view.classList.contains("active"));
}

function pauseSnapshot() {
  if (!shouldSaveAudit(state, auditViewIsActive())) return null;
  return buildPausePayload(state.audit, state.answers, state.media, state.sectionIndex);
}

function captureAuditDom() {
  const view = document.getElementById("view-audit");
  if (!view || !view.classList.contains("active") || !state.audit) return;
  captureSection();
  if (state.audit && state.user) saveDraft(localStorage, state, state.user.email);
}

const autosave = createAutosaveController({
  intervalMs: AUTOSAVE_INTERVAL_MS,
  capture: captureAuditDom,
  snapshot: pauseSnapshot,
  post: (payload) => api("pauseAudit", payload),
  keepalive: (payload) => sendKeepalive("pauseAudit", payload),
  onStatus: (text) => {
    const el = document.getElementById("autosaveStatus");
    if (el) el.textContent = text || "";
  },
  onSaved: () => {
    refreshContinueList();
  },
});

function isOpenRoute(name) {
  return name === "login" || name === "links";
}

function closeSiteNav() {
  const nav = document.getElementById("siteNav");
  const toggle = document.getElementById("navToggle");
  const menu = document.getElementById("adminMenu");
  const adminBtn = document.getElementById("adminMenuBtn");
  if (nav) nav.classList.remove("open");
  if (toggle) toggle.setAttribute("aria-expanded", "false");
  if (menu) menu.hidden = true;
  if (adminBtn) adminBtn.setAttribute("aria-expanded", "false");
}

function go(route, opts) {
  let next = route;
  if (!state.user && !isOpenRoute(next.name)) {
    try { sessionStorage.setItem(NEXT_KEY, hashForRoute(next)); } catch (err) {}
    next = { name: "login" };
  } else if (state.user && state.user.mustChangePassword && next.name !== "password" && next.name !== "login") {
    try { sessionStorage.setItem(NEXT_KEY, hashForRoute(next)); } catch (err) {}
    next = { name: "password" };
  }
  const hash = hashForRoute(next);
  const current = location.hash || "#/home";
  if (current === hash) {
    applyRoute(routeFromHash(hash));
    return;
  }
  if (opts && opts.replace) {
    history.replaceState(null, "", hash);
    applyRoute(routeFromHash(hash));
    return;
  }
  location.hash = hash;
}

function activate(name) {
  VIEWS.forEach((view) => {
    const el = document.getElementById("view-" + view);
    if (el) el.classList.toggle("active", view === name);
  });
  document.querySelectorAll("#siteNav a[data-nav]").forEach((link) => {
    const on = link.dataset.nav === name;
    link.classList.toggle("is-current", on);
    if (on) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  paintHome();
  window.scrollTo(0, 0);
}

function applyRoute(route) {
  if (!state.user && !isOpenRoute(route.name)) {
    try { sessionStorage.setItem(NEXT_KEY, hashForRoute(route)); } catch (err) {}
    if ((location.hash || "") !== "#/login") {
      history.replaceState(null, "", "#/login");
    }
    activate("login");
    return;
  }
  if (state.user && state.user.mustChangePassword && route.name !== "password") {
    try { sessionStorage.setItem(NEXT_KEY, hashForRoute(route)); } catch (err) {}
    if ((location.hash || "") !== "#/password") history.replaceState(null, "", "#/password");
    activate("password");
    return;
  }
  const onAudit = document.getElementById("view-audit").classList.contains("active");
  if (onAudit && state.audit && route.auditId === state.audit.auditId && (route.name === "audit" || route.name === "todos")) {
    captureSection();
    rememberDraft();
  } else if (onAudit && state.audit && route.name !== "audit" && route.name !== "todos") {
    captureSection();
    rememberDraft();
    autosave.flush();
  }
  activate(route.name);
  if (route.name === "home") loadPausedHome();
  if (route.name === "templates") {
    fillStores();
    const select = document.getElementById("auditStore");
    if (route.store && Array.from(select.options).some((option) => option.value === route.store)) {
      select.value = route.store;
    }
    loadTemplates();
  }
  if (route.name === "audit") restoreAudit(route);
  if (route.name === "todos") restoreReview(route);
  if (route.name === "users") loadUsers();
  if (route.name === "mytodos") loadMyTodos();
  if (route.name === "pastdue") loadPastDue();
  if (route.name === "builder") loadBuilderHome();
  if (route.name === "builder-detail") openBuilderTemplate(route.templateId);
}

function adoptDraft(draft) {
  state.audit = draft.audit;
  state.answers = draft.answers || {};
  state.media = {};
  Object.keys(draft.media || {}).forEach((id) => {
    state.media[id] = (draft.media[id] || []).map((file) => ({
      objectKey: file.objectKey,
      fileName: file.fileName,
      mimeType: file.mimeType,
      previewUrl: "",
    }));
  });
  state.sections = groupQuestionsBySection((draft.audit && draft.audit.questions) || []);
  state.lastResult = draft.lastResult || null;
  state.todosLocked = !!draft.todosLocked;
  state.submitting = false;
}

function clampSection(index) {
  const max = state.sections.length;
  if (!max) return 0;
  const n = Number(index) || 0;
  return Math.min(Math.max(0, n), max - 1);
}

function applyResumePayload(data) {
  state.audit = {
    auditId: data.auditId,
    store: data.store,
    storeLabel: data.storeLabel || "",
    templateName: data.templateName || "",
    questions: data.questions || [],
  };
  state.answers = {};
  state.media = {};
  state.sections = groupQuestionsBySection(state.audit.questions);
  (state.audit.questions || []).forEach((q) => {
    state.answers[q.questionId] = { answer: "", note: "" };
  });
  (data.answers || []).forEach((item) => {
    state.answers[item.questionId] = { answer: item.answer || "", note: item.note || "" };
    const keys = Array.isArray(item.mediaUrls)
      ? item.mediaUrls
      : String(item.mediaUrls || "").split("|").filter(Boolean);
    if (keys.length) {
      state.media[item.questionId] = keys.map((objectKey) => ({
        objectKey,
        fileName: String(objectKey).split("/").pop() || "file",
        mimeType: "",
        previewUrl: "",
      }));
    }
  });
  state.lastResult = null;
  state.todosLocked = false;
  state.submitting = false;
  state.sectionIndex = clampSection(data.sectionIndex);
}

async function restoreAudit(route) {
  const box = document.getElementById("auditBox");
  if (state.audit && state.audit.auditId === route.auditId) {
    state.sectionIndex = clampSection(route.section);
    renderAuditSection();
    return;
  }
  const draft = draftForUser(localStorage, state.user && state.user.email);
  if (draft && draft.audit.auditId === route.auditId) {
    adoptDraft(draft);
    state.sectionIndex = clampSection(route.section);
    renderAuditSection();
    autosave.flush();
    return;
  }
  box.textContent = "Loading paused audit…";
  try {
    const data = await api("resumePausedAudit", { auditId: route.auditId });
    applyResumePayload(data);
    state.sectionIndex = clampSection(route.section != null ? route.section : data.sectionIndex);
    autosave.resume();
    rememberDraft();
    autosave.acknowledge();
    renderAuditSection();
  } catch (err) {
    state.audit = null;
    const denied = err.code === "forbidden";
    box.innerHTML = '<p><a class="button" href="#/audits">← Audits</a></p>' +
      "<h2>Doing audit</h2>" +
      '<p class="muted">' + escapeHtml(denied
        ? err.message
        : "This audit is not saved for you. Start it again from Audits, or ask the person who paused it.") + "</p>";
  }
}

function formatPausedWhen(iso) {
  const date = new Date(iso);
  if (isNaN(date.getTime())) return "";
  return date.toLocaleString();
}

function renderPausedList(container, items, emptyText) {
  container.innerHTML = "";
  if (!items.length) {
    if (emptyText) {
      const note = document.createElement("p");
      note.className = "muted";
      note.textContent = emptyText;
      container.appendChild(note);
    }
    return;
  }
  const heading = document.createElement("h2");
  heading.textContent = "Continue audit";
  container.appendChild(heading);
  items.forEach((item) => {
    const card = document.createElement("div");
    card.className = "card";
    const who = state.user && state.user.role === "admin"
      ? (item.auditorName || item.auditorEmail || "Someone")
      : "";
    card.innerHTML =
      "<strong>" + escapeHtml(item.templateName || "Checklist") + "</strong>" +
      '<p class="muted">' + escapeHtml(item.store || "") +
      (item.storeLabel ? " — " + escapeHtml(item.storeLabel) : "") +
      (who ? " · Started by " + escapeHtml(who) : "") +
      (item.updatedAt ? " · Saved " + escapeHtml(formatPausedWhen(item.updatedAt)) : "") +
      "</p>";
    const row = document.createElement("div");
    row.className = "nav-row";
    const resume = document.createElement("button");
    resume.type = "button";
    resume.textContent = "Continue";
    resume.addEventListener("click", () => resumePaused(item.auditId));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "secondary";
    remove.textContent = "Delete";
    remove.addEventListener("click", () => deletePaused(item.auditId, container));
    row.append(resume, remove);
    card.appendChild(row);
    container.appendChild(card);
  });
}

async function loadPausedHome() {
  const box = document.getElementById("continueAudits");
  if (!box) return;
  box.innerHTML = "";
  try {
    const data = await api("listPausedAudits", {});
    renderPausedList(box, data.paused || [], "");
  } catch (err) {
    box.textContent = err.message;
  }
}

async function resumePaused(auditId) {
  try {
    const data = await api("resumePausedAudit", { auditId });
    applyResumePayload(data);
    autosave.resume();
    rememberDraft();
    autosave.acknowledge();
    go({ name: "audit", auditId: data.auditId, section: state.sectionIndex });
  } catch (err) {
    window.alert(err.message);
  }
}

async function deletePaused(auditId, container) {
  const label = state.audit && state.audit.auditId === auditId ? "this audit" : "this paused audit";
  if (!window.confirm("Delete " + label + "? Saved answers that were only in the pause will be removed.")) return;
  const deletingCurrent = !!(state.audit && state.audit.auditId === auditId);
  if (deletingCurrent) autosave.suspend();
  try {
    await autosave.whenIdle();
    await api("deletePausedAudit", { auditId });
    if (state.audit && state.audit.auditId === auditId) {
      clearDraft(localStorage);
      state.audit = null;
      state.answers = {};
      state.media = {};
      state.lastResult = null;
    } else {
      const draft = draftForUser(localStorage, state.user && state.user.email);
      if (draft && draft.audit.auditId === auditId) clearDraft(localStorage);
    }
    if (container && container.id === "continueAudits") await loadPausedHome();
    else await loadTemplates();
  } catch (err) {
    if (deletingCurrent) autosave.resume();
    window.alert(err.message);
  }
}

function restoreReview(route) {
  if (state.lastResult && state.lastResult.auditId === route.auditId) {
    autosave.suspend();
    showTodoReview(state.lastResult);
    return;
  }
  const draft = draftForUser(localStorage, state.user && state.user.email);
  if (draft && draft.audit.auditId === route.auditId && draft.lastResult) {
    adoptDraft(draft);
    autosave.suspend();
    showTodoReview(draft.lastResult);
    return;
  }
  if (draft && draft.audit.auditId === route.auditId) {
    adoptDraft(draft);
    autosave.resume();
    go({ name: "audit", auditId: route.auditId, section: draft.sectionIndex || 0 }, { replace: true });
    return;
  }
  document.getElementById("todosBox").innerHTML =
    '<p><a class="button" href="#/audits">← Audits</a></p>' +
    "<h2>Review to-dos</h2>" +
    '<p class="muted">This review is not on this phone anymore. If to-dos were already created, they are under My to-dos.</p>';
}

function paintHome() {
  const admin = !!(state.user && state.user.role === "admin");
  document.getElementById("homeUsersCard").hidden = !admin;
  document.getElementById("homeBuilderCard").hidden = !admin;
  document.getElementById("homePastDueCard").hidden = !admin;
  document.querySelectorAll("[data-admin-nav]").forEach((el) => { el.hidden = !admin; });
  const who = document.getElementById("whoami");
  const logout = document.getElementById("logoutBtn");
  if (state.user) {
    who.textContent = state.user.name + " · " + state.user.role;
    logout.hidden = false;
    logout.textContent = "Log out";
  } else {
    who.textContent = "";
    logout.hidden = false;
    logout.textContent = "Login";
  }
}

function acceptSession(data) {
  setToken(data.token);
  state.user = data.user;
  state.stores = data.stores || [];
  if (!draftForUser(localStorage, data.user.email)) clearDraft(localStorage);
  let next = "";
  try { next = sessionStorage.getItem(NEXT_KEY) || ""; } catch (err) { next = ""; }
  try { sessionStorage.removeItem(NEXT_KEY); } catch (err) {}
  if (data.mustChangePassword || data.user.mustChangePassword) {
    go({ name: "password" }, { replace: true });
    return;
  }
  if (next && next !== "#/login" && next !== "#/password") {
    history.replaceState(null, "", next);
    applyRoute(routeFromHash(next));
    return;
  }
  go({ name: "home" }, { replace: true });
}

function fillStores() {
  const select = document.getElementById("auditStore");
  const current = select.value;
  select.innerHTML = '<option value="">Select a store…</option>';
  (state.stores || []).forEach((store) => {
    const option = document.createElement("option");
    option.value = store.code;
    option.textContent = store.code + " — " + store.label;
    select.appendChild(option);
  });
  if (Array.from(select.options).some((option) => option.value === current)) select.value = current;
  else if ((state.stores || []).length === 1) select.value = state.stores[0].code;
}

async function loadTemplates() {
  const box = document.getElementById("templates");
  const store = document.getElementById("auditStore").value.trim();
  if (!store) {
    const pausedBox = document.getElementById("pausedForStore");
    if (pausedBox) pausedBox.innerHTML = "";
    box.textContent = (state.stores || []).length
      ? "Select a store to see checklists…"
      : "Your account does not cover a store yet. Ask an admin.";
    return;
  }
  box.textContent = "Loading checklists for " + store + "…";
  const pausedBox = document.getElementById("pausedForStore");
  if (pausedBox) pausedBox.innerHTML = "";
  try {
    const paused = await api("listPausedAudits", { store });
    if (pausedBox) renderPausedList(pausedBox, paused.paused || [], "");
  } catch (err) {
    if (pausedBox) pausedBox.textContent = err.message;
  }
  try {
    const data = await api("listTemplatesForStore", { store });
    const templates = data.templates || [];
    if (!templates.length) {
      box.textContent = "No checklists apply to " + store + ". Ask an admin to set Applies to.";
      return;
    }
    box.innerHTML = "";
    templates.forEach((template) => {
      const card = document.createElement("div");
      card.className = "card";
      card.innerHTML =
        "<strong>" + escapeHtml(template.name) + "</strong>" +
        '<p class="muted">' + escapeHtml(template.description || "") + "</p>" +
        '<p class="muted">Applies to: ' + escapeHtml(template.appliesTo || "ALL") + "</p>";
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "Select";
      button.addEventListener("click", () => startAudit(template.templateId));
      card.appendChild(button);
      box.appendChild(card);
    });
  } catch (err) {
    box.textContent = err.message;
  }
}

async function startAudit(templateId) {
  const store = document.getElementById("auditStore").value.trim();
  if (!store) {
    window.alert("Pick a store for this audit before starting.");
    return;
  }
  const box = document.getElementById("templates");
  const previous = box.textContent;
  box.textContent = "Starting audit…";
  try {
    const payload = await api("beginAudit", { templateId, store });
    state.audit = payload;
    state.answers = {};
    state.media = {};
    state.sectionIndex = 0;
    state.submitting = false;
    state.todosLocked = false;
    state.lastResult = null;
    state.sections = groupQuestionsBySection(payload.questions || []);
    (payload.questions || []).forEach((q) => {
      state.answers[q.questionId] = { answer: "", note: "" };
    });
    autosave.resume();
    rememberDraft();
    go({ name: "audit", auditId: payload.auditId, section: 0 });
  } catch (err) {
    box.textContent = err.message || previous;
  }
}

async function pauseCurrentAudit() {
  if (!state.audit) return;
  captureSection();
  rememberDraft();
  setStatus("status", "Pausing…");
  const outcome = await autosave.flush();
  if (outcome.error) {
    setStatus("status", outcome.error.message, true);
    return;
  }
  if (!outcome.saved && outcome.skip !== "unchanged") {
    setStatus("status", "Not saved yet", true);
    return;
  }
  showView("home");
}

async function refreshContinueList() {
  const route = routeFromHash(location.hash || "");
  if (route.name === "home") return loadPausedHome();
  if (route.name !== "templates") return;
  const box = document.getElementById("pausedForStore");
  const store = storeValue();
  if (!box || !store) return;
  try {
    const paused = await api("listPausedAudits", { store });
    renderPausedList(box, paused.paused || [], "");
  } catch (err) {
    box.textContent = err.message;
  }
}

function captureSection() {
  const section = state.sections[state.sectionIndex];
  if (!section) return;
  state.answers = mergeSectionAnswers(section.questions, state.answers, (questionId) => {
    const picked = document.querySelector('input[name="' + CSS.escape(questionId) + '"]:checked');
    const note = document.getElementById("note-" + questionId);
    return { answer: picked ? picked.value : "", note: note ? note.value : null };
  });
}

function renderAuditSection() {
  const box = document.getElementById("auditBox");
  if (!state.audit) {
    box.textContent = "No audit in progress.";
    return;
  }
  if (state.todosLocked) {
    box.innerHTML = '<p><a class="button" href="#/my-todos">My to-dos</a></p>' +
      "<h2>Doing audit</h2>" +
      '<p class="muted">To-dos were already created for this audit, so the answers stay as they were sent. Open My to-dos to work the tasks, or start a new audit.</p>';
    return;
  }
  if (!state.sections.length) {
    box.innerHTML = '<p><button type="button" id="backLists">← Back</button></p><h2>Doing audit</h2><p class="muted">This checklist has no questions.</p>';
    document.getElementById("backLists").addEventListener("click", () => showView("templates"));
    return;
  }
  captureHolder();
  const section = state.sections[state.sectionIndex];
  const total = state.sections.length;
  const storeLine = (state.audit.store || "") + (state.audit.storeLabel ? " — " + state.audit.storeLabel : "");
  box.innerHTML =
    '<p><button type="button" id="leaveAudit">← Back to checklists</button></p>' +
    "<h2>Doing audit</h2>" +
    '<p class="muted">Store: ' + escapeHtml(storeLine) + "</p>" +
    '<p class="muted">Audit id: ' + escapeHtml(state.audit.auditId) + "</p>" +
    '<div class="card"><strong>Section ' + (state.sectionIndex + 1) + " of " + total + ": " + escapeHtml(section.name) +
    "</strong><p class=\"muted\">Answer these items, then continue. Point values stay hidden until you submit. This audit saves to the sheet as you go.</p>" +
    '<p id="autosaveStatus" class="muted autosave-status" role="status">' + escapeHtml(autosave.label()) + "</p></div>";
  document.getElementById("leaveAudit").addEventListener("click", () => {
    captureSection();
    rememberDraft();
    showView("templates");
  });
  section.questions.forEach((q) => {
    const card = document.createElement("div");
    card.className = "card";
    const saved = state.answers[q.questionId] || { answer: "", note: "" };
    card.innerHTML = auditQuestionHtml(q, saved) +
      '<p><input type="text" id="note-' + q.questionId + '" placeholder="Optional note" value="' + escapeHtml(saved.note || "") + '"></p>';
    addMediaControls(card, q);
    box.appendChild(card);
  });
  const nav = document.createElement("div");
  nav.className = "nav-row";
  const pause = document.createElement("button");
  pause.type = "button";
  pause.className = "secondary";
  pause.textContent = "Pause";
  pause.addEventListener("click", pauseCurrentAudit);
  nav.appendChild(pause);
  if (state.sectionIndex > 0) {
    const back = document.createElement("button");
    back.type = "button";
    back.textContent = "← Back";
    back.addEventListener("click", () => {
      captureSection();
      state.sectionIndex = stepSection(state.sectionIndex, state.sections.length, -1);
      rememberDraft();
      autosave.flush();
      go({ name: "audit", auditId: state.audit.auditId, section: state.sectionIndex });
    });
    nav.appendChild(back);
  }
  if (state.sectionIndex < total - 1) {
    const next = document.createElement("button");
    next.type = "button";
    next.textContent = "Next section →";
    next.addEventListener("click", () => {
      captureSection();
      state.sectionIndex = stepSection(state.sectionIndex, state.sections.length, 1);
      rememberDraft();
      autosave.flush();
      go({ name: "audit", auditId: state.audit.auditId, section: state.sectionIndex });
    });
    nav.appendChild(next);
  } else {
    const save = document.createElement("button");
    save.type = "button";
    save.id = "saveBtn";
    save.textContent = "Save answers & continue";
    save.addEventListener("click", saveAndFinish);
    nav.appendChild(save);
  }
  box.appendChild(nav);
  const status = document.createElement("p");
  status.id = "status";
  status.className = "muted";
  box.appendChild(status);
}

function captureHolder() {
  // Answers are captured by the buttons before this render replaces the inputs.
}

function mediaList(questionId) {
  if (!state.media[questionId]) state.media[questionId] = [];
  return state.media[questionId];
}

function addMediaControls(card, q) {
  const wrap = document.createElement("div");
  wrap.className = "media-block";
  const required = q.requiresMedia === true;
  const heading = document.createElement("strong");
  heading.textContent = required ? "Photo/video evidence (Required)" : "Photo/video evidence (Optional)";
  const help = document.createElement("p");
  help.className = "muted";
  help.textContent = "Choose Photo opens this phone’s camera, photo library, or files. You can pick more than one. Photos are compressed here before upload. Videos must be under about 8 MB. Up to 5 files.";
  const status = document.createElement("p");
  status.className = "muted";
  const list = document.createElement("div");
  const actions = document.createElement("div");
  actions.className = "media-actions";
  const pickers = mediaPickerSpecs().map((spec) => fileInput(spec));
  pickers.forEach((picker) => actions.appendChild(picker.label));
  wrap.append(heading, help, actions, status, list);

  function renderList() {
    list.innerHTML = "";
    const files = mediaList(q.questionId);
    if (!files.length) {
      const empty = document.createElement("p");
      empty.className = "muted";
      empty.textContent = "No media attached yet.";
      list.appendChild(empty);
      return;
    }
    files.forEach((media, index) => {
      const row = document.createElement("div");
      row.className = "media-row";
      if (media.previewUrl && String(media.mimeType || "").startsWith("image/")) {
        const img = document.createElement("img");
        img.src = media.previewUrl;
        img.alt = media.fileName || "photo";
        row.appendChild(img);
      }
      const name = document.createElement("span");
      name.textContent = media.fileName || "file";
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "secondary";
      remove.textContent = "Remove";
      remove.addEventListener("click", () => {
        if (media.previewUrl) URL.revokeObjectURL(media.previewUrl);
        state.media[q.questionId] = mediaList(q.questionId).filter((_, i) => i !== index);
        rememberDraft();
        status.textContent = "Removed from this audit. The stored file, if the upload finished, is left in place.";
        renderList();
      });
      row.append(name, document.createTextNode(" "), remove);
      list.appendChild(row);
    });
  }

  async function onFile(file) {
    if (!file) return;
    const checkCount = mediaList(q.questionId).length;
    if (checkCount >= 5) {
      status.textContent = "Limit of 5 media files per question.";
      return;
    }
    status.textContent = String(file.type || "").startsWith("image/") ? "Compressing photo…" : "Preparing video…";
    setPickersEnabled(false);
    try {
      const saved = await uploadAuditFile(api, file, {
        auditId: state.audit.auditId,
        questionId: q.questionId,
        store: state.audit.store,
        existingKeys: mediaList(q.questionId).map((item) => item.objectKey),
      });
      mediaList(q.questionId).push(saved);
      rememberDraft();
      status.textContent = "Upload finished.";
      renderList();
    } catch (err) {
      status.textContent = err.message || "Upload failed.";
    } finally {
      setPickersEnabled(true);
    }
  }

  async function onFiles(fileList) {
    const files = Array.from(fileList || []);
    for (let i = 0; i < files.length; i += 1) {
      if (mediaList(q.questionId).length >= 5) {
        status.textContent = "Limit of 5 media files per question.";
        return;
      }
      await onFile(files[i]);
    }
  }

  function setPickersEnabled(on) {
    pickers.forEach((picker) => { picker.input.disabled = !on; });
  }

  pickers.forEach((picker) => {
    picker.input.addEventListener("change", () => {
      const files = Array.from(picker.input.files || []);
      picker.input.value = "";
      onFiles(files);
    });
  });
  renderList();
  card.appendChild(wrap);
}

function fileInput(spec) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = spec.accept;
  input.className = "visually-hidden";
  if (spec.multiple) input.multiple = true;
  const label = document.createElement("label");
  label.className = "button";
  label.appendChild(document.createTextNode(spec.label));
  label.appendChild(input);
  return { input, label };
}

async function saveAndFinish() {
  if (state.submitting) return;
  if (state.sectionIndex !== state.sections.length - 1 && state.sections.length) {
    setStatus("status", "Finish every section before submitting.", true);
    return;
  }
  captureSection();
  rememberDraft();
  await autosave.whenIdle();
  autosave.suspend();
  const submittedPayload = buildPausePayload(state.audit, state.answers, state.media, state.sectionIndex);
  const questions = state.audit.questions || [];
  const missing = questions.filter((q) => q.requiresMedia && !(state.media[q.questionId] || []).length);
  if (missing.length) {
    autosave.resume();
    setStatus("status", "Required photo/video evidence is missing for: " + missing.map((q) => q.text).join(", "), true);
    return;
  }
  const mediaWithoutAnswer = questions.filter((q) => {
    const files = state.media[q.questionId] || [];
    const answer = (state.answers[q.questionId] || {}).answer;
    return files.length && !answer;
  });
  if (mediaWithoutAnswer.length) {
    autosave.resume();
    setStatus("status", "Pick an answer for each question that has a photo or video, or remove the file: " + mediaWithoutAnswer.map((q) => q.text).join(", "), true);
    return;
  }
  const button = document.getElementById("saveBtn");
  if (button) {
    button.disabled = true;
    button.textContent = "Saving…";
  }
  state.submitting = true;
  setStatus("status", "Saving…");
  try {
    const result = await api("submitAuditAnswers", {
      auditId: state.audit.auditId,
      answers: questions.map((q) => ({
        questionId: q.questionId,
        answer: (state.answers[q.questionId] || {}).answer || "",
        note: (state.answers[q.questionId] || {}).note || "",
        mediaUrls: (state.media[q.questionId] || []).map((file) => file.objectKey),
      })),
    });
    state.lastResult = result;
    autosave.acknowledge(submittedPayload);
    rememberDraft();
    showView("todos");
  } catch (err) {
    state.submitting = false;
    autosave.resume();
    setStatus("status", err.message, true);
    if (button) {
      button.disabled = false;
      button.textContent = "Save answers & continue";
    }
  }
}

async function showTodoReview(result) {
  const box = document.getElementById("todosBox");
  let html =
    "<h2>Review to-dos</h2>" +
    '<p class="muted">Store: ' + escapeHtml(result.store || "") + " · Score: " + escapeHtml(result.score) + " / " + escapeHtml(result.maxScore) + "</p>";
  if (!state.todosLocked) {
    html += '<p><button type="button" id="backToAudit">← Fix answers</button></p>' +
      '<p class="muted">You can go back and correct answers or notes for this same audit. After you create to-dos, answer editing locks so the tasks stay in sync.</p>';
  } else {
    html += '<p class="muted">To-dos already created for this audit. Answer editing is locked.</p>';
  }
  const candidates = result.todoCandidates || [];
  if (!candidates.length) {
    html += '<div class="card">No imperfect answers. Nothing to assign.</div><button type="button" id="doneHome">Back to home</button>';
    box.innerHTML = html;
    const back = document.getElementById("backToAudit");
    if (back) back.addEventListener("click", backToAudit);
    document.getElementById("doneHome").addEventListener("click", () => showView("home"));
    return;
  }
  html += '<p class="muted">Edit each to-do, pick who owns it, then create them. Leaving one unassigned is OK.</p><div id="todoCards"></div>';
  if (!state.todosLocked) html += '<button type="button" id="createTodosBtn">Create to-dos</button>';
  html += '<p id="todoStatus" class="muted"></p>';
  box.innerHTML = html;
  const back = document.getElementById("backToAudit");
  if (back) back.addEventListener("click", backToAudit);
  const create = document.getElementById("createTodosBtn");
  if (create) create.addEventListener("click", createReviewedTodos);
  try {
    const payload = await api("listEligibleAssignees", { auditId: result.auditId });
    await renderTodoCards(candidates, payload.users || [], payload.store);
  } catch (err) {
    setStatus("todoStatus", err.message, true);
    await renderTodoCards(candidates, [], result.store);
  }
}

function backToAudit() {
  if (state.todosLocked) {
    window.alert("To-dos already exist for this audit. Changing answers would leave those tasks out of date. Manage tasks under My to-dos, or start a new audit.");
    return;
  }
  const ids = {};
  ((state.lastResult && state.lastResult.todoCandidates) || []).forEach((c) => { ids[String(c.questionId)] = true; });
  let target = 0;
  for (let i = 0; i < state.sections.length; i += 1) {
    if (state.sections[i].questions.some((q) => ids[String(q.questionId)])) {
      target = i;
      break;
    }
  }
  state.sectionIndex = target;
  state.submitting = false;
  autosave.resume();
  rememberDraft();
  go({ name: "audit", auditId: state.audit.auditId, section: target });
}

async function renderTodoCards(candidates, users, storeCode) {
  const wrap = document.getElementById("todoCards");
  wrap.innerHTML = "";
  if (!users.length) {
    const note = document.createElement("p");
    note.className = "muted";
    note.textContent = "No active people cover store " + (storeCode || "") + ". You can still leave to-dos unassigned.";
    wrap.appendChild(note);
  }
  const keys = [];
  candidates.forEach((c) => String(c.mediaUrls || "").split("|").filter(Boolean).forEach((key) => keys.push(key)));
  let signed = {};
  if (keys.length) {
    try {
      const files = await api("signMediaRead", { keys });
      (files.files || []).forEach((file) => { signed[file.objectKey] = file.url; });
    } catch (err) {
      signed = { error: err.message };
    }
  }
  candidates.forEach((c, i) => {
    const card = document.createElement("div");
    card.className = "card";
    const mediaKeys = String(c.mediaUrls || "").split("|").filter(Boolean);
    let mediaHtml = "";
    if (mediaKeys.length) {
      mediaHtml = '<p class="muted">📎 ' + mediaKeys.length + " file(s)</p>";
      if (signed.error) mediaHtml += '<p class="muted">' + escapeHtml(signed.error) + "</p>";
      mediaKeys.forEach((key) => {
        if (signed[key]) {
          mediaHtml += '<p><a href="' + escapeHtml(signed[key]) + '" target="_blank" rel="noopener noreferrer">Open file</a></p>';
        }
      });
    }
    let options = '<option value="">Leave unassigned</option>';
    users.forEach((user) => {
      options += '<option value="' + escapeHtml(user.email) + '">' + escapeHtml(user.name) + " (" + escapeHtml(user.email) + ")</option>";
    });
    card.innerHTML =
      '<p class="muted">' + escapeHtml(c.questionText) + " · " + escapeHtml(c.pointsEarned) + "/" + escapeHtml(c.maxPoints) + "</p>" +
      mediaHtml +
      '<p><input type="text" id="todo-title-' + i + '" value="' + escapeHtml(c.title || "") + '"></p>' +
      '<p><input type="text" id="todo-details-' + i + '" value="' + escapeHtml(c.details || "") + '" placeholder="Details"></p>' +
      '<p><select id="todo-assign-' + i + '">' + options + "</select></p>" +
      '<p><input type="date" id="todo-due-' + i + '" value="' + defaultDueDate() + '"></p>';
    wrap.appendChild(card);
  });
}

async function createReviewedTodos() {
  const result = state.lastResult;
  if (!result) return;
  const todos = (result.todoCandidates || []).map((c, i) => ({
    questionId: c.questionId,
    title: document.getElementById("todo-title-" + i).value.trim(),
    details: document.getElementById("todo-details-" + i).value.trim(),
    assignedTo: document.getElementById("todo-assign-" + i).value,
    dueDate: document.getElementById("todo-due-" + i).value,
    mediaUrls: c.mediaUrls || "",
  }));
  const button = document.getElementById("createTodosBtn");
  if (button) button.disabled = true;
  setStatus("todoStatus", "Creating…");
  try {
    const payload = await api("createTodosFromReview", { auditId: result.auditId, store: result.store, todos });
    state.todosLocked = true;
    clearDraft(localStorage);
    const back = document.getElementById("backToAudit");
    if (back) back.remove();
    if (button) button.remove();
    let message = "Created " + payload.count + " to-do(s). Answer editing is now locked for this audit.";
    if (payload.emailMessage) message += " " + payload.emailMessage;
    setStatus("todoStatus", message, payload.emailStatus === "failed" || payload.emailStatus === "partial");
    const home = document.createElement("p");
    const go = document.createElement("button");
    go.type = "button";
    go.textContent = "Back to home";
    go.addEventListener("click", () => showView("home"));
    home.appendChild(go);
    document.getElementById("todosBox").appendChild(home);
  } catch (err) {
    setStatus("todoStatus", err.message, true);
    if (button) button.disabled = false;
  }
}

async function loadUsers() {
  const box = document.getElementById("usersList");
  box.textContent = "Loading users…";
  try {
    renderUsers((await api("listUsers")).users || []);
  } catch (err) {
    box.textContent = err.message;
  }
}

function renderUsers(users) {
  const box = document.getElementById("usersList");
  box.innerHTML = "";
  const form = document.createElement("div");
  form.className = "card";
  form.innerHTML =
    "<strong>Add a person</strong>" +
    '<p><input id="newName" type="text" placeholder="Name"></p>' +
    '<p><input id="newEmail" type="email" placeholder="Email"></p>' +
    '<p><input id="newPassword" type="text" placeholder="Temporary password (10+ characters)" autocomplete="off"></p>' +
    '<p><select id="newRole"><option value="admin">admin</option><option value="gm">gm</option><option value="manager" selected>manager</option></select></p>' +
    '<p><select id="newStore">' +
      '<option value="ALL">ALL</option><option value="WPR">WPR (Pizza Ranch Wentzville)</option>' +
      '<option value="CPR">CPR (Pizza Ranch Cottleville)</option><option value="WZ">WZ (Ziggi\'s Wentzville)</option>' +
      '<option value="SPZ">SPZ (Ziggi\'s St. Peters)</option><option value="RANCH">RANCH (all Pizza Ranch)</option>' +
      '<option value="ZIGGIS">ZIGGIS (all Ziggi\'s)</option></select></p>' +
    '<p><label><input id="newMustChange" type="checkbox" checked style="width:auto"> They must choose a new password at first sign-in</label></p>' +
    '<button type="button" id="addUserBtn">Add user</button><p id="userStatus" class="muted"></p>';
  box.appendChild(form);
  document.getElementById("addUserBtn").addEventListener("click", submitNewUser);
  users.forEach((user) => {
    const card = document.createElement("div");
    card.className = "card";
    const flags = [
      user.active ? "active" : "inactive",
      user.hasPassword ? "" : "no password yet",
      user.mustChangePassword ? "must change password" : "",
      user.locked ? "sign-in locked" : "",
    ].filter(Boolean).join(" · ");
    card.innerHTML = "<strong>" + escapeHtml(user.name) + "</strong><p class=\"muted\">" +
      escapeHtml(user.email) + " · " + escapeHtml(user.role) + " · " + escapeHtml(user.store) +
      " · " + escapeHtml(flags) + "</p>";
    const reset = document.createElement("button");
    reset.type = "button";
    reset.textContent = "Reset password";
    reset.addEventListener("click", () => resetPassword(user));
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "secondary";
    toggle.textContent = user.active ? "Deactivate" : "Activate";
    toggle.addEventListener("click", () => setActive(user, !user.active));
    card.append(reset, document.createTextNode(" "), toggle);
    const note = document.createElement("p");
    note.className = "muted";
    note.id = "user-note-" + user.userId;
    card.appendChild(note);
    box.appendChild(card);
  });
}

async function submitNewUser() {
  setStatus("userStatus", "Saving…");
  try {
    await api("addUser", {
      name: document.getElementById("newName").value.trim(),
      email: document.getElementById("newEmail").value.trim(),
      password: document.getElementById("newPassword").value,
      role: document.getElementById("newRole").value,
      store: document.getElementById("newStore").value,
      mustChangePassword: document.getElementById("newMustChange").checked,
    });
    setStatus("userStatus", "Saved.");
    await loadUsers();
  } catch (err) {
    setStatus("userStatus", err.message, true);
  }
}

async function resetPassword(user) {
  if (!window.confirm("Set a new temporary password for " + user.name + "?")) return;
  try {
    const result = await api("resetUserPassword", { userId: user.userId });
    const note = document.getElementById("user-note-" + user.userId);
    if (note) {
      note.textContent = "Temporary password (shown once): " + result.temporaryPassword + ". Tell them in person or by a channel you trust. It is not saved in the sheet.";
    }
  } catch (err) {
    const note = document.getElementById("user-note-" + user.userId);
    if (note) note.textContent = err.message;
  }
}

async function setActive(user, active) {
  try {
    await api("setUserActive", { userId: user.userId, active });
    await loadUsers();
  } catch (err) {
    window.alert(err.message);
  }
}

async function loadMyTodos() {
  const box = document.getElementById("myTodosList");
  box.textContent = "Loading…";
  try {
    const data = await api("listMyTodos");
    const todos = data.todos || [];
    if (!todos.length) {
      box.innerHTML = '<p class="muted">No open to-dos.</p>';
      return;
    }
    box.innerHTML = "";
    todos.forEach((todo) => {
      const card = document.createElement("div");
      card.className = "card";
      const stateLabel = todo.dueState === "past" ? "PAST DUE" : (todo.dueState === "today" ? "DUE TODAY" : "");
      card.innerHTML =
        "<strong>" + escapeHtml(todo.title) + "</strong>" +
        (stateLabel ? ' <span class="muted">(' + stateLabel + ")</span>" : "") +
        '<p class="muted">' + escapeHtml(todo.details || "") + "</p>" +
        '<p class="muted">Store: ' + escapeHtml(todo.store || "") + " · Due: " + escapeHtml(todo.dueDate || "No due date") + "</p>" +
        '<p><input type="date" id="due-' + todo.todoId + '" value="' + escapeHtml(todo.dueDate || "") + '"></p>' +
        '<p id="status-' + todo.todoId + '" class="muted"></p>';
      const dueBtn = document.createElement("button");
      dueBtn.type = "button";
      dueBtn.textContent = "Update due date";
      dueBtn.addEventListener("click", () => saveDueDate(todo.todoId));
      card.append(dueBtn, document.createTextNode(" "));
      card.appendChild(statusMenu(todo, () => loadMyTodos()));
      String(todo.mediaUrls || "").split("|").filter(Boolean).forEach((key) => {
        const open = document.createElement("button");
        open.type = "button";
        open.className = "secondary";
        open.textContent = "View file";
        open.addEventListener("click", async () => {
          try {
            const signed = await api("signMediaRead", { keys: [key] });
            const url = signed.files && signed.files[0] && signed.files[0].url;
            if (url) window.open(url, "_blank", "noopener");
          } catch (err) {
            setStatus("status-" + todo.todoId, err.message, true);
          }
        });
        card.append(document.createTextNode(" "), open);
      });
      box.appendChild(card);
    });
  } catch (err) {
    box.textContent = err.message;
  }
}

async function saveDueDate(todoId) {
  setStatus("status-" + todoId, "Saving…");
  try {
    await api("updateTodoDueDate", { todoId, dueDate: document.getElementById("due-" + todoId).value });
    setStatus("status-" + todoId, "Due date updated.");
    await loadMyTodos();
  } catch (err) {
    setStatus("status-" + todoId, err.message, true);
  }
}

async function completeTodo(todoId) {
  setStatus("status-" + todoId, "Updating…");
  try {
    await api("markTodoDone", { todoId });
    await loadMyTodos();
  } catch (err) {
    setStatus("status-" + todoId, err.message, true);
  }
}

let pastDueReport = null;
let pastDueFilters = null;
let pastDueOpenPanel = "";

function statusMenu(todo, afterChange) {
  const wrap = document.createElement("div");
  wrap.className = "status-control";
  const current = normalizeTodoStatus(todo.status);
  const button = document.createElement("button");
  button.type = "button";
  button.className = "status-pill status-" + current;
  button.textContent = statusLabel(current);
  button.setAttribute("aria-haspopup", "listbox");
  button.setAttribute("aria-expanded", "false");
  const menu = document.createElement("div");
  menu.className = "status-menu";
  menu.hidden = true;
  menu.setAttribute("role", "listbox");
  TODO_STATUSES.forEach((status) => {
    const option = document.createElement("button");
    option.type = "button";
    option.className = "status-option status-" + status.id;
    option.textContent = status.label;
    option.setAttribute("role", "option");
    option.addEventListener("click", async () => {
      menu.hidden = true;
      button.setAttribute("aria-expanded", "false");
      if (status.id === current) return;
      try {
        await api("setTodoStatus", { todoId: todo.todoId, status: status.id });
        if (afterChange) await afterChange();
      } catch (err) {
        const note = document.getElementById("status-" + todo.todoId);
        if (note) {
          note.textContent = err.message;
          note.className = "error";
        } else window.alert(err.message);
      }
    });
    menu.appendChild(option);
  });
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    menu.hidden = !menu.hidden;
    button.setAttribute("aria-expanded", menu.hidden ? "false" : "true");
  });
  wrap.append(button, menu);
  return wrap;
}

function pastDueItems(report) {
  if (report && Array.isArray(report.items)) return report.items;
  const items = [];
  ((report && report.groups) || []).forEach((group) => {
    (group.items || []).forEach((item) => {
      items.push(Object.assign({}, item, {
        status: "todo",
        assignedTo: group.email || "",
        email: group.email || "",
        displayName: group.displayName || "",
        unassigned: !!group.unassigned,
        inactiveUser: !!group.inactiveUser,
        daysFromToday: item.daysOverdue ? -Number(item.daysOverdue) : null,
      }));
    });
  });
  return items;
}

function rememberPastDueFilters() {
  if (!state.user) return;
  savePastDueFilters(localStorage, state.user.email, pastDueFilters);
}

function changePastDueFilters(next) {
  const open = document.querySelector("#pastDueFilters details[open]");
  if (open) pastDueOpenPanel = open.dataset.panel || "";
  pastDueFilters = cloneFilters(next);
  rememberPastDueFilters();
  renderPastDuePage();
}

async function loadPastDue() {
  setStatus("pastDueAuth", "Loading Past due…");
  document.getElementById("pastDueBox").textContent = "";
  const filters = document.getElementById("pastDueFilters");
  if (filters) filters.innerHTML = "";
  try {
    pastDueReport = await api("getPastDueReport");
    pastDueFilters = loadPastDueFilters(localStorage, state.user && state.user.email);
    renderPastDuePage();
  } catch (err) {
    setStatus("pastDueAuth", err.message, true);
  }
}

function renderPastDuePage() {
  const report = pastDueReport || {};
  const today = report.today || "";
  const items = filterPastDueItems(pastDueItems(report), pastDueFilters, today);
  const groups = groupPastDueItems(items);
  renderPastDueFilters(report, items.length);
  setStatus("pastDueAuth", "As of " + (today || "") + " (" + (report.timezone || "America/Chicago") + "). " +
    items.length + " result" + (items.length === 1 ? "" : "s") + ".");
  const box = document.getElementById("pastDueBox");
  if (!groups.length) {
    box.innerHTML = "";
    const empty = document.createElement("div");
    empty.className = "card past-due-empty";
    const title = document.createElement("strong");
    title.textContent = "No results";
    const note = document.createElement("p");
    note.className = "muted";
    note.textContent = "No results – try different filters.";
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "secondary";
    reset.textContent = "Remove all filters";
    reset.addEventListener("click", () => changePastDueFilters(DEFAULT_PAST_DUE_FILTERS));
    empty.append(title, note, reset);
    box.appendChild(empty);
    return;
  }
  box.innerHTML = "";
  groups.forEach((group) => {
    const card = document.createElement("div");
    card.className = "card";
    const heading = document.createElement("strong");
    heading.textContent = group.unassigned ? "Unassigned" : (group.displayName || group.email || "Unassigned");
    card.appendChild(heading);
    if (group.email && !group.unassigned) {
      const email = document.createElement("span");
      email.className = "muted";
      email.textContent = " (" + group.email + ")";
      card.appendChild(email);
    }
    if (group.inactiveUser) {
      const inactive = document.createElement("span");
      inactive.className = "muted";
      inactive.textContent = " · inactive user";
      card.appendChild(inactive);
    }
    const count = document.createElement("p");
    count.className = "muted";
    count.textContent = group.count + " task" + (group.count === 1 ? "" : "s");
    card.appendChild(count);
    (group.items || []).forEach((item) => {
      const row = document.createElement("div");
      row.className = "past-due-item";
      const title = document.createElement("div");
      const name = document.createElement("strong");
      name.textContent = item.title || "To-do";
      title.appendChild(name);
      const meta = document.createElement("p");
      meta.className = "muted";
      const when = item.daysFromToday < 0
        ? (item.daysOverdue + " day" + (item.daysOverdue === 1 ? "" : "s") + " overdue")
        : (item.dueLabel || item.dueDate || "No due date");
      meta.textContent = "Store: " + (item.store || "—") + " · Due: " + (item.dueLabel || item.dueDate || "No due date") + " · " + when;
      row.append(title, meta);
      if (item.details) {
        const details = document.createElement("p");
        details.className = "muted";
        details.textContent = item.details;
        row.appendChild(details);
      }
      row.appendChild(statusMenu(item, loadPastDue));
      card.appendChild(row);
    });
    box.appendChild(card);
  });
}

function renderPastDueFilters(report, resultCount) {
  const host = document.getElementById("pastDueFilters");
  if (!host) return;
  const filters = pastDueFilters || cloneFilters(DEFAULT_PAST_DUE_FILTERS);
  host.innerHTML = "";
  const bar = document.createElement("div");
  bar.className = "card filter-bar";

  const row = document.createElement("div");
  row.className = "filter-controls";
  row.appendChild(peopleFilter(report, filters));
  row.appendChild(dueFilter(filters));
  row.appendChild(statusFilter(filters));
  const hideLabel = document.createElement("label");
  hideLabel.className = "hide-closed";
  const hide = document.createElement("input");
  hide.type = "checkbox";
  hide.checked = filters.hideClosed !== false;
  hide.addEventListener("change", () => {
    changePastDueFilters(Object.assign({}, filters, { hideClosed: hide.checked }));
  });
  hideLabel.append(hide, document.createTextNode(" Hide closed"));
  row.appendChild(hideLabel);
  const count = document.createElement("p");
  count.className = "filter-count";
  count.textContent = resultCount + " result" + (resultCount === 1 ? "" : "s");
  row.appendChild(count);
  bar.appendChild(row);

  const chips = document.createElement("div");
  chips.className = "filter-chips";
  filterChips(filters, (report && report.people) || []).forEach((chip) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "filter-chip";
    button.textContent = chip.label + " ×";
    button.setAttribute("aria-label", "Remove " + chip.label);
    button.addEventListener("click", () => changePastDueFilters(removeFilterChip(filters, chip.id)));
    chips.appendChild(button);
  });
  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "secondary filter-reset";
  reset.textContent = "Remove all filters";
  reset.addEventListener("click", () => changePastDueFilters(DEFAULT_PAST_DUE_FILTERS));
  chips.appendChild(reset);
  bar.appendChild(chips);
  host.appendChild(bar);
  if (pastDueOpenPanel) {
    const reopen = host.querySelector('details[data-panel="' + pastDueOpenPanel + '"]');
    if (reopen) reopen.open = true;
  }
}

function peopleFilter(report, filters) {
  const details = document.createElement("details");
  details.className = "filter-pop";
  details.dataset.panel = "people";
  const summary = document.createElement("summary");
  summary.textContent = filters.people.length ? ("Person (" + filters.people.length + ")") : "Person";
  details.appendChild(summary);
  const box = document.createElement("div");
  box.className = "filter-pop-menu";
  const options = [{ id: "__unassigned__", label: "Unassigned" }].concat(((report && report.people) || []).map((person) => ({
    id: String(person.email || "").toLowerCase(),
    label: person.name || person.email,
  })));
  options.forEach((option) => {
    if (!option.id) return;
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = filters.people.indexOf(option.id) !== -1;
    input.addEventListener("change", () => {
      const people = filters.people.slice();
      const index = people.indexOf(option.id);
      if (input.checked && index === -1) people.push(option.id);
      if (!input.checked && index !== -1) people.splice(index, 1);
      changePastDueFilters(Object.assign({}, filters, { people }));
    });
    label.append(input, document.createTextNode(" " + option.label));
    box.appendChild(label);
  });
  details.appendChild(box);
  return details;
}

function dueFilter(filters) {
  const wrap = document.createElement("div");
  wrap.className = "filter-due";
  const select = document.createElement("select");
  select.setAttribute("aria-label", "Due date");
  DUE_MODES.forEach((mode) => {
    const option = document.createElement("option");
    option.value = mode.id;
    option.textContent = mode.label;
    if (mode.id === filters.due) option.selected = true;
    select.appendChild(option);
  });
  select.addEventListener("change", () => {
    changePastDueFilters(Object.assign({}, filters, { due: select.value }));
  });
  wrap.appendChild(select);
  if (filters.due === "before" || filters.due === "after") {
    const input = document.createElement("input");
    input.type = "date";
    input.value = filters.due === "before" ? (filters.before || "") : (filters.after || "");
    input.setAttribute("aria-label", filters.due === "before" ? "Before date" : "After date");
    input.addEventListener("change", () => {
      const next = Object.assign({}, filters);
      if (filters.due === "before") next.before = input.value;
      else next.after = input.value;
      changePastDueFilters(next);
    });
    wrap.appendChild(input);
  }
  if (filters.due === "range") {
    const from = document.createElement("input");
    from.type = "date";
    from.value = filters.from || "";
    from.setAttribute("aria-label", "From date");
    const to = document.createElement("input");
    to.type = "date";
    to.value = filters.to || "";
    to.setAttribute("aria-label", "To date");
    const apply = () => changePastDueFilters(Object.assign({}, filters, { from: from.value, to: to.value }));
    from.addEventListener("change", apply);
    to.addEventListener("change", apply);
    wrap.append(from, to);
  }
  return wrap;
}

function statusFilter(filters) {
  const details = document.createElement("details");
  details.className = "filter-pop";
  details.dataset.panel = "status";
  const summary = document.createElement("summary");
  summary.textContent = filters.statuses.length ? ("Status (" + filters.statuses.length + ")") : "Status";
  details.appendChild(summary);
  const box = document.createElement("div");
  box.className = "filter-pop-menu";
  TODO_STATUSES.forEach((status) => {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = filters.statuses.indexOf(status.id) !== -1;
    input.addEventListener("change", () => {
      const statuses = filters.statuses.slice();
      const index = statuses.indexOf(status.id);
      if (input.checked && index === -1) statuses.push(status.id);
      if (!input.checked && index !== -1) statuses.splice(index, 1);
      changePastDueFilters(Object.assign({}, filters, { statuses }));
    });
    label.append(input, document.createTextNode(" " + status.label));
    box.appendChild(label);
  });
  details.appendChild(box);
  return details;
}

async function onLogin(event) {
  event.preventDefault();
  setStatus("loginStatus", "Signing in…");
  try {
    acceptSession(await api("login", {
      email: document.getElementById("loginEmail").value.trim(),
      password: document.getElementById("loginPassword").value,
    }));
    document.getElementById("loginPassword").value = "";
  } catch (err) {
    setStatus("loginStatus", err.message, true);
  }
}

async function onBootstrap(event) {
  event.preventDefault();
  setStatus("bootStatus", "Creating…");
  try {
    acceptSession(await api("bootstrapAdmin", {
      name: document.getElementById("bootName").value.trim(),
      email: document.getElementById("bootEmail").value.trim(),
      password: document.getElementById("bootPassword").value,
      passwordConfirm: document.getElementById("bootPassword2").value,
      bootstrapSecret: document.getElementById("bootSecret").value,
      store: "ALL",
    }));
    document.getElementById("bootPassword").value = "";
    document.getElementById("bootPassword2").value = "";
    document.getElementById("bootSecret").value = "";
  } catch (err) {
    setStatus("bootStatus", err.message, true);
  }
}

async function onPassword(event) {
  event.preventDefault();
  setStatus("passwordStatus", "Saving…");
  try {
    const result = await api("changeOwnPassword", {
      currentPassword: document.getElementById("currentPassword").value,
      newPassword: document.getElementById("newPassword").value,
      passwordConfirm: document.getElementById("newPassword2").value,
    });
    state.user = result.user;
    document.getElementById("currentPassword").value = "";
    document.getElementById("newPassword").value = "";
    document.getElementById("newPassword2").value = "";
    let next = "";
    try { next = sessionStorage.getItem(NEXT_KEY) || ""; } catch (err) { next = ""; }
    try { sessionStorage.removeItem(NEXT_KEY); } catch (err) {}
    if (next && next !== "#/login" && next !== "#/password") {
      history.replaceState(null, "", next);
      applyRoute(routeFromHash(next));
    } else {
      showView("home");
    }
  } catch (err) {
    setStatus("passwordStatus", err.message, true);
    if (err.code === "unauthorized" || err.code === "session-expired") showView("login");
  }
}

async function logout() {
  if (shouldSaveAudit(state, auditViewIsActive())) {
    captureAuditDom();
    await autosave.flush();
  }
  autosave.suspend();
  try { await api("logout"); } catch (err) {}
  clearToken();
  clearDraft(localStorage);
  try { sessionStorage.removeItem(NEXT_KEY); } catch (err) {}
  state.user = null;
  state.stores = [];
  state.audit = null;
  state.answers = {};
  state.media = {};
  state.lastResult = null;
  state.todosLocked = false;
  go({ name: "login" }, { replace: true });
}

function openCurrentRoute() {
  const route = routeFromHash(location.hash || "#/home");
  if (!location.hash) {
    history.replaceState(null, "", hashForRoute(route));
  }
  applyRoute(route);
}

async function init() {
  document.body.addEventListener("click", (event) => {
    const nav = event.target.closest("[data-nav]");
    if (nav) {
      event.preventDefault();
      closeSiteNav();
      showView(nav.dataset.nav);
      return;
    }
    if (!event.target.closest(".nav-drop")) {
      const menu = document.getElementById("adminMenu");
      const adminBtn = document.getElementById("adminMenuBtn");
      if (menu) menu.hidden = true;
      if (adminBtn) adminBtn.setAttribute("aria-expanded", "false");
    }
  });
  window.addEventListener("hashchange", () => {
    if (!state.ready) return;
    applyRoute(routeFromHash(location.hash));
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "hidden") return;
    if (!state.audit || !state.user) return;
    captureAuditDom();
    autosave.flush();
  });
  window.addEventListener("pagehide", () => {
    if (!state.audit || !state.user) return;
    captureAuditDom();
    autosave.flushKeepalive();
  });
  autosave.start();
  document.getElementById("loginForm").addEventListener("submit", onLogin);
  document.getElementById("bootstrapForm").addEventListener("submit", onBootstrap);
  document.getElementById("passwordForm").addEventListener("submit", onPassword);
  document.getElementById("logoutBtn").addEventListener("click", () => {
    closeSiteNav();
    if (!state.user) {
      go({ name: "login" });
      return;
    }
    logout();
  });
  document.getElementById("navToggle").addEventListener("click", () => {
    const nav = document.getElementById("siteNav");
    const open = nav.classList.toggle("open");
    document.getElementById("navToggle").setAttribute("aria-expanded", open ? "true" : "false");
  });
  document.getElementById("adminMenuBtn").addEventListener("click", (event) => {
    event.stopPropagation();
    const menu = document.getElementById("adminMenu");
    menu.hidden = !menu.hidden;
    event.currentTarget.setAttribute("aria-expanded", menu.hidden ? "false" : "true");
  });
  document.getElementById("showBootstrap").addEventListener("click", () => {
    document.getElementById("bootstrapForm").hidden = false;
  });
  document.getElementById("auditStore").addEventListener("change", () => {
    go({ name: "templates", store: storeValue() });
  });
  document.getElementById("refreshPastDue").addEventListener("click", loadPastDue);
  bindBuilderControls();
  state.ready = true;
  if (!scriptConfigured()) {
    go({ name: "login" }, { replace: true });
    setStatus("loginStatus", "This copy of the app does not have its Apps Script link yet. Paste the /exec URL into js/config.js, then commit that change so GitHub Pages picks it up.", true);
    return;
  }
  if (!getToken()) {
    const requested = routeFromHash(location.hash || "#/home");
    if (requested.name === "links") {
      go({ name: "links" }, { replace: true });
      return;
    }
    if (requested.name !== "login" && requested.name !== "home") {
      try { sessionStorage.setItem(NEXT_KEY, hashForRoute(requested)); } catch (err) {}
    }
    go({ name: "login" }, { replace: true });
    return;
  }
  try {
    const me = await api("me");
    state.user = me.user;
    state.stores = me.stores || [];
    if (me.user.mustChangePassword) {
      const requested = routeFromHash(location.hash || "#/home");
      if (requested.name !== "password" && requested.name !== "login") {
        try { sessionStorage.setItem(NEXT_KEY, hashForRoute(requested)); } catch (err) {}
      }
      go({ name: "password" }, { replace: true });
      return;
    }
    let next = "";
    try { next = sessionStorage.getItem(NEXT_KEY) || ""; } catch (err) { next = ""; }
    if (next) {
      try { sessionStorage.removeItem(NEXT_KEY); } catch (err) {}
      history.replaceState(null, "", next);
      applyRoute(routeFromHash(next));
      return;
    }
    if (!location.hash || location.hash === "#/login") {
      go({ name: "home" }, { replace: true });
      return;
    }
    openCurrentRoute();
  } catch (err) {
    clearToken();
    go({ name: "login" }, { replace: true });
    setStatus("loginStatus", err.message, true);
  }
}

init();
