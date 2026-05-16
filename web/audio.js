// Move sound effects.
//   * move + capture: real wooden-clack sample (CC0 from freesound.org,
//     "Small Wood Piece Sound" by qubodup, id 822567), pitched and layered
//     via Web Audio.
//   * flip: short scrape (filtered noise) + high-pitched tap from the wood
//     sample, evoking the rotation and landing of the tile.
//   * game-over: synthesized chime.
// AudioContext is created lazily on the first move; sample bytes are
// pre-fetched at module load so the first move doesn't wait on the network.

let ctx = null;
let sampleBytes = null;
let sampleBuffer = null;

const sampleBytesPromise = fetch('./sounds/move.mp3')
  .then(r => r.arrayBuffer())
  .then(b => { sampleBytes = b; })
  .catch(() => { /* offline / blocked — playMoveSound will degrade silently */ });

function getCtx() {
  if (!ctx) ctx = new AudioContext();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

async function getSample(ac) {
  if (sampleBuffer) return sampleBuffer;
  await sampleBytesPromise;
  if (!sampleBytes) return null;
  if (!sampleBuffer) sampleBuffer = await ac.decodeAudioData(sampleBytes.slice(0));
  return sampleBuffer;
}

function playSample(ac, buf, { rate = 1, gain = 1, offsetSec = 0 } = {}) {
  const src = ac.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = rate;
  const g = ac.createGain();
  g.gain.value = gain;
  src.connect(g);
  g.connect(ac.destination);
  src.start(ac.currentTime + offsetSec);
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
      chime(ac, [523, 659, 784], 0.08);
      return;
    }

    if (kind === 'flip') {
      // Brief scrape as the piece rotates.
      noise(ac, 0.055, 1800, 0.18);
      // High-pitched tap from the wood sample as it lands face-up.
      getSample(ac).then(buf => {
        if (!buf) return;
        playSample(ac, buf, { rate: 1.9, gain: 0.55, offsetSec: 0.045 });
      }).catch(() => { /* swallow */ });
      return;
    }

    if (kind === 'move') {
      getSample(ac).then(buf => {
        if (!buf) return;
        if (event.capture) {
          // Light first contact + heavier displaced hit ~30ms later.
          playSample(ac, buf, { rate: 1.0, gain: 0.5 });
          playSample(ac, buf, { rate: 0.7, gain: 1.0, offsetSec: 0.030 });
        } else {
          playSample(ac, buf, { rate: 0.92 });
        }
      }).catch(() => { /* swallow */ });
    }
  } catch (e) {
    // Audio errors should never break gameplay.
  }
}
