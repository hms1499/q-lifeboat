import { configureEndpoints } from "@qday/core/chain";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { APP_NAME } from "./brand";
import { AppProvider } from "./state";
import "./styles.css";

document.title = APP_NAME;

// diana's REST and Tendermint RPC send no CORS headers: the in-app wallet signs and broadcasts through same-origin
// proxies (Vite in dev, the hosted service in production). Absolute URLs: StargateClient needs one. Both in one call.
configureEndpoints({ rest: `${window.location.origin}/qore-rest`, rpc: `${window.location.origin}/qore-rpc` });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppProvider>
      <App />
    </AppProvider>
  </StrictMode>,
);
