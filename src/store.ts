import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import { home, keyFor } from "./paths";
export class Store {
  db: Database;
  constructor(public root = home) {
    fs.mkdirSync(root, { recursive: true });
    this.db = new Database(path.join(root, "dispatch.sqlite"), {
      create: true,
    });
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, directory TEXT NOT NULL UNIQUE, created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS watches(id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY, thread TEXT NOT NULL, message TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, updated INTEGER NOT NULL, detail TEXT);
    CREATE TABLE IF NOT EXISTS nights(project TEXT, night TEXT, job TEXT, PRIMARY KEY(project,night));
    CREATE TABLE IF NOT EXISTS decisions(id TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE, objective TEXT NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL, started INTEGER);
    CREATE INDEX IF NOT EXISTS decisions_objective ON decisions(objective);
    CREATE INDEX IF NOT EXISTS decisions_state ON decisions(state);`);
  }
  register(directory: string) {
    directory = fs.existsSync(directory)
      ? fs.realpathSync(directory)
      : path.resolve(directory);
    const id = keyFor(directory);
    this.db
      .query("INSERT OR IGNORE INTO runs VALUES (?,?,?)")
      .run(id, directory, Date.now());
    return id;
  }
  runs(): { id: string; directory: string; created: number }[] {
    return this.db
      .query("SELECT * FROM runs ORDER BY created DESC")
      .all() as any;
  }
  runsAwaitingNotification(): { id: string; directory: string }[] {
    return this.db
      .query(
        "SELECT r.id,r.directory FROM runs r WHERE NOT EXISTS (SELECT 1 FROM outbox n WHERE n.id='run:' || r.id || ':terminal')",
      )
      .all() as any;
  }
  run(id: string) {
    return this.db.query("SELECT * FROM runs WHERE id=?").get(id) as {
      id: string;
      directory: string;
    } | null;
  }
  putWatch(w: any) {
    this.db
      .query(
        "INSERT INTO watches VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(w.id, JSON.stringify(w));
  }
  watch(id: string): any {
    const r = this.db
      .query("SELECT data FROM watches WHERE id=?")
      .get(id) as any;
    return r ? JSON.parse(r.data) : null;
  }
  watches(pendingOnly = false): any[] {
    return (
      this.db
        .query(
          "SELECT data FROM watches" +
            (pendingOnly
              ? " WHERE COALESCE(json_extract(data,'$.done'),0)=0"
              : ""),
        )
        .all() as any[]
    ).map((r) => JSON.parse(r.data));
  }
  enqueue(id: string, thread: string, message: string) {
    this.db
      .query(
        "INSERT OR IGNORE INTO outbox(id,thread,message,updated) VALUES (?,?,?,?)",
      )
      .run(id, thread, message, Date.now());
  }
  notifications(state?: string): any[] {
    return state
      ? this.db
          .query("SELECT * FROM outbox WHERE state=? ORDER BY updated DESC")
          .all(state)
      : this.db.query("SELECT * FROM outbox ORDER BY updated DESC").all();
  }
  claim(id: string) {
    return (
      this.db
        .query(
          "UPDATE outbox SET state='sending',attempts=attempts+1,updated=? WHERE id=? AND state='pending'",
        )
        .run(Date.now(), id).changes === 1
    );
  }
  delivery(id: string, state: string, detail: string) {
    this.db
      .query("UPDATE outbox SET state=?,detail=?,updated=? WHERE id=?")
      .run(state, detail.slice(0, 2000), Date.now(), id);
  }
  localNotice(id: string, thread: string, message: string, detail: string) {
    this.db
      .query(
        "INSERT OR IGNORE INTO outbox(id,thread,message,state,updated,detail) VALUES (?,?,?,'local',?,?)",
      )
      .run(id, thread ?? "", message, Date.now(), detail.slice(0, 2000));
  }
  addDecision(
    id: string,
    runId: string,
    objective: string,
    state: string,
    data: any,
  ) {
    return (
      this.db
        .query(
          "INSERT OR IGNORE INTO decisions(id,run_id,objective,state,data,created,updated) VALUES (?,?,?,?,?,?,?)",
        )
        .run(
          id,
          runId,
          objective,
          state,
          JSON.stringify(data),
          Date.now(),
          Date.now(),
        ).changes === 1
    );
  }
  decisions(state?: string): any[] {
    const rows = state
      ? this.db
          .query("SELECT * FROM decisions WHERE state=? ORDER BY created")
          .all(state)
      : this.db.query("SELECT * FROM decisions ORDER BY created DESC").all();
    return (rows as any[]).map((r) => ({ ...r, data: JSON.parse(r.data) }));
  }
  decision(id: string): any {
    const r = this.db
      .query("SELECT * FROM decisions WHERE id=? OR run_id=?")
      .get(id, id) as any;
    return r ? { ...r, data: JSON.parse(r.data) } : null;
  }
  updateDecision(id: string, state: string, extra: any) {
    const row = this.decision(id);
    if (!row) throw Error("Unknown decision");
    this.db
      .query("UPDATE decisions SET state=?,data=?,updated=? WHERE id=?")
      .run(
        state,
        JSON.stringify({ ...row.data, ...extra }),
        Date.now(),
        row.id,
      );
  }
  claimDecision(id: string) {
    return this.db
      .transaction(() => {
        const row = this.decision(id);
        if (!row || row.state !== "queued") return false;
        const used = (
          this.db
            .query(
              "SELECT count(*) AS n FROM decisions WHERE objective=? AND started IS NOT NULL",
            )
            .get(row.objective) as any
        ).n;
        if (used >= row.data.policy.maxCalls) {
          this.updateDecision(id, "needs_user", {
            reason:
              "Persistent Astra decision allowance exhausted; no automatic retry",
          });
          return false;
        }
        return (
          this.db
            .query(
              "UPDATE decisions SET state='running',started=?,updated=? WHERE id=? AND state='queued'",
            )
            .run(Date.now(), Date.now(), id).changes === 1
        );
      })
      .immediate();
  }
  recover() {
    this.db
      .query(
        "UPDATE outbox SET state='unconfirmed',detail='Dispatcher ended during delivery; reconcile before retrying' WHERE state='sending'",
      )
      .run();
    this.db
      .query(
        "UPDATE decisions SET state='unconfirmed',updated=? WHERE state IN ('running','applying')",
      )
      .run(Date.now());
  }
  retry(id: string, reconciled: boolean) {
    const row = this.db.query("SELECT * FROM outbox WHERE id=?").get(id) as any;
    if (!row || !["failed", "unconfirmed"].includes(row.state))
      throw Error("Notification is not retryable");
    if (row.state === "unconfirmed" && !reconciled)
      throw Error(
        "Reconcile uncertain delivery first; retry can duplicate a delivered message",
      );
    this.delivery(id, "pending", "Explicit retry");
  }
  reserve(project: string, night: string, job: string) {
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(night) ||
      new Date(night).toISOString().slice(0, 10) !== night
    )
      throw Error("Invalid night");
    if (
      fs.existsSync(
        path.join(
          project,
          ".zcode-dispatch",
          "state",
          "nights",
          night + ".json",
        ),
      )
    )
      throw Error("This project/night already has a legacy reservation");
    this.db
      .query("INSERT INTO nights VALUES (?,?,?)")
      .run(keyFor(project), night, job);
  }
  close() {
    this.db.close();
  }
}
