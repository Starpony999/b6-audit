import { SCRIPT_URL } from "./config.js";

const TOKEN_KEY = "b6audit.token";

export function scriptConfigured() {
  return !!String(SCRIPT_URL || "").trim();
}

export function getToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ""; } catch (err) { return ""; }
}

export function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token || "");
}

export function clearToken() {
  try { localStorage.removeItem(TOKEN_KEY); } catch (err) {}
}

export async function api(action, payload) {
  const url = String(SCRIPT_URL || "").trim();
  if (!url) {
    const err = new Error("This copy of the app does not have its Apps Script link yet. Add it in js/config.js.");
    err.code = "not-configured";
    throw err;
  }
  let text = "";
  try {
    const response = await fetch(url, {
      method: "POST",
      redirect: "follow",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(Object.assign({ action: action, token: getToken() }, payload || {})),
    });
    text = await response.text();
  } catch (err) {
    const offline = new Error("Couldn't reach the audit service. Check the link in js/config.js, and that the script is deployed as Anyone.");
    offline.code = "offline";
    throw offline;
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    const bad = new Error("That link didn't answer with audit data. Check the web app URL (it should end in /exec).");
    bad.code = "bad-response";
    throw bad;
  }
  if (!data || data.ok === false) {
    const err = new Error((data && data.message) || "The request was not accepted.");
    err.code = (data && data.error) || "error";
    if (err.code === "unauthorized" || err.code === "session-expired") clearToken();
    throw err;
  }
  return data;
}
