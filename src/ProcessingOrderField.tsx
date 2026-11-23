export function ProcessingOrderField({ oldestFirst, onChange, disabled }: {
  oldestFirst: boolean;
  onChange: (oldestFirst: boolean) => void;
  disabled?: boolean;
}) {
  return <label className="processing-order-field">
    <span>Processing order <small>By date added to the library</small></span>
    <select value={oldestFirst ? "oldest" : "newest"} onChange={(event) => onChange(event.target.value === "oldest")} disabled={disabled}>
      <option value="newest">Newest first</option>
      <option value="oldest">Oldest first</option>
    </select>
  </label>;
}
