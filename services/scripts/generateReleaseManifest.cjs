#!/usr/bin/env node

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const cp = require("child_process");

const repoRoot = path.join(__dirname, "..");

function parseArgs(argv) {
  const args = {
    releaseId: "",
    bucket: "billboard-lambda-artifacts",
    out: path.join(repoRoot, "release-manifest.json"),
    version: "",
    environment: "prod",
    prefix: "",
    zipDir: repoRoot,
    repository: "",
    commitSha: "",
    branch: "",
    runtime: "nodejs24.x",
    handler: "dist/index.handler",
    contentAddressedPrefix: "artifacts",
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--release-id") {
      args.releaseId = String(next || "").trim();
      i += 1;
    } else if (arg === "--bucket") {
      args.bucket = String(next || "").trim();
      i += 1;
    } else if (arg === "--out") {
      args.out = path.resolve(repoRoot, String(next || "").trim());
      i += 1;
    } else if (arg === "--version") {
      args.version = String(next || "").trim();
      i += 1;
    } else if (arg === "--environment") {
      args.environment = String(next || "").trim();
      i += 1;
    } else if (arg === "--prefix") {
      args.prefix = String(next || "").trim();
      i += 1;
    } else if (arg === "--zip-dir") {
      args.zipDir = path.resolve(repoRoot, String(next || "").trim());
      i += 1;
    } else if (arg === "--repository") {
      args.repository = String(next || "").trim();
      i += 1;
    } else if (arg === "--commit-sha") {
      args.commitSha = String(next || "").trim();
      i += 1;
    } else if (arg === "--branch") {
      args.branch = String(next || "").trim();
      i += 1;
    } else if (arg === "--runtime") {
      args.runtime = String(next || "").trim();
      i += 1;
    } else if (arg === "--handler") {
      args.handler = String(next || "").trim();
      i += 1;
    } else if (arg === "--content-addressed-prefix") {
      args.contentAddressedPrefix = String(next || "")
        .trim()
        .replace(/^\/+|\/+$/g, "");
      i += 1;
    } else {
      throw new Error(`Unknown arg: ${arg}`);
    }
  }

  if (!args.releaseId) {
    throw new Error("Missing required --release-id");
  }

  if (!args.prefix) {
    args.prefix = `releases/${args.releaseId}`;
  }
  if (!args.contentAddressedPrefix) {
    throw new Error("Missing required --content-addressed-prefix");
  }

  return args;
}

function runGit(args) {
  try {
    return cp.execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function toFunctionName(logicalName) {
  if (!logicalName) return logicalName;
  return logicalName.charAt(0).toUpperCase() + logicalName.slice(1);
}

function sha256OfFile(filePath) {
  const hash = crypto.createHash("sha256");
  const data = fs.readFileSync(filePath);
  hash.update(data);
  return hash.digest("hex");
}

function stripVersionSuffix(baseName, version) {
  if (!version) return baseName;
  const suffix = `-${version}`;
  return baseName.endsWith(suffix) ? baseName.slice(0, -suffix.length) : baseName;
}

function findZipFiles(zipDir, version) {
  const entries = fs.readdirSync(zipDir, { withFileTypes: true });
  let files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".zip"))
    .map((entry) => path.join(zipDir, entry.name));

  if (version) {
    const expectedSuffix = `-${version}.zip`;
    files = files.filter((f) => f.endsWith(expectedSuffix));
  }

  return files.sort();
}

function validateManifestShape(manifest) {
  if (manifest.schemaVersion !== 1) throw new Error("Manifest schemaVersion must be 1");
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
    throw new Error("Manifest artifacts must be a non-empty array");
  }

  const logicalNames = new Set();
  const functionNames = new Set();
  for (const artifact of manifest.artifacts) {
    if (!artifact.logicalName) throw new Error("Artifact missing logicalName");
    if (!artifact.functionName) throw new Error(`Artifact ${artifact.logicalName} missing functionName`);
    if (!artifact.s3Key) throw new Error(`Artifact ${artifact.logicalName} missing s3Key`);
    if (!artifact.releaseS3Key) throw new Error(`Artifact ${artifact.logicalName} missing releaseS3Key`);
    if (!artifact.sha256 || !/^[a-f0-9]{64}$/.test(artifact.sha256)) {
      throw new Error(`Artifact ${artifact.logicalName} has invalid sha256`);
    }
    if (logicalNames.has(artifact.logicalName)) {
      throw new Error(`Duplicate logicalName in artifacts: ${artifact.logicalName}`);
    }
    if (functionNames.has(artifact.functionName)) {
      throw new Error(`Duplicate functionName in artifacts: ${artifact.functionName}`);
    }
    logicalNames.add(artifact.logicalName);
    functionNames.add(artifact.functionName);
  }
}

function main() {
  const args = parseArgs(process.argv);

  if (!fs.existsSync(args.zipDir)) {
    throw new Error(`zip directory does not exist: ${args.zipDir}`);
  }

  const zipFiles = findZipFiles(args.zipDir, args.version);
  if (zipFiles.length === 0) {
    throw new Error(`No zip files found in ${args.zipDir}${args.version ? ` for version ${args.version}` : ""}`);
  }

  const commitSha = args.commitSha || runGit(["rev-parse", "HEAD"]);
  const branch = args.branch || runGit(["rev-parse", "--abbrev-ref", "HEAD"]);
  const repository = args.repository || process.env.GITHUB_REPOSITORY || "BillBoardApp/billboard-backend";

  const artifacts = zipFiles.map((zipPath) => {
    const fileName = path.basename(zipPath);
    const withoutExt = fileName.replace(/\.zip$/, "");
    const logicalName = stripVersionSuffix(withoutExt, args.version);
    const stats = fs.statSync(zipPath);
    const sha256 = sha256OfFile(zipPath);

    return {
      logicalName,
      functionName: toFunctionName(logicalName),
      runtime: args.runtime,
      handler: args.handler,
      s3Bucket: args.bucket,
      s3Key: `${args.contentAddressedPrefix}/${logicalName}/${sha256}.zip`,
      releaseS3Key: `${args.prefix}/${logicalName}.zip`,
      sizeBytes: stats.size,
      sha256,
    };
  });

  const manifest = {
    schemaVersion: 1,
    releaseId: args.releaseId,
    createdAt: new Date().toISOString(),
    service: "billboard-services",
    environment: args.environment,
    git: {
      repository,
      commitSha,
      branch,
    },
    artifacts,
  };

  validateManifestShape(manifest);

  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`Wrote release manifest: ${args.out}`);
  console.log(`Artifacts: ${artifacts.length}`);
}

try {
  main();
} catch (error) {
  console.error(error.message || error);
  process.exit(1);
}
