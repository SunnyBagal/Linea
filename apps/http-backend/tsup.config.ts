import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs"],
  target: "node20",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  // Bundle internal workspace packages (@repo/*) into the output so the
  // compiled app is self-contained. Third-party / native deps stay external.
  noExternal: [/^@repo\//],
});
