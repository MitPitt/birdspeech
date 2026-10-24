import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mediaDir = path.join(root, "public", "examples");
const force = process.argv.includes("--force");
const ffmpeg = process.env.FFMPEG || "ffmpeg";

function hasBinary(name) {
	try {
		execFileSync(name, ["-version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

const videos = existsSync(mediaDir)
	? readdirSync(mediaDir)
		.filter((name) => name.toLowerCase().endsWith(".mp4"))
		.sort()
	: [];

if (videos.length === 0) {
	console.log("thumbnails: no example videos found");
	process.exit(0);
}

const missing = [];
const stale = [];

for (const name of videos) {
	const source = path.join(mediaDir, name);
	const target = path.join(mediaDir, `${path.parse(name).name}.jpg`);
	if (!existsSync(target)) {
		missing.push(source);
	} else if (force || statSync(target).mtimeMs < statSync(source).mtimeMs) {
		stale.push(source);
	}
}

const pending = [...missing, ...stale];

if (pending.length === 0) {
	console.log(`thumbnails: ${videos.length} up to date`);
	process.exit(0);
}

if (!hasBinary(ffmpeg)) {
	if (missing.length > 0) {
		console.error(
			`thumbnails: ffmpeg not found, cannot generate ${missing.length} missing thumbnail(s)`,
		);
		console.error(
			"thumbnails: install ffmpeg or set FFMPEG, or add the .jpg files manually",
		);
		process.exit(1);
	}
	console.warn(
		`thumbnails: ffmpeg not found, keeping ${stale.length} existing thumbnail(s)`,
	);
	process.exit(0);
}

for (const source of pending) {
	const target = path.join(mediaDir, `${path.parse(source).name}.jpg`);
	execFileSync(
		ffmpeg,
		[
			"-hide_banner",
			"-loglevel",
			"error",
			"-y",
			"-i",
			source,
			"-frames:v",
			"1",
			"-vf",
			"scale=480:-2",
			"-q:v",
			"4",
			"-an",
			target,
		],
		{ stdio: "inherit" },
	);
	console.log(`thumbnails: ${path.relative(root, target)}`);
}
