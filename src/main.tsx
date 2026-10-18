import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { TerminalWindow } from "./terminal/TerminalWindow";
import { windowMode } from "./windowMode";
import "./theme/tokens.css";
import "./theme/base.css";

// A pop-out window (`?terminal=<id>`, Story 4.5) renders that one terminal; every other window the app.
const mode = windowMode(window.location.search);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{mode.kind === "terminal" ? <TerminalWindow id={mode.id} /> : <App />}</React.StrictMode>,
);
