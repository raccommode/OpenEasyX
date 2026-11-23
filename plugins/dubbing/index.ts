import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { definePlugin, type DubbingResult } from "../../packages/plugin-sdk/index.js";
import subtitleLanguages from "../../packages/translation-languages.json" with { type: "json" };

const supported = new Set(["en", "fr", "es", "de", "it", "pt", "ru", "ja", "ko", "zh"]);
const languages = subtitleLanguages.filter(({ code }) => supported.has(code)).map(({ code, label }) => ({ code, label }));

export default definePlugin({
  manifest: {
    id: "org.easyx.dubbing", name: "Local Dubbing", version: "1.2.0", author: "Open EasyX",
    capabilities: ["video-dubbing"], dubbingLanguages: languages, dubbingRenderVersion: "2",
    description: "Clone each speaker’s voice, translate the dialogue and synchronize visible lips locally.",
    settings: [
      ...languages.map(({ code, label }) => ({ key: code, label, type: "boolean" as const, default: false })),
      { key: "oldestFirst", label: "Process oldest videos first", type: "boolean", default: false },
    ],
  },
  async renderDub({ signal }, job, report) {
    signal?.throwIfAborted();
    await mkdir(job.workDir, { recursive: true, mode: 0o700 });
    const jobFile = path.join(job.workDir, `.render-${randomUUID()}.json`);
    try {
      // A library with many long source paths can exceed the OS limit for a single argument.
      await writeFile(jobFile, JSON.stringify(job), { flag: "wx", mode: 0o600 });
      signal?.throwIfAborted();
      const grouped = process.platform !== "win32";
      const child = spawn(process.env.EASYX_DUBBING_PYTHON || "python3", [fileURLToPath(new URL("./pipeline.py", import.meta.url)), jobFile], {
        detached: grouped, stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, EASYX_DUBBING_PARENT: "1", PYTHONUNBUFFERED: "1", HF_HUB_DISABLE_TELEMETRY: "1", TOKENIZERS_PARALLELISM: "false" },
      });
      let error = "";
      let setupError: Error | undefined;
      let outcome: DubbingResult | undefined;
      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        if (!line.startsWith("EASYX ")) return;
        try {
          const event = JSON.parse(line.slice(6));
          if (event.errorCode === "DUBBING_RUNTIME_SETUP" && typeof event.message === "string") {
            setupError = Object.assign(new Error(event.message), { code: event.errorCode });
          }
          if (typeof event.phase === "string" && Number.isFinite(event.progress)) report(event.phase, event.progress);
          if (event.outcome === "rendered" && Number.isSafeInteger(event.lipSyncFrames) && event.lipSyncFrames >= 0) {
            outcome = { outcome: "rendered", lipSyncFrames: event.lipSyncFrames };
          } else if (["rendered", "original", "silent"].includes(event.outcome)) outcome = event.outcome;
        } catch { /* Ignore non-protocol model output. */ }
      });
      child.stderr.setEncoding("utf8").on("data", (chunk) => { error = (error + chunk).slice(-2000); });
      return await new Promise((resolve, reject) => {
        const stop = () => {
          if (child.pid) try { process.kill(grouped ? -child.pid : child.pid, "SIGTERM"); } catch { /* Already exited. */ }
        };
        signal?.addEventListener("abort", stop, { once: true });
        if (signal?.aborted) stop();
        child.once("error", (cause) => {
          signal?.removeEventListener("abort", stop);
          reject(Object.assign(new Error(cause.message, { cause }), { code: "DUBBING_RUNTIME_SETUP" }));
        });
        child.once("close", (code) => {
          signal?.removeEventListener("abort", stop);
          lines.close();
          if (setupError) reject(setupError);
          else if (code === 0 && outcome) resolve(outcome);
          else reject(new Error(error.trim().slice(-1000) || `Dubbing worker stopped (exit ${code})`));
        });
      });
    } finally {
      await rm(jobFile, { force: true });
    }
  },
});
