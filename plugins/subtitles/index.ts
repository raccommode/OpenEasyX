import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { definePlugin } from "../../packages/plugin-sdk/index.js";
import { normalizeSubtitleContent } from "./import.js";
import languages from "../../packages/translation-languages.json" with { type: "json" };

export default definePlugin({
  manifest: {
    id: "org.easyx.subtitles",
    name: "Local Subtitles",
    version: "1.1.0",
    author: "Open EasyX",
    description: "Transcribe library videos with Whisper and translate their subtitles locally. Models download on first use.",
    capabilities: ["subtitle-generation"],
    subtitleLanguages: languages.map(({ code, label }) => ({ code, label })),
  },
  importSubtitle: normalizeSubtitleContent,
  async runSubtitleWorker({ signal }, { dataDir, mediaDir, databasePath, languages }) {
    if (signal?.aborted) return;
    const grouped = process.platform !== "win32";
    const worker = spawn(process.env.EASYX_SUBTITLE_PYTHON || "python3", [fileURLToPath(new URL("./worker.py", import.meta.url))], {
      detached: grouped,
      stdio: ["pipe", "inherit", "inherit"],
      env: {
        ...process.env,
        EASYX_DATA_DIR: dataDir,
        EASYX_MEDIA_DIR: mediaDir,
        EASYX_SUBTITLE_DATABASE: databasePath,
        EASYX_SUBTITLE_LANGUAGES: JSON.stringify(languages),
        EASYX_SUBTITLE_PARENT_PIPE: "1",
        HF_HOME: process.env.HF_HOME || path.join(dataDir, "subtitle-models", "huggingface"),
        PYTHONUNBUFFERED: "1",
        OMP_NUM_THREADS: "1",
        MKL_NUM_THREADS: "1",
        OPENBLAS_NUM_THREADS: "1",
        TOKENIZERS_PARALLELISM: "false",
      },
    });
    await new Promise<void>((resolve, reject) => {
      function stop() {
        if (!worker.pid) return;
        // Stop ffmpeg and any package installers along with their parent.
        try { process.kill(grouped ? -worker.pid : worker.pid, "SIGTERM"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") reject(error); }
      }
      signal?.addEventListener("abort", stop, { once: true });
      worker.once("error", reject);
      worker.once("close", (code, reason) => {
        signal?.removeEventListener("abort", stop);
        if (signal?.aborted) resolve();
        else reject(new Error(`Local subtitle worker stopped (${reason || code})`));
      });
    });
  },
});
