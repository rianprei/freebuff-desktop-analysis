/**
 * The signing probe exists to make one specific bad release visible: an ad-hoc
 * signature pins macOS privacy grants to a cdhash, so every update silently
 * resets the user's Documents/Desktop permissions. That means the two failure
 * directions both hurt —
 *
 *  - classifying a real ad-hoc build as anything else hides the incident;
 *  - classifying a Developer ID build as ad-hoc raises a false one.
 *
 * The requirement strings below are verbatim `codesign -d -r-` output (Chrome,
 * VS Code, Docker, an ad-hoc-signed universal binary), because the regexes are
 * only worth anything against what codesign actually prints. The last block
 * signs a real binary and probes it end to end for the same reason.
 *
 * The literal state values are asserted rather than imported: Axiom/PostHog
 * queries match on these strings, so a rename is a silently-empty dashboard.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require_ = createRequire(import.meta.url)
const { detectSigning, classify } = require_('./signing.cjs') as {
  detectSigning: (opts: {
    platform: string
    isPackaged: boolean
    execPath?: string
    timeoutMs?: number
  }) => Promise<{ state: string; team?: string }>
  classify: (output: string) => { state: string; team?: string }
}

/** codesign prints the bundle path before the requirement; the regex must survive that. */
const withHeader = (requirement: string) =>
  `Executable=/Applications/Freebuff.app/Contents/MacOS/Freebuff\n${requirement}\n`

describe('classify · developer id', () => {
  test('reads the team out of an unquoted subject.OU (Chrome-style)', () => {
    const out = withHeader(
      'designated => (identifier "com.google.Chrome" or identifier "com.google.Chrome.beta") and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = EQHXZ8M8AV',
    )
    expect(classify(out)).toEqual({ state: 'developer-id', team: 'EQHXZ8M8AV' })
  })

  test('reads the team out of a quoted subject.OU (Docker-style) without the quotes', () => {
    // both forms come out of real codesign; a team of `"9BNSXJN65R` would not join
    // against anything on the analytics side
    const out = withHeader(
      'designated => identifier "com.docker.docker" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = "9BNSXJN65R"',
    )
    expect(classify(out)).toEqual({ state: 'developer-id', team: '9BNSXJN65R' })
  })

  test('omits the team key entirely when the requirement pins no OU', () => {
    const out = withHeader(
      'designated => identifier "com.example.app" and anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */',
    )
    const result = classify(out)
    expect(result.state).toBe('developer-id')
    expect('team' in result).toBe(false)
  })

  test('a self-signed certificate is NOT developer id', () => {
    // no `anchor apple`, so nothing guarantees the requirement outlives a re-sign —
    // reporting it as developer-id would hide exactly the grant-resetting class of build
    const out = withHeader('designated => identifier "com.example.app" and certificate leaf = H"deadbeef"')
    expect(classify(out)).toEqual({ state: 'unknown' })
  })

  test('an apple-anchored requirement with no certificate clause is not developer id', () => {
    // /bin/echo prints exactly this; platform binaries are not Developer ID signed
    expect(classify(withHeader('designated => identifier "com.apple.echo" and anchor apple'))).toEqual({
      state: 'unknown',
    })
  })
})

describe('classify · adhoc', () => {
  test('recognises the ad-hoc line despite its leading "# " comment prefix', () => {
    // ad-hoc requirements are implicit, so codesign comments the line out; anchoring
    // the regex at `designated` alone would miss every ad-hoc build we ship
    expect(classify(withHeader('# designated => cdhash H"7d9de9e518b05b93f9474f20a202e1b5"'))).toEqual({
      state: 'adhoc',
    })
  })

  test('recognises a universal binary, whose requirement is one cdhash per arch', () => {
    expect(
      classify(
        withHeader('# designated => cdhash H"7d9de9e518b05b93" or cdhash H"72f167650c5bd3b2"'),
      ),
    ).toEqual({ state: 'adhoc' })
  })
})

describe('classify · degradation', () => {
  test('detects an entirely unsigned binary from codesign stderr', () => {
    expect(classify('/tmp/Freebuff.app: code object is not signed at all\n')).toEqual({
      state: 'unsigned',
    })
  })

  test('unknown when codesign produced nothing usable', () => {
    // an execFile failure hands classify '\n' (both streams empty); guessing here
    // would put a fake state on the launch event
    expect(classify('\n')).toEqual({ state: 'unknown' })
    expect(classify('codesign: command not found')).toEqual({ state: 'unknown' })
  })
})

describe('detectSigning · non-probing branches', () => {
  test('a source run reports dev rather than probing the dev Electron binary', async () => {
    // unpackaged, execPath is Electron's own helper — its signature says nothing about us
    expect(await detectSigning({ platform: 'darwin', isPackaged: false, execPath: '/nope' })).toEqual({
      state: 'dev-unpackaged',
    })
  })

  test('non-darwin packaged builds are not-applicable, not unknown', async () => {
    // Windows/Linux have no TCC-by-requirement problem; reporting 'unknown' there
    // would drown the metric this event exists to watch
    for (const platform of ['win32', 'linux']) {
      expect(await detectSigning({ platform, isPackaged: true, execPath: '/nope' })).toEqual({
        state: 'not-applicable',
      })
    }
  })
})

describe('detectSigning · against real codesign', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fb-signing-'))
  const darwin = process.platform === 'darwin'
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  const sign = (name: string, args: string[]) => {
    const bin = join(dir, name)
    copyFileSync('/bin/echo', bin)
    const proc = Bun.spawnSync(['codesign', ...args, bin], { stdout: 'ignore', stderr: 'ignore' })
    if (!proc.success) throw new Error(`codesign ${args.join(' ')} failed`)
    return bin
  }

  test.skipIf(!darwin)('classifies a genuinely ad-hoc-signed binary as adhoc', async () => {
    // the incident case, end to end: only a real signature proves the requirement
    // regex still matches what this macOS version prints
    const bin = sign('adhoc', ['-f', '-s', '-'])
    expect(await detectSigning({ platform: 'darwin', isPackaged: true, execPath: bin })).toEqual({
      state: 'adhoc',
    })
  })

  test.skipIf(!darwin)('classifies a stripped binary as unsigned', async () => {
    const bin = sign('stripped', ['--remove-signature'])
    expect(await detectSigning({ platform: 'darwin', isPackaged: true, execPath: bin })).toEqual({
      state: 'unsigned',
    })
  })

  test('resolves to unknown instead of rejecting when the probe cannot run', async () => {
    // a diagnostic that throws would take boot down with it (main.cjs awaits this)
    const missing = join(dir, 'does-not-exist')
    expect(await detectSigning({ platform: 'darwin', isPackaged: true, execPath: missing })).toEqual({
      state: 'unknown',
    })
  })

  test.skipIf(!darwin)('abandons a probe that outlasts timeoutMs', async () => {
    // boot awaits this promise, so an unbounded codesign is an unbounded launch. The binary IS
    // signed, so an implementation that ignored timeoutMs would happily report 'adhoc' here —
    // the 'unknown' is what proves the probe was cut off rather than merely being fast.
    // (only darwin: elsewhere codesign is absent and the probe fails for the wrong reason)
    const bin = sign('slow', ['-f', '-s', '-'])
    const started = Date.now()
    const result = await detectSigning({
      platform: 'darwin',
      isPackaged: true,
      execPath: bin,
      timeoutMs: 1,
    })
    expect(result).toEqual({ state: 'unknown' })
    // generous, because the only failure this bound is for is a hang
    expect(Date.now() - started).toBeLessThan(5_000)
  })
})
