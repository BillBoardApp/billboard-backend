<!-- Write "none" instead of deleting a section. Never paste personal data, credentials or production logs. -->

## Summary

<!-- What changed and why. Link the issue it addresses. Add before/after screenshots for visible website changes. -->

## Test evidence

- [ ] `npm run setup`, then `npm run verify` passes at the repo root with no warnings (paste the `Tests:` lines)
- [ ] Infra changes: reviewed `infra/cdk.out/` after `npm run synth` for replaced or deleted resources
- [ ] Website changes: served locally with `python3 -m http.server 8080 --bind 127.0.0.1 --directory website` and
      checked the changed pages

## Impact

- Resources replaced or deleted (tables, buckets, queues, secrets, the Cognito pool, alarms):
- Contract changes (schema, fixture and `generated/` together; a breaking change needs a new versioned file):
- App impact (`contracts/generated/swift` changed: run `./scripts/syncContracts.sh` in `billboard-ios`):

## Deploy notes

<!-- What the project's maintainers should look for in the diff run before they deploy (docs/DEPLOYING.md): the
     stacks and Lambdas you expect to change, a switch that moves, anything to check after the deploy. -->

## App Store impact

<!-- "none", or the app change and release this needs, and whether the server change must be live first. -->

## Checklist

- [ ] I agree that this contribution is licensed under Apache-2.0 (see CONTRIBUTING.md).
- [ ] My commits use my GitHub noreply address (CONTRIBUTING.md, "Licence of contributions").
- [ ] No secrets, tokens, keys, `.env*` files or real user data in code, fixtures, logs or screenshots.
- [ ] Contract changes are made only under `contracts/`.

## AI assistance

<!-- "none", or the tool and what it wrote. -->
