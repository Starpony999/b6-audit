// Screen addresses are hashes (#/past-due). GitHub Pages is a static host:
// it has no server routes, and a path like /b6-audit/past-due would 404.
// The hash stays in the browser, so refresh, Back, Forward, and bookmarks work
// with the one index.html file.

export const DRAFT_KEY = "b6audit.draft";
export const NEXT_KEY = "b6audit.next";

const ADMIN_SCREENS = { users: true, builder: true, "builder-detail": true, pastdue: true };

export function isAdminScreen(name) {
  return !!ADMIN_SCREENS[name];
}

export function routeFromHash(hash) {
  const raw = String(hash || "").replace(/^#/, "");
  const path = raw.replace(/^\//, "").replace(/\/+$/, "");
  const parts = path.split("/").filter(Boolean).map((part) => {
    try { return decodeURIComponent(part); } catch (err) { return part; }
  });
  const head = (parts[0] || "home").toLowerCase();
  if (head === "home") return { name: "home" };
  if (head === "login") return { name: "login" };
  if (head === "password") return { name: "password" };
  if (head === "audits") return { name: "templates", store: String(parts[1] || "").toUpperCase() };
  if (head === "audit" && parts[1]) {
    if ((parts[2] || "").toLowerCase() === "review") return { name: "todos", auditId: parts[1] };
    const section = Number(parts[3]);
    return {
      name: "audit",
      auditId: parts[1],
      section: Number.isFinite(section) && section >= 0 ? Math.floor(section) : 0,
    };
  }
  if (head === "my-todos") return { name: "mytodos" };
  if (head === "builder" && parts[1]) return { name: "builder-detail", templateId: parts[1] };
  if (head === "builder") return { name: "builder" };
  if (head === "users") return { name: "users" };
  if (head === "past-due") return { name: "pastdue" };
  return { name: "home" };
}

export function hashForRoute(route) {
  const name = route && route.name;
  if (name === "login") return "#/login";
  if (name === "password") return "#/password";
  if (name === "templates") {
    const store = String(route.store || "").toUpperCase();
    return /^[A-Z0-9]+$/.test(store) ? "#/audits/" + store : "#/audits";
  }
  if (name === "audit") {
    return "#/audit/" + encodeURIComponent(route.auditId || "missing") + "/section/" + (Number(route.section) || 0);
  }
  if (name === "todos") {
    return "#/audit/" + encodeURIComponent(route.auditId || "missing") + "/review";
  }
  if (name === "mytodos") return "#/my-todos";
  if (name === "builder-detail") return "#/builder/" + encodeURIComponent(route.templateId || "missing");
  if (name === "builder") return "#/builder";
  if (name === "users") return "#/users";
  if (name === "pastdue") return "#/past-due";
  return "#/home";
}

export function draftFromState(state, ownerEmail) {
  const media = {};
  Object.keys(state.media || {}).forEach((id) => {
    media[id] = (state.media[id] || []).map((file) => ({
      objectKey: file.objectKey || "",
      fileName: file.fileName || "",
      mimeType: file.mimeType || "",
    })).filter((file) => file.objectKey);
  });
  return {
    ownerEmail: String(ownerEmail || ""),
    audit: state.audit ? {
      auditId: state.audit.auditId,
      store: state.audit.store || "",
      storeLabel: state.audit.storeLabel || "",
      templateName: state.audit.templateName || "",
      questions: state.audit.questions || [],
    } : null,
    sectionIndex: Number(state.sectionIndex) || 0,
    answers: state.answers || {},
    media,
    lastResult: state.lastResult || null,
    todosLocked: !!state.todosLocked,
  };
}

export function saveDraft(storage, state, ownerEmail) {
  if (!storage || !state || !state.audit || !state.audit.auditId) return;
  storage.setItem(DRAFT_KEY, JSON.stringify(draftFromState(state, ownerEmail)));
}

export function loadDraft(storage) {
  if (!storage) return null;
  try {
    const raw = storage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || !data.audit || !data.audit.auditId) return null;
    return data;
  } catch (err) {
    return null;
  }
}

export function clearDraft(storage) {
  if (!storage) return;
  try { storage.removeItem(DRAFT_KEY); } catch (err) {}
}

export function draftForUser(storage, email) {
  const draft = loadDraft(storage);
  if (!draft) return null;
  if (String(draft.ownerEmail || "").toLowerCase() !== String(email || "").toLowerCase()) return null;
  return draft;
}
