import tailwind from "bun-plugin-tailwind";

const result = await Bun.build({
  entrypoints: ["src/web/index.html"],
  outdir: "dist",
  minify: true,
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  plugins: [tailwind],
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exitCode = 1;
} else {
  for (const output of result.outputs)
    console.log(`${output.path} (${output.size} bytes)`);
}
