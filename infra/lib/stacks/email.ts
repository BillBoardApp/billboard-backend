import * as cdk from 'aws-cdk-lib';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as ses from 'aws-cdk-lib/aws-ses';
import { Construct } from 'constructs';
import {
  DMARC_RECORD,
  DMARC_RECORD_NAME,
  EMAIL_DOMAIN,
  MAIL_FROM_DOMAIN,
  MAIL_FROM_MX_PRIORITY,
  MAIL_FROM_SPF_RECORD,
  SES_CONFIGURATION_SET_NAME,
  SES_EVENT_DIMENSION_NAME,
  SES_PUBLISHED_EVENTS,
} from '../config/email-constants';

export interface EmailStackProps extends cdk.StackProps {
  /**
   * The Route 53 hosted zone of EMAIL_DOMAIN. The app passes HOSTED_ZONE_ID (deployment-identity.ts), as do the
   * tests; unset, the zone is looked up by name, which needs AWS credentials or a cached lookup.
   */
  readonly hostedZoneId?: string;
}

/**
 * REL-54 step 1: the SES sending identity for billboard-project.com (lib/config/email-constants.ts).
 *
 * - The domain identity with Easy DKIM (2048-bit keys) and its three DKIM CNAME records (`<token>._domainkey`) in the
 *   existing public hosted zone. SES verifies the domain through them, usually within minutes of the deploy.
 * - The custom MAIL FROM domain `bounce.billboard-project.com`: its MX (SES's feedback endpoint) and its own SPF TXT.
 *   If SES cannot find the MX when it sends, it falls back to amazonses.com instead of refusing the message.
 * - The configuration set `BillboardAccountEmail`, the identity's default, which publishes send, delivery, bounce,
 *   complaint, reject and delivery-delay counts to CloudWatch, keeps bounced and complained addresses on the
 *   suppression list, and records per-set reputation. It overrides three account-level SES settings to off for its
 *   mail (VDM engagement tracking and optimized shared delivery, Auto Validation), so the codes go out unaltered, at
 *   once and to every address. MonitoringStack alarms on the account's reputation.
 * - The domain's DMARC record `_dmarc.billboard-project.com` (project decision 2026-10-29): p=none, monitoring only,
 *   with aggregate reports to dmarc@billboard-project.com. It covers Microsoft 365 mail as well as SES's.
 *
 * It adds records under new names only. The domain's own records (the Microsoft 365 MX, the apex SPF and verification
 * TXT, autodiscover, the site's alias records) stay in ShareSiteStack, unchanged. Since step 2 the user pool sends
 * every code through the identity (docs/RUNBOOK.md 23.4). It names the identity by its fixed ARN
 * (arn:<partition>:ses:<region>:<account>:identity/billboard-project.com) and the configuration set by name, so no
 * CloudFormation export is needed and this stack never becomes un-updatable because another stack imports from it.
 * Cognito sends with its service-linked role (AWSServiceRoleForAmazonCognitoIdpEmailService), which needs no sending
 * authorization policy on an identity in the same account, so the identity has none.
 *
 * A stack of its own with no dependencies, created right after SharedInfraStack, so `cdk deploy --all` deploys it
 * before the service stacks: a failed create rolls back only this stack and the run stops before anything else
 * changes. UserAPIServiceStack depends on it (step 2, ordering only), so a new account creates the identity before
 * the pool names it.
 */
export class EmailStack extends cdk.Stack {
  public readonly emailIdentity: ses.EmailIdentity;
  public readonly configurationSet: ses.ConfigurationSet;

  constructor(scope: Construct, id: string, props: EmailStackProps = {}) {
    super(scope, id, props);

    const hostedZone = props.hostedZoneId
      ? route53.HostedZone.fromHostedZoneAttributes(this, 'EmailHostedZone', {
          hostedZoneId: props.hostedZoneId,
          zoneName: EMAIL_DOMAIN,
        })
      : route53.HostedZone.fromLookup(this, 'EmailHostedZone', { domainName: EMAIL_DOMAIN });

    this.configurationSet = new ses.ConfigurationSet(this, 'AccountEmailConfigurationSet', {
      configurationSetName: SES_CONFIGURATION_SET_NAME,
      reputationMetrics: true,
      sendingEnabled: true,
      // An address that hard-bounced or complained is not mailed again (the account-level list holds it), which
      // keeps one mistyped address, retried, from adding bounce after bounce. RUNBOOK 23.5 says how to release one.
      suppressionReasons: ses.SuppressionReasons.BOUNCES_AND_COMPLAINTS,
      // The account has Virtual Deliverability Manager on (set in the console, outside this app), and a set without
      // VdmOptions takes the account's settings. Off for this set, so every code email goes out as written and at
      // once: engagement tracking would add an open-tracking pixel and wrap links, and optimized shared delivery may
      // hold a message back ("preemptive delays", which AWS advises against for critical mail) while a reset code
      // expires in an hour. RUNBOOK 23.1; turning either on for the codes is a project decision.
      vdmOptions: { engagementMetrics: false, optimizedSharedDelivery: false },
    });
    // The same for SES Auto Validation (also on for the account): it would score every recipient and drop the send
    // to any address below its threshold, reported only as a bounce (EmailValidationSuppressed) while Cognito still
    // tells the app the code was sent, at a validation fee per message. Off for this set, so every code is attempted
    // and a bounce is a real one (RUNBOOK 23.1, 23.5). The L2 construct has no property for it.
    (this.configurationSet.node.defaultChild as ses.CfnConfigurationSet).addPropertyOverride(
      'SuppressionOptions.ValidationOptions',
      { ConditionThreshold: { ConditionThresholdEnabled: 'DISABLED' } },
    );
    this.configurationSet.addEventDestination('CloudWatchEvents', {
      configurationSetEventDestinationName: 'CloudWatchEvents',
      destination: ses.EventDestination.cloudWatchDimensions([
        {
          name: SES_EVENT_DIMENSION_NAME,
          source: ses.CloudWatchDimensionSource.MESSAGE_TAG,
          defaultValue: SES_CONFIGURATION_SET_NAME,
        },
      ]),
      events: SES_PUBLISHED_EVENTS.map((event) => event as ses.EmailSendingEvent),
    });

    // Identity.domain, not publicHostedZone: with a hosted zone CDK writes its own MAIL FROM SPF ("~all"). The
    // records are written below instead, with the stricter SPF the MAIL FROM domain can carry.
    this.emailIdentity = new ses.EmailIdentity(this, 'EmailIdentity', {
      identity: ses.Identity.domain(EMAIL_DOMAIN),
      dkimIdentity: ses.DkimIdentity.easyDkim(ses.EasyDkimSigningKeyLength.RSA_2048_BIT),
      dkimSigning: true,
      mailFromDomain: MAIL_FROM_DOMAIN,
      mailFromBehaviorOnMxFailure: ses.MailFromBehaviorOnMxFailure.USE_DEFAULT_VALUE,
      configurationSet: this.configurationSet,
      // SES also emails each bounce and complaint to the sending address (no-reply@, since step 2), with the
      // recipient's address in it; the CloudWatch counts carry none. Kept on: it is the only per-message detail.
      feedbackForwarding: true,
    });

    // The three Easy DKIM CNAMEs. Their names come from SES (<token>._domainkey.billboard-project.com), so they are
    // written as full names, as CDK's own Easy DKIM records are.
    this.emailIdentity.dkimRecords.forEach((record, index) => {
      new route53.CfnRecordSet(this, `DkimRecord${index + 1}`, {
        hostedZoneId: hostedZone.hostedZoneId,
        name: record.name,
        type: 'CNAME',
        resourceRecords: [record.value],
        ttl: '1800',
      });
    });

    new route53.MxRecord(this, 'MailFromMxRecord', {
      zone: hostedZone,
      recordName: MAIL_FROM_DOMAIN,
      values: [{ priority: MAIL_FROM_MX_PRIORITY, hostName: `feedback-smtp.${this.region}.amazonses.com` }],
      ttl: cdk.Duration.minutes(30),
    });
    new route53.TxtRecord(this, 'MailFromSpfRecord', {
      zone: hostedZone,
      recordName: MAIL_FROM_DOMAIN,
      values: [MAIL_FROM_SPF_RECORD],
      ttl: cdk.Duration.minutes(30),
    });

    // DMARC, monitoring only (p=none): receivers act on no message and send aggregate reports to dmarc@, an address
    // in the domain itself, so no authorization record elsewhere is needed. A stricter policy waits for Microsoft 365
    // DKIM: without it, Microsoft 365 mail a receiver forwards on fails DMARC (RUNBOOK 23.6).
    new route53.TxtRecord(this, 'DmarcRecord', {
      zone: hostedZone,
      recordName: DMARC_RECORD_NAME,
      values: [DMARC_RECORD],
      ttl: cdk.Duration.minutes(30),
    });

    new cdk.CfnOutput(this, 'EmailIdentityName', {
      value: this.emailIdentity.emailIdentityName,
      description: 'SES domain identity (REL-54). Check it with: aws sesv2 get-email-identity --email-identity <this>',
    });
    new cdk.CfnOutput(this, 'EmailConfigurationSetName', {
      value: this.configurationSet.configurationSetName,
      description: 'SES configuration set every message from the identity uses (REL-54)',
    });
  }
}
