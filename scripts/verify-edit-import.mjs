/**
 * Verifies the XML reader and the cut-list reader. No app, no browser.
 *
 *   node scripts/verify-edit-import.mjs [a-real-sequence.xml]
 *
 * The fixture is built here rather than committed, and that is deliberate
 * twice over. A real export is somebody's client work — the one this was built
 * against is a reel for a named person, with their footage paths in it — and
 * it does not belong in a public repository. And a fixture written here can be
 * made to contain *every* trap at once, which no single real export does.
 *
 * Pass a real file as an argument and it is read too, as a smoke test: it must
 * parse, and anything it cannot carry must come back as a warning rather than
 * silence.
 *
 * ## What is actually being checked
 *
 * Not "does it parse". Six specific ways an edit comes back wrong while
 * looking fine, each of which is in the real sequence this was written for:
 *
 *   1. a `<file>` referenced by id after its first use, with an empty body
 *   2. `ntsc` turning timebase 30 into 29.97
 *   3. `start`/`end` (timeline) confused with `in`/`out` (source)
 *   4. geometry taken from a Basic Motion filter, not from scaling to fit
 *   5. percent-encoded non-ASCII paths behind `file://localhost/`
 *   6. a nested sequence, which must be refused out loud
 *
 * Every one of those produces a timeline that plays. That is what makes them
 * worth a harness.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

import { documentLength, problemsWith, readCutList } from '../shared/editDocument.js'
import { pathFromUrl, rateOf, readXmeml } from '../shared/xmeml.js'
import { parseXml, child, numberOf } from '../shared/xml.js'

let passed = 0
let failed = 0
async function check(name, fn) {
  try {
    await fn()
    console.log(`  ok   ${name}`)
    passed++
  } catch (err) {
    console.error(`  FAIL ${name}`)
    console.error(`       ${err.message}`)
    failed++
  }
}

/**
 * A sequence with all six traps in it.
 *
 * 1080x1920 at a timebase of 30 marked NTSC, so the real rate is 29.97 and
 * every frame number below means something slightly different than it looks.
 */
const TRAPS = `<?xml version='1.0' encoding='UTF-8'?>
<!DOCTYPE xmeml>
<xmeml version="5">
  <sequence id="sequence-1">
    <name>Traps</name>
    <duration>900</duration>
    <rate><timebase>30</timebase><ntsc>TRUE</ntsc></rate>
    <media>
      <video>
        <format><samplecharacteristics>
          <rate><timebase>30</timebase><ntsc>TRUE</ntsc></rate>
          <width>1080</width><height>1920</height>
        </samplecharacteristics></format>
        <track>
          <clipitem id="clipitem-1">
            <name>bottom layer</name>
            <enabled>TRUE</enabled>
            <rate><timebase>30</timebase><ntsc>TRUE</ntsc></rate>
            <start>0</start><end>300</end><in>0</in><out>300</out>
            <file id="file-1">
              <name>&#x5E8;&#x5D9;&#x5DC;&#x5E1;.mp4</name>
              <pathurl>file://localhost/C:/Media/%D7%A8%D7%99%D7%9C%D7%A1%2010.mp4</pathurl>
              <rate><timebase>30</timebase><ntsc>TRUE</ntsc></rate>
              <media><video><samplecharacteristics>
                <width>2160</width><height>3840</height>
              </samplecharacteristics></video></media>
            </file>
            <filter><effect>
              <name>Basic Motion</name><effectid>basic</effectid>
              <parameter><parameterid>scale</parameterid><value>50.00</value></parameter>
            </effect></filter>
          </clipitem>
          <clipitem id="clipitem-2">
            <name>trimmed and moved</name>
            <enabled>TRUE</enabled>
            <rate><timebase>30</timebase><ntsc>TRUE</ntsc></rate>
            <start>600</start><end>900</end><in>120</in><out>420</out>
            <file id="file-1"/>
          </clipitem>
        </track>
        <track>
          <clipitem id="clipitem-3">
            <name>a nest</name>
            <enabled>TRUE</enabled>
            <rate><timebase>30</timebase><ntsc>TRUE</ntsc></rate>
            <start>0</start><end>300</end><in>0</in><out>300</out>
            <sequence id="sequence-2"><name>inner</name></sequence>
          </clipitem>
        </track>
      </video>
      <audio>
        <track>
          <clipitem id="clipitem-4">
            <name>half speed</name>
            <enabled>TRUE</enabled>
            <rate><timebase>30</timebase><ntsc>TRUE</ntsc></rate>
            <start>0</start><end>600</end><in>0</in><out>300</out>
            <file id="file-2">
              <name>music.wav</name>
              <pathurl>file://localhost/C:/Media/music.wav</pathurl>
              <rate><timebase>30</timebase><ntsc>TRUE</ntsc></rate>
            </file>
          </clipitem>
        </track>
      </audio>
    </media>
    <marker>
      <comment>the opening beat</comment><name>HOOK</name>
      <in>0</in><out>168</out>
    </marker>
  </sequence>
</xmeml>
`

const NTSC_30 = 30000 / 1001

try {
  const read = readXmeml(TRAPS)
  assert.ok(read.ok, `the fixture did not parse: ${read.ok === false ? read.error : ''}`)
  const doc = read.document

  await check('trap 2: ntsc turns timebase 30 into 29.97', () => {
    assert.ok(
      Math.abs(doc.frameRate - NTSC_30) < 1e-9,
      `frame rate is ${doc.frameRate}, expected ${NTSC_30}`,
    )
    // And the knock-on: 300 frames is 10.01 seconds, not 10.
    const first = doc.video[0][0]
    assert.ok(
      Math.abs(first.duration - 300 / NTSC_30) < 1e-9,
      `a 300-frame clip came out ${first.duration}s`,
    )
  })

  await check('trap 1: a file referenced by id after its first use keeps its path', () => {
    const [first, second] = doc.video[0]
    assert.ok(second, 'the second clip was dropped entirely')
    assert.equal(second.source, first.source, 'the empty <file id=.../> lost its path')
    assert.ok(second.source.endsWith('רילס 10.mp4'), `unexpected source: ${second.source}`)
  })

  await check('trap 3: start/end places the clip, in/out trims it', () => {
    const second = doc.video[0][1]
    assert.ok(
      Math.abs(second.start - 600 / NTSC_30) < 1e-9,
      `clip should start at frame 600, came out at ${second.start}s`,
    )
    assert.ok(
      Math.abs(second.offset - 120 / NTSC_30) < 1e-9,
      `clip should play from frame 120 of its source, came out at ${second.offset}s`,
    )
    assert.ok(Math.abs(second.duration - 300 / NTSC_30) < 1e-9, 'wrong duration')
  })

  await check('trap 4: geometry comes from the Basic Motion filter', () => {
    const first = doc.video[0][0]
    assert.ok(first.transform, 'the scale filter was dropped')
    assert.equal(first.transform.scale, 50)
    assert.equal(first.transform.uniform, true)
    // And the source really is bigger than the frame, which is why it is there.
    assert.deepEqual(first.sourceSize, { width: 2160, height: 3840 })
  })

  await check('trap 5: a percent-encoded non-ASCII path decodes', () => {
    assert.equal(
      pathFromUrl('file://localhost/C:/Media/%D7%A8%D7%99%D7%9C%D7%A1%2010.mp4'),
      'C:/Media/רילס 10.mp4',
    )
    // No authority at all, which is equally legal.
    assert.equal(pathFromUrl('file:///D:/a%20b/c.mov'), 'D:/a b/c.mov')
    // A stray percent must not throw the whole import away.
    assert.equal(pathFromUrl('file://localhost/C:/100%/x.mov'), 'C:/100%/x.mov')
  })

  await check('trap 6: a nested sequence is refused out loud', () => {
    const nest = doc.warnings.find((w) => w.includes('nested sequence'))
    assert.ok(nest, `no warning about the nest: ${JSON.stringify(doc.warnings)}`)
    assert.ok(nest.includes('a nest'), 'the warning does not name the clip')
    // And the track it was alone on is gone, rather than present and empty.
    assert.equal(doc.video.length, 1, 'the emptied track should not be carried')
  })

  await check('speed comes from source span against timeline span', () => {
    const clip = doc.audio[0][0]
    // 300 source frames over 600 timeline frames is half speed.
    assert.ok(Math.abs(clip.speed - 0.5) < 1e-9, `speed came out ${clip.speed}`)
  })

  await check('markers are carried, in seconds', () => {
    assert.equal(doc.markers.length, 1)
    assert.equal(doc.markers[0].name, 'HOOK')
    assert.equal(doc.markers[0].comment, 'the opening beat')
    assert.ok(Math.abs(doc.markers[0].end - 168 / NTSC_30) < 1e-9)
  })

  await check('CANARY: a confused reader would fail these', () => {
    /*
     * Without this the suite proves less than it looks. Each assertion above
     * would also pass against a reader that was wrong in the *opposite*
     * direction, so the values are pinned against the naive answers here: a
     * plain 30fps read, and in/out used as the timeline position.
     */
    const naiveRate = 30
    assert.notEqual(doc.frameRate, naiveRate, 'frame rate matches the naive reading')
    const second = doc.video[0][1]
    assert.notEqual(second.start, 120 / NTSC_30, 'start matches the in-point — they were confused')
    assert.notEqual(second.offset, 0, 'the trim was lost')
  })

  await check('a document with no clips is refused rather than imported empty', () => {
    const empty = readXmeml(
      `<?xml version='1.0'?><xmeml version="5"><sequence><name>n</name>` +
        `<rate><timebase>25</timebase><ntsc>FALSE</ntsc></rate>` +
        `<media><video/><audio/></media></sequence></xmeml>`,
    )
    assert.ok(empty.ok, 'it should parse')
    assert.ok(problemsWith(empty.document).length > 0, 'an empty document should be a problem')
  })

  await check('FCPXML and plain rubbish are refused with a useful reason', () => {
    const fcp = readXmeml(`<?xml version='1.0'?><fcpxml version="1.9"><resources/></fcpxml>`)
    assert.equal(fcp.ok, false)
    assert.match(fcp.error, /FCPXML/, `unhelpful: ${fcp.error}`)

    const junk = readXmeml('this is not xml at all')
    assert.equal(junk.ok, false)
  })

  // ── the cut list a model writes ──────────────────────────────────
  await check('a cut list lays its cuts end to end unless told otherwise', () => {
    const result = readCutList({
      name: 'Reel',
      frameRate: 30,
      width: 1080,
      height: 1920,
      sources: ['C:/Media/a.mp4', 'C:/Media/b.mp4'],
      video: [
        [
          { src: 0, in: 12.4, out: 18.9, why: 'clean, facing camera' },
          { src: 0, in: 31.0, out: 36.2 },
          { src: 1, at: 30, in: 0, out: 4 },
        ],
      ],
    })
    assert.ok(result.ok, `refused: ${result.ok === false ? result.problems.join('; ') : ''}`)
    const [a, b, c] = result.document.video[0]

    assert.equal(a.start, 0)
    assert.ok(Math.abs(a.duration - 6.5) < 1e-9)
    assert.equal(a.offset, 12.4)
    assert.equal(a.note, 'clean, facing camera')

    // Straight after the first, not at its own in-point.
    assert.ok(Math.abs(b.start - 6.5) < 1e-9, `second cut started at ${b.start}`)
    assert.equal(b.offset, 31.0)

    // `at` overrides the running position.
    assert.equal(c.start, 30)
    assert.equal(c.source, 'C:/Media/b.mp4')
  })

  await check('a bad cut list reports every problem at once', () => {
    const result = readCutList({
      sources: ['C:/Media/a.mp4'],
      video: [[{ src: 0, in: 5, out: 3 }, { src: 9, in: 0, out: 1 }, { src: 0, in: 0 }]],
    })
    assert.equal(result.ok, false)
    assert.ok(
      result.problems.length >= 3,
      `expected three problems, got ${result.problems.length}: ${result.problems.join(' | ')}`,
    )
    assert.ok(result.problems.some((p) => p.includes('not after')), 'no complaint about out < in')
    assert.ok(result.problems.some((p) => p.includes('not in sources')), 'no complaint about src')
    assert.ok(result.problems.some((p) => p.includes('no out point')), 'no complaint about out')
  })

  await check('rate reading is shared, and handles a missing rate', () => {
    const node = parseXml('<a><rate><timebase>24</timebase><ntsc>TRUE</ntsc></rate></a>')
    assert.ok(Math.abs(rateOf(node) - 24000 / 1001) < 1e-9)
    assert.equal(rateOf(parseXml('<a/>'), 25), 25)
    // An unparseable number falls back rather than becoming NaN.
    assert.equal(numberOf(child(parseXml('<a><n>x</n></a>'), 'n'), 'missing', 7), 7)
  })

  // ── the real file, when one is offered ───────────────────────────
  const real = process.argv[2]
  if (real) {
    await check(`a real export reads: ${real.split(/[\\/]/).pop()}`, async () => {
      const text = await fs.readFile(real, 'utf8')
      const result = readXmeml(text)
      assert.ok(result.ok, `refused: ${result.ok === false ? result.error : ''}`)
      const parsed = result.document
      assert.ok(documentLength(parsed) > 0, 'it came out with no length')
      const clips = [...parsed.video, ...parsed.audio].reduce((n, t) => n + t.length, 0)
      assert.ok(clips > 0, 'it came out with no clips')
      for (const track of [...parsed.video, ...parsed.audio]) {
        for (const clip of track) {
          assert.ok(clip.source, `"${clip.name}" came through with no source path`)
          assert.ok(clip.duration > 0, `"${clip.name}" came through with no length`)
        }
      }
      console.log(
        `       ${parsed.name}: ${parsed.width}x${parsed.height} @ ` +
          `${parsed.frameRate.toFixed(3)}fps, ${clips} clips over ` +
          `${parsed.video.length}V/${parsed.audio.length}A, ` +
          `${parsed.markers.length} markers, ${documentLength(parsed).toFixed(2)}s`,
      )
      for (const warning of parsed.warnings) console.log(`       warning: ${warning}`)
    })
  } else {
    console.log('  note  pass a real .xml to smoke-test it as well')
  }
} finally {
  console.log(`\n${passed} checks passed${failed ? ` (with ${failed} failures)` : ''}`)
  if (failed) process.exitCode = 1
}
