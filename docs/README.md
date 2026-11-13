# docs

- [DEPLOYING.md](DEPLOYING.md): how a change reaches production, and what the deploy workflow checks on the way.
- [RUNBOOK.md](RUNBOOK.md): why the operations runbook the code cites is not here.

The rest of the documentation is next to the code:

- [README.md](../README.md): what is here and how to build and test it
- [contracts/README.md](../contracts/README.md): the API contracts
- [services/README.md](../services/README.md): every Lambda handler and the operator scripts
- [infra/README.md](../infra/README.md): the CDK app, its stacks and how to deploy your own copy
- [website/README.md](../website/README.md): the public site

## Glossary: the IDs in code comments

Billboard was built in a private repository before it was published, and its comments, test names and evaluation
data still cite the project's internal trackers, plans and runbook. Those documents are not public, and the references
are kept rather than stripped: removing them would touch hundreds of files and force a full redeploy for no change in
behaviour. They are cleaned up gradually, alongside real changes. The code next to such a reference is meant to stand
on its own; if it does not, open an issue and we will explain it in the code.

| You see | It means |
|---|---|
| `RUNBOOK 14.2`, `docs/RUNBOOK.md 4.6`, `RUNBOOK section 21.5` | A section of the project's operations runbook (incidents, recovery, data repairs, switch changes). Not public |
| `REL-53`, `UX-33`, `INT-05`, `CAP-02`, `LLM-11`, `APPF-23`, `UA-09`, `CB-07`, `WEB-07`, `OBS-21`, `CON-08`, `SEC-02`, `INF-15`, `REC-04`, `CQ-15`, `P0-06` and similar | An item in one of the project's trackers: reliability (`REL`), user experience (`UX`), integrity (`INT`), capacity (`CAP`), the language models (`LLM`), app features (`APPF`), accounts (`UA`), the sign-up checks (`CB`), the website (`WEB`), observability (`OBS`), deploys and their consistency (`CON`), security (`SEC`), the infrastructure findings of the open-source readiness review (`INF`), and older review series (`REC`, `CQ`, `P0`, and others) |
| `project decision 2026-10-28`, `decision D8`, `decision O1`, `decision 8A` | A choice the project made and recorded in its tracker, by date or by the ID it had in a plan |
| `C1`, `C2`, `C3 3.1`, `section 6`, `the integration plan`, `spec 4.2` | A section of an internal design plan (C1 to C3 are the account-integrity work: monitoring, sign-up checks, App Attest) |
| `U9`, `U11`, `switchover` | Steps of the one-time move of the four earlier repositories into this one |
| `S13`, `S17`, `feature review` | Items of an internal feature review |
| `gap G1`, `checklist item 7`, `the privacy draft` | Items of the privacy review behind the current privacy policy |
| `billboard-platform`, `billboard-app` | The earlier private names of this repository and of `billboard-ios`. Old references such as `billboard-platform#12` point at the archived private repositories |

Production facts that are not in the code (counts of users or votes, logs, deploy records) stay out of this
repository, its issues and its pull requests.
