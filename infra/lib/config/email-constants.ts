/**
 * REL-54 (feature review S13): sign-up and password-reset email through Amazon SES on billboard-project.com, in two
 * steps. Step 1 (EmailStack, lib/stacks/email.ts) creates the SES identity with Easy DKIM, a custom MAIL FROM
 * subdomain and a configuration set, and the domain's DMARC record (p=none); MonitoringStack alarms on the account's
 * bounce and complaint rates. Step 2 (lib/stacks/user-api-service.ts, docs/RUNBOOK.md 23.4) points the user pool's
 * email at the identity: Cognito sends every code through SES (EmailSendingAccount DEVELOPER) from
 * ACCOUNT_EMAIL_FROM, with the project's copy below.
 */

/** The verified SES domain identity: the domain sign-up and reset emails come from. */
export const EMAIL_DOMAIN = 'billboard-project.com';

/**
 * The custom MAIL FROM domain (the envelope sender, where receiving servers return bounces). A subdomain of
 * EMAIL_DOMAIN that receives no mail of its own: its MX points at SES's feedback endpoint and its own SPF record
 * names SES only. "bounce." says what it is for and stays clear of a host name like "mail." that a mail or web
 * service might want later. The domain's own MX, SPF and other records (Microsoft 365, ShareSiteStack) are untouched.
 */
export const MAIL_FROM_DOMAIN = `bounce.${EMAIL_DOMAIN}`;

/** The SPF record on MAIL_FROM_DOMAIN only. Only SES sends with that envelope domain, so anything else fails. */
export const MAIL_FROM_SPF_RECORD = 'v=spf1 include:amazonses.com -all';

/** The MX priority of MAIL_FROM_DOMAIN's one MX record (SES's feedback endpoint in the stack's region). */
export const MAIL_FROM_MX_PRIORITY = 10;

/** The DMARC record's name: `_dmarc` under EMAIL_DOMAIN, the policy for mail whose From is at the domain. */
export const DMARC_RECORD_NAME = `_dmarc.${EMAIL_DOMAIN}`;

/**
 * Where receivers send DMARC aggregate reports: a Microsoft 365 alias the project makes before step 1's merge and files
 * into a folder (docs/RUNBOOK.md 23.2; reports to an address that does not exist are refused and never resent). It is
 * in EMAIL_DOMAIN itself, so it needs no authorization record in another domain (RFC 7489 7.1 asks for one only when
 * the report address's domain differs from the record's).
 */
export const DMARC_REPORT_ADDRESS = `dmarc@${EMAIL_DOMAIN}`;

/**
 * The DMARC record (project decision 2026-10-29): p=none, monitoring only. Receivers take no action on mail that fails
 * DMARC and send daily aggregate reports to DMARC_REPORT_ADDRESS. Relaxed alignment (the default) lets SES mail pass
 * through DKIM (d=billboard-project.com) and the MAIL FROM SPF, and Microsoft 365 mail through the apex SPF. Stricter
 * policies (quarantine or reject) wait for Microsoft 365 DKIM; docs/RUNBOOK.md 23.6 says why.
 */
export const DMARC_RECORD = `v=DMARC1; p=none; rua=mailto:${DMARC_REPORT_ADDRESS}`;

/**
 * The configuration set every message from the identity uses (the identity's default), and that step 2 also names
 * in the user pool's email configuration. Fixed, so the user pool and MonitoringStack name it without an export.
 */
export const SES_CONFIGURATION_SET_NAME = 'BillboardAccountEmail';

/**
 * The CloudWatch dimension the configuration set's event destination writes its counts under (AWS/SES, one metric
 * per event type). ses:configuration-set is an SES auto-tag on every message sent with a configuration set.
 */
export const SES_EVENT_DIMENSION_NAME = 'ses:configuration-set';

/**
 * The events the configuration set publishes to CloudWatch: counts only, never an address. No open or click events:
 * those would make SES add a tracking pixel and rewrite links in the codes' emails. The account's Virtual
 * Deliverability Manager engagement tracking would do the same whatever the events, so the configuration set turns it
 * off for its mail (lib/stacks/email.ts).
 */
export const SES_PUBLISHED_EVENTS: readonly string[] = ['send', 'delivery', 'bounce', 'complaint', 'reject', 'deliveryDelay'];

/**
 * Alarm thresholds on the account's reputation (AWS/SES Reputation.BounceRate and Reputation.ComplaintRate). SES
 * places an account under review at a 5% bounce rate or a 0.1% complaint rate and may pause its sending at 10% or
 * 0.5%; a paused account sends no sign-up or reset code (once step 2 is live). These fire well before review.
 */
export const SES_BOUNCE_RATE_ALARM_THRESHOLD = 0.03;
export const SES_COMPLAINT_RATE_ALARM_THRESHOLD = 0.0005;

/**
 * REL-54 step 2: the user pool's sender, approved by the project on 2026-10-29 (docs/RUNBOOK.md 23.4). The address is
 * at EMAIL_DOMAIN, the verified identity, so SES signs it with the domain's DKIM key; `no-reply@` is a Microsoft 365
 * alias (on the contact@ shared mailbox), where SES's forwarded bounce and complaint reports land (23.5).
 */
export const ACCOUNT_EMAIL_FROM_NAME = 'Billboard';
export const ACCOUNT_EMAIL_FROM_ADDRESS = `no-reply@${EMAIL_DOMAIN}`;
/** The From header Cognito writes: `Billboard <no-reply@billboard-project.com>`. */
export const ACCOUNT_EMAIL_FROM = `${ACCOUNT_EMAIL_FROM_NAME} <${ACCOUNT_EMAIL_FROM_ADDRESS}>`;
/** Reply-To, so a reply to a code email reaches a person (the contact@ shared mailbox). */
export const ACCOUNT_EMAIL_REPLY_TO = `contact@${EMAIL_DOMAIN}`;

/**
 * The verification message, word for word as the project approved it (2026-10-29). Cognito uses this one template for
 * every code it emails in this pool: the sign-up code, a resent code, the code for a changed email address and the
 * forgot-password code (there is no CustomMessage trigger), so the copy names no single action. `{####}` is where
 * Cognito puts the code. Other wording goes back to the project's maintainers first.
 */
export const VERIFICATION_EMAIL_SUBJECT = 'Your Billboard verification code';
export const VERIFICATION_EMAIL_BODY =
  "Your Billboard verification code is {####}. Enter it in the app to continue. If you didn't ask for this code, you can ignore this email.";
