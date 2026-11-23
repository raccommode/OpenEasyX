const timingLine = /^((?:\d{2,}:)?[0-5]\d:[0-5]\d[.,]\d{3})[ \t]+-->[ \t]+((?:\d{2,}:)?[0-5]\d:[0-5]\d[.,]\d{3})([ \t].*)?$/;

function seconds(timestamp: string) {
  return timestamp.replace(",", ".").split(":").reduce((total, part) => total * 60 + Number(part), 0);
}

export function normalizeSubtitleContent(content: string) {
  const normalized = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();
  if (!normalized) throw new Error("Subtitle file is empty");
  const blocks = normalized.split(/\n[ \t]*\n+/);
  const webvtt = /^WEBVTT(?:[ \t][^\n]*)?$/.test(blocks[0].split("\n", 1)[0]);
  if (webvtt && blocks[0].includes("-->")) throw new Error("A blank line must separate the WebVTT header from the first cue");
  const output = [webvtt ? blocks.shift()! : "WEBVTT"];
  let cues = 0;
  for (const block of blocks) {
    const lines = block.split("\n");
    if (webvtt && /^(?:NOTE(?:[ \t].*)?|STYLE|REGION)$/.test(lines[0])) {
      output.push(block);
      continue;
    }
    const index = lines[0].includes("-->") ? 0 : 1;
    const timing = timingLine.exec(lines[index]?.trim() ?? "");
    if (!timing || !lines.slice(index + 1).join("").trim() || seconds(timing[2]) <= seconds(timing[1])) {
      throw new Error("Expected a WebVTT or SRT cue with valid start and end times and subtitle text");
    }
    lines[index] = `${timing[1].replace(",", ".")} --> ${timing[2].replace(",", ".")}${timing[3] ?? ""}`;
    output.push(lines.join("\n"));
    cues++;
  }
  if (!cues) throw new Error("Subtitle file contains no timed cues");
  return `${output.join("\n\n")}\n`;
}
