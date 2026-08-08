import { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { api, errorMessage } from "../api";
import type { Presentation } from "../api/types";
import { useStore } from "../app/store";
import { presentationDeck } from "../lib/deck";
import { importPdf } from "../lib/pdf";
import { useFileDrop, useImageExtensions, within } from "../lib/fileDrop";
import { useTileSelection } from "../lib/selection";
import { useGridReorder } from "../lib/dragReorder";
import { useMarquee } from "../lib/marquee";
import { Icon } from "./ui/Icon";
import { Empty } from "./ui/controls";
import type { TileSelection } from "../lib/selection";
import { useContextMenu } from "./ui/ContextMenu";
import { useDialogs } from "./ui/Dialogs";

/** Just the file name, for messages that would otherwise be a full path. */
const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;


/**
 * Presentations are decks of images.
 *
 * PDFs are rasterised page by page here and stored as PNGs, so a deck that
 * imported cleanly once can never render differently later. PowerPoint and
 * Keynote are exported to PDF by the app that made them — trying to re-render
 * their XML in a webview looks compatible right up to the point where it
 * silently mangles a slide during a service.
 */
export function PresentationsTab() {
  const t = useStore((s) => s.t);
  const libraryRevision = useStore((s) => s.libraryRevision);
  const deck = useStore((s) => s.deck);
  const cursor = useStore((s) => s.cursor);
  const liveIndex = useStore((s) => s.liveIndex);
  const loadDeck = useStore((s) => s.loadDeck);
  const go = useStore((s) => s.go);
  const select = useStore((s) => s.select);
  const reportError = useStore((s) => s.reportError);
  const toast = useStore((s) => s.toast);
  const openMenu = useContextMenu();
  const addToPlan = useStore((s) => s.addToPlan);
  const dialogs = useDialogs();
  const imageExtensions = useImageExtensions();

  const [decks, setDecks] = useState<Presentation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const openRequest = useStore((s) => s.openRequest);
  const clearOpenRequest = useStore((s) => s.clearOpenRequest);

  // Opened from the plan.
  useEffect(() => {
    if (openRequest?.kind !== "presentation") return;
    setActiveId(openRequest.ref.presentationId);
    clearOpenRequest();
  }, [openRequest, clearOpenRequest]);
  const [busy, setBusy] = useState<string | null>(null);

  const active = decks.find((item) => item.id === activeId) ?? null;

  const reload = useCallback(async () => {
    try {
      const list = await api.listPresentations();
      setDecks(list);
      setActiveId((current) =>
        current && list.some((item) => item.id === current) ? current : (list[0]?.id ?? null),
      );
    } catch (error) {
      reportError(error);
    }
  }, [reportError]);

  useEffect(() => {
    void reload();
  }, [reload, libraryRevision]);

  // Loading a deck arms the transport; nothing goes live until asked.
  useEffect(() => {
    if (!active) return;
    void loadDeck(presentationDeck(active)).then(() => {
      const target = pendingSelect.current;
      pendingSelect.current = null;
      if (target !== null && target >= 0) select(target);
    });
  }, [active, loadDeck, select]);

  const create = async () => {
    const name = await dialogs.prompt({
      title: t("presentation.newName"),
      label: t("common.name"),
      value: t("presentation.untitled"),
      confirmLabel: t("common.create"),
    });
    if (!name) return;
    try {
      const created = await api.createPresentation(name);
      await reload();
      setActiveId(created.id);
    } catch (error) {
      reportError(error);
    }
  };

  /**
   * Imports a PDF as a presentation in one step, named after the file — the
   * common case, rather than making the operator create an empty deck first.
   */
  const importPdfAsDeck = async () => {
    const picked = await open({
      multiple: false,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (typeof picked !== "string") return;
    // A fresh deck named after the file, rather than appending to whatever
    // happens to be selected.
    await importInto(null, [picked]);
  };

  /**
   * Adds files to a deck, creating one first when there is nowhere to put
   * them — so dropping a PDF onto an empty library just works.
   */
  const importInto = useCallback(
    async (deckId: string | null, paths: string[]) => {
      if (paths.length === 0) return;
      setBusy(t("presentation.importing"));
      try {
        let target = deckId;
        if (!target) {
          const first = paths[0]!;
          const stem = first.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "");
          target = (await api.createPresentation(stem || t("presentation.untitled"))).id;
        }
        // One bad file must not abandon the rest of the batch; failures are
        // collected and reported together at the end.
        const failed: string[] = [];
        for (const path of paths) {
          try {
            if (path.toLowerCase().endsWith(".pdf")) {
              await importPdf(target, path, (page, total) =>
                setBusy(t("presentation.importingPage", { page, total })),
              );
            } else {
              await api.addPresentationImage(target, path);
            }
          } catch (error) {
            failed.push(`${fileName(path)} — ${errorMessage(error)}`);
          }
        }
        await reload();
        setActiveId(target);

        if (failed.length > 0) {
          toast(t("presentation.importFailed", { files: failed.join("; ") }), "error");
        } else {
          toast(t("presentation.imported"), "success");
        }
      } catch (error) {
        reportError(error);
      } finally {
        setBusy(null);
      }
    },
    [reload, reportError, t, toast],
  );

  const addFiles = async () => {
    const picked = await open({
      multiple: true,
      filters: [
        { name: t("presentation.filter"), extensions: ["pdf", ...imageExtensions] },
        { name: "All files", extensions: ["*"] },
      ],
    });
    const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
    await importInto(active?.id ?? null, paths);
  };

  /**
   * Where a drop lands decides what it does: onto the list of presentations
   * it starts a new one, onto the slides of the open deck it adds to that.
   * Dropping a service's worth of PDFs one after another should not silently
   * merge them all into whichever deck happened to be selected.
   */
  const listRef = useRef<HTMLElement>(null);
  const slidesRef = useRef<HTMLElement>(null);

  const dropTarget = useCallback(
    (paths: string[], position: { x: number; y: number }) => {
      // The list makes a new presentation; the slides area adds to the open
      // one. A PDF dropped on the slides becomes pages of *this* deck.
      //
      // Both are checked explicitly. Treating "not the list" as the slides
      // area meant a file dropped on the rail, the title bar or the preview
      // silently went into whichever deck happened to be open.
      if (within(listRef, position)) {
        void importInto(null, paths);
      } else if (within(slidesRef, position)) {
        void importInto(active?.id ?? null, paths);
      }
    },
    [importInto, active],
  );
  const rejectDrop = useCallback(
    (paths: string[], position: { x: number; y: number }) => {
      // Only complain about a file aimed at one of the zones; a drop on the
      // window at large was not meant for this tab.
      if (!within(listRef, position) && !within(slidesRef, position)) return;
      toast(
        t("presentation.unsupported", {
          files: paths.map(fileName).join(", "),
          formats: ["pdf", ...imageExtensions].join(", "),
        }),
        "error",
      );
    },
    [toast, t, imageExtensions],
  );

  const dragging = useFileDrop({
    extensions: ["pdf", ...imageExtensions],
    onDrop: dropTarget,
    onReject: rejectDrop,
    enabled: !busy,
  });

  // Which of the two zones the pointer is over right now.
  const zone = !dragging
    ? null
    : within(listRef, dragging)
      ? "list"
      : within(slidesRef, dragging)
        ? "slides"
        : null;

  const move = async (from: number, to: number) => {
    if (!active) return;
    const order = active.slides.map((slide) => slide.file);
    if (to < 0 || to >= order.length || from === to) return;
    const [moved] = order.splice(from, 1);
    if (moved === undefined) return;
    order.splice(to, 0, moved);
    // Optimistic: the drag must not stutter waiting for the disk.
    setDecks((current) =>
      current.map((item) =>
        item.id === active.id
          ? { ...item, slides: order.map((f) => item.slides.find((s) => s.file === f)!) }
          : item,
      ),
    );
    try {
      await api.reorderPresentation(active.id, order);
    } catch (error) {
      reportError(error);
      await reload();
    }
  };

  /** Index to re-select once the deck has been rebuilt after a change. */
  const pendingSelect = useRef<number | null>(null);

  // ⌘/Ctrl and Shift pick several slides, so a batch can go in one action.
  const selection = useTileSelection(active?.slides.length ?? 0, active?.id);

  /** A slide of words, for an announcement or a notice. */
  const addMessage = async () => {
    const text = await dialogs.prompt({
      title: t("presentation.addMessage"),
      label: t("presentation.messageText"),
      placeholder: t("presentation.messagePlaceholder"),
      confirmLabel: t("common.add"),
      multiline: true,
    });
    if (!text) return;
    try {
      // Adding one to nothing makes a deck to hold it.
      const target = active?.id ?? (await api.createPresentation(t("presentation.untitled"))).id;
      await api.addPresentationText(target, text);
      await reload();
      setActiveId(target);
    } catch (error) {
      reportError(error);
    }
  };

  const editMessage = async (file: string, current: string) => {
    if (!active) return;
    const text = await dialogs.prompt({
      title: t("presentation.editMessage"),
      label: t("presentation.messageText"),
      value: current,
      confirmLabel: t("common.save"),
      multiline: true,
    });
    if (text === null) return;
    try {
      await api.setPresentationText(active.id, file, text);
      await reload();
    } catch (error) {
      reportError(error);
    }
  };

  const removeSlides = useCallback(
    async (files: string[]) => {
      if (!active || files.length === 0) return;
      const first = active.slides.findIndex((slide) => slide.file === files[0]);
      try {
        let updated = active;
        for (const file of files) {
          updated = await api.removePresentationSlide(active.id, file);
        }
        // Land on the neighbour rather than jumping back to slide one, so
        // clearing several in a row stays where the operator is looking.
        pendingSelect.current = Math.min(Math.max(0, first), updated.slides.length - 1);
        selection.clear();
        await reload();
      } catch (error) {
        reportError(error);
      }
    },
    [active, reload, reportError, selection],
  );

  // Delete removes the highlighted slide — the same thing its context-menu
  // entry does, and what the key is expected to do once a tile is selected.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Delete" && event.key !== "Backspace") return;
      const target = event.target as HTMLElement | null;
      // Never steal the key from a field being typed in.
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (!active || deck?.source !== "image") return;

      // Delete acts on the whole selection when there is one.
      const indices = selection.selected.size > 0 ? selection.ordered() : [cursor];
      const files = indices
        .map((index) => active.slides[index]?.file)
        .filter((file): file is string => !!file);
      if (files.length === 0) return;
      event.preventDefault();

      void dialogs
        .confirm({
          title: t("common.delete"),
          message:
            files.length > 1
              ? t("presentation.slidesDeleteConfirm", { n: files.length })
              : t("presentation.slideDeleteConfirm", { n: indices[0]! + 1 }),
          confirmLabel: t("common.delete"),
          danger: true,
        })
        .then((ok) => {
          if (ok) void removeSlides(files);
        });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, deck, cursor, dialogs, removeSlides, selection, t]);

  return (
    <div className="workspace">
      <section className="panel" ref={listRef} style={{ flex: "0 0 260px", position: "relative" }}>
        {zone === "list" && (
          <DropZone icon="plus" title={t("presentation.dropNew")} hint={t("presentation.dropTypes")} />
        )}
        <div className="panel__head">
          <span className="panel__title">{t("tab.presentations")}</span>
          <div className="topbar__spacer" />
          <span className="field__hint">{decks.length || ""}</span>
        </div>
        {/* Their own row: a title and two labelled buttons will not fit across
            a panel this narrow. */}
        <div className="panel__actions">
          <button
            className="btn btn--sm btn--primary"
            onClick={() => void importPdfAsDeck()}
            disabled={!!busy}
            title={t("presentation.importPdfHint")}
          >
            {/* Just "+ PDF" here: it sits beside "Blank" in a narrow header,
                and the tooltip carries the explanation. The button in the
                empty state stays spelled out — there it is the only thing on
                screen and has to say what it does. */}
            <Icon name="plus" size={12} />
            {t("presentation.pdf")}
          </button>
          <button className="btn btn--sm" onClick={() => void create()} disabled={!!busy}>
            <Icon name="plus" size={12} />
            {t("presentation.blank")}
          </button>
        </div>
        {/* Right-clicking the list itself, rather than a deck in it. The row
            menus stop the event, so this only fires on empty space — where
            "make a new one" is the only thing anybody can mean. */}
        <div
          className="panel__body"
          onContextMenu={(event) =>
            openMenu(event, [
              { label: t("presentation.blank"), icon: "plus", onSelect: () => void create() },
              {
                label: t("presentation.importPdf"),
                icon: "folder",
                onSelect: () => void importPdfAsDeck(),
              },
              {
                label: t("presentation.addMessage"),
                icon: "pencil",
                onSelect: () => void addMessage(),
              },
            ])
          }
        >
          {decks.length === 0 ? (
            <Empty
              title={t("presentation.none")}
              hint={t("presentation.noneHint")}
              action={
                <button className="btn btn--primary" onClick={() => void importPdfAsDeck()}>
                  <Icon name="folder" size={13} />
                  {t("presentation.importPdf")}
                </button>
              }
            />
          ) : (
            <div className="list">
              {decks.map((item) => (
                <button
                  key={item.id}
                  className="row"
                  aria-selected={item.id === activeId}
                  onClick={() => setActiveId(item.id)}
                  onContextMenu={(event) => {
                    setActiveId(item.id);
                    openMenu(event, [
                      {
                        label: t("plan.add"),
                        icon: "plus",
                        onSelect: () =>
                          addToPlan({
                            kind: "presentation",
                            label: item.name,
                            note: "",
                            ref: { presentationId: item.id },
                          }),
                      },
                      {
                        label: t("songbook.rename"),
                        icon: "pencil",
                        onSelect: () => {
                          void dialogs
                            .prompt({
                              title: t("songbook.rename"),
                              label: t("common.name"),
                              value: item.name,
                            })
                            .then((name) =>
                              name ? api.renamePresentation(item.id, name).then(reload) : undefined,
                            )
                            .catch(reportError);
                        },
                      },
                      "separator",
                      {
                        label: t("common.delete"),
                        icon: "trash",
                        danger: true,
                        onSelect: () => {
                          void dialogs
                            .confirm({
                              title: t("common.delete"),
                              message: t("presentation.deleteConfirm", { name: item.name }),
                              confirmLabel: t("common.delete"),
                              danger: true,
                            })
                            .then((ok) =>
                              ok ? api.deletePresentation(item.id).then(reload) : undefined,
                            )
                            .catch(reportError);
                        },
                      },
                    ]);
                  }}
                >
                  <span className="row__main">
                    <span className="row__title">{item.name}</span>
                    <span className="row__sub">
                      {t("presentation.slideCount", { n: item.slides.length })}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </section>

      <section className="panel" ref={slidesRef} style={{ flex: 1, position: "relative" }}>
        {zone === "slides" && (
          <DropZone
            icon="image"
            title={
              active
                ? t("presentation.dropInto", { name: active.name })
                : t("presentation.dropNew")
            }
            hint={t("presentation.dropPages")}
          />
        )}
        <div className="panel__head">
          <span className="panel__title">{active?.name ?? ""}</span>
          <div className="topbar__spacer" />
          {busy && <span className="field__hint">{busy}</span>}
          <button className="btn btn--sm" onClick={() => void addMessage()} disabled={!!busy}>
            <Icon name="pencil" size={12} />
            {t("presentation.addMessage")}
          </button>
          <button className="btn btn--sm" onClick={() => void addFiles()} disabled={!active || !!busy}>
            <Icon name="plus" size={12} />
            {t("presentation.add")}
          </button>
        </div>
        <div className="panel__body">
          {!active ? (
            <Empty title={t("presentation.none")} hint={t("presentation.noneHint")} />
          ) : active.slides.length === 0 ? (
            <Empty
              title={t("presentation.empty")}
              hint={t("presentation.emptyHint")}
              action={
                <div style={{ display: "flex", gap: 8 }}>
                  <button className="btn btn--primary" onClick={() => void addFiles()}>
                    <Icon name="folder" size={13} />
                    {t("presentation.add")}
                  </button>
                  <button className="btn" onClick={() => void addMessage()}>
                    <Icon name="pencil" size={13} />
                    {t("presentation.addMessage")}
                  </button>
                </div>
              }
            />
          ) : (
            <SlideGrid
              deckId={active.id}
              slides={active.slides}
              onEditText={editMessage}
              cursor={cursor}
              liveIndex={deck?.source === "image" ? liveIndex : null}
              onSelect={select}
              onShow={go}
              onMove={move}
              onRemove={(files) => void removeSlides(files)}
              onAddFiles={() => void addFiles()}
              onAddMessage={() => void addMessage()}
              busy={!!busy}
              selection={selection}
            />
          )}
        </div>
        <div className="panel__foot">
          <span className="field__hint">
            {t("presentation.dragHint")} · {t("presentation.dropTypes")}
          </span>
        </div>
      </section>

    </div>
  );
}

/** Highlights whichever half of the tab a drag is currently over. */
function DropZone({ icon, title, hint }: { icon: "plus" | "image"; title: string; hint: string }) {
  return (
    <div className="dropzone">
      <div className="dropzone__card">
        <Icon name={icon} size={22} />
        <span>{title}</span>
        <span className="field__hint">{hint}</span>
      </div>
    </div>
  );
}

function SlideGrid({
  deckId,
  slides,
  cursor,
  liveIndex,
  onSelect,
  onShow,
  onMove,
  onRemove,
  onEditText,
  onAddFiles,
  onAddMessage,
  busy,
  selection,
}: {
  deckId: string;
  slides: { file: string; path: string; text: string | null }[];
  onEditText: (file: string, current: string) => void;
  cursor: number;
  liveIndex: number | null;
  onSelect: (index: number) => void;
  onShow: (index: number) => void;
  onMove: (from: number, to: number) => void;
  onRemove: (files: string[]) => void;
  onAddFiles: () => void;
  onAddMessage: () => void;
  busy: boolean;
  selection: TileSelection;
}) {
  const t = useStore((s) => s.t);
  const openMenu = useContextMenu();
  const dialogs = useDialogs();
  const gridRef = useRef<HTMLDivElement>(null);
  const { dragging, beginPress } = useGridReorder({
    containerRef: gridRef,
    onMove,
    onClick: (index, event) => {
      // A modifier press adjusts the selection instead of moving the cursor.
      if (!selection.handleClick(index, event)) onSelect(index);
    },
  });

  const marquee = useMarquee({
    containerRef: gridRef,
    count: slides.length,
    onSelect: selection.setMany,
    onClear: selection.clear,
  });

  return (
    <div
      ref={gridRef}
      onPointerDown={marquee.onPointerDown}
      style={{
        position: "relative",
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(168px, 1fr))",
        gap: 10,
        padding: 12,
      }}
    >
      {slides.map((slide, index) => (
        <div
          key={`${deckId}:${slide.file}`}
          onPointerDown={(event) => beginPress(event, index)}
          onDoubleClick={() => onShow(index)}
          onContextMenu={(event) => {
            const inSelection = selection.selected.has(index);
            const targets =
              inSelection && selection.isMulti
                ? selection.ordered().map((i) => slides[i]?.file).filter((f): f is string => !!f)
                : [slide.file];
            if (!inSelection) selection.selectOnly(index);
            openMenu(event, [
              {
                label: t("menu.show"),
                icon: "eye",
                disabled: targets.length > 1,
                onSelect: () => onShow(index),
              },
              ...(slide.text !== null && targets.length === 1
                ? [
                    {
                      label: t("menu.editText"),
                      icon: "pencil" as const,
                      onSelect: () => onEditText(slide.file, slide.text ?? ""),
                    },
                  ]
                : []),
              "separator",
              {
                label:
                  targets.length > 1
                    ? t("presentation.deleteSelected", { n: targets.length })
                    : t("common.delete"),
                icon: "trash",
                danger: true,
                // Removing slides erases their images, so it asks first.
                onSelect: () => {
                  void dialogs
                    .confirm({
                      title: t("common.delete"),
                      message:
                        targets.length > 1
                          ? t("presentation.slidesDeleteConfirm", { n: targets.length })
                          : t("presentation.slideDeleteConfirm", { n: index + 1 }),
                      confirmLabel: t("common.delete"),
                      danger: true,
                    })
                    .then((ok) => {
                      if (ok) onRemove(targets);
                    });
                },
              },
            ]);
          }}
          style={{
            position: "relative",
            borderRadius: 8,
            overflow: "hidden",
            cursor: dragging === index ? "grabbing" : "grab",
            border: `2px solid ${
              index === liveIndex
                ? "var(--accent)"
                : selection.selected.has(index) || index === cursor
                  ? "var(--accent-line)"
                  : "var(--border-strong)"
            }`,
            boxShadow: selection.selected.has(index)
              ? "inset 0 0 0 2px var(--accent-soft)"
              : undefined,
            opacity: dragging === index ? 0.55 : 1,
            background: "#000",
            aspectRatio: "16 / 9",
            touchAction: "none",
          }}
        >
          {slide.text === null ? (
            <img
              src={convertFileSrc(slide.path)}
              alt=""
              draggable={false}
              style={{ width: "100%", height: "100%", objectFit: "contain" }}
            />
          ) : (
            // A message slide shows its words, so the deck reads at a glance.
            <span
              style={{
                display: "grid",
                alignContent: "safe center",
                justifyItems: "center",
                width: "100%",
                height: "100%",
                padding: "14px 12px",
                fontSize: 12.5,
                lineHeight: 1.4,
                textAlign: "center",
                whiteSpace: "pre-wrap",
                overflow: "hidden",
                color: slide.text.trim() ? "var(--text)" : "var(--text-faint)",
              }}
            >
              {slide.text.trim() || t("presentation.emptyMessage")}
            </span>
          )}
          <span
            style={{
              position: "absolute",
              left: 5,
              top: 5,
              padding: "1px 6px",
              borderRadius: 3,
              fontSize: 10,
              fontWeight: 700,
              background: "rgba(0,0,0,0.7)",
              color: index === liveIndex ? "var(--accent)" : "#fff",
            }}
          >
            {index + 1}
          </span>
        </div>
      ))}

      {/* Always last: the tile that adds more. */}
      <button
        className="tile tile--add"
        style={{ aspectRatio: "16 / 9" }}
        disabled={busy}
        title={t("presentation.addSlide")}
        onClick={(event) =>
          openMenu(event, [
            {
              label: t("presentation.add"),
              icon: "folder",
              onSelect: onAddFiles,
            },
            {
              label: t("presentation.addMessage"),
              icon: "pencil",
              onSelect: onAddMessage,
            },
          ])
        }
      >
        <Icon name="plus" size={24} />
        <span>{t("presentation.addSlide")}</span>
      </button>

      {marquee.rect && <div className="marquee" style={marquee.rect} />}
    </div>
  );
}
