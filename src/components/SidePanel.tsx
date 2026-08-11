import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useStore } from "../app/store";
import { mediaSrc } from "../api/net";
import type { PlanEntry } from "../api/types";
import { parseClock, planTimes } from "../lib/plan";
import { ScreenPreview } from "./Preview";
import { Icon, type IconName } from "./ui/Icon";
import { useContextMenu, type MenuEntry } from "./ui/ContextMenu";
import { useDialogs } from "./ui/Dialogs";
import { useGridReorder } from "../lib/dragReorder";
import { useTileSelection } from "../lib/selection";
import { useMarquee } from "../lib/marquee";
import { newTimer, startTimer } from "../lib/timer";

/** Small enough to be worth having, large enough to still be readable. */
const MIN_WIDTH = 210;
const MIN_HEIGHT = 130;
/** Never let a drag swallow the tab the operator is actually working in. */
const MAX_FRACTION = 0.6;

/**
 * The panel down the side of the content tabs.
 *
 * What the operator wants without leaving whatever tab they are on: what a
 * screen is showing this second, what it has shown already, and what is coming.
 * The setup tabs do not get it — nobody is driving a service while wiring up a
 * projector, and those tabs want the room.
 *
 * It docks right or bottom because neither suits every desk: a tall portrait
 * monitor has width to spare, a laptop has none and would rather give up
 * height.
 */
export function SidePanel() {
  const chosen = useStore((s) => s.sidePreviewDisplayId);
  const setSidePreviewDisplay = useStore((s) => s.setSidePreviewDisplay);
  const placement = useStore((s) => s.settings.sidePanelPlacement);
  const t = useStore((s) => s.t);
  const planCount = useStore((s) => s.plan.entries.length);
  // Plan first: on the way into a service it is the thing being built, and
  // history has nothing in it yet.
  const [view, setView] = useState<"plan" | "history">("plan");

  return (
    <aside className="sidepanel" data-placement={placement}>
      <ResizeHandle placement={placement} />
      <div className="sidepanel__section">
        <ScreenPreview
          chosen={chosen}
          onPick={setSidePreviewDisplay}
          className="sidepanel__preview"
        />
      </div>

      <div className="sidepanel__section sidepanel__section--grow">
        <div className="sidepanel__tabs">
          <button
            className="sidepanel__tab"
            aria-selected={view === "plan"}
            onClick={() => setView("plan")}
          >
            {t("plan.title")}
            {planCount > 0 && <span className="sidepanel__count">{planCount}</span>}
          </button>
          <button
            className="sidepanel__tab"
            aria-selected={view === "history"}
            onClick={() => setView("history")}
          >
            {t("history.title")}
          </button>
        </div>
        {/* Both stay mounted. Glancing at history and coming back should find
            the plan exactly as it was left — unmounting the list throws away
            what was picked, and the operator has to find it again mid-service.
            `display: contents` keeps the shown one a direct child of the
            section, so the layout is the same as rendering it alone. */}
        <div style={{ display: view === "plan" ? "contents" : "none" }}>
          <PlanList active={view === "plan"} />
        </div>
        <div style={{ display: view === "history" ? "contents" : "none" }}>
          <History />
        </div>
      </div>
    </aside>
  );
}

/**
 * The panel's leading edge, draggable.
 *
 * It sits over the border rather than beside it, so the thing the operator
 * reaches for is the line they can already see. `patchSettings` is optimistic
 * and only debounces the trip to disk, so the panel tracks the pointer while
 * the drag is still going.
 */
function ResizeHandle({ placement }: { placement: "right" | "bottom" }) {
  const patchSettings = useStore((s) => s.patchSettings);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    // Left button only, and never let the press start a text selection.
    if (event.button !== 0) return;
    event.preventDefault();

    const handle = event.currentTarget;
    const bottom = placement === "bottom";
    const { sidePanelWidth, sidePanelHeight } = useStore.getState().settings;
    const startPos = bottom ? event.clientY : event.clientX;
    const startSize = bottom ? sidePanelHeight : sidePanelWidth;
    const limit = (bottom ? window.innerHeight : window.innerWidth) * MAX_FRACTION;
    const min = bottom ? MIN_HEIGHT : MIN_WIDTH;

    const onMove = (move: PointerEvent) => {
      // Both edges grow as the pointer moves *into* the tab, so the arithmetic
      // is the same for either: start minus current.
      const dragged = startSize + (startPos - (bottom ? move.clientY : move.clientX));
      const size = Math.round(Math.min(limit, Math.max(min, dragged)));
      void patchSettings(bottom ? { sidePanelHeight: size } : { sidePanelWidth: size });
    };

    const finish = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", finish);
      handle.removeEventListener("pointercancel", finish);
    };

    // Capture, so a fast drag that outruns the pointer keeps resizing rather
    // than dropping the moment the cursor leaves the handle.
    handle.setPointerCapture(event.pointerId);
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", finish);
    handle.addEventListener("pointercancel", finish);
  };

  return <div className="sidepanel__grip" onPointerDown={onPointerDown} />;
}

/** `14:32` — the wall clock, which is how an operator remembers a service. */
const clock = (at: number) =>
  new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

/**
 * Everything that has been on screen this session, newest first.
 *
 * Someone asks for the last chorus again, or a reading is cut short and wanted
 * back. The filmstrip can only offer the deck that happens to be open; this
 * reaches across every song and passage of the whole service, and a press puts
 * one back up — bringing its deck back with it.
 */
function History() {
  const t = useStore((s) => s.t);
  const history = useStore((s) => s.history);
  const deck = useStore((s) => s.deck);
  const liveIndex = useStore((s) => s.liveIndex);
  const blanked = useStore((s) => s.blanked);
  const replayHistory = useStore((s) => s.replayHistory);
  const clearHistory = useStore((s) => s.clearHistory);

  // The one entry that is on screen, found once rather than tested per row.
  //
  // A slide sung three times is three entries with the same deck and index, so
  // matching on those alone lit up every one of them. The list is newest
  // first, so the first match is the showing that is actually live.
  const liveId =
    blanked || liveIndex === null || !deck
      ? null
      : (history.find((entry) => entry.deck.key === deck.key && entry.index === liveIndex)?.id ??
        null);

  return (
    <>
      <div className="sidepanel__bar">
        <span className="field__hint">{t("history.hint")}</span>
        <div className="topbar__spacer" />
        {history.length > 0 && (
          <button
            className="btn btn--icon btn--sm"
            title={t("history.clear")}
            onClick={clearHistory}
          >
            <Icon name="trash" size={12} />
          </button>
        )}
      </div>

      {history.length === 0 ? (
        <div className="sidepanel__empty">
          <span className="field__hint">{t("history.empty")}</span>
        </div>
      ) : (
        <div className="sidepanel__history">
          {history.map((entry) => {
            const slide = entry.deck.slides[entry.index];
            if (!slide) return null;
            // A clip has a path too, but an <img> cannot show one — so a moving
            // slide gets a play mark rather than a broken thumbnail.
            const kind = slide.liveKind ?? entry.deck.source;
            const thumb = kind === "image" || kind === "message" ? slide.mediaPath : null;
            return (
              <button
                key={entry.id}
                className="history__row"
                data-live={entry.id === liveId || undefined}
                title={`${entry.deck.title} · ${slide.label} — ${t("history.hint")}`}
                onClick={() => void replayHistory(entry.id)}
              >
                <span className="history__thumb">
                  {thumb ? (
                    <img src={mediaSrc(thumb)} alt="" />
                  ) : kind === "video" ? (
                    <Icon name="play" size={14} />
                  ) : (
                    <span className="history__glyph">{slide.label}</span>
                  )}
                </span>
                <span className="history__text">
                  <span className="history__title">{entry.deck.title}</span>
                  <span className="history__part">{slide.summary ?? slide.part}</span>
                </span>
                <span className="history__time">{clock(entry.at)}</span>
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}

/** What each kind of entry looks like at a glance. */
const PLAN_ICONS: Record<PlanEntry["kind"], IconName> = {
  song: "music",
  bible: "book",
  presentation: "image",
  video: "play",
  audio: "music",
  // A typed line is a line, not a container; the folder is the container.
  custom: "check",
  folder: "folder",
};

/**
 * The running order, and the controls for the plan holding it.
 *
 * Built before a service and worked down during one: a press puts an item on
 * screen, so the operator drives the service from here rather than hunting
 * through five tabs for the next thing. Items are references, so the song that
 * goes up is the song as it stands now — see `resolvePlanEntry`.
 */
function PlanList({ active }: { active: boolean }) {
  const t = useStore((s) => s.t);
  const plan = useStore((s) => s.plan);
  const plans = useStore((s) => s.plans);
  const openPlanEntry = useStore((s) => s.openPlanEntry);
  const movePlanEntry = useStore((s) => s.movePlanEntry);
  const movePlanEntries = useStore((s) => s.movePlanEntries);
  const liveEntry = useStore((s) => s.livePlanEntry);
  const removePlanEntries = useStore((s) => s.removePlanEntries);
  const setPlanNote = useStore((s) => s.setPlanNote);
  const setPlanMinutes = useStore((s) => s.setPlanMinutes);
  const addPlanFolder = useStore((s) => s.addPlanFolder);
  const addPlanItem = useStore((s) => s.addPlanItem);
  const setPlanDepth = useStore((s) => s.setPlanDepth);
  const togglePlanFolder = useStore((s) => s.togglePlanFolder);
  const renamePlanEntry = useStore((s) => s.renamePlanEntry);
  const updateTimer = useStore((s) => s.updateTimer);
  const timer = useStore((s) => s.timer);
  const setPlanStart = useStore((s) => s.setPlanStart);
  const startNewPlan = useStore((s) => s.startNewPlan);
  const renamePlan = useStore((s) => s.renamePlan);
  const openPlan = useStore((s) => s.openPlan);
  const deletePlan = useStore((s) => s.deletePlan);
  const openMenu = useContextMenu();
  const dialogs = useDialogs();
  const times = useMemo(() => planTimes(plan), [plan]);

  /**
   * Opens the item and loads its countdown, ready but not running.
   *
   * Only for an item somebody has put a length on. Deliberately not started:
   * a clock that begins the moment a song is put on screen is a clock that is
   * already wrong by the time anybody looks at it, and starting is one press
   * in the title bar. A timer already counting down is left alone — that one
   * is being watched.
   */
  const openAndLoadTimer = async (entry: PlanEntry) => {
    await openPlanEntry(entry.id);
    if (entry.minutes <= 0 || timer?.running) return;
    void updateTimer(newTimer("countdown", entry.minutes * 60));
  };

  /** Asks for a name and adds the line. Reached from the plan's menu, from a
   *  right-click on a line, and from a right-click on the empty space below
   *  them — whichever the operator tries first. */
  const askFor = (kind: "custom" | "folder") =>
    void dialogs
      .prompt({
        title: kind === "folder" ? t("plan.addFolder") : t("plan.addItem"),
        label: t("common.name"),
        placeholder:
          kind === "folder" ? t("plan.folderPlaceholder") : t("plan.itemPlaceholder"),
      })
      .then((name) => {
        if (!name) return;
        if (kind === "folder") addPlanFolder(name);
        else addPlanItem(name);
      });

  /** Both, wherever there is room for both. */
  const addLineItems = (): MenuEntry[] => [
    { label: t("plan.addFolder"), icon: "folder", onSelect: () => askFor("folder") },
    { label: t("plan.addItem"), icon: "plus", onSelect: () => askFor("custom") },
  ];

  // Pointer-driven, like every other reorder in the app: WebKit will not start
  // an HTML5 drag without `setData`, and Tauri's file-drop sits in front of
  // those events anyway. A press has to travel a few pixels to count as a drag,
  // so a plain click still opens the entry.
  const listRef = useRef<HTMLDivElement>(null);

  /**
   * The lines actually drawn: everything, less whatever is folded away.
   *
   * The reorder hook counts the rows on screen, and `movePlanEntry` counts the
   * plan — the same numbers only while nothing is hidden. Every index that
   * crosses between them goes through here.
   */
  const visible = useMemo(() => {
    const rows: PlanEntry[] = [];
    // Everything deeper than this is inside something folded away. Folders
    // nest, so the shallowest fold wins until a line comes back out to its
    // level.
    let hiddenBelow: number | null = null;
    for (const entry of plan.entries) {
      if (hiddenBelow !== null && entry.depth > hiddenBelow) continue;
      hiddenBelow = null;
      rows.push(entry);
      if (entry.kind === "folder" && entry.collapsed) hiddenBelow = entry.depth;
    }
    return rows;
  }, [plan.entries]);

  /** Whether a typed line has anything tucked under it — which is the only
   *  thing that makes it a folder rather than a line of its own. */
  const realIndex = (row: number) => {
    const id = visible[row]?.id;
    return id ? plan.entries.findIndex((entry) => entry.id === id) : -1;
  };

  /**
   * The line being carried, by id.
   *
   * The reorder hook counts rows on screen and assumes each move shifts one of
   * them. A folder moves as a block — several rows at once, and more still
   * hidden inside a folded one — so its idea of where the dragged row now is
   * drifts, and the next move lands somewhere nobody pointed at. Holding the
   * id means the source is looked up rather than remembered, and only the
   * destination comes from the cursor.
   */
  const carried = useRef<string | null>(null);

  /**
   * Several lines at once — ⌘-click to add one, Shift-click for a run.
   *
   * The same helper the song list and the slide grid use, so the conventions
   * are the ones every file manager has. Indexed against the rows on screen,
   * which is what a Shift-range has to follow, and cleared whenever the plan
   * changes under it.
   */
  const picked = useTileSelection(visible.length, `${plan.id}:${visible.length}`);

  /**
   * Dragging a box over the lines picks them out, and ⌘A takes the lot.
   *
   * The marquee only starts on the empty space below the lines — a press on a
   * line is that line's business, which is what starts a reorder.
   */
  const marquee = useMarquee({
    containerRef: listRef,
    count: visible.length,
    onSelect: (indices, additive) => {
      // Dragging a box that has not reached anything yet — or that ends up
      // catching nothing — leaves what was already picked alone. Wiping the
      // selection the instant a drag starts loses it before the operator has
      // decided whether they meant to replace it.
      if (indices.length === 0 && !additive) return;
      picked.setMany(indices, additive);
    },
    onClear: () => picked.clear(),
  });

  /** Whether the plan is the pane in hand, so Delete belongs to it rather
   *  than to the songs or sections behind it. */
  const inHand = useRef(false);

  useEffect(() => {
    const claim = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      inHand.current = !!target && !!listRef.current?.contains(target);
    };
    window.addEventListener("pointerdown", claim, true);
    return () => window.removeEventListener("pointerdown", claim, true);
  }, []);

  /**
   * Dragging sideways changes the level: left to come out of a folder, right
   * to go into the one above.
   *
   * A step per 22px, counted from where the press began, so a drag that is
   * mostly vertical never nudges by accident and one that is deliberately
   * sideways moves a level at a time. Reading the plan from the store rather
   * than from this render keeps it right through a long drag.
   */
  const nudge = useRef<{ from: number; steps: number } | null>(null);

  const beginRowDrag = (event: ReactPointerEvent, index: number, id: string) => {
    carried.current = id;
    nudge.current = { from: event.clientX, steps: 0 };

    const onPointerMove = (move: PointerEvent) => {
      const state = nudge.current;
      if (!state) return;
      const steps = Math.trunc((move.clientX - state.from) / 22);
      if (steps === state.steps) return;
      const delta = steps - state.steps;
      state.steps = steps;

      const entries = useStore.getState().plan.entries;
      const at = entries.findIndex((entry) => entry.id === id);
      const line = entries[at];
      if (!line) return;
      // One deeper than the line above at most: a level with nothing above it
      // to belong to is not a level.
      const ceiling = at > 0 ? (entries[at - 1]?.depth ?? 0) + 1 : 0;
      const wanted = Math.max(0, Math.min(line.depth + delta, ceiling));
      if (wanted !== line.depth) setPlanDepth(id, wanted);
    };

    const finish = () => {
      nudge.current = null;
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    beginPress(event, index);
  };

  const removePicked = (fallback?: string) => {
    const chosen = picked.isMulti
      ? picked.ordered().map((row) => visible[row]?.id).filter((id): id is string => !!id)
      : [];
    const ids = chosen.length > 0 ? chosen : fallback ? [fallback] : [];
    if (ids.length === 0) return;
    removePlanEntries(ids);
    picked.clear();
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = !!target?.closest("input, textarea, [contenteditable='true']");

      if ((event.key === "Delete" || event.key === "Backspace") && !typing) {
        if (!inHand.current || picked.selected.size === 0) return;
        event.preventDefault();
        removePicked();
        return;
      }

      if (!(event.metaKey || event.ctrlKey) || event.code !== "KeyA") return;
      // The list is still mounted behind history, so it must not answer for
      // keys aimed at whatever is actually on screen.
      if (!active) return;
      // Inside a text field ⌘A belongs to the text.
      if (typing || visible.length === 0) return;
      event.preventDefault();
      picked.setMany(
        visible.map((_, index) => index),
        false,
      );
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, picked, removePlanEntries, active]);

  const { dragging, beginPress } = useGridReorder({
    containerRef: listRef,
    onMove: (_from, to) => {
      const target = realIndex(to);
      if (target < 0) return;

      // Dragging one of several picked lines carries all of them, in the
      // order they were in — which is the point of picking them.
      const chosen = picked.isMulti
        ? picked.ordered().map((row) => visible[row]?.id).filter((id): id is string => !!id)
        : [];
      if (carried.current && chosen.includes(carried.current)) {
        movePlanEntries(chosen, target);
        return;
      }

      const source = carried.current
        ? plan.entries.findIndex((entry) => entry.id === carried.current)
        : -1;
      if (source >= 0) movePlanEntry(source, target);
    },
    onClick: (index, event) => {
      // A modifier click is about building a selection, not about opening
      // anything — the same rule the song list follows.
      if (picked.handleClick(index, event)) return;
      picked.selectOnly(index);
      const entry = visible[index];
      if (entry) void openAndLoadTimer(entry);
    },
  });

  const openMenuEntries = (): MenuEntry[] => {
    if (plans.length === 0) {
      return [{ label: t("plan.noneSaved"), disabled: true, onSelect: () => {} }];
    }
    return plans.map((saved) => ({
      label: saved.name,
      checked: saved.id === plan.id,
      onSelect: () => openPlan(saved.id),
    }));
  };

  return (
    <>
      <div className="sidepanel__bar sidepanel__bar--plan">
        <button
          className="plan__name"
          title={t("plan.rename")}
          onClick={() =>
            void dialogs
              .prompt({
                title: t("plan.rename"),
                label: t("common.name"),
                value: plan.name,
                placeholder: t("plan.namePlaceholder"),
              })
              .then((name) => name && renamePlan(name))
          }
        >
          {plan.name.trim() || t("plan.untitled")}
        </button>

        {/* The start time, and where the plan is expected to end. Pressing it
            sets or clears the start; without one the items show their own
            lengths and there is nothing to press for. */}
        <button
          className="plan__clock"
          title={t("plan.startsAtHint")}
          onClick={() =>
            void dialogs
              .prompt({
                title: t("plan.startsAt"),
                label: t("plan.startsAtLabel"),
                value: plan.startsAt,
                placeholder: "10:00",
                allowEmpty: true,
              })
              .then((value) => {
                if (value === null) return;
                // Anything unreadable clears it rather than being kept as a
                // time nobody can act on.
                setPlanStart(parseClock(value) === null ? "" : value.trim());
              })
          }
        >
          <Icon name="clock" size={11} />
          {/* The finish is only worth the width once something has a length —
              "10:00–10:00" is two numbers saying one thing. With no start at
              all the total stands in, and an empty plan gets the invitation. */}
          {plan.startsAt
            ? times.minutes > 0
              ? `${plan.startsAt}–${times.ends}`
              : plan.startsAt
            : times.minutes > 0
              ? t("plan.minutesShort", { n: times.minutes })
              : t("plan.startsAt")}
        </button>


        <button
          className="btn btn--icon btn--sm"
          title={t("plan.open")}
          onClick={(event) => openMenu(event, openMenuEntries())}
        >
          <Icon name="folder" size={12} />
        </button>
        <button
          className="btn btn--icon btn--sm"
          title={t("plan.new")}
          onClick={(event) =>
            openMenu(event, [
              ...addLineItems(),
              "separator",
              { label: t("plan.new"), icon: "plus", onSelect: () => startNewPlan("") },
              ...(plan.id && plans.some((saved) => saved.id === plan.id)
                ? ([
                    "separator",
                    {
                      label: t("plan.delete"),
                      icon: "trash",
                      danger: true,
                      onSelect: () =>
                        void dialogs
                          .confirm({
                            title: t("plan.delete"),
                            message: t("plan.deleteConfirm", { name: plan.name }),
                            confirmLabel: t("common.delete"),
                            danger: true,
                          })
                          .then((ok) => ok && void deletePlan(plan.id)),
                    },
                  ] as const)
                : []),
            ])
          }
        >
          <Icon name="grip" size={12} />
        </button>
      </div>

      {plan.entries.length === 0 ? (
        <div
          className="sidepanel__empty"
          onContextMenu={(event) =>
            openMenu(event, addLineItems())
          }
        >
          <span className="field__hint">{t("plan.empty")}</span>
        </div>
      ) : (
        // The lines stop the event themselves, so this only fires on the
        // space below them.
        <div
          className="sidepanel__history"
          ref={listRef}
          style={{ position: "relative" }}
          onPointerDown={marquee.onPointerDown}
          onContextMenu={(event) =>
            openMenu(event, addLineItems())
          }
        >
          {visible.map((entry, index) => (
            <div
              key={entry.id}
              className="plan__row"
              data-depth={entry.depth > 0 ? "" : undefined}
              style={entry.depth > 0 ? { paddingLeft: 6 + entry.depth * 14 } : undefined}
              data-folder={entry.kind === "folder" ? "" : undefined}
              data-dragging={dragging === index || undefined}
              title={`${entry.label} — ${t("plan.showHint")}`}
              // Picked out, and on the screens: two different things, and a
              // row can be either, both or neither.
              aria-selected={picked.selected.has(index) || undefined}
              data-marked={(picked.isMulti && picked.selected.has(index)) || undefined}
              data-live={liveEntry === entry.id || undefined}
              onPointerDown={(event) => beginRowDrag(event, index, entry.id)}
              // One click opens it where it lives; two put it on the screens.
              // Showing the room is not something to do by brushing past a
              // line in a list.
              onDoubleClick={() => void openPlanEntry(entry.id, true)}
              onContextMenu={(event) =>
                openMenu(event, [
                  {
                    label: t("menu.show"),
                    icon: "eye",
                    onSelect: () => void openPlanEntry(entry.id, true),
                  },
                  {
                    label: t("plan.open"),
                    icon: "folder",
                    onSelect: () => void openPlanEntry(entry.id),
                  },
                  ...(entry.minutes > 0
                    ? ([
                        {
                          // The menu still starts it outright: asking for it
                          // by name is asking for it to run.
                          label: t("plan.startTimerFor", { n: entry.minutes }),
                          icon: "clock" as const,
                          onSelect: () =>
                            void updateTimer(
                              startTimer(newTimer("countdown", entry.minutes * 60)),
                            ),
                        },
                      ] as const)
                    : []),
                  {
                    label: t("plan.minutes"),
                    icon: "clock",
                    onSelect: () =>
                      void dialogs
                        .prompt({
                          title: t("plan.minutes"),
                          label: t("plan.minutesLabel"),
                          value: entry.minutes ? String(entry.minutes) : "",
                          placeholder: "5",
                          allowEmpty: true,
                        })
                        .then((value) => {
                          if (value === null) return;
                          // Anything that is not a number clears the time,
                          // which is how somebody takes one off again.
                          const minutes = Number.parseInt(value.trim(), 10);
                          setPlanMinutes(entry.id, Number.isFinite(minutes) ? minutes : 0);
                        }),
                  },
                  {
                    label: t("plan.note"),
                    icon: "pencil",
                    onSelect: () =>
                      void dialogs
                        .prompt({
                          title: t("plan.note"),
                          label: t("plan.note"),
                          value: entry.note,
                          placeholder: t("plan.notePlaceholder"),
                          allowEmpty: true,
                        })
                        .then((note) => note !== null && setPlanNote(entry.id, note)),
                  },
                  ...(entry.kind === "folder"
                    ? ([
                        {
                          label: entry.collapsed ? t("plan.unfold") : t("plan.fold"),
                          icon: entry.collapsed ? "chevronRight" : "chevronDown",
                          onSelect: () => togglePlanFolder(entry.id),
                        },
                      ] as const)
                    : []),
                  ...(entry.kind === "custom" || entry.kind === "folder"
                    ? ([
                        {
                          label: t("plan.renameItem"),
                          icon: "pencil",
                          onSelect: () =>
                            void dialogs
                              .prompt({
                                title: t("plan.renameItem"),
                                label: t("common.name"),
                                value: entry.label,
                                placeholder: t("plan.itemPlaceholder"),
                              })
                              .then((name) => name && renamePlanEntry(entry.id, name)),
                        },
                        "separator",
                      ] as const)
                    : []),
                  ...addLineItems(),
                  "separator",
                  {
                    // Only under a line that is itself at the top level:
                    // one level of nesting, so a folder cannot go inside a
                    // folder.
                    label: t("plan.indent"),
                    icon: "chevronRight",
                    disabled:
                      index === 0 || entry.depth > (visible[index - 1]?.depth ?? 0),
                    onSelect: () => setPlanDepth(entry.id, entry.depth + 1),
                  },
                  {
                    label: t("plan.outdent"),
                    icon: "chevronLeft",
                    disabled: entry.depth === 0,
                    onSelect: () => setPlanDepth(entry.id, entry.depth - 1),
                  },
                  "separator",
                  {
                    label: t("plan.moveUp"),
                    icon: "arrowUp",
                    disabled: index === 0,
                    onSelect: () => movePlanEntry(realIndex(index), realIndex(index) - 1),
                  },
                  {
                    label: t("plan.moveDown"),
                    icon: "arrowDown",
                    disabled: index === visible.length - 1,
                    onSelect: () => movePlanEntry(realIndex(index), realIndex(index) + 1),
                  },
                  "separator",
                  {
                    label:
                      picked.isMulti && picked.selected.has(index)
                        ? t("plan.removeSelected", { n: picked.selected.size })
                        : t("plan.remove"),
                    icon: "trash",
                    danger: true,
                    onSelect: () => removePicked(entry.id),
                  },
                ])
              }
            >
              <span className="plan__index">{index + 1}</span>
              <span
                className="plan__glyph"
                // A folder folds from its own icon; everything else keeps a
                // plain glyph that does nothing on its own.
                role={entry.kind === "folder" ? "button" : undefined}
                data-folds={entry.kind === "folder" ? "" : undefined}
                onPointerDown={
                  entry.kind === "folder"
                    ? (event) => {
                        // Kept from the drag: a press on the chevron is a
                        // fold, not the start of a reorder.
                        event.stopPropagation();
                      }
                    : undefined
                }
                onClick={
                  entry.kind === "folder"
                    ? (event) => {
                        event.stopPropagation();
                        togglePlanFolder(entry.id);
                      }
                    : undefined
                }
              >
                <Icon
                  name={
                    // A folder shows which way it is folded; everything else
                    // shows what it is.
                    entry.kind === "folder"
                      ? entry.collapsed
                        ? "chevronRight"
                        : "chevronDown"
                      : PLAN_ICONS[entry.kind]
                  }
                  size={13}
                />
              </span>
              <span className="history__text">
                <span className="history__title">{entry.label}</span>
                {entry.note && <span className="history__part">{entry.note}</span>}
              </span>
              {/* Last in the row, so a column of times lines up down the edge
                  and the title keeps the width it had. The clock time once the
                  plan has a start, the item's own length otherwise, and
                  nothing at all until somebody has said how long it takes. */}
              {(times.at.get(entry.id) || (times.runs.get(entry.id) ?? 0) > 0) && (
                <span className="plan__time">
                  {times.at.get(entry.id) ||
                    t("plan.minutesShort", { n: times.runs.get(entry.id) ?? entry.minutes })}
                </span>
              )}
            </div>
          ))}
          {/* Last, not first: the reorder hook and the marquee both count the
              container's children, so a box drawn ahead of the rows makes
              every row one out — which selected whatever was first the moment
              a drag began. */}
          {marquee.rect && <div className="marquee" style={marquee.rect} />}
        </div>
      )}
    </>
  );
}
