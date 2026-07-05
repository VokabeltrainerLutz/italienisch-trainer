/*
 * Italienisch Trainer PWA - Hands-free Live-Client
 * -------------------------------------------------
 * Zweck: Diese Datei ist der Live-Tag-Client (Auto/Zug/unterwegs) fuer den
 * "Hands-free Italienisch Trainer"-Agenten. Sie ruft bei jeder Antwort den
 * Webhook des Agenten auf und liest dessen JSON-Antwort direkt vor.
 *
 * WICHTIG - Grenzen dieser ersten Version:
 * - Dies ist der LIVE-Client. Der Offline-Nacht-Modus (siehe AGENTS.md,
 *   Abschnitt "Offline-Anforderung fuer Nachtnutzung") ist NICHT Teil dieser
 *   Datei und wird bewusst separat gebaut (kein Netz, lokales Paket, lokale
 *   Bewertung). Diese App braucht durchgehend eine Netzverbindung.
 * - Speech-to-Text und Text-to-Speech laufen ausschliesslich ueber die
 *   Bordmittel des Browsers (Web Speech API). Es werden keine fremden
 *   Sprachdateien oder Drittanbieter-Inhalte genutzt.
 * - Die Seite muss im Vordergrund/Bildschirm an bleiben, sonst pausiert die
 *   Spracherkennung (siehe Notiz zu Foreground-Service-Limits von PWAs).
 */

const els = {
  statusBadge: document.getElementById("status-badge"),
  promptLang: document.getElementById("prompt-lang"),
  promptText: document.getElementById("prompt-text"),
  lastTranscript: document.getElementById("last-transcript"),
  btnStart: document.getElementById("btn-start"),
  btnMic: document.getElementById("btn-mic"),
  btnPause: document.getElementById("btn-pause"),
  settingsToggle: document.getElementById("settings-toggle"),
  settingsPanel: document.getElementById("settings-panel"),
  webhookUrl: document.getElementById("webhook-url"),
  webhookToken: document.getElementById("webhook-token"),
  voiceSelect: document.getElementById("voice-select"),
  contextSelect: document.getElementById("context-select"),
  btnSaveSettings: document.getElementById("btn-save-settings"),
  wakelockHint: document.getElementById("wakelock-hint"),
};

const STORAGE_KEY = "it_trainer_settings_v1";
const SESSION_KEY = "it_trainer_session_v1";

let recognition = null;
let wakeLock = null;
let sessionActive = false;
let currentExpectedLang = "it"; // wird vom Agenten pro Aufgabe vorgegeben
let selectedVoice = null;

// ---------- Einstellungen laden/speichern ----------

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    return {};
  }
}

function saveSettings(settings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

function initSettingsUI() {
  const s = loadSettings();
  els.webhookUrl.value = s.webhookUrl || "";
  els.webhookToken.value = s.webhookToken || "";
  els.contextSelect.value = s.context || "auto";

  els.settingsToggle.addEventListener("click", () => {
    els.settingsPanel.classList.toggle("open");
  });

  els.btnSaveSettings.addEventListener("click", () => {
    saveSettings({
      webhookUrl: els.webhookUrl.value.trim(),
      webhookToken: els.webhookToken.value.trim(),
      context: els.contextSelect.value,
      voiceName: selectedVoice ? selectedVoice.name : null,
    });
    els.settingsPanel.classList.remove("open");
    setStatus("idle", "Einstellungen gespeichert");
  });
}

// ---------- Text-to-Speech ----------

function populateVoices() {
  const voices = window.speechSynthesis.getVoices();
  const itVoices = voices.filter((v) => v.lang && v.lang.toLowerCase().startsWith("it"));
  const list = itVoices.length ? itVoices : voices;

  els.voiceSelect.innerHTML = "";
  list.forEach((v, idx) => {
    const opt = document.createElement("option");
    opt.value = v.name;
    opt.textContent = `${v.name} (${v.lang})`;
    els.voiceSelect.appendChild(opt);
  });

  const s = loadSettings();
  const preferred = list.find((v) => v.name === s.voiceName) || list[0];
  selectedVoice = preferred || null;
  if (preferred) els.voiceSelect.value = preferred.name;

  els.voiceSelect.addEventListener("change", () => {
    selectedVoice = list.find((v) => v.name === els.voiceSelect.value) || null;
  });
}

if ("speechSynthesis" in window) {
  window.speechSynthesis.onvoiceschanged = populateVoices;
  populateVoices();
}

function speak(text, lang) {
  return new Promise((resolve) => {
    if (!("speechSynthesis" in window) || !text) {
      resolve();
      return;
    }
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = lang === "it" ? "it-IT" : "de-DE";
    if (selectedVoice && selectedVoice.lang.toLowerCase().startsWith(lang)) {
      utter.voice = selectedVoice;
    }
    utter.onend = resolve;
    utter.onerror = resolve;
    setStatus("speaking", "Spricht...");
    window.speechSynthesis.speak(utter);
  });
}

// ---------- Speech-to-Text ----------

function getRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return null;
  const rec = new SpeechRecognition();
  rec.continuous = false;
  rec.interimResults = false;
  rec.maxAlternatives = 1;
  return rec;
}

function listenOnce(lang) {
  return new Promise((resolve, reject) => {
    recognition = getRecognition();
    if (!recognition) {
      reject(new Error("Spracherkennung im Browser nicht verfuegbar."));
      return;
    }
    recognition.lang = lang === "it" ? "it-IT" : "de-DE";

    els.btnMic.classList.add("listening");
    setStatus("listening", "Hört zu...");

    recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript;
      resolve(transcript);
    };
    recognition.onerror = (event) => {
      reject(new Error("Spracherkennung-Fehler: " + event.error));
    };
    recognition.onend = () => {
      els.btnMic.classList.remove("listening");
    };

    try {
      recognition.start();
    } catch (e) {
      reject(e);
    }
  });
}

function stopListening() {
  if (recognition) {
    try { recognition.stop(); } catch (e) {}
  }
  els.btnMic.classList.remove("listening");
}

// ---------- Wake Lock (Bildschirm an halten) ----------

async function requestWakeLock() {
  try {
    if ("wakeLock" in navigator) {
      wakeLock = await navigator.wakeLock.request("screen");
      els.wakelockHint.textContent = "Bildschirm bleibt während der Session an.";
      wakeLock.addEventListener("release", () => {
        els.wakelockHint.textContent = "Bildschirm-Sperre wurde freigegeben (z. B. App in Hintergrund).";
      });
    } else {
      els.wakelockHint.textContent = "Wake-Lock nicht unterstützt - Bildschirm-Timeout manuell hochstellen.";
    }
  } catch (e) {
    els.wakelockHint.textContent = "Wake-Lock fehlgeschlagen: " + e.message;
  }
}

function releaseWakeLock() {
  if (wakeLock) {
    wakeLock.release();
    wakeLock = null;
  }
}

document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState === "visible" && sessionActive) {
    await requestWakeLock();
  }
});

// ---------- Status-UI ----------

function setStatus(kind, text) {
  els.statusBadge.className = "status-" + kind;
  els.statusBadge.textContent = text;
}

function renderPrompt(promptText, lang) {
  els.promptLang.textContent = lang === "it" ? "Antworte auf Italienisch" : "Antworte auf Deutsch";
  els.promptText.textContent = promptText || "—";
}

// ---------- Webhook-Kommunikation ----------

async function callAgent(payload) {
  const s = loadSettings();
  if (!s.webhookUrl || !s.webhookToken) {
    throw new Error("Webhook-URL oder Token fehlt. Bitte in den Einstellungen eintragen.");
  }

  const response = await fetch(s.webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + s.webhookToken,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error("Webhook-Fehler: HTTP " + response.status);
  }

  return response.json();
}

function buildBasePayload(extra) {
  const s = loadSettings();
  return Object.assign(
    {
      context: s.context || "auto",
      audio_context: "bluetooth_or_speaker_auto",
      session_mode: "mobile",
    },
    extra
  );
}

// ---------- Session-Ablauf ----------

async function handleAgentResponse(data) {
  currentExpectedLang = data.expected_answer_language || "it";
  renderPrompt(data.next_prompt_text, currentExpectedLang);

  if (data.speak_text) {
    await speak(data.speak_text, currentExpectedLang === "de" ? "de" : "it");
  }
  if (data.next_prompt_text && data.next_prompt_text !== data.speak_text) {
    await speak(data.next_prompt_text, currentExpectedLang);
  }

  if (data.status === "paused" || data.status === "stopped") {
    sessionActive = false;
    setStatus("paused", data.status === "stopped" ? "Beendet" : "Pausiert");
    releaseWakeLock();
    return;
  }

  if (data.should_listen) {
    await autoListenAndSend();
  } else {
    setStatus("idle", "Bereit");
  }
}

async function autoListenAndSend() {
  try {
    const transcript = await listenOnce(currentExpectedLang);
    els.lastTranscript.textContent = "Du: " + transcript;
    setStatus("idle", "Verarbeite...");

    const data = await callAgent(
      buildBasePayload({
        event: "answer",
        user_answer: transcript,
      })
    );
    await handleAgentResponse(data);
  } catch (err) {
    setStatus("error", "Fehler: " + err.message);
    // Nach Erkennungsfehler kurzer Retry-Hinweis, Session bleibt aktiv,
    // Nutzer kann ueber Mic-Button erneut sprechen.
  }
}

async function startSession() {
  sessionActive = true;
  await requestWakeLock();
  setStatus("idle", "Starte Session...");
  try {
    const data = await callAgent(buildBasePayload({ event: "start" }));
    await handleAgentResponse(data);
  } catch (err) {
    setStatus("error", "Start fehlgeschlagen: " + err.message);
    sessionActive = false;
  }
}

async function pauseSession() {
  stopListening();
  window.speechSynthesis.cancel();
  try {
    const data = await callAgent(buildBasePayload({ event: "pause" }));
    await handleAgentResponse(data);
  } catch (err) {
    setStatus("error", "Pause-Meldung fehlgeschlagen: " + err.message);
  }
  sessionActive = false;
  releaseWakeLock();
}

// ---------- Buttons ----------

els.btnStart.addEventListener("click", () => {
  if (!sessionActive) {
    startSession();
  }
});

els.btnMic.addEventListener("click", () => {
  if (!sessionActive) return;
  autoListenAndSend();
});

els.btnPause.addEventListener("click", () => {
  pauseSession();
});

// ---------- Init ----------

initSettingsUI();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch((e) => {
      console.warn("Service Worker Registrierung fehlgeschlagen:", e);
    });
  });
}
