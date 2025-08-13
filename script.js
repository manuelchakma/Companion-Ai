/* Companion AI - static client-side app
   NOTE: This client calls the OpenAI REST API directly. For production keep keys server-side.
*/

const chatEl = document.getElementById('chat');
const micBtn = document.getElementById('micBtn');
const statusEl = document.getElementById('status');
const clearBtn = document.getElementById('clearBtn');
const settingsBtn = document.getElementById('settingsBtn');
const settingsModal = document.getElementById('settingsModal');
const saveSettings = document.getElementById('saveSettings');
const closeSettings = document.getElementById('closeSettings');
const apiKeyInput = document.getElementById('apiKeyInput');
const passiveToggle = document.getElementById('passiveToggle');
const wakeInput = document.getElementById('wakeInput');
const clearKey = document.getElementById('clearKey');
const fontSizeSelect = document.getElementById('fontSize');
const speakBtn = document.getElementById('speakBtn');

let apiKey = '';
let passiveMode = false;
let wakeWord = '';
let speakResponses = false;

let recognition = null;
let isListening = false;
let continuousListening = false;

// small helper to render message
function renderMessage(text, from = 'bot') {
  const wrap = document.createElement('div');
  wrap.className = 'flex items-start';
  if (from === 'user') wrap.classList.add('justify-end');

  const bubble = document.createElement('div');
  bubble.className = `msg p-3 rounded-lg max-w-[80%] ${from==='user' ? 'bg-blue-600 text-white ml-auto text-right' : 'bg-gray-700 text-gray-100'}`;
  bubble.style.fontSize = getComputedStyle(document.body).fontSize;

  // very small markdown: **bold** and - bullets
  const html = markdownLite(text);
  bubble.innerHTML = html;

  // avatar
  const avatar = document.createElement('div');
  avatar.className = 'avatar mr-3';
  avatar.style.background = from==='user' ? '#1f2937' : '#374151';
  avatar.textContent = from==='user' ? 'You' : 'Bot';

  if (from === 'user') {
    wrap.appendChild(bubble);
    wrap.appendChild(avatar);
  } else {
    wrap.appendChild(avatar);
    wrap.appendChild(bubble);
  }
  chatEl.appendChild(wrap);
  chatEl.scrollTop = chatEl.scrollHeight;
}

// tiny markdown renderer: bold **text**, lines starting with "- " become bullets
function markdownLite(s) {
  if (!s) return '';
  // escape html
  s = s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

  // bold
  s = s.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');

  // bullets: convert lines that start with "- " into <ul>
  const lines = s.split(/\r?\n/);
  let out = '';
  let inList = false;
  for (const line of lines) {
    if (line.trim().startsWith('- ')) {
      if (!inList) { out += '<ul class="pl-5 list-disc">'; inList = true; }
      out += '<li>' + line.trim().slice(2) + '</li>';
    } else {
      if (inList) { out += '</ul>'; inList = false; }
      out += '<div>' + line + '</div>';
    }
  }
  if (inList) out += '</ul>';
  return out;
}

// ---------- Speech Recognition setup ----------
function initRecognition() {
  const win = window;
  const SpeechRecognition = win.SpeechRecognition || win.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    statusEl.textContent = 'SpeechRecognition not supported in this browser. Use Chrome/Edge.';
    micBtn.disabled = true;
    return;
  }
  recognition = new SpeechRecognition();
  recognition.lang = 'en-US';
  recognition.continuous = false; // for manual mic; passive uses continuous variant below
  recognition.interimResults = false;

  recognition.onstart = () => {
    isListening = true;
    statusEl.textContent = 'Listening…';
    micBtn.classList.add('bg-red-500');
  };

  recognition.onresult = (ev) => {
    const transcript = Array.from(ev.results).map(r=>r[0].transcript).join(' ');
    renderMessage(transcript, 'user');
    // decide: question or statement? if question-like or passive triggered, query AI
    handleHeardText(transcript, { explicit: true });
  };

  recognition.onerror = (e) => {
    console.error('Recognition error', e);
    statusEl.textContent = 'Speech recognition error';
  };

  recognition.onend = () => {
    isListening = false;
    micBtn.classList.remove('bg-red-500');
    statusEl.textContent = passiveMode ? 'Passive listening active' : 'Tap mic to speak';
  };
}

// Separate continuous recognizer for passive listening
let passiveRec = null;
function startPassiveListener() {
  if (!('webkitSpeechRecognition' in window || 'SpeechRecognition' in window)) return;
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  passiveRec = new SpeechRecognition();
  passiveRec.lang = 'en-US';
  passiveRec.interimResults = false;
  passiveRec.continuous = true;

  passiveRec.onresult = (ev) => {
    const transcript = Array.from(ev.results).map(r=>r[0].transcript).join(' ');
    // show small ephemeral status
    statusEl.textContent = 'Heard: ' + transcript.slice(0, 80);
    // attempt to detect topic or question
    handleHeardText(transcript, { explicit: false });
  };

  passiveRec.onerror = (e) => {
    console.log('Passive rec error', e);
  };

  passiveRec.onend = () => {
    // restart if passiveMode still true
    if (passiveMode) {
      setTimeout(()=>passiveRec.start(), 500);
    }
  };

  passiveRec.start();
}

function stopPassiveListener() {
  if (passiveRec) {
    try { passiveRec.onend = null; passiveRec.stop(); } catch(e){ console.warn(e); }
    passiveRec = null;
  }
}

// ---------- Heuristic logic ----------
function isQuestionLike(text) {
  if (!text) return false;
  const qwords = ['who','what','when','where','why','how','is','are','do','does','did','should','could','can','explain','tell me','define'];
  const t = text.trim().toLowerCase();
  // if contains question mark
  if (t.includes('?')) return true;
  // if starts with a qword
  for (const w of qwords) {
    if (t.startsWith(w + ' ') || t.startsWith(w + '\'')) return true;
  }
  // short phrase e.g., "do you mean ost file" contains 'do you mean'
  if (t.includes('do you mean') || t.includes('is this') || t.includes('meaning of')) return true;
  return false;
}

let lastHeardAt = 0;
async function handleHeardText(text, { explicit=false } = {}) {
  // Avoid reacting to tiny fragments or repeated triggers
  if (!text || text.trim().length < 2) return;
  const now = Date.now();
  if (now - lastHeardAt < 2000 && !explicit) return; // throttle passive responses
  lastHeardAt = now;

  const t = text.trim();
  const lower = t.toLowerCase();

  // If wake word configured, require it in passive mode unless explicit
  if (!explicit && wakeWord) {
    if (!lower.includes(wakeWord.toLowerCase())) {
      // not addressed to the bot
      return;
    }
  }

  // If explicit mic press, treat as definite query
  if (explicit || isQuestionLike(t)) {
    renderMessage('**Thinking...**', 'bot');
    // Call AI
    const reply = await askAI(t);
    // Replace last bot thinking with real reply
    // remove last bot "Thinking..." (simple approach: remove last child if it contains Thinking)
    const last = chatEl.lastChild;
    if (last && last.innerText && last.innerText.includes('Thinking')) {
      chatEl.removeChild(last);
    }
    renderMessage(reply, 'bot');
    if (speakResponses) speakText(stripMarkdown(reply));
  } else {
    // Not question-like; attempt a short context inference call if passive (lightweight)
    // We'll run a small "should respond" check with the AI using a short prompt — but to save API calls, only when passiveMode and wake word present OR text contains important IT keywords.
    const keywords = ['password','outlook','ost','pst','error','server','wifi','slow','crash','install','license','office 365','exchange'];
    const hasKW = keywords.some(k => lower.includes(k));
    if (passiveMode && (hasKW || (wakeWord && lower.includes(wakeWord.toLowerCase())))) {
      // treat as a trigger
      renderMessage('**Thinking...**', 'bot');
      const reply = await askAI(t, { inferOnly: true });
      const last = chatEl.lastChild;
      if (last && last.innerText && last.innerText.includes('Thinking')) chatEl.removeChild(last);
      renderMessage(reply, 'bot');
      if (speakResponses) speakText(stripMarkdown(reply));
    }
  }
}

// ---------- OpenAI call ----------
async function askAI(transcript, opts = {}) {
  if (!apiKey) return '**Error:** No API key set. Open Settings and paste your OpenAI key.';
  // Build system prompt for "Sage Ai" persona and constraints
  const system = `You are "Sage Ai", an expert presenter and IT helpdesk assistant. Answer directly and concisely. Do NOT use filler phrases (no "Let's", "Sure,", "As an AI", etc.). Jump straight into the answer. Use simple language and structure the response using short bullet points. Bold the key points using Markdown syntax like **Key point**. Treat the user's transcribed text as the source of truth (do not "correct" minor spelling). If the user's text is not explicitly a question, infer the user's intent and provide useful clarifying information or remediation steps.`;

  // For inference-only (when passive), ask it to infer topic + short answer
  const userMsg = opts.inferOnly ?
    `User utterance (passive overheard): "${transcript}". Determine if this requires a brief helpful response. If yes, provide a short 2-4 bullet points answer relevant to likely user intent. If no, reply with nothing.` :
    `User said: "${transcript}". Provide a clear, direct answer or summary, in bullet points, using bold for key points.`;

  const body = {
    model: 'gpt-3.5-turbo',
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: userMsg }
    ],
    max_tokens: 400,
    temperature: 0.2
  };

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok) {
      console.error('OpenAI error', data);
      return `**Error from API:** ${data.error?.message || JSON.stringify(data)}`;
    }
    const reply = data.choices?.[0]?.message?.content || 'No response';
    return reply.trim();
  } catch (e) {
    console.error(e);
    return '**Error:** Unable to reach AI service.';
  }
}

// small helper to strip markdown for TTS
function stripMarkdown(s) {
  return s.replace(/\*\*(.*?)\*\*/g, '$1').replace(/[-*] /g, '').replace(/<\/?[^>]+(>|$)/g, '');
}

function speakText(text) {
  if (!('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'en-US';
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(u);
}

// ---------- UI wiring ----------
micBtn.addEventListener('click', async () => {
  if (!recognition) initRecognition();
  if (!recognition) return;
  if (isListening) {
    recognition.stop();
  } else {
    recognition.start();
  }
});

clearBtn.addEventListener('click', () => {
  chatEl.innerHTML = '';
});

settingsBtn.addEventListener('click', () => {
  settingsModal.classList.remove('hidden');
  settingsModal.classList.add('flex');
  // prefill
  apiKeyInput.value = apiKey;
  passiveToggle.checked = passiveMode;
  wakeInput.value = wakeWord;
});

closeSettings.addEventListener('click', () => {
  settingsModal.classList.add('hidden');
});

saveSettings.addEventListener('click', () => {
  apiKey = apiKeyInput.value.trim();
  passiveMode = passiveToggle.checked;
  wakeWord = (wakeInput.value || '').trim();
  speakResponses = speakBtn.classList.contains('hidden') ? false : true;
  settingsModal.classList.add('hidden');

  statusEl.textContent = passiveMode ? 'Passive listening active' : 'Tap mic to speak';
  if (passiveMode) {
    startPassiveListener();
  } else {
    stopPassiveListener();
  }
});

clearKey.addEventListener('click', () => {
  apiKey = '';
  apiKeyInput.value = '';
  alert('API key cleared from memory. If you want to use the AI, paste the key again in Settings (not saved to repo).');
});

fontSizeSelect.addEventListener('change', () => {
  chatEl.classList.remove('text-sm','text-base','text-lg');
  chatEl.classList.add(fontSizeSelect.value);
});

// optional: show Speak responses button and toggle voice
speakBtn.addEventListener('click', () => {
  speakResponses = !speakResponses;
  speakBtn.classList.toggle('hidden', !speakResponses);
});

// init
initRecognition();
