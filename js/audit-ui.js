export function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function choiceLabel(part) {
  const chunk = String(part || "").trim();
  const idx = chunk.lastIndexOf(":");
  if (idx <= 0) return chunk;
  const tail = chunk.substring(idx + 1).trim();
  if (tail !== "" && Number.isFinite(Number(tail))) return chunk.substring(0, idx).trim();
  return chunk;
}

export function groupQuestionsBySection(questions) {
  const order = [];
  const map = {};
  (questions || []).forEach((q) => {
    const name = String(q.section || "").trim() || "General";
    if (!map[name]) {
      map[name] = [];
      order.push(name);
    }
    map[name].push(q);
  });
  return order.map((name) => ({ name, questions: map[name] }));
}

export function defaultDueDate(now = new Date()) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 30);
  const m = d.getMonth() + 1;
  const day = d.getDate();
  return d.getFullYear() + "-" + (m < 10 ? "0" : "") + m + "-" + (day < 10 ? "0" : "") + day;
}

export function appliesValue(mode, picked) {
  if (mode !== "SELECTED") return mode;
  const list = (picked || []).filter(Boolean);
  if (!list.length) throw new Error("Select at least one store, or choose All / Ranch / Ziggi's.");
  return list.join(",");
}

export function stepSection(index, length, dir) {
  if (!length) return 0;
  const next = index + dir;
  if (next < 0 || next >= length) return index;
  return next;
}

export function mergeSectionAnswers(questions, previous, read) {
  const next = Object.assign({}, previous || {});
  (questions || []).forEach((q) => {
    const prev = next[q.questionId] || { answer: "", note: "" };
    const got = read(q.questionId) || {};
    next[q.questionId] = {
      answer: got.answer != null && got.answer !== "" ? got.answer : (prev.answer || ""),
      note: got.note != null ? got.note : (prev.note || ""),
    };
  });
  return next;
}

export function auditQuestionHtml(q, saved) {
  const answer = (saved && saved.answer) || "";
  const name = escapeHtml(q.questionId);
  let controls = "";
  if (q.type === "yesno") {
    controls =
      '<label class="choice"><input type="radio" name="' + name + '" value="yes"' + (answer === "yes" ? " checked" : "") + "> Yes</label> " +
      '<label class="choice"><input type="radio" name="' + name + '" value="no"' + (answer === "no" ? " checked" : "") + "> No</label>";
  } else if (q.type === "multiple") {
    String(q.options || "").split("|").forEach((part) => {
      const label = choiceLabel(part);
      if (!label) return;
      controls +=
        '<div><label class="choice"><input type="radio" name="' + name + '" value="' + escapeHtml(label) + '"' +
        (answer === label ? " checked" : "") + "> " + escapeHtml(label) + "</label></div>";
    });
  }
  return "<div><strong>" + escapeHtml(q.order) + ". " + escapeHtml(q.text) + "</strong></div>" + controls;
}
