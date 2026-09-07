import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

// In the empty-repo skeleton (A1) there are no TypeScript inputs yet; tsc would
// fail with TS18003 "No inputs were found in config file". Skip typecheck until
// packages start adding sources under packages/*/src or packages/*/test.
function hasTsSources(directory) {
	if (!existsSync(directory)) return false;
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue;
			if (hasTsSources(join(directory, entry.name))) return true;
		} else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
			return true;
		}
	}
	return false;
}

if (!hasTsSources("packages")) {
	console.log("check-tsc: no TypeScript sources under packages/, skipping");
	process.exit(0);
}

const tscBin = join(process.cwd(), "node_modules", "typescript", "bin", "tsc");
const result = spawnSync(process.execPath, [tscBin, "--noEmit", "-p", "tsconfig.json"], {
	stdio: "inherit",
});
process.exit(result.status ?? 1);
