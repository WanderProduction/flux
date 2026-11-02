/**
 * A small XML reader — enough of it to read an edit, and no more.
 *
 * ## Why this is hand-rolled
 *
 * The same reason the mp4 demuxer and the CDP client are: FLUX carries one
 * runtime dependency on purpose, and this has to run unchanged in three
 * places — the renderer, the Electron main process, and a plain Node harness
 * with no bundler. `DOMParser` exists in the first and not the others;
 * `@xmldom` is present in node_modules today only because electron-builder
 * happens to pull it, and building on a transitive dependency is building on
 * something nobody promised to keep.
 *
 * What makes that defensible here is the narrowness of the job. An NLE
 * interchange file is XML written by a machine for machines: no namespaces, no
 * processing instructions beyond the declaration, no mixed content, no DTD
 * subset. This reads that, and **refuses anything outside it** rather than
 * guessing — see `parseXml`'s throws. A reader that half-understood a file
 * would produce an edit that is subtly not the one someone cut, which is worse
 * than one that will not open.
 *
 * ## What it does not do
 *
 * No namespace resolution — `a:b` is an element literally named `a:b`.
 * No CDATA, no entity declarations, no external references. Attribute and text
 * values resolve the five predefined entities and numeric character
 * references, which is everything a path or a clip name needs.
 */

/**
 * @typedef {object} XmlNode
 * @property {string} name
 * @property {Record<string, string>} attrs
 * @property {XmlNode[]} children
 * @property {string} text direct text content, trimmed, '' when there is none
 */

const NAME = /[A-Za-z_:][-A-Za-z0-9._:]*/y

/**
 * Resolves the entities an interchange file actually contains.
 *
 * Numeric references matter more than they look: Premiere writes `&#39;` into
 * any clip name with an apostrophe in it, and a reader that left that literal
 * would put `&#39;` in a filename.
 *
 * @param {string} text
 * @returns {string}
 */
function unescape(text) {
  if (!text.includes('&')) return text
  return text.replace(/&(#x?[0-9A-Fa-f]+|lt|gt|amp|apos|quot);/g, (whole, body) => {
    switch (body) {
      case 'lt':
        return '<'
      case 'gt':
        return '>'
      case 'amp':
        return '&'
      case 'apos':
        return "'"
      case 'quot':
        return '"'
      default: {
        const code =
          body[1] === 'x' || body[1] === 'X'
            ? Number.parseInt(body.slice(2), 16)
            : Number.parseInt(body.slice(1), 10)
        return Number.isFinite(code) ? String.fromCodePoint(code) : whole
      }
    }
  })
}

/**
 * Parses an XML document into a node tree.
 *
 * @param {string} source
 * @returns {XmlNode} the root element
 * @throws when the document is malformed, or uses a feature this does not read
 */
export function parseXml(source) {
  if (source.charCodeAt(0) === 0xfeff) source = source.slice(1)
  if (source.includes('<![CDATA[')) {
    throw new Error('CDATA sections are not read by this parser')
  }

  let at = 0
  /** @type {XmlNode[]} */
  const stack = []
  /** @type {XmlNode | null} */
  let root = null

  const fail = (why) => {
    // The offset is worth more than the line number: these files are machine
    // written and routinely have one line a thousand characters long.
    throw new Error(`${why} at character ${at}`)
  }

  while (at < source.length) {
    const open = source.indexOf('<', at)
    if (open < 0) break

    // Text between elements belongs to whatever is currently open.
    if (open > at && stack.length > 0) {
      const text = source.slice(at, open)
      if (text.trim()) stack[stack.length - 1].text += text
    }
    at = open

    // Declaration, comment, DOCTYPE — stepped over, not understood.
    if (source.startsWith('<?', at)) {
      const end = source.indexOf('?>', at)
      if (end < 0) fail('unterminated declaration')
      at = end + 2
      continue
    }
    if (source.startsWith('<!--', at)) {
      const end = source.indexOf('-->', at)
      if (end < 0) fail('unterminated comment')
      at = end + 3
      continue
    }
    if (source.startsWith('<!', at)) {
      /*
       * A DOCTYPE with an internal subset contains nested brackets, so the
       * first `>` is not reliably the end of it. Counting depth is cheap and
       * the alternative silently truncates the document.
       */
      let depth = 0
      let i = at
      for (; i < source.length; i++) {
        if (source[i] === '[') depth++
        else if (source[i] === ']') depth--
        else if (source[i] === '>' && depth <= 0) break
      }
      if (i >= source.length) fail('unterminated doctype')
      at = i + 1
      continue
    }

    // Closing tag.
    if (source.startsWith('</', at)) {
      NAME.lastIndex = at + 2
      const match = NAME.exec(source)
      if (!match) fail('expected a name after </')
      const close = source.indexOf('>', NAME.lastIndex)
      if (close < 0) fail('unterminated closing tag')
      const node = stack.pop()
      if (!node) fail(`</${match[0]}> closes nothing`)
      if (node.name !== match[0]) fail(`</${match[0]}> closes <${node.name}>`)
      at = close + 1
      continue
    }

    // Opening tag.
    NAME.lastIndex = at + 1
    const nameMatch = NAME.exec(source)
    if (!nameMatch) fail('expected an element name')
    /** @type {XmlNode} */
    const node = { name: nameMatch[0], attrs: {}, children: [], text: '' }
    at = NAME.lastIndex

    // Attributes.
    for (;;) {
      while (at < source.length && /\s/.test(source[at])) at++
      if (at >= source.length) fail('unterminated tag')
      if (source[at] === '>' || source.startsWith('/>', at)) break

      NAME.lastIndex = at
      const attrMatch = NAME.exec(source)
      if (!attrMatch) fail('expected an attribute name')
      at = NAME.lastIndex
      while (at < source.length && /\s/.test(source[at])) at++
      if (source[at] !== '=') fail(`attribute ${attrMatch[0]} has no value`)
      at++
      while (at < source.length && /\s/.test(source[at])) at++
      const quote = source[at]
      if (quote !== '"' && quote !== "'") fail('attribute value is not quoted')
      const end = source.indexOf(quote, at + 1)
      if (end < 0) fail('unterminated attribute value')
      node.attrs[attrMatch[0]] = unescape(source.slice(at + 1, end))
      at = end + 1
    }

    const selfClosing = source.startsWith('/>', at)
    at += selfClosing ? 2 : 1

    if (stack.length > 0) stack[stack.length - 1].children.push(node)
    else if (root) fail('a document may have only one root element')
    else root = node

    if (!selfClosing) stack.push(node)
    else if (!root) root = node
  }

  if (stack.length > 0) throw new Error(`<${stack[stack.length - 1].name}> is never closed`)
  if (!root) throw new Error('no element in this document')

  // Text was accumulated raw so entities spanning a chunk boundary still
  // resolve; doing it once at the end is also one pass instead of many.
  const settle = (node) => {
    node.text = unescape(node.text).trim()
    node.children.forEach(settle)
  }
  settle(root)

  return root
}

/** The first direct child with this name, or null. */
export function child(node, name) {
  return node?.children.find((one) => one.name === name) ?? null
}

/** Every direct child with this name. */
export function children(node, name) {
  return node?.children.filter((one) => one.name === name) ?? []
}

/** The trimmed text of a named child, or '' when it is absent. */
export function textOf(node, name) {
  return child(node, name)?.text ?? ''
}

/**
 * A named child's text as a number, or `fallback`.
 *
 * Returns the fallback for an absent *or unparseable* value rather than NaN.
 * NaN propagates silently through every arithmetic step after it and surfaces
 * as a clip of length NaN much later, where nothing points back to the tag
 * that was empty.
 */
export function numberOf(node, name, fallback = 0) {
  const text = textOf(node, name)
  if (!text) return fallback
  const value = Number(text)
  return Number.isFinite(value) ? value : fallback
}

/** A named child's text as a boolean. xmeml writes TRUE/FALSE. */
export function flagOf(node, name, fallback = false) {
  const text = textOf(node, name).toUpperCase()
  if (text === 'TRUE') return true
  if (text === 'FALSE') return false
  return fallback
}
