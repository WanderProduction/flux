import { useEffect, useState } from 'react'

import {
  clearImportError,
  getImportRequest,
  getImportStatus,
  subscribeImports,
  type ImportRequest,
  type ImportStatus,
} from '../kernel/importPipeline'
import { ImportChoiceDialog } from '../panels/ImportChoiceDialog'

/**
 * Answers the copy-or-link question, wherever it was asked from.
 *
 * Mounted by the app shell rather than by a panel, because the panel that
 * triggers an import is no longer the panel that can show a dialog: a file
 * dragged from Explorer onto the Timeline has to raise the same question, and
 * the Timeline has no modal of its own. One host, one dialog, one answer.
 *
 * Copy progress and copy failures live here for the same reason. A failed copy
 * means footage the user believes is inside the project and is not, so it is
 * reported at the app level where it is visible whatever panel is in front —
 * not tucked into a browser the user may have dragged away from.
 */
export function ImportChoiceHost() {
  const [request, setRequest] = useState<ImportRequest | null>(getImportRequest)
  const [status, setStatus] = useState<ImportStatus>(getImportStatus)

  useEffect(
    () =>
      subscribeImports(() => {
        setRequest(getImportRequest())
        setStatus({ ...getImportStatus() })
      }),
    [],
  )

  return (
    <>
      {status.progress && <div className="import-progress">{status.progress}</div>}
      {status.error && (
        <div className="import-error" role="alert" onClick={clearImportError}>
          {status.error}
          <span className="import-error-dismiss">dismiss</span>
        </div>
      )}
      {request && (
        <ImportChoiceDialog
          count={request.entries.length}
          projectName={request.projectName}
          onChoose={(choice) => request.answer(choice)}
          onCancel={() => request.answer(null)}
        />
      )}
    </>
  )
}
