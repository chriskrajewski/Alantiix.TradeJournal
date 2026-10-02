import { handler, ok, requireValue } from "@/server/api";
import { importPropCsv } from "@/server/prop-csv";
export const POST = handler(async (request: Request) => {
  const reader = request.body?.getReader();
  requireValue(reader, "Choose a CSV file.");
  let size = 0;
  const parts: Uint8Array[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 3 * 1024 * 1024) {
      await reader.cancel();
      requireValue(false, "CSV request is too large.");
    }
    parts.push(value);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(parts).toString("utf8"));
  } catch {
    requireValue(false, "Invalid CSV request.");
  }
  requireValue(
    body && typeof body.content === "string" && ["preview", "import"].includes(body.action),
    "Choose preview or import.",
  );
  return ok(await importPropCsv(body.content, body.action === "preview"));
});
