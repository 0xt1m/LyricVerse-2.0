import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Icon, type IconName } from "./Icon";

export interface MenuItem {
  label: string;
  icon?: IconName;
  onSelect?: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** Renders a tick in the icon slot — for menus that toggle things. */
  checked?: boolean;
  /** Right-aligned hint, e.g. a keyboard shortcut. */
  hint?: string;
}

export type MenuEntry = MenuItem | "separator";

type OpenMenu = (event: React.MouseEvent | MouseEvent, items: MenuEntry[]) => void;

const ContextMenuContext = createContext<OpenMenu>(() => {});

/** `openMenu(event, items)` — call from an `onContextMenu` handler. */
export function useContextMenu(): OpenMenu {
  return useContext(ContextMenuContext);
}

interface MenuState {
  x: number;
  y: number;
  items: MenuEntry[];
}

export function ContextMenuProvider({ children }: { children: ReactNode }) {
  const [menu, setMenu] = useState<MenuState | null>(null);

  const open = useCallback<OpenMenu>((event, items) => {
    if (items.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    setMenu({ x: event.clientX, y: event.clientY, items });
  }, []);

  useEffect(() => {
    // The webview's own menu (Reload, Inspect Element…) is meaningless here,
    // but text fields still need Cut/Copy/Paste.
    const suppress = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && target.closest("input, textarea, [contenteditable='true']")) return;
      event.preventDefault();
    };
    window.addEventListener("contextmenu", suppress);
    return () => window.removeEventListener("contextmenu", suppress);
  }, []);

  return (
    <ContextMenuContext.Provider value={open}>
      {children}
      {menu && <Menu state={menu} onClose={() => setMenu(null)} />}
    </ContextMenuContext.Provider>
  );
}

function Menu({ state, onClose }: { state: MenuState; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x: state.x, y: state.y });

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    // Flip back inside the window rather than opening off the edge.
    const box = node.getBoundingClientRect();
    const margin = 6;
    const x = Math.max(
      margin,
      Math.min(state.x, window.innerWidth - box.width - margin),
    );
    const y = Math.max(
      margin,
      Math.min(state.y, window.innerHeight - box.height - margin),
    );
    setPosition({ x, y });
  }, [state.x, state.y, state.items]);

  useEffect(() => {
    // A press inside the menu must be left alone. These listeners run in the
    // capture phase — before the event reaches the button — so without this
    // check the menu would unmount on `pointerdown` and the item's `click`
    // would never happen at all.
    const close = (event: Event) => {
      if (ref.current?.contains(event.target as Node)) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    // Capture phase, so a click that dismisses the menu does not also activate
    // whatever sits underneath it.
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("wheel", close, true);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("wheel", close, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="menu"
      role="menu"
      style={{ left: position.x, top: position.y }}
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      {state.items.map((entry, index) =>
        entry === "separator" ? (
          <div key={`sep-${index}`} className="menu__separator" />
        ) : (
          <button
            key={entry.label}
            className="menu__item"
            role="menuitem"
            data-danger={entry.danger || undefined}
            disabled={entry.disabled}
            onClick={() => {
              onClose();
              entry.onSelect?.();
            }}
          >
            <span className="menu__icon">
              {entry.checked !== undefined ? (
                entry.checked && <Icon name="check" size={13} />
              ) : (
                entry.icon && <Icon name={entry.icon} size={13} />
              )}
            </span>
            <span className="menu__label">{entry.label}</span>
            {entry.hint && <span className="menu__hint">{entry.hint}</span>}
          </button>
        ),
      )}
    </div>
  );
}
