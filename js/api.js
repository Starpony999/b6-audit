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

export function requestBody(action, payload) {
  return JSON.stringify(Object.assign({ action: action, token: getToken() }, payload || {}));
}

// Closing a tab can cancel a normal fetch. keepalive keeps the same POST
// (text/plain JSON, same shape as api()) alive through the Apps Script redirect.
// sendBeacon is only the fallback when fetch cannot be started. Apps Script
// often drops beacon bodies on that redirect, so this is best effort.
export function sendKeepalive(action, payload) {
  const url = String(SCRIPT_URL || "").trim();
  if (!url) return false;
  const body = requestBody(action, payload);
  if (body.length > 60000) return false;
  try {
    const pending = fetch(url, {
      method: "POST",
      redirect: "follow",
      keepalive: true,
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body,
    });
    if (pending && typeof pending.catch === "function") pending.catch(() => {});
    return true;
  } catch (err) {
    try {
      if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
        return navigator.sendBeacon(url, new Blob([body], { type: "text/plain;charset=utf-8" }));
      }
    } catch (beaconErr) {}
    return false;
  }
}

export async function api(action, payload, opts) {
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
      keepalive: !!(opts && opts.keepalive),
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: requestBody(action, payload),
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
