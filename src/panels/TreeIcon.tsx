export type TreeIconKind = 'drive' | 'folder' | 'project' | 'video' | 'image' | 'audio'

/**
 * Row icons, drawn as SVG rather than CSS boxes.
 *
 * An asset has to be unmistakably not a folder. The earlier CSS version gave
 * every kind the same bordered rectangle and only varied its colour, so a video
 * in the project tree read as a folder — which is exactly the wrong impression
 * when one can be opened and the other cannot.
 */
export function TreeIcon({ kind }: { kind: TreeIconKind }) {
  return (
    <svg
      className={`tree-icon tree-icon--${kind}`}
      viewBox="0 0 16 16"
      width="13"
      height="13"
      aria-hidden="true"
      focusable="false"
    >
      {kind === 'folder' && (
        <path d="M1.5 3.5h4l1.4 1.6h7.6v7.4a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" />
      )}

      {kind === 'project' && (
        <>
          <path d="M1.5 3.5h4l1.4 1.6h7.6v7.4a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" />
          {/* A dot marks the one folder that is the project itself. */}
          <circle className="tree-icon-mark" cx="8" cy="9.4" r="1.9" />
        </>
      )}

      {kind === 'drive' && (
        <>
          <rect x="1.5" y="4" width="13" height="8" rx="1.4" />
          <circle className="tree-icon-mark" cx="12" cy="8" r="1.1" />
        </>
      )}

      {/* A film frame with a play triangle — reads as "clip", never as a folder. */}
      {kind === 'video' && (
        <>
          <rect x="1.5" y="3" width="13" height="10" rx="1.6" />
          <path className="tree-icon-mark" d="M6.6 6.1l4 1.9-4 1.9z" />
        </>
      )}

      {/* A picture: frame, horizon and sun. */}
      {kind === 'image' && (
        <>
          <rect x="1.5" y="3" width="13" height="10" rx="1.6" />
          <path className="tree-icon-mark" d="M3.2 11.4l3.3-3.5 2.2 2.2 2-1.9 2.1 3.2z" />
          <circle className="tree-icon-mark" cx="5.4" cy="6.1" r="1.1" />
        </>
      )}

      {kind === 'audio' && (
        <>
          <rect x="1.5" y="3" width="13" height="10" rx="1.6" />
          <path
            className="tree-icon-mark"
            d="M4 8.6h1.3l1.1-2.4 1.6 4.4 1.3-3 .9 1.6H12"
            fill="none"
            strokeWidth="1.2"
          />
        </>
      )}
    </svg>
  )
}
