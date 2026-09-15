import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Textarea } from "./components/ui/textarea";
import { Badge } from "./components/ui/badge";
import { Card } from "./components/ui/card";
import { Alert } from "./components/ui/alert";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./components/ui/tabs";
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { useLiveJson } from "./use-live-json";
import "./style.css";
const prefix = "/" + location.pathname.split("/")[1] + "/";
const date = (n: any) => (n ? new Date(n).toLocaleString() : "—");
const status = (s: string) => s?.replaceAll("_", " ") ?? "unknown";
const active = (r: any) =>
  r.active || ["running", "watching", "queued", "pending"].includes(r.status);
function App() {
  const listing = useLiveJson(prefix + "api/snapshot");
  const data = listing.value ?? {
    runs: [],
    watches: [],
    notifications: [],
    decisions: [],
  };
  const [query, setQuery] = useState(""),
    [filter, setFilter] = useState("all"),
    [tab, setTab] = useState("workflows"),
    [selected, setSelected] = useState(
      location.pathname.match(/runs\/([a-f0-9]{24})/)?.[1] ??
        new URLSearchParams(location.hash.slice(1)).get("run") ??
        "",
    ),
    [action, setAction] = useState(""),
    [judgment, setJudgment] = useState(""),
    [documentName, setDocumentName] = useState(
      new URLSearchParams(location.search).get("document") ?? "",
    ),
    [documentText, setDocumentText] = useState("");
  const detail = useLiveJson(
    selected && tab === "workflows" ? prefix + "api/runs/" + selected : null,
  );
  const error = listing.error || detail.error;
  useEffect(() => {
    if (!selected && data.runs.length) setSelected(data.runs[0].id);
  }, [selected, data.runs]);
  useEffect(() => {
    if (!documentName || !selected) return;
    let cancelled = false;
    setDocumentText("Loading document…");
    fetch(
      prefix +
        "api/documents/" +
        selected +
        "/" +
        encodeURIComponent(documentName),
    )
      .then(async (response) => {
        if (!response.ok)
          throw Error("Document unavailable (" + response.status + ")");
        const text = await response.text();
        if (!cancelled) setDocumentText(text);
      })
      .catch((error) => {
        if (!cancelled) setDocumentText(String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [selected, documentName]);
  const runs = data.runs.filter(
    (r: any) =>
      (filter === "all" || (filter === "active" ? active(r) : !active(r))) &&
      `${r.objective ?? ""} ${r.project ?? ""} ${r.runId ?? ""}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const selectedSummary = data.runs.find((r: any) => r.id === selected);
  const selectedDecision = data.decisions?.find(
    (d: any) => d.runId === selected,
  );
  const current = detail.value?.id === selected ? detail.value : null;
  function choose(r: any) {
    setSelected(r.id);
    setDocumentName("");
    setJudgment("");
    history.pushState({}, "", prefix + "runs/" + r.id);
  }
  useEffect(() => {
    const pop = () => {
      setSelected(location.pathname.match(/runs\/([a-f0-9]{24})/)?.[1] ?? "");
      setDocumentName(
        new URLSearchParams(location.search).get("document") ?? "",
      );
    };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);
  async function command(name: string, payload: any) {
    try {
      const r = await fetch(prefix + "api/" + name, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const v = await r.json();
      if (!r.ok) throw Error(v.error);
      setAction(v.message ?? "Request recorded");
    } catch (e) {
      setAction(String(e));
    }
  }
  return (
    <div className="shell">
      <aside>
        <a className="brand" href={prefix}>
          <span className="logo">↗</span> agent dispatch
        </a>
        <div className="workspace">LOCAL WORKSPACE</div>
        <Button
          variant="outline"
          className={tab === "workflows" ? "nav chosen" : "nav"}
          onClick={() => setTab("workflows")}
        >
          ▦ Workflows <b>{data.runs.length}</b>
        </Button>
        <Button
          variant="outline"
          className={tab === "idle" ? "nav chosen" : "nav"}
          onClick={() => setTab("idle")}
        >
          ◷ IDLE queue <b>{data.watches.length}</b>
        </Button>
        <Button
          variant="outline"
          className={tab === "callbacks" ? "nav chosen" : "nav"}
          onClick={() => setTab("callbacks")}
        >
          ↪ Callbacks <b>{data.notifications.length}</b>
        </Button>
        <div className="sidebar-note">
          <span className="dot" /> Local dispatcher
          <br />
          <small>
            Astra sets the contract.
            <br />
            Workers build, test and fix.
          </small>
        </div>
        <Button
          variant="outline"
          className={tab === "decisions" ? "nav chosen" : "nav"}
          onClick={() => setTab("decisions")}
        >
          ◇ Decisions{" "}
          <b>
            {data.decisions?.filter((d: any) =>
              ["needs_user", "unconfirmed"].includes(d.state),
            ).length ?? 0}
          </b>
        </Button>
      </aside>
      <main>
        <header>
          <div>
            <div className="eyebrow">EXECUTION CONTROL</div>
            <h1>
              {tab === "workflows"
                ? "Workflows"
                : tab === "idle"
                  ? "IDLE queue"
                  : tab === "decisions"
                    ? "Decisions"
                    : "Callback delivery"}
            </h1>
            <p>One contract. Clear ownership. Evidence that stays available.</p>
          </div>
          <div className="refresh">
            Updated {data.at ? new Date(data.at).toLocaleTimeString() : "…"}
          </div>
        </header>
        {error && (
          <Alert role="alert" className="alert">
            {error}
          </Alert>
        )}
        {action && (
          <Alert role="status" className="notice">
            {action}
          </Alert>
        )}
        <section className="metrics">
          <Card>
            <small>ACTIVE WORKFLOWS</small>
            <strong>{data.runs.filter(active).length}</strong>
          </Card>
          <Card>
            <small>AWAITING JUDGMENT</small>
            <strong>
              {
                data.runs.filter((r: any) => r.status === "awaiting_judgment")
                  .length
              }
            </strong>
          </Card>
          <Card>
            <small>IDLE WATCHES</small>
            <strong>{data.watches.filter((w: any) => !w.done).length}</strong>
          </Card>
          <Card>
            <small>CALLBACKS NEED ATTENTION</small>
            <strong>
              {
                data.notifications.filter((n: any) =>
                  ["failed", "unconfirmed"].includes(n.state),
                ).length
              }
            </strong>
          </Card>
        </section>
        {tab === "workflows" ? (
          <Tabs value={filter} onValueChange={setFilter}>
            <div className="toolbar">
              <Input
                aria-label="Search workflows"
                placeholder="Search project, objective or run…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <TabsList aria-label="Filter workflows">
                {["all", "active", "history"].map((v) => (
                  <TabsTrigger key={v} value={v} className="capitalize">
                    {v}
                  </TabsTrigger>
                ))}
              </TabsList>
            </div>
            <TabsContent value={filter} className="split">
              <section className="run-list">
                {runs.length === 0 ? (
                  <div className="empty">
                    {data.at
                      ? "No matching workflows."
                      : "Loading workflow records…"}
                    <br />
                    <small>
                      {data.at
                        ? "Start a contract with agent-dispatch run --plan …"
                        : "Reading saved run and worker evidence."}
                    </small>
                  </div>
                ) : (
                  runs.map((r: any) => (
                    <Button
                      variant="outline"
                      key={r.id}
                      className={
                        "run-card " + (selected === r.id ? "selected" : "")
                      }
                      onClick={() => choose(r)}
                    >
                      <Badge className={"badge " + r.status}>
                        {status(r.status)}
                      </Badge>
                      <h3>
                        {r.project
                          ?.replaceAll("\\", "/")
                          .split("/")
                          .slice(-2)
                          .join(" / ") ?? r.id}
                      </h3>
                      <p>{r.objective ?? r.runId}</p>
                      <small>
                        {r.tasks?.length ?? 0} tasks · {date(r.startedAt)}
                      </small>
                    </Button>
                  ))
                )}
              </section>
              <section className="detail">
                {!current ? (
                  <div className="empty">
                    {!data.at || selectedSummary
                      ? "Loading workflow details…"
                      : selected
                        ? "This run is not registered. Import its saved directory with the CLI."
                        : "Choose a workflow to see its workers and evidence."}
                  </div>
                ) : (
                  <>
                    <div className="detail-head">
                      <Badge className={"badge " + current.status}>
                        {status(current.status)}
                      </Badge>
                      <a href={prefix + "runs/" + current.id}>
                        Permanent link ↗
                      </a>
                    </div>
                    <h2>{current.objective ?? current.runId}</h2>
                    <div className="path">{current.project}</div>
                    {current.dispatcherError && (
                      <Alert className="alert" role="status">
                        <strong>
                          {current.dispatcherError.beforeWorker
                            ? "Dispatcher stopped before a worker started"
                            : "Execution error"}
                        </strong>
                        <p>{current.dispatcherError.message}</p>
                      </Alert>
                    )}
                    {current.alert && (
                      <Alert className="alert">{current.alert}</Alert>
                    )}
                    {selectedDecision && (
                      <Alert className="alert" role="status">
                        <strong>
                          Decision: {status(selectedDecision.state)}
                        </strong>
                        <p>
                          {selectedDecision.reason ??
                            "Compact strategy is still running."}
                        </p>
                        {selectedDecision.guidance && (
                          <p>{selectedDecision.guidance}</p>
                        )}
                        {selectedDecision.continuationId && (
                          <a
                            href={
                              prefix + "runs/" + selectedDecision.continuationId
                            }
                          >
                            Open continued workflow ↗
                          </a>
                        )}
                      </Alert>
                    )}
                    <div className="section-label">WORKER TASKS</div>
                    {current.tasks?.length ? (
                      current.tasks.map((t: any) => (
                        <article className="task" key={t.id}>
                          <div className="task-title">
                            <h3>{t.id}</h3>
                            <Badge className={"badge " + t.status}>
                              {status(t.status)}
                            </Badge>
                          </div>
                          <p>
                            {t.workerKind?.toUpperCase() ?? "Not started"} ·{" "}
                            {t.requestedModel ?? "Selection pending"} ·{" "}
                            {t.requestedEffort ?? "default effort"} ·{" "}
                            {t.attempts} attempts
                          </p>
                          {t.partialEvidence && (
                            <p className="hint">
                              Partial check evidence saved. This task is still
                              blocked, not accepted.
                            </p>
                          )}
                          {t.blockedDecision && (
                            <p>{t.blockedDecision.reason}</p>
                          )}
                          {t.acceptanceCoverage?.length > 0 && (
                            <ul>
                              {t.acceptanceCoverage.map((c: any) => (
                                <li key={c.id}>
                                  {c.id}: {status(c.status)}
                                </li>
                              ))}
                            </ul>
                          )}
                          {t.child && (
                            <>
                              <small>
                                Observed model: {t.child.model ?? "Unavailable"}{" "}
                                · Last activity: {date(t.child.lastActivityAt)}
                              </small>
                              {t.child.todos?.length > 0 && (
                                <ul className="todos">
                                  {t.child.todos
                                    .slice(0, 8)
                                    .map((todo: any, i: number) => (
                                      <li key={i}>
                                        <span>
                                          {todo.status === "completed"
                                            ? "✓"
                                            : "·"}
                                        </span>
                                        {todo.content ?? todo.text}
                                      </li>
                                    ))}
                                </ul>
                              )}
                              <details>
                                <summary>
                                  Recent worker activity (
                                  {t.child.events.length})
                                </summary>
                                <div className="events">
                                  {t.child.events.length ? (
                                    t.child.events.map((e: any, i: number) => (
                                      <div key={i}>
                                        <time>{date(e.startedAt ?? e.at)}</time>
                                        <span>
                                          {e.label ?? e.message ?? e.kind}{" "}
                                          {e.status && "· " + e.status}
                                        </span>
                                      </div>
                                    ))
                                  ) : (
                                    <p>No recorded tool events.</p>
                                  )}
                                </div>
                              </details>
                              {t.child.report && (
                                <details>
                                  <summary>Worker report</summary>
                                  <pre>{t.child.report}</pre>
                                </details>
                              )}
                            </>
                          )}
                        </article>
                      ))
                    ) : (
                      <p>No component records in this legacy run.</p>
                    )}
                    <details className="task">
                      <summary>Dispatcher events</summary>
                      {current.events?.map((e: any, i: number) => (
                        <p key={i}>
                          <small>{date(e.at)}</small> {e.message}
                        </p>
                      ))}
                    </details>
                    {current.report && (
                      <details className="task" open>
                        <summary>Outcome</summary>
                        <pre>{current.report}</pre>
                      </details>
                    )}
                    <div className="section-label">SAVED EVIDENCE</div>
                    <p className="path">
                      {current.docsDir ?? current.directory}
                    </p>
                    <div className="document-links">
                      {current.documents?.map((d: any) => (
                        <a
                          key={d.name}
                          href={
                            prefix +
                            "runs/" +
                            current.id +
                            "?document=" +
                            encodeURIComponent(d.name)
                          }
                          rel="noreferrer"
                          onClick={(e) => {
                            e.preventDefault();
                            setDocumentName(d.name);
                            history.pushState(
                              {},
                              "",
                              prefix +
                                "runs/" +
                                current.id +
                                "?document=" +
                                encodeURIComponent(d.name),
                            );
                          }}
                        >
                          {d.name} ↗
                        </a>
                      ))}
                    </div>
                    {documentName && (
                      <section
                        className="document-reader"
                        aria-label="Document reader"
                      >
                        <div className="task-title">
                          <h3>{documentName}</h3>
                          <Button
                            variant="outline"
                            onClick={() => {
                              setDocumentName("");
                              history.pushState(
                                {},
                                "",
                                prefix + "runs/" + current.id,
                              );
                            }}
                          >
                            Close document
                          </Button>
                        </div>
                        <pre>{documentText}</pre>
                      </section>
                    )}
                    <p className="hint">
                      Reports describe worker results. Passing gates and final
                      judgment are tracked separately.
                    </p>
                    {current.canStop && (
                      <Button
                        variant="outline"
                        className="danger"
                        onClick={() => {
                          if (
                            confirm(
                              "Stop this workflow and its owned worker/check processes?",
                            )
                          )
                            void command("stop", { id: current.id });
                        }}
                      >
                        Stop workflow
                      </Button>
                    )}
                    {current.status === "awaiting_judgment" &&
                      current.finalJudge === "human" && (
                        <section className="task" aria-label="Human judgment">
                          <h3>Record your judgment</h3>
                          <ul>
                            {current.judgmentCriteria?.map(
                              (criterion: string, index: number) => (
                                <li key={index}>{criterion}</li>
                              ),
                            )}
                          </ul>
                          <p>
                            Check the delivered result against your goal, then
                            record your decision.
                          </p>
                          <Textarea
                            aria-label="Judgment reason"
                            value={judgment}
                            onChange={(e) => setJudgment(e.target.value)}
                            rows={4}
                          />
                          <div className="document-links">
                            <Button
                              variant="outline"
                              disabled={!judgment.trim()}
                              onClick={() =>
                                void command("judge", {
                                  id: current.id,
                                  verdict: "accepted",
                                  report: judgment,
                                })
                              }
                            >
                              Accept result
                            </Button>
                            <Button
                              variant="outline"
                              disabled={!judgment.trim()}
                              onClick={() =>
                                void command("judge", {
                                  id: current.id,
                                  verdict: "changes_required",
                                  report: judgment,
                                })
                              }
                            >
                              Request changes
                            </Button>
                          </div>
                        </section>
                      )}
                  </>
                )}
              </section>
            </TabsContent>
          </Tabs>
        ) : tab === "decisions" ? (
          <section className="panel">
            <h2>Strategy and human judgment</h2>
            <p>
              Eligible strategy exceptions use a fresh Astra context; routine
              fixes stay with workers. New runs send one callback when attention
              is needed. Runs configured for local notifications stay here.
            </p>
            {!data.decisions?.length ? (
              <div className="empty">
                No compact decisions recorded yet. Existing runs retain their
                saved callback route.
              </div>
            ) : (
              data.decisions.map((d: any) => (
                <article className="task" key={d.id}>
                  <Badge className={"badge " + d.state}>
                    {status(d.state)}
                  </Badge>
                  <h3>{d.objective}</h3>
                  <p>{d.reason ?? "Bounded strategy decision queued"}</p>
                  <small>
                    {d.started ? "Astra call reserved" : "No Astra call"} ·{" "}
                    {d.packetBytes ?? 0} packet bytes · {date(d.updated)}
                  </small>
                  {d.usage?.length > 0 && (
                    <p className="hint">
                      Recorded usage:{" "}
                      {d.usage.reduce(
                        (n: number, u: any) => n + (u.input_tokens ?? 0),
                        0,
                      )}{" "}
                      input ·{" "}
                      {d.usage.reduce(
                        (n: number, u: any) => n + (u.cached_input_tokens ?? 0),
                        0,
                      )}{" "}
                      cached ·{" "}
                      {d.usage.reduce(
                        (n: number, u: any) => n + (u.output_tokens ?? 0),
                        0,
                      )}{" "}
                      output tokens
                    </p>
                  )}
                  <p>
                    <a href={prefix + "runs/" + (d.continuationId ?? d.runId)}>
                      Open workflow and evidence ↗
                    </a>
                  </p>
                  {d.state === "unconfirmed" && (
                    <p className="hint">
                      Reconcile the existing decision or continuation before
                      retrying; it may already have executed.
                    </p>
                  )}
                </article>
              ))
            )}
          </section>
        ) : tab === "idle" ? (
          <section className="panel">
            <h2>Durable watches</h2>
            <p>
              Watch progress without waking Astra. Completion and deadline
              notifications have separate delivery records.
            </p>
            {!data.watches.length ? (
              <div className="empty">No IDLE jobs attached yet.</div>
            ) : (
              data.watches.map((w: any) => (
                <article className="task" key={w.id}>
                  <Badge className={"badge " + w.status}>
                    {status(w.status)}
                  </Badge>
                  <h3>{w.id}</h3>
                  <p>{w.project}</p>
                  <small>
                    {w.model ?? "Model unknown"} ·{" "}
                    {w.effort ?? "Effort unknown"} · Last probe:{" "}
                    {date(w.lastProbeAt)}
                  </small>
                  <p className="path">Codex task: {w.thread}</p>
                  {w.lastError && (
                    <Alert className="alert">{w.lastError}</Alert>
                  )}
                </article>
              ))
            )}
          </section>
        ) : (
          <section className="panel">
            <h2>Callback outbox</h2>
            <p>
              “Delivered” means the Codex queue accepted the message. An
              uncertain attempt needs reconciliation before another send.
            </p>
            {!data.notifications.length ? (
              <div className="empty">No notifications queued.</div>
            ) : (
              data.notifications.map((n: any) => (
                <article className="task" key={n.id}>
                  <Badge className={"badge " + n.state}>
                    {status(n.state)}
                  </Badge>
                  <h3>{n.id}</h3>
                  <p>{n.detail}</p>
                  <small>
                    {n.attempts} attempts · {date(n.updated)}
                  </small>
                  <p className="path">Codex task: {n.thread}</p>
                  {n.state === "failed" && (
                    <Button
                      variant="outline"
                      onClick={() =>
                        void command("retry-notification", { id: n.id })
                      }
                    >
                      Retry notification
                    </Button>
                  )}
                  {n.state === "unconfirmed" && (
                    <p className="hint">
                      Check the destination task, then use notify-retry
                      --reconciled if it was not delivered.
                    </p>
                  )}
                </article>
              ))
            )}
          </section>
        )}
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
