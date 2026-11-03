import { useEffect, useState } from 'react'

import {
  accents,
  densities,
  getAppearance,
  isDefaultAppearance,
  resetAppearance,
  setAppearance,
  subscribeAppearance,
  themes,
  TEXT_SCALES,
} from '../../kernel/appearance'

/**
 * Appearance — theme, accent, density, text size.
 *
 * Every control here writes one attribute or one custom property onto the root
 * element, and the stylesheet does the rest. There is no preview pane and no
 * Apply button because there is nothing to preview: the app *is* the preview,
 * and a change lands on every panel behind this one the instant it is clicked.
 * An Apply button would only exist to make the change feel expensive.
 *
 * The one thing worth knowing about the choices is that all three themes are
 * dark, and that is a decision rather than a gap — see `themes` in
 * kernel/appearance.ts. An editor is dark because the picture is the brightest
 * thing on screen and anything around it biases how you read it.
 */
export function AppearancePage() {
  const [, bump] = useState(0)
  useEffect(() => subscribeAppearance(() => bump((n) => n + 1)), [])
  const now = getAppearance()

  return (
    <div className="ap">
      <Row
        label="Theme"
        note="All dark on purpose: a light interface around a picture changes how you read the picture."
      >
        <div className="ap-cards">
          {themes.map((theme) => (
            <button
              key={theme.id}
              className={`ap-card${theme.id === now.theme ? ' ap-card--on' : ''}`}
              onClick={() => setAppearance({ theme: theme.id })}
              aria-pressed={theme.id === now.theme}
            >
              {/*
                A swatch built from the theme's own tokens rather than from
                values repeated here. `data-flux-theme` on the swatch itself
                means each one is rendered by the very block it selects, so a
                theme edited in the stylesheet cannot disagree with its own
                preview.
              */}
              <span className="ap-swatch" data-flux-theme={theme.id}>
                <span className="ap-swatch-bg" />
                <span className="ap-swatch-panel" />
                <span className="ap-swatch-accent" />
              </span>
              <span className="ap-card-name">{theme.name}</span>
              <span className="ap-card-blurb">{theme.blurb}</span>
            </button>
          ))}
        </div>
      </Row>

      <Row
        label="Accent"
        note="Outlines, the playhead, anything the app wants you to notice. Grey is for colour-critical work, where a saturated accent in the corner of your eye is the thing biasing your judgement."
      >
        <div className="ap-accents">
          {accents.map((accent) => (
            <button
              key={accent.id}
              className={`ap-accent${accent.id === now.accent ? ' ap-accent--on' : ''}`}
              style={{ background: accent.swatch }}
              title={accent.name}
              aria-label={accent.name}
              aria-pressed={accent.id === now.accent}
              onClick={() => setAppearance({ accent: accent.id })}
            />
          ))}
          <span className="ap-accent-name">
            {accents.find((one) => one.id === now.accent)?.name}
          </span>
        </div>
      </Row>

      <Row label="Density" note="Chrome heights and the gap around the panels. Not the type — that is below.">
        <div className="ap-choices">
          {densities.map((density) => (
            <button
              key={density.id}
              className={`ap-choice${density.id === now.density ? ' ap-choice--on' : ''}`}
              onClick={() => setAppearance({ density: density.id })}
              title={density.blurb}
              aria-pressed={density.id === now.density}
            >
              {density.name}
            </button>
          ))}
        </div>
      </Row>

      <Row
        label="Text size"
        note="Separate from density, because “I cannot read this” and “I cannot fit enough on screen” are different complaints and one control for both makes each harder to fix."
      >
        <div className="ap-choices">
          {TEXT_SCALES.map((scale) => (
            <button
              key={scale}
              className={`ap-choice${scale === now.textScale ? ' ap-choice--on' : ''}`}
              onClick={() => setAppearance({ textScale: scale })}
              aria-pressed={scale === now.textScale}
            >
              {scale}%
            </button>
          ))}
        </div>
      </Row>

      <div className="ap-foot">
        <button className="hk-btn" disabled={isDefaultAppearance()} onClick={() => resetAppearance()}>
          Back to the shipped look
        </button>
      </div>
    </div>
  )
}

function Row({
  label,
  note,
  children,
}: {
  label: string
  note: string
  children: React.ReactNode
}) {
  return (
    <section className="ap-row">
      <h3 className="hk-group-head">{label}</h3>
      <p className="ap-note">{note}</p>
      {children}
    </section>
  )
}
