import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import type { SorttieApi } from "../shared/contracts";

declare global {
  interface Window {
    sorttie?: SorttieApi;
  }
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
