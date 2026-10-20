"use client";
import {
  useState,
  useEffect,
  useLayoutEffect,
  useRef,
  useCallback,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import {
  FolderOpen,
  Search,
  Leaf,
  ArrowUp,
  ArrowRight,
  Plus,
  Mic,
  Square,
  X,
  Check,
  ChevronRight,
  FileText,
  Download,
  LogOut,
  Link2,
  ArrowLeft,
  Headphones,
  MoreHorizontal,
  Paperclip,
  LoaderCircle,
} from "lucide-react";
import { Markdown } from "./markdown";
type Row = Record<string, any>;
type View = "home" | "projects" | "recall" | "settings" | "inventory";
function csrf() {
  return (
    document.cookie
      .split("; ")
      .find((s) => s.startsWith("sb_csrf="))
      ?.split("=")[1] ?? ""
  );
}
async function api(path: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers);
  if (options.body && !(options.body instanceof FormData))
    headers.set("Content-Type", "application/json");
  if (options.method && options.method !== "GET")
    headers.set("X-CSRF-Token", csrf());
  const r = await fetch("/api/v1" + path, {
    ...options,
    headers,
    cache: "no-store",
  });
  if (!r.ok) {
    const b = await r.json().catch(() => ({}));
    throw Object.assign(
      new Error(b.error?.message ?? "Something went wrong. Try again."),
      { status: r.status, code: b.error?.code },
    );
  }
  return r.status === 204 ? null : r.json();
}
const date = (s: string) =>
  new Date(s).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const label = (s: string) => s.replaceAll("_", " ");
const day = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
const moment = (at: string) =>
  new Date(at).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
/** Where a task sits on the calendar: a deadline, a window or a start, with the user's own words. */
function when(i: Row) {
  const start = i.startDate ? day(i.startDate) : i.startAt && moment(i.startAt),
    due = i.dueDate ? day(i.dueDate) : i.dueAt && moment(i.dueAt);
  const dates =
    start && due
      ? `${start} – ${due}`
      : due
        ? `due ${due}`
        : start
          ? i.startAt
            ? start
            : `from ${start}`
          : null;
  const repeats =
    i.repeatEvery &&
    (i.repeatInterval > 1
      ? `every ${i.repeatInterval} ${i.repeatEvery}s`
      : `every ${i.repeatEvery}`);
  return [dates, repeats, i.dueHint].filter(Boolean).join(" · ") || null;
}
const calm = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
/** Crossfades whole-view changes; the composer and header keep their identity.
 *  `after` runs once the new view is in the DOM, before it is shown. */
function transition(update: () => void, after?: () => void) {
  const apply = () => {
    flushSync(update);
    after?.();
  };
  if (!("startViewTransition" in document) || calm()) return apply();
  document.startViewTransition(apply);
}
/** Animates content in and out by height, keeping the last content while it leaves. */
function Reveal({
  open,
  children,
  className = "",
}: {
  open: boolean;
  children?: ReactNode;
  className?: string;
}) {
  const [mounted, setMounted] = useState(open),
    last = useRef(children);
  if (open) last.current = children;
  useEffect(() => {
    if (open) setMounted(true);
    else if (calm()) setMounted(false);
  }, [open]);
  if (!mounted && !open) return null;
  return (
    <div
      className={open ? "reveal open" : "reveal"}
      inert={!open}
      onTransitionEnd={(e) => {
        if (e.target === e.currentTarget && !open) setMounted(false);
      }}
    >
      <div className={className}>{open ? children : last.current}</div>
    </div>
  );
}
function Badge({
  children,
  tone = "",
}: {
  children: ReactNode;
  tone?: string;
}) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
function Empty({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}
function Button({
  children,
  onClick,
  disabled = false,
  secondary = false,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  secondary?: boolean;
}) {
  return (
    <button
      disabled={disabled}
      className={secondary ? "button secondary" : "button"}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
export default function App() {
  const [me, setMe] = useState<Row | null | undefined>(undefined),
    [view, setView] = useState<View>("home"),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [selected, setSelected] = useState<{
      type: "capture" | "item" | "source";
      id: string;
    } | null>(null),
    [refresh, setRefresh] = useState(0);
  const update = () => setRefresh((x) => x + 1);
  const load = useCallback(async () => {
    try {
      setMe(await api("/me"));
    } catch (e: any) {
      if (e.status === 401) setMe(null);
      else setError(e.message);
    }
  }, []);
  useEffect(() => {
    void load();
    const search = new URLSearchParams(location.search);
    if (
      ["home", "projects", "recall", "settings", "inventory"].includes(
        search.get("view") ?? "",
      )
    )
      setView(
        search.get("view") === "recall" ? "home" : (search.get("view") as View),
      );
    if ("serviceWorker" in navigator)
      void navigator.serviceWorker.register("/sw.js");
  }, [load]);
  useEffect(() => {
    if (notice) {
      const t = setTimeout(() => setNotice(""), 4000);
      return () => clearTimeout(t);
    }
  }, [notice]);
  const go = (v: View) => {
    setView(v === "recall" ? "home" : v);
    setSelected(null);
    setError("");
    history.replaceState(null, "", `?view=${v}`);
  };
  // Views open at the top; the conversation keeps its place when you come back.
  const homeScroll = useRef(0);
  const leave = () => {
    if (view === "home" && !selected) homeScroll.current = scrollY;
  };
  const place = (top: number) => scrollTo({ top, behavior: "instant" });
  const navigate = (v: View) =>
    transition(
      () => {
        leave();
        go(v);
      },
      () => place(v === "home" || v === "recall" ? homeScroll.current : 0),
    );
  const menu = useRef<HTMLDetailsElement>(null);
  // The menu closes on outside press or Escape, like any popover.
  useEffect(() => {
    const close = (e: Event) => {
      const el = menu.current;
      if (!el?.open) return;
      if (e instanceof KeyboardEvent) {
        if (e.key !== "Escape") return;
        el.querySelector("summary")?.focus();
      } else if (el.contains(e.target as Node)) return;
      el.open = false;
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, []);
  const run = async (fn: () => Promise<unknown>) => {
    setError("");
    try {
      await fn();
      update();
    } catch (e: any) {
      setError(e.message);
      if (e.status === 401) setMe(null);
    }
  };
  if (me === undefined)
    return (
      <div className="loading">
        Loading…{error && <p role="alert">{error}</p>}
      </div>
    );
  if (me === null) return <Login onLogin={load} />;
  const open = (type: "capture" | "item" | "source", id: string) =>
    transition(
      () => {
        leave();
        setSelected({ type, id });
      },
      () => place(0),
    );
  return (
    <div className="app-shell">
      <header className="app-header">
        <button className="app-name" onClick={() => navigate("home")}>
          Second Brain
        </button>
        <details className="app-menu" ref={menu}>
          <summary aria-label="Open menu">
            <MoreHorizontal size={20} />
          </summary>
          <div
            className="menu-options"
            onClick={(e) =>
              e.currentTarget.closest("details")?.removeAttribute("open")
            }
          >
            <button
              onClick={() =>
                transition(
                  () => {
                    go("home");
                    setRefresh((x) => x + 1);
                    window.dispatchEvent(new Event("show-history"));
                  },
                  () => place(0),
                )
              }
            >
              Earlier conversations
            </button>
            <button onClick={() => navigate("inventory")}>Records</button>

            <button onClick={() => navigate("settings")}>Settings</button>
          </div>
        </details>
      </header>
      <main>
        <div className="main-content">
          <Reveal open={!!error}>
            <div className="alert" role="alert">
              {error}
              <button aria-label="Dismiss error" onClick={() => setError("")}>
                <X size={16} />
              </button>
            </div>
          </Reveal>
          {notice && (
            <div className="toast" role="status">
              <Check size={15} />
              {notice}
            </div>
          )}
          <div
            className="view-transition"
            hidden={view !== "home" || !!selected}
          >
            <Chat me={me} refresh={refresh} open={open} onSaved={update} />
          </div>
          <div
            className="view-transition"
            key={selected ? `${selected.type}:${selected.id}` : view}
          >
            {selected ? (
              <Detail
                key={`${selected.type}:${selected.id}:${refresh}`}
                selected={selected}
                open={open}
                back={() =>
                  transition(
                    () => setSelected(null),
                    () => place(view === "home" ? homeScroll.current : 0),
                  )
                }
                run={run}
                navigate={navigate}
              />
            ) : (
              <>
                {view === "projects" && (
                  <Projects refresh={refresh} open={open} run={run} />
                )}
                {view === "inventory" && (
                  <Inventory
                    refresh={refresh}
                    open={open}
                    navigate={navigate}
                  />
                )}

                {view === "settings" && (
                  <SettingsView
                    me={me}
                    run={run}
                    reload={load}
                    logout={() => setMe(null)}
                  />
                )}
              </>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
function Login({ onLogin }: { onLogin: () => void }) {
  const [password, setPassword] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    void api("/auth/csrf").catch((e) => setError(e.message));
  }, []);
  return (
    <div className="login-page">
      <div className="login-card">
        <h1>Second Brain</h1>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            try {
              await api("/auth/login", {
                method: "POST",
                body: JSON.stringify({ password }),
              });
              setPassword("");
              onLogin();
            } catch (e: any) {
              setError(e.message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
          <button className="button" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}
function useList(path: string, refresh = 0) {
  const [data, setData] = useState<Row[]>([]),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [cursor, setCursor] = useState<string | null>(null),
    [tick, setTick] = useState(0);
  useEffect(() => {
    if (
      !path.startsWith("/items") &&
      !path.startsWith("/reviews") &&
      !data.some((r) =>
        ["queued", "transcribing", "organizing"].includes(r.state),
      )
    )
      return;
    const t = setTimeout(() => setTick((x) => x + 1), 5000);
    return () => clearTimeout(t);
  }, [data, path]);
  useEffect(() => {
    let live = true;
    setLoading(true);
    api(path)
      .then((r) => {
        if (live) {
          setData(r.items ?? []);
          setCursor(r.nextCursor);
          setError("");
        }
      })
      .catch((e) => live && setError(e.message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [path, refresh, tick]);
  const more = async () => {
    try {
      const r = await api(
        `${path}${path.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(cursor!)}`,
      );
      setData((d) => [...d, ...r.items]);
      setCursor(r.nextCursor);
    } catch (e: any) {
      setError(e.message);
    }
  };
  return { data, error, loading, cursor, more };
}
function Chat({ me, refresh, open, onSaved }: any) {
  const [turns, setTurns] = useState<Row[]>([]),
    [earlier, setEarlier] = useState(false);
  const conversation = useRef<string | undefined>(undefined);
  const captures = useList("/conversations?limit=25", refresh);
  useEffect(() => {
    const show = () => setEarlier(true);
    window.addEventListener("show-history", show);
    return () => window.removeEventListener("show-history", show);
  }, []);
  // The first message moves the composer from the center to the bottom.
  const arrive = (turn: Row) =>
    (turns.length || earlier ? (f: () => void) => f() : transition)(() =>
      setTurns((t) => [...t, turn]),
    );
  // Every message goes to one agent turn; it decides what the message was.
  async function submit(text: string, clientId: string) {
    const send = (messageId: string) =>
      api("/messages", {
        method: "POST",
        body: JSON.stringify({
          clientMessageId: messageId,
          text,
          ...(conversation.current
            ? { conversationId: conversation.current }
            : {}),
        }),
      });
    let saved;
    try {
      saved = await send(clientId);
    } catch (e: any) {
      // The ongoing conversation was deleted elsewhere; start a new one.
      if (e.code !== "CONVERSATION_NOT_FOUND" || !conversation.current) throw e;
      conversation.current = undefined;
      saved = await send(crypto.randomUUID());
    }
    conversation.current = saved.conversationId;
    arrive({ id: saved.messageId, sourceId: saved.sourceId, text });
    onSaved();
  }
  return (
    <section
      className={
        turns.length || earlier ? "chat active-chat" : "chat empty-chat"
      }
      aria-label="Conversation"
    >
      <h1 className="sr-only">Second Brain</h1>
      {earlier && (
        <section className="earlier-conversations">
          <div className="section-heading">
            <h2>Earlier conversations</h2>
            <button
              className="text-button"
              onClick={() => transition(() => setEarlier(false))}
            >
              Close
            </button>
          </div>
          {captures.data.map((c) => (
            <PastConversation key={c.id} capture={c} open={open} />
          ))}
          <ListStatus list={captures} />
          {!captures.loading && !captures.data.length && (
            <p className="quiet">Nothing saved yet.</p>
          )}
        </section>
      )}
      <div className="chat-timeline" role="log" aria-label="Messages">
        {turns.map((t) => (
          <ChatTurn
            key={t.id}
            turn={t}
            me={me}
            open={open}
            onChange={onSaved}
          />
        ))}
      </div>
      <div className="chat-composer">
        <Capture
          compact={!!turns.length || earlier}
          onSaved={onSaved}
          onAudioSaved={() => {
            onSaved();
            transition(() => setEarlier(true));
          }}
          onSubmit={submit}
        />
      </div>
    </section>
  );
}
function PastConversation({ capture, open }: any) {
  const [expanded, setExpanded] = useState(false),
    [data, setData] = useState<Row | null>(null),
    [error, setError] = useState(""),
    [version, setVersion] = useState(0);
  useEffect(() => {
    if (expanded)
      void api("/conversations/" + capture.id)
        .then(setData)
        .catch((e) => setError(e.message));
  }, [expanded, capture.id, version]);
  const reload = () => setVersion((v) => v + 1);
  const turns: Row[] = data?.turns ?? [];
  const user: Row[] =
    data?.messages.filter((m: Row) => m.role === "user") ?? [];
  const loose = turns.filter((t) => !t.messageId);
  return (
    <article className="past-conversation">
      <button
        className="past-heading"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        <span>{capture.title ?? "Audio recording"}</span>
        <time>{date(capture.createdAt)}</time>
      </button>
      <Reveal open={expanded && !!(data || error)} className="past-body">
        <>
          {error && <p role="alert">{error}</p>}
          {user.map((m) => {
            const turn = turns.find((t) => t.messageId === m.id);
            return (
              <div
                key={m.id}
                className={
                  turn && turn.messageKind !== "note"
                    ? "past-turn"
                    : "past-turn saved"
                }
              >
                <div className="user-message">
                  <p>{m.content}</p>
                </div>
                {turn && <TurnView turn={turn} open={open} onUndone={reload} />}
              </div>
            );
          })}
          {loose.map((t) => (
            <div key={t.id} className="past-turn saved">
              <TurnView turn={t} open={open} onUndone={reload} />
            </div>
          ))}
          <button
            className="text-button"
            onClick={() => open("capture", capture.id)}
          >
            Details
          </button>
        </>
      </Reveal>
    </article>
  );
}
const verbs: Record<string, string> = {
  completed: "Done",
  cancelled: "Cancelled",
  reopened: "Reopened",
  updated: "Updated",
  linked: "Linked",
  archived: "Archived",
};
const created: Record<string, string> = {
  task: "Commitment",
  project: "Project",
  memory: "Noted",
  idea: "Idea",
  entity: "Person or thing",
};
/** What the agent changed: one quiet row per item, each opening that item. */
function Actions({ actions, open }: { actions: Row[]; open: any }) {
  if (!actions?.length) return null;
  return (
    <ul className="turn-actions" aria-label="What was recorded">
      {actions.map((a, i) => (
        <li key={`${a.itemId}:${i}`}>
          <button className="action-row" onClick={() => open("item", a.itemId)}>
            <span className="action-verb">
              {a.type === "created"
                ? (created[a.kind] ?? "New")
                : verbs[a.type]}
            </span>
            <span className="action-title">{a.title}</span>
            {a.detail && <span className="action-detail">{a.detail}</span>}
            {a.certainty === "unconfirmed" && (
              <span className="badge">Unconfirmed</span>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}
/** Citations grouped by note: several quotes from one note are one source. */
function sourcesOf(citations: Row[]) {
  const bySource = new Map<string, string[]>();
  for (const c of citations)
    bySource.set(c.sourceId, [...(bySource.get(c.sourceId) ?? []), c.quote]);
  return [...bySource].map(([sourceId, quotes]) => ({ sourceId, quotes }));
}
/** A sourced answer: every claim links back to the user's own words. */
function AnswerView({ reply, open }: { reply: Row; open: any }) {
  return (
    <div className="assistant-message">
      <Markdown text={reply.text} />
      {reply.claims?.length > 0 && (
        <ul className="answer-claims">
          {reply.claims.map((c: Row, i: number) => {
            const sources = sourcesOf(c.citations);
            return (
              <li key={i}>
                <span>
                  <Markdown text={c.text} />
                </span>
                <span className="citation-chips">
                  {sources.map((s, j) => (
                    <button
                      key={s.sourceId}
                      onClick={() => open("source", s.sourceId)}
                      title={s.quotes.join("\n…\n")}
                    >
                      <Link2 size={13} />
                      {sources.length > 1 ? `Source ${j + 1}` : "Source"}
                    </button>
                  ))}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
function TurnView({
  turn,
  open,
  onUndone,
}: {
  turn: Row;
  open: any;
  onUndone?: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  if (turn.status === "invalidated")
    return <p className="message-status">{turn.reply.text}</p>;
  const kind = turn.kind ?? turn.messageKind;
  const note = kind === "note" || kind === "instruction";
  if (turn.status === "undone")
    return (
      <p className="message-status" role="status">
        {note ? "Saved · undone" : "Undone"}
      </p>
    );
  const undo = turn.canUndo && (
    <button
      className="text-button undo-button"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        setError("");
        void api(`/turns/${turn.id}/undo`, { method: "POST" })
          .then(() => onUndone?.())
          .catch((e) => setError(e.message))
          .finally(() => setBusy(false));
      }}
    >
      Undo
    </button>
  );
  return (
    <>
      {note ? (
        <p className="message-status" role="status">
          <Check size={13} strokeWidth={2.5} />
          Saved
          {undo && (
            <>
              <span className="status-separator" aria-hidden="true">
                ·
              </span>
              {undo}
            </>
          )}
        </p>
      ) : (
        <AnswerView reply={turn.reply} open={open} />
      )}
      <Actions actions={turn.actions} open={open} />
      {!note && undo && <p className="message-status">{undo}</p>}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
const blocked: Record<string, string> = {
  CONSENT_REQUIRED:
    "Saved. Cloud processing is off, so it hasn't been organized or answered.",
  PROVIDER_NOT_CONFIGURED:
    "Saved. No AI provider is set up, so it hasn't been organized or answered.",
};
function ChatTurn({ turn, open, onChange }: any) {
  const [state, setState] = useState<Row | null>(null),
    [matches, setMatches] = useState<Row[]>([]),
    [error, setError] = useState(""),
    [tick, setTick] = useState(0),
    article = useRef<HTMLElement>(null);
  const status: string = state?.status ?? "queued";
  const done = status === "done" && state?.turn;
  // Follow the newest turn as it arrives and as its answer grows in.
  useEffect(() => {
    const el = article.current;
    if (!el || el !== el.parentElement?.lastElementChild) return;
    const t = setTimeout(() => el.scrollIntoView({ block: "nearest" }), 340);
    return () => clearTimeout(t);
  }, [status, matches.length]);
  useEffect(() => {
    let live = true,
      timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const r = await api("/messages/" + turn.id);
        if (!live) return;
        setState(r);
        setError("");
        if (["done", "failed"].includes(r.status)) {
          if (r.status === "done") onChange?.();
          return;
        }
        // Quick while the agent works, so its progress and answer stream in.
        timer = setTimeout(
          () => void poll(),
          r.status === "working" ? 400 : r.status === "blocked" ? 15000 : 1200,
        );
      } catch (e: any) {
        if (!live) return;
        setError(e.message);
        timer = setTimeout(() => void poll(), 5000);
      }
    };
    void poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [turn.id, tick]);
  // Without AI the agent can't answer; keyword matches still find saved notes.
  useEffect(() => {
    if (status !== "blocked" || matches.length) return;
    void api("/search?q=" + encodeURIComponent(turn.text))
      .then((r) =>
        setMatches(r.items.filter((s: Row) => s.sourceId !== turn.sourceId)),
      )
      .catch(() => {});
  }, [status, turn.text, turn.sourceId, matches.length]);
  const kind = state?.turn?.kind;
  const pending = ["queued", "working", "retrying"].includes(status);
  // A question's answer as the agent writes it; the committed turn replaces it.
  const draft: string | null = (pending && state?.progress?.reply) || null;
  const activity: string | undefined = state?.progress?.activity;
  return (
    <article
      ref={article}
      className={
        draft || (done && kind !== "note" && kind !== "instruction")
          ? "chat-turn"
          : "chat-turn saved"
      }
      style={{ viewTransitionName: `turn-${turn.id}` }}
    >
      <div className="user-message">
        <p>{turn.text}</p>
      </div>
      <Reveal open={pending && !draft}>
        <p className="message-status" role="status" data-pending="true">
          {status === "retrying"
            ? "Saved · retrying"
            : activity
              ? `Saved · ${activity.charAt(0).toLowerCase()}${activity.slice(1)}`
              : "Saved · working on it"}
        </p>
      </Reveal>
      <Reveal open={status === "blocked"}>
        <p className="message-status" role="status">
          {blocked[state?.blockedReason] ??
            "Saved. It will be organized when processing is available."}
        </p>
      </Reveal>
      <Reveal open={status === "failed"}>
        <p className="message-status" role="status">
          Saved, but I couldn’t process it.
          <button
            className="text-button"
            onClick={() =>
              void api(`/messages/${turn.id}/retry`, { method: "POST" })
                .then(() => setTick((x) => x + 1))
                .catch((e) => setError(e.message))
            }
          >
            Retry
          </button>
        </p>
      </Reveal>
      <Reveal open={!!error}>
        <p className="error-text" role="alert">
          {error}
        </p>
      </Reveal>
      <Reveal open={!!done || !!draft}>
        {draft && !done && (
          <div className="assistant-message" data-draft="true" aria-busy="true">
            <Markdown text={draft} />
          </div>
        )}
        {done && (
          <TurnView
            turn={state!.turn}
            open={open}
            onUndone={() => {
              setTick((x) => x + 1);
              onChange?.();
            }}
          />
        )}
      </Reveal>
      <Reveal open={matches.length > 0}>
        <details className="chat-sources">
          <summary>
            Matching notes <span className="count">{matches.length}</span>
            <ChevronRight size={14} />
          </summary>
          {matches.map((s, i) => (
            <button
              key={s.sourceId + ":" + i}
              className="search-result"
              onClick={() => open("source", s.sourceId)}
            >
              <p>{s.content}</p>
              <span className="result-date">
                {date(s.createdAt)} · Open source
              </span>
            </button>
          ))}
        </details>
      </Reveal>
    </article>
  );
}
function Capture({
  onSaved,
  onSubmit,
  onAudioSaved,
  compact = false,
}: {
  compact?: boolean;
  onSaved: () => void;
  onAudioSaved?: () => void;
  onSubmit?: (text: string, clientId: string) => Promise<void>;
}) {
  const [text, setText] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [recording, setRecording] = useState(false),
    [seconds, setSeconds] = useState(0),
    [blob, setBlob] = useState<Blob | null>(null),
    [progress, setProgress] = useState(0),
    [online, setOnline] = useState(true);
  const client = useRef<string>(""),
    audioClient = useRef<string>(""),
    recorder = useRef<MediaRecorder | null>(null),
    chunks = useRef<Blob[]>([]),
    stream = useRef<MediaStream | null>(null),
    file = useRef<HTMLInputElement>(null),
    field = useRef<HTMLTextAreaElement>(null),
    discard = useRef(false);
  // Unsent text survives an expired session or reload in this tab.
  useEffect(() => {
    const draft = sessionStorage.getItem("sb-draft");
    if (draft) setText(draft);
  }, []);
  useEffect(() => {
    if (text) sessionStorage.setItem("sb-draft", text);
    else sessionStorage.removeItem("sb-draft");
  }, [text]);
  // The box grows with the thought instead of scrolling inside a fixed frame.
  // A layout change (centered to docked) is carried by the view transition, so it jumps.
  const wasCompact = useRef(compact);
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    const jump = wasCompact.current !== compact || calm();
    wasCompact.current = compact;
    const from = el.getBoundingClientRect().height;
    el.style.transition = "none";
    el.style.height = "auto";
    const to = el.scrollHeight;
    el.style.height = `${jump ? to : from}px`;
    void el.offsetHeight;
    el.style.transition = "";
    if (!jump) el.style.height = `${to}px`;
  }, [text, compact]);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
      stream.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);
  useEffect(() => {
    if (!recording) return;
    const t = setInterval(
      () =>
        setSeconds((s) => {
          if (s >= 1799) recorder.current?.stop();
          return s + 1;
        }),
      1000,
    );
    return () => clearInterval(t);
  }, [recording]);
  useEffect(() => {
    // A suggested question never replaces an unsent draft.
    const fill = (event: Event) =>
      setText((draft) =>
        draft.trim() ? draft : (event as CustomEvent<string>).detail,
      );
    window.addEventListener("compose-question", fill);
    return () => window.removeEventListener("compose-question", fill);
  }, []);
  async function save() {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError("");
    if (!client.current) client.current = crypto.randomUUID();
    try {
      if (onSubmit) await onSubmit(text, client.current);
      else
        await api("/captures/text", {
          method: "POST",
          body: JSON.stringify({ clientCaptureId: client.current, text }),
        });
      setText("");
      client.current = "";
      onSaved();
    } catch (e: any) {
      setError(e.message + " Your text is still here.");
    } finally {
      setBusy(false);
    }
  }
  async function record() {
    setError("");
    if (
      !navigator.mediaDevices?.getUserMedia ||
      typeof MediaRecorder === "undefined"
    ) {
      file.current?.click();
      return;
    }
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
      const mime = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find(
        (m) => MediaRecorder.isTypeSupported(m),
      );
      const r = new MediaRecorder(
        stream.current,
        mime ? { mimeType: mime } : undefined,
      );
      recorder.current = r;
      chunks.current = [];
      discard.current = false;
      r.ondataavailable = (e) => {
        if (e.data.size) chunks.current.push(e.data);
      };
      r.onstop = () => {
        setRecording(false);
        stream.current?.getTracks().forEach((t) => t.stop());
        if (!discard.current) {
          setBlob(new Blob(chunks.current, { type: r.mimeType }));
          audioClient.current = crypto.randomUUID();
        }
      };
      setSeconds(0);
      setBlob(null);
      r.start(1000);
      setRecording(true);
    } catch {
      setError(
        "Microphone access is unavailable. You can upload a recording or type instead.",
      );
    }
  }
  async function upload() {
    if (!blob) return;
    setBusy(true);
    setError("");
    setProgress(0);
    try {
      const form = new FormData();
      form.append(
        "clientCaptureId",
        audioClient.current || crypto.randomUUID(),
      );
      form.append(
        "audio",
        blob,
        blob.type.includes("mp4")
          ? "recording.mp4"
          : blob.type.includes("wav")
            ? "recording.wav"
            : blob.type.includes("mpeg")
              ? "recording.mp3"
              : "recording.webm",
      );
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", "/api/v1/captures/audio");
        xhr.setRequestHeader("X-CSRF-Token", csrf());
        xhr.upload.onprogress = (e) =>
          e.lengthComputable &&
          setProgress(Math.round((e.loaded / e.total) * 100));
        xhr.onload = () => {
          if (xhr.status < 300) return resolve();
          // Proxies can answer with HTML; a parse error must not leave the upload pending.
          let message = "Upload failed";
          try {
            message = JSON.parse(xhr.responseText).error?.message ?? message;
          } catch {}
          reject(new Error(message));
        };
        xhr.onerror = () => reject(new Error("Connection lost"));
        xhr.send(form);
      });
      setBlob(null);
      (onAudioSaved ?? onSaved)();
    } catch (e: any) {
      setError(
        e.message + ". The recording is still here; retry or download it.",
      );
    } finally {
      setBusy(false);
    }
  }
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  return (
    <>
      <div className={recording ? "composer recording" : "composer"}>
        <textarea
          ref={field}
          id="capture-text"
          rows={1}
          readOnly={busy}
          aria-busy={busy}
          placeholder="Write something, or ask…"
          aria-label="Write or ask"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (client.current) client.current = "";
          }}
          onKeyDown={(e) => {
            // Touch keyboards have no Shift + Enter, so Enter stays a new line there.
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing &&
              !matchMedia("(pointer: coarse)").matches
            ) {
              e.preventDefault();
              void save();
            }
          }}
        />
        <Reveal open={recording}>
          <div className="composer-strip" role="status">
            <span className="record-dot" />
            <span className="strip-label">
              {seconds >= 1500
                ? `${clock} · Stops at 30:00`
                : `Recording · ${clock}`}
            </span>
            <button
              className="strip-action"
              onClick={() => {
                discard.current = true;
                recorder.current?.stop();
              }}
            >
              Discard
            </button>
          </div>
        </Reveal>
        <Reveal open={!!blob}>
          {blob && (
            <div className="composer-strip">
              <Headphones size={16} />
              <span className="strip-label">
                Recording · {(blob.size / 1024 / 1024).toFixed(1)} MB
              </span>
              <button
                className="strip-action"
                onClick={() => {
                  const url = URL.createObjectURL(blob),
                    a = document.createElement("a");
                  a.href = url;
                  a.download = blob.type.includes("mp4")
                    ? "brain-dump.mp4"
                    : "brain-dump.webm";
                  a.click();
                  setTimeout(() => URL.revokeObjectURL(url), 1000);
                }}
              >
                Download
              </button>
              <button
                className="strip-action primary"
                disabled={busy || !online}
                onClick={() => void upload()}
              >
                {busy ? `Uploading ${progress}%` : "Save recording"}
              </button>
              <button
                className="strip-icon"
                aria-label="Discard recording"
                disabled={busy}
                onClick={() => setBlob(null)}
              >
                <X size={16} />
              </button>
            </div>
          )}
        </Reveal>
        <Reveal open={!!error || !online}>
          <p className="composer-note" role={error ? "alert" : "status"}>
            {error ||
              "You’re offline. Keep this page open; your thought has not been saved yet."}
          </p>
        </Reveal>
        <div className="composer-bar">
          <button
            className={recording ? "tool-button active" : "tool-button"}
            aria-label={recording ? "Stop recording" : "Record"}
            title={recording ? "Stop recording" : "Record"}
            onClick={() =>
              recording ? recorder.current?.stop() : void record()
            }
            disabled={busy || (!!blob && !recording)}
          >
            {recording ? (
              <Square size={14} fill="currentColor" />
            ) : (
              <Mic size={18} />
            )}
          </button>
          <button
            className="tool-button"
            aria-label="Upload audio"
            title="Upload audio"
            onClick={() => file.current?.click()}
            disabled={recording || busy || !!blob}
          >
            <Paperclip size={17} />
          </button>
          <input
            ref={file}
            hidden
            type="file"
            accept="audio/*,.webm,.mp4,.m4a"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) {
                setBlob(f);
                audioClient.current = crypto.randomUUID();
              }
              e.target.value = "";
            }}
          />
          <button
            className="send-button"
            aria-label="Send"
            disabled={!text.trim() || busy || !online}
            onClick={() => void save()}
          >
            {busy && !blob ? (
              <LoaderCircle size={18} className="spin" />
            ) : (
              <ArrowUp size={18} strokeWidth={2.25} />
            )}
          </button>
        </div>
      </div>
      <p className="composer-hint" aria-hidden="true">
        <kbd>Enter</kbd> to send · <kbd>Shift</kbd> + <kbd>Enter</kbd> for a new
        line
      </p>
    </>
  );
}
function PageTitle({
  title,
  description,
}: {
  eyebrow?: string;
  title: string;
  description: string;
}) {
  return (
    <div className="page-title">
      <h1>{title}</h1>
      {description && <p>{description}</p>}
    </div>
  );
}
function ListStatus({ list }: any) {
  return (
    <>
      {list.loading && (
        <p className="quiet" role="status">
          Loading…
        </p>
      )}
      {list.error && (
        <p className="error-text" role="alert">
          {list.error}
        </p>
      )}
      {list.cursor && (
        <Button secondary onClick={() => void list.more()}>
          Load more
        </Button>
      )}
    </>
  );
}
function Projects({ refresh, open, run }: any) {
  const [archived, setArchived] = useState(false),
    [adding, setAdding] = useState(false),
    [title, setTitle] = useState(""),
    [content, setContent] = useState("");
  const list = useList(
    `/items?kind=project&lifecycle=${archived ? "archived" : "active"}`,
    refresh,
  );
  return (
    <>
      <PageTitle eyebrow="PICK UP THE THREAD" title="Projects" description="" />
      <div className="toolbar">
        <div className="tabs">
          <button
            className={!archived ? "active" : ""}
            onClick={() => setArchived(false)}
          >
            Active
          </button>
          <button
            className={archived ? "active" : ""}
            onClick={() => setArchived(true)}
          >
            Archived
          </button>
        </div>
        <Button secondary onClick={() => setAdding(!adding)}>
          <Plus size={16} />
          New project
        </Button>
      </div>
      <Reveal open={adding}>
        <form
          className="panel inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await api("/items", {
                method: "POST",
                body: JSON.stringify({ kind: "project", title, content }),
              });
              setAdding(false);
              setTitle("");
              setContent("");
            });
          }}
        >
          <label>
            Project name
            <input
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label>
            What is this about?
            <textarea
              required
              value={content}
              onChange={(e) => setContent(e.target.value)}
            />
          </label>
          <button className="button">
            Create project
            <ArrowRight size={16} />
          </button>
        </form>
      </Reveal>
      <div className="project-grid">
        {list.data.map((p, index) => (
          <button
            key={p.id}
            className="project-card"
            onClick={() => open("item", p.id)}
          >
            <span className={`project-icon color-${index % 3}`}>
              <FolderOpen size={23} />
            </span>
            <Badge>{p.lifecycle}</Badge>
            <h3>{p.title}</h3>
            <p>{p.content || "No description."}</p>
            <span className="project-footer">
              Updated {date(p.updatedAt)}
              <ArrowRight size={17} />
            </span>
          </button>
        ))}
      </div>
      {!list.loading && !list.data.length && (
        <Empty title="No projects">
          Create a project or mention one in a capture.
        </Empty>
      )}
      <ListStatus list={list} />
    </>
  );
}
const states: Record<string, [string, string][]> = {
  task: [
    ["open", "Open"],
    ["done", "Done"],
    ["all", "All"],
  ],
  memory: [
    ["active", "Current"],
    ["superseded", "Replaced"],
    ["archived", "Archived"],
  ],
};
/** One line of context for a record: who asked, when, and how sure. */
function recordLine(i: Row) {
  if (i.kind !== "task") return i.content.slice(0, 110);
  return (
    [
      i.status !== "open" && label(i.status),
      i.requestedBy && `for ${i.requestedBy}`,
      when(i),
      i.agreedAt && `agreed ${date(i.agreedAt)}`,
    ]
      .filter(Boolean)
      .join(" · ") || i.content.slice(0, 110)
  );
}
function Inventory({ refresh, open, navigate }: any) {
  const [kind, setKind] = useState("task"),
    [state, setState] = useState("open");
  const options = states[kind] ?? [
    ["active", "Current"],
    ["archived", "Archived"],
  ];
  const query =
    kind === "task"
      ? `kind=task${state === "all" ? "" : `&status=${state}`}`
      : `kind=${kind}&lifecycle=${state}`;
  const list = useList(`/items?${query}`, refresh);
  return (
    <>
      <PageTitle
        title="Records"
        description="Everything your notes were organized into."
      />
      <button className="text-button" onClick={() => navigate("projects")}>
        Manage projects
      </button>
      <div className="toolbar">
        <select
          aria-label="Record type"
          value={kind}
          onChange={(e) => {
            setKind(e.target.value);
            setState(e.target.value === "task" ? "open" : "active");
          }}
        >
          {["task", "project", "memory", "idea", "entity"].map((k) => (
            <option key={k} value={k}>
              {k === "task"
                ? "Commitments"
                : k === "entity"
                  ? "People & things"
                  : `${label(k)}s`}
            </option>
          ))}
        </select>
        <select
          aria-label="Record state"
          value={state}
          onChange={(e) => setState(e.target.value)}
        >
          {options.map(([value, name]) => (
            <option key={value} value={value}>
              {name}
            </option>
          ))}
        </select>
      </div>
      <div className="list-card">
        {list.data.map((i) => (
          <button
            className="capture-row"
            key={i.id}
            onClick={() => open("item", i.id)}
          >
            <span className="row-icon">
              {i.kind === "task" && i.status === "completed" ? (
                <Check size={18} />
              ) : (
                <FileText size={18} />
              )}
            </span>
            <div>
              <strong>{i.title}</strong>
              <small>{recordLine(i)}</small>
            </div>
            {i.certainty === "unconfirmed" && <Badge>Unconfirmed</Badge>}
            <ChevronRight size={16} />
          </button>
        ))}
      </div>
      {!list.loading && !list.data.length && (
        <Empty title="Nothing here">
          Records appear as your notes are organized.
        </Empty>
      )}
      <ListStatus list={list} />
    </>
  );
}
function Detail({ selected, open, back, run, navigate }: any) {
  const [data, setData] = useState<Row | null>(null),
    [error, setError] = useState(""),
    [editing, setEditing] = useState(false),
    [title, setTitle] = useState(""),
    [content, setContent] = useState(""),
    [reason, setReason] = useState(""),
    [correcting, setCorrecting] = useState(false),
    [deleting, setDeleting] = useState<Row | null>(null);
  const path =
    selected.type === "capture"
      ? "/conversations/"
      : selected.type === "source"
        ? "/sources/"
        : "/items/";
  useEffect(() => {
    let live = true;
    api(path + selected.id)
      .then((r) => {
        if (live) {
          setData(r);
          setTitle(r.title ?? "");
          setContent(r.content ?? "");
        }
      })
      .catch((e) => setError(e.message));
    return () => {
      live = false;
    };
  }, [path, selected.id]);
  const events = useList(
    selected.type === "item"
      ? `/items/${selected.id}/events`
      : "/items?limit=1",
  );
  if (error)
    return (
      <div className="alert" role="alert">
        {error}
      </div>
    );
  if (!data) return <p className="quiet">Opening…</p>;
  return (
    <>
      <button className="text-button back-button" onClick={back}>
        <ArrowLeft size={16} />
        Back
      </button>
      {selected.type === "capture" ? (
        <>
          <PageTitle
            eyebrow={label(data.conversation.mode).toUpperCase()}
            title={data.conversation.title ?? "Capture"}
            description={`Saved ${new Date(data.conversation.createdAt).toLocaleString()}`}
          />
          <div className="detail-toolbar">
            <Badge
              tone={data.conversation.state === "failed" ? "warning" : "green"}
            >
              {label(data.conversation.state)}
            </Badge>
            {data.conversation.state === "failed" && (
              <Button
                secondary
                onClick={() =>
                  run(() =>
                    api(`/conversations/${selected.id}/retry`, {
                      method: "POST",
                    }),
                  )
                }
              >
                Retry processing
              </Button>
            )}
            <button
              className="text-button danger"
              onClick={() =>
                run(async () =>
                  setDeleting(
                    await api(`/conversations/${selected.id}/deletion-impact`),
                  ),
                )
              }
            >
              Delete capture
            </button>
          </div>
          {data.attachments.map((a: Row) => (
            <div className="panel" key={a.id}>
              {a.state === "available" ? (
                <audio
                  controls
                  preload="none"
                  src={`/api/v1/attachments/${a.id}/content`}
                />
              ) : (
                <p className="quiet">
                  The recording has expired. Your transcript stays here.
                </p>
              )}
            </div>
          ))}
          {data.messages.map((m: Row) => (
            <article className="panel source-text" key={m.id}>
              <span className="eyebrow">
                {m.role === "user" ? "YOUR WORDS" : "REPLY"}
              </span>
              {m.role === "user" ? (
                <p>{m.content}</p>
              ) : (
                <Markdown text={m.content} />
              )}
              {m.sourceId && (
                <button
                  className="text-button"
                  onClick={() => open("source", m.sourceId)}
                >
                  <Link2 size={14} />
                  Open original source
                </button>
              )}
            </article>
          ))}
          {data.jobs.length > 0 && (
            <div className="panel">
              <h3>Processing</h3>
              {data.jobs.map((j: Row) => (
                <div className="job-row" key={j.id}>
                  <span>
                    {(
                      {
                        transcribe: "Transcribing",
                        converse: "Understanding and organizing",
                        embed: "Making it searchable",
                      } as Row
                    )[j.kind] ?? label(j.kind)}
                  </span>
                  <Badge tone={j.status === "failed" ? "warning" : ""}>
                    {j.blockedReason === "CONSENT_REQUIRED"
                      ? "Cloud processing is off"
                      : j.blockedReason === "PROVIDER_NOT_CONFIGURED"
                        ? "Provider setup needed"
                        : label(j.status)}
                  </Badge>
                </div>
              ))}
            </div>
          )}
          {data.turns.some((t: Row) => t.actions.length > 0) && (
            <div className="panel">
              <h3>What was recorded</h3>
              {data.turns.map((t: Row) => (
                <Actions key={t.id} actions={t.actions} open={open} />
              ))}
            </div>
          )}
        </>
      ) : selected.type === "source" ? (
        <>
          <PageTitle
            eyebrow="THE ORIGINAL SOURCE"
            title="Source"
            description={`Captured ${new Date(data.capturedAt).toLocaleString()}`}
          />
          <div className="panel source-text">
            <p>{data.content}</p>
            <button
              className="text-button"
              onClick={() => open("capture", data.conversationId)}
            >
              <Link2 size={14} />
              Open full capture
            </button>
            {data.attachmentId && data.audioState === "available" && (
              <audio
                controls
                preload="none"
                src={`/api/v1/attachments/${data.attachmentId}/content#t=${Math.floor((data.audioStartMs ?? 0) / 1000)}`}
              />
            )}
          </div>
        </>
      ) : (
        <>
          <PageTitle
            eyebrow={
              data.kind === "task" ? "COMMITMENT" : data.kind.toUpperCase()
            }
            title={data.title}
            description={`Last updated ${date(data.updatedAt)} · Revision ${data.revision}`}
          />
          {data.kind === "task" && (
            <dl className="item-facts">
              {[
                ["Status", label(data.status)],
                ["Asked by", data.requestedBy],
                ["Agreed", data.agreedAt && date(data.agreedAt)],
                ["When", when(data)],
                [
                  "Last mentioned",
                  data.lastMentionedAt && date(data.lastMentionedAt),
                ],
              ]
                .filter(([, value]) => value)
                .map(([name, value]) => (
                  <div key={name}>
                    <dt>{name}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
            </dl>
          )}
          <div className="detail-toolbar">
            {(data.certainty === "unconfirmed" || data.kind !== "task") && (
              <Badge tone={data.certainty === "unconfirmed" ? "warning" : ""}>
                {data.certainty === "unconfirmed"
                  ? "Unconfirmed"
                  : data.lifecycle}
              </Badge>
            )}
            <Button secondary onClick={() => setEditing(!editing)}>
              Edit
            </Button>
            {data.kind === "memory" && (
              <button
                className="text-button"
                onClick={() => setCorrecting(!correcting)}
              >
                I changed my mind
              </button>
            )}
            <button
              className="text-button"
              onClick={() =>
                run(() =>
                  api(`/items/${data.id}`, {
                    method: "PATCH",
                    headers: { "If-Match": `"${data.revision}"` },
                    body: JSON.stringify({
                      lifecycle:
                        data.lifecycle === "archived" ? "active" : "archived",
                    }),
                  }),
                )
              }
            >
              {data.lifecycle === "archived" ? "Restore" : "Archive"}
            </button>
          </div>
          <Reveal open={editing}>
            <form
              className="panel inline-form"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  await api(`/items/${data.id}`, {
                    method: "PATCH",
                    headers: { "If-Match": `"${data.revision}"` },
                    body: JSON.stringify({ title, content }),
                  });
                  setEditing(false);
                });
              }}
            >
              <label>
                Title
                <input
                  required
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </label>
              <label>
                Content
                <textarea
                  required
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                />
              </label>
              <button className="button">Save changes</button>
            </form>
          </Reveal>
          <Reveal open={!editing}>
            <div className="panel source-text">
              <p>{data.content || "No content."}</p>
              {data.kind === "task" && when(data) && (
                <p className="quiet">{when(data)}</p>
              )}
              {data.kind === "task" && data.status !== "completed" && (
                <Button
                  onClick={() =>
                    run(() =>
                      api(`/items/${data.id}`, {
                        method: "PATCH",
                        headers: { "If-Match": `"${data.revision}"` },
                        body: JSON.stringify({ status: "completed" }),
                      }),
                    )
                  }
                >
                  <Check size={16} />
                  Mark complete
                </Button>
              )}
            </div>
          </Reveal>
          <Reveal open={correcting}>
            <form
              className="panel inline-form"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  const next = await api(`/items/${data.id}/corrections`, {
                    method: "POST",
                    headers: { "If-Match": `"${data.revision}"` },
                    body: JSON.stringify({ assertion: content, reason }),
                  });
                  open("item", next.id);
                });
              }}
            >
              <h3>Correct memory</h3>
              <p className="quiet">
                The previous assertion stays in history, labeled superseded.
              </p>
              <label>
                Current assertion
                <textarea
                  required
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                />
              </label>
              <label>
                Reason
                <input
                  required
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </label>
              <button className="button">Save correction</button>
            </form>
          </Reveal>
          {data.kind === "project" && (
            <>
              <div className="project-context">
                {[
                  ["Last decision", data.lastDecision],
                  ["Current blocker", data.blocker],
                  ["Suggested next step", data.nextStep],
                ].map(([title, value]) => (
                  <div className="panel" key={title}>
                    <span className="eyebrow">{title}</span>
                    <p>{value || "Not captured yet."}</p>
                  </div>
                ))}
              </div>
              <Button
                secondary
                onClick={() => {
                  navigate("recall");
                  window.dispatchEvent(
                    new CustomEvent("compose-question", {
                      detail: `Where did I leave off with ${data.title}?`,
                    }),
                  );
                }}
              >
                <Search size={16} />
                Where did I leave off?
              </Button>
              <RelatedItems projectId={data.id} open={open} />
            </>
          )}
          <section className="detail-section">
            <h2>Sources</h2>
            <div className="list-card">
              {data.citations.map((c: Row, index: number) => (
                <button
                  key={index}
                  className="citation-row"
                  onClick={() => open("source", c.sourceId)}
                >
                  <Link2 size={16} />
                  <span>“{c.quote}”</span>
                  <ChevronRight size={16} />
                </button>
              ))}
            </div>
          </section>
          {data.relationships?.length > 0 && (
            <section className="detail-section">
              <h2>Relationships</h2>
              {data.relationships.map((r: Row) => (
                <button
                  key={r.id}
                  className="capture-row"
                  onClick={() =>
                    open(
                      "item",
                      r.fromItemId === data.id ? r.toItemId : r.fromItemId,
                    )
                  }
                >
                  <Link2 size={17} />
                  <div>
                    <strong>{r.relatedTitle}</strong>
                    <small>{label(r.type)}</small>
                  </div>
                  <ChevronRight size={16} />
                </button>
              ))}
            </section>
          )}
          <details className="panel">
            <summary>Revision history</summary>
            {events.data.map((e) => (
              <div key={e.id} className="event-row">
                <strong>{label(e.eventType)}</strong>
                <small>
                  {date(e.createdAt)} · {e.actor}
                </small>
                <p>{e.reason}</p>
              </div>
            ))}
            <ListStatus list={events} />
          </details>
        </>
      )}
      {deleting && (
        <div className="modal-backdrop">
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-title"
          >
            <h2 id="delete-title">Delete this capture?</h2>
            <p>
              The original, recording, and knowledge supported only by this
              capture will be removed.
            </p>
            <p>{deleting.items.length} knowledge records may be affected.</p>
            <p className="quiet">{deleting.backupNotice}</p>
            <div className="actions">
              <Button
                secondary
                onClick={() => transition(() => setDeleting(null))}
              >
                Keep capture
              </Button>
              <button
                className="button destructive"
                onClick={() =>
                  run(async () => {
                    await api(`/conversations/${selected.id}`, {
                      method: "DELETE",
                      body: JSON.stringify({ confirm: true }),
                    });
                    setDeleting(null);
                    back();
                  })
                }
              >
                Delete permanently
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
function RelatedItems({ projectId, open }: any) {
  const list = useList(`/items?projectId=${projectId}`);
  return (
    <section className="detail-section">
      <h2>Related records</h2>
      <div className="list-card">
        {list.data.map((i) => (
          <button
            key={i.id}
            className="capture-row"
            onClick={() => open("item", i.id)}
          >
            <FileText size={18} />
            <div>
              <strong>{i.title}</strong>
              <small>{i.kind}</small>
            </div>
            <ChevronRight size={16} />
          </button>
        ))}
      </div>
      <ListStatus list={list} />
    </section>
  );
}
function SettingsView({ me, run, reload, logout }: any) {
  const [timezone, setTimezone] = useState(me.timezone),
    [retention, setRetention] = useState(String(me.audioRetentionDays)),
    [ack, setAck] = useState(false),
    [exportId, setExportId] = useState(""),
    [exportReady, setExportReady] = useState(false),
    [audio, setAudio] = useState(false),
    [current, setCurrent] = useState(""),
    [password, setPassword] = useState(""),
    [allPassword, setAllPassword] = useState(""),
    [operations, setOperations] = useState<Row | null>(null);
  useEffect(() => {
    void api("/operations")
      .then(setOperations)
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (!exportId) return;
    const timer = setInterval(() => {
      void api(`/jobs/${exportId}`).then((j) => {
        if (j.status === "succeeded") {
          setExportReady(true);
          clearInterval(timer);
        }
        if (["failed", "cancelled"].includes(j.status)) clearInterval(timer);
      });
    }, 2000);
    return () => clearInterval(timer);
  }, [exportId]);
  return (
    <>
      <PageTitle eyebrow="PRIVATE BY DESIGN" title="Settings" description="" />
      <div className="settings-stack">
        <section className="panel settings-panel">
          <div className="settings-title">
            <span className="row-icon">
              <Leaf size={19} />
            </span>
            <div>
              <h2>Cloud processing</h2>
              {me.capabilities.provider === "chatgpt" && (
                <p>
                  Text reasoning uses your connected ChatGPT allowance. This
                  connection does not enable semantic embeddings or audio
                  transcription; originals remain saved and text search remains
                  available.
                </p>
              )}
              <p>
                Originals are stored on your server. Cloud AI can help organize
                and recall them.
              </p>
            </div>
          </div>
          <div className="setting-row">
            <div>
              <strong>Cloud processing</strong>
              <p>
                When enabled, recordings, transcripts, questions, and relevant
                memories are sent to your configured AI provider for
                transcription, organization, embeddings, and answers. Provider
                data policies apply. Turning this off prevents new calls.
              </p>
              <small>
                {me.capabilities.ai
                  ? `Configured provider: ${me.capabilities.provider}`
                  : "No cloud provider configured. Text capture and lexical search still work."}
              </small>
            </div>
            <button
              className={`toggle ${me.cloudConsentAt ? "on" : ""}`}
              role="switch"
              aria-checked={!!me.cloudConsentAt}
              aria-label="Cloud processing"
              onClick={() =>
                run(async () => {
                  await api("/settings", {
                    method: "PATCH",
                    body: JSON.stringify({ cloudConsent: !me.cloudConsentAt }),
                  });
                  await reload();
                })
              }
            >
              <span />
            </button>
          </div>
        </section>
        <form
          className="panel settings-panel"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await api("/settings", {
                method: "PATCH",
                body: JSON.stringify({
                  timezone,
                  audioRetentionDays: Number(retention),
                  acknowledgeShorterRetention: ack,
                }),
              });
              await reload();
            });
          }}
        >
          <h2>Preferences</h2>
          <label>
            Timezone
            <input
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              placeholder="Europe/Copenhagen"
            />
          </label>
          <label>
            Keep original audio for
            <select
              value={retention}
              onChange={(e) => setRetention(e.target.value)}
            >
              {[0, 7, 30, 90, 365].map((n) => (
                <option key={n} value={n}>
                  {n === 0 ? "Delete after processing" : `${n} days`}
                </option>
              ))}
            </select>
          </label>
          <p className="quiet">
            Transcripts and ideas remain searchable after audio expires.
          </p>
          {Number(retention) < me.audioRetentionDays && (
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={ack}
                onChange={(e) => setAck(e.target.checked)}
              />
              I understand this can delete existing recordings sooner.
            </label>
          )}
          <button className="button secondary">Save preferences</button>
        </form>
        <section className="panel settings-panel">
          <h2>Export</h2>
          <p>
            Export your originals, structured knowledge, sources, and revision
            history. The archive stays available for 24 hours.
          </p>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={audio}
              onChange={(e) => setAudio(e.target.checked)}
            />
            Include available audio recordings
          </label>
          <div className="actions">
            <Button
              secondary
              onClick={() =>
                run(async () => {
                  const e = await api("/exports", {
                    method: "POST",
                    body: JSON.stringify({ includeAudio: audio }),
                  });
                  setExportId(e.jobId);
                  setExportReady(false);
                })
              }
            >
              <Download size={16} />
              Create export
            </Button>
            {exportId &&
              (exportReady ? (
                <a
                  className="button"
                  href={`/api/v1/exports/${exportId}/download`}
                >
                  Download archive
                </a>
              ) : (
                <span className="quiet">Preparing your archive…</span>
              ))}
          </div>
        </section>
        <form
          className="panel settings-panel"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await api("/auth/password", {
                method: "POST",
                body: JSON.stringify({
                  currentPassword: current,
                  newPassword: password,
                }),
              });
              setCurrent("");
              setPassword("");
              logout();
            });
          }}
        >
          <h2>Password</h2>
          <label>
            Current password
            <input
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              required
            />
          </label>
          <label>
            New password
            <input
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={12}
              required
            />
          </label>
          <button className="button secondary">
            Change password & sign out
          </button>
        </form>
        <section className="panel settings-panel">
          <h2>Sessions</h2>
          <Button
            secondary
            onClick={() =>
              run(async () => {
                await api("/auth/logout", { method: "POST" });
                logout();
              })
            }
          >
            <LogOut size={16} />
            Sign out
          </Button>
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await api("/auth/logout-all", {
                  method: "POST",
                  body: JSON.stringify({ password: allPassword }),
                });
                setAllPassword("");
                logout();
              });
            }}
          >
            <label>
              Sign out every device
              <input
                type="password"
                autoComplete="current-password"
                placeholder="Confirm your password"
                required
                value={allPassword}
                onChange={(e) => setAllPassword(e.target.value)}
              />
            </label>
            <button className="text-button">Sign out all devices</button>
          </form>
        </section>
        <section className="panel settings-panel">
          <h2>Processing</h2>
          {operations ? (
            <>
              <p>
                {operations.jobs?.reduce(
                  (total: number, job: Row) =>
                    total +
                    (["pending", "retry_wait", "running"].includes(job.status)
                      ? job.count
                      : 0),
                  0,
                )}{" "}
                jobs waiting or running.
                {operations.processing?.oldestPendingSeconds != null &&
                  ` Oldest: ${Math.floor(operations.processing.oldestPendingSeconds / 60)} minutes.`}
              </p>
              {!!operations.processing?.expiredLeases && (
                <p role="status">
                  {operations.processing.expiredLeases} expired worker leases
                  awaiting recovery.
                </p>
              )}
              <p>
                {operations.vectors?.indexedChunks ?? 0} of{" "}
                {operations.vectors?.totalChunks ?? 0} chunks indexed for
                semantic search.
              </p>
              {operations.usage?.requests > 0 && (
                <p>
                  {operations.usage.requests} provider requests recorded ·{" "}
                  {operations.usage.inputTokens} input tokens ·{" "}
                  {operations.usage.outputTokens} output tokens.
                  {!!operations.usage.requestsWithoutTokenCounts &&
                    ` ${operations.usage.requestsWithoutTokenCounts} requests did not report token counts.`}
                </p>
              )}
              {operations.disk && (
                <p role={operations.disk.lowSpace ? "status" : undefined}>
                  {(operations.disk.availableBytes / 1073741824).toFixed(1)} GB
                  available.
                  {operations.disk.lowSpace && " Storage is running low."}
                </p>
              )}
              {operations.failures?.map((failure: Row) => (
                <p key={failure.id}>
                  {label(failure.kind)} failed · {failure.errorCode} ·{" "}
                  {date(failure.updatedAt)}
                </p>
              ))}
            </>
          ) : (
            <p>Processing status unavailable.</p>
          )}
        </section>
        <section className="panel settings-panel">
          <h2>Backups</h2>
          <p>
            Backups must include both your database and original files. Use the
            encrypted backup and restore commands on the server; keep a copy and
            recovery key somewhere separate.
          </p>
          <p className="quiet">
            Deleting a capture also removes derived knowledge and saved recall
            answers. Offline backups and downloaded exports retain their own
            copies until expired or removed.
          </p>
          <div className="operations-state">
            <strong>Recent backup status</strong>
            {operations?.backups?.length ? (
              operations.backups.map((b: Row) => (
                <p key={b.id}>
                  {label(b.kind)} · {b.status} · {date(b.createdAt)}
                </p>
              ))
            ) : (
              <p>No backup has been recorded yet.</p>
            )}
          </div>
        </section>
      </div>
    </>
  );
}
