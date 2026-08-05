import { useCallback, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { api } from "../api";
import type { Backdrop, Background, BackgroundFit } from "../api/types";
import { useStore } from "../app/store";
import { refreshBackgrounds, useBackgrounds } from "../lib/backgrounds";
import { useFileDrop, useImageExtensions, within } from "../lib/fileDrop";
import { useGridReorder } from "../lib/dragReorder";
import { Icon } from "./ui/Icon";
import { Field, Segmented, Slider } from "./ui/controls";
import { useContextMenu, type MenuEntry } from "./ui/ContextMenu";
import { useDialogs } from "./ui/Dialogs";

const VIDEO_EXTENSIONS = ["mp4", "m4v", "mov", "webm", "mkv"];

/** Grid entries are either a colour or a file name; a `#` tells them apart. */
const isColorEntry = (entry: string) => entry.startsWith("#");

/**
 * Picks a still or a looping video to sit behind the text.
 *
 * Files are copied into the app's own `Backgrounds/` folder on import, so a
 * background keeps working after the original is moved — and so the webview
 * only ever needs read access to that one directory.
 *
 * Used once per background state: the active one and the idle one a screen
 * falls back to when the output is blanked.
 */
export function BackgroundPicker({
  backdrop,
  color,
  onChange,
  onColor,
}: {
  backdrop: Backdrop;
  /** The flat colour this backdrop falls back to when no media is chosen. */
  color: string;
  onChange: (patch: Partial<Backdrop>) => void;
  onColor: (color: string) => void;
}) {
  const t = useStore((s) => s.t);
  const reportError = useStore((s) => s.reportError);
  const toast = useStore((s) => s.toast);
  const items = useBackgrounds();
  const dialogs = useDialogs();
  const imageExtensions = useImageExtensions();
  const [busy, setBusy] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);
  /**
   * The droppable region: the whole field, not just the tiles.
   *
   * Kept apart from `gridRef`, which the reorder drag measures tiles against
   * and so has to stay the grid itself. The two disagreed before — "Drop
   * photos or videos here" is printed under the grid, outside the only area
   * that would accept a drop, so a drop aimed at the words it tells you to aim
   * at was silently ignored.
   */
  const dropRef = useRef<HTMLDivElement>(null);
  const openMenu = useContextMenu();
  const order = useStore((s) => s.settings.backgroundOrder);
  const patchSettings = useStore((s) => s.patchSettings);

  /** True when this slot is showing that flat colour right now. */
  const isCurrent = (value: string) =>
    !backdrop.media && value.toLowerCase() === color.trim().toLowerCase();

  /**
   * The grid, in one order: colours and files interleaved however the operator
   * arranged them.
   *
   * The saved order is the authority, but it cannot be the only source — a
   * file imported a moment ago is not in it yet, and a file deleted outside
   * the app still is. So the order is filtered against the library and
   * anything new is appended.
   */
  const entries = useMemo(() => {
    const known = new Set(items.map((item) => item.filename));
    const kept = order.filter((entry) => isColorEntry(entry) || known.has(entry));
    const placed = new Set(kept);
    return [
      ...kept,
      ...items.filter((item) => !placed.has(item.filename)).map((item) => item.filename),
    ];
  }, [order, items]);

  // A colour set before it was in the grid — or taken out of it since — still
  // has to be visible, or nothing would look selected while a colour is
  // plainly on screen.
  const unlisted =
    !backdrop.media && !entries.some((entry) => entry.toLowerCase() === color.trim().toLowerCase())
      ? color.trim()
      : null;
  const shown = unlisted ? [unlisted, ...entries] : entries;
  const accepted = [...imageExtensions, ...VIDEO_EXTENSIONS];

  const saveOrder = (next: string[]) => void patchSettings({ backgroundOrder: next });

  const move = (from: number, to: number) => {
    // The pinned entry is not in the saved order, so it is not draggable and
    // the indices have to be read past it.
    const offset = unlisted ? 1 : 0;
    const list = [...entries];
    const source = from - offset;
    const target = to - offset;
    if (source < 0 || target < 0 || source >= list.length || target >= list.length) return;
    const [moved] = list.splice(source, 1);
    if (moved === undefined) return;
    list.splice(target, 0, moved);
    saveOrder(list);
  };

  /** Copies files in and points this slot at the last of them. */
  const importFiles = useCallback(
    async (paths: string[]) => {
      setBusy(true);
      try {
        let last: string | null = null;
        for (const path of paths) {
          last = (await api.importBackground(path)).filename;
        }
        await refreshBackgrounds();
        if (last) {
          onChange({ media: last });
          toast(t("style.mediaAdded", { name: last }), "success");
        }
      } catch (error) {
        reportError(error);
      } finally {
        setBusy(false);
      }
    },
    [onChange, reportError, t, toast],
  );

  const add = async () => {
    const picked = await open({
      multiple: true,
      filters: [
        { name: t("style.mediaFilter"), extensions: accepted },
        { name: "All files", extensions: ["*"] },
      ],
    });
    const paths = typeof picked === "string" ? [picked] : Array.isArray(picked) ? picked : [];
    if (paths.length > 0) await importFiles(paths);
  };

  // Both background slots are on screen at once, and a drop event arrives for
  // the whole window — so each picker takes only the files dropped onto its
  // own grid, and the one you dropped on is the one that changes.
  const onDrop = useCallback(
    (paths: string[], position: { x: number; y: number }) => {
      if (within(dropRef, position)) void importFiles(paths);
    },
    [importFiles],
  );
  const onReject = useCallback(
    (paths: string[], position: { x: number; y: number }) => {
      // Both pickers hear every drop; only the one dropped on should complain.
      if (!within(dropRef, position)) return;
      toast(
        t("style.mediaUnsupported", {
          files: paths.map((path) => path.split(/[\\/]/).pop() ?? path).join(", "),
        }),
        "error",
      );
    },
    [t, toast],
  );

  const dragging = useFileDrop({
    extensions: accepted,
    onDrop,
    onReject,
    enabled: !busy,
  });
  const over = !!dragging && within(dropRef, dragging);

  // A press has to travel a few pixels before it counts as a drag, so a plain
  // click still selects. The "+" tile is past the end and is not a drop target.
  const { dragging: reordering, beginPress } = useGridReorder({
    containerRef: gridRef,
    count: shown.length,
    onMove: move,
  });

  /** Chooses a colour and selects it, adding it to the shared palette. */
  const addColor = () => {
    void dialogs
      .color({
        title: t("style.colorPick"),
        label: t("style.color"),
        value: color,
      })
      .then((picked) => {
        if (!picked) return;
        const value = picked.toLowerCase();
        if (!entries.some((entry) => entry.toLowerCase() === value)) {
          saveOrder([...entries, picked]);
        }
        useColor(picked);
      });
  };

  /** Replaces one palette entry, and follows it if this slot was using it. */
  const editColor = (current: string) => {
    void dialogs
      .color({
        title: t("style.colorChange"),
        label: t("style.color"),
        value: current,
      })
      .then((picked) => {
        if (!picked || picked === current) return;
        saveOrder(entries.map((entry) => (entry === current ? picked : entry)));
        if (isCurrent(current)) useColor(picked);
      });
  };

  const removeColor = (value: string) => {
    const remaining = entries.filter((entry) => entry !== value);
    saveOrder(remaining);
    // Same as deleting a picture that is in use: the slot cannot go on
    // pointing at something the grid no longer has, so it falls back.
    if (isCurrent(value)) {
      onColor(remaining.find(isColorEntry) ?? "#000000");
    }
  };

  // Choosing a colour clears the picture too — otherwise it would be set but
  // invisible behind whichever image is still chosen.
  const useColor = (value: string) => {
    onColor(value);
    onChange({ media: null });
  };

  const remove = async (item: Background) => {
    try {
      await api.deleteBackground(item.filename);
      await refreshBackgrounds();
      saveOrder(entries.filter((entry) => entry !== item.filename));
      // A slot still pointing at it would silently render nothing.
      if (backdrop.media === item.filename) onChange({ media: null });
    } catch (error) {
      reportError(error);
    }
  };

  return (
    <>
      {/* The drop zone is the field entire — label, tiles and the line telling
          you to drop here — so the highlight surrounds exactly what will
          accept a file. */}
      <div
        ref={dropRef}
        style={{
          // Lights up only while something droppable is over this picker.
          outline: over ? "1px dashed var(--accent)" : undefined,
          outlineOffset: 3,
          borderRadius: 6,
        }}
      >
        <Field label={t("style.media")} hint={t("style.mediaDropHint")}>
          <div
            ref={gridRef}
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))",
              gap: 8,
            }}
          >
            {shown.map((entry, index) => {
              // The pinned entry is not in the saved order, so there is nothing
              // to take out of it and nothing to drag.
              const pinned = entry === unlisted;
              const press = pinned
                ? undefined
                : (event: React.PointerEvent) => beginPress(event, index);

              if (isColorEntry(entry)) {
                return (
                  <Tile
                    key={entry}
                    color={entry}
                    selected={isCurrent(entry)}
                    dragging={reordering === index}
                    onPointerDown={press}
                    onClick={() => useColor(entry)}
                    onRemove={pinned ? undefined : () => removeColor(entry)}
                    label={entry}
                    menu={[
                      {
                        label: t("style.colorUse"),
                        icon: "check",
                        onSelect: () => useColor(entry),
                      },
                      {
                        label: t("style.colorChange"),
                        icon: "pencil",
                        onSelect: () => editColor(entry),
                      },
                      "separator",
                      pinned
                        ? {
                            label: t("style.colorSave"),
                            icon: "plus",
                            onSelect: () => saveOrder([...entries, entry]),
                          }
                        : {
                            label: t("style.colorRemove"),
                            icon: "trash",
                            danger: true,
                            onSelect: () => removeColor(entry),
                          },
                    ]}
                  />
                );
              }

              const item = items.find((candidate) => candidate.filename === entry);
              if (!item) return null;
              return (
                <Tile
                  key={item.filename}
                  item={item}
                  selected={backdrop.media === item.filename}
                  dragging={reordering === index}
                  onPointerDown={press}
                  onClick={() => onChange({ media: item.filename })}
                  onRemove={() => void remove(item)}
                  label={item.filename}
                  menu={[
                    {
                      label: t("style.mediaNone"),
                      icon: "x",
                      onSelect: () => onChange({ media: null }),
                    },
                    "separator",
                    {
                      label: t("menu.deleteFile"),
                      icon: "trash",
                      danger: true,
                      onSelect: () => void remove(item),
                    },
                  ]}
                />
              );
            })}

            {/* Last in the grid, as on the Slides tab. */}
            <button
              className="tile tile--add"
              style={{ aspectRatio: "16 / 9" }}
              disabled={busy}
              title={t("style.mediaAdd")}
              onClick={(event) =>
                openMenu(event, [
                  {
                    label: t("style.addFile"),
                    icon: "folder",
                    onSelect: () => void add(),
                  },
                  { label: t("style.addColor"), onSelect: addColor },
                ])
              }
            >
              <Icon name="plus" size={14} />
            </button>
          </div>
        </Field>
      </div>

      {backdrop.media && (
        <>
          <Field label={t("style.fit")}>
            <Segmented
              value={backdrop.fit}
              onChange={(fit: BackgroundFit) => onChange({ fit })}
              options={[
                { value: "cover", label: t("style.fitCover") },
                { value: "contain", label: t("style.fitContain") },
                { value: "fill", label: t("style.fitFill") },
              ]}
            />
          </Field>
          <Slider
            label={t("style.dim")}
            value={backdrop.dim}
            min={0}
            max={90}
            unit="%"
            onChange={(dim) => onChange({ dim })}
          />
          <div className="field__hint">{t("style.dimHint")}</div>
        </>
      )}
    </>
  );
}

function Tile({
  item,
  color,
  selected,
  dragging,
  label,
  onClick,
  onPointerDown,
  onRemove,
  menu,
}: {
  item?: Background;
  /** Renders a flat colour instead of a file. */
  color?: string;
  selected: boolean;
  /** Being carried to a new place in the grid. */
  dragging?: boolean;
  label: string;
  onClick: () => void;
  onPointerDown?: (event: React.PointerEvent) => void;
  onRemove?: () => void;
  menu?: MenuEntry[];
}) {
  const openMenu = useContextMenu();
  return (
    <div style={{ position: "relative" }}>
      <button
        onClick={onClick}
        onPointerDown={onPointerDown}
        onContextMenu={(event) => menu && openMenu(event, menu)}
        title={label}
        style={{
          all: "unset",
          display: "block",
          cursor: onPointerDown ? "grab" : "pointer",
          opacity: dragging ? 0.45 : 1,
          width: "100%",
          aspectRatio: "16 / 9",
          borderRadius: 6,
          overflow: "hidden",
          border: `1px solid ${selected ? "var(--accent)" : "var(--border-strong)"}`,
          boxShadow: selected ? "0 0 0 1px var(--accent-line)" : undefined,
          background: color ?? "var(--panel-sunken)",
          position: "relative",
        }}
      >
        {item ? (
          item.kind === "video" ? (
            // Muted, un-looped and never played: this is a poster frame, not
            // a second copy of the video running in the settings pane.
            <video
              src={convertFileSrc(item.path)}
              muted
              playsInline
              preload="metadata"
              style={{ width: "100%", height: "100%", objectFit: "cover" }}
            />
          ) : (
            <img
              src={convertFileSrc(item.path)}
              alt=""
              draggable={false}
              style={{ width: "100%", height: "100%", objectFit: "cover" }}
            />
          )
        ) : (
          <span
            style={{
              position: "absolute",
              inset: 0,
              display: "grid",
              placeItems: "center",
              fontSize: 11,
              // A dark colour would otherwise be an unreadable black tile, so
              // the value is written on it with a shadow that works on any
              // background, light or dark.
              color: color ? "#fff" : "var(--text-faint)",
              textShadow: color ? "0 1px 3px rgba(0,0,0,0.85)" : undefined,
              fontVariantNumeric: "tabular-nums",
              textTransform: color ? "uppercase" : undefined,
            }}
          >
            {label}
          </span>
        )}
        {item?.kind === "video" && (
          <span
            style={{
              position: "absolute",
              left: 4,
              bottom: 4,
              padding: "1px 5px",
              borderRadius: 3,
              fontSize: 9,
              fontWeight: 700,
              letterSpacing: "0.05em",
              background: "rgba(0,0,0,0.65)",
              color: "#fff",
            }}
          >
            VIDEO
          </span>
        )}
      </button>
      {onRemove && (
        <button
          className="btn btn--icon btn--sm btn--danger"
          onClick={onRemove}
          title={label}
          style={{
            position: "absolute",
            top: 3,
            right: 3,
            padding: 2,
            minWidth: 0,
          }}
        >
          <Icon name="x" size={10} />
        </button>
      )}
    </div>
  );
}
