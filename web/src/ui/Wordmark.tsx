/** "mailyard" in Funnel Display: "mail" in gray-1000, "yard" in ember-700 (the design's .wordmark). */
export function Wordmark({ small }: { small?: boolean }) {
  return (
    <span className={small ? "wordmark wordmark-sm" : "wordmark"} role="img" aria-label="Mailyard">
      <span className="wm-mail" aria-hidden="true">
        mail
      </span>
      <span className="wm-yard" aria-hidden="true">
        yard
      </span>
    </span>
  )
}
