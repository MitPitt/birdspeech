import { createBio } from "@biomorphic/ca-core";
import type { BioEngine } from "@biomorphic/ca-core";
import { materials } from "@biomorphic/ca-flora";

const DESKTOP_QUERY = "(min-width: 1080px)";

let bio: ReturnType<typeof createBio> | null = null;
let waiting: BioEngine[] = [];
let settleFrame = 0;

function pollSettled() {
	settleFrame = 0;
	const next: BioEngine[] = [];
	for (const engine of waiting) {
		if (engine.settled) engine.instant = true;
		else next.push(engine);
	}
	waiting = next;
	if (waiting.length) settleFrame = requestAnimationFrame(pollSettled);
}

function waitForGrowth(engines: BioEngine[]) {
	waiting = engines;
	if (waiting.length) settleFrame = requestAnimationFrame(pollSettled);
}

function start() {
	if (bio) return;
	bio = createBio({
		materials,
		material: "spikes",
		upsample: "nearest",
		cellSize: 2,
		speed: 1,
		params: {
			height: 120,
			sharpness: 16,
			curve: 0,
			roughness: 0.0,
			wander: 0.0,
			drift: 0.9,
			driftScale: 20,
			spacing: 4,
			inset: 0,
			seedChance: 0.3,
			dirs: 32,
			style: 4,
		},
		worker: () =>
			new Worker(new URL("./bio.worker.ts", import.meta.url), {
				type: "module",
			}),
	});
	bio.scan();
	const engines: BioEngine[] = [];
	for (const group of bio.groups()) {
		const engine = bio.engine(group);
		if (!engine) continue;
		engine.wake();
		engines.push(engine);
	}
	waitForGrowth(engines);
}

function stop() {
	if (settleFrame) cancelAnimationFrame(settleFrame);
	settleFrame = 0;
	waiting = [];
	bio?.destroy();
	bio = null;
}

const desktop = window.matchMedia(DESKTOP_QUERY);

function sync() {
	if (desktop.matches) start();
	else stop();
}

desktop.addEventListener("change", sync);

if (document.fonts) document.fonts.ready.then(sync);
else sync();

import.meta.hot?.dispose(stop);
