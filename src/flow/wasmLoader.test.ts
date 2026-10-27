// Regression guard for the production WASM bundling fix. The loader must
// use a statically analyzable dynamic import so Vite bundles the wasm-pack
// glue and emits the .wasm asset. A non-literal specifier with @vite-ignore
// leaves `import("../wasm/pkg/gearflow_wasm.js")` in the dist chunk, which
// resolves to a file that is never emitted, so ?wasm=1 silently falls back
// to the TS solver in production.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const loaderPath = join(dirname(fileURLToPath(import.meta.url)), "wasmLoader.ts");

describe("wasmLoader bundling", () => {
    it("uses a statically analyzable wasm-pack specifier", () => {
        const source = readFileSync(loaderPath, "utf8");
        expect(source).toContain('import("@/wasm/pkg/gearflow_wasm")');
        expect(source).not.toContain("@vite-ignore");
    });
});
