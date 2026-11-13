#!/usr/bin/env node

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const fixedZipDate = new Date("1980-01-01T00:00:00Z");

function parseArgs(argv) {
  const args = {
    handlersDir: path.join(repoRoot, "src", "handlers"),
    outDir: repoRoot,
    version: process.env.LAMBDA_VERSION || "",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) {
        throw new Error(`Missing value for ${arg}`);
      }
      return argv[i];
    };

    if (arg === "--handlers-dir") {
      args.handlersDir = path.resolve(next());
    } else if (arg === "--out-dir") {
      args.outDir = path.resolve(next());
    } else if (arg === "--version") {
      args.version = next();
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/packageLambdas.cjs --version <version> [options]

Options:
  --handlers-dir <path>  Handler root directory. Default: src/handlers
  --out-dir <path>       Directory for generated zip files. Default: repo root
`);
}

function assertZipAvailable() {
  const result = spawnSync("zip", ["-v"], { encoding: "utf8" });
  if (result.error) {
    throw new Error("The `zip` command is required to package Lambdas. Install zip in the build environment.");
  }
}

function listHandlers(handlersDir) {
  return fs
    .readdirSync(handlersDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

function collectFiles(rootDir, currentDir = rootDir) {
  const entries = fs.readdirSync(currentDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));

  const files = [];

  for (const entry of entries) {
    const absolutePath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(rootDir, absolutePath));
    } else if (entry.isFile()) {
      files.push(path.relative(rootDir, absolutePath).split(path.sep).join("/"));
    }
  }

  return files;
}

function touchTree(rootDir) {
  const entries = fs.readdirSync(rootDir, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      touchTree(absolutePath);
    }
    fs.utimesSync(absolutePath, fixedZipDate, fixedZipDate);
  }

  fs.utimesSync(rootDir, fixedZipDate, fixedZipDate);
}

function packageLambda({ distDir, lambdaName, outDir, version }) {
  const files = collectFiles(distDir);
  if (files.length === 0) {
    console.log(`No files found for ${lambdaName}, skipping`);
    return null;
  }

  touchTree(distDir);
  fs.mkdirSync(outDir, { recursive: true });

  const outputPath = path.join(outDir, `${lambdaName}-${version}.zip`);
  fs.rmSync(outputPath, { force: true });

  const result = spawnSync("zip", ["-X", "-q", outputPath, "-@"], {
    cwd: distDir,
    input: `${files.join("\n")}\n`,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(`Failed to package ${lambdaName}: ${result.stderr || result.stdout || "zip exited with an error"}`);
  }

  return outputPath;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  if (!args.version) {
    throw new Error("Missing required --version value.");
  }

  assertZipAvailable();

  const packaged = [];
  for (const lambdaName of listHandlers(args.handlersDir)) {
    const entrypoint = path.join(args.handlersDir, lambdaName, "index.ts");
    if (!fs.existsSync(entrypoint)) {
      console.log(`No index.ts found for ${lambdaName}, skipping`);
      continue;
    }

    const distDir = path.join(args.handlersDir, lambdaName, "dist");
    if (!fs.existsSync(distDir)) {
      console.log(`No dist found for ${lambdaName}, skipping`);
      continue;
    }

    const outputPath = packageLambda({
      distDir,
      lambdaName,
      outDir: args.outDir,
      version: args.version,
    });
    if (outputPath) {
      packaged.push(outputPath);
      console.log(`Packaged ${lambdaName} -> ${path.relative(repoRoot, outputPath)}`);
    }
  }

  console.log(`Packaged ${packaged.length} Lambda artifact(s).`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
