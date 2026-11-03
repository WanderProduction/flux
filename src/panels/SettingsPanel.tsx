import { useCallback, useMemo, useState } from 'react'

import type { FunctionComponent } from 'react'

import { PanelFrame } from './PanelFrame'
import { AccountPage } from './settings/AccountPage'
import { AppearancePage } from './settings/AppearancePage'
import { CachePage } from './settings/CachePage'
import { HotkeysPage } from './settings/HotkeysPage'
import { WorkspacePage } from './settings/WorkspacePage'
import { commands } from '../kernel/commands'
import {
  FIRST_SETTINGS_PAGE,
  getSettingsPage,
  pagesInLevel,
  settingsLevels,
  settingsPages,
  type SettingsPage,
} from '../kernel/settings'

/**
 * Settings: a list of pages down the left, one page in the middle.
 *
 * The shape every application with more than a dialog's worth of settings
 * arrives at, and it is worth saying why rather than copying it. Settings are
 * *found*, not navigated: nobody remembers which tab the cache lives on, they
 * scan a list for the word that matches what they want to change. A list is
 * scannable and a tab bar with nineteen tabs is not — and the list has room
 * for a line under each name, which turns "what is this page" from a click
 * into a read.
 *
 * ## It is a panel, so it is a page
 *
 * There is no settings *window*. It is a panel, registered through the same
 * `panels.register()` a community panel uses, shown in a workspace of its own
 * that fills the dock — exactly how the Export page works, and for the reason
 * written in kernel/layouts.ts: Premiere, Resolve and Media Encoder all
 * reach the same answer because a question you cannot answer from a corner of
 * the screen should not be asked in a corner of the screen.
 *
 * It also means settings are dockable like anything else. Pull the panel
 * alongside the Timeline and change a cache budget while watching what it does
 * to playback, which is the one way anybody has ever tuned a cache honestly.
 *
 * ## Almost every page is a plan
 *
 * See the note at the top of kernel/settings.ts. Each unbuilt page says it is
 * unbuilt and then says what will be on it, specifically enough to argue with.
 * The one thing this panel must never do is draw a control that does nothing,
 * so there are no disabled sliders or dead switches anywhere in here — an
 * unbuilt page has *prose*, and prose cannot be mistaken for a feature.
 *
 * Where a setting already exists somewhere else in FLUX, the page says where
 * and offers the command that gets you there. That is not a courtesy; a page
 * promising a cache setting the app has had for weeks would send someone
 * looking for something they already own.
 */
export function SettingsPanel() {
  const [openId, setOpenId] = useState(FIRST_SETTINGS_PAGE)
  const [query, setQuery] = useState('')

  const page = getSettingsPage(openId)

  /*
   * Search across the name, the blurb and what is coming.
   *
   * Across the *promise* as well as the name, which is the point: somebody
   * looking for VST support does not know it is on a page called Plugins, and
   * somebody looking for "autosave" should not have to guess at "Saves". While
   * most pages are plans, this search is the fastest way to read the plan.
   */
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return null
    return new Set(
      settingsPages
        .filter((one) =>
          `${one.name} ${one.blurb} ${one.coming ?? ''} ${one.livesAt?.what ?? ''}`
            .toLowerCase()
            .includes(needle),
        )
        .map((one) => one.id),
    )
  }, [query])

  const built = settingsPages.filter((one) => one.ready).length

  return (
    <PanelFrame
      scroll={false}
      toolbar={
        <>
          <span className="tool-label">Settings</span>
          <input
            className="settings-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search every page"
            spellCheck={false}
          />
          <span className="tool-sep" />
          <span className="tool-value tool-value--dim">
            {built} of {settingsPages.length} built
          </span>
        </>
      }
    >
      <div className="settings">
        <nav className="settings-nav">
          {settingsLevels.map((level) => {
            const pages = pagesInLevel(level.id)
            const shown = matches ? pages.filter((one) => matches.has(one.id)) : pages
            // A level whose pages are all filtered out goes entirely, heading
            // included: an empty heading is a row that says nothing.
            if (shown.length === 0) return null
            return (
              <div className="settings-level" key={level.id}>
                <div className="settings-level-head">
                  <span className="settings-level-name">{level.name}</span>
                  <span className="settings-level-blurb">{level.blurb}</span>
                </div>
                {shown.map((one) => (
                  <button
                    key={one.id}
                    className={
                      'settings-link' +
                      (one.id === openId ? ' settings-link--open' : '') +
                      (one.ready ? '' : ' settings-link--planned')
                    }
                    onClick={() => setOpenId(one.id)}
                    aria-current={one.id === openId}
                  >
                    <span className="settings-link-name">{one.name}</span>
                    <span className="settings-link-blurb">{one.blurb}</span>
                  </button>
                ))}
              </div>
            )
          })}
          {matches?.size === 0 && (
            <div className="settings-empty">Nothing on any page matches “{query}”.</div>
          )}
        </nav>

        <div className="settings-content">
          {page ? <SettingsContent page={page} /> : null}
        </div>
      </div>
    </PanelFrame>
  )
}

/**
 * The pages that have been built, by id.
 *
 * Here rather than on the page definition because `kernel/settings.ts` is
 * kernel — it describes the settings tree and must not import React. The
 * `ready` flag there stays the single statement of what is built, and
 * `verify:settings` asserts the two agree in both directions: a page marked
 * ready with nothing to render would be a blank page, and a component nobody
 * can reach would be dead code.
 */
// Explicitly partial: most ids are not in here, and a lookup that TypeScript
// believed always returned a component would make the `Built &&` below look
// like a mistake rather than the point.
const BUILT: Record<string, FunctionComponent | undefined> = {
  'account.appearance': AppearancePage,
  'account.general': AccountPage,
  'account.hotkeys': HotkeysPage,
  'device.cache': CachePage,
  'workspace.general': WorkspacePage,
}

/** One page: the built ones render themselves, the rest state the plan. */
function SettingsContent({ page }: { page: SettingsPage }) {
  const Built = BUILT[page.id]
  const level = settingsLevels.find((one) => one.id === page.level)

  // A built page gets a wider column: 620px is right for prose and wrong for
  // a table of commands and the keys they run.
  return (
    <article className={`settings-page${Built ? ' settings-page--built' : ''}`}>
      <header className="settings-page-head">
        <div className="settings-page-crumb">
          {level?.name}
          {!page.ready && <span className="settings-badge">Planned</span>}
        </div>
        <h2 className="settings-page-title">{page.name}</h2>
        <p className="settings-page-blurb">{page.blurb}</p>
      </header>

      {page.livesAt && <LivesAt page={page} />}

      {Built && <Built />}

      {page.coming && (
        <section className="settings-plan">
          {/* On a built page this is what is still missing, which is a
              different heading from what the page *will be*. */}
          <h3 className="settings-plan-head">
            {page.ready ? 'Still to come' : 'What this page will be'}
          </h3>
          <p className="settings-plan-body">{page.coming}</p>
        </section>
      )}

      {/*
        Said once, at the bottom, rather than as a banner at the top of all
        nineteen. The badge beside the level already says the page is planned;
        this is the sentence that explains why it is here at all, and it is
        worth reading once rather than nineteen times.
      */}
      {!page.ready && (
        <footer className="settings-page-foot">
          This page is the plan, not the feature. It is here because the shape of the settings is
          worth agreeing on before any of it is wired up — and because a page that is honestly
          empty is better than a control that silently does nothing.
        </footer>
      )}
    </article>
  )
}

/**
 * Where this setting can be changed today.
 *
 * With a button that runs the command rather than a line naming its key.
 * Deliberately: the chord for a command id is something only the keymap
 * controller can answer, and it is handed to the palette as a prop from the
 * app root — so a panel asking the same question would need either that prop
 * threaded down to it or a second module-level way to ask, and a second answer
 * to one question is how the two drift apart. Pressing the button is also
 * better than being told a key, since it keeps working when the key is
 * rebound, which is exactly what the Hotkeys page is for.
 */
function LivesAt({ page }: { page: SettingsPage }) {
  const lives = page.livesAt

  const go = useCallback(() => {
    if (lives?.command) void commands.run(lives.command)
  }, [lives?.command])

  if (!lives) return null

  return (
    <section className="settings-lives">
      <h3 className="settings-lives-head">Already in FLUX today</h3>
      <p className="settings-lives-what">{lives.what}</p>
      <p className="settings-lives-where">{lives.where}</p>
      {lives.command && (
        <button className="settings-lives-go" data-command={lives.command} onClick={go}>
          Take me there
        </button>
      )}
    </section>
  )
}
