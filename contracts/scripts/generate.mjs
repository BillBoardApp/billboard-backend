// Generates the TypeScript and Swift contract files under generated/ from the JSON schemas.
//
//   node scripts/generate.mjs           write generated/
//   node scripts/generate.mjs --check   fail when generated/ differs from what the schemas produce
//
// The schemas decide fields, types and optionality. A sub-schema with a `title` becomes a named
// type (TypeScript `title`, Swift `title` without the trailing V1); an object with properties must
// have one. Two schemas may share a title only when they generate the same type. The tables below
// hold the few emission choices a schema cannot express. Dependency-free on purpose.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const contractsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const entity = (name) => `schemas/entities/${name}.v1.schema.json`;

const OUTPUTS = [
  {
    language: "ts",
    file: "generated/ts/user-api-contracts-v1.ts",
    roots: [
      entity("processed-bill"),
      entity("bills-manifest"),
      entity("bills-manifest-snapshot-pointer"),
      entity("congress-member-manifest"),
      entity("processed-congress-member"),
      entity("congress-member-civic-profile"),
      entity("weekly-digest"),
      "openapi/user-api.v1.json#/components/schemas/ApiError",
    ],
  },
  {
    language: "ts",
    file: "generated/ts/release-contracts-v1.ts",
    roots: ["schemas/release/lambda-release-manifest.v1.schema.json"],
  },
  {
    language: "swift",
    file: "generated/swift/UserAPIContractsV1.swift",
    namespace: "UserAPIContractsV1",
    roots: [
      entity("bills-manifest"),
      entity("bills-manifest-snapshot-pointer"),
      entity("congress-member-manifest"),
      entity("processed-congress-member"),
      entity("congress-member-civic-profile"),
      entity("weekly-digest"),
      entity("processed-bill"),
    ],
  },
];

// Named string enums exported to TypeScript as a value list plus a type derived from it.
const TS_VALUE_LISTS = new Map([
  ["BillStatusV1", "BILL_STATUS_VALUES_V1"],
  ["WeeklyDigestAccentV1", "WEEKLY_DIGEST_ACCENT_VALUES_V1"],
  ["WeeklyDigestSectionKindV1", "WEEKLY_DIGEST_SECTION_KIND_VALUES_V1"],
  ["WeeklyDigestItemKindV1", "WEEKLY_DIGEST_ITEM_KIND_VALUES_V1"],
  ["WeeklyDigestBillStateV1", "WEEKLY_DIGEST_BILL_STATE_VALUES_V1"],
  ["CivicProfileAxisV1", "CIVIC_PROFILE_AXES_V1"],
]);
// Named string enums exported to Swift as a static value list (Swift types every enum as String).
const SWIFT_VALUE_LISTS = new Map([["CivicProfileAxisV1", "civicProfileAxes"]]);
// An object whose optional properties are exactly one of these enums' values, all with the same
// schema, is a partial record keyed by that enum: Partial<Record<Key, T>> in TypeScript, [String: T] in Swift.
const RECORD_KEY_ENUMS = ["CivicProfileAxisV1"];
// Enums the schemas enforce but the generated types keep as plain strings, because services build
// these arrays from untyped DynamoDB and S3 data.
const PLAIN_STRING_ENUMS = new Set(["BillSubCategoryV1", "LifeAreaV1"]);
// Swift types that come from these schemas also conform to Equatable (the app compares civic profiles).
const SWIFT_EQUATABLE_ROOTS = new Set([entity("congress-member-civic-profile")]);

const LINE_WIDTH = 120;
const SWIFT_KEYWORDS = new Set(
  (
    "associatedtype break case catch class continue default defer deinit do else enum extension fallthrough false " +
    "fileprivate for func guard if import in init inout internal is let nil operator private protocol public repeat " +
    "rethrows return self Self static struct subscript super switch throw throws true try typealias var where while"
  ).split(" "),
);

// ── Schema loading and $ref resolution ─────────────────────────────────────────────────────────

const documents = new Map();

function loadDocument(file) {
  if (!documents.has(file)) {
    documents.set(file, JSON.parse(fs.readFileSync(path.join(contractsRoot, file), "utf8")));
  }
  return documents.get(file);
}

function resolvePointer(document, pointer, where) {
  let node = document;
  for (const raw of pointer.replace(/^#/, "").split("/").filter(Boolean)) {
    const token = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!node || typeof node !== "object" || !(token in node)) throw new Error(`${where}: cannot resolve ${pointer}`);
    node = node[token];
  }
  return node;
}

/** Resolves "file#pointer" (file relative to `fromFile`, or empty for the same file). */
function locate(reference, fromFile) {
  const [refFile, pointer = ""] = reference.split("#");
  const file = refFile ? path.posix.join(path.posix.dirname(fromFile), refFile) : fromFile;
  return { file, schema: resolvePointer(loadDocument(file), `#${pointer}`, `${fromFile} -> ${reference}`) };
}

function deref(schema, file) {
  let current = { schema, file };
  const seen = new Set();
  while (current.schema && typeof current.schema.$ref === "string") {
    const key = `${current.file}|${current.schema.$ref}`;
    if (seen.has(key)) throw new Error(`${file}: $ref cycle at ${current.schema.$ref}`);
    seen.add(key);
    current = locate(current.schema.$ref, current.file);
  }
  return current;
}

function* walkSchemas(schema, file, seen = new Set()) {
  if (!schema || typeof schema !== "object") return;
  ({ schema, file } = deref(schema, file));
  if (seen.has(schema)) return;
  seen.add(schema);
  yield { schema, file };
  for (const child of Object.values(schema.properties ?? {})) yield* walkSchemas(child, file, seen);
  if (schema.items) yield* walkSchemas(schema.items, file, seen);
  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    yield* walkSchemas(schema.additionalProperties, file, seen);
  }
}

// ── Intermediate model ─────────────────────────────────────────────────────────────────────────
// Type nodes: {kind: "string" | "integer" | "number" | "boolean" | "null" | "unknown"}
//   {kind: "ref", name}                 a named declaration
//   {kind: "enum", values}              string enum or const
//   {kind: "const", value}              non-string const
//   {kind: "array", items}
//   {kind: "record", key, value}        partial record keyed by a RECORD_KEY_ENUMS enum
//   {kind: "map", value}                object without properties (additionalProperties, or unknown)
//   {kind: "union", members}            from a `type` array, in schema order
// Declaration bodies: object {kind: "object", fields: [{name, type, required, description}]},
//   enum {kind: "enum", values}, or record.

function buildModel(roots) {
  const rootEntries = roots.map((root) => {
    const [file, pointer = ""] = root.split("#");
    return { root: file, file, schema: resolvePointer(loadDocument(file), `#${pointer}`, root) };
  });

  const enumValues = new Map();
  for (const { schema, file } of rootEntries) {
    for (const node of walkSchemas(schema, file)) {
      if (node.schema.title && Array.isArray(node.schema.enum)) enumValues.set(node.schema.title, node.schema.enum);
    }
  }

  const declarations = new Map();
  let preOrder = 0;
  let postOrder = 0;
  let currentRoot = null;

  const where = (file, schema) => `${file}${schema.title ? ` (${schema.title})` : ""}`;

  function typeOf(input, inputFile) {
    const { schema, file } = deref(input, inputFile);
    if (schema.title) {
      if (PLAIN_STRING_ENUMS.has(schema.title)) return { kind: "string" };
      declare(schema.title, schema, file);
      return { kind: "ref", name: schema.title };
    }
    return bodyOf(schema, file);
  }

  function declare(name, schema, file) {
    const existing = declarations.get(name);
    if (existing?.inProgress) throw new Error(`${where(file, schema)}: recursive types are not supported`);
    if (!existing) declarations.set(name, { name, inProgress: true, pre: preOrder++ });
    const body = bodyOf(schema, file, name);
    if (existing) {
      if (!sameShape(existing.body, body)) {
        throw new Error(
          `${where(file, schema)}: title ${name} is already used for a different shape (${existing.file})`,
        );
      }
      return;
    }
    Object.assign(declarations.get(name), {
      inProgress: false,
      post: postOrder++,
      body,
      file,
      root: currentRoot,
      description: schema.description,
    });
  }

  // A named type documents itself; an untitled $ref target documents the field that uses it.
  function untitledDescription(property, file) {
    const target = deref(property, file).schema;
    return target.title ? undefined : target.description;
  }

  function recordKeyOf(schema, file) {
    const keys = Object.keys(schema.properties);
    if ((schema.required ?? []).length > 0 || schema.additionalProperties !== false) return null;
    for (const keyEnum of RECORD_KEY_ENUMS) {
      const values = enumValues.get(keyEnum);
      if (!values || values.length !== keys.length || !values.every((value) => keys.includes(value))) continue;
      const valueTypes = keys.map((key) => typeOf(schema.properties[key], file));
      if (valueTypes.every((valueType) => sameShape(valueType, valueTypes[0]))) {
        return { key: keyEnum, value: valueTypes[0] };
      }
    }
    return null;
  }

  function bodyOf(schema, file, declaredName) {
    const unsupported = ["oneOf", "anyOf", "allOf", "not", "if", "patternProperties"].filter((key) => key in schema);
    if (unsupported.length > 0) {
      throw new Error(`${where(file, schema)}: the generator does not support ${unsupported.join(", ")}`);
    }
    if (Array.isArray(schema.type)) {
      return { kind: "union", members: schema.type.map((type) => bodyOf({ ...schema, type, title: undefined }, file)) };
    }
    if (Array.isArray(schema.enum)) {
      if (!schema.enum.every((value) => typeof value === "string"))
        throw new Error(`${where(file, schema)}: only string enums are supported`);
      return { kind: "enum", values: schema.enum };
    }
    if (schema.const !== undefined) {
      return typeof schema.const === "string"
        ? { kind: "enum", values: [schema.const] }
        : { kind: "const", value: schema.const };
    }
    switch (schema.type) {
      case "string":
      case "integer":
      case "number":
      case "boolean":
      case "null":
        return { kind: schema.type };
      case "array":
        return { kind: "array", items: schema.items ? typeOf(schema.items, file) : { kind: "unknown" } };
      case "object": {
        if (!schema.properties) {
          const values = schema.additionalProperties;
          return {
            kind: "map",
            value: values && typeof values === "object" ? typeOf(values, file) : { kind: "unknown" },
          };
        }
        const record = recordKeyOf(schema, file);
        if (record) {
          declare(record.key, { title: record.key, type: "string", enum: enumValues.get(record.key) }, file);
          return { kind: "record", ...record };
        }
        if (!declaredName)
          throw new Error(`${where(file, schema)}: an object with properties needs a title (its type name)`);
        const required = new Set(schema.required ?? []);
        for (const name of required) {
          if (!(name in schema.properties))
            throw new Error(`${where(file, schema)}: required property ${name} is not defined`);
        }
        return {
          kind: "object",
          fields: Object.entries(schema.properties).map(([name, property]) => ({
            name,
            type: typeOf(property, file),
            required: required.has(name),
            description: property.description ?? untitledDescription(property, file),
          })),
        };
      }
      case undefined:
        return { kind: "unknown" };
      default:
        throw new Error(`${where(file, schema)}: unsupported type ${schema.type}`);
    }
  }

  for (const { root, file, schema } of rootEntries) {
    currentRoot = root;
    if (!schema.title) throw new Error(`${root}: the root schema needs a title`);
    typeOf(schema, file);
  }
  return declarations;
}

function sameShape(left, right) {
  const strip = (node) => JSON.stringify(node, (key, value) => (key === "description" ? undefined : value));
  return strip(left) === strip(right);
}

// ── TypeScript ─────────────────────────────────────────────────────────────────────────────────

function tsType(type) {
  switch (type.kind) {
    case "ref":
      return type.name;
    case "string":
    case "number":
    case "boolean":
    case "null":
    case "unknown":
      return type.kind;
    case "integer":
      return "number";
    case "enum":
      return type.values.map((value) => JSON.stringify(value)).join(" | ");
    case "const":
      return JSON.stringify(type.value);
    case "array": {
      const items = tsType(type.items);
      return /[|&\s]/.test(items) ? `Array<${items}>` : `${items}[]`;
    }
    case "record":
      return `Partial<Record<${type.key}, ${tsType(type.value)}>>`;
    case "map":
      return `Record<string, ${tsType(type.value)}>`;
    case "union":
      return type.members.map(tsType).join(" | ");
    default:
      throw new Error(`unknown type kind ${type.kind}`);
  }
}

/** Splits text into lines of at most `width` characters, breaking at spaces. */
function wrap(text, width) {
  const lines = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  return line ? [...lines, line] : lines;
}

function tsComment(description, indent) {
  if (!description) return [];
  const text = description.replaceAll("*/", "* /");
  const single = `${indent}/** ${text} */`;
  if (single.length <= LINE_WIDTH) return [single];
  return [
    `${indent}/**`,
    ...wrap(text, LINE_WIDTH - indent.length - 3).map((line) => `${indent} * ${line}`),
    `${indent} */`,
  ];
}

function tsValueList(constName, values) {
  const inline = `export const ${constName} = [${values.map((value) => JSON.stringify(value)).join(", ")}] as const;`;
  if (inline.length <= LINE_WIDTH) return [inline];
  return [`export const ${constName} = [`, ...values.map((value) => `  ${JSON.stringify(value)},`), "] as const;"];
}

function renderTypeScript(declarations) {
  const all = [...declarations.values()];
  const valueLists = [...TS_VALUE_LISTS.keys()]
    .filter((name) => declarations.has(name))
    .map((name) => declarations.get(name));
  const aliases = all
    .filter((decl) => decl.body.kind !== "object" && !TS_VALUE_LISTS.has(decl.name))
    .sort((a, b) => a.pre - b.pre);
  const interfaces = all.filter((decl) => decl.body.kind === "object").sort((a, b) => a.post - b.post);

  const blocks = [];
  for (const decl of valueLists) {
    if (decl.body.kind !== "enum") throw new Error(`${decl.name} is listed in TS_VALUE_LISTS but is not an enum`);
    const constName = TS_VALUE_LISTS.get(decl.name);
    blocks.push([
      ...tsComment(decl.description, ""),
      ...tsValueList(constName, decl.body.values),
      `export type ${decl.name} = (typeof ${constName})[number];`,
    ]);
  }
  for (const decl of aliases) {
    blocks.push([...tsComment(decl.description, ""), `export type ${decl.name} = ${tsType(decl.body)};`]);
  }
  for (const decl of interfaces) {
    const lines = [...tsComment(decl.description, ""), `export interface ${decl.name} {`];
    for (const field of decl.body.fields) {
      lines.push(
        ...tsComment(field.description, "  "),
        `  ${field.name}${field.required ? "" : "?"}: ${tsType(field.type)};`,
      );
    }
    lines.push("}");
    blocks.push(lines);
  }

  const header = [
    "/*",
    " * GENERATED by contracts/scripts/generate.mjs from the JSON schemas in contracts/. Do not edit by hand:",
    " * change the schema and run `npm run generate`.",
    " */",
  ];
  return `${[header, ...blocks].map((block) => block.join("\n")).join("\n\n")}\n`;
}

// ── Swift ──────────────────────────────────────────────────────────────────────────────────────

const swiftName = (name) => name.replace(/V1$/, "");
const swiftIdentifier = (name) => (SWIFT_KEYWORDS.has(name) ? `\`${name}\`` : name);

/** Returns {type, optional, stringOrInt} for a field type. */
function swiftField(type, declarations, context) {
  if (type.kind === "union") {
    const members = type.members.filter((member) => member.kind !== "null");
    const nullable = members.length !== type.members.length;
    const kinds = members
      .map((member) => member.kind)
      .sort()
      .join(",");
    if (members.length === 1) return { ...swiftField(members[0], declarations, context), optional: nullable };
    if (kinds === "integer,string") return { type: "String", optional: true, stringOrInt: true };
    throw new Error(`${context}: Swift cannot represent the union ${tsType(type)}`);
  }
  return { type: swiftType(type, declarations, context), optional: false };
}

function swiftType(type, declarations, context) {
  switch (type.kind) {
    case "ref": {
      const decl = declarations.get(type.name);
      return decl.body.kind === "enum" ? "String" : swiftName(type.name);
    }
    case "string":
    case "enum":
      return "String";
    case "integer":
      return "Int";
    case "number":
      return "Double";
    case "boolean":
      return "Bool";
    case "const":
      return Number.isInteger(type.value) ? "Int" : typeof type.value === "boolean" ? "Bool" : "Double";
    case "array":
      return `[${swiftType(type.items, declarations, context)}]`;
    case "record":
    case "map":
      return `[String: ${swiftType(type.value, declarations, context)}]`;
    default:
      throw new Error(`${context}: Swift cannot represent ${tsType(type)}`);
  }
}

function swiftComment(description, indent) {
  return description ? wrap(description, LINE_WIDTH - indent.length - 4).map((line) => `${indent}/// ${line}`) : [];
}

function renderSwift(declarations, namespace) {
  const all = [...declarations.values()];
  const valueLists = [...SWIFT_VALUE_LISTS.keys()]
    .filter((name) => declarations.has(name))
    .map((name) => declarations.get(name));
  const typealiases = all.filter((decl) => decl.body.kind === "record").sort((a, b) => a.pre - b.pre);
  const structs = all.filter((decl) => decl.body.kind === "object").sort((a, b) => a.pre - b.pre);

  const blocks = [];
  for (const decl of valueLists) {
    blocks.push([
      `    static let ${SWIFT_VALUE_LISTS.get(decl.name)}: [String] = [`,
      decl.body.values.map((value) => `        ${JSON.stringify(value)}`).join(",\n"),
      "    ]",
    ]);
  }
  for (const decl of typealiases) {
    blocks.push([`    typealias ${swiftName(decl.name)} = ${swiftType(decl.body, declarations, decl.name)}`]);
  }
  for (const decl of structs) {
    const conformances = SWIFT_EQUATABLE_ROOTS.has(decl.root) ? "Decodable, Equatable" : "Decodable";
    const fields = decl.body.fields.map((field) => ({
      ...field,
      ...swiftField(field.type, declarations, `${decl.name}.${field.name}`),
    }));
    const lines = [
      ...swiftComment(decl.description, "    "),
      `    nonisolated struct ${swiftName(decl.name)}: ${conformances} {`,
    ];
    for (const field of fields) {
      const optional = field.optional || !field.required;
      lines.push(
        ...swiftComment(field.description, "        "),
        `        let ${swiftIdentifier(field.name)}: ${field.type}${optional ? "?" : ""}`,
      );
    }
    if (fields.some((field) => field.stringOrInt)) {
      lines.push("", "        private enum CodingKeys: String, CodingKey {");
      for (const field of fields) lines.push(`            case ${swiftIdentifier(field.name)}`);
      lines.push("        }", "", "        init(from decoder: Decoder) throws {");
      lines.push("            let container = try decoder.container(keyedBy: CodingKeys.self)");
      for (const field of fields) {
        const optional = field.optional || !field.required;
        const target = swiftIdentifier(field.name);
        if (field.stringOrInt) {
          lines.push(`            ${target} = try container.decodeStringOrIntIfPresent(forKey: .${field.name})`);
        } else {
          const method = optional ? "decodeIfPresent" : "decode";
          lines.push(`            ${target} = try container.${method}(${field.type}.self, forKey: .${field.name})`);
        }
      }
      lines.push("        }");
    }
    lines.push("    }");
    blocks.push(lines);
  }

  const header = [
    "//",
    "// GENERATED by contracts/scripts/generate.mjs from the JSON schemas in billboard-platform/contracts.",
    "// Do not edit by hand: change the schema, run `npm run generate` there, then copy this file into the",
    "// app with billboard-app/scripts/syncContracts.sh.",
    "//",
    "",
    "import Foundation",
    "",
    "// Every declaration is nonisolated so the app, which defaults to MainActor isolation, can decode these types",
    "// (and compare the Equatable ones) off the main actor.",
    `nonisolated enum ${namespace} {`,
  ];
  const helpers = [
    "}",
    "",
    "// For fields whose schema allows a string or an integer. The first attempt uses try? because decoding a",
    "// number as a String (or a string as an Int) throws typeMismatch; any other type still throws from the second.",
    "nonisolated private extension KeyedDecodingContainer {",
    "    func decodeStringOrIntIfPresent(forKey key: Key) throws -> String? {",
    "        if let stringValue = try? decodeIfPresent(String.self, forKey: key) {",
    "            return stringValue",
    "        }",
    "        if let intValue = try decodeIfPresent(Int.self, forKey: key) {",
    "            return String(intValue)",
    "        }",
    "        return nil",
    "    }",
    "",
    "    func decodeIntIfPresent(forKey key: Key) throws -> Int? {",
    "        if let intValue = try? decodeIfPresent(Int.self, forKey: key) {",
    "            return intValue",
    "        }",
    "        if let stringValue = try decodeIfPresent(String.self, forKey: key) {",
    "            return Int(stringValue)",
    "        }",
    "        return nil",
    "    }",
    "}",
  ];
  return `${header.join("\n")}\n${blocks.map((block) => block.join("\n")).join("\n\n")}\n${helpers.join("\n")}\n`;
}

// ── Main ───────────────────────────────────────────────────────────────────────────────────────

function render(output) {
  const declarations = buildModel(output.roots);
  return output.language === "ts" ? renderTypeScript(declarations) : renderSwift(declarations, output.namespace);
}

function listFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(fullPath) : [fullPath];
  });
}

function main() {
  const checkOnly = process.argv.includes("--check");
  const problems = [];
  let written = 0;

  for (const output of OUTPUTS) {
    const target = path.join(contractsRoot, output.file);
    const content = render(output);
    const current = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;
    if (current === content) continue;
    if (checkOnly) {
      problems.push(`${output.file} is out of date`);
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
      console.log(`wrote ${output.file}`);
      written += 1;
    }
  }

  const expected = new Set(OUTPUTS.map((output) => path.join(contractsRoot, output.file)));
  for (const file of listFiles(path.join(contractsRoot, "generated"))) {
    if (!expected.has(file) && path.basename(file) !== ".DS_Store") {
      problems.push(
        `${path.relative(contractsRoot, file)} is not produced by the generator (delete it, or add it to OUTPUTS)`,
      );
    }
  }

  if (problems.length > 0) {
    console.error(`Generated contracts check failed:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
    if (checkOnly)
      console.error("Run `npm run generate` (in contracts/ or at the repository root) and commit the result.");
    process.exit(1);
  }
  if (written === 0) console.log("Generated contracts are up to date.");
}

try {
  main();
} catch (error) {
  console.error(`Contract generation failed: ${error.message}`);
  process.exit(1);
}
