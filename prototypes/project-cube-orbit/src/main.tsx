import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BuzzProjectPrototype } from "../app/buzz-project-prototype";
import "../app/globals.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode><BuzzProjectPrototype /></StrictMode>,
);
