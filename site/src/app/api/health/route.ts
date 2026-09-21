// Railway healthcheck: the site is up. The engine's state lives in /api/feed/*, not here.
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ ok: true });
}
