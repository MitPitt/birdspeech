use std::f64::consts::PI;

const TWO_PI: f64 = 2.0 * PI;
const BASE_HARMONIC: f64 = 6.0;
const TRILL_MAX: f64 = 0.16;
const DECIM: usize = 8;
const FMDEMOD_QUADRI_K: f64 = 0.340447550238101026565118445432744920253753662109375;
const MAX_FRAMES: usize = 256;

const KAISER_COEFS: [[f64; 4]; 10] = [
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

fn clamp_int(x: i64, lo: i64, hi: i64) -> usize {
    x.clamp(lo, hi) as usize
}

fn bessel_i0(x: f64) -> f64 {
    let mut term = 1.0;
    let mut sum = 1.0;
    let x2 = x / 2.0;
    let mut i = 1.0;
    loop {
        let y = x2 / i;
        i += 1.0;
        term *= y * y;
        let last = sum;
        sum += term;
        if sum == last {
            return sum;
        }
    }
}

fn kaiser_beta(att: f64, tr_bw: f64) -> f64 {
    if att >= 60.0 {
        let realm = (tr_bw / 0.0005).ln() / 2.0f64.ln();
        let ir = realm.trunc() as i64;
        let c0 = KAISER_COEFS[clamp_int(ir, 0, (KAISER_COEFS.len() - 1) as i64)];
        let c1 = KAISER_COEFS[clamp_int(1 + ir, 0, (KAISER_COEFS.len() - 1) as i64)];
        let b0 = ((c0[0] * att + c0[1]) * att + c0[2]) * att + c0[3];
        let b1 = ((c1[0] * att + c1[1]) * att + c1[2]) * att + c1[3];
        return b0 + (b1 - b0) * (realm - ir as f64);
    }
    if att > 50.0 {
        return 0.1102 * (att - 8.7);
    }
    if att > 20.96 {
        return 0.58417 * (att - 20.96).powf(0.4) + 0.07886 * (att - 20.96);
    }
    0.0
}

fn make_lpf(num_taps: usize, fc: f64, beta: f64) -> Vec<f64> {
    let m = (num_taps - 1) as f64;
    let mut h = vec![0.0; num_taps];
    let mult = 1.0 / bessel_i0(beta);
    let mult1 = 1.0 / (0.5 * m);
    let mut i = 0usize;
    while i as f64 <= m / 2.0 {
        let z = i as f64 - 0.5 * m;
        let x = z * PI;
        let y = z * mult1;
        let mut val = if x != 0.0 { (fc * x).sin() / x } else { fc };
        val *= bessel_i0(beta * (1.0 - y * y).max(0.0).sqrt()) * mult;
        h[i] = val;
        let mirror = (m as usize) - i;
        if mirror != i {
            h[mirror] = val;
        }
        i += 1;
    }
    h
}

fn sinc_lowpass(rate: f64, cutoff_hz: f64, num_taps: usize) -> Vec<f64> {
    let fn_ = rate / 2.0;
    let fc = (cutoff_hz / fn_).clamp(1e-9, 0.999999);
    let att = 120.0;
    let tr_bw = 0.05 * 0.5;
    let beta = kaiser_beta(att, (tr_bw * 0.5) / fc);
    make_lpf(num_taps | 1, fc, beta)
}

fn q16(v: f64) -> f64 {
    let s = v * 32768.0;
    let r = if s > 32767.0 {
        32767.0
    } else if s < -32768.0 {
        -32768.0
    } else {
        s.round()
    };
    r / 32768.0
}

pub struct Processor {
    sr: f64,
    tap_count: usize,
    fund_lp_hz: f64,
    env_lp_hz: f64,
    fm_lp_hz: f64,
    fund_taps: Vec<f64>,
    env_taps: Vec<f64>,
    fm_taps: Vec<f64>,
    n: usize,
    half: usize,
    n_low: usize,
    low_half: usize,
    hi: Vec<f32>,
    hq: Vec<f32>,
    am_hist: Vec<f32>,
    fm_hist: Vec<f32>,
    head: usize,
    low_head: usize,
    decim: usize,
    am_prev: f64,
    am_cur: f64,
    fm_prev: f64,
    fm_cur: f64,
    fscale_base: f64,
    gate: f64,
    quantize: bool,
    autogain: bool,
    shift_hz: f64,
    wave: u32,
    harm_count: i32,
    trill_depth: f64,
    trill_rate: f64,
    amps: Vec<f64>,
    amp_norm: f64,
    max_harm: usize,
    d_dn_i: f64,
    d_dn_q: f64,
    d_up_i: f64,
    d_up_q: f64,
    p_dn_i: f64,
    p_dn_q: f64,
    p_up_i: f64,
    p_up_q: f64,
    last_i: f64,
    last_q: f64,
    phase_synth: f64,
    trill_phase: f64,
    renorm: u32,
    agc_env: f64,
    in_l: [f32; MAX_FRAMES],
    in_r: [f32; MAX_FRAMES],
    out: [f32; MAX_FRAMES],
}

impl Processor {
    fn new(sr: f64) -> Self {
        let tap_count = 1024usize;
        let fund_lp_hz = 140.0;
        let env_lp_hz = 70.0;
        let fm_lp_hz = 70.0;
        let fund_taps = sinc_lowpass(sr, fund_lp_hz, tap_count);
        let n = fund_taps.len();
        let n_low = ((n as f64 / DECIM as f64).round() as usize).max(17) | 1;
        let env_taps = sinc_lowpass(sr / DECIM as f64, env_lp_hz, n_low);
        let fm_taps = sinc_lowpass(sr / DECIM as f64, fm_lp_hz, n_low);

        let mut p = Self {
            sr,
            tap_count,
            fund_lp_hz,
            env_lp_hz,
            fm_lp_hz,
            fund_taps,
            env_taps,
            fm_taps,
            n,
            half: n >> 1,
            n_low,
            low_half: n_low >> 1,
            hi: vec![0.0; 2 * n],
            hq: vec![0.0; 2 * n],
            am_hist: vec![0.0; 2 * n_low],
            fm_hist: vec![0.0; 2 * n_low],
            head: 0,
            low_head: 0,
            decim: 0,
            am_prev: 0.0,
            am_cur: 0.0,
            fm_prev: 0.0,
            fm_cur: 0.0,
            fscale_base: 24000.0,
            gate: 0.0,
            quantize: true,
            autogain: false,
            shift_hz: 220.5,
            wave: 0,
            harm_count: 1,
            trill_depth: 0.0,
            trill_rate: 14.0,
            amps: Vec::new(),
            amp_norm: 1.0,
            max_harm: 1,
            d_dn_i: 1.0,
            d_dn_q: 0.0,
            d_up_i: 1.0,
            d_up_q: 0.0,
            p_dn_i: 1.0,
            p_dn_q: 0.0,
            p_up_i: 1.0,
            p_up_q: 0.0,
            last_i: 0.0,
            last_q: 0.0,
            phase_synth: 0.0,
            trill_phase: 0.0,
            renorm: 0,
            agc_env: 0.0,
            in_l: [0.0; MAX_FRAMES],
            in_r: [0.0; MAX_FRAMES],
            out: [0.0; MAX_FRAMES],
        };
        p.build_amps();
        p.reset_state();
        p
    }

    fn reset_state(&mut self) {
        self.hi.fill(0.0);
        self.hq.fill(0.0);
        self.am_hist.fill(0.0);
        self.fm_hist.fill(0.0);
        self.head = 0;
        self.low_head = 0;
        self.decim = 0;
        self.am_prev = 0.0;
        self.am_cur = 0.0;
        self.fm_prev = 0.0;
        self.fm_cur = 0.0;
        self.last_i = 0.0;
        self.last_q = 0.0;
        self.phase_synth = 0.0;
        self.trill_phase = 0.0;
        self.renorm = 0;
        self.agc_env = 0.0;
        self.update_mixer(true);
    }

    fn build_amps(&mut self) {
        let n = self.harm_count.clamp(1, 12) as usize;
        let mut amps = vec![0.0; n + 1];
        for k in 1..=n {
            amps[k] = match self.wave {
                1 => 1.0 / k as f64,
                2 => {
                    if k % 2 == 1 {
                        1.0 / k as f64
                    } else {
                        0.0
                    }
                }
                3 => {
                    if k % 2 == 1 {
                        let sign = if k % 4 == 1 { 1.0 } else { -1.0 };
                        sign / ((k * k) as f64)
                    } else {
                        0.0
                    }
                }
                _ => {
                    if k == 1 {
                        1.0
                    } else {
                        0.0
                    }
                }
            };
        }
        let mut sum = 0.0;
        for k in 1..=n {
            sum += amps[k].abs();
        }
        self.amp_norm = if sum > 0.0 { 1.0 / sum } else { 1.0 };
        self.amps = amps;
        self.max_harm = n;
    }

    fn update_mixer(&mut self, reset_phase: bool) {
        let inc_dn = (-self.shift_hz / self.sr) * TWO_PI;
        let inc_up = (self.shift_hz / self.sr) * TWO_PI;
        self.d_dn_i = inc_dn.cos();
        self.d_dn_q = inc_dn.sin();
        self.d_up_i = (inc_up * DECIM as f64).cos();
        self.d_up_q = (inc_up * DECIM as f64).sin();
        if reset_phase {
            self.p_dn_i = 1.0;
            self.p_dn_q = 0.0;
            self.p_up_i = 1.0;
            self.p_up_q = 0.0;
        }
    }

    fn fscale(&self) -> f64 {
        (self.fscale_base * self.sr) / 44100.0
    }

    fn set_fund_lp(&mut self, hz: f64) {
        if hz != self.fund_lp_hz {
            self.fund_lp_hz = hz;
            self.fund_taps = sinc_lowpass(self.sr, hz, self.tap_count);
        }
    }

    fn set_env_lp(&mut self, hz: f64) {
        if hz != self.env_lp_hz {
            self.env_lp_hz = hz;
            self.env_taps = sinc_lowpass(self.sr / DECIM as f64, hz, self.n_low);
        }
    }

    fn set_fm_lp(&mut self, hz: f64) {
        if hz != self.fm_lp_hz {
            self.fm_lp_hz = hz;
            self.fm_taps = sinc_lowpass(self.sr / DECIM as f64, hz, self.n_low);
        }
    }

    fn set_wave(&mut self, wave: u32) {
        if wave != self.wave {
            self.wave = wave;
            self.build_amps();
        }
    }

    fn set_harmonics(&mut self, harmonics: i32) {
        if harmonics != self.harm_count {
            self.harm_count = harmonics;
            self.build_amps();
        }
    }

    fn process(&mut self, frames: usize) {
        let frames = frames.min(MAX_FRAMES);
        let n = self.n;
        let half = self.half;
        let n_low = self.n_low;
        let low_half = self.low_half;
        let sr = self.sr;
        let fsc = self.fscale();
        let use_q = self.quantize;
        let gate = self.gate;
        let autogain = self.autogain;
        let max_harm = self.max_harm;
        let amp_norm = self.amp_norm;
        let trill_amt = self.trill_depth * TRILL_MAX;
        let trill_inc = (TWO_PI * self.trill_rate) / sr;

        let hi = &mut self.hi;
        let hq = &mut self.hq;
        let ah = &mut self.am_hist;
        let fh = &mut self.fm_hist;
        let ft = &self.fund_taps;
        let et = &self.env_taps;
        let fmt = &self.fm_taps;
        let amps = &self.amps;

        for s in 0..frames {
            let x = 0.5 * (self.in_l[s] as f64 + self.in_r[s] as f64);

            let c_i = self.p_dn_i;
            let c_q = self.p_dn_q;
            let xd_i = c_i * x - c_q * x;
            let xd_q = c_q * x + c_i * x;
            let mut t = c_i * self.d_dn_i - c_q * self.d_dn_q;
            let mut u = c_i * self.d_dn_q + c_q * self.d_dn_i;
            self.p_dn_i = t;
            self.p_dn_q = u;

            let head = self.head;
            let tail = head + n;
            hi[head] = xd_i as f32;
            hi[tail] = xd_i as f32;
            hq[head] = xd_q as f32;
            hq[tail] = xd_q as f32;

            if self.decim == 0 {
                let mut yi = 0.0;
                let mut yq = 0.0;
                let mut a = tail;
                let mut b = tail - n + 1;
                for k in 0..half {
                    let h = ft[k];
                    yi += h * (hi[a] as f64 + hi[b] as f64);
                    yq += h * (hq[a] as f64 + hq[b] as f64);
                    a -= 1;
                    b += 1;
                }
                if n & 1 == 1 {
                    let c = tail - half;
                    yi += ft[half] * hi[c] as f64;
                    yq += ft[half] * hq[c] as f64;
                }
                if use_q {
                    yi = q16(yi);
                    yq = q16(yq);
                }

                let am = (yi * yi + yq * yq).sqrt();
                let lh = self.low_head;
                let lt = lh + n_low;
                ah[lh] = am as f32;
                ah[lt] = am as f32;
                let mut am_next = 0.0;
                a = lt;
                b = lt - n_low + 1;
                for k in 0..low_half {
                    am_next += et[k] * (ah[a] as f64 + ah[b] as f64);
                    a -= 1;
                    b += 1;
                }
                if n_low & 1 == 1 {
                    am_next += et[low_half] * ah[lt - low_half] as f64;
                }
                if use_q {
                    am_next = q16(am_next);
                }

                let u_i = self.p_up_i;
                let u_q = self.p_up_q;
                let yu_i = u_i * yi - u_q * yq;
                let yu_q = u_q * yi + u_i * yq;
                t = u_i * self.d_up_i - u_q * self.d_up_q;
                u = u_i * self.d_up_q + u_q * self.d_up_i;
                self.p_up_i = t;
                self.p_up_q = u;

                let num = yu_i * (yu_q - self.last_q) - yu_q * (yu_i - self.last_i);
                let den = yu_i * yu_i + yu_q * yu_q;
                let mut fm = if den != 0.0 {
                    (FMDEMOD_QUADRI_K * num) / den
                } else {
                    0.0
                };
                fm /= DECIM as f64;
                self.last_i = yu_i;
                self.last_q = yu_q;
                if use_q {
                    fm = q16(fm);
                }
                fh[lh] = fm as f32;
                fh[lt] = fm as f32;
                let mut fm_next = 0.0;
                a = lt;
                b = lt - n_low + 1;
                for k in 0..low_half {
                    fm_next += fmt[k] * (fh[a] as f64 + fh[b] as f64);
                    a -= 1;
                    b += 1;
                }
                if n_low & 1 == 1 {
                    fm_next += fmt[low_half] * fh[lt - low_half] as f64;
                }
                if use_q {
                    fm_next = q16(fm_next);
                }

                self.low_head = (lh + 1) % n_low;
                self.am_prev = self.am_cur;
                self.am_cur = am_next;
                self.fm_prev = self.fm_cur;
                self.fm_cur = fm_next;
            }

            let phase = (self.decim + 1) as f64 / DECIM as f64;
            let am_f = self.am_prev + (self.am_cur - self.am_prev) * phase;
            let fm_f = self.fm_prev + (self.fm_cur - self.fm_prev) * phase;

            let mut trill = 1.0;
            if trill_amt > 0.0 {
                trill += trill_amt * self.trill_phase.sin();
                self.trill_phase += trill_inc;
                if self.trill_phase >= TWO_PI {
                    self.trill_phase -= TWO_PI;
                }
            }

            self.phase_synth += ((fm_f * TWO_PI) / sr) * fsc * trill;
            while self.phase_synth >= TWO_PI {
                self.phase_synth -= TWO_PI;
            }
            while self.phase_synth < 0.0 {
                self.phase_synth += TWO_PI;
            }
            let base = self.phase_synth * BASE_HARMONIC;

            let mut max_h = max_harm;
            if fm_f != 0.0 {
                let f0 = (fm_f * fsc).abs() * BASE_HARMONIC;
                if f0 > 1.0 {
                    let lim = ((0.45 * sr) / f0).floor() as i64;
                    if lim < max_h as i64 {
                        max_h = lim.max(1) as usize;
                    }
                }
            }

            let mut w;
            if max_h == 1 {
                w = base.sin() * amps[1];
            } else {
                let s1 = base.sin();
                let c1 = base.cos();
                let mut sv = s1;
                let mut cv = c1;
                w = 0.0;
                for k in 1..=max_h {
                    let amp = amps[k];
                    if amp != 0.0 {
                        w += amp * sv;
                    }
                    let next = sv * c1 + cv * s1;
                    cv = cv * c1 - sv * s1;
                    sv = next;
                }
            }
            w *= amp_norm;

            let mut o = w * am_f;
            if gate > 0.0 {
                o *= am_f / (am_f + gate);
            }
            if autogain {
                self.agc_env += (am_f - self.agc_env) * 0.00004;
                let mut ag = 0.15 / self.agc_env.max(1e-4);
                if ag > 4.0 {
                    ag = 4.0;
                } else if ag < 0.2 {
                    ag = 0.2;
                }
                o *= ag;
            }
            if o > 1.0 {
                o = 1.0;
            } else if o < -1.0 {
                o = -1.0;
            }
            self.out[s] = o as f32;

            self.head = (head + 1) % n;
            self.decim = (self.decim + 1) % DECIM;
            if (self.renorm & 4095) == 0 {
                let nd = (self.p_dn_i * self.p_dn_i + self.p_dn_q * self.p_dn_q)
                    .sqrt()
                    .max(1e-30);
                self.p_dn_i /= nd;
                self.p_dn_q /= nd;
                let nu = (self.p_up_i * self.p_up_i + self.p_up_q * self.p_up_q)
                    .sqrt()
                    .max(1e-30);
                self.p_up_i /= nu;
                self.p_up_q /= nu;
            }
            self.renorm = self.renorm.wrapping_add(1);
        }
    }
}

#[no_mangle]
pub extern "C" fn create(sr: f64) -> *mut Processor {
    Box::into_raw(Box::new(Processor::new(sr)))
}

#[no_mangle]
pub unsafe extern "C" fn destroy(p: *mut Processor) {
    if !p.is_null() {
        drop(Box::from_raw(p));
    }
}

#[no_mangle]
pub unsafe extern "C" fn process(p: *mut Processor, frames: u32) {
    if let Some(proc_) = p.as_mut() {
        proc_.process(frames as usize);
    }
}

#[no_mangle]
pub unsafe extern "C" fn reset(p: *mut Processor) {
    if let Some(proc_) = p.as_mut() {
        proc_.reset_state();
    }
}

#[no_mangle]
pub unsafe extern "C" fn set_fscale(p: *mut Processor, v: f64) {
    if let Some(proc_) = p.as_mut() {
        proc_.fscale_base = v;
    }
}

#[no_mangle]
pub unsafe extern "C" fn set_gate(p: *mut Processor, v: f64) {
    if let Some(proc_) = p.as_mut() {
        proc_.gate = v;
    }
}

#[no_mangle]
pub unsafe extern "C" fn set_quantize(p: *mut Processor, v: i32) {
    if let Some(proc_) = p.as_mut() {
        proc_.quantize = v != 0;
    }
}

#[no_mangle]
pub unsafe extern "C" fn set_autogain(p: *mut Processor, v: i32) {
    if let Some(proc_) = p.as_mut() {
        proc_.autogain = v != 0;
    }
}

#[no_mangle]
pub unsafe extern "C" fn set_shift(p: *mut Processor, v: f64) {
    if let Some(proc_) = p.as_mut() {
        if v != proc_.shift_hz {
            proc_.shift_hz = v;
            proc_.update_mixer(false);
        }
    }
}

#[no_mangle]
pub unsafe extern "C" fn set_trill_depth(p: *mut Processor, v: f64) {
    if let Some(proc_) = p.as_mut() {
        proc_.trill_depth = v;
    }
}

#[no_mangle]
pub unsafe extern "C" fn set_trill_rate(p: *mut Processor, v: f64) {
    if let Some(proc_) = p.as_mut() {
        proc_.trill_rate = v;
    }
}

#[no_mangle]
pub unsafe extern "C" fn set_fund_lp(p: *mut Processor, v: f64) {
    if let Some(proc_) = p.as_mut() {
        proc_.set_fund_lp(v);
    }
}

#[no_mangle]
pub unsafe extern "C" fn set_env_lp(p: *mut Processor, v: f64) {
    if let Some(proc_) = p.as_mut() {
        proc_.set_env_lp(v);
    }
}

#[no_mangle]
pub unsafe extern "C" fn set_fm_lp(p: *mut Processor, v: f64) {
    if let Some(proc_) = p.as_mut() {
        proc_.set_fm_lp(v);
    }
}

#[no_mangle]
pub unsafe extern "C" fn set_wave(p: *mut Processor, v: u32) {
    if let Some(proc_) = p.as_mut() {
        proc_.set_wave(v);
    }
}

#[no_mangle]
pub unsafe extern "C" fn set_harmonics(p: *mut Processor, v: i32) {
    if let Some(proc_) = p.as_mut() {
        proc_.set_harmonics(v);
    }
}

#[no_mangle]
pub unsafe extern "C" fn in_l_ptr(p: *mut Processor) -> *mut f32 {
    match p.as_mut() {
        Some(proc_) => proc_.in_l.as_mut_ptr(),
        None => std::ptr::null_mut(),
    }
}

#[no_mangle]
pub unsafe extern "C" fn in_r_ptr(p: *mut Processor) -> *mut f32 {
    match p.as_mut() {
        Some(proc_) => proc_.in_r.as_mut_ptr(),
        None => std::ptr::null_mut(),
    }
}

#[no_mangle]
pub unsafe extern "C" fn out_ptr(p: *mut Processor) -> *mut f32 {
    match p.as_mut() {
        Some(proc_) => proc_.out.as_mut_ptr(),
        None => std::ptr::null_mut(),
    }
}

