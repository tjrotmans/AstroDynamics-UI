import { useState, type ReactNode } from "react"
import { ChevronDown, ChevronRight } from "lucide-react"

// Small paper-native form primitives, light-toned to match the rest of the
// study document (InlineEditField.tsx's palette: #171512 ink, #55524b
// ink-2, #8b877d ink-3, #dedbd2 rule-soft, #f24d00 orange) rather than the
// app's dark shadcn form chrome. Built after direct user feedback: "build
// it all on the real paper page, not in a window that opens in the style
// of the old frontend" -- every optimizer/survey control gets rebuilt on
// top of these instead of reusing dark Input/Select/Checkbox.

const fieldClass =
  "w-full rounded-[3px] border border-[#dedbd2] bg-white px-2 py-1.5 text-[12.5px] text-[#171512] outline-none focus:border-[#f24d00]"

export function PaperLabel({ children, htmlFor, hint }: { children: ReactNode; htmlFor?: string; hint?: ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="flex items-center gap-1.5 text-[11.5px] font-semibold text-[#171512]">
      {children}
      {hint}
    </label>
  )
}

export function PaperHint({ children }: { children: ReactNode }) {
  return <p className="text-[10.5px] leading-relaxed text-[#8b877d]">{children}</p>
}

export function PaperField({
  label,
  htmlFor,
  hint,
  note,
  children,
}: {
  label: string
  htmlFor?: string
  hint?: ReactNode
  note?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-1">
      <PaperLabel htmlFor={htmlFor} hint={hint}>
        {label}
      </PaperLabel>
      {children}
      {note && <PaperHint>{note}</PaperHint>}
    </div>
  )
}

export function PaperInput({
  id,
  type = "number",
  value,
  step,
  min,
  max,
  placeholder,
  onChange,
}: {
  id?: string
  type?: "number" | "text"
  value: string | number
  step?: number | string
  min?: number
  max?: number
  placeholder?: string
  onChange: (value: string) => void
}) {
  return (
    <input
      id={id}
      type={type}
      value={value}
      step={step}
      min={min}
      max={max}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className={fieldClass}
    />
  )
}

export function PaperSelect<T extends string>({
  id,
  value,
  options,
  placeholder,
  onChange,
}: {
  id?: string
  value: T | ""
  options: { value: T; label: string; disabled?: boolean }[]
  placeholder?: string
  onChange: (value: T) => void
}) {
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value as T)} className={fieldClass}>
      {placeholder && (
        <option value="" disabled>
          {placeholder}
        </option>
      )}
      {options.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

export function PaperCheckbox({
  id,
  checked,
  label,
  note,
  onChange,
}: {
  id: string
  checked: boolean
  label: ReactNode
  note?: ReactNode
  onChange: (checked: boolean) => void
}) {
  return (
    <div className="flex items-center gap-2">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="size-[13px] accent-[#f24d00]"
      />
      <label htmlFor={id} className="text-[12px] text-[#171512]">
        {label}
        {note && <span className="ml-1.5 text-[10.5px] text-[#8b877d]">{note}</span>}
      </label>
    </div>
  )
}

export function PaperFieldGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-3">{children}</div>
}

// A paper-toned collapsible, same trigger pattern as the app's
// AdvancedPhysicsSection (chevron + label toggle) but light-styled -- used
// for every "Advanced" sub-panel below a rebuilt paper-native form,
// including the ones that intentionally still mount an existing dark
// component inside (MgaAdvancedSearchSection, AdvancedPhysicsSection
// itself) as a clearly-framed island rather than pretending they're native.
export function PaperDisclosure({
  title,
  defaultOpen = false,
  children,
}: {
  title: string
  defaultOpen?: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        className="flex items-center gap-1.5 text-[11px] font-bold tracking-[0.08em] text-[#55524b] uppercase hover:text-[#f24d00]"
      >
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        {title}
      </button>
      {open && <div className="mt-2 border-l-2 border-[#dedbd2] pl-3">{children}</div>}
    </div>
  )
}

export function PaperSectionLabel({ children }: { children: ReactNode }) {
  return <div className="mb-1.5 text-[9.5px] font-bold tracking-[0.16em] text-[#8b877d] uppercase">{children}</div>
}
