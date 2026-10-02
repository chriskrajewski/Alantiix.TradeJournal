import { handler, ok, bad, requireValue } from "@/server/api";
import { propData, propHistory, mutateProp, PropConflict } from "@/server/prop-firms";
export const GET = handler(async (request: Request) => {
  const params = new URL(request.url).searchParams;
  return ok(
    params.has("history")
      ? { history: await propHistory(params.get("type") ?? "", params.get("history")!) }
      : await propData(),
  );
});
export const POST = handler(async (request: Request) => {
  const reader = request.body?.getReader();
  requireValue(reader, "Provide a tracker action.");
  let size = 0;
  const parts: Uint8Array[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 32_000) {
      await reader.cancel();
      requireValue(false, "Tracker requests must be smaller than 32 KB.");
    }
    parts.push(value);
  }
  const raw = Buffer.concat(parts).toString("utf8");
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return bad("Invalid tracker request.");
  }
  requireValue(
    body && typeof body === "object" && !Array.isArray(body),
    "Provide a tracker action.",
  );
  try {
    return ok(await mutateProp(body));
  } catch (error) {
    if (error instanceof PropConflict) return bad(error.message, 409);
    throw error;
  }
});
