"use client";
import { useTradingStore } from "./store";
import type { WSMessage, Market, Signal, Order, Position, ArbOpportunity } from "./types";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8765";
const PING_INTERVAL_MS = 15_000;
const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 15000, 30000];

let socket: WebSocket | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;
let pingTs = 0;
let isMounted = false;

function dispatch(msg: WSMessage) {
  const store = useTradingStore.getState();

  switch (msg.type) {
    case "market_update": {
      const m = msg as unknown as Market & { type: string };
      store.updateMarket(m);
      break;
    }
    case "orderbook_update": {
      store.setOrderBook(msg as any);
      break;
    }
    case "price_history": {
      store.setPriceHistory((msg as any).data ?? []);
      break;
    }
    case "signal": {
      store.addSignal(msg as unknown as Signal);
      store.addLog({ level: "INFO", message: `Signal: ${(msg as any).side} ${(msg as any).market_question?.slice(0,40)} edge=${((msg as any).edge * 100).toFixed(1)}%`, ts: Date.now() });
      break;
    }
    case "order_submitted": {
      store.addOrder(msg as unknown as Order);
      break;
    }
    case "order_filled": {
      store.updateOrder((msg as any).order_id, { status: "FILLED", fill_price: (msg as any).fill_price, filled_size: (msg as any).filled_size });
      store.addLog({ level: "INFO", message: `Fill: ${(msg as any).order_id?.slice(0,8)} @ ${(msg as any).fill_price?.toFixed(3)}`, ts: Date.now() });
      break;
    }
    case "order_cancelled": {
      store.updateOrder((msg as any).order_id, { status: "CANCELLED" });
      break;
    }
    case "position_update": {
      const pos = msg as unknown as Position & { type: string };
      store.updatePosition(pos.market_id, pos);
      break;
    }
    case "risk_update": {
      store.setRisk(msg as any);
      break;
    }
    case "heartbeat": {
      store.setWorkerHealth((msg as any).workers ?? {});
      break;
    }
    case "stats_update": {
      store.setStats(msg as any);
      break;
    }
    case "log": {
      store.addLog({ level: (msg as any).level ?? "INFO", message: (msg as any).message, ts: (msg as any).ts ?? Date.now() });
      break;
    }
    case "arb_opportunity": {
      store.addArbOpportunity(msg as unknown as ArbOpportunity);
      store.addLog({
        level: "INFO",
        message: `ARB: ${(msg as any).strategy} edge=+${((msg as any).edge * 100).toFixed(1)}¢ — ${(msg as any).action?.slice(0, 50)}`,
        ts: Date.now(),
      });
      break;
    }
    case "markets_snapshot": {
      const mkts = (msg as any).markets as Market[];
      if (mkts?.length) {
        store.setMarkets(mkts);
        if (!useTradingStore.getState().selectedMarket) {
          store.selectMarket(mkts[0]);
        }
      }
      break;
    }
    case "positions_update": {
      store.setPositions((msg as any).positions ?? []);
      break;
    }
    case "kill_switch": {
      store.activateKillSwitch();
      store.addLog({ level: "CRITICAL", message: "KILL SWITCH ACTIVATED — all trading halted", ts: Date.now() });
      break;
    }
    case "pong": {
      const latency = Date.now() - pingTs;
      store.setStats({ ws_latency_ms: latency });
      break;
    }
  }
}

function schedulePing() {
  if (pingTimer) clearInterval(pingTimer);
  pingTimer = setInterval(() => {
    if (socket?.readyState === WebSocket.OPEN) {
      pingTs = Date.now();
      socket.send(JSON.stringify({ type: "ping" }));
    }
  }, PING_INTERVAL_MS);
}

function connect() {
  if (!isMounted) return;
  if (socket && socket.readyState === WebSocket.CONNECTING) return;

  try {
    socket = new WebSocket(WS_URL);
  } catch {
    scheduleReconnect();
    return;
  }

  socket.onopen = () => {
    reconnectAttempt = 0;
    useTradingStore.getState().setStats({ ws_connected: true, ws_latency_ms: 0 });
    useTradingStore.getState().addLog({ level: "INFO", message: `WebSocket connected to ${WS_URL}`, ts: Date.now() });
    schedulePing();
    // Request initial state
    socket?.send(JSON.stringify({ type: "subscribe", channels: ["market", "orderbook", "signal", "order", "position", "risk", "heartbeat", "log"] }));
  };

  socket.onmessage = (ev) => {
    try {
      const msg: WSMessage = JSON.parse(ev.data as string);
      dispatch(msg);
    } catch { /* malformed message — ignore */ }
  };

  socket.onerror = () => {
    // onerror always followed by onclose
  };

  socket.onclose = () => {
    if (pingTimer) clearInterval(pingTimer);
    useTradingStore.getState().setStats({ ws_connected: false });
    if (isMounted) scheduleReconnect();
  };
}

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  const delay = RECONNECT_DELAYS[Math.min(reconnectAttempt, RECONNECT_DELAYS.length - 1)];
  reconnectAttempt++;
  useTradingStore.getState().addLog({ level: "WARNING", message: `WebSocket disconnected — reconnecting in ${delay / 1000}s (attempt ${reconnectAttempt})`, ts: Date.now() });
  reconnectTimer = setTimeout(connect, delay);
}

export function initWebSocket() {
  isMounted = true;
  connect();
}

export function destroyWebSocket() {
  isMounted = false;
  if (pingTimer) clearInterval(pingTimer);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  socket?.close();
  socket = null;
}

export function sendMessage(msg: object) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(msg));
  }
}
