/**
 * Browser half of the Swarm tab (docs/05 §6.1, A9): a `conversation.view` tab
 * over the web carrier (`swarm/*` on dsh's `/api` gateway, owner-only,
 * loopback). It follows one run of this web process by long-polling
 * `swarm/events` and shows its board, open questions and recap, with cancel,
 * answer, steer and a start form; its RunMetrics in the Result section and its
 * landing queue, read-only (docs/05 B4, B5).
 *
 * A throwing factory or `apply` takes down the whole web UI, so `apply` only
 * registers; every call happens inside the component, whose failures render
 * inline. Only the active tab is mounted, and it remounts per session, so the
 * long-poll aborts on unmount.
 */
import { useCallback, useEffect, useState } from 'react'
import css from './client.css'
import { memberNames, newestFirst, openQuestions, pickRun, resultText, runLabel, sortTasks, startArgs } from './model.js'

if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="openswarm-swarm-client"]') === null) {
  const tag = document.createElement('style')
  tag.dataset.plugin = 'openswarm-swarm-client'
  tag.dataset.pluginCss = 'openswarm-swarm-client'
  tag.textContent = css
  document.head.appendChild(tag)
}

export const inject = ['slots', 'connection']

export function apply(ctx) {
  const call = rpc(ctx.connection)
  ctx.slots.inject('conversation.view', () =>
    ctx.slots.register(
      { name: 'conversation.view', id: 'swarm', order: 20, label: 'Swarm', inject: () => ({ call }) },
      SwarmView,
    ),
  )
}

/**
 * One `swarm/<method>` call on the web carrier. A refusal (`ok: false`)
 * throws its message, which leads with the protocol code; transport failures
 * throw from `rpc.call` itself.
 */
function rpc(connection) {
  return async (method, args = {}, signal) => {
    const result = await connection.rpc.call('/api', `swarm/${method}`, { args }, signal)
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  }
}

const message = (error) => (error instanceof Error ? error.message : String(error))

/** Resolves after `ms`, or at once when `signal` aborts. */
const sleep = (ms, signal) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true })
  })

function SwarmView({ sessionId, call }) {
  const [runs, setRuns] = useState([])
  const [chosen, setChosen] = useState()
  const [view, setView] = useState()
  const [landings, setLandings] = useState([])
  const [metrics, setMetrics] = useState()
  const [error, setError] = useState()
  const runId = chosen ?? pickRun(runs, sessionId)?.id

  const loadRuns = useCallback(
    () => call('runs').then(({ runs }) => setRuns(runs), (e) => setError(message(e))),
    [call],
  )
  useEffect(() => void loadRuns(), [loadRuns])

  // Follow the selected run: the first poll returns its whole journal, each
  // later one waits for the next event; any new event refreshes the view.
  useEffect(() => {
    setView(undefined)
    setLandings([])
    setMetrics(undefined)
    setError(undefined)
    if (runId === undefined) return
    const abort = new AbortController()
    const { signal } = abort
    void (async () => {
      let afterSeq = -1
      while (!signal.aborted) {
        try {
          const { events } = await call('events', { runId, afterSeq, waitMs: 25_000 }, signal)
          // A run not live in this process answers at once; don't spin on it.
          if (events.length === 0) {
            await sleep(2_000, signal)
            continue
          }
          const next = await call('view', { runId }, signal)
          afterSeq = events.at(-1).seq
          setView(next)
          setError(undefined)
          // Extras, each on its own: one that fails says so, and never hides the board, questions, steer or cancel.
          const [queue, measured] = await Promise.allSettled([call('landings', { runId }, signal), call('metrics', { runId }, signal)])
          if (queue.status === 'fulfilled') setLandings(queue.value.landings)
          if (measured.status === 'fulfilled') setMetrics(measured.value.rows)
          const failed = [queue, measured].find((settled) => settled.status === 'rejected')
          if (failed !== undefined && !signal.aborted) setError(message(failed.reason))
          if (next.run.status !== 'running') return void loadRuns()
        } catch (e) {
          if (signal.aborted) return
          setError(message(e))
          await sleep(5_000, signal)
        }
      }
    })()
    return () => abort.abort()
  }, [runId, call, loadRuns])

  const act = (method, args) => call(method, { runId, ...args }).catch((e) => setError(message(e)))
  const running = view?.run.status === 'running'
  const result = view === undefined ? undefined : resultText(view.run)

  return (
    <div className="osw-root" data-conversation-composer-overlay="">
      <div className="osw-scroll">
        <div className="osw-column">
          <div className="osw-row">
            <select className="osw-grow" value={runId ?? ''} onChange={(e) => setChosen(e.target.value || undefined)} aria-label="Run">
              {runs.length === 0 && <option value="">No runs yet</option>}
              {newestFirst(runs).map((run) => (
                <option key={run.id} value={run.id}>
                  {runLabel(run)}
                </option>
              ))}
            </select>
            <button type="button" onClick={() => void loadRuns()}>
              Refresh
            </button>
          </div>
          {error !== undefined && <p className="osw-error">{error}</p>}
          {view !== undefined && (
            <>
              <div className="osw-row">
                <span className="osw-badge">{view.run.status}</span>
                <span className="osw-badge">{view.run.topology}</span>
                <span className="osw-mono osw-grow">{view.run.id}</span>
                {running && (
                  <button type="button" onClick={() => void act('cancel')}>
                    Cancel
                  </button>
                )}
              </div>
              {view.run.spec?.intent !== undefined && (
                <p className="osw-muted">
                  {view.run.spec.intent.purpose} — end state: {view.run.spec.intent.endState}
                </p>
              )}
              {view.run.error !== undefined && <p className="osw-error">{view.run.error}</p>}
              {(result !== undefined || metrics !== undefined) && (
                <details className="osw-section">
                  <summary>Result</summary>
                  {result !== undefined && <pre className="osw-result">{result}</pre>}
                  {metrics !== undefined && <Metrics rows={metrics} />}
                </details>
              )}
              <Board tasks={view.tasks} />
              <Landings landings={landings} />
              <Questions questions={openQuestions(view)} answer={(questionId, answer) => act('answer', { questionId, answer })} />
              {running && <Steer key={view.run.id} members={memberNames(view)} steer={(to, text) => call('steer', { runId, to, text })} />}
              <Recap lines={view.recap} />
            </>
          )}
          <Start
            start={(args) => call('start', args)}
            onStarted={(id) => {
              setChosen(id)
              void loadRuns()
            }}
          />
        </div>
      </div>
    </div>
  )
}

function Board({ tasks }) {
  return (
    <section className="osw-section">
      <h3>Board</h3>
      {tasks.length === 0 ? (
        <p className="osw-muted">No board tasks.</p>
      ) : (
        <table className="osw-table">
          <thead>
            <tr>
              <th>Task</th>
              <th>Status</th>
              <th>Owner</th>
              <th>Subject</th>
            </tr>
          </thead>
          <tbody>
            {sortTasks(tasks).map((task) => (
              <tr key={task.id}>
                <td className="osw-mono">{task.id}</td>
                <td>{task.status}</td>
                <td>{task.owner ?? '-'}</td>
                <td title={task.intent === undefined ? undefined : `End state: ${task.intent.endState}`}>{task.subject}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

function Metrics({ rows }) {
  return (
    <table className="osw-table osw-metrics">
      <tbody>
        {rows.map(([label, value]) => (
          <tr key={label}>
            <th className="osw-mono">{label}</th>
            <td>{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** The landing queue, highest risk first, as the server orders it. Read-only: reprioritize, retain and take over are not built. */
function Landings({ landings }) {
  if (landings.length === 0) return null
  return (
    <section className="osw-section">
      <h3>Landings</h3>
      {landings.map((landing) => (
        <pre key={`${landing.key}-${landing.at}`} className={`osw-landing osw-risk-${landing.risk}`}>
          {landing.text.join('\n')}
        </pre>
      ))}
    </section>
  )
}

function Questions({ questions, answer }) {
  if (questions.length === 0) return null
  return (
    <section className="osw-section">
      <h3>Open questions</h3>
      {questions.map((q) => (
        <div key={q.id} className="osw-question">
          <p>
            <span className="osw-mono">{q.id}</span> <span className="osw-muted">({q.trigger}, {q.tier})</span> {q.prompt}
          </p>
          <div className="osw-row">
            {q.options.map((option) => (
              <button key={option} type="button" onClick={() => void answer(q.id, option)}>
                {option === q.default ? `${option} (default)` : option}
              </button>
            ))}
          </div>
        </div>
      ))}
    </section>
  )
}

function Steer({ members, steer }) {
  const [to, setTo] = useState('')
  const [text, setText] = useState('')
  const [note, setNote] = useState()
  const target = to || members[0] || ''
  const send = async (e) => {
    e.preventDefault()
    try {
      const { delivery } = await steer(target, text)
      setNote(`delivered: ${delivery}`)
      setText('')
    } catch (error) {
      setNote(message(error))
    }
  }
  return (
    <section className="osw-section">
      <h3>Steer</h3>
      <form className="osw-row" onSubmit={send}>
        <select value={target} onChange={(e) => setTo(e.target.value)} aria-label="Member">
          {members.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <input className="osw-grow" value={text} onChange={(e) => setText(e.target.value)} placeholder="Message to the member" />
        <button type="submit" disabled={target === '' || text.trim() === ''}>
          Send
        </button>
      </form>
      {note !== undefined && <p className={note.startsWith('delivered') ? 'osw-muted' : 'osw-error'}>{note}</p>}
    </section>
  )
}

function Recap({ lines }) {
  return (
    <section className="osw-section">
      <h3>Recap</h3>
      <ul className="osw-recap">
        {[...lines].reverse().map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </section>
  )
}

const SPEC_HINT = `{
  "topology": "peer-team",
  "messaging": true,
  "members": [{ "name": "alice" }, { "name": "bob" }],
  "tasks": [{ "subject": "…", "prompt": "…" }]
}`

function Start({ start, onStarted }) {
  const [spec, setSpec] = useState('')
  const [worktrees, setWorktrees] = useState('')
  const [note, setNote] = useState()
  const [busy, setBusy] = useState(false)
  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    try {
      const { runId } = await start(startArgs(spec, worktrees))
      setNote(undefined)
      onStarted(runId)
    } catch (error) {
      setNote(message(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <details className="osw-section">
      <summary>Start run</summary>
      <form className="osw-form" onSubmit={submit}>
        <textarea rows={8} value={spec} onChange={(e) => setSpec(e.target.value)} placeholder={SPEC_HINT} aria-label="TeamSpec JSON" />
        <textarea
          rows={2}
          value={worktrees}
          onChange={(e) => setWorktrees(e.target.value)}
          placeholder={'Optional worktrees JSON, e.g. { "repoRoot": "/path/to/repo" } (steers land immediate)'}
          aria-label="Worktrees JSON"
        />
        <div className="osw-row">
          <button type="submit" disabled={busy || spec.trim() === ''}>
            {busy ? 'Starting…' : 'Start'}
          </button>
          <span className="osw-muted">Steering needs a messaging peer-team.</span>
        </div>
        {note !== undefined && <p className="osw-error">{note}</p>}
      </form>
    </details>
  )
}
