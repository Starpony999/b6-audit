import { api } from "./api.js";
import { appliesValue, escapeHtml } from "./audit-ui.js";

let deps = null;

export function registerBuilder(next) {
  deps = next;
}

function status(id, message, isError) {
  deps.setStatus(id, message, isError);
}

function checkedStores(className) {
  return Array.from(document.querySelectorAll("." + className + ":checked")).map((el) => el.value);
}

function wireApplies(selectId, pickId) {
  const mode = document.getElementById(selectId);
  const pick = document.getElementById(pickId);
  if (!mode || mode.dataset.wired) return;
  mode.dataset.wired = "1";
  mode.addEventListener("change", () => {
    pick.hidden = mode.value !== "SELECTED";
  });
}

function setApplies(selectId, className, pickId, appliesTo) {
  const value = String(appliesTo || "ALL").toUpperCase();
  const mode = document.getElementById(selectId);
  const pick = document.getElementById(pickId);
  document.querySelectorAll("." + className).forEach((el) => { el.checked = false; });
  if (value === "ALL" || value === "RANCH" || value === "ZIGGIS") {
    mode.value = value;
    pick.hidden = true;
  } else {
    mode.value = "SELECTED";
    pick.hidden = false;
    value.split(",").forEach((code) => {
      document.querySelectorAll("." + className).forEach((el) => {
        if (el.value === code.trim()) el.checked = true;
      });
    });
  }
}

function toggleNewQuestionFields() {
  const type = document.getElementById("newQType").value;
  document.getElementById("newQYesNoFields").hidden = type !== "yesno";
  document.getElementById("newQMultipleFields").hidden = type !== "multiple";
}

function collectQuestion(questionId) {
  return {
    questionId,
    section: document.getElementById("edit-section-" + questionId).value.trim(),
    text: document.getElementById("edit-text-" + questionId).value.trim(),
    points: document.getElementById("edit-points-" + questionId).value.trim(),
    type: document.getElementById("edit-type-" + questionId).value,
    options: document.getElementById("edit-options-" + questionId).value.trim(),
    todoIfImperfect: document.getElementById("edit-todo-" + questionId).value.trim(),
    fullPointsAnswer: document.getElementById("edit-full-" + questionId).value,
  };
}

function newQuestionDirty() {
  const section = document.getElementById("newQSection").value || "";
  const text = document.getElementById("newQText").value || "";
  const options = document.getElementById("newQOptions").value || "";
  const todo = document.getElementById("newQTodo").value || "";
  const points = document.getElementById("newQPoints").value || "5";
  return !!(section.trim() || text.trim() || options.trim() || todo.trim() || (points.trim() && points.trim() !== "5"));
}

export async function loadBuilderHome() {
  const auth = document.getElementById("builderAuth");
  const createBox = document.getElementById("builderCreate");
  const list = document.getElementById("builderList");
  auth.textContent = "Checking access…";
  createBox.hidden = true;
  document.getElementById("builderSchema").hidden = true;
  list.textContent = "Loading…";
  try {
    const payload = await api("getBuilderHome");
    auth.textContent = "Signed in as admin: " + (payload.access.email || "");
    createBox.hidden = false;
    document.getElementById("builderSchema").hidden = false;
    renderTemplates(payload.templates || []);
  } catch (err) {
    auth.textContent = err.message || "Only an admin can use the template builder.";
    list.textContent = "";
  }
}

function renderTemplates(templates) {
  const list = document.getElementById("builderList");
  wireApplies("newTemplateApplies", "newTemplateStorePick");
  if (!templates.length) {
    list.innerHTML = '<p class="muted">No checklists yet. Create one above.</p>';
    return;
  }
  list.innerHTML = "";
  templates.forEach((template) => {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML =
      "<strong>" + escapeHtml(template.name) + "</strong>" +
      '<p class="muted">' + escapeHtml(template.description || "") + "</p>" +
      '<p class="muted">Applies to: ' + escapeHtml(template.appliesTo || "ALL") + "</p>";
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Edit checklist";
    button.addEventListener("click", () => openBuilderTemplate(template.templateId));
    card.appendChild(button);
    list.appendChild(card);
  });
}

export async function runSchemaSetup() {
  status("builderSchemaStatus", "Updating sheet headers…");
  try {
    const result = await api("ensureSchema");
    status("builderSchemaStatus", (result && result.message) || "Done.");
  } catch (err) {
    status("builderSchemaStatus", err.message, true);
  }
}

export async function submitNewTemplate() {
  let appliesTo = "";
  try {
    appliesTo = appliesValue(
      document.getElementById("newTemplateApplies").value,
      checkedStores("newAppliesStore")
    );
  } catch (err) {
    status("builderCreateStatus", err.message, true);
    return;
  }
  status("builderCreateStatus", "Saving…");
  try {
    await api("createTemplate", {
      name: document.getElementById("newTemplateName").value.trim(),
      description: document.getElementById("newTemplateDescription").value.trim(),
      appliesTo,
    });
    status("builderCreateStatus", "Created.");
    document.getElementById("newTemplateName").value = "";
    document.getElementById("newTemplateDescription").value = "";
    await loadBuilderHome();
  } catch (err) {
    status("builderCreateStatus", err.message, true);
  }
}

export async function openBuilderTemplate(templateId) {
  deps.state.builderTemplateId = templateId;
  deps.showView("builder-detail");
  document.getElementById("builderDetailTitle").textContent = "Edit template";
  document.getElementById("builderQuestions").textContent = "Loading…";
  status("builderRenameStatus", "");
  status("builderAddQStatus", "");
  wireApplies("editTemplateApplies", "editTemplateStorePick");
  toggleNewQuestionFields();
  try {
    renderDetail(await api("listBuilderQuestions", { templateId }));
  } catch (err) {
    document.getElementById("builderQuestions").textContent = err.message;
  }
}

function renderDetail(payload) {
  const template = payload.template || {};
  const questions = payload.questions || [];
  deps.state.builderTemplateId = template.templateId;
  deps.state.builderQuestionIds = questions.map((q) => String(q.questionId));
  document.getElementById("builderDetailTitle").textContent = "Edit: " + (template.name || "template");
  document.getElementById("renameTemplateName").value = template.name || "";
  setApplies("editTemplateApplies", "editAppliesStore", "editTemplateStorePick", template.appliesTo || "ALL");
  if (!deps.state.saveAllBusy) status("builderSaveAllStatus", "");
  const box = document.getElementById("builderQuestions");
  if (!questions.length) {
    deps.state.builderQuestionIds = [];
    box.innerHTML = '<p class="muted">No questions yet. Add one above.</p>';
    return;
  }
  box.innerHTML = "";
  questions.forEach((q) => {
    const card = document.createElement("div");
    card.className = "card";
    const qid = String(q.questionId);
    const isMultiple = q.type === "multiple";
    card.innerHTML =
      '<p class="muted">#' + escapeHtml(q.order) + " · id kept on save</p>" +
      '<p><input type="text" id="edit-section-' + qid + '" value="' + escapeHtml(q.section) + '" placeholder="Section"></p>' +
      '<p><input type="text" id="edit-text-' + qid + '" value="' + escapeHtml(q.text) + '" placeholder="Question text"></p>' +
      '<p><input type="text" id="edit-points-' + qid + '" value="' + escapeHtml(q.points) + '" placeholder="Points"></p>' +
      '<p><label>Type <select id="edit-type-' + qid + '">' +
        '<option value="yesno"' + (!isMultiple ? " selected" : "") + ">Yes / No</option>" +
        '<option value="multiple"' + (isMultiple ? " selected" : "") + ">Multiple choice</option></select></label></p>" +
      '<div id="edit-yesno-' + qid + '"' + (isMultiple ? " hidden" : "") + ">" +
        '<p><label>Full points when the answer is <select id="edit-full-' + qid + '">' +
        '<option value="yes"' + ((q.fullPointsAnswer || "yes") === "yes" ? " selected" : "") + ">Yes</option>" +
        '<option value="no"' + (q.fullPointsAnswer === "no" ? " selected" : "") + ">No</option></select></label></p></div>" +
      '<div id="edit-multiple-' + qid + '"' + (isMultiple ? "" : " hidden") + ">" +
        '<p><input type="text" id="edit-options-' + qid + '" value="' + escapeHtml(q.options || "") + '" placeholder="Good:5|Fair:3|Poor:0"></p></div>' +
      '<p><input type="text" id="edit-todo-' + qid + '" value="' + escapeHtml(q.todoIfImperfect || "") + '" placeholder="To-do title if imperfect (or OFF)"></p>' +
      '<p class="muted">To-do on an imperfect answer: ' + (q.todoEnabled === false ? "OFF" : "ON") + "</p>" +
      '<p id="edit-status-' + qid + '" class="muted"></p>';
    const typeSelect = card.querySelector("#edit-type-" + CSS.escape(qid));
    typeSelect.addEventListener("change", () => {
      document.getElementById("edit-yesno-" + qid).hidden = typeSelect.value !== "yesno";
      document.getElementById("edit-multiple-" + qid).hidden = typeSelect.value !== "multiple";
    });
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Save question";
    button.addEventListener("click", () => saveQuestion(qid));
    card.appendChild(button);
    box.appendChild(card);
  });
}

function restoreEdits(pending) {
  Object.keys(pending).forEach((qid) => {
    const edit = pending[qid];
    const set = (id, value) => {
      const el = document.getElementById(id);
      if (el) el.value = value;
    };
    set("edit-section-" + qid, edit.section);
    set("edit-text-" + qid, edit.text);
    set("edit-points-" + qid, edit.points);
    set("edit-type-" + qid, edit.type);
    set("edit-options-" + qid, edit.options);
    set("edit-todo-" + qid, edit.todoIfImperfect);
    set("edit-full-" + qid, edit.fullPointsAnswer);
    const typeEl = document.getElementById("edit-type-" + qid);
    if (typeEl) {
      document.getElementById("edit-yesno-" + qid).hidden = typeEl.value !== "yesno";
      document.getElementById("edit-multiple-" + qid).hidden = typeEl.value !== "multiple";
    }
    const note = document.getElementById("edit-status-" + qid);
    if (note) note.textContent = "Unsaved edits restored after add — use Save question or Save all.";
  });
}

export async function submitNewQuestion() {
  if (!deps.state.builderTemplateId) return;
  const optionsEl = document.getElementById("newQOptions");
  const pending = {};
  deps.state.builderQuestionIds.forEach((qid) => {
    try { pending[qid] = collectQuestion(qid); } catch (err) {}
  });
  status("builderAddQStatus", "Saving…");
  try {
    await api("addBuilderQuestion", {
      templateId: deps.state.builderTemplateId,
      section: document.getElementById("newQSection").value.trim(),
      text: document.getElementById("newQText").value.trim(),
      points: document.getElementById("newQPoints").value.trim(),
      type: document.getElementById("newQType").value,
      options: optionsEl ? optionsEl.value.trim() : "",
      todoIfImperfect: document.getElementById("newQTodo").value.trim(),
      fullPointsAnswer: document.getElementById("newQFull").value,
    });
    status("builderAddQStatus", "Question added.");
    document.getElementById("newQSection").value = "";
    document.getElementById("newQText").value = "";
    document.getElementById("newQPoints").value = "5";
    if (optionsEl) optionsEl.value = "";
    document.getElementById("newQTodo").value = "";
    document.getElementById("newQType").value = "yesno";
    document.getElementById("newQFull").value = "yes";
    toggleNewQuestionFields();
    const payload = await api("listBuilderQuestions", { templateId: deps.state.builderTemplateId });
    renderDetail(payload);
    restoreEdits(pending);
  } catch (err) {
    status("builderAddQStatus", err.message, true);
  }
}

async function saveQuestion(questionId) {
  const question = collectQuestion(questionId);
  const note = document.getElementById("edit-status-" + questionId);
  if (note) note.textContent = "Saving…";
  try {
    await api("updateBuilderQuestion", question);
    if (note) note.textContent = "Saved (same question id). Other unsaved rows were left alone.";
  } catch (err) {
    if (note) note.textContent = err.message;
  }
}

export async function submitTemplateMeta() {
  if (!deps.state.builderTemplateId) return;
  let appliesTo = "";
  try {
    appliesTo = appliesValue(document.getElementById("editTemplateApplies").value, checkedStores("editAppliesStore"));
  } catch (err) {
    status("builderRenameStatus", err.message, true);
    return;
  }
  status("builderRenameStatus", "Saving…");
  try {
    const result = await api("updateTemplateMeta", {
      templateId: deps.state.builderTemplateId,
      name: document.getElementById("renameTemplateName").value.trim(),
      appliesTo,
    });
    status("builderRenameStatus", "Checklist settings saved. Applies to: " + (result.template.appliesTo || "ALL"));
    document.getElementById("builderDetailTitle").textContent = "Edit: " + (result.template.name || "");
  } catch (err) {
    status("builderRenameStatus", err.message, true);
  }
}

export async function saveAllBuilderTemplate() {
  if (!deps.state.builderTemplateId || deps.state.saveAllBusy) return;
  let appliesTo = "";
  try {
    appliesTo = appliesValue(document.getElementById("editTemplateApplies").value, checkedStores("editAppliesStore"));
  } catch (err) {
    status("builderSaveAllStatus", err.message, true);
    return;
  }
  const questions = [];
  try {
    deps.state.builderQuestionIds.forEach((qid) => questions.push(collectQuestion(qid)));
  } catch (err) {
    status("builderSaveAllStatus", err.message, true);
    return;
  }
  deps.state.saveAllBusy = true;
  let message = "Checking and saving all…";
  if (newQuestionDirty()) message = "Add-question draft stays separate (use Add question). " + message;
  status("builderSaveAllStatus", message);
  status("builderRenameStatus", "");
  const draft = {
    section: document.getElementById("newQSection").value,
    text: document.getElementById("newQText").value,
    points: document.getElementById("newQPoints").value,
    type: document.getElementById("newQType").value,
    options: document.getElementById("newQOptions").value,
    todo: document.getElementById("newQTodo").value,
    full: document.getElementById("newQFull").value,
  };
  try {
    const result = await api("saveAllBuilderTemplate", {
      templateId: deps.state.builderTemplateId,
      meta: { name: document.getElementById("renameTemplateName").value.trim(), appliesTo },
      questions,
    });
    deps.state.saveAllBusy = false;
    renderDetail(result);
    document.getElementById("newQSection").value = draft.section;
    document.getElementById("newQText").value = draft.text;
    document.getElementById("newQPoints").value = draft.points;
    document.getElementById("newQType").value = draft.type;
    document.getElementById("newQOptions").value = draft.options;
    document.getElementById("newQTodo").value = draft.todo;
    document.getElementById("newQFull").value = draft.full;
    toggleNewQuestionFields();
    if (newQuestionDirty()) {
      status("builderAddQStatus", "Draft in Add question was kept. Click Add question when you are ready.");
    }
    status("builderSaveAllStatus", "Saved all: checklist settings + " + (result.updatedCount != null ? result.updatedCount : questions.length) + " question(s). IDs unchanged.");
  } catch (err) {
    deps.state.saveAllBusy = false;
    status("builderSaveAllStatus", err.message, true);
  }
}

export function bindBuilderControls() {
  document.getElementById("newQType").addEventListener("change", toggleNewQuestionFields);
  document.getElementById("runSchema").addEventListener("click", runSchemaSetup);
  document.getElementById("submitNewTemplate").addEventListener("click", submitNewTemplate);
  document.getElementById("submitTemplateMeta").addEventListener("click", submitTemplateMeta);
  document.getElementById("saveAllBuilder").addEventListener("click", saveAllBuilderTemplate);
  document.getElementById("submitNewQuestion").addEventListener("click", submitNewQuestion);
}
