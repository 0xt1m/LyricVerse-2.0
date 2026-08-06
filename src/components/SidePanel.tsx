import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useStore } from "../app/store";
import { mediaSrc } from "../api/net";
import type { PlanEntry } from "../api/types";
import { ScreenPreview } from "./Preview";
import { Icon, type IconName } from "./ui/Icon";
import { useContextMenu, type MenuEntry } from "./ui/ContextMenu";
import { useDialogs } from "./ui/Dialogs";
import { useGridReorder } from "../lib/dragReorder";

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
        {view === "plan" ? <PlanList /> : <History />}
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
};

/**
 * The running order, and the controls for the plan holding it.
 *
 * Built before a service and worked down during one: a press puts an item on
 * screen, so the operator drives the service from here rather than hunting
 * through five tabs for the next thing. Items are references, so the song that
 * goes up is the song as it stands now — see `resolvePlanEntry`.
 */
function PlanList() {
  const t = useStore((s) => s.t);
  const plan = useStore((s) => s.plan);
  const plans = useStore((s) => s.plans);
  const openPlanEntry = useStore((s) => s.openPlanEntry);
  const removeFromPlan = useStore((s) => s.removeFromPlan);
  const movePlanEntry = useStore((s) => s.movePlanEntry);
  const setPlanNote = useStore((s) => s.setPlanNote);
  const startNewPlan = useStore((s) => s.startNewPlan);
  const renamePlan = useStore((s) => s.renamePlan);
  const openPlan = useStore((s) => s.openPlan);
  const deletePlan = useStore((s) => s.deletePlan);
  const openMenu = useContextMenu();
  const dialogs = useDialogs();

  // Pointer-driven, like every other reorder in the app: WebKit will not start
  // an HTML5 drag without `setData`, and Tauri's file-drop sits in front of
  // those events anyway. A press has to travel a few pixels to count as a drag,
  // so a plain click still opens the entry.
  const listRef = useRef<HTMLDivElement>(null);
  const { dragging, beginPress } = useGridReorder({
    containerRef: listRef,
    onMove: movePlanEntry,
    onClick: (index) => {
      const entry = plan.entries[index];
      if (entry) void openPlanEntry(entry.id);
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
      <div className="sidepanel__bar">
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

        <div className="topbar__spacer" />

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
        <div className="sidepanel__empty">
          <span className="field__hint">{t("plan.empty")}</span>
        </div>
      ) : (
        <div className="sidepanel__history" ref={listRef}>
          {plan.entries.map((entry, index) => (
            <div
              key={entry.id}
              className="plan__row"
              data-dragging={dragging === index || undefined}
              title={`${entry.label} — ${t("plan.showHint")}`}
              onPointerDown={(event) => beginPress(event, index)}
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
                        })
                        .then((note) => note !== null && setPlanNote(entry.id, note)),
                  },
                  "separator",
                  {
                    label: t("plan.moveUp"),
                    icon: "arrowUp",
                    disabled: index === 0,
                    onSelect: () => movePlanEntry(index, index - 1),
                  },
                  {
                    label: t("plan.moveDown"),
                    icon: "arrowDown",
                    disabled: index === plan.entries.length - 1,
                    onSelect: () => movePlanEntry(index, index + 1),
                  },
                  "separator",
                  {
                    label: t("plan.remove"),
                    icon: "trash",
                    danger: true,
                    onSelect: () => removeFromPlan(entry.id),
                  },
                ])
              }
            >
              <span className="plan__index">{index + 1}</span>
              <span className="plan__glyph">
                <Icon name={PLAN_ICONS[entry.kind]} size={13} />
              </span>
              <span className="history__text">
                <span className="history__title">{entry.label}</span>
                {entry.note && <span className="history__part">{entry.note}</span>}
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
