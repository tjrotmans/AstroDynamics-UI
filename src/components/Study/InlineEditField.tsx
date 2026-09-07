import { useEffect, useRef, useState } from "react"

// The margin table's "Table 1 -- Configuration. Dotted entries edit in
// place." interaction from the design mockup, built as a small generic
// primitive rather than five bespoke fields: a dotted-underline value that
// swaps to a real inline control on click, and commits straight to
// whichever missionStore setter the caller passes in -- no local
// duplication of the field's real validation/clamping logic, this is
// presentation only.
export type InlineEditVariant =
  | { kind: "select"; options: { value: string; label: string }[] }
  | { kind: "number"; min?: number; max?: number; step?: number }
  | { kind: "date" }

export function InlineEditField({
  displayValue,
  rawValue,
  variant,
  onCommit,
}: {
  displayValue: string
  rawValue: string
  variant: InlineEditVariant
  onCommit: (value: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const selectRef = useRef<HTMLSelectElement>(null)

  useEffect(() => {
    if (!editing) return
    inputRef.current?.focus()
    selectRef.current?.focus()
  }, [editing])

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="cursor-text border-b border-dotted border-[#8b877d] text-right font-semibold text-[#171512] hover:border-[#f24d00] hover:text-[#f24d00]"
      >
        {displayValue}
      </button>
    )
  }

  const commit = (value: string) => {
    onCommit(value)
    setEditing(false)
  }

  const fieldClass =
    "rounded border border-[#dedbd2] bg-white px-1.5 py-0.5 text-right text-[12px] text-[#171512] outline-none focus:border-[#f24d00]"

  if (variant.kind === "select") {
    return (
      <select
        ref={selectRef}
        defaultValue={rawValue}
        onChange={(e) => commit(e.target.value)}
        onBlur={() => setEditing(false)}
        className={fieldClass}
      >
        {variant.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    )
  }

  if (variant.kind === "number") {
    return (
      <input
        ref={inputRef}
        type="number"
        defaultValue={rawValue}
        min={variant.min}
        max={variant.max}
        step={variant.step}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit((e.target as HTMLInputElement).value)
          if (e.key === "Escape") setEditing(false)
        }}
        className={`w-24 ${fieldClass}`}
      />
    )
  }

  return (
    <input
      ref={inputRef}
      type="datetime-local"
      step={1}
      defaultValue={rawValue}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit((e.target as HTMLInputElement).value)
        if (e.key === "Escape") setEditing(false)
      }}
      className={fieldClass}
    />
  )
}
