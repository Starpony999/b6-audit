import test from "node:test";
import assert from "node:assert/strict";
import {
  clearDraft,
  draftForUser,
  hashForRoute,
  isAdminScreen,
  loadDraft,
  routeFromHash,
  saveDraft,
} from "../js/routes.js";

const screens = [
  [{ name: "home" }, "#/home"],
  [{ name: "login" }, "#/login"],
  [{ name: "password" }, "#/password"],
  [{ name: "templates" }, "#/audits"],
  [{ name: "templates", store: "cpr" }, "#/audits/CPR"],
  [{ name: "audit", auditId: "audit-1", section: 2 }, "#/audit/audit-1/section/2"],
  [{ name: "todos", auditId: "audit-1" }, "#/audit/audit-1/review"],
  [{ name: "mytodos" }, "#/my-todos"],
  [{ name: "builder" }, "#/builder"],
  [{ name: "builder-detail", templateId: "tpl-9" }, "#/builder/tpl-9"],
  [{ name: "users" }, "#/users"],
  [{ name: "pastdue" }, "#/past-due"],
];

test("every screen has a stable hash and parses back", () => {
  screens.forEach(([route, hash]) => {
    assert.equal(hashForRoute(route), hash);
    const parsed = routeFromHash(hash);
    assert.equal(parsed.name, route.name);
    if (route.store) assert.equal(parsed.store, route.store.toUpperCase());
    if (route.auditId) assert.equal(parsed.auditId, route.auditId);
    if (route.section != null) assert.equal(parsed.section, route.section);
    if (route.templateId) assert.equal(parsed.templateId, route.templateId);
  });
  assert.equal(routeFromHash("").name, "home");
  assert.equal(routeFromHash("#/nope").name, "home");
  assert.equal(routeFromHash("#/audit/audit-1").section, 0);
});

test("admin addresses are marked so the page can refuse them", () => {
  assert.equal(isAdminScreen("users"), true);
  assert.equal(isAdminScreen("builder"), true);
  assert.equal(isAdminScreen("builder-detail"), true);
  assert.equal(isAdminScreen("pastdue"), true);
  assert.equal(isAdminScreen("home"), false);
  assert.equal(isAdminScreen("audit"), false);
  assert.equal(isAdminScreen("mytodos"), false);
});

test("an in-progress audit is saved without photo previews and cleared", () => {
  const mem = new Map();
  const storage = {
    getItem: (key) => mem.get(key) || null,
    setItem: (key, value) => mem.set(key, value),
    removeItem: (key) => mem.delete(key),
  };
  saveDraft(storage, {
    audit: { auditId: "audit-1", store: "CPR", storeLabel: "Cottleville", questions: [{ questionId: "q1", section: "Lobby", text: "Mats?", type: "yesno" }] },
    sectionIndex: 1,
    answers: { q1: { answer: "no", note: "torn" } },
    media: { q1: [{ objectKey: "audits/audit-1/q1/up/photo.jpg", fileName: "photo.jpg", mimeType: "image/jpeg", previewUrl: "blob:secret" }] },
    lastResult: null,
    todosLocked: false,
  }, "Cassidy@Example.com");
  const saved = loadDraft(storage);
  assert.equal(saved.media.q1[0].previewUrl, undefined);
  assert.equal(saved.media.q1[0].objectKey, "audits/audit-1/q1/up/photo.jpg");
  assert.equal(saved.answers.q1.note, "torn");
  assert.equal(draftForUser(storage, "other@example.com"), null);
  assert.equal(draftForUser(storage, "cassidy@example.com").audit.auditId, "audit-1");
  clearDraft(storage);
  assert.equal(loadDraft(storage), null);
});
