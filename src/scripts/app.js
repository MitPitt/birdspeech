// @ts-nocheck
import { Mp3Encoder } from "@breezystack/lamejs";

const BASE = import.meta.env.BASE_URL || "/";
const $ = (id) => document.getElementById(id);

const state = {
	drywet: 100,
	reverb: 15,
	volume: 80,
	pitch: 24000,
	timbre: 1,
	wave: "sine",
	shift: 220,
	rough: 140,
	gate: 0,
	env: 70,
	pitchResp: 70,
	trill: 0,
	trillRate: 14,
	grit: true,
	autogain: true,
};

let selectedPreset = null;

// Output Hz per (input Hz × pitch value). This folds in the
// resynthesis harmonic, FM constant, sample rate and filter gain.
const VOICE_TO_BIRD = 2.4853e-4;
const BIRD_TARGET_HZ = 2600;

const EQ_MIN_HZ = 20;
const EQ_MAX_HZ = 20000;
const EQ_BINS = 128;
const EQ_FREQS = Array.from(
	{ length: EQ_BINS },
	(_, i) =>
		EQ_MIN_HZ *
		Math.pow(EQ_MAX_HZ / EQ_MIN_HZ, i / (EQ_BINS - 1)),
);
const eqGains = new Array(EQ_BINS).fill(0);
let eqOn = true;
let eqFilters = null;

const CQT_AXIS_NUDGE = 0.03;
const CQT_AXIS = new Image();
CQT_AXIS.addEventListener("load", () => {
	drawCqtIdle();
	drawViz(false);
});
CQT_AXIS.src = `${BASE}showcqt-axis.png`;

function makeCqtSurface(id) {
	return {
		canvas: $(id),
		engine: null,
		ctx: null,
		imageData: null,
		history: null,
		historyCtx: null,
		rowData: null,
		width: 0,
		axisY: 0,
		axisH: 0,
		histTop: 0,
		histH: 0,
		initW: 0,
		initH: 0,
		sampleRate: 0,
		paintKey: "",
	};
}

const cqtOutSurface = makeCqtSurface("cqt");
const cqtInSurface = makeCqtSurface("viz");

let cqtOut = null;
let cqtIn = null;
let cqtPromise = null;
let vizBase = null;

let ctx = null;
let media = null;
let mediaSource = null;
let workletNode = null;
let dryGain = null;
let wetGain = null;
let reverbNode = null;
let reverbGain = null;
let mixBus = null;
let masterGain = null;
let analyser = null;
let visLeft = null;
let visRight = null;
let visSplitter = null;
let exportBuffer = null;
let renderedBuffer = null;
let fallbackDuration = 0;
let wavePeaks = null;
let transportWaveData = null;
let fileEpoch = 0;
let exportDirty = false;
let currentURL = null;
let loaded = false;
let playing = false;
let scrubbing = false;
let rafId = 0;
let recorder = null;
let recordStream = null;
let micSource = null;
let recordVisualsAttached = false;
let recordChunks = [];
let recording = false;
let recordStarting = false;
let recordDiscard = false;

const playBtn = $("play");
const recordBtn = $("record");
const makeWavBtn = $("makewav");
const makeMp3Btn = $("makemp3");
const progress = $("progress");
const curTimeEl = $("curtime");
const durTimeEl = $("durtime");

function notify(msg, isError) {
	if (!msg) return;
	if (isError) console.error(msg);
	else console.info(msg);
}

const exporters = {
	wav: {
		btn: makeWavBtn,
		blob: null,
		busy: false,
		ready: false,
		mime: "audio/wav",
		ext: "wav",
	},
	mp3: {
		btn: makeMp3Btn,
		blob: null,
		busy: false,
		ready: false,
		mime: "audio/mpeg",
		ext: "mp3",
	},
};

function makeImpulseResponse(seconds, decay) {
	const rate = ctx.sampleRate;
	const len = Math.max(1, Math.floor(rate * seconds));
	const ir = ctx.createBuffer(2, len, rate);
	for (let ch = 0; ch < 2; ch++) {
		const d = ir.getChannelData(ch);
		for (let i = 0; i < len; i++) {
			d[i] =
				(Math.random() * 2 - 1) *
				Math.pow(1 - i / len, decay);
		}
	}
	return ir;
}

function buildEqChain(ac) {
	const filters = EQ_FREQS.map((f, i) => {
		const b = ac.createBiquadFilter();
		b.type = "peaking";
		b.frequency.value = f;
		b.Q.value = EQ_Q;
		b.gain.value = eqOn ? eqGains[i] : 0;
		return b;
	});
	for (let i = 0; i < filters.length - 1; i++)
		filters[i].connect(filters[i + 1]);
	return {
		input: filters[0],
		output: filters[filters.length - 1],
		filters,
	};
}

function applyEq() {
	clearPresetSelection();
	if (!eqFilters) return;
	eqFilters.forEach((f, i) => {
		f.gain.value = eqOn ? eqGains[i] : 0;
	});
}

function fmtHz(f) {
	if (f >= 1000) {
		const k = f / 1000;
		return `${Number.isInteger(k) ? k : k.toFixed(1)}k`;
	}
	return String(Number(f.toFixed(3)));
}

const EQ_MAX_DB = 12;
const EQ_PAD = { l: 0, r: 0, t: 0, b: 0 };
const EQ_OCT = Math.log2(EQ_MAX_HZ / EQ_MIN_HZ) / (EQ_BINS - 1);
const EQ_Q = 1 / (EQ_OCT * Math.LN2);
let eqHover = -1;
let eqDragging = false;
let eqLast = -1;

function eqFreqX(plotW, f) {
	return (
		EQ_PAD.l +
		(Math.log(f / EQ_MIN_HZ) /
			Math.log(EQ_MAX_HZ / EQ_MIN_HZ)) *
		plotW
	);
}

function eqDbY(plotH, g) {
	return EQ_PAD.t + ((EQ_MAX_DB - g) / (2 * EQ_MAX_DB)) * plotH;
}

function eqGainFromY(plotH, y) {
	const g = EQ_MAX_DB - ((y - EQ_PAD.t) / plotH) * 2 * EQ_MAX_DB;
	return Math.max(
		-EQ_MAX_DB,
		Math.min(EQ_MAX_DB, Math.round(g * 10) / 10),
	);
}

function drawEqOverlay(g, w, h) {
	const plotW = w - EQ_PAD.l - EQ_PAD.r;
	const plotH = h - EQ_PAD.t - EQ_PAD.b;
	if (plotW <= 0 || plotH <= 0) return;
	const x0 = EQ_PAD.l;
	const x1 = EQ_PAD.l + plotW;
	const zeroY = eqDbY(plotH, 0);
	const pts = EQ_FREQS.map((f, i) => [
		eqFreqX(plotW, f),
		eqDbY(plotH, eqGains[i]),
	]);

	g.save();
	g.globalAlpha = eqOn ? 1 : 0.4;
	g.textBaseline = "middle";

	g.beginPath();
	g.moveTo(pts[0][0], zeroY);
	for (const [x, y] of pts) g.lineTo(x, y);
	g.lineTo(pts[pts.length - 1][0], zeroY);
	g.closePath();
	const fill = g.createLinearGradient(
		0,
		EQ_PAD.t,
		0,
		EQ_PAD.t + plotH,
	);
	fill.addColorStop(0, "rgba(255,255,255,0.20)");
	fill.addColorStop(0.5, "rgba(255,255,255,0.07)");
	fill.addColorStop(1, "rgba(255,255,255,0.02)");
	g.fillStyle = fill;
	g.fill();

	g.beginPath();
	pts.forEach(([x, y], i) =>
		i ? g.lineTo(x, y) : g.moveTo(x, y),
	);
	g.strokeStyle = "#ffffff";
	g.lineWidth = 2;
	g.lineJoin = "round";
	g.shadowColor = "rgba(255,255,255,0.5)";
	g.shadowBlur = 7;
	g.stroke();
	g.shadowBlur = 0;

	if (eqHover >= 0) {
		const hx = pts[eqHover][0];
		const hy = pts[eqHover][1];
		g.strokeStyle = "rgba(255,255,255,0.4)";
		g.lineWidth = 1;
		g.beginPath();
		g.moveTo(hx, EQ_PAD.t);
		g.lineTo(hx, EQ_PAD.t + plotH);
		g.stroke();
		g.beginPath();
		g.arc(hx, hy, 5, 0, Math.PI * 2);
		g.fillStyle = "#ffffff";
		g.fill();
		g.strokeStyle = "#0d0d0d";
		g.lineWidth = 2;
		g.stroke();

		const val = eqGains[eqHover];
		const txt = `${fmtHz(EQ_FREQS[eqHover])} Hz  ${val > 0 ? "+" : ""}${val} dB`;
		g.font = "11px 'PT Mono', ui-monospace, monospace";
		const tw = g.measureText(txt).width + 14;
		const bx = Math.min(x1 - tw, Math.max(x0, hx - tw / 2));
		const by = Math.max(
			EQ_PAD.t + 2,
			Math.min(EQ_PAD.t + plotH - 22, hy - 30),
		);
		g.fillStyle = "rgba(16,16,16,0.92)";
		g.strokeStyle = "rgba(255,255,255,0.18)";
		g.beginPath();
		if (g.roundRect) g.roundRect(bx, by, tw, 20, 6);
		else g.rect(bx, by, tw, 20);
		g.fill();
		g.stroke();
		g.fillStyle = "#e6e6e6";
		g.textAlign = "center";
		g.fillText(txt, bx + tw / 2, by + 10);
	}
	g.restore();
}

function eqSampleAt(plotW, x) {
	const t = Math.max(0, Math.min(1, (x - EQ_PAD.l) / plotW));
	return Math.round(t * (EQ_BINS - 1));
}

function eqPointerInfo(e) {
	const rect = $("viz").getBoundingClientRect();
	return {
		x: e.clientX - rect.left,
		y: e.clientY - rect.top,
		plotW: rect.width - EQ_PAD.l - EQ_PAD.r,
		plotH: rect.height - EQ_PAD.t - EQ_PAD.b,
	};
}

function setupEqCanvas() {
	const canvas = $("viz");
	if (!canvas) return;
	canvas.addEventListener("pointerdown", (e) => {
		e.preventDefault();
		canvas.setPointerCapture(e.pointerId);
		eqDragging = true;
		const p = eqPointerInfo(e);
		const i = eqSampleAt(p.plotW, p.x);
		eqGains[i] = eqGainFromY(p.plotH, p.y);
		eqLast = i;
		eqHover = i;
		applyEq();
		drawViz(false);
	});
	canvas.addEventListener("pointermove", (e) => {
		const p = eqPointerInfo(e);
		const i = eqSampleAt(p.plotW, p.x);
		eqHover = i;
		if (eqDragging) {
			const val = eqGainFromY(p.plotH, p.y);
			if (eqLast >= 0 && i !== eqLast) {
				const step = i > eqLast ? 1 : -1;
				const from = eqGains[eqLast];
				const span = Math.abs(i - eqLast);
				for (let k = 1; k <= span; k++) {
					eqGains[eqLast + step * k] =
						from + (val - from) * (k / span);
				}
			} else {
				eqGains[i] = val;
			}
			eqLast = i;
			applyEq();
		}
		drawViz(false);
	});
	const end = () => {
		if (eqDragging) resetExporters();
		eqDragging = false;
		eqLast = -1;
		drawViz(false);
	};
	canvas.addEventListener("pointerup", end);
	canvas.addEventListener("pointercancel", end);
	canvas.addEventListener("pointerleave", () => {
		if (!eqDragging) {
			eqHover = -1;
			drawViz(false);
		}
	});
	if (window.ResizeObserver)
		new ResizeObserver(() => drawViz()).observe(canvas);
	drawViz(false);
}

let wasmModulePromise = null;

function getWasmModule() {
	if (!wasmModulePromise) {
		wasmModulePromise = fetch(`${BASE}worklets/birdsong-processor.wasm`)
			.then((res) => {
				if (!res.ok) throw new Error(`wasm ${res.status}`);
				return res.arrayBuffer();
			})
			.then((bytes) => WebAssembly.compile(bytes));
		wasmModulePromise.catch(() => {
			wasmModulePromise = null;
		});
	}
	return wasmModulePromise;
}

async function loadWorkletModule(context) {
	try {
		if (typeof WebAssembly === "undefined") {
			throw new Error("WebAssembly unavailable");
		}
		const wasmModule = await getWasmModule();
		await context.audioWorklet.addModule(
			`${BASE}worklets/birdsong-processor-wasm.js`,
		);
		return {
			name: "birdsong-processor-wasm",
			options: { ...workletOptions(), wasmModule },
		};
	} catch (e) {
		console.warn("WASM worklet unavailable; using the JS fallback.", e);
		await context.audioWorklet.addModule(
			`${BASE}worklets/birdsong-processor.js`,
		);
		return {
			name: "birdsong-processor",
			options: workletOptions(),
		};
	}
}

async function createWorkletNode(context, engine) {
	const make = (name, options) =>
		new AudioWorkletNode(context, name, {
			numberOfInputs: 1,
			numberOfOutputs: 1,
			outputChannelCount: [1],
			processorOptions: options,
		});
	try {
		return make(engine.name, engine.options);
	} catch (e) {
		if (engine.name !== "birdsong-processor-wasm") throw e;
		console.warn("WASM worklet node failed; using the JS fallback.", e);
		await context.audioWorklet.addModule(
			`${BASE}worklets/birdsong-processor.js`,
		);
		return make("birdsong-processor", workletOptions());
	}
}

async function ensureGraph() {
	if (ctx) return;
	if (
		!window.AudioContext ||
		!("audioWorklet" in AudioContext.prototype)
	) {
		notify("This browser has no AudioWorklet support.", true);
		throw new Error("no AudioWorklet");
	}
	ctx = new AudioContext({ latencyHint: "interactive" });
	const engine = await loadWorkletModule(ctx);
	workletNode = await createWorkletNode(ctx, engine);
	workletNode.onprocessorerror = () => {
		notify("The audio worklet crashed.", true);
	};

	dryGain = ctx.createGain();
	wetGain = ctx.createGain();
	masterGain = ctx.createGain();
	reverbNode = ctx.createConvolver();
	reverbNode.buffer = makeImpulseResponse(1.8, 2.6);
	reverbGain = ctx.createGain();
	analyser = ctx.createAnalyser();
	analyser.fftSize = 8192;

	media = $("media");
	// A stray OS/media-session speed setting would speed up the audio and the
	// spectrogram together. Playback speed is not a feature of this app.
	if (media.playbackRate !== 1) media.playbackRate = 1;
	mediaSource = ctx.createMediaElementSource(media);
	mediaSource.connect(dryGain);
	const eq = buildEqChain(ctx);
	eqFilters = eq.filters;
	mediaSource.connect(eq.input);
	eq.output.connect(workletNode);

	mixBus = ctx.createGain();
	workletNode.connect(wetGain);
	workletNode.connect(reverbNode);
	reverbNode.connect(reverbGain);
	dryGain.connect(mixBus);
	wetGain.connect(mixBus);
	reverbGain.connect(mixBus);
	mixBus.connect(masterGain);
	masterGain.connect(ctx.destination);

	visLeft = ctx.createAnalyser();
	visRight = ctx.createAnalyser();
	visLeft.smoothingTimeConstant = 0;
	visRight.smoothingTimeConstant = 0;
	visSplitter = ctx.createChannelSplitter(2);
	mixBus.connect(visSplitter);
	visSplitter.connect(visLeft, 0);
	visSplitter.connect(visRight, 1);
	for (const a of [visLeft, visRight]) {
		const sink = ctx.createGain();
		sink.gain.value = 0;
		a.connect(sink);
		sink.connect(ctx.destination);
	}

	mediaSource.connect(analyser);
	const analyserSink = ctx.createGain();
	analyserSink.gain.value = 0;
	analyser.connect(analyserSink);
	analyserSink.connect(ctx.destination);

	media.addEventListener("loadedmetadata", onMetadata);
	media.addEventListener("play", () => {
		playing = true;
		updateTransport();
	});
	media.addEventListener("pause", () => {
		playing = false;
		updateTransport();
	});
	media.addEventListener("ended", () => {
		playing = false;
		updateTransport();
	});
	media.addEventListener("error", () => {
		notify("That file could not be played.", true);
	});
	media.addEventListener("click", () => {
		if (media.videoWidth > 0) togglePlay();
	});
	media.addEventListener("ratechange", () => {
		if (media.playbackRate !== 1) media.playbackRate = 1;
	});

	applyMix();

	try {
		const engines = await getCqt();
		cqtOut = engines.out;
		cqtIn = engines.in;
		initCqtSurface(cqtOutSurface, cqtOut, setOutAnalysers);
		initCqtSurface(cqtInSurface, cqtIn, setInAnalyser);
	} catch (e) {
		console.warn("showcqt visualizer unavailable", e);
	}
}

function getCqt() {
	if (!cqtPromise) {
		cqtPromise = import("showcqt/showcqt-ref.mjs").then(
			async (m) => {
				const [out, inp] = await Promise.all([
					m.default.instantiate(),
					m.default.instantiate(),
				]);
				return { out, in: inp };
			},
		);
	}
	return cqtPromise;
}

function primeCqt() {
	if (cqtOut) return;
	getCqt()
		.then((engines) => {
			cqtOut = engines.out;
			cqtIn = engines.in;
			drawCqtIdle();
			drawViz(false);
		})
		.catch((e) => {
			console.warn("showcqt visualizer unavailable", e);
		});
}

function setOutAnalysers(engine) {
	if (visLeft) visLeft.fftSize = engine.fft_size;
	if (visRight) visRight.fftSize = engine.fft_size;
}

function setInAnalyser(engine) {
	if (analyser) analyser.fftSize = engine.fft_size;
}

function initCqtSurface(surface, engine, onInit) {
	if (!engine || !surface || !surface.canvas) return false;
	const rect = surface.canvas.getBoundingClientRect();
	if (rect.width < 16 || rect.height < 16) return false;
	const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
	const width = Math.max(64, Math.round(rect.width * dpr));
	const totalH = Math.max(64, Math.round(rect.height * dpr));
	const sampleRate = ctx ? ctx.sampleRate : 48000;
	if (
		width === surface.initW &&
		totalH === surface.initH &&
		sampleRate === surface.sampleRate &&
		surface.engine === engine
	) {
		if (onInit) onInit(engine);
		return true;
	}
	const axisH = Math.max(8, Math.round(width * 0.028));
	const axisY = Math.max(
		16,
		Math.round(
			totalH / 2 - axisH / 2 + totalH * CQT_AXIS_NUDGE,
		),
	);
	const barH = Math.max(16, axisY);
	const histTop = Math.min(totalH - 8, axisY + axisH);
	const histH = Math.max(8, totalH - histTop);
	surface.canvas.width = width;
	surface.canvas.height = totalH;
	engine.init(sampleRate, width, barH, 9, 17, true);
	engine.height = barH;
	surface.engine = engine;
	surface.ctx = surface.canvas.getContext("2d");
	surface.imageData = surface.ctx.createImageData(width, barH);
	surface.history = document.createElement("canvas");
	surface.history.width = width;
	surface.history.height = histH;
	surface.historyCtx = surface.history.getContext("2d");
	surface.rowData = surface.historyCtx.createImageData(width, 1);
	surface.width = width;
	surface.axisY = axisY;
	surface.axisH = axisH;
	surface.histTop = histTop;
	surface.histH = histH;
	surface.initW = width;
	surface.initH = totalH;
	surface.sampleRate = sampleRate;
	surface.paintKey = "";
	if (onInit) onInit(engine);
	return true;
}

function renderCqtSurface(surface, fillInputs) {
	const engine = surface.engine;
	if (!engine || !surface.ctx) return;
	const ctx = surface.ctx;
	// The input surface shares its canvas with the EQ overlay, which leaves a
	// dpr transform behind. Reset it before drawing the spectrogram or the
	// history/axis are scaled a second time on high-DPI phones. Clear the
	// whole canvas too, so the previous EQ curve cannot be captured into the
	// cached backdrop.
	ctx.setTransform(1, 0, 0, 1, 0, 0);
	ctx.globalAlpha = 1;
	ctx.globalCompositeOperation = "source-over";
	ctx.fillStyle = "#000";
	ctx.fillRect(0, 0, surface.canvas.width, surface.canvas.height);
	fillInputs(engine);
	engine.calc();
	const width = engine.width;
	const height = engine.height;
	const output = engine.output;
	const color = engine.color;
	for (let x = 0; x < width * 4; x += 4) {
		const v = Math.max(color[x], color[x + 1], color[x + 2]);
		color[x] = v;
		color[x + 1] = v;
		color[x + 2] = v;
	}
	const data = surface.imageData.data;
	for (let y = 0; y < height; y++) {
		engine.render_line_alpha(y, 255);
		data.set(output, 4 * width * y);
	}
	surface.ctx.putImageData(surface.imageData, 0, 0);
	const row = surface.rowData.data;
	for (let x = 0; x < width; x++) {
		const i = 4 * x;
		row[i] = color[i];
		row[i + 1] = color[i + 1];
		row[i + 2] = color[i + 2];
		row[i + 3] = 255;
	}
	if (surface.histH > 1) {
		const hctx = surface.historyCtx;
		hctx.globalCompositeOperation = "copy";
		hctx.drawImage(surface.history, 0, 1);
		hctx.globalCompositeOperation = "source-over";
		hctx.putImageData(surface.rowData, 0, 0);
		surface.ctx.drawImage(surface.history, 0, surface.histTop);
	}
	drawCqtAxis(surface, width);
}

function drawCqtAxis(surface, width) {
	surface.ctx.fillStyle = "#000";
	surface.ctx.fillRect(0, surface.axisY, width, surface.axisH);
	if (CQT_AXIS.complete && CQT_AXIS.naturalWidth > 0) {
		surface.ctx.drawImage(
			CQT_AXIS,
			0,
			surface.axisY,
			width,
			surface.axisH,
		);
	}
}

function paintCqtIdle(surface, engine) {
	if (!initCqtSurface(surface, engine)) return false;
	const g = surface.ctx;
	g.setTransform(1, 0, 0, 1, 0, 0);
	g.fillStyle = "#000";
	g.fillRect(0, 0, surface.canvas.width, surface.canvas.height);
	drawCqtAxis(surface, surface.canvas.width);
	return true;
}

function drawCqtIdle() {
	if (!cqtOut) return;
	const surface = cqtOutSurface;
	if (!initCqtSurface(surface, cqtOut, setOutAnalysers)) return;
	const key = `${surface.initW}x${surface.initH}:${CQT_AXIS.complete ? 1 : 0
		}`;
	if (surface.paintKey === key) return;
	surface.paintKey = key;
	paintCqtIdle(surface, cqtOut);
}

function onMetadata() {
	const isVideo = media.videoWidth > 0 && media.videoHeight > 0;
	$("mediabox").classList.toggle("video-mode", isVideo);
	$("mediabox").classList.add("hasmedia", "welcome-hide");
	document.querySelector(".scrubrow").classList.add("hasmedia");
	loaded = true;
	progress.disabled = false;
	updateTransport();
}

function applyMix() {
	if (!ctx) return;
	const w = state.drywet / 100;
	const r = state.reverb / 100;
	const now = ctx.currentTime;
	const dry = Math.cos((w * Math.PI) / 2);
	const wet = Math.sin((w * Math.PI) / 2);
	dryGain.gain.setTargetAtTime(dry, now, 0.02);
	wetGain.gain.setTargetAtTime(wet, now, 0.02);
	reverbGain.gain.setTargetAtTime(wet * r * 0.9, now, 0.02);
	masterGain.gain.setTargetAtTime(
		Math.pow(state.volume / 100, 2),
		now,
		0.02,
	);
}

function workletOptions() {
	return {
		fscale: state.pitch,
		harmonics: state.timbre,
		wave: state.wave,
		gate: state.gate,
		quantize: state.grit,
		shiftHz: state.shift,
		fundLpHz: state.rough,
		envLpHz: state.env,
		fmLpHz: state.pitchResp,
		trillDepth: state.trill / 100,
		trillRate: state.trillRate,
		autogain: state.autogain,
	};
}

function sendParams() {
	if (workletNode) {
		workletNode.port.postMessage(workletOptions());
	}
	resetExporters();
}

function fmt(t) {
	if (!isFinite(t) || t < 0) t = 0;
	const m = Math.floor(t / 60);
	const s = Math.floor(t % 60);
	return `${m}:${String(s).padStart(2, "0")}`;
}

function duration() {
	if (media && isFinite(media.duration) && media.duration > 0)
		return media.duration;
	return fallbackDuration;
}

function updateTransport() {
	playBtn.classList.toggle("playing", playing);
	playBtn.title = playing ? "Pause" : "Play";
	playBtn.setAttribute("aria-label", playing ? "Pause" : "Play");
	playBtn.disabled = !loaded;
	const vizwrap = $("vizwrap");
	if (vizwrap) vizwrap.classList.toggle("is-playing", playing);
	const pausedBadge = $("pausedbadge");
	if (pausedBadge)
		pausedBadge.classList.toggle(
			"is-visible",
			loaded && !playing && !recording,
		);
	refreshExportButtons();
}

function updateTimes(cur, dur) {
	curTimeEl.textContent = fmt(cur);
	durTimeEl.textContent = fmt(dur);
	drawWaveform();
}

const WAVE_BUCKETS = 600;

function computeWavePeaks(buffer) {
	const channels = [];
	for (let c = 0; c < buffer.numberOfChannels; c++)
		channels.push(buffer.getChannelData(c));
	const len = buffer.length;
	if (!len) return null;
	const peaks = new Float32Array(WAVE_BUCKETS);
	const block = Math.max(1, Math.floor(len / WAVE_BUCKETS));
	let max = 0;
	for (let i = 0; i < WAVE_BUCKETS; i++) {
		const start = i * block;
		const end = Math.min(len, start + block);
		let peak = 0;
		for (let s = start; s < end; s++) {
			for (let c = 0; c < channels.length; c++) {
				const v = Math.abs(channels[c][s] || 0);
				if (v > peak) peak = v;
			}
		}
		peaks[i] = peak;
		if (peak > max) max = peak;
	}
	if (max <= 0) return null;
	const sorted = Array.from(peaks).sort((a, b) => a - b);
	const ref = sorted[Math.floor(sorted.length * 0.95)] || max;
	for (let i = 0; i < peaks.length; i++)
		peaks[i] = Math.pow(Math.min(1, peaks[i] / ref), 0.65);
	return peaks;
}

function drawWaveform() {
	const canvas = $("waveform");
	if (!canvas) return;
	const w = canvas.clientWidth;
	const h = canvas.clientHeight;
	if (!w || !h) return;
	const dpr = Math.min(window.devicePixelRatio || 1, 2);
	const pw = Math.round(w * dpr);
	const ph = Math.round(h * dpr);
	if (canvas.width !== pw || canvas.height !== ph) {
		canvas.width = pw;
		canvas.height = ph;
	}
	const g = canvas.getContext("2d");
	if (!g) return;
	// Draw in device pixels with an identity transform. The envelope is a
	// single filled path sampled once per device column, with bucket peaks
	// linearly interpolated, so there are no seams between buckets.
	g.setTransform(1, 0, 0, 1, 0, 0);
	g.clearRect(0, 0, pw, ph);
	const dur = duration();
	const frac =
		dur > 0
			? Math.max(0, Math.min(1, (media.currentTime || 0) / dur))
			: 0;
	const playedX = Math.round(frac * pw);
	if (!wavePeaks || !wavePeaks.length) {
		g.fillStyle = "rgba(255,255,255,0.06)";
		g.fillRect(0, 0, pw, ph);
		g.strokeStyle = "rgba(255,255,255,0.14)";
		g.lineWidth = 1;
		g.strokeRect(0.5, 0.5, pw - 1, ph - 1);
		return;
	}
	const n = wavePeaks.length;
	const maxH = Math.max(1, ph - Math.round(2 * dpr));
	const sample = (x) => {
		const t = ((x + 0.5) / pw) * n - 0.5;
		const i = Math.floor(t);
		if (i < 0) return wavePeaks[0];
		if (i >= n - 1) return wavePeaks[n - 1];
		const f = t - i;
		return wavePeaks[i] + (wavePeaks[i + 1] - wavePeaks[i]) * f;
	};
	const shape = () => {
		g.beginPath();
		g.moveTo(0, ph);
		for (let x = 0; x <= pw; x++)
			g.lineTo(x, ph - Math.max(1, sample(x) * maxH));
		g.lineTo(pw, ph);
		g.closePath();
		g.fill();
	};
	g.fillStyle = "rgba(255,255,255,0.26)";
	shape();
	if (playedX > 0) {
		g.save();
		g.beginPath();
		g.rect(0, 0, playedX, ph);
		g.clip();
		g.fillStyle = "rgba(255,255,255,0.95)";
		shape();
		g.restore();
	}
	if (frac > 0 && frac < 1) {
		const markerW = Math.max(1, Math.round(dpr));
		g.fillStyle = "rgba(255,255,255,0.7)";
		g.fillRect(Math.round(playedX - markerW / 2), 0, markerW, ph);
	}
}

function drawTransportWave() {
	const canvas = $("transportwave");
	if (!canvas) return;
	const w = canvas.clientWidth;
	const h = canvas.clientHeight;
	if (!w || !h) return;
	const dpr = Math.min(window.devicePixelRatio || 1, 2);
	const pw = Math.round(w * dpr);
	const ph = Math.round(h * dpr);
	if (canvas.width !== pw || canvas.height !== ph) {
		canvas.width = pw;
		canvas.height = ph;
	}
	const g = canvas.getContext("2d");
	if (!g) return;
	g.setTransform(dpr, 0, 0, dpr, 0, 0);
	g.clearRect(0, 0, w, h);
	const mid = h / 2;
	g.strokeStyle = "rgba(255,255,255,0.1)";
	g.lineWidth = 1;
	g.beginPath();
	g.moveTo(0, mid + 0.5);
	g.lineTo(w, mid + 0.5);
	g.stroke();
	if (!visLeft) return;
	const n = visLeft.fftSize;
	if (!transportWaveData || transportWaveData.length !== n)
		transportWaveData = new Float32Array(n);
	visLeft.getFloatTimeDomainData(transportWaveData);
	const scale = h * 0.42;
	g.strokeStyle = "rgba(255,255,255,0.8)";
	g.beginPath();
	for (let x = 0; x <= w; x++) {
		const i = Math.max(0, n - 1 - Math.floor((x / w) * (n - 1)));
		const y = mid - transportWaveData[i] * scale;
		if (x === 0) g.moveTo(x, y);
		else g.lineTo(x, y);
	}
	g.stroke();
}

function seek(t) {
	if (!media) return;
	const dur = duration();
	t = Math.max(0, Math.min(dur > 0 ? dur - 0.01 : 0, t));
	try {
		media.currentTime = t;
	} catch (e) { }
	if (workletNode)
		workletNode.port.postMessage({ type: "reset" });
	updateTimes(t, dur);
}

const CQT_COLUMN_MS = 1000 / 60;
let cqtClock = 0;
let cqtAccum = 0;

// The CQT advances one column per call, so tie it to wall time instead of the
// display refresh rate. A 120 Hz phone would otherwise scroll twice as fast
// as a 60 Hz one.
function cqtAdvance(now) {
	if (!cqtClock) {
		cqtClock = now;
		return true;
	}
	cqtAccum += Math.min(now - cqtClock, 250);
	cqtClock = now;
	if (cqtAccum < CQT_COLUMN_MS) return false;
	cqtAccum = Math.min(cqtAccum - CQT_COLUMN_MS, CQT_COLUMN_MS);
	return true;
}

function tick() {
	rafId = requestAnimationFrame(tick);
	const advance = cqtAdvance(performance.now());
	if (advance) drawCqt();
	drawViz(advance);
	if (!media) return;
	const dur = duration();
	const cur = media.currentTime || 0;
	updateTimes(cur, dur);
	if (!scrubbing && dur > 0)
		progress.value = Math.round((cur / dur) * 1000);
	drawTransportWave();
}

function drawViz(advance = false) {
	const canvas = $("viz");
	if (!canvas) return;
	const w = canvas.clientWidth;
	const h = canvas.clientHeight;
	if (!w || !h) return;
	const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
	if (
		advance ||
		!vizBase ||
		vizBase.width !== Math.round(w * dpr) ||
		vizBase.height !== Math.round(h * dpr)
	) {
		if (cqtIn && analyser) {
			initCqtSurface(cqtInSurface, cqtIn, setInAnalyser);
			renderCqtSurface(cqtInSurface, (engine) => {
				analyser.getFloatTimeDomainData(engine.inputs[0]);
				engine.inputs[1].set(engine.inputs[0]);
			});
		} else if (cqtIn) {
			paintCqtIdle(cqtInSurface, cqtIn);
		} else {
			canvas.width = Math.round(w * dpr);
			canvas.height = Math.round(h * dpr);
		}
		if (!vizBase) vizBase = document.createElement("canvas");
		if (vizBase.width !== canvas.width) vizBase.width = canvas.width;
		if (vizBase.height !== canvas.height) vizBase.height = canvas.height;
		const b = vizBase.getContext("2d");
		b.clearRect(0, 0, vizBase.width, vizBase.height);
		b.drawImage(canvas, 0, 0);
	}
	const g = canvas.getContext("2d");
	g.setTransform(1, 0, 0, 1, 0, 0);
	g.clearRect(0, 0, canvas.width, canvas.height);
	g.drawImage(vizBase, 0, 0);
	g.setTransform(dpr, 0, 0, dpr, 0, 0);
	drawEqOverlay(g, w, h);
}

function drawCqt(advance = true) {
	const box = $("mediabox");
	if (!box) return;
	if (!cqtOut) return;
	if (!visLeft || !visRight) {
		drawCqtIdle();
		return;
	}
	if (!advance) return;
	if (!initCqtSurface(cqtOutSurface, cqtOut, setOutAnalysers))
		return;
	renderCqtSurface(cqtOutSurface, (engine) => {
		visLeft.getFloatTimeDomainData(engine.inputs[0]);
		visRight.getFloatTimeDomainData(engine.inputs[1]);
	});
}

async function loadFile(file) {
	if (recording) {
		recordDiscard = true;
		stopRecording();
	}
	try {
		await ensureGraph();
		if (currentURL) URL.revokeObjectURL(currentURL);
		currentURL = URL.createObjectURL(file);
		exportBuffer = null;
		fallbackDuration = 0;
		wavePeaks = null;
		fileEpoch++;
		setExampleSelected(null);
		invalidateVoiceStats();
		updateAutoButtons();
		loaded = false;
		playing = false;
		if (workletNode)
			workletNode.port.postMessage({ type: "reset" });
		const box = $("mediabox");
		box.classList.remove("video-mode", "hasmedia");
		document.querySelector(".scrubrow").classList.remove("hasmedia");
		media.src = currentURL;
		media.load();
		updateTimes(0, 0);
		progress.value = 0;
		try {
			const ab = await file.arrayBuffer();
			exportBuffer = await ctx.decodeAudioData(ab);
			fallbackDuration = exportBuffer.duration;
			wavePeaks = computeWavePeaks(exportBuffer);
		} catch (e) {
			console.warn("decode for export failed", e);
			wavePeaks = null;
			notify(
				"Export is unavailable for this file, but it can still be played.",
			);
		}
		drawWaveform();
		resetExporters();
		updateAutoButtons();
		updateTransport();
	} catch (err) {
		console.error(err);
		updateAutoButtons();
		notify("Could not load that file.", true);
	}
}

async function togglePlay() {
	if (!loaded) return;
	await ensureGraph();
	if (ctx.state === "suspended") await ctx.resume();
	if (media.paused) {
		try {
			await media.play();
		} catch (e) {
			notify("Playback was blocked.", true);
		}
	} else {
		media.pause();
	}
}

const RECORD_MIMES = [
	"audio/webm;codecs=opus",
	"audio/webm",
	"audio/ogg;codecs=opus",
	"audio/mp4",
];

function recordSupported() {
	return (
		!!window.MediaRecorder &&
		!!navigator.mediaDevices &&
		typeof navigator.mediaDevices.getUserMedia === "function"
	);
}

function pickRecordMime() {
	if (typeof MediaRecorder.isTypeSupported !== "function") return "";
	for (const mime of RECORD_MIMES)
		if (MediaRecorder.isTypeSupported(mime)) return mime;
	return "";
}

function updateRecordButton() {
	if (!recordBtn) return;
	recordBtn.classList.toggle("recording", recording);
	recordBtn.setAttribute("aria-pressed", String(recording));
	const label = recording ? "Stop recording" : "Record from microphone";
	recordBtn.title = label;
	recordBtn.setAttribute("aria-label", label);
	recordBtn.disabled = !recording && !recordSupported();
	const badge = $("recbadge");
	if (badge) badge.classList.toggle("is-visible", recording);
	const box = $("mediabox");
	if (box) box.classList.toggle("is-recording", recording);
	const pausedBadge = $("pausedbadge");
	if (pausedBadge)
		pausedBadge.classList.toggle(
			"is-visible",
			loaded && !playing && !recording,
		);
}

function releaseRecordStream() {
	if (!recordStream) return;
	for (const track of recordStream.getTracks()) track.stop();
	recordStream = null;
}

// Route the microphone into the same analysers that feed the input
// spectrum and the player's CQT, so both show the live input while
// recording instead of silence.
async function attachRecordingVisuals(stream) {
	try {
		await ensureGraph();
		if (ctx.state === "suspended") await ctx.resume();
		micSource = ctx.createMediaStreamSource(stream);
		if (analyser) micSource.connect(analyser);
		if (visSplitter) visSplitter.disconnect();
		if (visLeft) micSource.connect(visLeft);
		if (visRight) micSource.connect(visRight);
		recordVisualsAttached = true;
	} catch (e) {
		console.warn("recording visualizer unavailable", e);
	}
}

function detachRecordingVisuals() {
	if (micSource) {
		try {
			micSource.disconnect();
		} catch (e) { }
		micSource = null;
	}
	if (recordVisualsAttached && visSplitter) {
		try {
			visSplitter.connect(visLeft, 0);
			visSplitter.connect(visRight, 1);
		} catch (e) { }
	}
	recordVisualsAttached = false;
}

async function startRecording() {
	if (recording || recordStarting) return;
	if (!recordSupported()) {
		notify("This browser cannot record from the microphone.", true);
		return;
	}
	recordStarting = true;
	try {
		let stream;
		try {
			stream = await navigator.mediaDevices.getUserMedia({
				audio: true,
			});
		} catch (e) {
			console.warn("microphone access failed", e);
			notify("Microphone access was denied.", true);
			return;
		}
		recordStream = stream;
		await attachRecordingVisuals(stream);
		recordChunks = [];
		recordDiscard = false;
		const mime = pickRecordMime();
		try {
			recorder = new MediaRecorder(
				stream,
				mime ? { mimeType: mime } : undefined,
			);
		} catch (e) {
			console.warn("recorder init failed", e);
			detachRecordingVisuals();
			releaseRecordStream();
			notify("Could not start recording.", true);
			return;
		}
		recorder.addEventListener("dataavailable", (e) => {
			if (e.data && e.data.size) recordChunks.push(e.data);
		});
		recorder.addEventListener("stop", onRecordingStop);
		if (media && !media.paused) media.pause();
		recording = true;
		updateRecordButton();
		try {
			recorder.start();
		} catch (e) {
			console.warn("recorder start failed", e);
			recording = false;
			recorder = null;
			recordChunks = [];
			detachRecordingVisuals();
			releaseRecordStream();
			updateRecordButton();
			notify("Could not start recording.", true);
		}
	} finally {
		recordStarting = false;
	}
}

function stopRecording() {
	if (!recording || !recorder) return;
	if (recorder.state !== "inactive") recorder.stop();
}

async function onRecordingStop() {
	recording = false;
	const mime = (recorder && recorder.mimeType) || "audio/webm";
	recorder = null;
	const discard = recordDiscard;
	recordDiscard = false;
	const blobs = recordChunks;
	recordChunks = [];
	detachRecordingVisuals();
	releaseRecordStream();
	updateRecordButton();
	if (discard) return;
	const type = mime.split(";")[0] || "audio/webm";
	const blob = new Blob(blobs, { type });
	if (!blob.size) {
		notify("Nothing was recorded.", true);
		return;
	}
	const ext = type.includes("mp4")
		? "m4a"
		: type.includes("ogg")
			? "ogg"
			: "webm";
	const file = new File([blob], `recording.${ext}`, { type });
	await loadFile(file);
	try {
		await waitForMedia();
		if (!playing) await togglePlay();
	} catch (e) {
		console.warn("recording did not load", e);
	}
}

function toggleRecording() {
	if (recording) stopRecording();
	else startRecording();
}

function setExportBtn(exp, fill, ready) {
	exp.btn.style.setProperty(
		"--p",
		Math.max(0, Math.min(1, fill)).toFixed(4),
	);
	const name = exp.ext.toUpperCase();
	const title = ready
		? `Download ${name}`
		: exp.busy
			? `Exporting ${name}…`
			: `Export ${name}`;
	exp.btn.title = title;
	exp.btn.setAttribute("aria-label", title);
	exp.btn.classList.toggle("ready", !!ready);
}

function refreshExportButtons() {
	const anyBusy = exporters.wav.busy || exporters.mp3.busy;
	for (const kind of ["wav", "mp3"]) {
		const exp = exporters[kind];
		if (exp.busy) {
			exp.btn.disabled = false;
			exp.btn.classList.add("busy");
		} else {
			exp.btn.classList.remove("busy");
			if (anyBusy) exp.btn.disabled = true;
			else if (exp.ready) exp.btn.disabled = false;
			else exp.btn.disabled = !exportBuffer;
		}
	}
}

function resetExporters() {
	if (exporters.wav.busy || exporters.mp3.busy) {
		exportDirty = true;
		return;
	}
	exportDirty = false;
	renderedBuffer = null;
	for (const kind of ["wav", "mp3"]) {
		const exp = exporters[kind];
		exp.blob = null;
		exp.busy = false;
		exp.ready = false;
		setExportBtn(exp, 0, false);
	}
	refreshExportButtons();
}

function yieldToUI() {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

async function renderBirdsong(onProgress) {
	if (renderedBuffer) return renderedBuffer;
	const sr = 44100;
	const frames = Math.max(
		1,
		Math.ceil(exportBuffer.duration * sr),
	);
	const off = new OfflineAudioContext(1, frames, sr);
	const engine = await loadWorkletModule(off);
	const wn = await createWorkletNode(off, engine);
	const eq = buildEqChain(off);
	const src = off.createBufferSource();
	src.buffer = exportBuffer;
	src.connect(eq.input);
	eq.output.connect(wn);
	wn.connect(off.destination);

	const total = exportBuffer.duration;
	if (typeof off.suspend === "function") {
		const steps = 24;
		for (let i = 1; i < steps; i++) {
			const t = (total * i) / steps;
			if (t <= 0 || t >= total) continue;
			try {
				off.suspend(t)
					.then(() => {
						if (onProgress) onProgress(i / steps);
						off.resume();
					})
					.catch(() => { });
			} catch (e) { }
		}
	}
	src.start();
	if (onProgress) onProgress(0);
	const rendered = await off.startRendering();
	wn.port.postMessage({ type: "dispose" });
	if (onProgress) onProgress(1);
	renderedBuffer = rendered;
	return rendered;
}

async function encodeWavAsync(audioBuffer, onProgress) {
	const samples = audioBuffer.getChannelData(0);
	const n = samples.length;
	const buffer = new ArrayBuffer(44 + n * 2);
	const view = new DataView(buffer);
	const str = (off, s) => {
		for (let i = 0; i < s.length; i++)
			view.setUint8(off + i, s.charCodeAt(i));
	};
	str(0, "RIFF");
	view.setUint32(4, 36 + n * 2, true);
	str(8, "WAVE");
	str(12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, audioBuffer.sampleRate, true);
	view.setUint32(28, audioBuffer.sampleRate * 2, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	str(36, "data");
	view.setUint32(40, n * 2, true);

	const chunk = 1 << 20;
	let off = 44;
	for (let i = 0; i < n; i++) {
		let s = samples[i];
		s = s > 1 ? 1 : s < -1 ? -1 : s;
		s = s < 0 ? s * 0x8000 : s * 0x7fff;
		view.setInt16(off, s, true);
		off += 2;
		if ((i + 1) % chunk === 0) {
			if (onProgress) onProgress((i + 1) / n);
			await yieldToUI();
		}
	}
	if (onProgress) onProgress(1);
	return new Blob([view], { type: "audio/wav" });
}

function floatToInt16(input) {
	const out = new Int16Array(input.length);
	for (let i = 0; i < input.length; i++) {
		let s = input[i];
		s = s > 1 ? 1 : s < -1 ? -1 : s;
		out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
	}
	return out;
}

async function encodeMp3Async(audioBuffer, onProgress) {
	const samples = audioBuffer.getChannelData(0);
	const encoder = new Mp3Encoder(1, audioBuffer.sampleRate, 160);
	const blockSize = 1152;
	const parts = [];
	const total = samples.length;
	for (let i = 0; i < total; i += blockSize) {
		const chunk = samples.subarray(
			i,
			Math.min(i + blockSize, total),
		);
		const buf = encoder.encodeBuffer(floatToInt16(chunk));
		if (buf.length) parts.push(buf);
		if ((i / blockSize) % 24 === 0) {
			if (onProgress) onProgress(i / total);
			await yieldToUI();
		}
	}
	const end = encoder.flush();
	if (end.length) parts.push(end);
	if (onProgress) onProgress(1);
	return new Blob(parts, { type: "audio/mpeg" });
}

function triggerDownload(exp) {
	const a = document.createElement("a");
	a.href = URL.createObjectURL(exp.blob);
	a.download = `birdsong.${exp.ext}`;
	a.click();
	setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

async function startExport(kind) {
	const exp = exporters[kind];
	if (exp.busy) return;
	if (exp.ready) {
		triggerDownload(exp);
		return;
	}
	if (!exportBuffer) return;
	const title = exp.ext.toUpperCase();
	exp.busy = true;
	refreshExportButtons();
	setExportBtn(exp, 0, false);
	try {
		await renderBirdsong((p) => {
			setExportBtn(exp, p * 0.85, false);
		});
		const blob =
			kind === "wav"
				? await encodeWavAsync(renderedBuffer, (p) =>
					setExportBtn(exp, 0.85 + p * 0.15, false),
				)
				: await encodeMp3Async(renderedBuffer, (p) =>
					setExportBtn(exp, 0.85 + p * 0.15, false),
				);
		exp.blob = blob;
		exp.ready = true;
		setExportBtn(exp, 1, true);
	} catch (err) {
		console.error(err);
		setExportBtn(exp, 0, false);
		notify(`${title} export failed.`, true);
	} finally {
		exp.busy = false;
		if (exportDirty) resetExporters();
		else refreshExportButtons();
	}
}

function bindSlider(
	id,
	labelId,
	key,
	format,
	onChange,
	markDirty = true,
) {
	const el = $(id);
	const label = $(labelId);
	const update = () => {
		const v = parseFloat(el.value);
		state[key] = v;
		if (label) label.textContent = format(v);
		const min = parseFloat(el.min) || 0;
		const max = parseFloat(el.max) || 100;
		const fill = max > min ? ((v - min) / (max - min)) * 100 : 0;
		el.style.setProperty(
			"--fill",
			`${Math.max(0, Math.min(100, fill))}%`,
		);
		if (markDirty) clearPresetSelection();
		if (onChange) onChange(v);
	};
	el.addEventListener("input", update);
	update();
}

bindSlider(
	"drywet",
	"v-drywet",
	"drywet",
	(v) => `${Math.round(v)}%`,
	applyMix,
);
bindSlider(
	"reverb",
	"v-reverb",
	"reverb",
	(v) => `${Math.round(v)}%`,
	applyMix,
);
bindSlider("volume", null, "volume", () => "", applyMix, false);
bindSlider(
	"pitch",
	"v-pitch",
	"pitch",
	(v) => `${(v * VOICE_TO_BIRD).toFixed(1)}×`,
	sendParams,
);
bindSlider(
	"timbre",
	"v-timbre",
	"timbre",
	(v) => `${Math.round(v)}`,
	sendParams,
);
bindSlider(
	"shift",
	"v-shift",
	"shift",
	(v) => `${Math.round(v)} Hz`,
	sendParams,
);
bindSlider(
	"rough",
	"v-rough",
	"rough",
	(v) => `${Math.round(v)} Hz`,
	sendParams,
);
bindSlider(
	"gate",
	"v-gate",
	"gate",
	(v) => `${Math.round((v / 0.2) * 100)}%`,
	sendParams,
);
bindSlider(
	"pitchresp",
	"v-pitchresp",
	"pitchResp",
	(v) => `${Math.round(v)} Hz`,
	sendParams,
);
bindSlider(
	"env",
	"v-env",
	"env",
	(v) => `${Math.round(v)} Hz`,
	sendParams,
);
bindSlider(
	"trill",
	"v-trill",
	"trill",
	(v) => `${Math.round(v)}%`,
	sendParams,
);
bindSlider(
	"trillrate",
	"v-trillrate",
	"trillRate",
	(v) => `${Math.round(v)} Hz`,
	sendParams,
);

$("wave").addEventListener("change", (e) => {
	state.wave = e.target.value;
	$("v-wave").textContent = state.wave;
	clearPresetSelection();
	sendParams();
});

document.querySelectorAll(".slider .help").forEach((btn) => {
	btn.addEventListener("click", (e) => {
		e.preventDefault();
		e.stopPropagation();
		const row = btn.closest(".slider");
		row.classList.toggle("open");
	});
});

setupEqCanvas();
$("eq-on").addEventListener("change", (e) => {
	eqOn = e.target.checked;
	applyEq();
	resetExporters();
	drawViz(false);
});
$("eq-reset").addEventListener("click", () => {
	eqGains.fill(0);
	applyEq();
	resetExporters();
	drawViz(false);
});

$("grit").addEventListener("change", (e) => {
	state.grit = e.target.checked;
	clearPresetSelection();
	sendParams();
});
$("autogain").addEventListener("change", (e) => {
	state.autogain = e.target.checked;
	clearPresetSelection();
	sendParams();
});

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function setRangeValue(id, value) {
	const el = $(id);
	el.value = value;
	el.dispatchEvent(new Event("input"));
}
function setCheck(id, checked) {
	const el = $(id);
	el.checked = checked;
	el.dispatchEvent(new Event("change"));
}
function setSelect(id, value) {
	const el = $(id);
	el.value = value;
	el.dispatchEvent(new Event("change"));
}

const DEFAULT_SETTINGS = {
	drywet: 100,
	reverb: 50,
	pitch: 24000,
	timbre: 1,
	wave: "sine",
	shift: 220,
	rough: 140,
	gate: 0,
	env: 70,
	pitchResp: 70,
	trill: 0,
	trillRate: 14,
	grit: true,
	autogain: true,
	eqOn: true,
	eq: new Array(EQ_BINS).fill(0),
};

const EXAMPLE_PRESETS = {
	baka: {
		media: "examples/baka.mp4",
		settings: {
			"drywet": 95,
			"reverb": 100,
			"pitch": 43500,
			"timbre": 4,
			"wave": "sine",
			"shift": 135,
			"rough": 115,
			"gate": 0.05,
			"env": 200,
			"pitchResp": 65,
			"trill": 7,
			"trillRate": 29,
			"grit": true,
			"autogain": true,
			"eqOn": true,
			"eq": []
		},
	},
	drums: {
		media: "examples/drums.mp4",
		settings: {
			"drywet": 100,
			"reverb": 28,
			"pitch": 36000,
			"timbre": 11,
			"wave": "sine",
			"shift": 298,
			"rough": 205,
			"gate": 0.05,
			"env": 80,
			"pitchResp": 135,
			"trill": 42,
			"trillRate": 7,
			"grit": true,
			"autogain": true,
			"eqOn": true,
			"eq": []
		},
	},
	parade: {
		media: "examples/parade.mp4",
		settings: {
			"drywet": 100,
			"reverb": 50,
			"pitch": 24000,
			"timbre": 1,
			"wave": "sine",
			"shift": 363,
			"rough": 140,
			"gate": 0,
			"env": 70,
			"pitchResp": 70,
			"trill": 0,
			"trillRate": 14,
			"grit": true,
			"autogain": true,
			"eqOn": true,
			"eq": []
		},
	},
	hams: {
		media: "examples/hams.mp4",
		settings: {
			"drywet": 100,
			"reverb": 56,
			"pitch": 24000,
			"timbre": 1,
			"wave": "triangle",
			"shift": 526,
			"rough": 250,
			"gate": 0.04,
			"env": 80,
			"pitchResp": 70,
			"trill": 5,
			"trillRate": 26,
			"grit": true,
			"autogain": true,
			"eqOn": true,
			"eq": []
		},
	},
	koth: {
		media: "examples/koth.mp4",
		settings: {
			"drywet": 100,
			"reverb": 16,
			"pitch": 28000,
			"timbre": 3,
			"wave": "triangle",
			"shift": 438,
			"rough": 90,
			"gate": 0.005,
			"env": 110,
			"pitchResp": 165,
			"trill": 18,
			"trillRate": 12,
			"grit": true,
			"autogain": true,
			"eqOn": true,
			"eq": []
		},
	},
	undertale: {
		media: "examples/undertale.mp4",
		settings: {
			"drywet": 82,
			"reverb": 40,
			"pitch": 18000,
			"timbre": 2,
			"wave": "sine",
			"shift": 542,
			"rough": 190,
			"gate": 0,
			"env": 165,
			"pitchResp": 30,
			"trill": 35,
			"trillRate": 10,
			"grit": true,
			"autogain": true,
			"eqOn": true,
			"eq": []
		},
	},
	house: {
		media: "examples/house.mp4",
		settings: {
			"drywet": 89,
			"reverb": 41,
			"pitch": 40000,
			"timbre": 6,
			"wave": "square",
			"shift": 530,
			"rough": 190,
			"gate": 0.02,
			"env": 50,
			"pitchResp": 40,
			"trill": 3,
			"trillRate": 28,
			"grit": true,
			"autogain": true,
			"eqOn": true,
			"eq": []
		},
	},
};

const PRESETS = {
	blackbird: {
		pitch: 24000,
		timbre: 1,
		wave: "sine",
		rough: 140,
		gate: 0,
		env: 70,
		pitchResp: 70,
		trill: 0,
		trillRate: 14,
		drywet: 100,
		reverb: 15,
	},
	warbler: {
		pitch: 68000,
		timbre: 1,
		wave: "sine",
		rough: 170,
		gate: 0,
		env: 100,
		pitchResp: 100,
		trill: 16,
		trillRate: 20,
		drywet: 100,
		reverb: 18,
	},
	canary: {
		pitch: 76000,
		timbre: 3,
		wave: "triangle",
		rough: 185,
		gate: 0,
		env: 110,
		pitchResp: 110,
		trill: 24,
		trillRate: 24,
		drywet: 100,
		reverb: 18,
	},
	sparrow: {
		pitch: 60000,
		timbre: 3,
		wave: "saw",
		rough: 165,
		gate: 0,
		env: 120,
		pitchResp: 110,
		trill: 8,
		trillRate: 20,
		drywet: 100,
		reverb: 12,
	},
	crow: {
		pitch: 12000,
		timbre: 8,
		wave: "saw",
		rough: 210,
		gate: 0.02,
		env: 80,
		pitchResp: 80,
		trill: 0,
		trillRate: 14,
		drywet: 100,
		reverb: 6,
	},
	duck: {
		pitch: 14000,
		timbre: 5,
		wave: "square",
		rough: 230,
		gate: 0.02,
		env: 100,
		pitchResp: 100,
		trill: 4,
		trillRate: 9,
		drywet: 100,
		reverb: 8,
	},
	owl: {
		pitch: 9000,
		timbre: 1,
		wave: "sine",
		rough: 100,
		gate: 0,
		env: 40,
		pitchResp: 40,
		trill: 2,
		trillRate: 6,
		drywet: 100,
		reverb: 16,
	},
	trainhorn: {
		pitch: 9000,
		timbre: 12,
		wave: "saw",
		rough: 120,
		gate: 0,
		env: 30,
		pitchResp: 25,
		trill: 0,
		trillRate: 14,
		drywet: 100,
		reverb: 30,
	},
	alien: {
		pitch: 20000,
		timbre: 12,
		wave: "square",
		rough: 280,
		gate: 0.005,
		env: 140,
		pitchResp: 140,
		trill: 36,
		trillRate: 26,
		drywet: 100,
		reverb: 30,
	},
};

function setPresetSelected(name) {
	selectedPreset = name;
	document.querySelectorAll("[data-preset]").forEach((btn) => {
		btn.classList.toggle(
			"selected",
			btn.getAttribute("data-preset") === name,
		);
	});
}

function clearPresetSelection() {
	if (selectedPreset == null) return;
	setPresetSelected(null);
}

function applySettings(s) {
	if (!s) return;
	if ("eq" in s) {
		for (let i = 0; i < EQ_BINS; i++) {
			const g = Array.isArray(s.eq) ? s.eq[i] : 0;
			eqGains[i] = clamp(
				Number(g) || 0,
				-EQ_MAX_DB,
				EQ_MAX_DB,
			);
		}
	}
	if (s.eqOn != null) {
		eqOn = !!s.eqOn;
		$("eq-on").checked = eqOn;
	}
	if ("eq" in s || s.eqOn != null) {
		applyEq();
		resetExporters();
		drawViz(false);
	}
	if (s.pitch != null) setRangeValue("pitch", s.pitch);
	if (s.timbre != null) setRangeValue("timbre", s.timbre);
	if (s.wave != null) setSelect("wave", s.wave);
	if (s.shift != null) setRangeValue("shift", s.shift);
	if (s.rough != null) setRangeValue("rough", s.rough);
	if (s.gate != null) setRangeValue("gate", s.gate);
	if (s.env != null) setRangeValue("env", s.env);
	if (s.pitchResp != null)
		setRangeValue("pitchresp", s.pitchResp);
	if (s.trill != null) setRangeValue("trill", s.trill);
	if (s.trillRate != null)
		setRangeValue("trillrate", s.trillRate);
	if (s.grit != null) setCheck("grit", s.grit);
	if (s.autogain != null) setCheck("autogain", s.autogain);
	if (s.drywet != null) setRangeValue("drywet", s.drywet);
	if (s.reverb != null) setRangeValue("reverb", s.reverb);
}

function currentSettings() {
	const eq = eqGains.map((g) => Math.round(g * 10) / 10);
	while (eq.length && eq[eq.length - 1] === 0) eq.pop();
	return {
		drywet: state.drywet,
		reverb: state.reverb,
		pitch: state.pitch,
		timbre: state.timbre,
		wave: state.wave,
		shift: state.shift,
		rough: state.rough,
		gate: state.gate,
		env: state.env,
		pitchResp: state.pitchResp,
		trill: state.trill,
		trillRate: state.trillRate,
		grit: state.grit,
		autogain: state.autogain,
		eqOn,
		eq,
	};
}

function applyPreset(name) {
	const p = PRESETS[name];
	if (!p) return;
	applySettings(p);
	setPresetSelected(name);
}

function setExampleSelected(name) {
	document.querySelectorAll("[data-example]").forEach((btn) => {
		btn.classList.toggle(
			"selected",
			btn.getAttribute("data-example") === name,
		);
	});
}

function setExamplesLoading(name) {
	const loading = Boolean(name);
	const grid = document.querySelector(".examplegrid");
	if (grid) {
		grid.classList.toggle("loading", loading);
		grid.setAttribute("aria-busy", String(loading));
	}
	document.querySelectorAll("[data-example]").forEach((btn) => {
		btn.classList.toggle(
			"loading",
			loading && btn.getAttribute("data-example") === name,
		);
		btn.disabled = loading;
	});
}

function waitForMedia() {
	if (loaded) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error("media timeout"));
		}, 15000);
		const cleanup = () => {
			clearTimeout(timer);
			media.removeEventListener("loadedmetadata", onReady);
			media.removeEventListener("error", onError);
		};
		const onReady = () => {
			cleanup();
			resolve();
		};
		const onError = () => {
			cleanup();
			reject(new Error("media error"));
		};
		media.addEventListener("loadedmetadata", onReady);
		media.addEventListener("error", onError);
	});
}

let loadingExample = false;

async function loadExamplePreset(name) {
	if (loadingExample) return;
	const p = EXAMPLE_PRESETS[name];
	if (!p) return;
	loadingExample = true;
	setExamplesLoading(name);
	try {
		const res = await fetch(`${BASE}${p.media}`);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const blob = await res.blob();
		const file = new File(
			[blob],
			p.media.split("/").pop() || name,
			{ type: blob.type || "video/mp4" },
		);
		await loadFile(file);
		applySettings(p.settings);
		setExampleSelected(name);
		await waitForMedia();
		if (!playing) await togglePlay();
	} catch (err) {
		console.error(err);
		notify(`Could not load the ${name} preset.`, true);
	} finally {
		loadingExample = false;
		setExamplesLoading(null);
	}
}

function randomizeEq() {
	const bumps = [];
	const nB = 2 + Math.floor(Math.random() * 3);
	for (let i = 0; i < nB; i++) {
		bumps.push({
			c: Math.random(),
			g: (Math.random() * 2 - 1) * 9,
			w: 0.05 + Math.random() * 0.15,
		});
	}
	for (let i = 0; i < EQ_BINS; i++) {
		const u = i / (EQ_BINS - 1);
		let g = 0;
		for (const b of bumps) {
			const d = (u - b.c) / b.w;
			g += b.g * Math.exp(-d * d);
		}
		eqGains[i] = clamp(Math.round(g * 10) / 10, -12, 12);
	}
	applyEq();
	resetExporters();
	drawViz(false);
}

const wantRandom = (key) => {
	const el = document.querySelector(`[data-rand="${key}"]`);
	return !!el && el.checked;
};

function randomizeAll() {
	const any =
		document.querySelector(".randbox:checked") ||
		($("rand-eq") && $("rand-eq").checked);
	if (!any) {
		console.warn(
			"Tick at least one box in the “to randomize” column first.",
		);
		return;
	}
	if (wantRandom("pitch"))
		setRangeValue(
			"pitch",
			pick([
				2000, 3000, 5000, 8000, 10000, 12000, 14000, 18000,
				20000, 24000, 28000, 36000, 40000, 48000, 56000,
				64000, 72000, 80000,
			]),
		);
	if (wantRandom("timbre"))
		setRangeValue("timbre", 1 + Math.floor(Math.random() * 12));
	if (wantRandom("wave"))
		setSelect(
			"wave",
			pick(["sine", "triangle", "square", "saw"]),
		);
	if (wantRandom("shift"))
		setRangeValue(
			"shift",
			80 + Math.floor(Math.random() * 521),
		);
	if (wantRandom("rough"))
		setRangeValue(
			"rough",
			60 + Math.floor(Math.random() * 49) * 5,
		);
	if (wantRandom("gate"))
		setRangeValue(
			"gate",
			Math.round(Math.random() * 20) * 0.005,
		);
	if (wantRandom("env"))
		setRangeValue(
			"env",
			20 + Math.floor(Math.random() * 37) * 5,
		);
	if (wantRandom("pitchresp"))
		setRangeValue(
			"pitchresp",
			20 + Math.floor(Math.random() * 37) * 5,
		);
	if (wantRandom("trill"))
		setRangeValue("trill", Math.floor(Math.random() * 61));
	if (wantRandom("trillrate"))
		setRangeValue(
			"trillrate",
			4 + Math.floor(Math.random() * 27),
		);
	if (wantRandom("drywet"))
		setRangeValue(
			"drywet",
			30 + Math.floor(Math.random() * 71),
		);
	if (wantRandom("reverb"))
		setRangeValue("reverb", Math.floor(Math.random() * 61));
	if ($("rand-eq") && $("rand-eq").checked) randomizeEq();
	resetExporters();
	setPresetSelected(null);
}

// ---- Voice analysis ------------------------------------------
// Lightweight YIN pitch detector over the decoded file. It does not
// need to match the worklet's exact filters; it only has to find the
// speaker's pitch range so we can centre the tracker and set the
// output register.
function mixMonoBuffer(buf) {
	const ch = buf.numberOfChannels;
	const n = buf.length;
	const out = new Float32Array(n);
	for (let c = 0; c < ch; c++) {
		const d = buf.getChannelData(c);
		for (let i = 0; i < n; i++) out[i] += d[i];
	}
	if (ch > 1) {
		const inv = 1 / ch;
		for (let i = 0; i < n; i++) out[i] *= inv;
	}
	return out;
}

function decimate(x, factor) {
	const n = Math.floor(x.length / factor);
	const y = new Float32Array(n);
	let sum = 0;
	for (let i = 0; i < x.length; i++) {
		sum += x[i];
		if (i >= factor) sum -= x[i - factor];
		if ((i + 1) % factor === 0)
			y[(i + 1) / factor - 1] = sum / factor;
	}
	return y;
}

function estimateF0Yin(frame, sr, fmin, fmax) {
	const n = frame.length;
	const tauMin = Math.max(2, Math.floor(sr / fmax));
	const tauMax = Math.min(n - 2, Math.ceil(sr / fmin));
	const W = n - tauMax;
	if (W <= 0 || tauMax <= tauMin) return 0;
	const d = new Float32Array(tauMax + 1);
	for (let tau = tauMin; tau <= tauMax; tau++) {
		let s = 0;
		for (let j = 0; j < W; j++) {
			const df = frame[j] - frame[j + tau];
			s += df * df;
		}
		d[tau] = s;
	}
	let running = 0;
	let bestTau = -1;
	let bestVal = 1e9;
	for (let tau = tauMin; tau <= tauMax; tau++) {
		running += d[tau];
		const cmnd =
			running > 0
				? (d[tau] * (tau - tauMin + 1)) / running
				: 1;
		if (cmnd < bestVal) {
			bestVal = cmnd;
			bestTau = tau;
		}
	}
	if (bestTau < 0 || bestVal > 0.35) return 0;
	let t = bestTau;
	if (t > tauMin && t < tauMax) {
		const a = d[t - 1];
		const b = d[t];
		const c = d[t + 1];
		const den = a - 2 * b + c;
		if (den !== 0) t += (0.5 * (a - c)) / den;
	}
	return sr / t;
}

function weightedMedian(vals, wts) {
	const pairs = vals.map((v, i) => [v, wts[i]]);
	pairs.sort((a, b) => a[0] - b[0]);
	let tot = 0;
	for (const p of pairs) tot += p[1];
	let acc = 0;
	for (const p of pairs) {
		acc += p[1];
		if (acc >= tot / 2) return p[0];
	}
	return pairs[pairs.length - 1][0];
}

let voiceStats = null;
let voiceStatsPromise = null;
let autoBusy = false;

function invalidateVoiceStats() {
	voiceStats = null;
	voiceStatsPromise = null;
}

// Turn the detected voice into sensible values for one control.
function autoValues(stats) {
	const shift = clamp(Math.round(stats.med), 80, 600);
	const pitch = clamp(
		Math.round(
			BIRD_TARGET_HZ / (stats.med * VOICE_TO_BIRD) / 250,
		) * 250,
		2000,
		80000,
	);
	const rough = clamp(
		Math.round((60 + stats.spread * 0.9) / 5) * 5,
		60,
		300,
	);
	const nr =
		stats.voicedRms > 0
			? stats.noiseFloor / stats.voicedRms
			: 0;
	const gate =
		nr > 0.03
			? clamp(
				Math.round((nr * 0.12) / 0.005) * 0.005,
				0,
				0.08,
			)
			: 0;
	return { shift, pitch, rough, gate };
}

async function analyseVoice() {
	const buf = exportBuffer;
	if (!buf) throw new Error("Load a recording first.");
	const sr = buf.sampleRate;
	const mono = mixMonoBuffer(buf);
	const factor = Math.max(1, Math.round(sr / 4000));
	let ds = decimate(mono, factor);
	const dsr = sr / factor;
	const MAXS = Math.floor(dsr * 180);
	if (ds.length > MAXS) ds = ds.subarray(0, MAXS);

	const N = 512;
	const hop = 256;
	const fmin = 70;
	const fmax = 600;
	const rmsAll = [];
	for (let s = 0; s + N <= ds.length; s += hop) {
		let e = 0;
		for (let j = 0; j < N; j++) {
			const v = ds[s + j];
			e += v * v;
		}
		rmsAll.push(Math.sqrt(e / N));
		if ((rmsAll.length & 511) === 0) await yieldToUI();
	}
	if (rmsAll.length < 3) {
		throw new Error("That recording is too short to analyse.");
	}
	const sorted = rmsAll.slice().sort((a, b) => a - b);
	const noiseFloor = sorted[Math.floor(sorted.length * 0.1)] || 0;
	const peak = sorted[sorted.length - 1] || 0;
	const thresh = Math.max(noiseFloor * 2.5, peak * 0.05, 0.002);

	const f0s = [];
	const wts = [];
	let voicedSum = 0;
	let idx = 0;
	for (let s = 0; s + N <= ds.length; s += hop) {
		const r = rmsAll[idx++];
		if (r < thresh) continue;
		const f0 = estimateF0Yin(
			ds.subarray(s, s + N),
			dsr,
			fmin,
			fmax,
		);
		if (f0 > 0) {
			f0s.push(f0);
			wts.push(r);
			voicedSum += r;
		}
		if ((idx & 255) === 0) await yieldToUI();
	}
	if (f0s.length < 3) {
		throw new Error(
			"Couldn't find a clear voice pitch in that recording.",
		);
	}
	const arr = f0s.slice().sort((a, b) => a - b);
	const med = weightedMedian(f0s, wts);
	const p10 = arr[Math.floor(arr.length * 0.1)];
	const p90 = arr[Math.floor(arr.length * 0.9)];
	const voicedRms = voicedSum / f0s.length;
	return {
		med,
		p10,
		p90,
		spread: p90 - p10,
		voicedRms,
		noiseFloor,
		voicedFrames: f0s.length,
		totalFrames: rmsAll.length,
	};
}

async function getVoiceStats(epoch = fileEpoch) {
	if (voiceStats && epoch === fileEpoch) return voiceStats;
	if (!exportBuffer) throw new Error("Load a recording first.");
	if (!voiceStatsPromise) {
		voiceStatsPromise = analyseVoice();
	}
	const promise = voiceStatsPromise;
	try {
		const stats = await promise;
		if (epoch === fileEpoch) voiceStats = stats;
		return stats;
	} finally {
		if (voiceStatsPromise === promise) voiceStatsPromise = null;
	}
}

function showAnalysis(stats) {
	const full = Math.max(1, stats.totalFrames);
	console.info(
		`Detected voice: ${Math.round(stats.med)} Hz (range ${Math.round(
			stats.p10,
		)}–${Math.round(stats.p90)} Hz; clear on ${Math.round(
			(stats.voicedFrames / full) * 100,
		)}% of the clip).`,
	);
}

function updateAutoButtons() {
	document.querySelectorAll("[data-auto]").forEach((btn) => {
		btn.disabled = !exportBuffer || autoBusy;
	});
}

async function autoSet(kind) {
	if (!exportBuffer) {
		notify("Load a recording first.", true);
		return;
	}
	if (autoBusy) return;
	const epoch = fileEpoch;
	const btn = document.querySelector(`[data-auto="${kind}"]`);
	autoBusy = true;
	updateAutoButtons();
	let label = "auto";
	if (btn) {
		label = btn.textContent;
		btn.textContent = "…";
		btn.classList.add("busy");
	}
	try {
		const stats = await getVoiceStats(epoch);
		if (epoch !== fileEpoch) return;
		const values = autoValues(stats);
		setRangeValue(kind, values[kind]);
		showAnalysis(stats);
	} catch (err) {
		console.error(err);
	} finally {
		autoBusy = false;
		if (btn) {
			btn.textContent = label;
			btn.classList.remove("busy");
		}
		updateAutoButtons();
	}
}

document
	.querySelectorAll("[data-preset]")
	.forEach((b) =>
		b.addEventListener("click", () =>
			applyPreset(b.getAttribute("data-preset")),
		),
	);
document.querySelectorAll("[data-example]").forEach((b) => {
	b.addEventListener("click", () =>
		loadExamplePreset(b.getAttribute("data-example")),
	);
});

const settingsJSON = () =>
	JSON.stringify(currentSettings(), null, 2);
window.dumpSettings = () => {
	const json = settingsJSON();
	console.log(json);
	return json;
};
window.copySettings = async () => {
	const json = settingsJSON();
	console.log(json);
	try {
		await navigator.clipboard.writeText(json);
		notify("Settings JSON copied to clipboard.");
	} catch (e) {
		notify("Could not copy; the JSON is in the console.", true);
	}
	return json;
};
console.info(
	"Debug: run dumpSettings() to print the current settings as JSON, or copySettings() to also copy it.",
);
document.querySelectorAll("[data-auto]").forEach((b) => {
	b.addEventListener("click", (e) => {
		e.preventDefault();
		e.stopPropagation();
		autoSet(b.getAttribute("data-auto"));
	});
});
$("randomize").addEventListener("click", randomizeAll);

$("volmax").addEventListener("click", () => {
	const vol = $("volume");
	vol.value = vol.max;
	vol.dispatchEvent(new Event("input", { bubbles: true }));
});
playBtn.addEventListener("click", togglePlay);
recordBtn.addEventListener("click", toggleRecording);
window.addEventListener("keydown", (e) => {
	if (e.code !== "Space" && e.key !== " ") return;
	if (e.repeat || e.altKey || e.ctrlKey || e.metaKey) return;
	if (recording || !loaded) return;
	const t = e.target;
	if (t) {
		if (t.isContentEditable) return;
		if (/^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(t.tagName)) return;
		if (
			typeof t.closest === "function" &&
			t.closest('[role="button"]')
		)
			return;
	}
	e.preventDefault();
	togglePlay();
});
$("cqt").addEventListener("click", () => {
	if (loaded) togglePlay();
});
makeWavBtn.addEventListener("click", () => startExport("wav"));
makeMp3Btn.addEventListener("click", () => startExport("mp3"));

progress.addEventListener("pointerdown", () => {
	scrubbing = true;
});
progress.addEventListener("input", () => {
	const dur = duration();
	seek((parseFloat(progress.value) / 1000) * dur);
});
progress.addEventListener("change", () => {
	scrubbing = false;
});
progress.addEventListener("pointerup", () => {
	scrubbing = false;
});
progress.addEventListener("pointercancel", () => {
	scrubbing = false;
});
if (window.ResizeObserver)
	new ResizeObserver(() => drawWaveform()).observe($("waveform"));
else window.addEventListener("resize", drawWaveform);

const transportWave = $("transportwave");
if (transportWave) {
	if (window.ResizeObserver)
		new ResizeObserver(() => drawTransportWave()).observe(transportWave);
	else window.addEventListener("resize", drawTransportWave);
	drawTransportWave();
}

$("drop").addEventListener("click", () => $("file").click());
$("drop").addEventListener("keydown", (e) => {
	if (e.key !== "Enter" && e.key !== " ") return;
	e.preventDefault();
	$("file").click();
});
$("file").addEventListener("change", (e) => {
	if (e.target.files && e.target.files[0])
		loadFile(e.target.files[0]);
});

const dragveil = $("dragveil");
let dragDepth = 0;
const hasFiles = (e) =>
	!!e.dataTransfer &&
	Array.from(e.dataTransfer.types || []).indexOf("Files") !== -1;
window.addEventListener("dragenter", (e) => {
	if (!hasFiles(e)) return;
	e.preventDefault();
	dragDepth++;
	dragveil.hidden = false;
});
window.addEventListener("dragover", (e) => {
	if (!hasFiles(e)) return;
	e.preventDefault();
	e.dataTransfer.dropEffect = "copy";
});
window.addEventListener("dragleave", (e) => {
	if (!hasFiles(e)) return;
	dragDepth = Math.max(0, dragDepth - 1);
	if (dragDepth === 0) dragveil.hidden = true;
});
window.addEventListener("drop", (e) => {
	e.preventDefault();
	dragDepth = 0;
	dragveil.hidden = true;
	const f =
		e.dataTransfer &&
		e.dataTransfer.files &&
		e.dataTransfer.files[0];
	if (f) loadFile(f);
});

resetExporters();
updateAutoButtons();
updateRecordButton();
setPresetSelected("blackbird");
primeCqt();
tick();
