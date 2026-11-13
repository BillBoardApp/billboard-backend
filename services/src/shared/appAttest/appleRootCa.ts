import { X509Certificate } from "node:crypto";

/**
 * Apple App Attestation Root CA, pinned. Source: https://www.apple.com/certificateauthority/
 * Apple_App_Attestation_Root_CA.pem, linked from https://www.apple.com/certificateauthority/private/
 * (checked 2026-10-08; that page publishes no fingerprint, so the fingerprint below is the one
 * computed from Apple's file). P-384, self-signed, valid 2020-03-18 to 2045-03-15, serial
 * 0BF3BE0EF1CDD2E0FB8C6E721F621798. Nothing is fetched at runtime; a unit test asserts the
 * fingerprint, the subject and the self-signature.
 */
export const APPLE_APP_ATTESTATION_ROOT_CA_PEM = `-----BEGIN CERTIFICATE-----
MIICITCCAaegAwIBAgIQC/O+DvHN0uD7jG5yH2IXmDAKBggqhkjOPQQDAzBSMSYw
JAYDVQQDDB1BcHBsZSBBcHAgQXR0ZXN0YXRpb24gUm9vdCBDQTETMBEGA1UECgwK
QXBwbGUgSW5jLjETMBEGA1UECAwKQ2FsaWZvcm5pYTAeFw0yMDAzMTgxODMyNTNa
Fw00NTAzMTUwMDAwMDBaMFIxJjAkBgNVBAMMHUFwcGxlIEFwcCBBdHRlc3RhdGlv
biBSb290IENBMRMwEQYDVQQKDApBcHBsZSBJbmMuMRMwEQYDVQQIDApDYWxpZm9y
bmlhMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAERTHhmLW07ATaFQIEVwTtT4dyctdh
NbJhFs/Ii2FdCgAHGbpphY3+d8qjuDngIN3WVhQUBHAoMeQ/cLiP1sOUtgjqK9au
Yen1mMEvRq9Sk3Jm5X8U62H+xTD3FE9TgS41o0IwQDAPBgNVHRMBAf8EBTADAQH/
MB0GA1UdDgQWBBSskRBTM72+aEH/pwyp5frq5eWKoTAOBgNVHQ8BAf8EBAMCAQYw
CgYIKoZIzj0EAwMDaAAwZQIwQgFGnByvsiVbpTKwSga0kP0e8EeDS4+sQmTvb7vn
53O5+FRXgeLhpJ06ysC5PrOyAjEAp5U4xDgEgllF7En3VcE3iexZZtKeYnpqtijV
oyFraWVIyd/dganmrduC1bmTBGwD
-----END CERTIFICATE-----
`;

/** SHA-256 of the root's DER, lower-case hex. */
export const APPLE_APP_ATTESTATION_ROOT_CA_SHA256 = "1cb9823ba28ba6ad2d33a006941de2ae4f513ef1d4e831b9f7e0fa7b6242c932";

let root: X509Certificate | undefined;

/** The pinned root, parsed once per container. */
export const appleAppAttestationRoot = (): X509Certificate =>
  (root ??= new X509Certificate(APPLE_APP_ATTESTATION_ROOT_CA_PEM));
