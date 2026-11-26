import type { DubbingOriginalInterval } from "../packages/plugin-sdk";
import { playerTime } from "./playback";
import "./dubbing-passages.css";

export function DubbingPassages({ intervals, label }: { intervals?: DubbingOriginalInterval[]; label?: string }) {
  if (!intervals?.length) return null;
  return <details className="dubbing-passages">
    <summary>{label && <b>{label} · </b>}{intervals.length === 1 ? "1 passage uses" : `${intervals.length} passages use`} original audio</summary>
    <ul>{intervals.map(({ start, end, reason }, index) => <li key={index}>
      <span className="dubbing-time">{playerTime(start)}–{playerTime(Math.ceil(end))}</span> · {reason === "unverified-source" ? "Source words unverified" : "Dubbed speech unverified"}
    </li>)}</ul>
  </details>;
}
