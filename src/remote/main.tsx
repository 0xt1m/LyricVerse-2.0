import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "../styles/remote.css";

/**
 * The phone remote's document.
 *
 * Deliberately not the console's stylesheet: this page is thumbs in a dark
 * room, not a mouse at a desk, and every size and spacing in it is different.
 */
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
