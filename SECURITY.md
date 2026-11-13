# Security policy

This policy covers both Billboard repositories, `billboard-backend` and `billboard-ios`, and the hosted service
built from them.

## Reporting a problem

Report security problems privately. Do not open a public issue, discussion or pull request about them.

- **Preferred:** GitHub private vulnerability reporting. Open the **Security** tab of either repository and choose
  **Report a vulnerability**. The report stays private between you and the project.
- **If you cannot use GitHub:** email contact@billboard-project.com with "Security" in the subject.

Say what you found, where (file and line, API route, web page or app screen), how to reproduce it, and what harm it
could do. Keep any proof of concept small, and leave out other people's data.

We aim to reply within a few working days and to keep you updated until the problem is fixed. Please give us
reasonable time to fix it before you share it, and tell us when you plan to publish.

## In scope

- The code in both repositories.
- The hosted service: billboard-project.com and its subdomains (the website and share pages), and the sign-in and
  API the app uses (our configuration of them; problems in AWS itself go to AWS).
- The Billboard app's App Store and TestFlight builds.

## Out of scope

- Services run by others, such as AWS, Apple, GitHub, Congress.gov or the Census Bureau's geocoder. Report those to
  them.
- Scanner output, or missing headers and best-practice settings, with no harm shown.
- The anti-abuse limits and thresholds themselves. They are in the code on purpose. A way around one is in scope.
- Social engineering, phishing and physical attacks.
- Copies of the code that someone else runs.

## Rules for testing

- Test against your own deployment where you can (see
  ["Deploying your own copy"](https://github.com/BillBoardApp/billboard-backend/blob/main/infra/README.md#deploying-your-own-copy)).
  Use the hosted service only to confirm a problem.
- Use only accounts you created, no more than two. Never read, change or delete anyone else's account, votes or
  data. If you reach someone else's data by accident, stop, do not keep or share it, and tell us.
- No denial of service: no load tests, floods, password guessing, high-volume scans, or bulk sign-ups or votes.
  Show a problem with as few requests as you can.
- Votes count toward results other people see. Keep test votes to a few, and list the bills you voted on in your
  report.
- Do not enter other people's email addresses or street addresses.
- Stop as soon as you can show the problem, and report it.

## Safe harbor

If you follow this policy in good faith, we treat your testing as authorized. We will not take legal action against
you or ask anyone else to. If someone else does, we will say you followed this policy. This promise comes from the
project only. It cannot give permission for services run by others.

## Supported versions

Fixes go to `main`. The hosted service gets them when `main` is deployed. The app gets them in the next App Store
release. Older versions are not patched separately, and the service can ask users to update.
