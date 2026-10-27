// The voice button in the panel's header and its card (docs/voice-agent.md): say or type what
// you want, and the hub's agent (hub/agent.py) does it. Listening is the browser's own speech
// recognition where it has one (Safari, Chrome); in a web view without it (the Mac app, the
// Windows app) the card opens on a text field instead, and typing works everywhere. The request
// goes to POST api/agent; its steps come over the hub's events (`{"agent": …}`, for this page's
// requests only), the reply with the answer, read out when the request was spoken.
import { h } from './dom.js';
import { icon } from './icons.js';
import { isHub, isNative, platform, call, incoming, haptic, CLIENT_ID } from '../bridge.js';

// Only where a hub runs the agent: the page it serves, or the Mac app beside it (`hubRequest`).
export const voiceAvailable = isHub || (isNative && platform === 'macos');

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const ANSWER_WAIT = 130000; // the hub stops a run at 120 s

async function ask(text) {
  const body = { text, client: CLIENT_ID };
  const reply = isHub
    ? fetch('./api/agent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then((r) => r.json(), () => { throw new Error('The hub can’t be reached'); })
    : call('hubRequest', { method: 'POST', path: 'api/agent', body }).catch((error) => error.detail || { error: error.message });
  const answer = await Promise.race([reply, new Promise((resolve) => setTimeout(() => resolve({ error: 'The house didn’t answer in time' }), ANSWER_WAIT))]);
  return answer && typeof answer === 'object' ? answer : { error: 'The hub answered something unreadable' };
}

export function createVoice() {
  const input = h('input.agent-input', {
    type: 'text', enterkeyhint: 'send', autocomplete: 'off', spellcheck: 'false', maxlength: 500,
    placeholder: 'Ask the house…', 'aria-label': 'What should the house do?',
  });
  const mic = h('button.round.agent-mic', { type: 'button', hidden: !Recognition, onclick: () => (listening ? stopListening() : listen()) });
  const send = h('button.round.agent-send', { type: 'button', title: 'Send', 'aria-label': 'Send', onclick: () => submit(false) }, icon('send', 17, 2.2));
  const steps = h('ol.agent-steps');
  const reply = h('p.agent-reply', { 'aria-live': 'polite' });
  const status = h('div.agent-status');
  const card = h('div.agent-card', { hidden: true, role: 'dialog', 'aria-label': 'Ask the house' },
    h('div.agent-row', input, mic, send,
      h('button.round.agent-close', { type: 'button', title: 'Close', 'aria-label': 'Close', onclick: () => close() }, icon('close', 15, 2.2))),
    status, steps, reply);
  const button = h('button.round.agent-button', {
    type: 'button', title: 'Ask the house', 'aria-label': 'Ask the house',
    onclick: () => { haptic('light'); if (card.hidden) openCard(); else if (Recognition && !listening && !busy) listen(); else close(); },
  }, icon('mic', 17, 2));

  let recognition = null;
  let listening = false;
  let busy = false;
  let heard = '';        // the words recognised so far
  let current = null;    // { text, spoken, id }: the request on its way

  function showMic() {
    mic.replaceChildren(icon(listening ? 'stop' : 'mic', 16, 2.2));
    mic.title = listening ? 'Stop listening' : 'Speak';
    mic.setAttribute('aria-label', mic.title);
    mic.classList.toggle('on', listening);
    button.classList.toggle('on', listening);
    card.classList.toggle('listening', listening);
  }

  function setStatus(text, kind = '') {
    status.replaceChildren(...(kind === 'busy' ? [icon('spinner', 14, 2.2)] : []), text ? h('span', text) : '');
    status.className = `agent-status${kind ? ` ${kind}` : ''}`;
  }

  function showSteps(list) {
    steps.replaceChildren(...(list || []).map((s) => h(`li${s.ok === false ? '.failed' : s.ok == null ? '.running' : ''}`,
      icon(s.ok === false ? 'alert' : s.ok == null ? 'spinner' : 'ok', 14, 2.2), h('span', s.text || s.tool))));
  }

  function openCard() {
    card.hidden = false;
    if (Recognition) listen();
    else input.focus();
  }

  function close() {
    if (card.hidden) return false;
    stopListening(true);
    window.speechSynthesis?.cancel();
    card.hidden = true;
    return true;
  }

  /* ---------- listening ---------- */

  function listen() {
    if (!Recognition || listening || busy) return;
    window.speechSynthesis?.cancel();
    const mine = new Recognition();
    recognition = mine;
    mine.lang = navigator.language || 'en-US';
    mine.interimResults = true;
    mine.continuous = false;
    mine.maxAlternatives = 1;
    heard = '';
    let sent = false;
    // A recogniser let go (closed, typed over) may still report: only the current one counts.
    mine.onresult = (ev) => {
      if (recognition !== mine) return;
      let words = '';
      let final = false;
      for (const result of ev.results) {
        words += result[0].transcript;
        final ||= result.isFinal;
      }
      heard = words.trim();
      input.value = heard;
      if (final && heard && !sent) { sent = true; stopListening(); submit(true); }
    };
    mine.onerror = (ev) => {
      if (recognition !== mine) return;
      // No speech is just a pause; anything else (no microphone, not allowed) leaves typing.
      if (ev.error !== 'no-speech' && ev.error !== 'aborted') {
        setStatus(ev.error === 'not-allowed' || ev.error === 'service-not-allowed'
          ? 'The microphone isn’t allowed here: type instead' : 'Couldn’t listen: type instead', 'error');
        input.focus();
      }
    };
    mine.onend = () => {
      if (recognition !== mine) return;
      recognition = null;
      listening = false;
      showMic();
      // Stopped on the pause before a final result came: what was heard is the request.
      if (!sent && heard && !card.hidden) { sent = true; submit(true); }
      else if (!busy && !current && !heard && status.textContent === 'Listening…') setStatus('');
    };
    try {
      mine.start();
    } catch {
      recognition = null;
      setStatus('Couldn’t listen: type instead', 'error');
      input.focus();
      return;
    }
    listening = true;
    input.value = '';
    steps.replaceChildren();
    reply.textContent = '';
    setStatus('Listening…', 'listening');
    showMic();
  }

  function stopListening(discard = false) {
    const mine = recognition;
    if (!mine) return;
    if (discard) {
      // Nothing more is wanted from it: the mic is off now, whatever it still says.
      recognition = null;
      heard = '';
      listening = false;
      showMic();
      if (status.textContent === 'Listening…') setStatus('');
    }
    try { discard ? mine.abort() : mine.stop(); } catch { /* already stopped */ }
  }

  /* ---------- asking ---------- */

  async function submit(spoken) {
    const text = input.value.trim();
    if (!text || busy) return;
    if (listening && !spoken) stopListening(true);
    busy = true;
    current = { text, spoken, id: null };
    input.value = '';
    input.placeholder = text;
    steps.replaceChildren();
    reply.textContent = '';
    setStatus('Thinking…', 'busy');
    send.disabled = true;
    haptic('light');
    const answer = await ask(text);
    busy = false;
    send.disabled = false;
    input.placeholder = 'Ask the house…';
    const said = answer.reply || answer.error || 'Done.';
    if (Array.isArray(answer.steps)) showSteps(answer.steps);
    reply.textContent = said;
    reply.classList.toggle('error', !answer.ok);
    setStatus('');
    haptic(answer.ok ? 'success' : 'error');
    if (current.spoken && !card.hidden && window.speechSynthesis && window.SpeechSynthesisUtterance) {
      const line = new SpeechSynthesisUtterance(said);
      line.lang = navigator.language || 'en-US';
      window.speechSynthesis.speak(line);
    }
    current = null;
  }

  // The run as the hub tells every panel about it: this page's own requests only.
  const onRun = (run) => {
    if (!current || !run || run.client !== CLIENT_ID) return;
    if (current.id && run.id !== current.id) return;
    current.id = run.id;
    showSteps(run.steps);
    if (run.state === 'acting') setStatus('Working on it…', 'busy');
  };
  incoming.agent = onRun;

  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.isComposing) { ev.preventDefault(); submit(false); }
  });
  input.addEventListener('input', () => { if (listening) stopListening(true); });
  showMic();

  return {
    button,
    card,
    get open() { return !card.hidden; },
    close,
    dispose() {
      close();
      if (incoming.agent === onRun) incoming.agent = null;
    },
  };
}
