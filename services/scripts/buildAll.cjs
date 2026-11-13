const { build } = require("esbuild");
const fs = require("fs");
const path = require("path");

const lambdaDir = path.join(__dirname, "../src/handlers");
console.log("Looking in:", lambdaDir);

async function buildAll() {
  const folders = fs.readdirSync(lambdaDir).sort((a, b) => a.localeCompare(b));
  const failures = [];
  console.log("Folders found:", folders);

  for (const folder of folders) {
    const indexFile = path.join(lambdaDir, folder, "index.ts");
    console.log(`Checking: ${indexFile}`);
    if (fs.existsSync(indexFile)) {
      console.log(`Found index.ts in ${folder}`);
      const outDir = path.join(lambdaDir, folder, "dist");
      fs.rmSync(outDir, { recursive: true, force: true });
      fs.mkdirSync(outDir, { recursive: true });

      try {
        await build({
          entryPoints: [indexFile],
          bundle: true,
          platform: "node",
          target: "node24",
          outfile: path.join(outDir, "index.js"),
        });
        console.log(`✅ Built Lambda: ${folder}`);
      } catch (err) {
        console.error(`❌ Failed to build Lambda: ${folder}`, err);
        failures.push(folder);
      }
    } else {
      console.log(`No index.ts in ${folder}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`Failed to build Lambda(s): ${failures.join(", ")}`);
  }
}

buildAll().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
