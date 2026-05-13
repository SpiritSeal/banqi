// Move sound effects synthesized via Web Audio API.
// AudioContext is created lazily on the first move (user has already clicked,
// so autoplay policy is satisfied by then).

let ctx = null;

function getCtx() {
  if (!ctx) ctx = new AudioContext();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function noise(ac, duration, frequency, gain) {
  const bufLen = Math.ceil(ac.sampleRate * duration);
  const buf = ac.createBuffer(1, bufLen, ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;

  const src = ac.createBufferSource();
  src.buffer = buf;

  const filter = ac.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = frequency;
  filter.Q.value = 1.5;

  const g = ac.createGain();
  const t = ac.currentTime;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.005);
  g.gain.exponentialRampToValueAtTime(0.001, t + duration);

  src.connect(filter);
  filter.connect(g);
  g.connect(ac.destination);
  src.start(t);
  src.stop(t + duration);
}

function tone(ac, frequency, gain, attack, duration) {
  const osc = ac.createOscillator();
  osc.type = 'triangle';
  osc.frequency.value = frequency;

  const g = ac.createGain();
  const t = ac.currentTime;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + attack);
  g.gain.exponentialRampToValueAtTime(0.001, t + duration);

  osc.connect(g);
  g.connect(ac.destination);
  osc.start(t);
  osc.stop(t + duration);
}

function chime(ac, frequencies, noteDuration) {
  frequencies.forEach((freq, i) => {
    const osc = ac.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;

    const g = ac.createGain();
    const start = ac.currentTime + i * noteDuration;
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(0.3, start + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, start + noteDuration * 2);

    osc.connect(g);
    g.connect(ac.destination);
    osc.start(start);
    osc.stop(start + noteDuration * 2);
  });
}

export function playMoveSound(event) {
  try {
    const ac = getCtx();
    const kind = event.action?.kind;

    if (event.game_over) {
      // Ascending chime for any game end.
      chime(ac, [523, 659, 784], 0.08);
      return;
    }

    if (kind === 'flip') {
      noise(ac, 0.085, 700, 0.4);
    } else if (kind === 'move') {
      if (event.capture) {
        tone(ac, 340, 0.5, 0.003, 0.13);
        noise(ac, 0.09, 600, 0.45);
      } else {
        tone(ac, 520, 0.25, 0.003, 0.055);
      }
    }
  } catch (e) {
    // Audio errors should never break gameplay.
  }
}
