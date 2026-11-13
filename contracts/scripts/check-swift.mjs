// Compiles generated/swift/UserAPIContractsV1.swift and decodes every entity fixture with it.
// Needs swiftc (Xcode or a Swift toolchain), so it is not part of `npm run check`; run it after
// changing a schema or the Swift emitter:   npm run check:swift
// It compiles as the app does (Swift 6 checking, MainActor default isolation) and decodes from a
// nonisolated context, so a generated type whose Decodable conformance is main-actor isolated fails to compile.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const contractsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const swiftFile = path.join(contractsRoot, "generated/swift/UserAPIContractsV1.swift");
const fixtureDir = path.join(contractsRoot, "fixtures/entities");

try {
  execFileSync("swiftc", ["--version"], { stdio: "ignore" });
} catch {
  console.error("check:swift needs swiftc on PATH.");
  process.exit(1);
}

const cases = fs
  .readdirSync(fixtureDir)
  .filter((name) => name.endsWith(".valid.json"))
  .sort()
  .map((name) => {
    const schemaFile = path.join(contractsRoot, "schemas/entities", name.replace(/\.valid\.json$/, ".schema.json"));
    const { title } = JSON.parse(fs.readFileSync(schemaFile, "utf8"));
    return { fixture: path.join(fixtureDir, name), type: `UserAPIContractsV1.${title.replace(/V1$/, "")}` };
  });

const main = `import Foundation

nonisolated func check<T: Decodable>(_ type: T.Type, _ file: String) -> Bool {
    do {
        _ = try JSONDecoder().decode(type, from: Data(contentsOf: URL(fileURLWithPath: file)))
        print("ok    \\(T.self) <- \\((file as NSString).lastPathComponent)")
        return true
    } catch {
        print("FAIL  \\(T.self) <- \\((file as NSString).lastPathComponent): \\(error)")
        return false
    }
}

nonisolated func checkAll() -> [Bool] {
    [
${cases.map(({ fixture, type }) => `        check(${type}.self, ${JSON.stringify(fixture)}),`).join("\n")}
    ]
}

let results = await Task.detached { checkAll() }.value
exit(results.allSatisfy { $0 } ? 0 : 1)
`;

const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), "contracts-swift-"));
try {
  fs.writeFileSync(path.join(buildDir, "main.swift"), main);
  const binary = path.join(buildDir, "check");
  // Swift 6 checking with the app's MainActor default isolation (see the header).
  const flags = ["-swift-version", "6", "-default-isolation", "MainActor"];
  execFileSync("swiftc", [...flags, "-o", binary, swiftFile, path.join(buildDir, "main.swift")], { stdio: "inherit" });
  execFileSync(binary, { stdio: "inherit" });
  console.log("Swift contract decodes every entity fixture.");
} catch {
  process.exitCode = 1;
} finally {
  fs.rmSync(buildDir, { recursive: true, force: true });
}
