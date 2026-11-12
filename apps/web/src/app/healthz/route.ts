// Liveness of the web server itself, for the compose healthcheck.
// Deliberately independent of the API so an API outage doesn't take web down too.
export function GET() {
  return Response.json({ status: "ok" });
}
