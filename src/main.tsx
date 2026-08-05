import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { ContextMenuProvider } from "./components/ui/ContextMenu";
import { DialogProvider } from "./components/ui/Dialogs";
import { flushSettings } from "./app/store";
import "./styles/global.css";

// The layout editor debounces its writes; make sure the last one lands.
window.addEventListener("beforeunload", flushSettings);
window.addEventListener("blur", flushSettings);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <DialogProvider>
      <ContextMenuProvider>
        <App />
      </ContextMenuProvider>
    </DialogProvider>
  </StrictMode>,
);
