import { api, clearToken, getToken, scriptConfigured, setToken } from "./api.js";
import {
  auditQuestionHtml,
  defaultDueDate,
  escapeHtml,
  groupQuestionsBySection,
  mergeSectionAnswers,
  stepSection,
} from "./audit-ui.js";
import { bindBuilderControls, loadBuilderHome, openBuilderTemplate, registerBuilder } from "./builder.js";
import { uploadAuditFile } from "./media.js";
import {
  NEXT_KEY,
  clearDraft,
  draftForUser,
  hashForRoute,
  routeFromHash,
  saveDraft,
} from "./routes.js";

const VIEWS = ["login", "password", "home", "templates", "users", "audit", "todos", "mytodos", "pastdue", "builder", "builder-detail"];

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
}

function go(route, opts) {
  let next = route;
  if (!state.user && next.name !== "login") {
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
  paintHome();
  window.scrollTo(0, 0);
}

function applyRoute(route) {
  if (!state.user && route.name !== "login") {
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
  }
  activate(route.name);
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

function restoreAudit(route) {
  const box = document.getElementById("auditBox");
  if (state.audit && state.audit.auditId === route.auditId) {
    const max = state.sections.length;
    state.sectionIndex = max ? Math.min(route.section || 0, max - 1) : 0;
    renderAuditSection();
    return;
  }
  const draft = draftForUser(localStorage, state.user && state.user.email);
  if (!draft || draft.audit.auditId !== route.auditId) {
    state.audit = null;
    box.innerHTML = '<p><a class="button" href="#/audits">← Audits</a></p>' +
      "<h2>Doing audit</h2>" +
      '<p class="muted">This audit is not on this phone anymore. Start it again from Audits. Answers already sent to the sheet are still there.</p>';
    return;
  }
  adoptDraft(draft);
  const max = state.sections.length;
  state.sectionIndex = max ? Math.min(route.section || 0, max - 1) : 0;
  renderAuditSection();
}

function restoreReview(route) {
  if (state.lastResult && state.lastResult.auditId === route.auditId) {
    showTodoReview(state.lastResult);
    return;
  }
  const draft = draftForUser(localStorage, state.user && state.user.email);
  if (draft && draft.audit.auditId === route.auditId && draft.lastResult) {
    adoptDraft(draft);
    showTodoReview(draft.lastResult);
    return;
  }
  if (draft && draft.audit.auditId === route.auditId) {
    adoptDraft(draft);
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
  const who = document.getElementById("whoami");
  const logout = document.getElementById("logoutBtn");
  if (state.user) {
    who.textContent = state.user.name + " · " + state.user.role;
    logout.hidden = false;
  } else {
    who.textContent = "";
    logout.hidden = true;
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
    box.textContent = (state.stores || []).length
      ? "Select a store to see checklists…"
      : "Your account does not cover a store yet. Ask an admin.";
    return;
  }
  box.textContent = "Loading checklists for " + store + "…";
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
    rememberDraft();
    go({ name: "audit", auditId: payload.auditId, section: 0 });
  } catch (err) {
    box.textContent = err.message || previous;
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
    "</strong><p class=\"muted\">Answer these items, then continue. Point values stay hidden until you submit.</p></div>";
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
  if (state.sectionIndex > 0) {
    const back = document.createElement("button");
    back.type = "button";
    back.textContent = "← Back";
    back.addEventListener("click", () => {
      captureSection();
      rememberDraft();
      const section = stepSection(state.sectionIndex, state.sections.length, -1);
      go({ name: "audit", auditId: state.audit.auditId, section });
    });
    nav.appendChild(back);
  }
  if (state.sectionIndex < total - 1) {
    const next = document.createElement("button");
    next.type = "button";
    next.textContent = "Next section →";
    next.addEventListener("click", () => {
      captureSection();
      rememberDraft();
      const section = stepSection(state.sectionIndex, state.sections.length, 1);
      go({ name: "audit", auditId: state.audit.auditId, section });
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
  help.textContent = "Take or choose a photo or video. Photos are compressed on this device before upload. Videos must be under about 8 MB.";
  const status = document.createElement("p");
  status.className = "muted";
  const list = document.createElement("div");
  const photo = fileInput("image/*", "Take / upload photo");
  const video = fileInput("video/*", "Record / upload video");
  wrap.append(heading, help, photo.label, video.label, status, list);

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
    photo.input.disabled = true;
    video.input.disabled = true;
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
      if (err.code === "media-not-configured") {
        status.textContent = err.message;
      }
    } finally {
      photo.input.disabled = false;
      video.input.disabled = false;
    }
  }

  photo.input.addEventListener("change", () => {
    const file = photo.input.files && photo.input.files[0];
    photo.input.value = "";
    onFile(file);
  });
  video.input.addEventListener("change", () => {
    const file = video.input.files && video.input.files[0];
    video.input.value = "";
    onFile(file);
  });
  renderList();
  card.appendChild(wrap);
}

function fileInput(accept, labelText) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = accept;
  input.setAttribute("capture", "environment");
  input.style.display = "block";
  input.style.margin = "8px 0";
  const label = document.createElement("label");
  label.textContent = labelText;
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
  const questions = state.audit.questions || [];
  const missing = questions.filter((q) => q.requiresMedia && !(state.media[q.questionId] || []).length);
  if (missing.length) {
    setStatus("status", "Required photo/video evidence is missing for: " + missing.map((q) => q.text).join(", "), true);
    return;
  }
  const mediaWithoutAnswer = questions.filter((q) => {
    const files = state.media[q.questionId] || [];
    const answer = (state.answers[q.questionId] || {}).answer;
    return files.length && !answer;
  });
  if (mediaWithoutAnswer.length) {
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
    rememberDraft();
    showView("todos");
  } catch (err) {
    state.submitting = false;
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
      const doneBtn = document.createElement("button");
      doneBtn.type = "button";
      doneBtn.textContent = "Mark done";
      doneBtn.addEventListener("click", () => completeTodo(todo.todoId));
      card.append(dueBtn, document.createTextNode(" "), doneBtn);
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

async function loadPastDue() {
  setStatus("pastDueAuth", "Loading Past due…");
  document.getElementById("pastDueBox").textContent = "";
  try {
    renderPastDue(await api("getPastDueReport"));
  } catch (err) {
    setStatus("pastDueAuth", err.message, true);
  }
}

function renderPastDue(report) {
  setStatus("pastDueAuth", "As of " + (report.today || "") + " (" + (report.timezone || "") + "). " +
    (report.totalItems || 0) + " past-due item(s) across " + (report.totalAssignees || 0) + " assignee(s).");
  const box = document.getElementById("pastDueBox");
  const groups = report.groups || [];
  if (!groups.length) {
    box.innerHTML = '<div class="card">Nothing past due.</div>';
    return;
  }
  box.innerHTML = "";
  groups.forEach((group) => {
    const card = document.createElement("div");
    card.className = "card";
    let title = group.unassigned ? "Unassigned" : escapeHtml(group.displayName || group.email || "Unassigned");
    if (group.email && !group.unassigned) title += ' <span class="muted">(' + escapeHtml(group.email) + ")</span>";
    if (group.inactiveUser) title += ' <span class="muted">· inactive user</span>';
    let html = "<strong>" + title + "</strong><p class=\"muted\">" + group.count + " past-due task" + (group.count === 1 ? "" : "s") + "</p>";
    (group.items || []).forEach((item) => {
      html += '<div style="margin:10px 0;padding-top:8px;border-top:1px solid #eee;">' +
        "<div><strong>" + escapeHtml(item.title) + "</strong></div>" +
        '<p class="muted">Store: ' + escapeHtml(item.store || "—") + " · Due: " + escapeHtml(item.dueLabel || item.dueDate || "") +
        " · " + item.daysOverdue + " day" + (item.daysOverdue === 1 ? "" : "s") + " overdue</p>" +
        (item.details ? '<p class="muted">' + escapeHtml(item.details) + "</p>" : "") +
        "</div>";
    });
    card.innerHTML = html;
    box.appendChild(card);
  });
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
    if (!nav) return;
    event.preventDefault();
    showView(nav.dataset.nav);
  });
  window.addEventListener("hashchange", () => {
    if (!state.ready) return;
    applyRoute(routeFromHash(location.hash));
  });
  window.addEventListener("pagehide", () => {
    if (!state.audit || !state.user) return;
    captureSection();
    rememberDraft();
  });
  document.getElementById("loginForm").addEventListener("submit", onLogin);
  document.getElementById("bootstrapForm").addEventListener("submit", onBootstrap);
  document.getElementById("passwordForm").addEventListener("submit", onPassword);
  document.getElementById("logoutBtn").addEventListener("click", logout);
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
