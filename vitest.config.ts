// The tests, run as Node runs src/ (type stripping, nothing built first).

import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: [
			"tests/*.test.ts",
			"tests/unit/*.test.ts",
			"tests/ts/runtime.test.ts",
		],
		// The fastest pool where the tests tolerate shared state, as these do: each restores
		// what it changes (globalThis.fetch, temporary files).
		pool: "threads",
		isolate: false,
		coverage: {
			provider: "v8",
			// The table only: no report files.
			reporter: ["text"],
			include: ["src/**/*.ts"],
			// bin.ts runs only as a process (tests/bin.test.ts), which coverage does not measure.
			exclude: ["src/bin.ts"],
			thresholds: { lines: 100, branches: 100, functions: 100 },
		},
	},
});
