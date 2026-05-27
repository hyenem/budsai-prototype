// buds-sim · entry point
//
// Wires up: device key → mic → dual ring buffer → trigger → packet sign
//           → POST /v1/sessions → SSE feed → answer rendering.
// Every meaningful step also flashes a line in the code viewer.

import { loadOrCreateKeypair } from "../shared/ts/key.js";
import { buildEnvelope, signEnvelope } from "../shared/ts/packet.js";
import { Mic } from "./lib/mic.js";
import { RingBuffer, attachRingViz } from "./lib/ring-buffer.js";
import { registerDevice, postSession, streamSession, apiBase } from "./lib/api.js";
import { CodeViewer } from "./lib/code-viewer.js";
import { SNIPPETS } from "./snippets.js";

// ----- state -----
const SAMPLE_RATE = 16000;
const LOOKBACK_MS = 30_000;
const QUESTION_MAX_MS = 5_000;
const VAD_HANGOVER_MS = 500;
const VAD_RMS_THRESHOLD = 0.012;

const kp = loadOrCreateKeypair();
const DEVICE_ID = "buds-sim-" + kp.publicB64.slice(0, 8);

const ringA = new RingBuffer({ durationMs: LOOKBACK_MS, sampleRate: SAMPLE_RATE, name: "A" });
const ringB = new RingBuffer({ durationMs: QUESTION_MAX_MS, sampleRate: SAMPLE_RATE, name: "B" });

const mic = new Mic();
let recording = false;          // currently capturing into B
let lastVoiceTs = 0;            // for VAD hangover
let questionStartTs = 0;

const viewer = new CodeViewer(document.getElementById("code-viewer"), SNIPPETS);

// ----- DOM refs -----
const $ = (id) => document.getElementById(id);
const els = {
  devId:    $("dev-id"),
  devPub:   $("dev-pub"),
  devReg:   $("dev-reg"),
  devSrv:   $("dev-server"),
  micBar:   $("mic-bar"),
  micNum:   $("mic-num"),
  qBar:     $("q-bar"),
  qNum:     $("q-num"),
  ringA:    $("ringA"),
  ringB:    $("ringB"),
  ringAm:   $("ringA-meta"),
  ringBm:   $("ringB-meta"),
  btnMic:   $("btn-mic"),
  btnClear: $("btn-clear"),
  btnTrig:  $("btn-trigger"),
  feed:     $("feed"),
  answer:   $("answer"),
  ansText:  $("answer-text"),
  ansSong:  $("answer-song"),
  ansFollow:$("answer-followups"),
  apiStat:  $("api-status"),
};

// ----- init UI -----
els.devId.textContent  = DEVICE_ID;
els.devPub.textContent = kp.publicB64.slice(0, 28) + "…";

attachRingViz(els.ringA, ringA, "#5eead4");
attachRingViz(els.ringB, ringB, "#f472b6");

ringA.onUpdate(() => {
  const slots = Math.floor(ringA.filled / (SAMPLE_RATE * 0.02));
  els.ringAm.textContent = `${slots} / 1500 slots · ${(ringA.filled / SAMPLE_RATE).toFixed(1)}s`;
});
ringB.onUpdate(() => {
  if (ringB.filled === 0) {
    els.ringBm.textContent = "idle";
  } else {
    els.ringBm.textContent = `recording · ${(ringB.filled / SAMPLE_RATE).toFixed(2)}s`;
  }
});

// ----- API probe + device registration -----
(async () => {
  try {
    const r = await fetch(apiBase() + "/healthz");
    const j = await r.json();
    els.devSrv.textContent = `${apiBase()} · v${j.version}`;
    els.devSrv.classList.replace("pending", "ok");
    els.apiStat.textContent = `API: ${apiBase()} · v${j.version} · OK`;
  } catch (e) {
    els.devSrv.textContent = "unreachable";
    els.devSrv.classList.remove("pending");
    els.apiStat.textContent = "API: unreachable";
  }
  try {
    viewer.fire("device", "register");
    await registerDevice(DEVICE_ID, kp.publicB64);
    els.devReg.textContent = "✓ registered";
    els.devReg.classList.replace("pending", "ok");
  } catch (e) {
    els.devReg.textContent = "✗ " + e.message;
    els.devReg.classList.remove("pending");
  }
})();

// ----- mic + sample fan-out to both buffers -----
mic.onLevel((rms) => {
  const pct = Math.min(100, rms * 600);
  els.micBar.style.height = pct + "%";
  els.micNum.textContent = rms.toFixed(3);

  if (recording) {
    const qPct = Math.min(100, rms * 600);
    els.qBar.style.height = qPct + "%";
    els.qNum.textContent = rms.toFixed(3);

    // VAD hangover: if voice detected, refresh timer
    if (rms > VAD_RMS_THRESHOLD) {
      lastVoiceTs = performance.now();
      viewer.fire("vad", "speech");
    } else if (lastVoiceTs && performance.now() - lastVoiceTs > VAD_HANGOVER_MS) {
      viewer.fire("vad", "endpoint");
      finishQuestion("vad");
    } else if (performance.now() - questionStartTs > QUESTION_MAX_MS) {
      finishQuestion("max");
    }
  }
});

mic.onSamples((int16) => {
  ringA.write(int16);
  viewer.fire("ringbuffer", "writeA");
  if (recording) {
    ringB.write(int16);
  }
});

// ----- buttons -----
els.btnMic.addEventListener("click", async () => {
  if (mic.isRunning()) return;
  try {
    viewer.fire("mic", "getusermedia");
    await mic.start();
    els.btnMic.textContent = "🎤 마이크 ON";
    els.btnMic.disabled = true;
    els.btnTrig.disabled = false;
  } catch (e) {
    alert("마이크 권한이 거부되었습니다: " + e.message);
  }
});

els.btnClear.addEventListener("click", () => {
  els.feed.innerHTML = '<div class="empty">트리거를 눌러 첫 세션을 시작하세요.</div>';
  els.answer.classList.remove("is-shown");
});

els.btnTrig.addEventListener("click", () => startQuestion());

// ----- trigger -----
function startQuestion() {
  if (recording) return;
  if (!mic.isRunning()) { alert("먼저 마이크를 시작하세요."); return; }
  ringB.reset();
  recording = true;
  questionStartTs = performance.now();
  lastVoiceTs = performance.now();
  els.btnTrig.textContent = "🔴 녹음 중 · 말이 끝나면 자동 종료";
  els.btnTrig.classList.add("is-recording");
  viewer.fire("trigger", "longpress");
  appendFeed("triggered", "롱프레스 감지 · A 스냅샷 잠금 + B 캡처 시작", "is-pipe");
}

async function finishQuestion(reason) {
  if (!recording) return;
  recording = false;
  els.btnTrig.textContent = "🔘 롱프레스 트리거 — 질문 시작";
  els.btnTrig.classList.remove("is-recording");
  appendFeed("captured",
    `B close · ${reason === "vad" ? "500ms 침묵 감지" : "5s 한계 도달"} · ${(ringB.filled / SAMPLE_RATE).toFixed(2)}s`,
    "is-pipe");

  // ---- assemble + sign + post + stream ----
  viewer.fire("packet", "snapshot");
  const aBytes = ringA.asBytes();
  const bBytes = ringB.asBytes();
  const sessionId = `bs-${Date.now()}`;

  viewer.fire("packet", "build");
  const env = buildEnvelope({
    deviceId:      DEVICE_ID,
    sessionId,
    trigger:       "long_press",
    lookbackBytes: aBytes,
    questionBytes: bBytes,
    lookbackMs:    Math.floor(ringA.filled / SAMPLE_RATE * 1000),
    questionMs:    Math.floor(ringB.filled / SAMPLE_RATE * 1000),
  });

  viewer.fire("packet", "sign");
  const signed = signEnvelope(env, kp);
  appendFeed("signed",
    `Ed25519 sig = ${signed.sig.slice(0, 14)}… · payload ${humanBytes(aBytes.length + bBytes.length)}`,
    "is-pipe");

  try {
    viewer.fire("api", "post");
    const resp = await postSession(DEVICE_ID, signed);
    appendFeed("posted", `session_id = ${resp.session_id}`, "is-pipe");

    viewer.fire("api", "stream");
    streamSession(resp.session_id, {
      onStage: (stage) => onServerStage(stage),
      onEnd:   ()      => appendFeed("end", "session complete", "is-final"),
      onError: (e)     => appendFeed("error", e.message, "is-pipe"),
    });
  } catch (e) {
    appendFeed("error", e.message);
  }
}

function onServerStage(stage) {
  viewer.fire("server", stage.stage || "");
  const friendly = formatStage(stage);
  appendFeed(stage.stage, friendly);
  if (stage.stage === "llm_answer") {
    showAnswer(stage);
  }
}

function formatStage(s) {
  switch (s.stage) {
    case "decoded":     return s.note || "Opus → PCM";
    case "stt":         return `transcript = "${s.transcript}"`;
    case "intent":      return `intent = ${s.intent} (${(s.confidence * 100).toFixed(0)}%)`;
    case "fingerprint": return s.match
      ? `match → ${s.song.artist} — ${s.song.title} (${s.song.year})`
      : "no fingerprint match";
    case "llm_answer":  return `"${s.answer.slice(0, 60)}…"`;
    case "tts":         return `TTS · voice=${s.voice} · ${s.duration_ms}ms`;
    case "complete":    return "pipeline complete";
    default:            return JSON.stringify(s).slice(0, 80);
  }
}

function showAnswer(stage) {
  els.ansText.textContent = stage.answer;
  els.ansSong.textContent = "";
  els.ansFollow.innerHTML = "";
  for (const fu of stage.follow_ups || []) {
    const b = document.createElement("button");
    b.textContent = fu.label;
    b.onclick = () => appendFeed("user", `선택: ${fu.label} (id=${fu.id})`, "is-pipe");
    els.ansFollow.appendChild(b);
  }
  els.answer.classList.add("is-shown");
}

// ----- feed helpers -----
function appendFeed(stage, text, extraClass = "") {
  // Drop the placeholder line on first real event
  const empty = els.feed.querySelector(".empty");
  if (empty) empty.remove();
  const row = document.createElement("div");
  row.className = "ev " + extraClass;
  row.innerHTML = `<span class="stage">${stage}</span><span>${escapeHtml(text)}</span>`;
  els.feed.appendChild(row);
  els.feed.scrollTop = els.feed.scrollHeight;
}

function humanBytes(n) {
  if (n < 1024) return n + "B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + "KB";
  return (n / 1024 / 1024).toFixed(2) + "MB";
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}
