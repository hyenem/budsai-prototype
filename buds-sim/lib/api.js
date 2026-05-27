// Thin wrapper for the BudsAI server.
//
// Base URL is read from `<meta name="api-base" content="...">` so the
// same bundle works locally and on Pages without rebuilding.

export function apiBase() {
  const meta = document.querySelector('meta[name="api-base"]');
  return (meta?.content || "http://127.0.0.1:8000").replace(/\/$/, "");
}

export async function registerDevice(deviceId, publicB64) {
  const r = await fetch(apiBase() + "/v1/devices/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_id: deviceId, public_key_b64: publicB64 }),
  });
  if (!r.ok && r.status !== 409) {
    const text = await r.text();
    throw new Error(`register failed: ${r.status} ${text}`);
  }
  return r.status === 201 ? await r.json() : { device_id: deviceId, already: true };
}

export async function postSession(deviceId, signedEnvelope) {
  const r = await fetch(apiBase() + "/v1/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Device-Id": deviceId },
    body: JSON.stringify(signedEnvelope),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`session POST failed: ${r.status} ${text}`);
  }
  return await r.json();
}

/**
 * Subscribe to SSE events for a session.
 *
 * @param {string}   sessionId
 * @param {object}   handlers
 * @param {(stage:object)=>void} handlers.onStage
 * @param {(payload:object)=>void} handlers.onEnd
 * @param {(err:Error)=>void}    handlers.onError
 * @returns {() => void}  function that closes the stream
 */
export function streamSession(sessionId, handlers) {
  const url = apiBase() + "/v1/stream/" + encodeURIComponent(sessionId);
  const es = new EventSource(url);

  es.addEventListener("stage", (e) => {
    try { handlers.onStage?.(JSON.parse(e.data)); }
    catch (err) { handlers.onError?.(err); }
  });
  es.addEventListener("end", (e) => {
    try { handlers.onEnd?.(JSON.parse(e.data || "{}")); }
    finally { es.close(); }
  });
  es.addEventListener("ping", () => {});  // ignore
  es.onerror = (e) => {
    handlers.onError?.(new Error("SSE connection error"));
    es.close();
  };

  return () => es.close();
}
