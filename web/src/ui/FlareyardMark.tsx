/**
 * The Flareyard yard-grid mark, inline (HAL-3494). The five ink squares take `currentColor`, so the mark
 * follows the text it sits in and stays visible in dark mode; the ember square keeps the flare token
 * (`.fy-mark .fy-flare` → `--my-flare`). The `<img>` of flareyard-mark.svg it replaces had a fixed #171717 ink,
 * near-invisible on a dark background.
 */
export function FlareyardMark({ size = 14 }: { size?: number }) {
  return (
    <svg
      className="fy-mark"
      viewBox="0 0 32 32"
      width={size}
      height={size}
      aria-hidden="true"
      shapeRendering="crispEdges"
      data-od-id="flareyard-mark"
    >
      <rect x="1" y="25" width="6" height="6" fill="currentColor" />
      <rect x="17" y="9" width="6" height="6" fill="currentColor" />
      <rect x="25" y="1" width="6" height="6" fill="currentColor" />
      <rect x="17" y="17" width="6" height="6" fill="currentColor" />
      <rect x="25" y="17" width="6" height="6" fill="currentColor" />
      <rect className="fy-flare" x="9" y="17" width="6" height="6" />
    </svg>
  )
}
