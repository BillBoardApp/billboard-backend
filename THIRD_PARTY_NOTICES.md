# Third-party notices

This repository is licensed under the Apache License 2.0 (see `LICENSE` and `NOTICE`). It depends on, and in places
vendors, the third-party material listed here, which remains under its own licence. npm packages are not vendored:
`npm ci` downloads them, and each carries its own licence file and notices in `node_modules/`. Generated from the
lockfiles when the repository was published; update this list when a runtime dependency is added or removed.

## Vendored data

- `services/src/handlers/preSignUp/disposableDomains.generated.ts`: the domain list of
  [disposable-email-domains](https://github.com/disposable-email-domains/disposable-email-domains), dedicated to the
  public domain under CC0 1.0 Universal. The file header records the upstream commit and checksums.
- Public-domain U.S. government material (bill text, titles and roll-call data from Congress.gov, GovInfo, the House
  Clerk and the Senate) appears in test fixtures. It is not subject to copyright in the United States (17 U.S.C. 105).

## npm packages: services/

Bundled into the Lambda functions (esbuild) and run by the operator scripts. 123 runtime packages (services/package-lock.json).

Licences: Apache-2.0 112, MIT 10, 0BSD 1.

| Package | Version | Licence |
|---|---|---|
| `@aws-crypto/crc32` | 5.2.0 | Apache-2.0 |
| `@aws-crypto/crc32c` | 5.2.0 | Apache-2.0 |
| `@aws-crypto/sha1-browser` | 5.2.0 | Apache-2.0 |
| `@aws-crypto/sha256-browser` | 5.2.0 | Apache-2.0 |
| `@aws-crypto/sha256-js` | 5.2.0 | Apache-2.0 |
| `@aws-crypto/supports-web-crypto` | 5.2.0 | Apache-2.0 |
| `@aws-crypto/util` | 5.2.0 | Apache-2.0 |
| `@aws-sdk/client-bedrock-runtime` | 3.1014.0 | Apache-2.0 |
| `@aws-sdk/client-cloudwatch` | 3.1014.0 | Apache-2.0 |
| `@aws-sdk/client-cognito-identity-provider` | 3.1014.0 | Apache-2.0 |
| `@aws-sdk/client-dynamodb` | 3.1014.0 | Apache-2.0 |
| `@aws-sdk/client-s3` | 3.1014.0 | Apache-2.0 |
| `@aws-sdk/client-secrets-manager` | 3.1014.0 | Apache-2.0 |
| `@aws-sdk/client-sns` | 3.1014.0 | Apache-2.0 |
| `@aws-sdk/client-sqs` | 3.1014.0 | Apache-2.0 |
| `@aws-sdk/client-ssm` | 3.1014.0 | Apache-2.0 |
| `@aws-sdk/core` | 3.973.23 | Apache-2.0 |
| `@aws-sdk/crc64-nvme` | 3.972.5 | Apache-2.0 |
| `@aws-sdk/credential-provider-env` | 3.972.21 | Apache-2.0 |
| `@aws-sdk/credential-provider-http` | 3.972.23 | Apache-2.0 |
| `@aws-sdk/credential-provider-ini` | 3.972.23 | Apache-2.0 |
| `@aws-sdk/credential-provider-login` | 3.972.23 | Apache-2.0 |
| `@aws-sdk/credential-provider-node` | 3.972.24 | Apache-2.0 |
| `@aws-sdk/credential-provider-process` | 3.972.21 | Apache-2.0 |
| `@aws-sdk/credential-provider-sso` | 3.972.23 | Apache-2.0 |
| `@aws-sdk/credential-provider-web-identity` | 3.972.23 | Apache-2.0 |
| `@aws-sdk/dynamodb-codec` | 3.972.24 | Apache-2.0 |
| `@aws-sdk/endpoint-cache` | 3.972.4 | Apache-2.0 |
| `@aws-sdk/eventstream-handler-node` | 3.972.11 | Apache-2.0 |
| `@aws-sdk/middleware-bucket-endpoint` | 3.972.8 | Apache-2.0 |
| `@aws-sdk/middleware-endpoint-discovery` | 3.972.8 | Apache-2.0 |
| `@aws-sdk/middleware-eventstream` | 3.972.8 | Apache-2.0 |
| `@aws-sdk/middleware-expect-continue` | 3.972.8 | Apache-2.0 |
| `@aws-sdk/middleware-flexible-checksums` | 3.974.3 | Apache-2.0 |
| `@aws-sdk/middleware-host-header` | 3.972.8 | Apache-2.0 |
| `@aws-sdk/middleware-location-constraint` | 3.972.8 | Apache-2.0 |
| `@aws-sdk/middleware-logger` | 3.972.8 | Apache-2.0 |
| `@aws-sdk/middleware-recursion-detection` | 3.972.8 | Apache-2.0 |
| `@aws-sdk/middleware-sdk-s3` | 3.972.23 | Apache-2.0 |
| `@aws-sdk/middleware-sdk-sqs` | 3.972.17 | Apache-2.0 |
| `@aws-sdk/middleware-ssec` | 3.972.8 | Apache-2.0 |
| `@aws-sdk/middleware-user-agent` | 3.972.24 | Apache-2.0 |
| `@aws-sdk/middleware-websocket` | 3.972.13 | Apache-2.0 |
| `@aws-sdk/nested-clients` | 3.996.13 | Apache-2.0 |
| `@aws-sdk/region-config-resolver` | 3.972.9 | Apache-2.0 |
| `@aws-sdk/s3-request-presigner` | 3.1014.0 | Apache-2.0 |
| `@aws-sdk/signature-v4-multi-region` | 3.996.11 | Apache-2.0 |
| `@aws-sdk/token-providers` | 3.1014.0 | Apache-2.0 |
| `@aws-sdk/types` | 3.973.6 | Apache-2.0 |
| `@aws-sdk/util-arn-parser` | 3.972.3 | Apache-2.0 |
| `@aws-sdk/util-endpoints` | 3.996.5 | Apache-2.0 |
| `@aws-sdk/util-format-url` | 3.972.8 | Apache-2.0 |
| `@aws-sdk/util-locate-window` | 3.965.5 | Apache-2.0 |
| `@aws-sdk/util-user-agent-browser` | 3.972.8 | Apache-2.0 |
| `@aws-sdk/util-user-agent-node` | 3.973.10 | Apache-2.0 |
| `@aws-sdk/xml-builder` | 3.972.19 | Apache-2.0 |
| `@aws/lambda-invoke-store` | 0.2.4 | Apache-2.0 |
| `@nodable/entities` | 2.1.0 | MIT |
| `@smithy/abort-controller` | 4.2.12 | Apache-2.0 |
| `@smithy/chunked-blob-reader` | 5.2.2 | Apache-2.0 |
| `@smithy/chunked-blob-reader-native` | 4.2.3 | Apache-2.0 |
| `@smithy/config-resolver` | 4.4.13 | Apache-2.0 |
| `@smithy/core` | 3.35.0 | Apache-2.0 |
| `@smithy/credential-provider-imds` | 4.2.12 | Apache-2.0 |
| `@smithy/eventstream-codec` | 4.2.12 | Apache-2.0 |
| `@smithy/eventstream-serde-browser` | 4.2.12 | Apache-2.0 |
| `@smithy/eventstream-serde-config-resolver` | 4.3.12 | Apache-2.0 |
| `@smithy/eventstream-serde-node` | 4.2.12 | Apache-2.0 |
| `@smithy/eventstream-serde-universal` | 4.2.12 | Apache-2.0 |
| `@smithy/fetch-http-handler` | 5.3.15 | Apache-2.0 |
| `@smithy/hash-blob-browser` | 4.2.13 | Apache-2.0 |
| `@smithy/hash-node` | 4.2.12 | Apache-2.0 |
| `@smithy/hash-stream-node` | 4.2.12 | Apache-2.0 |
| `@smithy/invalid-dependency` | 4.2.12 | Apache-2.0 |
| `@smithy/is-array-buffer` | 2.2.0 | Apache-2.0 |
| `@smithy/is-array-buffer` | 4.2.2 | Apache-2.0 |
| `@smithy/md5-js` | 4.2.12 | Apache-2.0 |
| `@smithy/middleware-compression` | 4.6.2 | Apache-2.0 |
| `@smithy/middleware-content-length` | 4.2.12 | Apache-2.0 |
| `@smithy/middleware-endpoint` | 4.4.27 | Apache-2.0 |
| `@smithy/middleware-retry` | 4.4.44 | Apache-2.0 |
| `@smithy/middleware-serde` | 4.2.15 | Apache-2.0 |
| `@smithy/middleware-stack` | 4.2.12 | Apache-2.0 |
| `@smithy/node-config-provider` | 4.3.12 | Apache-2.0 |
| `@smithy/node-http-handler` | 4.5.0 | Apache-2.0 |
| `@smithy/property-provider` | 4.2.12 | Apache-2.0 |
| `@smithy/protocol-http` | 5.3.12 | Apache-2.0 |
| `@smithy/querystring-builder` | 4.2.12 | Apache-2.0 |
| `@smithy/querystring-parser` | 4.2.12 | Apache-2.0 |
| `@smithy/service-error-classification` | 4.2.12 | Apache-2.0 |
| `@smithy/shared-ini-file-loader` | 4.4.7 | Apache-2.0 |
| `@smithy/signature-v4` | 5.3.12 | Apache-2.0 |
| `@smithy/smithy-client` | 4.12.7 | Apache-2.0 |
| `@smithy/types` | 4.19.0 | Apache-2.0 |
| `@smithy/url-parser` | 4.2.12 | Apache-2.0 |
| `@smithy/util-base64` | 4.3.2 | Apache-2.0 |
| `@smithy/util-body-length-browser` | 4.2.2 | Apache-2.0 |
| `@smithy/util-body-length-node` | 4.2.3 | Apache-2.0 |
| `@smithy/util-buffer-from` | 2.2.0 | Apache-2.0 |
| `@smithy/util-buffer-from` | 4.2.2 | Apache-2.0 |
| `@smithy/util-config-provider` | 4.2.2 | Apache-2.0 |
| `@smithy/util-defaults-mode-browser` | 4.3.43 | Apache-2.0 |
| `@smithy/util-defaults-mode-node` | 4.2.47 | Apache-2.0 |
| `@smithy/util-endpoints` | 3.3.3 | Apache-2.0 |
| `@smithy/util-hex-encoding` | 4.2.2 | Apache-2.0 |
| `@smithy/util-middleware` | 4.2.12 | Apache-2.0 |
| `@smithy/util-retry` | 4.2.12 | Apache-2.0 |
| `@smithy/util-stream` | 4.5.20 | Apache-2.0 |
| `@smithy/util-uri-escape` | 4.2.2 | Apache-2.0 |
| `@smithy/util-utf8` | 2.3.0 | Apache-2.0 |
| `@smithy/util-utf8` | 4.2.2 | Apache-2.0 |
| `@smithy/util-waiter` | 4.2.13 | Apache-2.0 |
| `@smithy/uuid` | 1.1.2 | Apache-2.0 |
| `bowser` | 2.14.1 | MIT |
| `fast-xml-builder` | 1.3.1 | MIT |
| `fast-xml-parser` | 5.7.1 | MIT |
| `fflate` | 0.8.3 | MIT |
| `mnemonist` | 0.38.3 | MIT |
| `obliterator` | 1.6.1 | MIT |
| `path-expression-matcher` | 1.6.2 | MIT |
| `strnum` | 2.2.3 | MIT |
| `tslib` | 2.8.1 | 0BSD |
| `xml-naming` | 0.3.0 | MIT |

## npm packages: infra/

Used by the CDK app at synth and deploy time; a few run inside deployed custom resources. 97 runtime packages (infra/package-lock.json).

Licences: Apache-2.0 80, MIT 11, ISC 3, (MIT OR GPL-3.0-or-later) 1, 0BSD 1, BlueOak-1.0.0 1.

| Package | Version | Licence |
|---|---|---|
| `@aws-cdk/asset-awscli-v1` | 2.2.292 | Apache-2.0 |
| `@aws-cdk/asset-node-proxy-agent-v6` | 2.1.3 | Apache-2.0 |
| `@aws-cdk/cloud-assembly-api` (bundled inside its parent package) | 2.2.6 | Apache-2.0 |
| `@aws-cdk/cloud-assembly-schema` | 54.25.0 | Apache-2.0 |
| `@aws-crypto/sha256-browser` | 5.2.0 | Apache-2.0 |
| `@aws-crypto/sha256-js` | 5.2.0 | Apache-2.0 |
| `@aws-crypto/supports-web-crypto` | 5.2.0 | Apache-2.0 |
| `@aws-crypto/util` | 5.2.0 | Apache-2.0 |
| `@aws-sdk/client-secrets-manager` | 3.1014.0 | Apache-2.0 |
| `@aws-sdk/client-sns` | 3.1014.0 | Apache-2.0 |
| `@aws-sdk/core` | 3.973.23 | Apache-2.0 |
| `@aws-sdk/credential-provider-env` | 3.972.21 | Apache-2.0 |
| `@aws-sdk/credential-provider-http` | 3.972.23 | Apache-2.0 |
| `@aws-sdk/credential-provider-ini` | 3.972.23 | Apache-2.0 |
| `@aws-sdk/credential-provider-login` | 3.972.23 | Apache-2.0 |
| `@aws-sdk/credential-provider-node` | 3.972.24 | Apache-2.0 |
| `@aws-sdk/credential-provider-process` | 3.972.21 | Apache-2.0 |
| `@aws-sdk/credential-provider-sso` | 3.972.23 | Apache-2.0 |
| `@aws-sdk/credential-provider-web-identity` | 3.972.23 | Apache-2.0 |
| `@aws-sdk/middleware-host-header` | 3.972.8 | Apache-2.0 |
| `@aws-sdk/middleware-logger` | 3.972.8 | Apache-2.0 |
| `@aws-sdk/middleware-recursion-detection` | 3.972.8 | Apache-2.0 |
| `@aws-sdk/middleware-user-agent` | 3.972.24 | Apache-2.0 |
| `@aws-sdk/nested-clients` | 3.996.13 | Apache-2.0 |
| `@aws-sdk/region-config-resolver` | 3.972.9 | Apache-2.0 |
| `@aws-sdk/token-providers` | 3.1014.0 | Apache-2.0 |
| `@aws-sdk/types` | 3.973.6 | Apache-2.0 |
| `@aws-sdk/util-endpoints` | 3.996.5 | Apache-2.0 |
| `@aws-sdk/util-locate-window` | 3.965.5 | Apache-2.0 |
| `@aws-sdk/util-user-agent-browser` | 3.972.8 | Apache-2.0 |
| `@aws-sdk/util-user-agent-node` | 3.973.10 | Apache-2.0 |
| `@aws-sdk/xml-builder` | 3.972.41 | Apache-2.0 |
| `@aws/cloudformation-validate` (bundled inside its parent package) | 1.7.0-beta | Apache-2.0 |
| `@aws/lambda-invoke-store` | 0.2.4 | Apache-2.0 |
| `@balena/dockerignore` (bundled inside its parent package) | 1.0.2 | Apache-2.0 |
| `@smithy/abort-controller` | 4.2.12 | Apache-2.0 |
| `@smithy/config-resolver` | 4.4.13 | Apache-2.0 |
| `@smithy/core` | 3.23.12 | Apache-2.0 |
| `@smithy/credential-provider-imds` | 4.2.12 | Apache-2.0 |
| `@smithy/fetch-http-handler` | 5.3.15 | Apache-2.0 |
| `@smithy/hash-node` | 4.2.12 | Apache-2.0 |
| `@smithy/invalid-dependency` | 4.2.12 | Apache-2.0 |
| `@smithy/is-array-buffer` | 2.2.0 | Apache-2.0 |
| `@smithy/is-array-buffer` | 4.2.2 | Apache-2.0 |
| `@smithy/middleware-content-length` | 4.2.12 | Apache-2.0 |
| `@smithy/middleware-endpoint` | 4.4.27 | Apache-2.0 |
| `@smithy/middleware-retry` | 4.4.44 | Apache-2.0 |
| `@smithy/middleware-serde` | 4.2.15 | Apache-2.0 |
| `@smithy/middleware-stack` | 4.2.12 | Apache-2.0 |
| `@smithy/node-config-provider` | 4.3.12 | Apache-2.0 |
| `@smithy/node-http-handler` | 4.5.0 | Apache-2.0 |
| `@smithy/property-provider` | 4.2.12 | Apache-2.0 |
| `@smithy/protocol-http` | 5.3.12 | Apache-2.0 |
| `@smithy/querystring-builder` | 4.2.12 | Apache-2.0 |
| `@smithy/querystring-parser` | 4.2.12 | Apache-2.0 |
| `@smithy/service-error-classification` | 4.2.12 | Apache-2.0 |
| `@smithy/shared-ini-file-loader` | 4.4.7 | Apache-2.0 |
| `@smithy/signature-v4` | 5.3.12 | Apache-2.0 |
| `@smithy/smithy-client` | 4.12.7 | Apache-2.0 |
| `@smithy/types` | 4.19.0 | Apache-2.0 |
| `@smithy/url-parser` | 4.2.12 | Apache-2.0 |
| `@smithy/util-base64` | 4.3.2 | Apache-2.0 |
| `@smithy/util-body-length-browser` | 4.2.2 | Apache-2.0 |
| `@smithy/util-body-length-node` | 4.2.3 | Apache-2.0 |
| `@smithy/util-buffer-from` | 2.2.0 | Apache-2.0 |
| `@smithy/util-buffer-from` | 4.2.2 | Apache-2.0 |
| `@smithy/util-config-provider` | 4.2.2 | Apache-2.0 |
| `@smithy/util-defaults-mode-browser` | 4.3.43 | Apache-2.0 |
| `@smithy/util-defaults-mode-node` | 4.2.47 | Apache-2.0 |
| `@smithy/util-endpoints` | 3.3.3 | Apache-2.0 |
| `@smithy/util-hex-encoding` | 4.2.2 | Apache-2.0 |
| `@smithy/util-middleware` | 4.2.12 | Apache-2.0 |
| `@smithy/util-retry` | 4.2.12 | Apache-2.0 |
| `@smithy/util-stream` | 4.5.20 | Apache-2.0 |
| `@smithy/util-uri-escape` | 4.2.2 | Apache-2.0 |
| `@smithy/util-utf8` | 2.3.0 | Apache-2.0 |
| `@smithy/util-utf8` | 4.2.2 | Apache-2.0 |
| `@smithy/uuid` | 1.1.2 | Apache-2.0 |
| `aws-cdk-lib` | 2.265.0 | Apache-2.0 |
| `balanced-match` (bundled inside its parent package) | 4.0.4 | MIT |
| `bowser` | 2.14.1 | MIT |
| `brace-expansion` (bundled inside its parent package) | 5.0.9 | MIT |
| `case` (bundled inside its parent package) | 1.6.3 | (MIT OR GPL-3.0-or-later) |
| `constructs` | 10.6.0 | Apache-2.0 |
| `fs-extra` (bundled inside its parent package) | 11.3.6 | MIT |
| `graceful-fs` (bundled inside its parent package) | 4.2.11 | ISC |
| `ignore` (bundled inside its parent package) | 5.3.2 | MIT |
| `jsonfile` (bundled inside its parent package) | 6.2.1 | MIT |
| `jsonschema` (bundled inside its parent package) | 1.5.0 | MIT |
| `mime-db` (bundled inside its parent package) | 1.52.0 | MIT |
| `mime-types` (bundled inside its parent package) | 2.1.35 | MIT |
| `minimatch` (bundled inside its parent package) | 10.2.5 | BlueOak-1.0.0 |
| `punycode` (bundled inside its parent package) | 2.3.1 | MIT |
| `semver` (bundled inside its parent package) | 7.8.5 | ISC |
| `tslib` | 2.8.1 | 0BSD |
| `universalify` (bundled inside its parent package) | 2.0.1 | MIT |
| `yaml` (bundled inside its parent package) | 1.10.3 | ISC |

## npm packages: contracts/

Development tools only. 0 runtime packages (contracts/package-lock.json).
