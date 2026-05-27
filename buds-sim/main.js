// buds-sim · entry point
//
// Three input tracks captured in parallel:
//   S = system playback (page <audio> or synth)  → ring S, 30 s rolling
//   E = external mic                              → ring E, 30 s rolling
//   Q = user question (mic, latched on trigger)   → ring Q, 5 s, VAD-bounded
//
// All AudioContext + capture starts on the user's first click of
// "마이크 시작" — browsers block autoplay before any user gesture.

import { loadOrCreateKeypair } from "../shared/ts/key.js";
import { buildEnvelope, signEnvelope } from "../shared/ts/packet.js";
import { Mic } from "./lib/mic.js";
import { SystemAudio } from "./lib/system-audio.js";
import { RingBuffer, attachRingViz } from "./lib/ring-buffer.js";
import { registerDevice, postSession, streamSession, apiBase } from "./lib/api.js";
import { CodeViewer } from "./lib/code-viewer.js";
import { OpusRecorder, blobToB64u } from "./lib/opus-recorder.js";
import { SNIPPETS } from "./snippets.js";

// ----- constants -----
const SR = 16000;
const LOOKBACK_MS = 30_000;
const QUESTION_MAX_MS = 8_000;        // hard cap (was 5; user complained recording cut off)
const VAD_HANGOVER_MS = 900;          // silence to consider speech ended
const VAD_RMS_THRESHOLD = 0.008;      // more sensitive (was 0.012)
const VAD_MIN_SPEECH_MS = 300;        // need at least this much speech before allowing endpoint

// ----- DOM -----
const $ = (id) => document.getElementById(id);
const els = {
  devId:    $("dev-id"),
  devPub:   $("dev-pub"),
  devReg:   $("dev-reg"),
  devSrv:   $("dev-server"),
  devCodec: $("dev-codec"),
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
  sysMute:  $("sys-mute"),
};

// ----- top-level error catch so failures land in the UI, not just console -----
window.addEventListener("error", (e) => fatal("script error", e.message));
window.addEventListener("unhandledrejection", (e) =>
  fatal("async error", e.reason?.message || String(e.reason))
);

function fatal(label, msg) {
  appendFeed(label, msg, "is-pipe");
  els.devReg.textContent = "✗ " + msg;
  els.devReg.classList.remove("pending");
  console.error("[buds-sim]", label, msg);
}

// ===== STATE =====
const ringS = new RingBuffer({ durationMs: LOOKBACK_MS, sampleRate: SR, name: "S" });
const ringE = new RingBuffer({ durationMs: LOOKBACK_MS, sampleRate: SR, name: "E" });
const ringQ = new RingBuffer({ durationMs: QUESTION_MAX_MS, sampleRate: SR, name: "Q" });

const mic = new Mic();
const sys = new SystemAudio();
let opusRec = null;     // OpusRecorder, lazily created after mic starts

let kp = null;             // Ed25519 keypair (set during boot)
let DEVICE_ID = "—";
let recording = false;
let questionStartTs = 0;
let firstVoiceTs = 0;     // when speech was first detected this take (0 = never yet)
let lastVoiceTs = 0;      // when speech was last detected (only meaningful after first)
let bootOk = false;

// ===== ring viz attached immediately (no audio yet, just empty bars) =====
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

// ===== CODE VIEWER =====
const viewer = new CodeViewer(document.getElementById("code-viewer"), SNIPPETS);

// ===== BOOT: identity + API probe + device register =====
(async () => {
  try {
    // 1. Ed25519 keypair (async in v1)
    kp = await loadOrCreateKeypair();
    DEVICE_ID = "buds-sim-" + kp.publicB64.slice(0, 8);
    els.devId.textContent = DEVICE_ID;
    els.devPub.textContent = kp.publicB64.slice(0, 28) + "…";
  } catch (e) {
    fatal("keypair", e.message);
    return;
  }

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
    bootOk = true;
    appendFeed("ready", "👇 마이크 시작 버튼을 눌러 캡처를 시작하세요.", "is-pipe");
  } catch (e) {
    fatal("register", e.message);
  }
})();

// ===== AUDIO LISTENERS (wired once; fire only when mic / sys is running) =====
mic.onLevel((rms) => {
  const pct = Math.min(100, rms * 600);
  els.micBar.style.height = pct + "%";
  els.micNum.textContent = rms.toFixed(3);

  if (recording) {
    els.qBar.style.height = pct + "%";
    els.qNum.textContent = rms.toFixed(3);
    const now = performance.now();

    if (rms > VAD_RMS_THRESHOLD) {
      if (!firstVoiceTs) firstVoiceTs = now;
      lastVoiceTs = now;
      viewer.fire("vad", "speech");
    }

    // Only consider closing on silence AFTER:
    //   (a) we've heard speech at least once (firstVoiceTs > 0)
    //   (b) we've heard ≥ VAD_MIN_SPEECH_MS of voiced frames cumulatively
    //   (c) the trailing silence has lasted ≥ VAD_HANGOVER_MS
    const heardEnough = firstVoiceTs && (lastVoiceTs - firstVoiceTs) >= VAD_MIN_SPEECH_MS;
    const tailedOut = lastVoiceTs && now - lastVoiceTs > VAD_HANGOVER_MS;

    if (heardEnough && tailedOut) {
      viewer.fire("vad", "endpoint");
      finishQuestion("vad");
    } else if (now - questionStartTs > QUESTION_MAX_MS) {
      finishQuestion("max");
    }
  }
});

mic.onSamples((int16) => {
  ringE.write(int16);
  if (recording) ringQ.write(int16);
});

sys.onLevel((rms) => {
  els.sysBar.style.height = Math.min(100, rms * 600) + "%";
  els.sysNum.textContent = rms.toFixed(3);
});
sys.onSamples((int16) => { ringS.write(int16); });

// ===== System audio: source picker. ALL action deferred to first user click. =====
sys.attach(els.sysEl);
if (els.sysMute) {
  sys.muted = els.sysMute.checked;
  els.sysMute.addEventListener("change", () => sys.setMuted(els.sysMute.checked));
}
els.sysSrc.addEventListener("change", () => {
  // Only act after the user has interacted (so AudioContext can resume).
  if (!mic.isRunning()) return;
  applySysSource();
});
async function applySysSource() {
  const src = els.sysSrc.value;
  if (src === "silence") {
    sys.stopSynthetic();
    try { els.sysEl.pause(); } catch {}
    els.sysEl.src = "";
    els.sysEl.style.display = "none";
    appendFeed("sys", "선택 안 함 — 시스템 트랙 비어있음", "is-pipe");
    return;
  }
  if (src.startsWith("synthetic-")) {
    try { els.sysEl.pause(); } catch {}
    els.sysEl.src = "";
    els.sysEl.style.display = "none";
    try {
      await sys.startSynthetic(src);
      appendFeed("sys", `${src} 활성 · 시스템 트랙 채워지는 중 (음소거 ${sys.muted ? "ON — 마이크 보호" : "OFF — 스피커 출력 중"})`, "is-pipe");
    } catch (e) {
      fatal("sys", "시스템 사운드 시작 실패: " + e.message);
    }
    return;
  }
  sys.stopSynthetic();
  els.sysEl.src = "./" + src;
  els.sysEl.style.display = "inline-block";
  try { await els.sysEl.play(); } catch {}
  appendFeed("sys", `${src} 재생 시도`, "is-pipe");
}

// ===== Buttons =====
els.btnMic.addEventListener("click", async () => {
  if (!bootOk) { alert("아직 준비 중입니다 — 디바이스 등록을 기다려주세요."); return; }
  if (mic.isRunning()) return;
  try {
    viewer.fire("mic", "getusermedia");
    await mic.start();
    // Prepare Opus encoder against the same mic stream.
    if (OpusRecorder.isSupported()) {
      opusRec = new OpusRecorder(mic.stream);
      if (els.devCodec) {
        els.devCodec.textContent = opusRec.mime + "  ✓";
        els.devCodec.classList.replace("pending", "ok");
      }
      appendFeed("opus", `MediaRecorder ready · ${opusRec.mime} @ ~16 kbps`, "is-pipe");
    } else {
      if (els.devCodec) {
        els.devCodec.textContent = "pcm16 (Opus not supported in this browser)";
      }
      appendFeed("opus", "⚠ Opus not supported in this browser — falling back to raw PCM for question", "is-pipe");
    }
    els.btnMic.innerHTML = "✓ 시뮬레이션 실행 중";
    els.btnMic.classList.remove("btn-start");
    els.btnMic.classList.add("is-running");
    els.btnMic.disabled = true;
    els.btnTrig.disabled = false;
    appendFeed("started", "외부 마이크 + 시스템 재생 활성화 — 트리거 버튼을 눌러 질문하세요", "is-pipe");
    // Now that we have a user gesture, start the chosen system source too.
    applySysSource();
  } catch (e) {
    fatal("mic", "마이크 권한 거부 또는 실패: " + e.message);
  }
});

els.btnClear.addEventListener("click", () => {
  els.feed.innerHTML = '<div class="empty">트리거를 눌러 새 세션을 시작하세요.</div>';
  els.answer.classList.remove("is-shown");
  els.ansAudio.style.display = "none";
  els.ansAudio.src = "";
});

els.btnTrig.addEventListener("click", () => startQuestion());

// ===== Trigger =====
function startQuestion() {
  if (recording) return;
  if (!mic.isRunning()) { alert("먼저 ▶ 시뮬레이션 시작 버튼을 눌러주세요."); return; }
  ringQ.reset();
  recording = true;
  questionStartTs = performance.now();
  firstVoiceTs = 0;
  lastVoiceTs = 0;
  els.btnTrig.textContent = "🔴 녹음 중 · 말씀하세요…";
  els.btnTrig.classList.add("is-recording");
  viewer.fire("trigger", "longpress");
  // Start Opus encoder for the question track.
  if (opusRec) {
    try { opusRec.start(); } catch (e) { console.warn("opus start", e); opusRec = null; }
  }
  appendFeed("triggered",
    "녹음 시작 — 말씀 후 약 0.9s 침묵 또는 최대 8s에서 자동 전송", "is-pipe");
}

async function finishQuestion(reason) {
  if (!recording) return;
  recording = false;
  els.btnTrig.textContent = "🔘 롱프레스 트리거 — 질문 시작";
  els.btnTrig.classList.remove("is-recording");
  appendFeed("captured",
    `Q close · ${reason === "vad" ? "500ms 침묵 감지" : "5s 한계 도달"} · ${(ringQ.filled / SR).toFixed(2)}s`,
    "is-pipe");

  try {
    viewer.fire("packet", "snapshot");
    const sBytes = ringS.asBytes();
    const eBytes = ringE.asBytes();
    const qBytes = ringQ.asBytes();
    const sessionId = `bs-${Date.now()}`;

    // Stop the Opus recorder and pull its WebM blob.
    let opusBlob = null;
    if (opusRec) {
      try {
        opusBlob = await opusRec.stop();
        appendFeed("opus",
          `question encoded → ${opusRec.mime} · ${humanBytes(opusBlob.size)}` +
          ` (PCM would be ${humanBytes(qBytes.length)} · ~${(qBytes.length / Math.max(1, opusBlob.size)).toFixed(1)}× smaller)`,
          "is-pipe");
      } catch (e) {
        console.warn("opus stop failed", e);
      }
    }

    viewer.fire("packet", "build");
    const env = buildEnvelope({
      deviceId:      DEVICE_ID,
      sessionId,
      trigger:       "long_press",
      systemBytes:   sBytes,  systemMs:   msFromFilled(ringS),
      externalBytes: eBytes,  externalMs: msFromFilled(ringE),
      questionBytes: qBytes,  questionMs: msFromFilled(ringQ),
      questionOpus_b64:  opusBlob ? await blobToB64u(opusBlob) : undefined,
      questionOpus_mime: opusBlob ? opusRec.mime : undefined,
    });

    viewer.fire("packet", "sign");
    const signed = await signEnvelope(env, kp);
    const totalRaw = sBytes.length + eBytes.length + (opusBlob ? opusBlob.size : qBytes.length);
    appendFeed("signed",
      `Ed25519 · payload ${humanBytes(totalRaw)} ` +
      `(S:${humanBytes(sBytes.length)} E:${humanBytes(eBytes.length)} ` +
      `Q:${opusBlob ? humanBytes(opusBlob.size) + " opus" : humanBytes(qBytes.length) + " pcm"})`,
      "is-pipe");

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
    fatal("trigger", e.message);
  }
}

function msFromFilled(ring) { return Math.floor(ring.filled / SR * 1000); }

function onServerStage(stage) {
  viewer.fire("server", stage.stage || "");
  appendFeed(stage.stage, formatStage(stage));
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
      return `system=${s.system_kind || "?"} · external=${s.external_kind || "?"}`;
    case "fingerprint":
      return s.match
        ? `match → ${s.song.artist} — ${s.song.title} (${s.song.year})`
        : "no fingerprint match";
    case "llm_answer":
      return `[${s.track_used}] ${s.intent} → "${(s.answer || "").slice(0, 60)}…"`;
    case "tts":
      return `TTS · voice=${s.voice} · ${s.audio_b64 ? humanBytes(Math.floor(s.audio_b64.length * 3 / 4)) : "mock"}`;
    case "complete":
      return `pipeline complete · ${s.elapsed_ms || "?"}ms`;
    case "error":
      return `⚠ ${s.message}`;
    default:
      return JSON.stringify(s).slice(0, 80);
  }
}

function showAnswer(stage) {
  els.ansText.textContent = stage.answer;
  els.ansSong.textContent = `[${stage.track_used}] · ${stage.intent} · ${((stage.confidence || 0) * 100).toFixed(0)}% 신뢰도`;
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
  try {
    const bin = atob(stage.audio_b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const blob = new Blob([bytes], { type: stage.audio_mime || "audio/mpeg" });
    els.ansAudio.src = URL.createObjectURL(blob);
    els.ansAudio.style.display = "block";
    els.ansAudio.play().catch(() => {});
  } catch (e) {
    console.error("TTS decode failed", e);
  }
}

// ===== helpers =====
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
