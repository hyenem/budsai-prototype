// buds-sim · entry point
//
// Three input tracks captured in parallel:
//   S = system playback (page <audio>)            → ring S, 30 s rolling
//   E = external ANC mic                          → ring E, 30 s rolling
//   Q = user question (mic, latched on trigger)   → ring Q, 5 s, VAD-bounded

import { loadOrCreateKeypair } from "../shared/ts/key.js";
import { buildEnvelope, signEnvelope } from "../shared/ts/packet.js";
import { Mic } from "./lib/mic.js";
import { SystemAudio } from "./lib/system-audio.js";
import { RingBuffer, attachRingViz } from "./lib/ring-buffer.js";
import { registerDevice, postSession, streamSession, apiBase } from "./lib/api.js";
import { CodeViewer } from "./lib/code-viewer.js";
import { SNIPPETS } from "./snippets.js";

// ----- constants -----
const SR = 16000;
const LOOKBACK_MS = 30_000;
const QUESTION_MAX_MS = 5_000;
const VAD_HANGOVER_MS = 500;
const VAD_RMS_THRESHOLD = 0.012;

// ----- identity -----
const kp = loadOrCreateKeypair();
const DEVICE_ID = "buds-sim-" + kp.publicB64.slice(0, 8);

// ----- buffers -----
const ringS = new RingBuffer({ durationMs: LOOKBACK_MS, sampleRate: SR, name: "S" });
const ringE = new RingBuffer({ durationMs: LOOKBACK_MS, sampleRate: SR, name: "E" });
const ringQ = new RingBuffer({ durationMs: QUESTION_MAX_MS, sampleRate: SR, name: "Q" });

// ----- audio sources -----
const mic = new Mic();
const sys = new SystemAudio();

// ----- state -----
let recording = false;
let lastVoiceTs = 0;
let questionStartTs = 0;

// ----- code viewer -----
const viewer = new CodeViewer(document.getElementById("code-viewer"), SNIPPETS);

// ----- DOM -----
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
  sysBar:   $("sys-bar"),
  sysNum:   $("sys-num"),
  ringS:    $("ringS"),
  ringA:    $("ringA"),
  ringB:    $("ringB"),
  ringSm:   $("ringS-meta"),
  ringAm:   $("ringA-meta"),
  ringBm:   $("ringB-meta"),
  btnMic:   $("btn-mic"),
  btnClear: $("btn-clear"),
  btnTrig:  $("btn-trigger"),
  feed:     $("feed"),
  answer:   $("answer"),
  ansText:  $("answer-text"),
  ansSong:  $("answer-song"),
  ansAudio: $("answer-audio"),
  ansFollow:$("answer-followups"),
  apiStat:  $("api-status"),
  sysSrc:   $("sys-source"),
  sysEl:    $("sys-audio"),
};

// ----- identity display -----
els.devId.textContent  = DEVICE_ID;
els.devPub.textContent = kp.publicB64.slice(0, 28) + "…";

// ----- ring viz -----
attachRingViz(els.ringS, ringS, "#c084fc");
attachRingViz(els.ringA, ringE, "#5eead4");
attachRingViz(els.ringB, ringQ, "#f472b6");

const slotsPerSec = SR * 0.02;
ringS.onUpdate(() => {
  const slots = Math.floor(ringS.filled / slotsPerSec);
  els.ringSm.textContent = `${slots} / 1500 · ${(ringS.filled / SR).toFixed(1)}s`;
});
ringE.onUpdate(() => {
  const slots = Math.floor(ringE.filled / slotsPerSec);
  els.ringAm.textContent = `${slots} / 1500 · ${(ringE.filled / SR).toFixed(1)}s`;
});
ringQ.onUpdate(() => {
  els.ringBm.textContent = ringQ.filled === 0
    ? "idle"
    : `recording · ${(ringQ.filled / SR).toFixed(2)}s`;
});

// ----- API probe + device registration -----
(async () => {
  try {
    const r = await fetch(apiBase() + "/healthz");
    const j = await r.json();
    els.devSrv.textContent = `${apiBase()} · v${j.version}`;
    els.devSrv.classList.replace("pending", "ok");
    els.apiStat.textContent = `API: ${apiBase()} · v${j.version} · OK`;
  } catch {
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

// ----- mic fan-out → ring E (always) + ring Q (only while recording) -----
mic.onLevel((rms) => {
  const pct = Math.min(100, rms * 600);
  els.micBar.style.height = pct + "%";
  els.micNum.textContent = rms.toFixed(3);

  if (recording) {
    els.qBar.style.height = pct + "%";
    els.qNum.textContent = rms.toFixed(3);
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
  ringE.write(int16);
  viewer.fire("ringbuffer", "writeE");
  if (recording) ringQ.write(int16);
});

// ----- system audio fan-out → ring S -----
sys.onLevel((rms) => {
  els.sysBar.style.height = Math.min(100, rms * 600) + "%";
  els.sysNum.textContent = rms.toFixed(3);
});
sys.onSamples((int16) => {
  ringS.write(int16);
  viewer.fire("ringbuffer", "writeS");
});

// ----- system audio: pick source -----
sys.attach(els.sysEl);   // lazy element graph (only used in mp3 mode)

els.sysSrc.addEventListener("change", async () => {
  const src = els.sysSrc.value;

  if (src === "silence") {
    sys.stopSynthetic();
    els.sysEl.pause();
    els.sysEl.src = "";
    els.sysEl.style.display = "none";
    return;
  }

  if (src.startsWith("synthetic-")) {
    els.sysEl.pause();
    els.sysEl.src = "";
    els.sysEl.style.display = "none";
    try {
      sys.startSynthetic(src);
    } catch (e) {
      console.error("synth start failed", e);
      alert("브라우저가 합성 톤을 생성하지 못했습니다: " + e.message);
    }
    return;
  }

  // mp3 path (user-supplied file in /audio/)
  sys.stopSynthetic();
  els.sysEl.src = "./" + src;
  els.sysEl.style.display = "inline-block";
});
els.sysSrc.dispatchEvent(new Event("change"));

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
  els.ansAudio.style.display = "none";
  els.ansAudio.src = "";
});

els.btnTrig.addEventListener("click", () => startQuestion());

// ----- trigger -----
function startQuestion() {
  if (recording) return;
  if (!mic.isRunning()) { alert("먼저 마이크를 시작하세요."); return; }
  ringQ.reset();
  recording = true;
  questionStartTs = performance.now();
  lastVoiceTs = performance.now();
  els.btnTrig.textContent = "🔴 녹음 중 · 말이 끝나면 자동 종료";
  els.btnTrig.classList.add("is-recording");
  viewer.fire("trigger", "longpress");
  appendFeed("triggered",
    "롱프레스 감지 · S/E 스냅샷 잠금 + Q 캡처 시작", "is-pipe");
}

async function finishQuestion(reason) {
  if (!recording) return;
  recording = false;
  els.btnTrig.textContent = "🔘 롱프레스 트리거 — 질문 시작";
  els.btnTrig.classList.remove("is-recording");
  appendFeed("captured",
    `Q close · ${reason === "vad" ? "500ms 침묵 감지" : "5s 한계 도달"} · ${(ringQ.filled / SR).toFixed(2)}s`,
    "is-pipe");

  // ---- assemble + sign + post + stream ----
  viewer.fire("packet", "snapshot");
  const sBytes = ringS.asBytes();
  const eBytes = ringE.asBytes();
  const qBytes = ringQ.asBytes();
  const sessionId = `bs-${Date.now()}`;

  viewer.fire("packet", "build");
  const env = buildEnvelope({
    deviceId:      DEVICE_ID,
    sessionId,
    trigger:       "long_press",
    systemBytes:   sBytes,  systemMs:   msFromFilled(ringS),
    externalBytes: eBytes,  externalMs: msFromFilled(ringE),
    questionBytes: qBytes,  questionMs: msFromFilled(ringQ),
  });

  viewer.fire("packet", "sign");
  const signed = signEnvelope(env, kp);
  appendFeed("signed",
    `Ed25519 · payload ${humanBytes(sBytes.length + eBytes.length + qBytes.length)} ` +
    `(S:${humanBytes(sBytes.length)} E:${humanBytes(eBytes.length)} Q:${humanBytes(qBytes.length)})`,
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

function msFromFilled(ring) {
  return Math.floor(ring.filled / SR * 1000);
}

function onServerStage(stage) {
  viewer.fire("server", stage.stage || "");
  const friendly = formatStage(stage);
  appendFeed(stage.stage, friendly);
  if (stage.stage === "llm_answer") showAnswer(stage);
  if (stage.stage === "tts" && stage.audio_b64) playTTS(stage);
}

function formatStage(s) {
  switch (s.stage) {
    case "decoded":
      return `3 tracks · S=${s.system_ms}ms · E=${s.external_ms}ms · Q=${s.question_ms}ms`;
    case "stt":
      return `S="${(s.system_text || "").slice(0, 28)}…" · ` +
             `E="${(s.external_text || "").slice(0, 28)}…" · ` +
             `Q="${(s.question_text || "").slice(0, 36)}…"`;
    case "intent":
      return `system=${s.system_kind} · external=${s.external_kind}`;
    case "fingerprint":
      return s.match
        ? `match → ${s.song.artist} — ${s.song.title} (${s.song.year})`
        : "no fingerprint match";
    case "llm_answer":
      return `[${s.track_used}] ${s.intent} → "${(s.answer || "").slice(0, 60)}…"`;
    case "tts":
      return `TTS · voice=${s.voice} · ${s.audio_b64 ? humanBytes(Math.floor(s.audio_b64.length * 3 / 4)) : "mock"}`;
    case "complete":
      return `pipeline complete · ${s.elapsed_ms}ms`;
    case "error":
      return `⚠ ${s.message}`;
    default:
      return JSON.stringify(s).slice(0, 80);
  }
}

function showAnswer(stage) {
  els.ansText.textContent = stage.answer;
  els.ansSong.textContent = `[${stage.track_used}] · ${stage.intent} · ${(stage.confidence * 100).toFixed(0)}% 신뢰도`;
  els.ansFollow.innerHTML = "";
  for (const fu of stage.follow_ups || []) {
    const b = document.createElement("button");
    b.textContent = fu.label;
    b.onclick = () => appendFeed("user", `선택: ${fu.label} (id=${fu.id})`, "is-pipe");
    els.ansFollow.appendChild(b);
  }
  els.answer.classList.add("is-shown");
}

function playTTS(stage) {
  // base64 → Blob → object URL → audio element
  try {
    const bin = atob(stage.audio_b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const blob = new Blob([bytes], { type: stage.audio_mime || "audio/mpeg" });
    const url = URL.createObjectURL(blob);
    els.ansAudio.src = url;
    els.ansAudio.style.display = "block";
    els.ansAudio.play().catch(() => { /* user must click */ });
  } catch (e) {
    console.error("TTS decode failed", e);
  }
}

// ----- helpers -----
function appendFeed(stage, text, extraClass = "") {
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
