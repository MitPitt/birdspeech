// Speech -> birdsong AudioWorkletProcessor.
// Direct port of birdspeech/dsp.py + birdspeech/convert.py, which in turn
// reproduce windytan's blackbird.pl (csdr shift_math_cc / fmdemod_quadri_cf /
// amdemod_cf and the SoX `sinc` Kaiser low-pass).
//
// Web-only extensions beyond the original proof of concept:
//   * the fixed output harmonic (6) is folded into a BASE_HARMONIC constant and
//     the Pitch control transposes continuously;
//   * the old "harmony" multiplier is repurposed as a real additive timbre
//     (waveform + harmonic count), so the pure sine can become a buzzy croak;
//   * the tracker's frequency shift and low-pass width are runtime parameters;
//   * an optional slow automatic level control;
//   * separate envelope and pitch tracking speeds;
//   * an optional trill (pitch vibrato) LFO;
//   * the tracked input F0 is reported back to the UI;
//   * the band-limited tracker/control path runs at a decimated rate.

const TWO_PI = 2 * Math.PI;
const BASE_HARMONIC = 6;
const TRILL_MAX = 0.16;
// The demodulated signal is band-limited to ~140 Hz, so the tracker and its
// 70 Hz smoothing filters can run at 1/8 of the audio rate with no aliasing.
const DECIM = 8;
const FMDEMOD_QUADRI_K = 0.340447550238101026565118445432744920253753662109375;
const KAISER_COEFS = [
  [-6.784957e-10, 1.02856e-05, 0.1087556, -0.8988365 + 0.001],
  [-6.897885e-10, 1.027433e-05, 0.10876, -0.8994658 + 0.002],
  [-1.000683e-09, 1.030092e-05, 0.1087677, -0.9007898 + 0.003],
  [-3.654474e-10, 1.040631e-05, 0.1087085, -0.8977766 + 0.006],
  [8.106988e-09, 6.983091e-06, 0.1091387, -0.9172048 + 0.015],
  [9.519571e-09, 7.272678e-06, 0.1090068, -0.9140768 + 0.025],
  [-5.626821e-09, 1.342186e-05, 0.1083999, -0.9065452 + 0.05],
  [-9.965946e-08, 5.073548e-05, 0.1040967, -0.7672778 + 0.085],
  [1.604808e-07, -5.856462e-05, 0.1185998, -1.34824 + 0.1],
  [-1.511964e-07, 6.363034e-05, 0.1064627, -0.9876665 + 0.18],
];

function clampInt(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

function besselI0(x) {
  let term = 1;
  let sum = 1;
  const x2 = x / 2;
  let i = 1;
  for (;;) {
    const y = x2 / i;
    i += 1;
    term *= y * y;
    const last = sum;
    sum += term;
    if (sum === last) return sum;
  }
}

function kaiserBeta(att, trBw) {
  if (att >= 60) {
    const realm = Math.log(trBw / 0.0005) / Math.log(2);
    const ir = Math.trunc(realm);
    const c0 = KAISER_COEFS[clampInt(ir, 0, KAISER_COEFS.length - 1)];
    const c1 = KAISER_COEFS[clampInt(1 + ir, 0, KAISER_COEFS.length - 1)];
    const b0 = ((c0[0] * att + c0[1]) * att + c0[2]) * att + c0[3];
    const b1 = ((c1[0] * att + c1[1]) * att + c1[2]) * att + c1[3];
    return b0 + (b1 - b0) * (realm - ir);
  }
  if (att > 50) return 0.1102 * (att - 8.7);
  if (att > 20.96)
    return 0.58417 * Math.pow(att - 20.96, 0.4) + 0.07886 * (att - 20.96);
  return 0;
}

function makeLpf(numTaps, fc, beta) {
  const m = numTaps - 1;
  const h = new Float64Array(numTaps);
  const mult = 1 / besselI0(beta);
  const mult1 = 1 / (0.5 * m);
  for (let i = 0; i <= m / 2; i++) {
    const z = i - 0.5 * m;
    const x = z * Math.PI;
    const y = z * mult1;
    let val = x !== 0 ? Math.sin(fc * x) / x : fc;
    val *= besselI0(beta * Math.sqrt(Math.max(0, 1 - y * y))) * mult;
    h[i] = val;
    if (m - i !== i) h[m - i] = val;
  }
  return h;
}

function sincLowpass(rate, cutoffHz, numTaps) {
  const fn = rate / 2;
  const fc = cutoffHz / fn;
  if (fc <= 0 || fc >= 1) throw new Error("cutoff out of range");
  const att = 120;
  const trBw = 0.05 * 0.5;
  const beta = kaiserBeta(att, (trBw * 0.5) / fc);
  return makeLpf(numTaps | 1, fc, beta);
}

function q16(v) {
  const s = v * 32768;
  const r = s > 32767 ? 32767 : s < -32768 ? -32768 : Math.round(s);
  return r / 32768;
}

class BirdsongProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    const sr = sampleRate;
    this.sr = sr;
    this.tapCount = o.taps || 1024;
    this.fundLpHz = o.fundLpHz != null ? o.fundLpHz : 140;
    this.envLpHz = o.envLpHz != null ? o.envLpHz : 70;
    this.fmLpHz = o.fmLpHz != null ? o.fmLpHz : 70;
    this.fundTaps = sincLowpass(sr, this.fundLpHz, this.tapCount);
    const N = this.fundTaps.length;
    this.N = N;
    this.half = N >> 1;
    this.Nlow = Math.max(17, Math.round(N / DECIM) | 1);
    this.lowHalf = this.Nlow >> 1;
    this.envTaps = sincLowpass(sr / DECIM, this.envLpHz, this.Nlow);
    this.fmTaps = sincLowpass(sr / DECIM, this.fmLpHz, this.Nlow);
    this.hi = new Float32Array(2 * N);
    this.hq = new Float32Array(2 * N);
    this.amHist = new Float32Array(2 * this.Nlow);
    this.fmHist = new Float32Array(2 * this.Nlow);
    this.head = 0;
    this.lowHead = 0;
    this.decim = 0;
    this.amPrev = 0;
    this.amCur = 0;
    this.fmPrev = 0;
    this.fmCur = 0;
    this.fscaleBase = o.fscale != null ? o.fscale : 24000;
    this.gate = o.gate != null ? o.gate : 0;
    this.quantize = o.quantize !== false;
    this.autogain = !!o.autogain;
    this.shiftHz = o.shiftHz != null ? o.shiftHz : 220.5;
    this.wave = o.wave || "sine";
    this.harmCount = o.harmonics != null ? o.harmonics : 1;
    this.trillDepth = o.trillDepth != null ? o.trillDepth : 0;
    this.trillRate = o.trillRate != null ? o.trillRate : 14;
    this.buildAmps();
    this.resetState();
    this.port.onmessage = (e) => this.setParams(e.data);
  }

  // Build additive harmonic amplitudes for the selected waveform recipe.
  // The amplitudes are normalised so the sum stays near unity before the
  // envelope is applied (avoids clipping as harmonic count grows).
  buildAmps() {
    const n = Math.max(1, Math.min(12, Math.round(this.harmCount)));
    const amps = new Float64Array(n + 1);
    for (let k = 1; k <= n; k++) {
      let a = 0;
      switch (this.wave) {
        case "saw":
          a = 1 / k;
          break;
        case "square":
          a = k % 2 === 1 ? 1 / k : 0;
          break;
        case "triangle":
          a = k % 2 === 1 ? (k % 4 === 1 ? 1 : -1) / (k * k) : 0;
          break;
        default:
          a = k === 1 ? 1 : 0;
          break;
      }
      amps[k] = a;
    }
    let sum = 0;
    for (let k = 1; k <= n; k++) sum += Math.abs(amps[k]);
    this.ampNorm = sum > 0 ? 1 / sum : 1;
    this.amps = amps;
    this.maxHarm = n;
  }

  updateMixer(resetPhase) {
    const incDn = (-this.shiftHz / this.sr) * TWO_PI;
    const incUp = (this.shiftHz / this.sr) * TWO_PI;
    this.dDnI = Math.cos(incDn);
    this.dDnQ = Math.sin(incDn);
    this.dUpI = Math.cos(incUp * DECIM);
    this.dUpQ = Math.sin(incUp * DECIM);
    if (resetPhase) {
      this.pDnI = 1;
      this.pDnQ = 0;
      this.pUpI = 1;
      this.pUpQ = 0;
    }
  }

  resetState() {
    this.hi.fill(0);
    this.hq.fill(0);
    this.amHist.fill(0);
    this.fmHist.fill(0);
    this.head = 0;
    this.lowHead = 0;
    this.decim = 0;
    this.amPrev = 0;
    this.amCur = 0;
    this.fmPrev = 0;
    this.fmCur = 0;
    this.lastI = 0;
    this.lastQ = 0;
    this.phaseSynth = 0;
    this.trillPhase = 0;
    this.renorm = 0;
    this.agcEnv = 0;
    this.updateMixer(true);
  }

  setParams(p) {
    if (!p) return;
    if (p.type === "reset") {
      this.resetState();
      return;
    }
    if (p.fscale != null) this.fscaleBase = p.fscale;
    if (p.gate != null) this.gate = p.gate;
    if (p.quantize != null) this.quantize = !!p.quantize;
    if (p.autogain != null) this.autogain = !!p.autogain;
    if (p.trillDepth != null) this.trillDepth = p.trillDepth;
    if (p.trillRate != null) this.trillRate = p.trillRate;
    if (p.wave != null || p.harmonics != null) {
      if (p.wave != null) this.wave = p.wave;
      if (p.harmonics != null) this.harmCount = p.harmonics;
      this.buildAmps();
    }
    if (p.shiftHz != null && p.shiftHz !== this.shiftHz) {
      this.shiftHz = p.shiftHz;
      this.updateMixer(false);
    }
    if (p.fundLpHz != null && p.fundLpHz !== this.fundLpHz) {
      this.fundLpHz = p.fundLpHz;
      this.fundTaps = sincLowpass(this.sr, this.fundLpHz, this.tapCount);
    }
    if (p.envLpHz != null && p.envLpHz !== this.envLpHz) {
      this.envLpHz = p.envLpHz;
      this.envTaps = sincLowpass(
        this.sr / DECIM,
        this.envLpHz,
        this.Nlow,
      );
    }
    if (p.fmLpHz != null && p.fmLpHz !== this.fmLpHz) {
      this.fmLpHz = p.fmLpHz;
      this.fmTaps = sincLowpass(this.sr / DECIM, this.fmLpHz, this.Nlow);
    }
  }

  fscale() {
    return (this.fscaleBase * this.sr) / 44100;
  }

  process(inputs, outputs) {
    const out = outputs[0][0];
    const inp = inputs[0];
    if (!inp || inp.length === 0 || !inp[0]) {
      out.fill(0);
      return true;
    }
    const L = inp[0];
    const R = inp.length > 1 && inp[1] ? inp[1] : inp[0];
    const N = this.N;
    const half = this.half;
    const Nlow = this.Nlow;
    const lowHalf = this.lowHalf;
    const hi = this.hi;
    const hq = this.hq;
    const ah = this.amHist;
    const fh = this.fmHist;
    const ft = this.fundTaps;
    const et = this.envTaps;
    const fmt = this.fmTaps;
    const useQ = this.quantize;
    const gate = this.gate;
    const autogain = this.autogain;
    const amps = this.amps;
    const maxHarm = this.maxHarm;
    const ampNorm = this.ampNorm;
    const fsc = this.fscale();
    const sr = this.sr;
    const trillAmt = this.trillDepth * TRILL_MAX;
    const trillInc = (TWO_PI * this.trillRate) / sr;

    for (let s = 0; s < out.length; s++) {
      const x = 0.5 * (L[s] + R[s]);

      const cI = this.pDnI;
      const cQ = this.pDnQ;
      const xdI = cI * x - cQ * x;
      const xdQ = cQ * x + cI * x;
      let t = cI * this.dDnI - cQ * this.dDnQ;
      let u = cI * this.dDnQ + cQ * this.dDnI;
      this.pDnI = t;
      this.pDnQ = u;

      const head = this.head;
      const tail = head + N;
      hi[head] = xdI;
      hi[tail] = xdI;
      hq[head] = xdQ;
      hq[tail] = xdQ;

      if (this.decim === 0) {
        // The demodulated signal is band-limited to ~140 Hz, so the full
        // 140 Hz filter and the 70 Hz smoothers only need to run once per
        // DECIM samples. The result is linearly interpolated between updates.
        let yi = 0;
        let yq = 0;
        let a = tail;
        let b = tail - N + 1;
        for (let k = 0; k < half; k++) {
          const h = ft[k];
          yi += h * (hi[a] + hi[b]);
          yq += h * (hq[a] + hq[b]);
          a--;
          b++;
        }
        if (N & 1) {
          const c = tail - half;
          yi += ft[half] * hi[c];
          yq += ft[half] * hq[c];
        }
        if (useQ) {
          yi = q16(yi);
          yq = q16(yq);
        }

        const am = Math.sqrt(yi * yi + yq * yq);
        const lh = this.lowHead;
        const lt = lh + Nlow;
        ah[lh] = am;
        ah[lt] = am;
        let amNext = 0;
        a = lt;
        b = lt - Nlow + 1;
        for (let k = 0; k < lowHalf; k++) {
          amNext += et[k] * (ah[a] + ah[b]);
          a--;
          b++;
        }
        if (Nlow & 1) amNext += et[lowHalf] * ah[lt - lowHalf];
        if (useQ) amNext = q16(amNext);

        const uI = this.pUpI;
        const uQ = this.pUpQ;
        const yuI = uI * yi - uQ * yq;
        const yuQ = uQ * yi + uI * yq;
        t = uI * this.dUpI - uQ * this.dUpQ;
        u = uI * this.dUpQ + uQ * this.dUpI;
        this.pUpI = t;
        this.pUpQ = u;

        const num = yuI * (yuQ - this.lastQ) - yuQ * (yuI - this.lastI);
        const den = yuI * yuI + yuQ * yuQ;
        let fm = den !== 0 ? (FMDEMOD_QUADRI_K * num) / den : 0;
        fm /= DECIM;
        this.lastI = yuI;
        this.lastQ = yuQ;
        if (useQ) fm = q16(fm);
        fh[lh] = fm;
        fh[lt] = fm;
        let fmNext = 0;
        a = lt;
        b = lt - Nlow + 1;
        for (let k = 0; k < lowHalf; k++) {
          fmNext += fmt[k] * (fh[a] + fh[b]);
          a--;
          b++;
        }
        if (Nlow & 1) fmNext += fmt[lowHalf] * fh[lt - lowHalf];
        if (useQ) fmNext = q16(fmNext);

        this.lowHead = (lh + 1) % Nlow;
        this.amPrev = this.amCur;
        this.amCur = amNext;
        this.fmPrev = this.fmCur;
        this.fmCur = fmNext;
      }

      const phase = (this.decim + 1) / DECIM;
      const amF = this.amPrev + (this.amCur - this.amPrev) * phase;
      const fmF = this.fmPrev + (this.fmCur - this.fmPrev) * phase;

      let trill = 1;
      if (trillAmt > 0) {
        trill += trillAmt * Math.sin(this.trillPhase);
        this.trillPhase += trillInc;
        if (this.trillPhase >= TWO_PI) this.trillPhase -= TWO_PI;
      }

      this.phaseSynth += ((fmF * TWO_PI) / sr) * fsc * trill;
      while (this.phaseSynth >= TWO_PI) this.phaseSynth -= TWO_PI;
      while (this.phaseSynth < 0) this.phaseSynth += TWO_PI;
      const base = this.phaseSynth * BASE_HARMONIC;

      // Band-limit the additive harmonics to the Nyquist range for the
      // instantaneous output pitch, so high registers don't alias badly.
      // The oscillator fundamental is BASE_HARMONIC times the demodulated
      // pitch, so the limit has to use that frequency, not the demod output.
      let maxH = maxHarm;
      if (fmF !== 0) {
        const f0 = Math.abs(fmF * fsc) * BASE_HARMONIC;
        if (f0 > 1) {
          const lim = Math.floor((0.45 * sr) / f0);
          if (lim < maxH) maxH = lim;
          if (maxH < 1) maxH = 1;
        }
      }
      let w;
      if (maxH === 1) {
        w = Math.sin(base) * amps[1];
      } else {
        // Build sin(k*base) by rotating (sin base, cos base) instead of
        // calling Math.sin once per harmonic.
        const s1 = Math.sin(base);
        const c1 = Math.cos(base);
        let s = s1;
        let c = c1;
        w = 0;
        for (let k = 1; k <= maxH; k++) {
          const a = amps[k];
          if (a) w += a * s;
          const next = s * c1 + c * s1;
          c = c * c1 - s * s1;
          s = next;
        }
      }
      w *= ampNorm;

      let o = w * amF;
      if (gate > 0) o *= amF / (amF + gate);
      if (autogain) {
        this.agcEnv += (amF - this.agcEnv) * 0.00004;
        let ag = 0.15 / Math.max(this.agcEnv, 1e-4);
        if (ag > 4) ag = 4;
        else if (ag < 0.2) ag = 0.2;
        o *= ag;
      }
      if (o > 1) o = 1;
      else if (o < -1) o = -1;
      out[s] = o;

      this.head = (head + 1) % N;
      this.decim = (this.decim + 1) % DECIM;
      if ((this.renorm++ & 4095) === 0) {
        const nd = Math.hypot(this.pDnI, this.pDnQ) || 1;
        this.pDnI /= nd;
        this.pDnQ /= nd;
        const nu = Math.hypot(this.pUpI, this.pUpQ) || 1;
        this.pUpI /= nu;
        this.pUpQ /= nu;
      }
    }

    return true;
  }
}

registerProcessor("birdsong-processor", BirdsongProcessor);