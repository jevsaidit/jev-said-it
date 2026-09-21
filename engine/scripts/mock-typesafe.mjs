// Fake TypeSafe for tests: answers like /v1/systemone and logs what it receives.
// p = 0.62 if the price rose in the last hour, 0.38 otherwise: deterministic and recognisable.
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
const [port, log] = [Number(process.argv[2] ?? 18181), process.argv[3] ?? "/dev/null"];
createServer((req, res) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => {
    appendFileSync(log, JSON.stringify({ url: req.url, auth: req.headers.authorization, body: JSON.parse(b || "{}") }) + "\n");
    if (req.headers.authorization !== "Bearer sk-mock") return res.writeHead(401).end("unauthorized");
    const up = (JSON.parse(b).state?.priceChange1h ?? 0) > 0;
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ answers: { up: { noul: up ? 0.62 : 0.38, confidence: 0.6 } }, model: "jev-1.13.0" }));
  });
}).listen(port, "127.0.0.1");
