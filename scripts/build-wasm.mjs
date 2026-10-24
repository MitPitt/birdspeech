import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const cargo = existsSync(join(homedir(), ".cargo/bin/cargo"))
	? join(homedir(), ".cargo/bin/cargo")
	: "cargo";

const build = spawnSync(
	cargo,
	["build", "--release", "--target", "wasm32-unknown-unknown"],
	{
		cwd: join(root, "wasm"),
		stdio: "inherit",
	},
);

if (build.error) {
	console.error(
		"Could not run cargo. Install Rust and the wasm target:\n" +
			"  rustup target add wasm32-unknown-unknown",
	);
	process.exit(1);
}
if (build.status !== 0) process.exit(build.status ?? 1);

const built = join(
	root,
	"wasm/target/wasm32-unknown-unknown/release/birdsong_wasm.wasm",
);
const out = join(root, "public/worklets/birdsong-processor.wasm");
copyFileSync(built, out);
console.log(`wasm: wrote ${out}`);
