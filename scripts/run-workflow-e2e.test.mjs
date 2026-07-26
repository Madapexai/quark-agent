import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import test from "node:test";

test("refuses to run when the configured port is already in use", async (t) => {
  const occupiedServer = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("stale server");
  });

  await new Promise((resolve, reject) => {
    occupiedServer.once("error", reject);
    occupiedServer.listen(0, "127.0.0.1", resolve);
  });
  t.after(
    () =>
      new Promise((resolve, reject) => {
        occupiedServer.close((error) => (error ? reject(error) : resolve()));
      }),
  );

  const address = occupiedServer.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");

  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/run-workflow-e2e.mjs"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        WORKFLOW_E2E_PORT: String(address.port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";

    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        output += chunk;
      });
    }

    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, output, signal }));
  });

  assert.equal(result.signal, null);
  assert.notEqual(result.code, 0);
  assert.match(result.output, /already in use/u);
});
