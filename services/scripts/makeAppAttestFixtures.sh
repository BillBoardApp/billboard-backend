#!/usr/bin/env bash
# Regenerates the synthetic App Attest certificates the services tests verify attestations
# against (C3 WP-C3a): src/tests/fixtures/appAttest/synthetic-chain.json.
#
# What it makes, all with openssl and none of it Apple's:
#   - a synthetic root CA (P-384) and an unrelated second root (for the wrong-root test);
#   - an intermediate CA (P-384) and an intermediate whose basicConstraints say CA:FALSE;
#   - a P-256 leaf key and a P-384 leaf key;
#   - one leaf certificate per scenario in src/tests/fixtures/appAttest/scenarios.ts, signed by the
#     scenario's intermediate and carrying the scenario's nonce in extension
#     1.2.840.113635.100.8.2 (DER SEQUENCE { [1] { OCTET STRING nonce } }), where
#     nonce = SHA256(authData || SHA256(challenge)) for the authData the scenario describes.
#
# Private keys stay in a temporary directory that is deleted on exit: the JSON holds certificates
# and public keys only. The tests take their clock from the certificates' own validity dates, so
# regenerating never breaks them. Rerun after changing scenarios.ts:
#   bash scripts/makeAppAttestFixtures.sh            (from services/)
set -euo pipefail

cd "$(dirname "$0")/.."
OUT="src/tests/fixtures/appAttest/synthetic-chain.json"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

command -v openssl >/dev/null || { echo "makeAppAttestFixtures: openssl is required" >&2; exit 1; }
[ -d node_modules/ts-node ] || { echo "makeAppAttestFixtures: run npm ci in services/ first" >&2; exit 1; }

CA_DAYS=7300
LEAF_DAYS=3650

cat >"$WORK/req.cnf" <<'EOF'
[req]
distinguished_name = dn
prompt = no
[dn]
CN = placeholder
EOF

cat >"$WORK/root.ext" <<'EOF'
basicConstraints = critical, CA:TRUE
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
EOF

cat >"$WORK/intermediate.ext" <<'EOF'
basicConstraints = critical, CA:TRUE, pathlen:0
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always
EOF

# Allowed to sign (keyCertSign) but not a CA, so only the basicConstraints check rejects it.
cat >"$WORK/notCa.ext" <<'EOF'
basicConstraints = critical, CA:FALSE
keyUsage = critical, keyCertSign, digitalSignature
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always
EOF

ec_key() { openssl genpkey -algorithm EC -pkeyopt "ec_paramgen_curve:$1" -out "$WORK/$2.key" 2>/dev/null; }
csr() { openssl req -new -key "$WORK/$1.key" -subj "$2" -config "$WORK/req.cnf" -out "$WORK/$1.csr"; }
self_sign() {
  openssl x509 -req -in "$WORK/$1.csr" -signkey "$WORK/$1.key" -days "$CA_DAYS" -sha384 \
    -extfile "$WORK/root.ext" -set_serial "$2" -out "$WORK/$1.pem" 2>/dev/null
}
issue() { # name issuer extfile serial days digest
  openssl x509 -req -in "$WORK/$1.csr" -CA "$WORK/$2.pem" -CAkey "$WORK/$2.key" -extfile "$3" \
    -set_serial "$4" -days "$5" "-$6" -out "$WORK/$1.pem" 2>/dev/null
}

ec_key P-384 root
csr root "/CN=Billboard Test App Attestation Root CA/O=Billboard Tests"
self_sign root 1

ec_key P-384 otherRoot
csr otherRoot "/CN=Billboard Test Unrelated Root CA/O=Billboard Tests"
self_sign otherRoot 2

ec_key P-384 ca
csr ca "/CN=Billboard Test App Attestation CA 1/O=Billboard Tests"
issue ca root "$WORK/intermediate.ext" 3 "$CA_DAYS" sha384

ec_key P-384 notCa
csr notCa "/CN=Billboard Test Not A CA/O=Billboard Tests"
issue notCa root "$WORK/notCa.ext" 4 "$CA_DAYS" sha384

for leaf in p256:P-256 p384:P-384; do
  name="${leaf%%:*}"
  ec_key "${leaf##*:}" "$name"
  openssl pkey -in "$WORK/$name.key" -pubout -out "$WORK/$name.pub" 2>/dev/null
done

# One line per scenario: name, leaf key, intermediate, nonce hex (or "absent").
node -r ts-node/register/transpile-only -e '
const fs = require("fs");
const path = require("path");
const s = require("./src/tests/fixtures/appAttest/scenarios.ts");
const work = process.argv[1];
for (const scenario of s.SCENARIOS) {
  const pub = fs.readFileSync(path.join(work, scenario.leaf + ".pub"), "utf8");
  const authData = s.buildAttestationAuthData(scenario.authData, pub);
  const nonce = scenario.nonce === "absent" ? "absent" : s.attestationNonce(authData, s.scenarioChallenge(scenario.name)).toString("hex");
  console.log([scenario.name, scenario.leaf, scenario.intermediate, nonce].join("\t"));
}' "$WORK" >"$WORK/scenarios.tsv"

serial=100
while IFS=$'\t' read -r name leaf intermediate nonce; do
  serial=$((serial + 1))
  {
    echo "basicConstraints = critical, CA:FALSE"
    echo "keyUsage = critical, digitalSignature"
    echo "authorityKeyIdentifier = keyid:always"
    if [ "$nonce" != "absent" ]; then echo "1.2.840.113635.100.8.2 = DER:3024a1220420$nonce"; fi
  } >"$WORK/leaf-$name.ext"
  cp "$WORK/$leaf.key" "$WORK/leaf-$name.key"
  csr "leaf-$name" "/CN=$name/OU=AAA Certification/O=Billboard Tests"
  issue "leaf-$name" "$intermediate" "$WORK/leaf-$name.ext" "$serial" "$LEAF_DAYS" sha256
done <"$WORK/scenarios.tsv"

node -r ts-node/register/transpile-only -e '
const fs = require("fs");
const path = require("path");
const s = require("./src/tests/fixtures/appAttest/scenarios.ts");
const [work, out] = process.argv.slice(1);
const read = (name) => fs.readFileSync(path.join(work, name), "utf8");
const scenarios = {};
for (const scenario of s.SCENARIOS) {
  const pub = read(scenario.leaf + ".pub");
  scenarios[scenario.name] = {
    certificate: read("leaf-" + scenario.name + ".pem"),
    challenge: s.scenarioChallenge(scenario.name),
    authDataHex: s.buildAttestationAuthData(scenario.authData, pub).toString("hex"),
  };
}
const fixture = {
  note: "Synthetic App Attest certificates for tests, made by services/scripts/makeAppAttestFixtures.sh. Not Apple certificates; no private keys.",
  generatedAt: new Date().toISOString(),
  roots: { synthetic: read("root.pem"), other: read("otherRoot.pem") },
  intermediates: { ca: read("ca.pem"), notCa: read("notCa.pem") },
  leafPublicKeys: { p256: read("p256.pub"), p384: read("p384.pub") },
  scenarios,
};
fs.writeFileSync(out, JSON.stringify(fixture, null, 2) + "\n");
console.log("Wrote " + out + " (" + Object.keys(scenarios).length + " scenarios)");
' "$WORK" "$OUT"
