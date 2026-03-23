import { getToken, clearToken } from "./auth";
import type {
  Overview,
  NavPoint,
  HoldingsData,
  TradesData,
  SignalsData,
  Slot,
  ExecutionsData,
  ExecutionsSummary,
  PendingOrdersData,
} from "../types";

const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:8080";

async function request<T>(path: string, params?: Record<string, string>): Promise<T> {
  const token = getToken();
  if (!token) throw new Error("NO_TOKEN");

  const url = new URL(`${API_BASE}${path}`);
  if (params) {
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  }

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (res.status === 401) {
    clearToken();
    throw new Error("UNAUTHORIZED");
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return res.json();
}

export const api = {
  overview: () => request<Overview>("/api/overview"),
  nav: () => request<NavPoint[]>("/api/nav"),
  holdings: () => request<HoldingsData>("/api/holdings"),
  trades: (page = 1, size = 20) =>
    request<TradesData>("/api/trades", { page: String(page), size: String(size) }),
  signals: (date?: string) =>
    request<SignalsData>("/api/signals", date ? { date } : {}),
  signalDates: () => request<string[]>("/api/signals/dates"),
  slots: () => request<Slot[]>("/api/slots"),
  executions: (params: {
    page?: number;
    size?: number;
    action?: string;
    stock_code?: string;
    start_date?: string;
    end_date?: string;
  } = {}) => {
    const q: Record<string, string> = {};
    if (params.page) q.page = String(params.page);
    if (params.size) q.size = String(params.size);
    if (params.action) q.action = params.action;
    if (params.stock_code) q.stock_code = params.stock_code;
    if (params.start_date) q.start_date = params.start_date;
    if (params.end_date) q.end_date = params.end_date;
    return request<ExecutionsData>("/api/executions", q);
  },
  executionsSummary: () => request<ExecutionsSummary>("/api/executions/summary"),
  pendingOrders: (status?: string) =>
    request<PendingOrdersData>("/api/pending-orders", status ? { status } : {}),
};
