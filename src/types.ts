export interface ClosedTradeStats {
  total: number;
  winning: number;
  losing: number;
  win_rate: number;
  avg_profit_pct: number;
}

export interface OpenPositionStats {
  total: number;
  winning: number;
  losing: number;
  win_rate: number;
}

export interface Overview {
  total_return_pct: number;
  max_drawdown: number;
  sharpe_ratio: number;
  total_value: number;
  position_value: number;
  holding_count: number;
  closed_trade_stats: ClosedTradeStats;
  open_position_stats: OpenPositionStats;
}

export interface NavPoint {
  date: string;
  total_value: number;
  drawdown: number;
  return_pct: number;
  day_return?: number;
}

export interface Position {
  id: number;
  stock_code: string;
  buy_date: string;
  buy_price: number;
  shares: number;
  cost: number;
  current_value?: number;
  value_updated_date?: string;
  slot_idx: number;
  da_pred: number | null;
  zhong_iqr: number | null;
}

export interface Slot {
  slot_idx: number;
  capital: number;
  position_count: number;
  stocks?: string[];
  closed_trade_stats?: ClosedTradeStats;
  open_position_stats?: OpenPositionStats;
}

export interface HoldingsData {
  positions: Position[];
  slots: Slot[];
}

export interface Trade {
  id: number;
  stock_code: string;
  buy_date: string;
  buy_price: number;
  sell_date: string;
  sell_price: number;
  profit: number;
  profit_pct: number;
  slot_idx: number;
  sell_reason: string;
}

export interface TradesData {
  trades: Trade[];
  total: number;
}

export interface Signal {
  stock_code: string;
  da_next_price_change: number | null;
  zhong_iqr: number | null;
  passed_filter: boolean;
}

export interface SignalsData {
  signals: Signal[];
}

export interface Execution {
  id: number;
  exec_date: string;
  stock_code: string;
  action: "buy" | "sell";
  market_price: number;
  exec_price: number;
  shares: number;
  amount: number;
  slippage: number;
  commission: number;
  stamp_duty: number;
  total_cost: number;
  net_amount: number;
  slot_idx: number;
  source: "backfill" | "live";
  da_pred: number | null;
  zhong_iqr: number | null;
}

export interface ExecutionsData {
  executions: Execution[];
  total: number;
  page: number;
  size: number;
  pages: number;
}

export interface ExecutionsSummary {
  total: number;
  buys: number;
  sells: number;
  total_slippage: number;
  total_commission: number;
  total_stamp_duty: number;
  total_cost: number;
}

export interface PendingOrder {
  id: number;
  create_date: string;
  stock_code: string;
  slot_idx: number;
  action: "buy" | "sell";
  da_pred: number | null;
  zhong_iqr: number | null;
  status: string;
}

export interface PendingOrdersData {
  orders: PendingOrder[];
  total: number;
}

export interface IndexDailyPoint {
  ts_code: string;
  trade_date: string;
  close: number;
  open: number;
  high: number;
  low: number;
  pre_close: number;
  change: number;
  pct_chg: number;
  vol: number;
  amount: number;
}

export interface IndexDailyResponse {
  data: IndexDailyPoint[];
  total: number;
  ts_code: string;
}

export interface HoldingsDailyItem {
  stock_code: string;
  shares: number;
  slot_idx: number[];
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  pre_close: number | null;
  change: number | null;
  pct_chg: number | null;
  vol: number;
  amount: number;
  is_realtime?: boolean;
}

export interface HoldingsDailyResponse {
  date: string;
  items: HoldingsDailyItem[];
  total: number;
}
