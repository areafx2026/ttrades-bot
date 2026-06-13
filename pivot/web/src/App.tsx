import { useEffect, useReducer } from "react";
import { connectWS, Evt } from "./ws";
import { Dashboard } from "./pages/Dashboard";

const SOUNDS: Record<string, string> = {
  open: "/sounds/notify.wav",
  win: "/sounds/tada.wav",
  loss: "/sounds/disconnect.wav",
};

export type State = {
  zones: Record<string, any[]>;
  trades: any[];
  account: any;
  events: Evt[];
  autoEnabled: boolean;
};

const initial: State = { zones: {}, trades: [], account: null, events: [], autoEnabled: true };

function reducer(s: State, e: Evt): State {
  switch (e.kind) {
    case "zones":
      return { ...s, zones: { ...s.zones, [e.symbol]: e.zones } };
    case "fill":
      return { ...s, trades: [e, ...s.trades], events: [e, ...s.events].slice(0, 100) };
    case "account":
      return { ...s, account: e };
    default:
      return { ...s, events: [e, ...s.events].slice(0, 100) };
  }
}

export default function App() {
  const [state, dispatch] = useReducer(reducer, initial);

  useEffect(() => {
    connectWS((e) => {
      dispatch(e);
      if (e.sound && SOUNDS[e.sound]) new Audio(SOUNDS[e.sound]).play().catch(() => {});
    });
  }, []);

  return <Dashboard state={state} />;
}
