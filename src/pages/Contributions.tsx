import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Card,
  Spin,
  Alert,
  Tag,
  Table,
  Row,
  Col,
  Statistic,
  Tooltip,
  Empty,
  Select,
  Segmented,
} from "antd";
import {
  ArrowUpOutlined,
  ArrowDownOutlined,
  InfoCircleOutlined,
  RiseOutlined,
  FallOutlined,
} from "@ant-design/icons";
import ReactECharts from "echarts-for-react";
import { api } from "../utils/api";
import useIsMobile from "../hooks/useIsMobile";
import type {
  NavPoint,
  Execution,
  HoldingsDailyItem,
} from "../types";

const POS_COLOR = "#3f8600";
const NEG_COLOR = "#cf1322";

interface ExecAgg {
  buy_count: number;
  sell_count: number;
  buy_shares: number;
  sell_shares: number;
  buy_amount: number;
  sell_amount: number;
  total_commission: number;
  total_stamp_duty: number;
  total_slippage: number;
  total_exec_cost: number;
}

const EMPTY_EXEC_AGG: ExecAgg = {
  buy_count: 0,
  sell_count: 0,
  buy_shares: 0,
  sell_shares: 0,
  buy_amount: 0,
  sell_amount: 0,
  total_commission: 0,
  total_stamp_duty: 0,
  total_slippage: 0,
  total_exec_cost: 0,
};

interface ContribRow {
  stock_code: string;
  slot_idx: number[];
  shares: number;
  shares_prev: number;
  close: number | null;
  pre_close: number | null;
  change: number | null;
  pct_chg: number | null;
  is_suspended: boolean;
  is_realtime: boolean;
  // 当日开仓且当日清仓（昨日无持仓，sell_shares == buy_shares）。
  // 这种 row 走"日内 PnL = sell_amount − buy_amount"分支，pre_close/close 是 vwap 代理。
  is_intraday: boolean;
  // attribution
  hold_pnl: number;
  buy_pnl: number;
  sell_pnl: number;
  total_pnl: number;
  contribution_pct: number; // total_pnl / prev_total_value
  contribution_share: number; // total_pnl / total_day_pnl (signed share)
  // exec
  exec: ExecAgg;
}

function fmtMoney(v: number, digits = 0) {
  const sign = v < 0 ? "-" : "";
  const abs = Math.abs(v);
  return `${sign}¥${abs.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

function fmtPct(v: number | null | undefined, digits = 2) {
  if (v == null || Number.isNaN(v) || !Number.isFinite(v)) return "-";
  const sign = v >= 0 ? "+" : "";
  return `${sign}${v.toFixed(digits)}%`;
}

function pnlColor(v: number | null | undefined) {
  if (v == null || Number.isNaN(v)) return "rgba(255,255,255,0.65)";
  if (v > 0) return POS_COLOR;
  if (v < 0) return NEG_COLOR;
  return "rgba(255,255,255,0.65)";
}

// 贡献度排行图统一使用的「纯左右滚动」滑块（窗口固定，禁止缩放）
function buildScrollDataZoom(endPercent: number) {
  return [
    {
      type: "slider" as const,
      show: true,
      xAxisIndex: 0,
      start: 0,
      end: endPercent,
      height: 10,
      bottom: 4,
      brushSelect: false,
      zoomLock: true,
      showDetail: false,
      showDataShadow: false,
      handleSize: 0,
      moveHandleSize: 0,
      fillerColor: "rgba(255,255,255,0.25)",
      borderColor: "transparent",
      backgroundColor: "rgba(255,255,255,0.06)",
    },
    {
      type: "inside" as const,
      xAxisIndex: 0,
      start: 0,
      end: endPercent,
      zoomLock: true,
    },
  ];
}

// 计算贡献度柱图 Y 轴范围（含 10% padding，零基线锚定）
function computeAxisRange(values: number[]) {
  const rawMin = Math.min(0, ...values);
  const rawMax = Math.max(0, ...values);
  const span = rawMax - rawMin || 1;
  const pad = span * 0.1;
  const yMin = rawMin < 0 ? Number((rawMin - pad).toFixed(4)) : 0;
  const yMax = rawMax > 0 ? Number((rawMax + pad).toFixed(4)) : 0;
  return { yMin, yMax };
}

// 已清股票表格单元格的 Tooltip 包装（仅在 proxy=true 时套 Tooltip）
function ClosedProxyCell({
  proxy,
  title,
  children,
}: {
  proxy: boolean;
  title: string;
  children: ReactNode;
}) {
  if (!proxy) return <>{children}</>;
  return <Tooltip title={title}>{children}</Tooltip>;
}

const CLOSED_PROXY_TIP = "已清仓，按卖出成交均价相对昨日收盘推算";
const INTRADAY_PROXY_TIP =
  "日内开仓平仓，按卖出均价相对买入均价推算（昨日无持仓，无昨日收盘可参考）";

function proxyTipFor(r: { is_intraday: boolean }) {
  return r.is_intraday ? INTRADAY_PROXY_TIP : CLOSED_PROXY_TIP;
}

async function fetchExecutionsForDate(date: string): Promise<Execution[]> {
  const SIZE_CANDIDATES = [100, 50, 20];
  const baseQuery = { start_date: date, end_date: date };

  let first;
  let pageSize = SIZE_CANDIDATES[0];
  let lastErr: unknown;
  for (const size of SIZE_CANDIDATES) {
    try {
      first = await api.executions({ ...baseQuery, page: 1, size });
      pageSize = size;
      break;
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (!/HTTP\s*4(00|22)/.test(msg)) throw e;
    }
  }
  if (!first) throw lastErr instanceof Error ? lastErr : new Error("EXECUTIONS_FAILED");

  if (first.pages <= 1) return first.executions;

  const restPages = await Promise.all(
    Array.from({ length: first.pages - 1 }, (_, i) =>
      api.executions({ ...baseQuery, page: i + 2, size: pageSize })
    )
  );
  return first.executions.concat(...restPages.map((r) => r.executions));
}

export default function Contributions() {
  const [navData, setNavData] = useState<NavPoint[]>([]);
  const [navLoading, setNavLoading] = useState(true);
  const [navError, setNavError] = useState("");

  const [selectedDate, setSelectedDate] = useState<string>("");
  const [chartMode, setChartMode] = useState<"stock" | "slot">("stock");
  // 明细表排序方向：desc = 涨幅优先（贡献度从大到小），asc = 跌幅优先（贡献度从小到大）
  const [detailSort, setDetailSort] = useState<"desc" | "asc">("desc");

  const [items, setItems] = useState<HoldingsDailyItem[]>([]);
  const [executions, setExecutions] = useState<Execution[]>([]);
  const [dayLoading, setDayLoading] = useState(false);
  const [dayError, setDayError] = useState("");
  const [execError, setExecError] = useState("");

  // 用于「已清股票」精确归因：拉前一交易日的 holdings/daily，
  //   - close → 作为今日 pre_close
  //   - slot_idx → 让清仓股票仍能正确归到原槽位，而不是被全部丢进「未分配」桶
  const [closedPreClose, setClosedPreClose] = useState<Map<string, number>>(
    new Map()
  );
  const [closedPrevSlotIdx, setClosedPrevSlotIdx] = useState<Map<string, number[]>>(
    new Map()
  );
  const [closedPreCloseError, setClosedPreCloseError] = useState("");

  const isMobile = useIsMobile();

  // 1) 拉 nav，确定可选日期与默认值
  useEffect(() => {
    api
      .nav()
      .then((nav) => {
        const sorted = [...nav].sort((a, b) => a.date.localeCompare(b.date));
        setNavData(sorted);
        if (sorted.length) setSelectedDate(sorted[sorted.length - 1].date);
      })
      .catch((e) => setNavError(e.message))
      .finally(() => setNavLoading(false));
  }, []);

  // 2) 选定日期变化时并行拉持仓日线 + 当日交割单
  useEffect(() => {
    if (!selectedDate) return;
    setDayLoading(true);
    setDayError("");
    setExecError("");
    setItems([]);
    setExecutions([]);

    let cancelled = false;

    const pHoldings = api
      .holdingsDaily(selectedDate)
      .then((res) => {
        if (!cancelled) setItems(res.items || []);
      })
      .catch((e) => {
        if (!cancelled) setDayError(e.message);
      });

    const pExec = fetchExecutionsForDate(selectedDate)
      .then((rows) => {
        if (!cancelled) setExecutions(rows);
      })
      .catch((e) => {
        if (!cancelled) setExecError(e.message);
      });

    Promise.all([pHoldings, pExec]).finally(() => {
      if (!cancelled) setDayLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [selectedDate]);

  // prev_total_value：选定日期的前一交易日总资产，作为贡献度的分母
  const { prevDate, prevTotalValue, dayReturnPct, todayTotalValue } = useMemo(() => {
    const idx = navData.findIndex((n) => n.date === selectedDate);
    if (idx < 0)
      return {
        prevDate: null as string | null,
        prevTotalValue: null,
        dayReturnPct: null,
        todayTotalValue: null,
      };
    const today = navData[idx];
    const prev = idx > 0 ? navData[idx - 1] : null;
    const dr =
      typeof today.day_return === "number"
        ? today.day_return
        : prev && prev.total_value > 0
        ? ((today.total_value - prev.total_value) / prev.total_value) * 100
        : null;
    return {
      prevDate: prev?.date ?? null,
      prevTotalValue: prev?.total_value ?? null,
      dayReturnPct: dr,
      todayTotalValue: today.total_value,
    };
  }, [navData, selectedDate]);

  const execAggByCode = useMemo(() => {
    const map = new Map<string, ExecAgg>();
    for (const e of executions) {
      const cur = map.get(e.stock_code) ?? { ...EMPTY_EXEC_AGG };
      if (e.action === "buy") {
        cur.buy_count += 1;
        cur.buy_shares += e.shares;
        cur.buy_amount += e.amount;
      } else {
        cur.sell_count += 1;
        cur.sell_shares += e.shares;
        cur.sell_amount += e.amount;
      }
      cur.total_commission += e.commission;
      cur.total_stamp_duty += e.stamp_duty;
      cur.total_slippage += e.slippage;
      cur.total_exec_cost += e.total_cost;
      map.set(e.stock_code, cur);
    }
    return map;
  }, [executions]);

  const execsByCode = useMemo(() => {
    const map = new Map<string, Execution[]>();
    for (const e of executions) {
      const arr = map.get(e.stock_code);
      if (arr) arr.push(e);
      else map.set(e.stock_code, [e]);
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => a.id - b.id);
    }
    return map;
  }, [executions]);

  // 当日完全卖出（开盘前持有但收盘已不在持仓）的股票：在 executions 里有 sell，
  // 但不在 holdings/daily 的 items 里。它们仍然贡献当日盈亏。
  const closedTodayCodes = useMemo(() => {
    const heldSet = new Set(items.map((it) => it.stock_code));
    return [...execAggByCode.keys()].filter((c) => !heldSet.has(c));
  }, [items, execAggByCode]);

  // 已清股票的归因需要昨日收盘：拉一次前一交易日的 holdings/daily
  //   items[].close    → 今日 pre_close（用于精确 PnL 归因）
  //   items[].slot_idx → 清仓股票的原槽位（用于按槽位视图正确分类）
  useEffect(() => {
    setClosedPreCloseError("");
    if (!prevDate || closedTodayCodes.length === 0) {
      setClosedPreClose(new Map());
      setClosedPrevSlotIdx(new Map());
      return;
    }
    let cancelled = false;
    api
      .holdingsDaily(prevDate)
      .then((res) => {
        if (cancelled) return;
        const need = new Set(closedTodayCodes);
        const closeMap = new Map<string, number>();
        const slotMap = new Map<string, number[]>();
        for (const it of res.items) {
          if (!need.has(it.stock_code)) continue;
          if (it.close != null) closeMap.set(it.stock_code, it.close);
          if (it.slot_idx?.length) slotMap.set(it.stock_code, it.slot_idx);
        }
        setClosedPreClose(closeMap);
        setClosedPrevSlotIdx(slotMap);
      })
      .catch((e) => {
        if (cancelled) return;
        setClosedPreClose(new Map());
        setClosedPrevSlotIdx(new Map());
        setClosedPreCloseError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [prevDate, closedTodayCodes]);

  const rows: ContribRow[] = useMemo(() => {
    if (!prevTotalValue || prevTotalValue <= 0) return [];

    const baseRows: ContribRow[] = items.map((it) => {
      const exec = execAggByCode.get(it.stock_code) ?? { ...EMPTY_EXEC_AGG };
      const sharesToday = it.shares;
      const sharesPrev = sharesToday - exec.buy_shares + exec.sell_shares;
      const suspended = it.close == null || it.pre_close == null;

      // 全天持有的份额（昨持 − 当日已卖），用于 hold_pnl 的分母，避免与 sell_pnl 重复计提
      // 已卖出份额的盈亏完全由 sell_pnl = sell_amount − preClose × sell_shares 承担
      const sharesHeldThroughDay = sharesPrev - exec.sell_shares;
      let holdPnl = 0;
      let buyPnl = 0;
      let sellPnl = 0;
      if (!suspended) {
        const close = it.close as number;
        const preClose = it.pre_close as number;
        holdPnl = sharesHeldThroughDay * (close - preClose);
        buyPnl = close * exec.buy_shares - exec.buy_amount;
        sellPnl = exec.sell_amount - preClose * exec.sell_shares;
      }
      const totalPnl = holdPnl + buyPnl + sellPnl;

      return {
        stock_code: it.stock_code,
        slot_idx: it.slot_idx,
        shares: sharesToday,
        shares_prev: sharesPrev,
        close: it.close,
        pre_close: it.pre_close,
        change: it.change,
        pct_chg: it.pct_chg,
        is_suspended: suspended,
        is_realtime: !!it.is_realtime,
        is_intraday: false,
        hold_pnl: holdPnl,
        buy_pnl: buyPnl,
        sell_pnl: sellPnl,
        total_pnl: totalPnl,
        contribution_pct: 0,
        contribution_share: 0,
        exec,
      };
    });

    // 当日 holdings 里没有的股票，分两种子情况：
    //
    // (A) 昨日有持仓 → 当日全部卖出（含可能的加仓后再清）
    //     sharesPrev = sell − buy > 0；以昨日收盘 preClose 作为成本基准：
    //       hold_pnl = 0
    //       buy_pnl  = preClose × buy_shares − buy_amount
    //       sell_pnl = sell_amount − preClose × sell_shares
    //     若拿不到 preClose（前日 holdings/daily 缺失或停牌），退回 0 + Tag 提醒。
    //
    // (B) 昨日无持仓 → 当日开仓后又全部卖出（纯日内 round-trip）
    //     sharesPrev = sell − buy = 0；这种股票永远不会出现在前一交易日的 holdings/daily 里，
    //     因此拿不到 preClose 也不应该退回 0。它的真实 PnL 完全等于 sell_amount − buy_amount，
    //     与昨收无关。统一记为：
    //       hold_pnl = 0
    //       buy_pnl  = 0（按"以买入成本入账"的口径，买入瞬间无浮盈/浮亏）
    //       sell_pnl = sell_amount − buy_amount（卖出相对买入成本的实现 PnL）
    //     展示价用 vwap 代理：pre_close ← avg_buy，close ← avg_sell。
    //
    // (C) sharesPrev < 0 不应出现（无卖空），防御性归 0。
    const closedRows: ContribRow[] = closedTodayCodes.map((code) => {
      const exec = execAggByCode.get(code)!;
      const sharesPrev = exec.sell_shares - exec.buy_shares;
      const isIntraday = sharesPrev === 0 && exec.buy_shares > 0 && exec.sell_shares > 0;
      const avgBuyPrice =
        exec.buy_shares > 0 ? exec.buy_amount / exec.buy_shares : null;
      const avgSellPrice =
        exec.sell_shares > 0 ? exec.sell_amount / exec.sell_shares : null;

      let buyPnl = 0;
      let sellPnl = 0;
      let totalPnl = 0;
      let preClose: number | null = null;
      let closeProxy: number | null = null;

      if (isIntraday) {
        // 日内 round-trip：完全不依赖昨收，PnL = 卖出额 − 买入额
        sellPnl = exec.sell_amount - exec.buy_amount;
        totalPnl = sellPnl;
        preClose = avgBuyPrice;
        closeProxy = avgSellPrice;
      } else if (sharesPrev > 0) {
        // 昨日有持仓 → 全清
        preClose = closedPreClose.get(code) ?? null;
        closeProxy = avgSellPrice;
        if (preClose != null) {
          buyPnl = preClose * exec.buy_shares - exec.buy_amount;
          sellPnl = exec.sell_amount - preClose * exec.sell_shares;
          totalPnl = buyPnl + sellPnl;
        }
      }
      // sharesPrev < 0：不应到这里，保持全部 0

      const change =
        closeProxy != null && preClose != null ? closeProxy - preClose : null;
      const pctChg =
        change != null && preClose != null && preClose > 0
          ? (change / preClose) * 100
          : null;

      // 已清股票的 slot_idx 还原顺序：
      //   1) 优先取昨日 holdings/daily 里的 slot_idx（最权威，反映清仓前的实际归属）
      //   2) 退而求其次从当日 executions[].slot_idx 反推（intraday round-trip 必走这条；
      //      昨持→全清若昨日 holdings 拉取失败也会落到这条）
      //   3) 都拿不到则回退为 []，归入「未分配」桶
      const prevSlots = closedPrevSlotIdx.get(code);
      let slotIdx: number[] = prevSlots ?? [];
      if (!slotIdx.length) {
        const execs = execsByCode.get(code) ?? [];
        const seen = new Set<number>();
        for (const e of execs) {
          if (e.slot_idx != null && e.slot_idx >= 0 && !seen.has(e.slot_idx)) {
            seen.add(e.slot_idx);
            slotIdx.push(e.slot_idx);
          }
        }
        slotIdx.sort((a, b) => a - b);
      }

      return {
        stock_code: code,
        slot_idx: slotIdx,
        shares: 0,
        shares_prev: sharesPrev,
        close: closeProxy,
        pre_close: preClose,
        change,
        pct_chg: pctChg,
        is_suspended: false,
        is_realtime: false,
        is_intraday: isIntraday,
        hold_pnl: 0,
        buy_pnl: buyPnl,
        sell_pnl: sellPnl,
        total_pnl: totalPnl,
        contribution_pct: 0,
        contribution_share: 0,
        exec,
      };
    });

    const all = [...baseRows, ...closedRows];
    const totalDayPnl = all.reduce((acc, r) => acc + r.total_pnl, 0);
    for (const r of all) {
      r.contribution_pct = (r.total_pnl / prevTotalValue) * 100;
      r.contribution_share =
        Math.abs(totalDayPnl) > 1e-9 ? (r.total_pnl / totalDayPnl) * 100 : 0;
    }
    return all.sort((a, b) => b.contribution_pct - a.contribution_pct);
  }, [
    items,
    execAggByCode,
    execsByCode,
    closedTodayCodes,
    closedPreClose,
    closedPrevSlotIdx,
    prevTotalValue,
  ]);

  const summary = useMemo(() => {
    if (!rows.length) return null;
    const totalPnl = rows.reduce((acc, r) => acc + r.total_pnl, 0);
    const totalContribution = rows.reduce((acc, r) => acc + r.contribution_pct, 0);
    const positives = rows.filter((r) => r.total_pnl > 0);
    const negatives = rows.filter((r) => r.total_pnl < 0);
    const flats = rows.length - positives.length - negatives.length;
    const positiveSum = positives.reduce((a, r) => a + r.contribution_pct, 0);
    const negativeSum = negatives.reduce((a, r) => a + r.contribution_pct, 0);

    const tradedRows = rows.filter(
      (r) => r.exec.buy_count + r.exec.sell_count > 0
    );
    const totalCommission = tradedRows.reduce((a, r) => a + r.exec.total_commission, 0);
    const totalStampDuty = tradedRows.reduce((a, r) => a + r.exec.total_stamp_duty, 0);
    const totalSlippage = tradedRows.reduce((a, r) => a + r.exec.total_slippage, 0);
    const totalExecCost = tradedRows.reduce((a, r) => a + r.exec.total_exec_cost, 0);
    const totalBuyCount = tradedRows.reduce((a, r) => a + r.exec.buy_count, 0);
    const totalSellCount = tradedRows.reduce((a, r) => a + r.exec.sell_count, 0);

    return {
      totalPnl,
      totalContribution,
      positives: positives.length,
      negatives: negatives.length,
      flats,
      positiveSum,
      negativeSum,
      topGainer: rows[0],
      topLoser: rows[rows.length - 1],
      totalCommission,
      totalStampDuty,
      totalSlippage,
      totalExecCost,
      totalBuyCount,
      totalSellCount,
      tradedStocks: tradedRows.length,
    };
  }, [rows]);

  // 按槽位聚合：一只股票若同时挂在 N 个 slot，把 contribution / N 摊到每个 slot
  const slotRows = useMemo(() => {
    interface SlotMember {
      code: string;
      partial_pnl: number;
      partial_pct: number;
      slot_count: number;
    }
    interface SlotAgg {
      slot: number; // -1 表示「已清/未分配」
      total_pnl: number;
      contribution_pct: number;
      stock_count: number;
      buy_count: number;
      sell_count: number;
      total_exec_cost: number;
      members: SlotMember[];
    }
    const map = new Map<number, SlotAgg>();
    const ensure = (slot: number): SlotAgg => {
      let cur = map.get(slot);
      if (!cur) {
        cur = {
          slot,
          total_pnl: 0,
          contribution_pct: 0,
          stock_count: 0,
          buy_count: 0,
          sell_count: 0,
          total_exec_cost: 0,
          members: [],
        };
        map.set(slot, cur);
      }
      return cur;
    };
    for (const r of rows) {
      const slots = r.slot_idx.length ? r.slot_idx : [-1];
      const n = slots.length;
      const partialPnl = r.total_pnl / n;
      const partialPct = r.contribution_pct / n;
      // 交易笔数与成本按相同比例分摊
      const partialBuy = r.exec.buy_count / n;
      const partialSell = r.exec.sell_count / n;
      const partialCost = r.exec.total_exec_cost / n;
      for (const s of slots) {
        const agg = ensure(s);
        agg.total_pnl += partialPnl;
        agg.contribution_pct += partialPct;
        agg.stock_count += 1;
        agg.buy_count += partialBuy;
        agg.sell_count += partialSell;
        agg.total_exec_cost += partialCost;
        agg.members.push({
          code: r.stock_code,
          partial_pnl: partialPnl,
          partial_pct: partialPct,
          slot_count: n,
        });
      }
    }
    const arr = [...map.values()];
    for (const a of arr) {
      a.members.sort((x, y) => Math.abs(y.partial_pct) - Math.abs(x.partial_pct));
    }
    return arr.sort((a, b) => b.contribution_pct - a.contribution_pct);
  }, [rows]);

  const chartOptions = useMemo(() => {
    const buildStockOption = (
      subset: ContribRow[],
      color: string,
      isLoss = false
    ) => {
      if (!subset.length) return null;
      const initialWindow = 30;
      const sorted = [...subset].sort(
        (a, b) => Math.abs(b.contribution_pct) - Math.abs(a.contribution_pct)
      );
      const codes = sorted.map((r) => r.stock_code);
      const data = sorted.map((r) => ({
        value: Number(r.contribution_pct.toFixed(4)),
        itemStyle: { color },
      }));
      const needZoom = sorted.length > initialWindow;
      const endPercent = needZoom
        ? Math.min(100, (initialWindow / sorted.length) * 100)
        : 100;
      const { yMin, yMax } = computeAxisRange(data.map((d) => d.value));
      return {
        tooltip: {
          trigger: "axis" as const,
          confine: true,
          axisPointer: { type: "shadow" as const },
          formatter: (params: any) => {
            if (!Array.isArray(params) || !params.length) return "";
            const p = params[0];
            const r = sorted[p.dataIndex];
            if (!r) return "";
            const priceLabel = r.is_realtime ? "现价" : "收盘";
            const closeStr = r.close != null ? r.close.toFixed(2) : "—";
            const preCloseStr =
              r.pre_close != null ? r.pre_close.toFixed(2) : "—";
            const closeLine =
              r.shares === 0 && r.close == null
                ? `${priceLabel}: <span style="color:rgba(255,255,255,0.55)">— (已清仓)</span>`
                : `${priceLabel}: <b style="color:${pnlColor(
                    r.change ?? 0
                  )}">${closeStr}</b>`;
            const preCloseLine = `昨日收盘: <b>${preCloseStr}</b>`;
            const lines = [
              `<b>${r.stock_code}</b>${
                r.slot_idx.length ? ` · #${r.slot_idx.join(",")}` : ""
              }`,
              `贡献度: <b>${fmtPct(r.contribution_pct, 4)}</b>${
                Math.abs(r.contribution_share) > 0
                  ? `（占当日盈亏 ${fmtPct(r.contribution_share)}）`
                  : ""
              }`,
              `贡献金额: ${fmtMoney(r.total_pnl, 2)}`,
              r.is_suspended
                ? `状态: <span style="color:#faad14">停牌</span>`
                : `涨跌幅: ${fmtPct(r.pct_chg)}`,
              closeLine,
              preCloseLine,
              `持股: ${r.shares.toFixed(0)}`,
            ];
            if (r.exec.buy_count + r.exec.sell_count > 0) {
              const stockExecs = execsByCode.get(r.stock_code) ?? [];
              lines.push(
                `<div style="margin-top:4px;border-top:1px solid rgba(255,255,255,0.15);padding-top:4px">成交明细 · 买 <span style="color:${POS_COLOR}">${r.exec.buy_count}</span> / 卖 <span style="color:${NEG_COLOR}">${r.exec.sell_count}</span></div>`
              );
              const MAX_ROWS = 6;
              const shown = stockExecs.slice(0, MAX_ROWS);
              for (const e of shown) {
                const isBuy = e.action === "buy";
                const actionLabel = isBuy
                  ? `<span style="color:${POS_COLOR};font-weight:600">买入</span>`
                  : `<span style="color:${NEG_COLOR};font-weight:600">卖出</span>`;
                const amountLabel = isBuy ? "买入额" : "卖出额";
                lines.push(
                  `${actionLabel} ${e.shares.toFixed(
                    0
                  )} 股，${amountLabel}：<b>${fmtMoney(e.amount, 2)}</b>`
                );
              }
              if (stockExecs.length > MAX_ROWS) {
                lines.push(
                  `<span style="color:rgba(255,255,255,0.45)">…另 ${
                    stockExecs.length - MAX_ROWS
                  } 笔</span>`
                );
              }
              lines.push(
                `<span style="color:rgba(255,255,255,0.55)">买入额 ${fmtMoney(
                  r.exec.buy_amount,
                  0
                )} · 卖出额 ${fmtMoney(
                  r.exec.sell_amount,
                  0
                )} · 成本 ${fmtMoney(r.exec.total_exec_cost, 2)}</span>`
              );
            }
            return lines.join("<br/>");
          },
        },
        grid: isMobile
          ? {
              left: 56,
              right: 16,
              top: 36,
              bottom: needZoom ? 30 : 8,
              containLabel: true,
            }
          : {
              left: 64,
              right: 30,
              top: 40,
              bottom: needZoom ? 32 : 10,
              containLabel: true,
            },
        dataZoom: needZoom ? buildScrollDataZoom(endPercent) : undefined,
        xAxis: {
          type: "category" as const,
          data: codes,
          axisLabel: {
            rotate: isMobile ? 60 : 45,
            fontSize: isMobile ? 9 : 11,
            interval: 0,
          },
        },
        yAxis: {
          type: "value" as const,
          name: "贡献度 %",
          nameLocation: "end" as const,
          nameGap: 14,
          nameTextStyle: { fontSize: 11, color: "rgba(255,255,255,0.65)" },
          axisLabel: { formatter: (v: number) => v.toFixed(2) },
          min: yMin,
          max: yMax,
        },
        series: [
          {
            type: "bar",
            data,
            barMaxWidth: 24,
            label: {
              show: !isMobile,
              position: (isLoss ? "bottom" : "top") as "top" | "bottom",
              fontSize: 10,
              formatter: (p: any) => (p.value as number).toFixed(2),
            },
          },
        ],
      };
    };

    const buildSlotOption = (
      subset: typeof slotRows,
      color: string,
      isLoss = false
    ) => {
      if (!subset.length) return null;
      const sorted = [...subset].sort(
        (a, b) => Math.abs(b.contribution_pct) - Math.abs(a.contribution_pct)
      );
      const labels = sorted.map((s) => (s.slot < 0 ? "未分配" : `#${s.slot}`));
      const data = sorted.map((s) => ({
        value: Number(s.contribution_pct.toFixed(4)),
        itemStyle: { color },
      }));
      const initialSlotWindow = 30;
      const needZoom = sorted.length > initialSlotWindow;
      const endPercent = needZoom
        ? Math.min(100, (initialSlotWindow / sorted.length) * 100)
        : 100;
      const { yMin, yMax } = computeAxisRange(data.map((d) => d.value));
      return {
        tooltip: {
          trigger: "axis" as const,
          confine: true,
          axisPointer: { type: "shadow" as const },
          formatter: (params: any) => {
            if (!Array.isArray(params) || !params.length) return "";
            const p = params[0];
            const s = sorted[p.dataIndex];
            if (!s) return "";
            const head =
              s.slot < 0 ? `<b>未分配 / 已清</b>` : `<b>槽位 #${s.slot}</b>`;
            const lines = [
              head,
              `贡献度: <b>${fmtPct(s.contribution_pct, 4)}</b>`,
              `贡献金额: ${fmtMoney(s.total_pnl, 2)}`,
              `成员: ${s.stock_count} 只`,
            ];
            if (s.buy_count + s.sell_count > 0) {
              lines.push(
                `成交: 买 ${s.buy_count.toFixed(1)} / 卖 ${s.sell_count.toFixed(
                  1
                )}，成本 ${fmtMoney(s.total_exec_cost, 2)}`
              );
            }
            if (s.members.length) {
              lines.push(
                `<div style="margin-top:4px;border-top:1px solid rgba(255,255,255,0.15);padding-top:4px">成员贡献:</div>` +
                  s.members
                    .map((m) => {
                      const c = m.partial_pct >= 0 ? POS_COLOR : NEG_COLOR;
                      const split =
                        m.slot_count > 1
                          ? ` <span style="color:rgba(255,255,255,0.45)">(1/${m.slot_count})</span>`
                          : "";
                      const ag = execAggByCode.get(m.code);
                      const tradeStr =
                        ag && ag.buy_count + ag.sell_count > 0
                          ? ` <span style="color:rgba(255,255,255,0.45)">[买${ag.buy_count}/卖${ag.sell_count}]</span>`
                          : "";
                      return `${m.code}${split}: <span style="color:${c}">${fmtPct(
                        m.partial_pct,
                        4
                      )}</span>${tradeStr}`;
                    })
                    .join("<br/>")
              );
            }
            return lines.join("<br/>");
          },
        },
        grid: isMobile
          ? {
              left: 56,
              right: 16,
              top: 36,
              bottom: needZoom ? 26 : 8,
              containLabel: true,
            }
          : {
              left: 64,
              right: 30,
              top: 40,
              bottom: needZoom ? 28 : 10,
              containLabel: true,
            },
        dataZoom: needZoom ? buildScrollDataZoom(endPercent) : undefined,
        xAxis: {
          type: "category" as const,
          data: labels,
          axisLabel: {
            rotate: 0,
            fontSize: isMobile ? 10 : 12,
            interval: 0,
          },
        },
        yAxis: {
          type: "value" as const,
          name: "贡献度 %",
          nameLocation: "end" as const,
          nameGap: 14,
          nameTextStyle: { fontSize: 11, color: "rgba(255,255,255,0.65)" },
          axisLabel: { formatter: (v: number) => v.toFixed(2) },
          min: yMin,
          max: yMax,
        },
        series: [
          {
            type: "bar",
            data,
            barMaxWidth: 32,
            label: {
              show: true,
              position: (isLoss ? "bottom" : "top") as "top" | "bottom",
              fontSize: isMobile ? 9 : 10,
              formatter: (p: any) => (p.value as number).toFixed(2),
            },
          },
        ],
      };
    };

    if (chartMode === "slot") {
      const positives = slotRows.filter((s) => s.contribution_pct > 0);
      const negatives = slotRows.filter((s) => s.contribution_pct < 0);
      return {
        gain: buildSlotOption(positives, POS_COLOR),
        loss: buildSlotOption(negatives, NEG_COLOR, true),
      };
    }

    const positives = rows.filter((r) => r.contribution_pct > 0);
    const negatives = rows.filter((r) => r.contribution_pct < 0);
    return {
      gain: buildStockOption(positives, POS_COLOR),
      loss: buildStockOption(negatives, NEG_COLOR, true),
    };
  }, [rows, slotRows, chartMode, isMobile, execsByCode, execAggByCode]);

  const dateOptions = useMemo(
    () =>
      [...navData]
        .sort((a, b) => b.date.localeCompare(a.date))
        .map((n) => ({ value: n.date, label: n.date })),
    [navData]
  );

  // 选中日期 = 本地"今天"时，明细表的"收盘"列展示为"现价"（盘中实时价）
  const isToday = useMemo(() => {
    if (!selectedDate) return false;
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return selectedDate === `${y}-${m}-${day}`;
  }, [selectedDate]);

  const renderSlots = (slots: number[]) => {
    if (!slots.length) return <span style={{ color: "rgba(255,255,255,0.45)" }}>—</span>;
    return (
      <span>
        {slots.map((s) => (
          <Tag color="blue" key={s} style={{ marginRight: 2 }}>#{s}</Tag>
        ))}
      </span>
    );
  };

  const columns = [
    {
      title: "股票代码",
      dataIndex: "stock_code",
      key: "stock_code",
      fixed: "left" as const,
      width: 130,
      render: (v: string, r: ContribRow) => (
        <span>
          {v}
          {r.is_suspended && (
            <Tooltip title="停牌，无行情">
              <Tag color="default" style={{ marginLeft: 4 }}>停牌</Tag>
            </Tooltip>
          )}
        </span>
      ),
    },
    {
      title: "槽位",
      dataIndex: "slot_idx",
      key: "slot_idx",
      width: 110,
      render: renderSlots,
    },
    {
      title: "方向",
      key: "trade_action",
      width: 120,
      render: (_: unknown, r: ContribRow) => {
        const buy = r.exec.buy_count > 0;
        const sell = r.exec.sell_count > 0;
        if (!buy && !sell) {
          return <span style={{ color: "rgba(255,255,255,0.45)" }}>—</span>;
        }
        return (
          <span>
            {buy && (
              <Tooltip
                title={`买入 ${r.exec.buy_count} 笔，共 ${r.exec.buy_shares.toFixed(
                  0
                )} 股 / ${fmtMoney(r.exec.buy_amount, 2)}`}
              >
                <Tag color="green" style={{ marginRight: 2 }}>
                  买入{r.exec.buy_count > 1 ? `×${r.exec.buy_count}` : ""}
                </Tag>
              </Tooltip>
            )}
            {sell && (
              <Tooltip
                title={`卖出 ${r.exec.sell_count} 笔，共 ${r.exec.sell_shares.toFixed(
                  0
                )} 股 / ${fmtMoney(r.exec.sell_amount, 2)}`}
              >
                <Tag color="red" style={{ marginRight: 2 }}>
                  卖出{r.exec.sell_count > 1 ? `×${r.exec.sell_count}` : ""}
                </Tag>
              </Tooltip>
            )}
          </span>
        );
      },
    },
    {
      title: "贡献度",
      dataIndex: "contribution_pct",
      key: "contribution_pct",
      width: 130,
      render: (v: number) => (
        <span style={{ color: pnlColor(v), fontWeight: 600 }}>{fmtPct(v, 4)}</span>
      ),
    },
    {
      title: "贡献金额",
      dataIndex: "total_pnl",
      key: "total_pnl",
      width: 140,
      render: (v: number, r: ContribRow) => {
        const isClosed = r.shares === 0;
        const noPreClose = isClosed && !r.is_intraday && r.pre_close == null;
        const tip = noPreClose ? (
          <div style={{ lineHeight: 1.6 }}>
            <div>已清仓，前一交易日无收盘数据，无法精确归因</div>
            <div style={{ color: "rgba(255,255,255,0.45)" }}>
              卖出 ¥{r.exec.sell_amount.toFixed(2)} − 买入 ¥
              {r.exec.buy_amount.toFixed(2)}（仅供参考，未反映真实盈亏）
            </div>
          </div>
        ) : r.is_intraday ? (
          <div style={{ lineHeight: 1.6 }}>
            <div style={{ marginBottom: 4 }}>
              日内开仓平仓（昨日无持仓），按买入成本作为基准：
            </div>
            <div>
              实现盈亏: <b>{fmtMoney(r.sell_pnl, 2)}</b>
              <span style={{ color: "rgba(255,255,255,0.45)", marginLeft: 6 }}>
                = 卖出 {fmtMoney(r.exec.sell_amount, 2)} − 买入{" "}
                {fmtMoney(r.exec.buy_amount, 2)}
              </span>
            </div>
            <div style={{ color: "rgba(255,255,255,0.45)" }}>
              均价 买入 {r.pre_close?.toFixed(2) ?? "—"} → 卖出{" "}
              {r.close?.toFixed(2) ?? "—"}（{r.exec.buy_shares.toFixed(0)} 股 ×{" "}
              {r.exec.buy_count} 笔买 / {r.exec.sell_count} 笔卖）
            </div>
          </div>
        ) : isClosed ? (
          <div style={{ lineHeight: 1.6 }}>
            <div style={{ marginBottom: 4 }}>
              已清仓，按昨日收盘 <b>{r.pre_close?.toFixed(2)}</b> 作为成本基准：
            </div>
            <div>
              买入盈亏: <b>{fmtMoney(r.buy_pnl, 2)}</b>
              <span style={{ color: "rgba(255,255,255,0.45)", marginLeft: 6 }}>
                = {r.pre_close?.toFixed(2)}×{r.exec.buy_shares.toFixed(0)} −{" "}
                {fmtMoney(r.exec.buy_amount, 2)}
              </span>
            </div>
            <div>
              卖出盈亏: <b>{fmtMoney(r.sell_pnl, 2)}</b>
              <span style={{ color: "rgba(255,255,255,0.45)", marginLeft: 6 }}>
                = {fmtMoney(r.exec.sell_amount, 2)} − {r.pre_close?.toFixed(2)}×
                {r.exec.sell_shares.toFixed(0)}
              </span>
            </div>
          </div>
        ) : (
          (() => {
            const sharesHeldThroughDay = r.shares_prev - r.exec.sell_shares;
            return (
              <div style={{ lineHeight: 1.6 }}>
                <div>
                  持仓盈亏: <b>{fmtMoney(r.hold_pnl, 2)}</b>
                  <span style={{ color: "rgba(255,255,255,0.45)", marginLeft: 6 }}>
                    = {sharesHeldThroughDay.toFixed(0)} ×{" "}
                    ({r.close ?? "—"} − {r.pre_close ?? "—"})
                    {r.exec.sell_shares > 0 && (
                      <span style={{ marginLeft: 4 }}>
                        （全天持有 = 昨持 {r.shares_prev.toFixed(0)} − 当日卖出{" "}
                        {r.exec.sell_shares.toFixed(0)}）
                      </span>
                    )}
                  </span>
                </div>
                <div>
                  买入盈亏: <b>{fmtMoney(r.buy_pnl, 2)}</b>
                  <span style={{ color: "rgba(255,255,255,0.45)", marginLeft: 6 }}>
                    = {isToday ? "现价" : "收盘"}×{r.exec.buy_shares.toFixed(0)} −{" "}
                    {fmtMoney(r.exec.buy_amount, 2)}
                  </span>
                </div>
                <div>
                  卖出盈亏: <b>{fmtMoney(r.sell_pnl, 2)}</b>
                  <span style={{ color: "rgba(255,255,255,0.45)", marginLeft: 6 }}>
                    = {fmtMoney(r.exec.sell_amount, 2)} − 昨日收盘×
                    {r.exec.sell_shares.toFixed(0)}
                  </span>
                </div>
              </div>
            );
          })()
        );
        return (
          <Tooltip title={tip}>
            <span
              style={{
                color: noPreClose ? "rgba(255,255,255,0.45)" : pnlColor(v),
                cursor: "help",
                fontStyle: noPreClose ? "italic" : undefined,
              }}
            >
              {noPreClose ? "—" : fmtMoney(v, 2)}
            </span>
          </Tooltip>
        );
      },
    },
    {
      title: "涨跌幅",
      dataIndex: "pct_chg",
      key: "pct_chg",
      width: 100,
      render: (v: number | null, r: ContribRow) => {
        if (v == null) return <span style={{ color: "rgba(255,255,255,0.45)" }}>—</span>;
        return (
          <ClosedProxyCell proxy={r.shares === 0} title={proxyTipFor(r)}>
            <span style={{ color: pnlColor(v) }}>{fmtPct(v)}</span>
          </ClosedProxyCell>
        );
      },
    },
    {
      title: "涨跌额",
      dataIndex: "change",
      key: "change",
      width: 100,
      render: (v: number | null, r: ContribRow) => {
        if (v == null) return "—";
        return (
          <ClosedProxyCell proxy={r.shares === 0} title={proxyTipFor(r)}>
            <span style={{ color: pnlColor(v) }}>
              {(v >= 0 ? "+" : "") + v.toFixed(2)}
            </span>
          </ClosedProxyCell>
        );
      },
    },
    {
      title: isToday ? "现价" : "收盘",
      dataIndex: "close",
      key: "close",
      width: 90,
      render: (v: number | null, r: ContribRow) => {
        if (v == null) return "—";
        const closeTitle = r.is_intraday
          ? `日内卖出均价 = ¥${r.exec.sell_amount.toFixed(2)} ÷ ${r.exec.sell_shares.toFixed(
              0
            )} 股`
          : `已清仓，显示为卖出成交均价 = ¥${r.exec.sell_amount.toFixed(
              2
            )} ÷ ${r.exec.sell_shares.toFixed(0)} 股`;
        return (
          <ClosedProxyCell
            proxy={r.shares === 0}
            title={closeTitle}
          >
            <span>{v.toFixed(2)}</span>
          </ClosedProxyCell>
        );
      },
    },
    {
      title: "昨日收盘",
      dataIndex: "pre_close",
      key: "pre_close",
      width: 90,
      render: (v: number | null) => (v == null ? "—" : v.toFixed(2)),
    },
    {
      title: () => (
        <span>
          持股{" "}
          <Tooltip title="收盘后持股 / 开盘前持股">
            <InfoCircleOutlined style={{ color: "rgba(255,255,255,0.45)" }} />
          </Tooltip>
        </span>
      ),
      key: "shares",
      width: 130,
      render: (_: unknown, r: ContribRow) => (
        <span>
          {r.shares.toFixed(0)}
          <span style={{ color: "rgba(255,255,255,0.45)", marginLeft: 4 }}>
            / {r.shares_prev.toFixed(0)}
          </span>
        </span>
      ),
    },
  ];

  const mobileColumns = [
    {
      title: "股票",
      dataIndex: "stock_code",
      key: "stock_code",
      fixed: "left" as const,
      width: 110,
      render: (v: string, r: ContribRow) => {
        const buy = r.exec.buy_count > 0;
        const sell = r.exec.sell_count > 0;
        return (
          <div style={{ lineHeight: 1.3 }}>
            <div style={{ fontWeight: 600 }}>{v}</div>
            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.45)" }}>
              {r.slot_idx.length ? `#${r.slot_idx.join(",")}` : "—"}
              {r.is_suspended && " · 停牌"}
            </div>
            {(buy || sell) && (
              <div style={{ marginTop: 2 }}>
                {buy && (
                  <Tag
                    color="green"
                    style={{ marginRight: 2, fontSize: 10, lineHeight: "16px", padding: "0 4px" }}
                  >
                    买{r.exec.buy_count > 1 ? r.exec.buy_count : ""}
                  </Tag>
                )}
                {sell && (
                  <Tag
                    color="red"
                    style={{ marginRight: 2, fontSize: 10, lineHeight: "16px", padding: "0 4px" }}
                  >
                    卖{r.exec.sell_count > 1 ? r.exec.sell_count : ""}
                  </Tag>
                )}
              </div>
            )}
          </div>
        );
      },
    },
    {
      title: "贡献度",
      dataIndex: "contribution_pct",
      key: "contribution_pct",
      width: 110,
      render: (v: number) => (
        <span style={{ color: pnlColor(v), fontWeight: 600 }}>{fmtPct(v, 4)}</span>
      ),
    },
    {
      title: "涨跌幅",
      dataIndex: "pct_chg",
      key: "pct_chg",
      width: 80,
      render: (v: number | null, r: ContribRow) => {
        if (v == null) return <span style={{ color: "rgba(255,255,255,0.45)" }}>—</span>;
        return (
          <ClosedProxyCell proxy={r.shares === 0} title={proxyTipFor(r)}>
            <span style={{ color: pnlColor(v) }}>{fmtPct(v)}</span>
          </ClosedProxyCell>
        );
      },
    },
    {
      title: "贡献金额",
      dataIndex: "total_pnl",
      key: "total_pnl",
      width: 110,
      render: (v: number) => <span style={{ color: pnlColor(v) }}>{fmtMoney(v, 0)}</span>,
    },
  ];

  if (navLoading) {
    return <Spin size="large" style={{ display: "block", margin: "100px auto" }} />;
  }
  if (navError) return <Alert type="error" message={navError} />;

  const dateSelector = (
    <Select
      value={selectedDate || undefined}
      onChange={setSelectedDate}
      options={dateOptions}
      style={{ width: isMobile ? 140 : 180 }}
      placeholder="选择交易日"
      showSearch
      size={isMobile ? "small" : "middle"}
    />
  );

  const summaryCards = summary && (
    <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
      <Col xs={12} sm={6}>
        <Card size={isMobile ? "small" : "default"}>
          <Statistic
            title="组合涨跌"
            value={dayReturnPct ?? 0}
            precision={2}
            suffix="%"
            valueStyle={{ color: pnlColor(dayReturnPct ?? 0) }}
            prefix={(dayReturnPct ?? 0) >= 0 ? <ArrowUpOutlined /> : <ArrowDownOutlined />}
          />
          <div
            style={{
              marginTop: 4,
              fontSize: 11,
              color: "rgba(255,255,255,0.45)",
              lineHeight: 1.6,
            }}
          >
            <div>
              {prevDate ? prevDate.slice(5) : "前一日"} 总资产{" "}
              {prevTotalValue != null ? fmtMoney(prevTotalValue, 0) : "—"}
            </div>
            {todayTotalValue != null && (
              <div style={{ marginTop: 10 }}>
                {selectedDate ? selectedDate.slice(5) : "今日"} 总资产{" "}
                {fmtMoney(todayTotalValue, 0)}
              </div>
            )}
          </div>
        </Card>
      </Col>
      <Col xs={12} sm={6}>
        <Card size={isMobile ? "small" : "default"}>
          <Statistic
            title={
              <span>
                持仓贡献合计{" "}
                <Tooltip title="所有股票盈亏之和。若与「组合涨跌 × 前一交易日总资产」存在差额，通常来自现金/非持仓项变动或除权调整误差。">
                  <InfoCircleOutlined style={{ color: "rgba(255,255,255,0.45)" }} />
                </Tooltip>
              </span>
            }
            value={summary.totalPnl}
            precision={0}
            prefix="¥"
            valueStyle={{ color: pnlColor(summary.totalPnl) }}
          />
          {!isMobile && (
            <div style={{ marginTop: 4, fontSize: 11, color: "rgba(255,255,255,0.45)" }}>
              贡献度合计 {fmtPct(summary.totalContribution)}
            </div>
          )}
        </Card>
      </Col>
      <Col xs={12} sm={6}>
        <Card size={isMobile ? "small" : "default"}>
          <Statistic
            title="正/负贡献"
            value={`${summary.positives} / ${summary.negatives}`}
            valueStyle={{ fontSize: isMobile ? 18 : 22 }}
          />
          {!isMobile && (
            <div style={{ marginTop: 4, fontSize: 11, color: "rgba(255,255,255,0.45)" }}>
              <span style={{ color: POS_COLOR }}>+{summary.positiveSum.toFixed(2)}%</span>{" "}
              <span style={{ color: NEG_COLOR }}>{summary.negativeSum.toFixed(2)}%</span>
              {summary.flats > 0 && ` · 持平 ${summary.flats}`}
            </div>
          )}
        </Card>
      </Col>
      <Col xs={12} sm={6}>
        <Card size={isMobile ? "small" : "default"} styles={{ body: { padding: isMobile ? 12 : 24 } }}>
          {summary.topGainer && summary.topGainer.contribution_pct > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <RiseOutlined style={{ color: POS_COLOR }} />
              <div>
                <div style={{ fontSize: 11, color: "rgba(255,255,255,0.45)" }}>最大正贡献</div>
                <div style={{ fontSize: isMobile ? 13 : 15, fontWeight: 600 }}>
                  {summary.topGainer.stock_code}{" "}
                  <span style={{ color: POS_COLOR }}>
                    {fmtPct(summary.topGainer.contribution_pct)}
                  </span>
                </div>
              </div>
            </div>
          )}
          {summary.topLoser && summary.topLoser.contribution_pct < 0 && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginTop:
                  summary.topGainer && summary.topGainer.contribution_pct > 0 ? 6 : 0,
              }}
            >
              <FallOutlined style={{ color: NEG_COLOR }} />
              <div>
                <div style={{ fontSize: 11, color: "rgba(255,255,255,0.45)" }}>最大负贡献</div>
                <div style={{ fontSize: isMobile ? 13 : 15, fontWeight: 600 }}>
                  {summary.topLoser.stock_code}{" "}
                  <span style={{ color: NEG_COLOR }}>
                    {fmtPct(summary.topLoser.contribution_pct)}
                  </span>
                </div>
              </div>
            </div>
          )}
        </Card>
      </Col>
    </Row>
  );

  const execCards = summary && (
    <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
      <Col xs={24} sm={12}>
        <Card size={isMobile ? "small" : "default"}>
          <Statistic
            title="交易成本"
            value={summary.totalExecCost}
            precision={2}
            prefix="¥"
            valueStyle={{ color: "#faad14" }}
          />
          {!isMobile && (
            <div style={{ marginTop: 4, fontSize: 11, color: "rgba(255,255,255,0.45)" }}>
              佣金 ¥{summary.totalCommission.toFixed(2)} · 印花税 ¥
              {summary.totalStampDuty.toFixed(2)} · 滑点 ¥
              {summary.totalSlippage.toFixed(2)}
            </div>
          )}
        </Card>
      </Col>
      <Col xs={24} sm={12}>
        <Card size={isMobile ? "small" : "default"}>
          <Statistic
            title="交易笔数"
            value={`${summary.totalBuyCount + summary.totalSellCount}`}
            valueStyle={{ fontSize: isMobile ? 18 : 22 }}
          />
          {!isMobile && (
            <div style={{ marginTop: 4, fontSize: 11, color: "rgba(255,255,255,0.45)" }}>
              <span style={{ color: POS_COLOR }}>买 {summary.totalBuyCount}</span> ·{" "}
              <span style={{ color: NEG_COLOR }}>卖 {summary.totalSellCount}</span>
              {` · 涉及 ${summary.tradedStocks} 只股票`}
            </div>
          )}
        </Card>
      </Col>
    </Row>
  );

  return (
    <div>
      {dayError && (
        <Alert
          type="error"
          message={`持仓日线加载失败：${dayError}`}
          style={{ marginBottom: 12 }}
          showIcon
          closable
        />
      )}
      {execError && (
        <Alert
          type="warning"
          message={`交割单加载失败：${execError}（不影响持仓贡献部分）`}
          style={{ marginBottom: 12 }}
          showIcon
          closable
        />
      )}
      {closedPreCloseError && (
        <Alert
          type="warning"
          message={`已清股票的昨日收盘拉取失败：${closedPreCloseError}（其贡献度暂计为 0）`}
          style={{ marginBottom: 12 }}
          showIcon
          closable
        />
      )}
      {prevTotalValue == null && !dayLoading && (
        <Alert
          type="warning"
          message="无法确定前一交易日总资产（nav 缺失上一交易日数据），暂无法计算贡献度。"
          style={{ marginBottom: 12 }}
          showIcon
        />
      )}

      <Card
        title={
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              flexWrap: "wrap",
            }}
          >
            <span>{isMobile ? "贡献度" : "涨跌贡献度"}</span>
            {dateSelector}
          </div>
        }
        size={isMobile ? "small" : "default"}
        styles={{ body: { padding: isMobile ? 8 : 24 } }}
      >
        {dayLoading ? (
          <Spin style={{ display: "block", margin: "60px auto" }} />
        ) : rows.length === 0 ? (
          <Empty description={`${selectedDate || "—"} 无可计算数据`} />
        ) : (
          <>
            {summaryCards}
            {(executions.length > 0 || summary?.totalExecCost) ? execCards : null}
            <Card
              size="small"
              title={
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    flexWrap: "wrap",
                    gap: 8,
                  }}
                >
                  <span>贡献度排行</span>
                  <Segmented
                    size={isMobile ? "small" : "middle"}
                    value={chartMode}
                    onChange={(v) => setChartMode(v as "stock" | "slot")}
                    options={[
                      { label: "按个股", value: "stock" },
                      { label: "按槽位", value: "slot" },
                    ]}
                  />
                </div>
              }
              style={{ marginBottom: 12 }}
              styles={{ body: { padding: isMobile ? 4 : 12 } }}
            >
              {chartOptions.gain || chartOptions.loss ? (
                <div>
                  <div
                    style={{
                      fontSize: 12,
                      color: POS_COLOR,
                      marginBottom: 4,
                      paddingLeft: 8,
                    }}
                  >
                    <RiseOutlined style={{ marginRight: 4 }} />
                    正贡献（涨）
                  </div>
                  {chartOptions.gain ? (
                    <ReactECharts
                      option={chartOptions.gain}
                      style={{ height: isMobile ? 240 : 320 }}
                      notMerge
                    />
                  ) : (
                    <Empty
                      description="无正贡献"
                      style={{ padding: isMobile ? 30 : 60 }}
                    />
                  )}
                  <div
                    style={{
                      fontSize: 12,
                      color: NEG_COLOR,
                      marginTop: 16,
                      marginBottom: 4,
                      paddingLeft: 8,
                    }}
                  >
                    <FallOutlined style={{ marginRight: 4 }} />
                    负贡献（跌）
                  </div>
                  {chartOptions.loss ? (
                    <ReactECharts
                      option={chartOptions.loss}
                      style={{ height: isMobile ? 240 : 320 }}
                      notMerge
                    />
                  ) : (
                    <Empty
                      description="无负贡献"
                      style={{ padding: isMobile ? 30 : 60 }}
                    />
                  )}
                </div>
              ) : (
                <Empty />
              )}
            </Card>
            {(() => {
              const sortedRows = [...rows].sort((a, b) =>
                detailSort === "desc"
                  ? b.contribution_pct - a.contribution_pct
                  : a.contribution_pct - b.contribution_pct
              );
              return (
                <Card
                  size="small"
                  title={
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        flexWrap: "wrap",
                        gap: 8,
                      }}
                    >
                      <span style={{ fontSize: isMobile ? 13 : 14 }}>
                        个股贡献度明细
                      </span>
                      <Segmented
                        size={isMobile ? "small" : "middle"}
                        value={detailSort}
                        onChange={(v) => setDetailSort(v as "desc" | "asc")}
                        options={[
                          {
                            label: (
                              <span style={{ color: POS_COLOR }}>涨</span>
                            ),
                            value: "desc",
                          },
                          {
                            label: (
                              <span style={{ color: NEG_COLOR }}>跌</span>
                            ),
                            value: "asc",
                          },
                        ]}
                      />
                    </div>
                  }
                  styles={{ body: { padding: 0 } }}
                >
                  {sortedRows.length ? (
                    <Table
                      dataSource={sortedRows}
                      columns={isMobile ? mobileColumns : columns}
                      rowKey="stock_code"
                      size="small"
                      pagination={{
                        defaultPageSize: 20,
                        showSizeChanger: !isMobile,
                        pageSizeOptions: ["20", "50", "100"],
                        size: isMobile ? "small" : undefined,
                        showTotal: (total) => `共 ${total} 只`,
                      }}
                      scroll={{ x: isMobile ? 440 : 1300 }}
                    />
                  ) : (
                    <Empty
                      description="暂无数据"
                      style={{ padding: isMobile ? 30 : 60 }}
                    />
                  )}
                </Card>
              );
            })()}
          </>
        )}
      </Card>
    </div>
  );
}
