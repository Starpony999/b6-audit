export const TODO_STATUSES = [
  { id: "todo", label: "To do", closed: false },
  { id: "in_progress", label: "In progress", closed: false },
  { id: "complete", label: "Complete", closed: true },
  { id: "cant_do", label: "Can't do", closed: true },
];

export const DUE_MODES = [
  { id: "today", label: "Due today" },
  { id: "next7", label: "Due next 7 days" },
  { id: "past", label: "Past due" },
  { id: "before", label: "Before" },
  { id: "after", label: "After" },
  { id: "range", label: "Custom range" },
  { id: "all", label: "Any due date" },
];

export const DEFAULT_PAST_DUE_FILTERS = {
  people: [],
  due: "past",
  before: "",
  after: "",
  from: "",
  to: "",
  statuses: ["todo", "in_progress"],
  hideClosed: true,
};

export function normalizeTodoStatus(raw) {
  const s = String(raw == null ? "" : raw).toLowerCase().replace(/[’']/g, "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!s || s === "open" || s === "todo" || s === "to do") return "todo";
  if (s === "in progress" || s === "inprogress") return "in_progress";
  if (s === "done" || s === "complete" || s === "completed") return "complete";
  if (s === "cant do" || s === "cantdo" || s === "cannot do" || s === "cannot") return "cant_do";
  return "todo";
}

export function isClosedStatus(raw) {
  const id = normalizeTodoStatus(raw);
  const found = TODO_STATUSES.find((status) => status.id === id);
  return !!(found && found.closed);
}

export function statusLabel(raw) {
  const id = normalizeTodoStatus(raw);
  const found = TODO_STATUSES.find((status) => status.id === id);
  return found ? found.label : "To do";
}

export function filterStorageKey(email) {
  return "b6audit.pastDueFilters." + String(email || "").toLowerCase();
}

function pad(n) {
  return (n < 10 ? "0" : "") + n;
}

export function parseDayKey(key) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ""));
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (!y || m < 1 || m > 12 || d < 1 || d > 31) return null;
  return { y, m, d, key: match[1] + "-" + match[2] + "-" + match[3] };
}

export function addDays(key, days) {
  const parts = parseDayKey(key);
  if (!parts) return "";
  const date = new Date(Date.UTC(parts.y, parts.m - 1, parts.d));
  date.setUTCDate(date.getUTCDate() + days);
  return date.getUTCFullYear() + "-" + pad(date.getUTCMonth() + 1) + "-" + pad(date.getUTCDate());
}

export function daysBetween(fromKey, toKey) {
  const from = parseDayKey(fromKey);
  const to = parseDayKey(toKey);
  if (!from || !to) return null;
  const a = Date.UTC(from.y, from.m - 1, from.d);
  const b = Date.UTC(to.y, to.m - 1, to.d);
  return Math.round((b - a) / 86400000);
}

export function cloneFilters(filters) {
  const source = filters || DEFAULT_PAST_DUE_FILTERS;
  return {
    people: (source.people || []).map(String),
    due: source.due || "past",
    before: source.before || "",
    after: source.after || "",
    from: source.from || "",
    to: source.to || "",
    statuses: (source.statuses || []).map(String),
    hideClosed: source.hideClosed !== false,
  };
}

export function sanitizeFilters(raw) {
  const next = cloneFilters(DEFAULT_PAST_DUE_FILTERS);
  if (!raw || typeof raw !== "object") return next;
  const dueIds = DUE_MODES.map((mode) => mode.id);
  if (dueIds.indexOf(raw.due) !== -1) next.due = raw.due;
  next.before = parseDayKey(raw.before) ? raw.before : "";
  next.after = parseDayKey(raw.after) ? raw.after : "";
  next.from = parseDayKey(raw.from) ? raw.from : "";
  next.to = parseDayKey(raw.to) ? raw.to : "";
  next.people = Array.isArray(raw.people) ? raw.people.map((id) => String(id || "").toLowerCase()).filter(Boolean) : [];
  const known = {};
  TODO_STATUSES.forEach((status) => { known[status.id] = true; });
  next.statuses = Array.isArray(raw.statuses)
    ? raw.statuses.map((id) => normalizeTodoStatus(id)).filter((id) => known[id])
    : next.statuses;
  next.hideClosed = raw.hideClosed !== false;
  return next;
}

export function loadPastDueFilters(storage, email) {
  if (!storage) return cloneFilters(DEFAULT_PAST_DUE_FILTERS);
  try {
    const raw = storage.getItem(filterStorageKey(email));
    if (!raw) return cloneFilters(DEFAULT_PAST_DUE_FILTERS);
    return sanitizeFilters(JSON.parse(raw));
  } catch (err) {
    return cloneFilters(DEFAULT_PAST_DUE_FILTERS);
  }
}

export function savePastDueFilters(storage, email, filters) {
  if (!storage) return;
  storage.setItem(filterStorageKey(email), JSON.stringify(sanitizeFilters(filters)));
}

function personKey(item) {
  if (!item || item.unassigned || !String(item.assignedTo || item.email || "").trim()) return "__unassigned__";
  return String(item.email || item.assignedTo).toLowerCase();
}

function matchesDue(item, filters, todayKey) {
  const due = item && item.dueDate;
  const delta = daysBetween(todayKey, due);
  if (filters.due === "all") return true;
  if (delta === null) return false;
  if (filters.due === "past") return delta < 0;
  if (filters.due === "today") return delta === 0;
  if (filters.due === "next7") return delta >= 0 && delta <= 7;
  if (filters.due === "before") return !!(filters.before && due < filters.before);
  if (filters.due === "after") return !!(filters.after && due > filters.after);
  if (filters.due === "range") {
    if (!filters.from || !filters.to) return false;
    return due >= filters.from && due <= filters.to;
  }
  return false;
}

export function filterPastDueItems(items, filters, todayKey) {
  const active = sanitizeFilters(filters);
  return (items || []).filter((item) => {
    const status = normalizeTodoStatus(item && item.status);
    if (active.hideClosed && isClosedStatus(status)) return false;
    if (active.statuses.length && active.statuses.indexOf(status) === -1) return false;
    if (active.people.length && active.people.indexOf(personKey(item)) === -1) return false;
    return matchesDue(item, active, todayKey);
  });
}

export function groupPastDueItems(items) {
  const map = {};
  (items || []).forEach((item) => {
    const key = personKey(item);
    if (!map[key]) {
      map[key] = {
        key,
        email: item.unassigned ? "" : (item.email || item.assignedTo || ""),
        displayName: item.displayName || (item.unassigned ? "Unassigned" : (item.email || "Unassigned")),
        inactiveUser: !!item.inactiveUser,
        unassigned: key === "__unassigned__",
        items: [],
      };
    }
    map[key].items.push(item);
  });
  const groups = Object.keys(map).map((key) => {
    const group = map[key];
    group.items.sort((a, b) => {
      const overdue = (b.daysOverdue || 0) - (a.daysOverdue || 0);
      if (overdue) return overdue;
      return String(a.title || "").localeCompare(String(b.title || ""));
    });
    group.count = group.items.length;
    return group;
  });
  groups.sort((a, b) => {
    if (a.unassigned !== b.unassigned) return a.unassigned ? 1 : -1;
    if (b.count !== a.count) return b.count - a.count;
    return String(a.displayName).localeCompare(String(b.displayName));
  });
  return groups;
}

export function dueChipLabel(filters) {
  const mode = DUE_MODES.find((item) => item.id === filters.due);
  if (!mode || filters.due === "all") return "";
  if (filters.due === "before" && filters.before) return "Due date: Before " + filters.before;
  if (filters.due === "after" && filters.after) return "Due date: After " + filters.after;
  if (filters.due === "range" && filters.from && filters.to) return "Due date: " + filters.from + " – " + filters.to;
  return "Due date: " + mode.label;
}

export function filterChips(filters, people) {
  const active = sanitizeFilters(filters);
  const chips = [];
  const names = {};
  (people || []).forEach((person) => { names[String(person.email || "").toLowerCase()] = person.name || person.email; });
  active.people.forEach((id) => {
    chips.push({
      id: "person:" + id,
      label: id === "__unassigned__" ? "Assignee: Unassigned" : ("Assignee: " + (names[id] || id)),
    });
  });
  const due = dueChipLabel(active);
  if (due) chips.push({ id: "due", label: due });
  active.statuses.forEach((id) => {
    chips.push({ id: "status:" + id, label: "Status: " + statusLabel(id) });
  });
  if (active.hideClosed) chips.push({ id: "hideClosed", label: "Hide closed" });
  return chips;
}

export function removeFilterChip(filters, chipId) {
  const next = sanitizeFilters(filters);
  if (chipId === "due") next.due = "all";
  else if (chipId === "hideClosed") next.hideClosed = false;
  else if (String(chipId).indexOf("person:") === 0) {
    const id = chipId.slice(7);
    next.people = next.people.filter((person) => person !== id);
  } else if (String(chipId).indexOf("status:") === 0) {
    const id = chipId.slice(7);
    next.statuses = next.statuses.filter((status) => status !== id);
  }
  return next;
}
