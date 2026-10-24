// AudioWorklet wrapper for the Rust/WASM DSP core. The wasm module is compiled
// once on the main thread and passed in processorOptions, so no network access
// is needed inside the worklet.
const WAVE_INDEX = { sine: 0, saw: 1, square: 2, triangle: 3 };

class BirdsongWasmProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    if (!(o.wasmModule instanceof WebAssembly.Module)) {
      throw new Error("missing wasm module");
    }
    const instance = new WebAssembly.Instance(o.wasmModule, {});
    this.w = instance.exports;
    this.handle = this.w.create(sampleRate);
    this.setParams(o);
    this.port.onmessage = (e) => this.setParams(e.data);
  }

  setParams(p) {
    if (!p || !this.handle) return;
    const w = this.w;
    const h = this.handle;
    if (p.type === "reset") {
      w.reset(h);
      return;
    }
    if (p.type === "dispose") {
      w.destroy(h);
      this.handle = 0;
      return;
    }
    if (p.fscale != null) w.set_fscale(h, p.fscale);
    if (p.gate != null) w.set_gate(h, p.gate);
    if (p.quantize != null) w.set_quantize(h, p.quantize ? 1 : 0);
    if (p.autogain != null) w.set_autogain(h, p.autogain ? 1 : 0);
    if (p.shiftHz != null) w.set_shift(h, p.shiftHz);
    if (p.trillDepth != null) w.set_trill_depth(h, p.trillDepth);
    if (p.trillRate != null) w.set_trill_rate(h, p.trillRate);
    if (p.fundLpHz != null) w.set_fund_lp(h, p.fundLpHz);
    if (p.envLpHz != null) w.set_env_lp(h, p.envLpHz);
    if (p.fmLpHz != null) w.set_fm_lp(h, p.fmLpHz);
    if (p.wave != null) w.set_wave(h, WAVE_INDEX[p.wave] ?? 0);
    if (p.harmonics != null) w.set_harmonics(h, p.harmonics);
  }

  process(inputs, outputs) {
    const out = outputs[0][0];
    const inp = inputs[0];
    if (!inp || inp.length === 0 || !inp[0]) {
      out.fill(0);
      return true;
    }
    if (!this.handle) {
      out.fill(0);
      return true;
    }
    const frames = Math.min(out.length, 256);
    const L = inp[0];
    const R = inp.length > 1 && inp[1] ? inp[1] : inp[0];
    const w = this.w;
    const h = this.handle;
    const mem = w.memory.buffer;
    let v = this.views;
    if (!v || v.buf !== mem || v.frames !== frames) {
      v = this.views = {
        buf: mem,
        frames,
        inL: new Float32Array(mem, w.in_l_ptr(h), frames),
        inR: new Float32Array(mem, w.in_r_ptr(h), frames),
        out: new Float32Array(mem, w.out_ptr(h), frames),
      };
    }
    v.inL.set(L.length === frames ? L : L.subarray(0, frames));
    v.inR.set(R.length === frames ? R : R.subarray(0, frames));
    w.process(h, frames);
    out.set(v.out);
    if (frames < out.length) out.fill(0, frames);
    return true;
  }
}

registerProcessor("birdsong-processor-wasm", BirdsongWasmProcessor);
