import ReactDOM from "react-dom/client";
import { MotionConfig } from "framer-motion";
import "./styles/index.css";
import { App } from "./App";
import { ItemStoreProvider } from "./lib/itemStore";
import { CommandStackProvider } from "./lib/commands";
import { ModalProvider } from "./components/Modal";

ReactDOM.createRoot(document.getElementById("root")!).render(
  // reducedMotion="user" disables transform/layout animations app-wide when the
  // OS prefers reduced motion; index.css covers the CSS keyframe equivalents.
  <MotionConfig reducedMotion="user">
    <ItemStoreProvider>
      <CommandStackProvider>
        <ModalProvider>
          <App />
        </ModalProvider>
      </CommandStackProvider>
    </ItemStoreProvider>
  </MotionConfig>
);
