import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
  DatePicker,
  Segmented,
  Space,
} from "antd";
import {
  ArrowUpOutlined,
  ArrowDownOutlined,
  InfoCircleOutlined,
  RiseOutlined,
  FallOutlined,
} from "@ant-design/icons";
import ReactECharts from "echarts-for-react";
import dayjs, { type Dayjs } from "dayjs";
import { api } from "../utils/api";
import useIsMobile from "../hooks/useIsMobile";
import type {
  NavPoint,
  Execution,
  HoldingsDailyItem,
  HoldingsDailyResponse,
} from "../types";

const POS_COLOR = "#3f8600";
const NEG_COLOR = "#cf1322";

// 区间最大允许天数。每个交易日要拉一次 holdings/daily，超过此值会拒绝拉取以保护 API。
const MAX_TRADING_DAYS = 90;
// 默认窗口：最近 N 个交易日
const DEFAULT_WINDOW = 5;
// holdings/daily 并发拉取上限
const MAX_CONCURRENT_DAILY = 6;
// executions 翻页并发上限
const MAX_CONCURRENT_EXEC_PAGES = 6;

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

function addExec(target: ExecAgg, e: Execution) {
  if (e.action === "buy") {
    target.buy_count += 1;
    target.buy_shares += e.shares;
    target.buy_amount += e.amount;
  } else {
    target.sell_count += 1;
    target.sell_shares += e.shares;
    target.sell_amount += e.amount;
  }
  target.total_commission += e.commission;
  target.total_stamp_duty += e.stamp_duty;
  target.total_slippage += e.slippage;
  target.total_exec_cost += e.total_cost;
}

function mergeExec(target: ExecAgg, src: ExecAgg) {
  target.buy_count += src.buy_count;
  target.sell_count += src.sell_count;
  target.buy_shares += src.buy_shares;
  target.sell_shares += src.sell_shares;
  target.buy_amount += src.buy_amount;
  target.sell_amount += src.sell_amount;
  target.total_commission += src.total_commission;
  target.total_stamp_duty += src.total_stamp_duty;
  target.total_slippage += src.total_slippage;
  target.total_exec_cost += src.total_exec_cost;
}

interface PeriodRow {
  stock_code: string;
  // 结束日所在槽位（若结束日已不持仓，则取最后一次出现在 items 中的那一天的槽位）
  latest_slot_idx: number[];
  // 区间结束日是否仍持仓
  held_at_end: boolean;
  // 结束日持股 / 区间起始日开盘前持股
  shares_end: number;
  shares_start_prev: number;
  // 区间内首次出现的 pre_close（用于估算「区间收盘涨跌幅」）
  first_pre_close: number | null;
  // 区间内末次出现的 close（若结束日已清仓，回退为最后一笔卖出均价）
  last_close: number | null;
  // 拆分盈亏
  hold_pnl: number;
  buy_pnl: number;
  sell_pnl: number;
  total_pnl: number;
  // 累加每日 contribution_pct
  contribution_pct: number;
  contribution_share: number;
  exec: ExecAgg;
  // 区间内活跃天数（持仓或当日有交易）
  active_days: number;
  // 当日缺 pre_close 兜底为 0 的天数
  missing_pre_close_days: number;
  // 是否含停牌天
  has_suspended_day: boolean;
  // 区间内有任意一天数据来自实时
  has_realtime: boolean;
  // 区间内是否发生过「日内开仓 + 当日清仓」的 round-trip
  // （昨日无持仓 + 当日 buy 后又全部 sell；走 sell_amount − buy_amount 口径，不依赖昨收）
  has_intraday_day: boolean;
  // true = 该股票在区间起始日开盘前未持仓（中途新建仓）
  inception_mid_period: boolean;
  // 区间内最后一次出现在 holdings/items 中的日期（用于「已清」展示清仓时点）
  last_appearance_date: string | null;
}

function fmtMoney(v: number, digits = 0) {
  if (!Number.isFinite(v)) return "—";
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

// 「区间内交易」列 Tag 的 Tooltip：表头汇总 + 每笔交易明细（清晰字段，无省略）
function renderExecListTooltip(
  side: "buy" | "sell",
  list: Execution[],
  count: number,
  shares: number,
  amount: number
) {
  const sideLabel = side === "buy" ? "买入" : "卖出";
  const totalCost = list.reduce((acc, e) => acc + e.total_cost, 0);
  const muted = "rgba(255,255,255,0.55)";
  return (
    <div style={{ lineHeight: 1.6, minWidth: 240 }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>
        区间{sideLabel}汇总
      </div>
      <div style={{ fontSize: 12 }}>
        <div>
          <span style={{ color: muted }}>笔数：</span>
          {count} 笔
        </div>
        <div>
          <span style={{ color: muted }}>累计股数：</span>
          {shares.toFixed(0)} 股
        </div>
        <div>
          <span style={{ color: muted }}>累计交易额：</span>
          {fmtMoney(amount, 2)}
        </div>
        <div>
          <span style={{ color: muted }}>累计交易成本：</span>
          {fmtMoney(totalCost, 2)}
        </div>
      </div>
      <div
        style={{
          marginTop: 6,
          paddingTop: 4,
          borderTop: "1px solid rgba(255,255,255,0.15)",
          fontWeight: 600,
        }}
      >
        逐笔明细
      </div>
      {list.map((e) => (
        <div
          key={e.id}
          style={{
            fontSize: 12,
            marginTop: 4,
            paddingTop: 4,
            borderTop: "1px dashed rgba(255,255,255,0.08)",
          }}
        >
          <div>
            <span style={{ color: muted }}>日期：</span>
            {e.exec_date}
          </div>
          <div>
            <span style={{ color: muted }}>股数：</span>
            {e.shares.toFixed(0)} 股
            <span style={{ color: muted, marginLeft: 8 }}>成交价：</span>
            {e.exec_price.toFixed(2)}
          </div>
          <div>
            <span style={{ color: muted }}>交易额：</span>
            {fmtMoney(e.amount, 2)}
          </div>
          <div>
            <span style={{ color: muted }}>交易成本：</span>
            {fmtMoney(e.total_cost, 2)}
            <span style={{ color: muted, marginLeft: 8 }}>
              （佣金 {fmtMoney(e.commission, 2)} + 印花税{" "}
              {fmtMoney(e.stamp_duty, 2)} + 滑点 {fmtMoney(e.slippage, 2)}）
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

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

function computeAxisRange(values: number[]) {
  const rawMin = Math.min(0, ...values);
  const rawMax = Math.max(0, ...values);
  const span = rawMax - rawMin || 1;
  const pad = span * 0.1;
  const yMin = rawMin < 0 ? Number((rawMin - pad).toFixed(4)) : 0;
  const yMax = rawMax > 0 ? Number((rawMax + pad).toFixed(4)) : 0;
  return { yMin, yMax };
}

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

const CLOSED_PROXY_TIP = "结束日已不持仓，收盘/涨跌幅按「区间内最后一次卖出成交均价相对区间起始价」推算";

// 拉取指定日期范围内的全部 executions（自动翻页，受限并发）
async function fetchExecutionsInRange(
  start: string,
  end: string,
  signal?: { cancelled: boolean }
): Promise<Execution[]> {
  const PAGE_SIZE = 100;
  const baseQuery = { start_date: start, end_date: end };
  const first = await api.executions({ ...baseQuery, page: 1, size: PAGE_SIZE });
  if (signal?.cancelled) return [];
  if (first.pages <= 1) return first.executions;

  const pages = Array.from({ length: first.pages - 1 }, (_, i) => i + 2);
  const results: Execution[][] = new Array(pages.length);
  let idx = 0;
  async function worker() {
    while (idx < pages.length) {
      if (signal?.cancelled) return;
      const i = idx++;
      const r = await api.executions({
        ...baseQuery,
        page: pages[i],
        size: PAGE_SIZE,
      });
      if (signal?.cancelled) return;
      results[i] = r.executions;
    }
  }
  const workerCount = Math.min(MAX_CONCURRENT_EXEC_PAGES, pages.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return first.executions.concat(...results.filter(Boolean));
}

// 受限并发拉取多个交易日的 holdings/daily
async function fetchHoldingsDailyConcurrent(
  dates: string[],
  maxConc = MAX_CONCURRENT_DAILY,
  signal?: { cancelled: boolean }
): Promise<{
  map: Map<string, HoldingsDailyResponse>;
  errors: Map<string, string>;
}> {
  const map = new Map<string, HoldingsDailyResponse>();
  const errors = new Map<string, string>();
  let idx = 0;
  async function worker() {
    while (idx < dates.length) {
      if (signal?.cancelled) return;
      const i = idx++;
      const d = dates[i];
      try {
        const res = await api.holdingsDaily(d);
        if (signal?.cancelled) return;
        map.set(d, res);
      } catch (e) {
        if (signal?.cancelled) return;
        errors.set(d, e instanceof Error ? e.message : String(e));
      }
    }
  }
  const workerCount = Math.min(maxConc, Math.max(1, dates.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return { map, errors };
}

export default function PeriodContributions() {
  const [navData, setNavData] = useState<NavPoint[]>([]);
  const [navLoading, setNavLoading] = useState(true);
  const [navError, setNavError] = useState("");

  const [range, setRange] = useState<[Dayjs, Dayjs] | null>(null);
  const [chartMode, setChartMode] = useState<"stock" | "slot">("stock");
  const [tableSort, setTableSort] = useState<"gain" | "loss">("gain");

  const [holdingsByDate, setHoldingsByDate] = useState<
    Map<string, HoldingsDailyResponse>
  >(new Map());
  const [executions, setExecutions] = useState<Execution[]>([]);
  const [loadingPeriod, setLoadingPeriod] = useState(false);
  const [periodError, setPeriodError] = useState("");
  const [partialErrors, setPartialErrors] = useState<Map<string, string>>(
    new Map()
  );
  // 跨区间复用已经成功拉取过的 holdings/daily（含实时数据的日期不缓存，避免拿到陈旧快照）
  const holdingsCacheRef = useRef<Map<string, HoldingsDailyResponse>>(new Map());

  const isMobile = useIsMobile();

  // 1) 加载 nav，建立可选交易日索引
  useEffect(() => {
    api
      .nav()
      .then((nav) => {
        const sorted = [...nav].sort((a, b) => a.date.localeCompare(b.date));
        setNavData(sorted);
        if (sorted.length) {
          const endIdx = sorted.length - 1;
          const startIdx = Math.max(0, endIdx - (DEFAULT_WINDOW - 1));
          setRange([
            dayjs(sorted[startIdx].date),
            dayjs(sorted[endIdx].date),
          ]);
        }
      })
      .catch((e) => setNavError(e.message))
      .finally(() => setNavLoading(false));
  }, []);

  // navData 派生的所有可选日期 set，用于 disabledDate
  const navDateSet = useMemo(() => {
    const s = new Set<string>();
    for (const n of navData) s.add(n.date);
    return s;
  }, [navData]);

  const navByDate = useMemo(() => {
    const m = new Map<string, NavPoint>();
    for (const n of navData) m.set(n.date, n);
    return m;
  }, [navData]);

  // 在 nav 列表里上下查找最近的有效交易日（包含 self）。direction: -1 取≤d 的最近日，+1 取≥d 的最近日
  // navData 已按 date 升序排序（见上面 effect），可二分。
  const snapToTradingDay = useMemo(
    () => (d: string, direction: -1 | 1): string | null => {
      const n = navData.length;
      if (!n) return null;
      if (direction === 1) {
        if (navData[n - 1].date < d) return null;
        let lo = 0;
        let hi = n - 1;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (navData[mid].date >= d) hi = mid;
          else lo = mid + 1;
        }
        return navData[lo].date;
      }
      if (navData[0].date > d) return null;
      let lo = 0;
      let hi = n - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (navData[mid].date <= d) lo = mid;
        else hi = mid - 1;
      }
      return navData[lo].date;
    },
    [navData]
  );

  // 区间内的交易日（升序）
  const tradingDays = useMemo(() => {
    if (!range || !navData.length) return [] as string[];
    const start = range[0].format("YYYY-MM-DD");
    const end = range[1].format("YYYY-MM-DD");
    return navData.filter((n) => n.date >= start && n.date <= end).map((n) => n.date);
  }, [range, navData]);

  // 区间起始交易日的前一交易日（用于「区间起始日就清仓」的股票回填昨收）
  const preStartDate = useMemo(() => {
    if (!tradingDays.length) return null;
    const idx = navData.findIndex((n) => n.date === tradingDays[0]);
    if (idx <= 0) return null;
    return navData[idx - 1].date;
  }, [tradingDays, navData]);

  const tooManyDays = tradingDays.length > MAX_TRADING_DAYS;

  // 2) 区间变化时重新拉取数据
  useEffect(() => {
    if (!tradingDays.length || tooManyDays) {
      setHoldingsByDate(new Map());
      setExecutions([]);
      setPartialErrors(new Map());
      setPeriodError("");
      setLoadingPeriod(false);
      return;
    }

    const signal = { cancelled: false };
    setLoadingPeriod(true);
    setPeriodError("");
    setPartialErrors(new Map());

    const datesAll = preStartDate
      ? [preStartDate, ...tradingDays]
      : [...tradingDays];

    const start = tradingDays[0];
    const end = tradingDays[tradingDays.length - 1];

    // 缓存命中过滤：只拉缓存里没有的日期
    const datesNeedFetch = datesAll.filter(
      (d) => !holdingsCacheRef.current.has(d)
    );

    const pHoldings = datesNeedFetch.length
      ? fetchHoldingsDailyConcurrent(
          datesNeedFetch,
          MAX_CONCURRENT_DAILY,
          signal
        )
      : Promise.resolve({
          map: new Map<string, HoldingsDailyResponse>(),
          errors: new Map<string, string>(),
        });
    const pExec = fetchExecutionsInRange(start, end, signal);

    Promise.allSettled([pHoldings, pExec]).then((settled) => {
      if (signal.cancelled) return;

      const holdRes = settled[0];
      const execRes = settled[1];

      const partialMap = new Map<string, string>();

      if (holdRes.status === "fulfilled") {
        // 写入缓存（含实时数据的不缓存，避免下次拿到旧快照）
        for (const [d, r] of holdRes.value.map.entries()) {
          const hasRealtime = r.items.some((it) => it.is_realtime);
          if (!hasRealtime) holdingsCacheRef.current.set(d, r);
        }
        for (const [d, m] of holdRes.value.errors.entries()) {
          partialMap.set(d, m);
        }
        // 拼出本次区间的完整 holdings map（含本次新拉 + 老缓存）
        const fullMap = new Map<string, HoldingsDailyResponse>();
        for (const d of datesAll) {
          const fromCache = holdingsCacheRef.current.get(d);
          const fromFresh = holdRes.value.map.get(d);
          const r = fromFresh ?? fromCache;
          if (r) fullMap.set(d, r);
        }
        setHoldingsByDate(fullMap);
      } else {
        const msg =
          holdRes.reason instanceof Error
            ? holdRes.reason.message
            : String(holdRes.reason);
        setPeriodError(`持仓数据加载失败：${msg}`);
        setHoldingsByDate(new Map());
      }

      if (execRes.status === "fulfilled") {
        setExecutions(execRes.value);
      } else {
        const msg =
          execRes.reason instanceof Error
            ? execRes.reason.message
            : String(execRes.reason);
        partialMap.set("__executions__", msg);
        setExecutions([]);
      }

      setPartialErrors(partialMap);
      setLoadingPeriod(false);
    });

    return () => {
      signal.cancelled = true;
    };
  }, [tradingDays, preStartDate, tooManyDays]);

  // 区间组合涨跌：(nav_end - nav_{start-1}) / nav_{start-1} * 100
  const periodReturnPct = useMemo(() => {
    if (!tradingDays.length) return null;
    const endNav = navByDate.get(tradingDays[tradingDays.length - 1]);
    if (!endNav) return null;
    const baseNav = preStartDate ? navByDate.get(preStartDate) : null;
    if (!baseNav || baseNav.total_value <= 0) return null;
    return ((endNav.total_value - baseNav.total_value) / baseNav.total_value) * 100;
  }, [tradingDays, navByDate, preStartDate]);

  const periodEndTotalValue = useMemo(() => {
    if (!tradingDays.length) return null;
    return navByDate.get(tradingDays[tradingDays.length - 1])?.total_value ?? null;
  }, [tradingDays, navByDate]);

  const periodBaseTotalValue = useMemo(() => {
    if (!preStartDate) return null;
    return navByDate.get(preStartDate)?.total_value ?? null;
  }, [preStartDate, navByDate]);

  // 用户实际选择的区间起始交易日（用于卡片展示，与日期选择器匹配）
  const periodStartDate = useMemo(
    () => (tradingDays.length ? tradingDays[0] : null),
    [tradingDays]
  );
  const periodStartTotalValue = useMemo(() => {
    if (!periodStartDate) return null;
    return navByDate.get(periodStartDate)?.total_value ?? null;
  }, [periodStartDate, navByDate]);

  // 按日聚合 executions
  const execsByDate = useMemo(() => {
    const map = new Map<string, Execution[]>();
    for (const e of executions) {
      const d = e.exec_date;
      const arr = map.get(d);
      if (arr) arr.push(e);
      else map.set(d, [e]);
    }
    return map;
  }, [executions]);

  // 核心聚合：逐日为每只股票计算盈亏与 daily_contribution_pct，再求和到区间维度
  const rows: PeriodRow[] = useMemo(() => {
    if (!tradingDays.length) return [];
    if (!holdingsByDate.size) return [];

    const map = new Map<string, PeriodRow>();
    const ensure = (code: string): PeriodRow => {
      let cur = map.get(code);
      if (!cur) {
        cur = {
          stock_code: code,
          latest_slot_idx: [],
          held_at_end: false,
          shares_end: 0,
          shares_start_prev: 0,
          first_pre_close: null,
          last_close: null,
          hold_pnl: 0,
          buy_pnl: 0,
          sell_pnl: 0,
          total_pnl: 0,
          contribution_pct: 0,
          contribution_share: 0,
          exec: { ...EMPTY_EXEC_AGG },
          active_days: 0,
          missing_pre_close_days: 0,
          has_suspended_day: false,
          has_realtime: false,
          has_intraday_day: false,
          inception_mid_period: false,
          last_appearance_date: null,
        };
        map.set(code, cur);
      }
      return cur;
    };

    // 跟踪每只股票当日是否已记过 active_days（同日不重复 +1）
    const lastSlotByCode = new Map<string, number[]>();
    const firstPreCloseSeen = new Set<string>();
    const startPrevSharesSeen = new Set<string>();

    for (let dIdx = 0; dIdx < tradingDays.length; dIdx++) {
      const date = tradingDays[dIdx];
      const isFirstDay = dIdx === 0;
      const items = holdingsByDate.get(date)?.items ?? [];
      const itemByCode = new Map<string, HoldingsDailyItem>();
      for (const it of items) itemByCode.set(it.stock_code, it);

      const prevDate =
        dIdx > 0 ? tradingDays[dIdx - 1] : preStartDate;
      const prevItemByCode = new Map<string, HoldingsDailyItem>();
      const prevHoldings = prevDate ? holdingsByDate.get(prevDate) : undefined;
      if (prevHoldings) {
        for (const it of prevHoldings.items) prevItemByCode.set(it.stock_code, it);
      }

      const navPrev = prevDate ? navByDate.get(prevDate) : null;
      const denom = navPrev && navPrev.total_value > 0 ? navPrev.total_value : null;

      const dayExecs = execsByDate.get(date) ?? [];
      const dayExecAggByCode = new Map<string, ExecAgg>();
      for (const e of dayExecs) {
        const ag = dayExecAggByCode.get(e.stock_code) ?? { ...EMPTY_EXEC_AGG };
        addExec(ag, e);
        dayExecAggByCode.set(e.stock_code, ag);
      }

      // 当日"涉及"的股票 = 持仓 ∪ 当日有交易
      const codes = new Set<string>();
      for (const c of itemByCode.keys()) codes.add(c);
      for (const c of dayExecAggByCode.keys()) codes.add(c);

      for (const code of codes) {
        const row = ensure(code);
        const exec = dayExecAggByCode.get(code) ?? { ...EMPTY_EXEC_AGG };
        const it = itemByCode.get(code);
        const heldToday = !!it;

        let holdPnl = 0;
        let buyPnl = 0;
        let sellPnl = 0;
        let dailyTotal = 0;

        if (heldToday) {
          const sharesToday = it!.shares;
          const sharesPrev =
            sharesToday - exec.buy_shares + exec.sell_shares;
          const suspended = it!.close == null || it!.pre_close == null;
          if (suspended) {
            row.has_suspended_day = true;
          } else {
            const close = it!.close as number;
            const preClose = it!.pre_close as number;
            // 全天持有的份额（昨持 − 当日已卖），用于 hold_pnl 的乘数，
            // 避免与 sell_pnl 重复计提：已卖出份额的 (close − preClose) 部分
            // 完全由 sell_pnl = sell_amount − preClose × sell_shares 承担。
            const sharesHeldThroughDay = sharesPrev - exec.sell_shares;
            holdPnl = sharesHeldThroughDay * (close - preClose);
            buyPnl = close * exec.buy_shares - exec.buy_amount;
            sellPnl = exec.sell_amount - preClose * exec.sell_shares;
            dailyTotal = holdPnl + buyPnl + sellPnl;

            if (!firstPreCloseSeen.has(code)) {
              row.first_pre_close = preClose;
              firstPreCloseSeen.add(code);
            }
            row.last_close = close;
          }
          if (!startPrevSharesSeen.has(code)) {
            row.shares_start_prev = sharesPrev;
            // 区间起始日就持仓（sharesPrev > 0）= 期初持仓；
            // 否则为中途新建仓（首日有买入或非首日才首次出现）
            row.inception_mid_period = !(isFirstDay && sharesPrev > 0);
            startPrevSharesSeen.add(code);
          }
          row.last_appearance_date = date;
          if (it!.is_realtime) row.has_realtime = true;
          if (it!.slot_idx && it!.slot_idx.length) {
            lastSlotByCode.set(code, it!.slot_idx);
          }
        } else {
          // 当日不在 items 里 → 当日完全卖出（已清仓）。三个子情况：
          //   (A) sharesPrev > 0 & 拿到昨收：昨日有持仓 → 全清，按 preClose 做归因
          //         buy_pnl  = preClose × buy_shares − buy_amount
          //         sell_pnl = sell_amount − preClose × sell_shares
          //   (B) sharesPrev == 0 & buy_shares > 0 & sell_shares > 0：日内 round-trip
          //         （昨日无持仓，前一交易日 holdings 里查不到 code，preClose 必然为 null）
          //         真实盈亏 = sell_amount − buy_amount，与昨收无关
          //         展示价用 vwap 代理：first_pre_close ← avg_buy，last_close ← avg_sell
          //   (C) sharesPrev > 0 但缺 preClose：无法精确归因，归 0 并 missing_pre_close_days += 1
          //   (D) sharesPrev < 0：理论不可能（无卖空），防御性归 0
          const prevIt = prevItemByCode.get(code);
          const preClose = prevIt?.close ?? null;
          const sharesPrev = exec.sell_shares - exec.buy_shares;
          const isIntraday =
            sharesPrev === 0 && exec.buy_shares > 0 && exec.sell_shares > 0;

          if (isIntraday) {
            sellPnl = exec.sell_amount - exec.buy_amount;
            dailyTotal = sellPnl;
            row.has_intraday_day = true;
            const avgSell = exec.sell_amount / exec.sell_shares;
            const avgBuy = exec.buy_amount / exec.buy_shares;
            row.last_close = avgSell;
            if (!firstPreCloseSeen.has(code)) {
              row.first_pre_close = avgBuy;
              firstPreCloseSeen.add(code);
            }
          } else if (sharesPrev > 0 && preClose != null) {
            buyPnl = preClose * exec.buy_shares - exec.buy_amount;
            sellPnl = exec.sell_amount - preClose * exec.sell_shares;
            dailyTotal = buyPnl + sellPnl;
            const avgSell =
              exec.sell_shares > 0 ? exec.sell_amount / exec.sell_shares : null;
            if (avgSell != null) row.last_close = avgSell;
            if (!firstPreCloseSeen.has(code)) {
              row.first_pre_close = preClose;
              firstPreCloseSeen.add(code);
            }
          } else if (sharesPrev > 0) {
            row.missing_pre_close_days += 1;
          }
          // sharesPrev < 0：保持全 0，防御性

          if (!startPrevSharesSeen.has(code)) {
            row.shares_start_prev = sharesPrev;
            row.inception_mid_period = !(isFirstDay && sharesPrev > 0);
            startPrevSharesSeen.add(code);
          }
        }

        // 累加到区间总量
        row.hold_pnl += holdPnl;
        row.buy_pnl += buyPnl;
        row.sell_pnl += sellPnl;
        row.total_pnl += dailyTotal;
        mergeExec(row.exec, exec);
        row.active_days += 1;

        const dailyContribPct = denom != null ? (dailyTotal / denom) * 100 : 0;
        row.contribution_pct += dailyContribPct;
      }
    }

    // 结束日持仓状态
    const endItems = holdingsByDate.get(tradingDays[tradingDays.length - 1])?.items ?? [];
    const endByCode = new Map<string, HoldingsDailyItem>();
    for (const it of endItems) endByCode.set(it.stock_code, it);
    for (const r of map.values()) {
      const endIt = endByCode.get(r.stock_code);
      if (endIt) {
        r.held_at_end = endIt.shares > 0;
        r.shares_end = endIt.shares;
        if (endIt.slot_idx && endIt.slot_idx.length) {
          r.latest_slot_idx = endIt.slot_idx;
        } else {
          r.latest_slot_idx = lastSlotByCode.get(r.stock_code) ?? [];
        }
      } else {
        r.held_at_end = false;
        r.shares_end = 0;
        r.latest_slot_idx = lastSlotByCode.get(r.stock_code) ?? [];
      }
    }

    // 计算 contribution_share（占区间净盈亏）
    const periodTotal = [...map.values()].reduce((a, r) => a + r.total_pnl, 0);
    for (const r of map.values()) {
      r.contribution_share =
        Math.abs(periodTotal) > 1e-9 ? (r.total_pnl / periodTotal) * 100 : 0;
    }

    return [...map.values()].sort((a, b) => b.contribution_pct - a.contribution_pct);
  }, [tradingDays, holdingsByDate, navByDate, execsByDate, preStartDate]);

  // 区间内 executions 按 stock_code 聚合的列表（tooltip 中展示明细）
  const execsByCode = useMemo(() => {
    const map = new Map<string, Execution[]>();
    for (const e of executions) {
      const arr = map.get(e.stock_code);
      if (arr) arr.push(e);
      else map.set(e.stock_code, [e]);
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => {
        const c = a.exec_date.localeCompare(b.exec_date);
        return c !== 0 ? c : a.id - b.id;
      });
    }
    return map;
  }, [executions]);

  const summary = useMemo(() => {
    if (!rows.length) return null;
    const totalPnl = rows.reduce((acc, r) => acc + r.total_pnl, 0);
    const totalContribution = rows.reduce(
      (acc, r) => acc + r.contribution_pct,
      0
    );
    const positives = rows.filter((r) => r.total_pnl > 0);
    const negatives = rows.filter((r) => r.total_pnl < 0);
    const flats = rows.length - positives.length - negatives.length;
    const positiveSum = positives.reduce((a, r) => a + r.contribution_pct, 0);
    const negativeSum = negatives.reduce((a, r) => a + r.contribution_pct, 0);

    const tradedRows = rows.filter(
      (r) => r.exec.buy_count + r.exec.sell_count > 0
    );
    const totalCommission = tradedRows.reduce(
      (a, r) => a + r.exec.total_commission,
      0
    );
    const totalStampDuty = tradedRows.reduce(
      (a, r) => a + r.exec.total_stamp_duty,
      0
    );
    const totalSlippage = tradedRows.reduce(
      (a, r) => a + r.exec.total_slippage,
      0
    );
    const totalExecCost = tradedRows.reduce(
      (a, r) => a + r.exec.total_exec_cost,
      0
    );
    const totalBuyCount = tradedRows.reduce((a, r) => a + r.exec.buy_count, 0);
    const totalSellCount = tradedRows.reduce(
      (a, r) => a + r.exec.sell_count,
      0
    );

    const sortedByPct = [...rows].sort(
      (a, b) => b.contribution_pct - a.contribution_pct
    );

    return {
      totalPnl,
      totalContribution,
      positives: positives.length,
      negatives: negatives.length,
      flats,
      positiveSum,
      negativeSum,
      topGainer: sortedByPct[0],
      topLoser: sortedByPct[sortedByPct.length - 1],
      totalCommission,
      totalStampDuty,
      totalSlippage,
      totalExecCost,
      totalBuyCount,
      totalSellCount,
      tradedStocks: tradedRows.length,
      heldAtEndCount: rows.filter((r) => r.held_at_end).length,
      hasRealtime: rows.some((r) => r.has_realtime),
    };
  }, [rows]);

  // 按槽位聚合：基于"每日历史"分摊
  const slotRows = useMemo(() => {
    interface SlotMember {
      code: string;
      partial_pnl: number;
      partial_pct: number;
    }
    interface SlotAgg {
      slot: number;
      total_pnl: number;
      contribution_pct: number;
      stock_codes: Set<string>;
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
          stock_codes: new Set<string>(),
          members: [],
        };
        map.set(slot, cur);
      }
      return cur;
    };
    // 简化方案：用 latest_slot_idx 做整笔分摊（每只股票一笔）。
    // 对未换槽的股票完全准确，对换过槽的股票只反映结束日所属槽位（已通过表头说明告知用户）。
    for (const r of rows) {
      const slots = r.latest_slot_idx.length ? r.latest_slot_idx : [-1];
      const n = slots.length;
      const partialPnl = r.total_pnl / n;
      const partialPct = r.contribution_pct / n;
      for (const s of slots) {
        const agg = ensure(s);
        agg.total_pnl += partialPnl;
        agg.contribution_pct += partialPct;
        agg.stock_codes.add(r.stock_code);
        agg.members.push({
          code: r.stock_code,
          partial_pnl: partialPnl,
          partial_pct: partialPct,
        });
      }
    }
    for (const agg of map.values()) {
      agg.members.sort(
        (a, b) => Math.abs(b.partial_pct) - Math.abs(a.partial_pct)
      );
    }
    return [...map.values()]
      .map((agg) => ({
        slot: agg.slot,
        total_pnl: agg.total_pnl,
        contribution_pct: agg.contribution_pct,
        stock_count: agg.stock_codes.size,
        members: agg.members,
      }))
      .sort((a, b) => b.contribution_pct - a.contribution_pct);
  }, [rows]);

  const chartOptions = useMemo(() => {
    const buildStockOption = (
      subset: PeriodRow[],
      color: string,
      isLoss = false
    ) => {
      if (!subset.length) return null;
      const initialWindow = 30;
      const sorted = [...subset].sort(
        (a, b) =>
          Math.abs(b.contribution_pct) - Math.abs(a.contribution_pct)
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
            const lines = [
              `<b>${r.stock_code}</b>${
                r.latest_slot_idx.length
                  ? ` · #${r.latest_slot_idx.join(",")}`
                  : ""
              }`,
              `区间贡献度: <b>${fmtPct(r.contribution_pct, 4)}</b>${
                Math.abs(r.contribution_share) > 0
                  ? `（占区间盈亏 ${fmtPct(r.contribution_share)}）`
                  : ""
              }`,
              `区间贡献金额: ${fmtMoney(r.total_pnl, 2)}`,
              `活跃天数: ${r.active_days}`,
              `结束日持股: ${r.shares_end.toFixed(0)}${
                r.held_at_end ? "" : " · <span style=\"color:#faad14\">已清</span>"
              }`,
            ];
            if (r.has_suspended_day) {
              lines.push(`<span style="color:#faad14">含停牌天</span>`);
            }
            if (r.missing_pre_close_days > 0) {
              lines.push(
                `<span style="color:#faad14">缺昨收兜底为 0：${r.missing_pre_close_days} 天</span>`
              );
            }
            if (r.exec.buy_count + r.exec.sell_count > 0) {
              const stockExecs = execsByCode.get(r.stock_code) ?? [];
              lines.push(
                `<div style="margin-top:4px;border-top:1px solid rgba(255,255,255,0.15);padding-top:4px">区间成交 · 买 <span style="color:${POS_COLOR}">${r.exec.buy_count}</span> / 卖 <span style="color:${NEG_COLOR}">${r.exec.sell_count}</span></div>`
              );
              const MAX_ROWS = 6;
              const shown = stockExecs.slice(-MAX_ROWS);
              if (stockExecs.length > MAX_ROWS) {
                lines.push(
                  `<span style="color:rgba(255,255,255,0.45)">…前 ${
                    stockExecs.length - MAX_ROWS
                  } 笔已省略</span>`
                );
              }
              for (const e of shown) {
                const isBuy = e.action === "buy";
                const actionLabel = isBuy
                  ? `<span style="color:${POS_COLOR};font-weight:600">买入</span>`
                  : `<span style="color:${NEG_COLOR};font-weight:600">卖出</span>`;
                const amountLabel = isBuy ? "买入额" : "卖出额";
                lines.push(
                  `${e.exec_date} ${actionLabel} ${e.shares.toFixed(
                    0
                  )} 股，${amountLabel}：<b>${fmtMoney(e.amount, 2)}</b>`
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
        (a, b) =>
          Math.abs(b.contribution_pct) - Math.abs(a.contribution_pct)
      );
      const labels = sorted.map((s) =>
        s.slot < 0 ? "未分配" : `#${s.slot}`
      );
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
              `区间贡献度: <b>${fmtPct(s.contribution_pct, 4)}</b>`,
              `区间贡献金额: ${fmtMoney(s.total_pnl, 2)}`,
              `成员: ${s.stock_count} 只`,
            ];
            if (s.members.length) {
              lines.push(
                `<div style="margin-top:4px;border-top:1px solid rgba(255,255,255,0.15);padding-top:4px">成员贡献:</div>` +
                  s.members
                    .map((m) => {
                      const c =
                        m.partial_pct >= 0 ? POS_COLOR : NEG_COLOR;
                      return `${m.code}: <span style="color:${c}">${fmtPct(
                        m.partial_pct,
                        4
                      )}</span>`;
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
  }, [rows, slotRows, chartMode, isMobile, execsByCode, tradingDays]);

  const renderSlots = (slots: number[]) => {
    if (!slots.length)
      return <span style={{ color: "rgba(255,255,255,0.45)" }}>—</span>;
    return (
      <span>
        {slots.map((s) => (
          <Tag color="blue" key={s} style={{ marginRight: 2 }}>
            #{s}
          </Tag>
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
      render: (v: string) => <span>{v}</span>,
    },
    {
      title: () => (
        <span>
          槽位{" "}
          <Tooltip title="按区间结束日所属槽位展示。区间内换过槽位的股票仅反映末位状态。">
            <InfoCircleOutlined style={{ color: "rgba(255,255,255,0.45)" }} />
          </Tooltip>
        </span>
      ),
      dataIndex: "latest_slot_idx",
      key: "latest_slot_idx",
      width: 110,
      render: renderSlots,
    },
    {
      title: "区间内交易",
      key: "trade_action",
      width: 130,
      render: (_: unknown, r: PeriodRow) => {
        const buy = r.exec.buy_count > 0;
        const sell = r.exec.sell_count > 0;
        if (!buy && !sell) {
          return <span style={{ color: "rgba(255,255,255,0.45)" }}>—</span>;
        }
        const stockExecs = execsByCode.get(r.stock_code) ?? [];
        const buyList = stockExecs.filter((e) => e.action === "buy");
        const sellList = stockExecs.filter((e) => e.action === "sell");
        return (
          <span>
            {buy && (
              <Tooltip
                title={renderExecListTooltip(
                  "buy",
                  buyList,
                  r.exec.buy_count,
                  r.exec.buy_shares,
                  r.exec.buy_amount
                )}
              >
                <Tag color="green" style={{ marginRight: 2 }}>
                  买{r.exec.buy_count > 1 ? `×${r.exec.buy_count}` : ""}
                </Tag>
              </Tooltip>
            )}
            {sell && (
              <Tooltip
                title={renderExecListTooltip(
                  "sell",
                  sellList,
                  r.exec.sell_count,
                  r.exec.sell_shares,
                  r.exec.sell_amount
                )}
              >
                <Tag color="red" style={{ marginRight: 2 }}>
                  卖{r.exec.sell_count > 1 ? `×${r.exec.sell_count}` : ""}
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
        <span style={{ color: pnlColor(v), fontWeight: 600 }}>
          {fmtPct(v, 4)}
        </span>
      ),
    },
    {
      title: "贡献金额",
      dataIndex: "total_pnl",
      key: "total_pnl",
      width: 150,
      render: (v: number, r: PeriodRow) => {
        const tip = (
          <div style={{ lineHeight: 1.6 }}>
            <div>区间内逐日盈亏分项累加：</div>
            <div>
              持仓盈亏: <b>{fmtMoney(r.hold_pnl, 2)}</b>
              <span style={{ color: "rgba(255,255,255,0.45)", marginLeft: 6 }}>
                = Σ 持仓股 × (close − pre_close)
              </span>
            </div>
            <div>
              买入盈亏: <b>{fmtMoney(r.buy_pnl, 2)}</b>
              <span style={{ color: "rgba(255,255,255,0.45)", marginLeft: 6 }}>
                = Σ close × buy_shares − buy_amount
              </span>
            </div>
            <div>
              卖出盈亏: <b>{fmtMoney(r.sell_pnl, 2)}</b>
              <span style={{ color: "rgba(255,255,255,0.45)", marginLeft: 6 }}>
                = Σ sell_amount − pre_close × sell_shares
              </span>
            </div>
            {r.missing_pre_close_days > 0 && (
              <div style={{ marginTop: 4, color: "#faad14" }}>
                有 {r.missing_pre_close_days} 天因缺昨收兜底为 0
              </div>
            )}
          </div>
        );
        return (
          <Tooltip title={tip}>
            <span style={{ color: pnlColor(v), cursor: "help" }}>
              {fmtMoney(v, 2)}
            </span>
          </Tooltip>
        );
      },
    },
    {
      title: "区间涨跌",
      key: "period_pct_chg",
      width: 110,
      render: (_: unknown, r: PeriodRow) => {
        if (r.first_pre_close == null || r.last_close == null)
          return <span style={{ color: "rgba(255,255,255,0.45)" }}>—</span>;
        const pct =
          ((r.last_close - r.first_pre_close) / r.first_pre_close) * 100;
        return <span style={{ color: pnlColor(pct) }}>{fmtPct(pct)}</span>;
      },
    },
    {
      title: "结束价",
      dataIndex: "last_close",
      key: "last_close",
      width: 100,
      render: (v: number | null, r: PeriodRow) => {
        if (v == null) return "—";
        return (
          <ClosedProxyCell proxy={!r.held_at_end} title={CLOSED_PROXY_TIP}>
            <span>{v.toFixed(2)}</span>
          </ClosedProxyCell>
        );
      },
    },
    {
      title: "起始价",
      dataIndex: "first_pre_close",
      key: "first_pre_close",
      width: 100,
      render: (v: number | null) => (v == null ? "—" : v.toFixed(2)),
    },
    {
      title: () => (
        <span>
          活跃 / 持股{" "}
          <Tooltip title="活跃天数 / 结束日持股 / 区间起始日开盘前持股">
            <InfoCircleOutlined style={{ color: "rgba(255,255,255,0.45)" }} />
          </Tooltip>
        </span>
      ),
      key: "shares",
      width: 150,
      render: (_: unknown, r: PeriodRow) => (
        <span>
          {r.active_days}d
          <span style={{ color: "rgba(255,255,255,0.45)", marginLeft: 4 }}>
            · {r.shares_end.toFixed(0)} / {r.shares_start_prev.toFixed(0)}
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
      render: (v: string, r: PeriodRow) => {
        const buy = r.exec.buy_count > 0;
        const sell = r.exec.sell_count > 0;
        const stockExecs = execsByCode.get(r.stock_code) ?? [];
        const buyList = stockExecs.filter((e) => e.action === "buy");
        const sellList = stockExecs.filter((e) => e.action === "sell");
        return (
          <div style={{ lineHeight: 1.3 }}>
            <div style={{ fontWeight: 600 }}>{v}</div>
            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.45)" }}>
              {r.latest_slot_idx.length
                ? `#${r.latest_slot_idx.join(",")}`
                : "—"}
            </div>
            {(buy || sell) && (
              <div style={{ marginTop: 2 }}>
                {buy && (
                  <Tooltip
                    title={renderExecListTooltip(
                      "buy",
                      buyList,
                      r.exec.buy_count,
                      r.exec.buy_shares,
                      r.exec.buy_amount
                    )}
                  >
                    <Tag
                      color="green"
                      style={{
                        marginRight: 2,
                        fontSize: 10,
                        lineHeight: "16px",
                        padding: "0 4px",
                      }}
                    >
                      买{r.exec.buy_count > 1 ? r.exec.buy_count : ""}
                    </Tag>
                  </Tooltip>
                )}
                {sell && (
                  <Tooltip
                    title={renderExecListTooltip(
                      "sell",
                      sellList,
                      r.exec.sell_count,
                      r.exec.sell_shares,
                      r.exec.sell_amount
                    )}
                  >
                    <Tag
                      color="red"
                      style={{
                        marginRight: 2,
                        fontSize: 10,
                        lineHeight: "16px",
                        padding: "0 4px",
                      }}
                    >
                      卖{r.exec.sell_count > 1 ? r.exec.sell_count : ""}
                    </Tag>
                  </Tooltip>
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
        <span style={{ color: pnlColor(v), fontWeight: 600 }}>
          {fmtPct(v, 4)}
        </span>
      ),
    },
    {
      title: "区间涨跌",
      key: "period_pct_chg",
      width: 90,
      render: (_: unknown, r: PeriodRow) => {
        if (r.first_pre_close == null || r.last_close == null)
          return <span style={{ color: "rgba(255,255,255,0.45)" }}>—</span>;
        const pct =
          ((r.last_close - r.first_pre_close) / r.first_pre_close) * 100;
        return <span style={{ color: pnlColor(pct) }}>{fmtPct(pct)}</span>;
      },
    },
    {
      title: "贡献金额",
      dataIndex: "total_pnl",
      key: "total_pnl",
      width: 110,
      render: (v: number) => (
        <span style={{ color: pnlColor(v) }}>{fmtMoney(v, 0)}</span>
      ),
    },
  ];

  const minDate = navData.length ? dayjs(navData[0].date) : undefined;
  const maxDate = navData.length
    ? dayjs(navData[navData.length - 1].date)
    : undefined;

  // 快捷区间：基于真实交易日索引向回数 N 个交易日
  const rangePresets = useMemo(() => {
    if (!navData.length) return [];
    const lastIdx = navData.length - 1;
    const lastDate = navData[lastIdx].date;
    const make = (n: number): [Dayjs, Dayjs] => {
      const i = Math.max(0, lastIdx - (n - 1));
      return [dayjs(navData[i].date), dayjs(lastDate)];
    };
    const presets: { label: string; value: [Dayjs, Dayjs] }[] = [
      { label: "近 5 日", value: make(5) },
      { label: "近 10 日", value: make(10) },
      { label: "近 20 日", value: make(20) },
    ];
    if (navData.length >= 60) {
      presets.push({
        label: "近 60 日",
        value: make(Math.min(60, MAX_TRADING_DAYS)),
      });
    }
    if (navData.length >= MAX_TRADING_DAYS) {
      presets.push({
        label: `最大 ${MAX_TRADING_DAYS} 日`,
        value: make(MAX_TRADING_DAYS),
      });
    }
    return presets;
  }, [navData]);

  const rangePicker = (
    <DatePicker.RangePicker
      value={range as [Dayjs, Dayjs] | null}
      onChange={(v) => {
        if (!v || !v[0] || !v[1]) {
          setRange(null);
          return;
        }
        // 自动吸附到最近的交易日
        const startStr = v[0].format("YYYY-MM-DD");
        const endStr = v[1].format("YYYY-MM-DD");
        const snappedStart =
          navDateSet.has(startStr) ? startStr : snapToTradingDay(startStr, 1);
        const snappedEnd =
          navDateSet.has(endStr) ? endStr : snapToTradingDay(endStr, -1);
        if (!snappedStart || !snappedEnd || snappedStart > snappedEnd) {
          setRange(null);
          return;
        }
        setRange([dayjs(snappedStart), dayjs(snappedEnd)]);
      }}
      format="YYYY-MM-DD"
      disabledDate={(d) => {
        if (!d) return false;
        const s = d.format("YYYY-MM-DD");
        if (minDate && d.isBefore(minDate, "day")) return true;
        if (maxDate && d.isAfter(maxDate, "day")) return true;
        return !navDateSet.has(s);
      }}
      allowClear={false}
      size={isMobile ? "small" : "middle"}
      style={{ width: isMobile ? 240 : 280 }}
      presets={rangePresets}
    />
  );

  if (navLoading) {
    return (
      <Spin size="large" style={{ display: "block", margin: "100px auto" }} />
    );
  }
  if (navError) return <Alert type="error" message={navError} />;

  const summaryCards = summary && (
    <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
      <Col xs={12} sm={6}>
        <Card size={isMobile ? "small" : "default"}>
          <Statistic
            title="区间组合涨跌"
            value={periodReturnPct ?? 0}
            precision={2}
            suffix="%"
            valueStyle={{ color: pnlColor(periodReturnPct ?? 0) }}
            prefix={
              (periodReturnPct ?? 0) >= 0 ? (
                <ArrowUpOutlined />
              ) : (
                <ArrowDownOutlined />
              )
            }
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
              起始日{" "}
              {periodStartDate ? periodStartDate.slice(5) : "—"} 总资产{" "}
              {periodStartTotalValue != null
                ? fmtMoney(periodStartTotalValue, 0)
                : "—"}
            </div>
            <div style={{ marginTop: 6 }}>
              结束日{" "}
              {tradingDays.length
                ? tradingDays[tradingDays.length - 1].slice(5)
                : "—"}{" "}
              总资产{" "}
              {periodEndTotalValue != null
                ? fmtMoney(periodEndTotalValue, 0)
                : "—"}
            </div>
          </div>
        </Card>
      </Col>
      <Col xs={12} sm={6}>
        <Card size={isMobile ? "small" : "default"}>
          <Statistic
            title={
              <span>
                持仓贡献合计{" "}
                <Tooltip title="区间内每只股票每日盈亏之和。与「区间组合涨跌 × 起始基准总资产」的差额通常来自现金/非持仓项变动或除权调整误差。">
                  <InfoCircleOutlined
                    style={{ color: "rgba(255,255,255,0.45)" }}
                  />
                </Tooltip>
              </span>
            }
            value={summary.totalPnl}
            precision={0}
            prefix="¥"
            valueStyle={{ color: pnlColor(summary.totalPnl) }}
          />
          {!isMobile && (
            <div
              style={{
                marginTop: 4,
                fontSize: 11,
                color: "rgba(255,255,255,0.45)",
                lineHeight: 1.6,
              }}
            >
              <div>
                贡献度合计 {fmtPct(summary.totalContribution)} · 累计{" "}
                {tradingDays.length} 个交易日
              </div>
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
            <div
              style={{
                marginTop: 4,
                fontSize: 11,
                color: "rgba(255,255,255,0.45)",
              }}
            >
              <span style={{ color: POS_COLOR }}>
                +{summary.positiveSum.toFixed(2)}%
              </span>{" "}
              <span style={{ color: NEG_COLOR }}>
                {summary.negativeSum.toFixed(2)}%
              </span>
              {summary.flats > 0 && ` · 持平 ${summary.flats}`}
            </div>
          )}
        </Card>
      </Col>
      <Col xs={12} sm={6}>
        <Card
          size={isMobile ? "small" : "default"}
          styles={{ body: { padding: isMobile ? 12 : 24 } }}
        >
          {summary.topGainer && summary.topGainer.contribution_pct > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <RiseOutlined style={{ color: POS_COLOR }} />
              <div>
                <div
                  style={{ fontSize: 11, color: "rgba(255,255,255,0.45)" }}
                >
                  最大正贡献
                </div>
                <div
                  style={{
                    fontSize: isMobile ? 13 : 15,
                    fontWeight: 600,
                  }}
                >
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
                  summary.topGainer && summary.topGainer.contribution_pct > 0
                    ? 6
                    : 0,
              }}
            >
              <FallOutlined style={{ color: NEG_COLOR }} />
              <div>
                <div
                  style={{ fontSize: 11, color: "rgba(255,255,255,0.45)" }}
                >
                  最大负贡献
                </div>
                <div
                  style={{
                    fontSize: isMobile ? 13 : 15,
                    fontWeight: 600,
                  }}
                >
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
            title="区间交易成本"
            value={summary.totalExecCost}
            precision={2}
            prefix="¥"
            valueStyle={{ color: "#faad14" }}
          />
          {!isMobile && (
            <div
              style={{
                marginTop: 4,
                fontSize: 11,
                color: "rgba(255,255,255,0.45)",
              }}
            >
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
            title="区间交易笔数"
            value={`${summary.totalBuyCount + summary.totalSellCount}`}
            valueStyle={{ fontSize: isMobile ? 18 : 22 }}
          />
          {!isMobile && (
            <div
              style={{
                marginTop: 4,
                fontSize: 11,
                color: "rgba(255,255,255,0.45)",
              }}
            >
              <span style={{ color: POS_COLOR }}>
                买 {summary.totalBuyCount}
              </span>{" "}
              ·{" "}
              <span style={{ color: NEG_COLOR }}>
                卖 {summary.totalSellCount}
              </span>
              {` · 涉及 ${summary.tradedStocks} 只股票`}
            </div>
          )}
        </Card>
      </Col>
    </Row>
  );

  const partialErrorList =
    partialErrors.size > 0
      ? [...partialErrors.entries()]
          .map(([d, m]) =>
            d === "__executions__" ? `成交记录: ${m}` : `${d}: ${m}`
          )
          .join("；")
      : null;

  return (
    <div>
      {periodError && (
        <Alert
          type="error"
          message={`区间数据加载失败：${periodError}`}
          style={{ marginBottom: 12 }}
          showIcon
          closable
        />
      )}
      {partialErrorList && (
        <Alert
          type="warning"
          message={`部分数据拉取失败：${partialErrorList}（缺失部分按 0 处理）`}
          style={{ marginBottom: 12 }}
          showIcon
          closable
        />
      )}
      {tooManyDays && (
        <Alert
          type="warning"
          message={`所选区间包含 ${tradingDays.length} 个交易日，超过上限 ${MAX_TRADING_DAYS}，请缩短范围。`}
          style={{ marginBottom: 12 }}
          showIcon
        />
      )}
      {!tooManyDays &&
        tradingDays.length > 0 &&
        periodBaseTotalValue == null &&
        !loadingPeriod && (
          <Alert
            type="warning"
            message="无法确定起始基准总资产（区间起始日已是 nav 数据首日），区间组合涨跌与基准对照不可用。"
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
            <span>区间贡献度</span>
            <Space size={6} wrap>
              <span
                style={{
                  fontSize: isMobile ? 12 : 13,
                  color: "rgba(255,255,255,0.65)",
                  fontWeight: 400,
                }}
              >
                时间区间：
              </span>
              {rangePicker}
            </Space>
          </div>
        }
        size={isMobile ? "small" : "default"}
        styles={{ body: { padding: isMobile ? 8 : 24 } }}
      >
        {tooManyDays ? (
          <Empty description={`请将区间缩短到 ${MAX_TRADING_DAYS} 个交易日以内`} />
        ) : loadingPeriod ? (
          <Spin style={{ display: "block", margin: "60px auto" }} />
        ) : !tradingDays.length ? (
          <Empty description="请选择有效的交易日区间" />
        ) : rows.length === 0 ? (
          <Empty
            description={`${tradingDays[0]} ~ ${tradingDays[tradingDays.length - 1]} 区间内无可计算数据`}
          />
        ) : (
          <>
            {summaryCards}
            {executions.length > 0 || (summary?.totalExecCost ?? 0) > 0
              ? execCards
              : null}
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
                  <span>
                    区间贡献度排行
                  </span>
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
                    正贡献
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
                    负贡献
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
                tableSort === "gain"
                  ? b.contribution_pct - a.contribution_pct
                  : a.contribution_pct - b.contribution_pct
              );
              const tableProps = {
                columns: isMobile ? mobileColumns : columns,
                rowKey: "stock_code" as const,
                size: "small" as const,
                pagination: {
                  defaultPageSize: 20,
                  showSizeChanger: !isMobile,
                  pageSizeOptions: ["20", "50", "100"],
                  size: isMobile ? ("small" as const) : undefined,
                  showTotal: (total: number) => `共 ${total} 只`,
                },
                scroll: { x: isMobile ? 440 : 1300 },
              };
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
                        个股区间贡献度明细
                      </span>
                      <Segmented
                        size={isMobile ? "small" : "middle"}
                        value={tableSort}
                        onChange={(v) => setTableSort(v as "gain" | "loss")}
                        options={[
                          {
                            label: (
                              <span style={{ color: POS_COLOR, fontWeight: 600 }}>
                                涨
                              </span>
                            ),
                            value: "gain",
                          },
                          {
                            label: (
                              <span style={{ color: NEG_COLOR, fontWeight: 600 }}>
                                跌
                              </span>
                            ),
                            value: "loss",
                          },
                        ]}
                      />
                    </div>
                  }
                  styles={{ body: { padding: 0 } }}
                >
                  {sortedRows.length ? (
                    <Table dataSource={sortedRows} {...tableProps} />
                  ) : (
                    <Empty
                      description="无数据"
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
