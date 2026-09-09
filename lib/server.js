// Booting the game's own Express server against the sandbox.
//
// server.js calls app.listen() at module scope and exports the listener, so
// importing it IS starting it — deliberate, and already relied on by the game's
// own runtimeJsonShape.test.js. PORT=0 asks the OS for a free port, which keeps
// concurrent runs from colliding the way a hard-coded port would.
//
// Because the module is cached per process, ONE server per process. Comparing two
// branches needs --isolate to fork, not a second call here.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { assertSandboxed } from "./safety.js";

/** Swallow the server's startup chatter without hiding real warnings. */
const muteConsole = () => {
  const original = console.log;
  console.log = () => {};
  return () => {
    console.log = original;
  };
};

export const startServer = async ({ target, sandbox, port = 0, quiet = true } = {}) => {
  if (!target?.path) throw new Error("[harness server] startServer needs a resolved target");
  if (!sandbox?.dataDir) throw new Error("[harness server] startServer needs a sandbox");

  // The environment IS the isolation. Set before the import, because dataDir.js
  // resolves DATA_DIR once at module load and never looks again.
  process.env.OH_DATA_DIR = sandbox.dataDir;
  process.env.OH_ASSETS_DIR = sandbox.assetsDir;
  process.env.PORT = String(port);
  // The server pings a Cloudflare Worker to count scenario imports. A test run has
  // no business phoning home, and an empty value is the documented off switch
  // (server.js:856 returns an empty object when it is unset).
  process.env.OH_IMPORT_COUNTER_URL = "";

  const entry = pathToFileURL(path.join(target.path, "server", "server.js")).href;

  // The mute has to outlast the import: app.listen's callback logs "Server
  // running at ..." and fires after the module has finished evaluating, so
  // unmuting any earlier lets that line through on every single run.
  const unmute = quiet ? muteConsole() : () => {};
  let module;
  let httpServer;
  try {
    module = await import(entry);

    httpServer = module.httpServer;
    if (!httpServer) {
      throw new Error(
        `[harness server] ${entry} did not export httpServer — the branch may have restructured it`,
      );
    }

    await new Promise((resolve, reject) => {
      // `listening` flips synchronously inside listen(), but the 'listening'
      // EVENT — and with it the server's own "Server running at ..." callback —
      // is emitted a tick later. Resolving on the flag alone unmutes before that
      // callback runs, which is exactly how the log line kept escaping.
      if (httpServer.listening) return setImmediate(resolve);
      const onListening = () => {
        httpServer.off("error", onError);
        resolve();
      };
      const onError = (error) => {
        httpServer.off("listening", onListening);
        reject(error);
      };
      httpServer.once("listening", onListening);
      httpServer.once("error", onError);
    });
  } finally {
    unmute();
  }

  const address = httpServer.address();
  const actualPort = typeof address === "object" && address ? address.port : Number(port);
  const baseUrl = `http://127.0.0.1:${actualPort}`;

  // Guard 1, asserted a SECOND time — and this is the assertion that matters.
  // The first one checked a path we computed; this one reads back what the game's
  // own resolver actually decided, closing the gap where OH_DATA_DIR was set too
  // late, spelled wrong, or clobbered by something in between.
  const { DATA_DIR } = await import(pathToFileURL(path.join(target.path, "server", "dataDir.js")).href);
  assertSandboxed(DATA_DIR, "resolved server DATA_DIR");

  const stop = async () => {
    // Keep-alive sockets will hold close() open otherwise, which is how a harness
    // run ends up hanging after its work is done.
    httpServer.closeAllConnections?.();
    await new Promise((resolve) => httpServer.close(resolve));
  };

  return { baseUrl, port: actualPort, httpServer, dataDir: DATA_DIR, stop };
};
