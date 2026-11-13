import type { APIGatewayProxyEvent } from "aws-lambda";

const JSON_HEADERS = { "Content-Type": "application/json" };

export function jsonResponse(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  };
}

export function emptyJsonResponse(statusCode = 204) {
  return {
    statusCode,
    headers: JSON_HEADERS,
    body: "",
  };
}

export function getAuthenticatedUserId(event: APIGatewayProxyEvent): string | null {
  const claims = event?.requestContext?.authorizer?.claims ?? event?.requestContext?.authorizer?.jwt?.claims;
  const userId = typeof claims?.sub === "string" ? claims.sub.trim() : "";
  return userId.length > 0 ? userId : null;
}
