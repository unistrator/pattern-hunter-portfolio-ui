import { useEffect, useMemo, useState } from "react";
import {
  Card,
  Spin,
  Alert,
  Tag,
  Row,
  Col,
  Statistic,
  Tooltip,
  Empty,
  DatePicker,
  Select,
  Space,
  Segmented,
  Table,
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
  HoldingsDailyResponse,
  IndexDailyPoint,
} from "../types";

const POS_COLOR = "#3f8600";
const NEG_COLOR = "#cf1322";
const NEUTRAL_COLOR = "rgba(255,255,255,0.65)";

const MAX_TRADING_DAYS = 90;
const DEFAULT_WINDOW = 5;
const MAX_CONCURRENT_DAILY = 6;

const INDEX_OPTIONS = [
  { value: "000300.SH", label: "沪深300" },
  { value: "000905.SH", label: "中证500" },
  { value: "000906.SH", label: "中证800" },
  { value: "000852.SH", label: "中证1000" },
];

// ---- 工具函数 -------------------------------------------------------------

function fmtPct(v: number | null | undefined, digits = 2) {
  if (v == null || Number.isNaN(v) || !Number.isFinite(v)) return "-";
  const sign = v >= 0 ? "+" : "";
  return `${sign}${v.toFixed(digits)}%`;
}

function pnlColor(v: number | null | undefined) {
  if (v == null || Number.isNaN(v)) return NEUTRAL_COLOR;
  if (v > 0) return POS_COLOR;
  if (v < 0) return NEG_COLOR;
  return NEUTRAL_COLOR;
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

function slotKey(slots: number[]): string {
  if (!slots || !slots.length) return "未分配";
  return slots.map((s) => `#${s}`).join(",");
}

// ---- 数据获取 -------------------------------------------------------------

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

// ---- 类型 -----------------------------------------------------------------

// 单只股票在区间内的偏离归因结果
interface DeviationRow {
  stock_code: string;
  // 末日所在槽位（若末日已不持仓，取末次出现的槽位）
  latest_slot_idx: number[];
  held_at_end: boolean;
  // 区间内活跃天数（持仓即 +1）
  active_days: number;
  // Σ 当日权重（用于算 平均权重 = sum_weight / active_days）
  sum_weight: number;
  // 平均权重 (sum_weight / active_days)
  avg_weight: number;
  // 累加：Σ 当日权重 × 当日个股 pct_chg → 该股对组合收益的累计贡献（线性近似）
  ret_contrib_pct: number;
  // 累加：Σ 当日权重 × 当日基准 pct_chg → 假设这块仓位换成指数的累计贡献
  bench_contrib_pct: number;
  // 累加：Σ 当日权重 × (个股 pct_chg − 基准 pct_chg) → 该股的超额贡献
  excess_contrib_pct: number;
  // 区间个股累计涨跌（连乘 1+pct_chg − 1）
  stock_period_return_pct: number | null;
  // 区间内有任意一天数据来自实时
  has_realtime: boolean;
  // 区间内含停牌天（pct_chg 为 null 或 close 为 null）
  has_suspended_day: boolean;
  // 缺数据兜底为 0 的天数（pct_chg 缺失但仍持仓）
  missing_pct_days: number;
}

// ---- 主组件 ---------------------------------------------------------------

export default function Deviation() {
  const [navData, setNavData] = useState<NavPoint[]>([]);
  const [navLoading, setNavLoading] = useState(true);
  const [navError, setNavError] = useState("");

  const [range, setRange] = useState<[Dayjs, Dayjs] | null>(null);
  const [selectedIndex, setSelectedIndex] = useState<string>("000905.SH");
  const [chartMode, setChartMode] = useState<"stock" | "slot">("stock");
  const [tableSort, setTableSort] = useState<"gain" | "loss">("gain");

  const [holdingsByDate, setHoldingsByDate] = useState<
    Map<string, HoldingsDailyResponse>
  >(new Map());
  const [indexByDate, setIndexByDate] = useState<Map<string, IndexDailyPoint>>(
    new Map()
  );
  const [loadingPeriod, setLoadingPeriod] = useState(false);
  const [periodError, setPeriodError] = useState("");
  const [partialErrors, setPartialErrors] = useState<Map<string, string>>(
    new Map()
  );

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

  const snapToTradingDay = useMemo(
    () => (d: string, direction: -1 | 1): string | null => {
      if (!navData.length) return null;
      if (direction === 1) {
        for (const n of navData) if (n.date >= d) return n.date;
        return null;
      } else {
        let last: string | null = null;
        for (const n of navData) {
          if (n.date <= d) last = n.date;
          else break;
        }
        return last;
      }
    },
    [navData]
  );

  const tradingDays = useMemo(() => {
    if (!range || !navData.length) return [] as string[];
    const start = range[0].format("YYYY-MM-DD");
    const end = range[1].format("YYYY-MM-DD");
    return navData
      .filter((n) => n.date >= start && n.date <= end)
      .map((n) => n.date);
  }, [range, navData]);

  const preStartDate = useMemo(() => {
    if (!tradingDays.length) return null;
    const idx = navData.findIndex((n) => n.date === tradingDays[0]);
    if (idx <= 0) return null;
    return navData[idx - 1].date;
  }, [tradingDays, navData]);

  const tooManyDays = tradingDays.length > MAX_TRADING_DAYS;

  // 2) 区间或指数变化时拉数据
  useEffect(() => {
    if (!tradingDays.length || tooManyDays) {
      setHoldingsByDate(new Map());
      setIndexByDate(new Map());
      setPartialErrors(new Map());
      setPeriodError("");
      return;
    }

    const signal = { cancelled: false };
    setLoadingPeriod(true);
    setPeriodError("");
    setPartialErrors(new Map());

    const start = tradingDays[0];
    const end = tradingDays[tradingDays.length - 1];
    const startCompact = start.replace(/-/g, "");
    const endCompact = end.replace(/-/g, "");

    const pHoldings = fetchHoldingsDailyConcurrent(
      tradingDays,
      MAX_CONCURRENT_DAILY,
      signal
    );
    const pIndex = api.indexDaily(selectedIndex, startCompact, endCompact);

    Promise.all([pHoldings, pIndex])
      .then(([holdRes, idxRes]) => {
        if (signal.cancelled) return;
        setHoldingsByDate(holdRes.map);
        setPartialErrors(holdRes.errors);
        const im = new Map<string, IndexDailyPoint>();
        for (const p of idxRes.data) {
          // trade_date 是 YYYYMMDD，转成 YYYY-MM-DD 与 nav 一致
          const ymd = p.trade_date.replace(
            /(\d{4})(\d{2})(\d{2})/,
            "$1-$2-$3"
          );
          im.set(ymd, p);
        }
        setIndexByDate(im);
      })
      .catch((e) => {
        if (signal.cancelled) return;
        setPeriodError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!signal.cancelled) setLoadingPeriod(false);
      });

    return () => {
      signal.cancelled = true;
    };
  }, [tradingDays, tooManyDays, selectedIndex]);

  // 3) 核心：偏离归因主聚合
  const result = useMemo(() => {
    if (!tradingDays.length || tooManyDays || !holdingsByDate.size) {
      return null;
    }

    const rowsMap = new Map<string, DeviationRow>();
    // 当日基准收益率列表（用于汇总）
    const dailyBench: Array<number | null> = [];
    const dailyPortfolio: Array<number | null> = [];
    // cash 拖累累加
    let cashContribPct = 0;
    let benchSumLinearCash = 0;
    // 末日 latest_slot_idx 准备
    const lastSlotByCode = new Map<string, number[]>();

    const ensureRow = (code: string): DeviationRow => {
      let r = rowsMap.get(code);
      if (!r) {
        r = {
          stock_code: code,
          latest_slot_idx: [],
          held_at_end: false,
          active_days: 0,
          sum_weight: 0,
          avg_weight: 0,
          ret_contrib_pct: 0,
          bench_contrib_pct: 0,
          excess_contrib_pct: 0,
          stock_period_return_pct: null,
          has_realtime: false,
          has_suspended_day: false,
          missing_pct_days: 0,
        };
        rowsMap.set(code, r);
      }
      return r;
    };

    // 用于累乘连续涨跌的辅助：Π(1 + r_i / 100) - 1
    const pctSeriesByCode = new Map<string, number[]>();
    const lastDay = tradingDays[tradingDays.length - 1];

    for (const d of tradingDays) {
      const hold = holdingsByDate.get(d);
      const navPoint = navByDate.get(d);
      const idxPt = indexByDate.get(d);
      const benchPct = idxPt?.pct_chg ?? null;

      dailyBench.push(benchPct);
      dailyPortfolio.push(navPoint?.day_return ?? navPoint?.return_pct ?? null);

      if (!hold) {
        // 当日 holdings/daily 拉取失败，整体当日跳过
        continue;
      }
      if (!navPoint || !navPoint.total_value || navPoint.total_value <= 0) {
        // 无法计算权重
        continue;
      }

      const totalValue = navPoint.total_value;
      let positionWeightSum = 0;

      for (const it of hold.items) {
        const code = it.stock_code;
        const r = ensureRow(code);
        if (it.is_realtime) r.has_realtime = true;

        // 估权重的价格：优先 close，停牌时回退 pre_close（保证停牌仓位仍计入归因）
        const suspended = it.close == null;
        const priceForWeight =
          it.close != null ? it.close : it.pre_close ?? null;

        if (suspended) r.has_suspended_day = true;

        if (priceForWeight == null) {
          // 完全没有价格（连昨收都缺），无法估权重，仅记 active_days 和 slot
          r.active_days += 1;
          if (it.slot_idx?.length) lastSlotByCode.set(code, it.slot_idx);
          if (d === lastDay) {
            r.held_at_end = it.shares > 0;
            r.latest_slot_idx = it.slot_idx ?? [];
          }
          continue;
        }

        const w = (it.shares * priceForWeight) / totalValue; // 0~1
        positionWeightSum += w;

        r.active_days += 1;
        r.sum_weight += w;

        if (it.slot_idx?.length) lastSlotByCode.set(code, it.slot_idx);
        if (d === lastDay) {
          r.held_at_end = it.shares > 0;
          r.latest_slot_idx = it.slot_idx ?? [];
        }

        // 停牌当日个股 pct_chg 视为 0（个股不动），但仍参与与基准的对比
        let stockPct: number | null;
        if (suspended) {
          stockPct = 0;
        } else if (it.pct_chg == null) {
          // 非停牌但缺涨跌幅（极少数数据缺失），权重计入但不贡献
          r.missing_pct_days += 1;
          continue;
        } else {
          stockPct = it.pct_chg;
        }

        // 单日贡献（百分比点）
        const retC = w * stockPct; // 该股对当日组合收益的贡献，单位 %
        r.ret_contrib_pct += retC;
        if (benchPct != null) {
          const benchC = w * benchPct;
          r.bench_contrib_pct += benchC;
          r.excess_contrib_pct += retC - benchC;
        } else {
          r.bench_contrib_pct += 0;
          r.excess_contrib_pct += retC;
        }

        // 累乘准备：股票区间真实涨跌 = Π(1 + pct_chg/100) − 1（停牌当 0 计入）
        let arr = pctSeriesByCode.get(code);
        if (!arr) {
          arr = [];
          pctSeriesByCode.set(code, arr);
        }
        arr.push(stockPct);
      }

      // 现金部分：cash_d = 1 − Σ w_i_d；现金的"未做指数配置"贡献 = -cash_d × benchPct
      const cashWeight = Math.max(0, 1 - positionWeightSum);
      if (benchPct != null) {
        cashContribPct += -cashWeight * benchPct;
        benchSumLinearCash += cashWeight * benchPct;
      }
    }

    // 后处理：avg_weight 与 stock_period_return_pct
    const rows: DeviationRow[] = [];
    for (const r of rowsMap.values()) {
      r.avg_weight = r.active_days > 0 ? r.sum_weight / r.active_days : 0;
      // 末日已不持仓但 active 过的股票，latest_slot_idx 取最近一次记录
      if (!r.latest_slot_idx.length) {
        const fallback = lastSlotByCode.get(r.stock_code);
        if (fallback) r.latest_slot_idx = fallback;
      }
      const arr = pctSeriesByCode.get(r.stock_code);
      if (arr && arr.length) {
        let cum = 1;
        for (const p of arr) cum *= 1 + p / 100;
        r.stock_period_return_pct = (cum - 1) * 100;
      }
      rows.push(r);
    }

    rows.sort((a, b) => b.excess_contrib_pct - a.excess_contrib_pct);

    // 汇总
    const sumExcess = rows.reduce((s, r) => s + r.excess_contrib_pct, 0);
    const sumRetContrib = rows.reduce((s, r) => s + r.ret_contrib_pct, 0);
    const sumBenchContrib = rows.reduce((s, r) => s + r.bench_contrib_pct, 0);
    const sumWeight = rows.reduce((s, r) => s + r.sum_weight, 0);
    const avgPosRatio = tradingDays.length > 0 ? sumWeight / tradingDays.length : 0;

    // 区间真实组合收益（与 PeriodContributions 同口径，使用 nav）
    let portfolioPeriodReturn: number | null = null;
    let benchPeriodReturn: number | null = null;
    let actualExcess: number | null = null;

    if (preStartDate) {
      const navPrev = navByDate.get(preStartDate);
      const navEnd = navByDate.get(lastDay);
      if (navPrev?.total_value && navEnd?.total_value) {
        portfolioPeriodReturn =
          ((navEnd.total_value - navPrev.total_value) / navPrev.total_value) * 100;
      }
    }

    // 基准区间真实收益：从 indexByDate 取首尾，需要 preStartDate 的 close 才能严格对齐组合
    // 这里用 indexDaily 在区间内的连乘
    {
      let cum = 1;
      let any = false;
      for (const d of tradingDays) {
        const idxPt = indexByDate.get(d);
        if (idxPt?.pct_chg != null) {
          cum *= 1 + idxPt.pct_chg / 100;
          any = true;
        }
      }
      if (any) benchPeriodReturn = (cum - 1) * 100;
    }

    if (portfolioPeriodReturn != null && benchPeriodReturn != null) {
      actualExcess = portfolioPeriodReturn - benchPeriodReturn;
    }

    const positives = rows.filter((r) => r.excess_contrib_pct > 0);
    const negatives = rows.filter((r) => r.excess_contrib_pct < 0);
    const positiveSum = positives.reduce((s, r) => s + r.excess_contrib_pct, 0);
    const negativeSum = negatives.reduce((s, r) => s + r.excess_contrib_pct, 0);

    const heldAtEndCount = rows.filter((r) => r.held_at_end).length;
    const hasRealtime = rows.some((r) => r.has_realtime);

    return {
      rows,
      summary: {
        sumExcess,
        sumRetContrib,
        sumBenchContrib,
        cashContribPct,
        benchSumLinearCash,
        avgPosRatio, // 区间内平均仓位率（0~1）
        portfolioPeriodReturn,
        benchPeriodReturn,
        actualExcess,
        positives: positives.length,
        negatives: negatives.length,
        positiveSum,
        negativeSum,
        topGainer: positives.length ? positives[0] : null,
        topLoser: negatives.length ? negatives[negatives.length - 1] : null,
        heldAtEndCount,
        hasRealtime,
      },
    };
  }, [
    tradingDays,
    tooManyDays,
    holdingsByDate,
    indexByDate,
    navByDate,
    preStartDate,
  ]);

  // 4) 区间内组合 vs 基准的归一化净值与累计收益曲线（与 Dashboard 同口径，仅范围限定到所选区间）
  const comparisonData = useMemo(() => {
    if (!tradingDays.length || tooManyDays) return null;
    // 仅取区间内同时有 nav 和 index 数据的交易日
    const commonDates: string[] = [];
    for (const d of tradingDays) {
      if (navByDate.has(d) && indexByDate.has(d)) commonDates.push(d);
    }
    if (commonDates.length < 2) return null;

    const firstNav = navByDate.get(commonDates[0])!.total_value;
    const firstIdx = indexByDate.get(commonDates[0])!.close;
    if (!firstNav || !firstIdx) return null;

    const dates: string[] = [];
    const portfolioNav: number[] = [];
    const indexNav: number[] = [];
    const portfolioReturns: number[] = [];
    const indexReturns: number[] = [];
    const excessReturns: number[] = [];

    for (const d of commonDates) {
      const nv = navByDate.get(d)!.total_value;
      const ix = indexByDate.get(d)!.close;
      const pNorm = nv / firstNav;
      const iNorm = ix / firstIdx;
      const pRet = (pNorm - 1) * 100;
      const iRet = (iNorm - 1) * 100;
      dates.push(d);
      portfolioNav.push(Number(pNorm.toFixed(4)));
      indexNav.push(Number(iNorm.toFixed(4)));
      portfolioReturns.push(Number(pRet.toFixed(4)));
      indexReturns.push(Number(iRet.toFixed(4)));
      excessReturns.push(Number((pRet - iRet).toFixed(4)));
    }

    return {
      dates,
      portfolioNav,
      indexNav,
      portfolioReturns,
      indexReturns,
      excessReturns,
    };
  }, [tradingDays, tooManyDays, navByDate, indexByDate]);

  const indexLabel =
    INDEX_OPTIONS.find((o) => o.value === selectedIndex)?.label ?? selectedIndex;

  // 5) 按槽位聚合的偏离归因（用 latest_slot_idx 作为分组键；多槽位股票把贡献按槽位均摊）
  const slotRows = useMemo(() => {
    if (!result) return [] as Array<{
      slot_label: string;
      excess_contrib_pct: number;
      ret_contrib_pct: number;
      bench_contrib_pct: number;
      sum_weight: number;
      stock_count: number;
      members: Array<{ code: string; partial_pct: number }>;
    }>;
    const map = new Map<
      string,
      {
        slot_label: string;
        excess_contrib_pct: number;
        ret_contrib_pct: number;
        bench_contrib_pct: number;
        sum_weight: number;
        codes: Set<string>;
        members: Array<{ code: string; partial_pct: number }>;
      }
    >();
    for (const r of result.rows) {
      const slots = r.latest_slot_idx?.length ? r.latest_slot_idx : [];
      const n = Math.max(1, slots.length);
      const labels = slots.length ? slots.map((s) => `#${s}`) : ["未分配"];
      for (const label of labels) {
        let agg = map.get(label);
        if (!agg) {
          agg = {
            slot_label: label,
            excess_contrib_pct: 0,
            ret_contrib_pct: 0,
            bench_contrib_pct: 0,
            sum_weight: 0,
            codes: new Set(),
            members: [],
          };
          map.set(label, agg);
        }
        const partial = r.excess_contrib_pct / n;
        agg.excess_contrib_pct += partial;
        agg.ret_contrib_pct += r.ret_contrib_pct / n;
        agg.bench_contrib_pct += r.bench_contrib_pct / n;
        agg.sum_weight += r.sum_weight / n;
        agg.codes.add(r.stock_code);
        agg.members.push({ code: r.stock_code, partial_pct: partial });
      }
    }
    for (const agg of map.values()) {
      agg.members.sort(
        (a, b) => Math.abs(b.partial_pct) - Math.abs(a.partial_pct)
      );
    }
    return [...map.values()]
      .map((agg) => ({
        slot_label: agg.slot_label,
        excess_contrib_pct: agg.excess_contrib_pct,
        ret_contrib_pct: agg.ret_contrib_pct,
        bench_contrib_pct: agg.bench_contrib_pct,
        sum_weight: agg.sum_weight,
        stock_count: agg.codes.size,
        members: agg.members,
      }))
      .sort((a, b) => b.excess_contrib_pct - a.excess_contrib_pct);
  }, [result]);

  // 6) 偏离归因图表 option（按股票 / 按槽位，正/负分两图）
  const attribOptions = useMemo(() => {
    const buildStockOption = (
      subset: DeviationRow[],
      color: string,
      isLoss = false
    ) => {
      if (!subset.length) return null;
      const initialWindow = 30;
      const sorted = [...subset].sort(
        (a, b) =>
          Math.abs(b.excess_contrib_pct) - Math.abs(a.excess_contrib_pct)
      );
      const codes = sorted.map((r) => r.stock_code);
      const data = sorted.map((r) => ({
        value: Number(r.excess_contrib_pct.toFixed(4)),
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
              `超额贡献: <b>${fmtPct(r.excess_contrib_pct, 4)}</b>`,
              `个股贡献: <span style="color:${pnlColor(
                r.ret_contrib_pct
              )}">${fmtPct(r.ret_contrib_pct, 4)}</span>`,
              `基准贡献: <span style="color:${pnlColor(
                r.bench_contrib_pct
              )}">${fmtPct(r.bench_contrib_pct, 4)}</span>`,
              `平均权重: ${(r.avg_weight * 100).toFixed(2)}%`,
              `区间真实涨跌: <span style="color:${pnlColor(
                r.stock_period_return_pct
              )}">${fmtPct(r.stock_period_return_pct, 2)}</span>`,
              `活跃天数: ${r.active_days}`,
            ];
            if (r.has_suspended_day) {
              lines.push('<span style="color:#faad14">含停牌天</span>');
            }
            if (r.missing_pct_days > 0) {
              lines.push(
                `<span style="color:#faad14">缺涨跌幅天数: ${r.missing_pct_days}</span>`
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
          name: "超额贡献 %",
          nameLocation: "end" as const,
          nameGap: 14,
          nameTextStyle: { fontSize: 11, color: "rgba(255,255,255,0.65)" },
          axisLabel: { formatter: (v: number) => v.toFixed(2) },
          min: yMin,
          max: yMax,
        },
        series: [
          {
            type: "bar" as const,
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
          Math.abs(b.excess_contrib_pct) - Math.abs(a.excess_contrib_pct)
      );
      const labels = sorted.map((s) => s.slot_label);
      const data = sorted.map((s) => ({
        value: Number(s.excess_contrib_pct.toFixed(4)),
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
            const lines = [
              `<b>${s.slot_label === "未分配" ? "未分配 / 已清" : `槽位 ${s.slot_label}`}</b>`,
              `超额贡献: <b>${fmtPct(s.excess_contrib_pct, 4)}</b>`,
              `个股贡献: <span style="color:${pnlColor(
                s.ret_contrib_pct
              )}">${fmtPct(s.ret_contrib_pct, 4)}</span>`,
              `基准贡献: <span style="color:${pnlColor(
                s.bench_contrib_pct
              )}">${fmtPct(s.bench_contrib_pct, 4)}</span>`,
              `成员: ${s.stock_count} 只`,
            ];
            if (s.members.length) {
              const head =
                '<div style="margin-top:4px;border-top:1px solid rgba(255,255,255,0.15);padding-top:4px">成员超额贡献:</div>';
              const body = s.members
                .slice(0, 10)
                .map((m) => {
                  const c = m.partial_pct >= 0 ? POS_COLOR : NEG_COLOR;
                  return `${m.code}: <span style="color:${c}">${fmtPct(
                    m.partial_pct,
                    4
                  )}</span>`;
                })
                .join("<br/>");
              lines.push(head + body);
              if (s.members.length > 10) {
                lines.push(
                  `<span style="color:rgba(255,255,255,0.45)">…及其他 ${
                    s.members.length - 10
                  } 只</span>`
                );
              }
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
          name: "超额贡献 %",
          nameLocation: "end" as const,
          nameGap: 14,
          nameTextStyle: { fontSize: 11, color: "rgba(255,255,255,0.65)" },
          axisLabel: { formatter: (v: number) => v.toFixed(2) },
          min: yMin,
          max: yMax,
        },
        series: [
          {
            type: "bar" as const,
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

    if (!result) return { gain: null, loss: null };
    if (chartMode === "slot") {
      const positives = slotRows.filter((s) => s.excess_contrib_pct > 0);
      const negatives = slotRows.filter((s) => s.excess_contrib_pct < 0);
      return {
        gain: buildSlotOption(positives, POS_COLOR),
        loss: buildSlotOption(negatives, NEG_COLOR, true),
      };
    }
    const positives = result.rows.filter((r) => r.excess_contrib_pct > 0);
    const negatives = result.rows.filter((r) => r.excess_contrib_pct < 0);
    return {
      gain: buildStockOption(positives, POS_COLOR),
      loss: buildStockOption(negatives, NEG_COLOR, true),
    };
  }, [result, slotRows, chartMode, isMobile]);

  // 7) 偏离归因 · 每日超额柱状（Σ 个股权重×(个股 pct − 基准 pct)）
  const dailyExcessOption = useMemo(() => {
    if (!result || !tradingDays.length) return null;
    const dates: string[] = [];
    const values: number[] = [];
    for (const d of tradingDays) {
      const hold = holdingsByDate.get(d);
      const navPoint = navByDate.get(d);
      const idxPt = indexByDate.get(d);
      const benchPct = idxPt?.pct_chg;
      if (!hold || !navPoint?.total_value || benchPct == null) {
        dates.push(d);
        values.push(0);
        continue;
      }
      const totalValue = navPoint.total_value;
      let excess = 0;
      for (const it of hold.items) {
        if (it.close == null || it.pct_chg == null) continue;
        const w = (it.shares * it.close) / totalValue;
        excess += w * (it.pct_chg - benchPct);
      }
      dates.push(d);
      values.push(Number(excess.toFixed(4)));
    }
    if (!values.length) return null;
    const { yMin, yMax } = computeAxisRange(values);
    return {
      tooltip: {
        trigger: "axis" as const,
        confine: true,
        axisPointer: { type: "shadow" as const },
        formatter: (params: any) => {
          if (!Array.isArray(params) || !params.length) return "";
          const p = params[0];
          const v = p.value as number;
          return `${p.axisValueLabel}<br/>${p.marker} 当日超额(线性): <b style="color:${pnlColor(
            v
          )}">${fmtPct(v, 4)}</b>`;
        },
      },
      grid: isMobile
        ? { left: 50, right: 16, top: 30, bottom: 36, containLabel: true }
        : { left: 64, right: 30, top: 40, bottom: 30, containLabel: true },
      xAxis: {
        type: "category" as const,
        data: dates,
        axisLabel: isMobile ? { rotate: 45, fontSize: 10 } : { rotate: 30 },
      },
      yAxis: {
        type: "value" as const,
        name: "超额 %",
        axisLabel: { formatter: (v: number) => v.toFixed(2) },
        min: yMin,
        max: yMax,
      },
      series: [
        {
          type: "bar" as const,
          data: values.map((v) => ({
            value: v,
            itemStyle: { color: v >= 0 ? POS_COLOR : NEG_COLOR },
          })),
          barMaxWidth: 18,
        },
      ],
    };
  }, [result, tradingDays, holdingsByDate, navByDate, indexByDate, isMobile]);

  // 8) 明细表格 columns
  const tableColumns = useMemo(
    () => [
      {
        title: "股票代码",
        dataIndex: "stock_code",
        key: "stock_code",
        fixed: "left" as const,
        width: 130,
      },
      {
        title: "槽位",
        dataIndex: "latest_slot_idx",
        key: "latest_slot_idx",
        width: 110,
        render: (slots: number[]) => {
          if (!slots?.length)
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
        },
      },
      {
        title: () => (
          <span>
            平均权重{" "}
            <Tooltip title="区间内 Σ 当日权重 / 活跃天数。">
              <InfoCircleOutlined style={{ color: "rgba(255,255,255,0.45)" }} />
            </Tooltip>
          </span>
        ),
        dataIndex: "avg_weight",
        key: "avg_weight",
        width: 110,
        render: (v: number) => `${(v * 100).toFixed(2)}%`,
      },
      {
        title: () => (
          <span>
            个股贡献{" "}
            <Tooltip title="Σ 当日权重 × 个股当日收益率（百分点，线性近似）">
              <InfoCircleOutlined style={{ color: "rgba(255,255,255,0.45)" }} />
            </Tooltip>
          </span>
        ),
        dataIndex: "ret_contrib_pct",
        key: "ret_contrib_pct",
        width: 120,
        render: (v: number) => (
          <span style={{ color: pnlColor(v) }}>{fmtPct(v, 4)}</span>
        ),
      },
      {
        title: () => (
          <span>
            基准贡献{" "}
            <Tooltip title="Σ 当日权重 × 基准当日收益率（假设这块仓位换成指数）">
              <InfoCircleOutlined style={{ color: "rgba(255,255,255,0.45)" }} />
            </Tooltip>
          </span>
        ),
        dataIndex: "bench_contrib_pct",
        key: "bench_contrib_pct",
        width: 120,
        render: (v: number) => (
          <span style={{ color: pnlColor(v) }}>{fmtPct(v, 4)}</span>
        ),
      },
      {
        title: () => (
          <span>
            超额贡献{" "}
            <Tooltip title="Σ 当日权重 × (个股收益率 − 基准收益率)">
              <InfoCircleOutlined style={{ color: "rgba(255,255,255,0.45)" }} />
            </Tooltip>
          </span>
        ),
        dataIndex: "excess_contrib_pct",
        key: "excess_contrib_pct",
        width: 130,
        render: (v: number) => (
          <span style={{ color: pnlColor(v), fontWeight: 600 }}>
            {fmtPct(v, 4)}
          </span>
        ),
      },
      {
        title: "活跃天数",
        dataIndex: "active_days",
        key: "active_days",
        width: 90,
      },
    ],
    []
  );

  const sortedRows = useMemo(() => {
    if (!result) return [] as DeviationRow[];
    const arr = [...result.rows];
    arr.sort((a, b) =>
      tableSort === "gain"
        ? b.excess_contrib_pct - a.excess_contrib_pct
        : a.excess_contrib_pct - b.excess_contrib_pct
    );
    return arr;
  }, [result, tableSort]);

  // ---- 渲染 ---------------------------------------------------------------

  if (navLoading) {
    return (
      <Spin size="large" style={{ display: "block", margin: "100px auto" }} />
    );
  }
  if (navError) return <Alert type="error" message={navError} />;

  const minDate = navData.length ? dayjs(navData[0].date) : undefined;
  const maxDate = navData.length
    ? dayjs(navData[navData.length - 1].date)
    : undefined;

  const rangePicker = (
    <DatePicker.RangePicker
      value={range as [Dayjs, Dayjs] | null}
      onChange={(v) => {
        if (!v || !v[0] || !v[1]) {
          setRange(null);
          return;
        }
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
    />
  );

  const summary = result?.summary;

  const summaryCardsRow1 = summary && (
    <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
      <Col xs={12} sm={6}>
        <Card size={isMobile ? "small" : "default"}>
          <Statistic
            title="区间组合收益"
            value={summary.portfolioPeriodReturn ?? 0}
            precision={2}
            suffix="%"
            valueStyle={{ color: pnlColor(summary.portfolioPeriodReturn) }}
            prefix={
              (summary.portfolioPeriodReturn ?? 0) >= 0 ? (
                <ArrowUpOutlined />
              ) : (
                <ArrowDownOutlined />
              )
            }
          />
        </Card>
      </Col>
      <Col xs={12} sm={6}>
        <Card size={isMobile ? "small" : "default"}>
          <Statistic
            title={`${indexLabel}收益`}
            value={summary.benchPeriodReturn ?? 0}
            precision={2}
            suffix="%"
            valueStyle={{ color: pnlColor(summary.benchPeriodReturn) }}
            prefix={
              (summary.benchPeriodReturn ?? 0) >= 0 ? (
                <ArrowUpOutlined />
              ) : (
                <ArrowDownOutlined />
              )
            }
          />
        </Card>
      </Col>
      <Col xs={12} sm={6}>
        <Card size={isMobile ? "small" : "default"}>
          <Statistic
            title={
              <Tooltip title="实际超额 = 区间组合收益 − 区间基准收益">
                <span>
                  实际超额收益 <InfoCircleOutlined style={{ fontSize: 11 }} />
                </span>
              </Tooltip>
            }
            value={summary.actualExcess ?? 0}
            precision={2}
            suffix="%"
            valueStyle={{
              color: pnlColor(summary.actualExcess),
              fontWeight: 700,
            }}
            prefix={
              (summary.actualExcess ?? 0) >= 0 ? (
                <RiseOutlined />
              ) : (
                <FallOutlined />
              )
            }
          />
        </Card>
      </Col>
      <Col xs={12} sm={6}>
        <Card size={isMobile ? "small" : "default"}>
          <Statistic
            title={
              <Tooltip title="逐日 Σ 个股权重×(个股涨跌−基准涨跌) 累加（线性近似）。与「实际超额」之差源于复利、现金/未配置仓位、以及对未持有指数成分股的近似处理">
                <span>
                  归因合计(线性) <InfoCircleOutlined style={{ fontSize: 11 }} />
                </span>
              </Tooltip>
            }
            value={summary.sumExcess}
            precision={2}
            suffix="%"
            valueStyle={{ color: pnlColor(summary.sumExcess) }}
          />
          <div style={{ marginTop: 4, fontSize: 11, color: NEUTRAL_COLOR }}>
            +现金拖累 {fmtPct(summary.cashContribPct, 2)}
          </div>
        </Card>
      </Col>
    </Row>
  );

  const summaryCardsRow2 = summary && (
    <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
      <Col xs={12} sm={6}>
        <Card size={isMobile ? "small" : "default"}>
          <Statistic
            title={
              <Tooltip title="区间内组合的平均仓位率 = Σ 每日权重之和 / 总天数。1 − 仓位率 即平均现金占比">
                <span>
                  平均仓位率 <InfoCircleOutlined style={{ fontSize: 11 }} />
                </span>
              </Tooltip>
            }
            value={summary.avgPosRatio * 100}
            precision={1}
            suffix="%"
          />
          <div style={{ marginTop: 4, fontSize: 11, color: NEUTRAL_COLOR }}>
            现金占比 {((1 - summary.avgPosRatio) * 100).toFixed(1)}%
          </div>
        </Card>
      </Col>
      <Col xs={12} sm={6}>
        <Card size={isMobile ? "small" : "default"}>
          <span style={{ fontSize: 14 }}>正/负超额贡献</span>
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 12,
              marginTop: 8,
              flexWrap: "wrap",
            }}
          >
            <span style={{ color: POS_COLOR, fontWeight: 600 }}>
              <span style={{ fontSize: isMobile ? 18 : 22 }}>
                {summary.positives}
              </span>
              <span style={{ fontSize: 12, marginLeft: 2 }}>只</span>
            </span>
            <span style={{ color: NEUTRAL_COLOR, fontSize: 14 }}>/</span>
            <span style={{ color: NEG_COLOR, fontWeight: 600 }}>
              <span style={{ fontSize: isMobile ? 18 : 22 }}>
                {summary.negatives}
              </span>
              <span style={{ fontSize: 12, marginLeft: 2 }}>只</span>
            </span>
          </div>
          <div style={{ marginTop: 4, fontSize: 11 }}>
            <span style={{ color: POS_COLOR }}>
              +{fmtPct(summary.positiveSum, 2).replace(/^\+/, "")}
            </span>
            <span style={{ color: NEUTRAL_COLOR }}> · </span>
            <span style={{ color: NEG_COLOR }}>
              {fmtPct(summary.negativeSum, 2)}
            </span>
          </div>
        </Card>
      </Col>
      <Col xs={12} sm={6}>
        <Card size={isMobile ? "small" : "default"}>
          <Statistic
            title={
              <Tooltip title="未持仓现金对超额的影响 = Σ (−现金权重 × 基准当日涨跌)。基准上涨时为拖累（负），基准下跌时为正贡献。">
                <span>
                  现金影响 <InfoCircleOutlined style={{ fontSize: 11 }} />
                </span>
              </Tooltip>
            }
            value={summary.cashContribPct}
            precision={4}
            suffix="%"
            valueStyle={{ color: pnlColor(summary.cashContribPct) }}
            prefix={
              summary.cashContribPct >= 0 ? (
                <ArrowUpOutlined />
              ) : (
                <ArrowDownOutlined />
              )
            }
          />
          <div style={{ marginTop: 4, fontSize: 11, color: NEUTRAL_COLOR }}>
            平均现金占比 {((1 - summary.avgPosRatio) * 100).toFixed(1)}%
          </div>
        </Card>
      </Col>
    </Row>
  );

  const partialErrorList = Array.from(partialErrors.entries());

  // 指数对比图：收益率与超额收益
  const returnsCompareOption = comparisonData && {
    tooltip: {
      trigger: "axis" as const,
      confine: true,
      formatter: (params: any) => {
        if (!Array.isArray(params)) return "";
        let html = `${params[0].axisValueLabel}<br/>`;
        for (const p of params) {
          html += `${p.marker} ${p.seriesName}: <b>${(p.value as number).toFixed(2)}%</b><br/>`;
        }
        return html;
      },
    },
    legend: {
      data: ["组合收益率", `${indexLabel}收益率`, "超额收益"],
    },
    xAxis: {
      type: "category" as const,
      data: comparisonData.dates,
      axisLabel: isMobile ? { rotate: 45, fontSize: 10 } : {},
    },
    yAxis: {
      type: "value" as const,
      name: "收益率%",
      axisLabel: { formatter: (v: number) => `${v}%` },
    },
    series: [
      {
        name: "组合收益率",
        type: "line",
        data: comparisonData.portfolioReturns,
        smooth: true,
        lineStyle: { width: 2 },
        symbol: "none",
      },
      {
        name: `${indexLabel}收益率`,
        type: "line",
        data: comparisonData.indexReturns,
        smooth: true,
        lineStyle: { width: 2 },
        symbol: "none",
      },
      {
        name: "超额收益",
        type: "line",
        data: comparisonData.excessReturns,
        smooth: true,
        lineStyle: { width: 1.5, type: "dashed" as const },
        areaStyle: { opacity: 0.1 },
        symbol: "none",
      },
    ],
    grid: isMobile
      ? { left: 50, right: 50, top: 40, bottom: 30 }
      : { left: 80, right: 80, top: 40, bottom: 30 },
  };

  return (
    <div>
      {/* 算法说明 */}
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="偏离归因 · 算法说明"
        description={
          <div style={{ fontSize: 12, lineHeight: 1.7 }}>
            采用 <b>主动持仓近似法</b>：每只股票超额贡献 = Σ 当日权重 × (个股当日涨跌 − 基准当日涨跌)。<p></p>
            假设基准成分股权重 ≈ 0（因目前暂无法获得基准指数的具体个股权重），所有持仓股都视为
            <b> 超配</b>，未持有的成分股视为 <b>低配</b>（其影响合并到「现金拖累」中）。
          </div>
        }
      />

      {periodError && (
        <Alert
          type="error"
          message={periodError}
          showIcon
          style={{ marginBottom: 12 }}
        />
      )}
      {partialErrorList.length > 0 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message={`部分日期 holdings/daily 拉取失败 (${partialErrorList.length} 天)，相关天数贡献按 0 处理`}
          description={
            <div style={{ fontSize: 12, maxHeight: 80, overflow: "auto" }}>
              {partialErrorList.slice(0, 5).map(([d, msg]) => (
                <div key={d}>
                  {d}: {msg}
                </div>
              ))}
              {partialErrorList.length > 5 && (
                <div>…及其他 {partialErrorList.length - 5} 天</div>
              )}
            </div>
          }
        />
      )}
      {tooManyDays && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message={`所选区间含 ${tradingDays.length} 个交易日，超过 ${MAX_TRADING_DAYS} 天上限，请缩短范围`}
        />
      )}
      {result && !result.rows.length && !loadingPeriod && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="区间内无持仓数据"
        />
      )}

      <Card
        title={
          <Space wrap size={[12, 8]}>
            <span>偏离归因</span>
            <Select
              value={selectedIndex}
              onChange={setSelectedIndex}
              options={INDEX_OPTIONS}
              style={{ width: 130 }}
              size={isMobile ? "small" : "middle"}
            />
            {rangePicker}
          </Space>
        }
        size={isMobile ? "small" : "default"}
      >
        {loadingPeriod ? (
          <Spin style={{ display: "block", margin: "60px auto" }} />
        ) : !result || tooManyDays ? (
          <Empty description="选择区间后查看偏离归因" />
        ) : (
          <>
            {summaryCardsRow1}
            {summaryCardsRow2}
          </>
        )}
      </Card>

      {!tooManyDays && (
        <Card
          title={`收益率对比（区间累计 · 含超额收益曲线）`}
          size={isMobile ? "small" : "default"}
          style={{ marginTop: 12 }}
        >
          {loadingPeriod ? (
            <Spin style={{ display: "block", margin: "60px auto" }} />
          ) : returnsCompareOption ? (
            <ReactECharts
              option={returnsCompareOption}
              style={{ height: isMobile ? 260 : 360 }}
            />
          ) : (
            <Empty description="区间内组合或基准数据不足，无法绘制对比图" />
          )}
        </Card>
      )}

      {!tooManyDays && (
        <Card
          title={
            <Space wrap size={[12, 8]}>
              <span>偏离归因图</span>
              <Segmented
                value={chartMode}
                onChange={(v) => setChartMode(v as "stock" | "slot")}
                options={[
                  { label: "按股票", value: "stock" },
                  { label: "按槽位", value: "slot" },
                ]}
                size={isMobile ? "small" : "middle"}
              />
            </Space>
          }
          size={isMobile ? "small" : "default"}
          style={{ marginTop: 12 }}
        >
          {loadingPeriod ? (
            <Spin style={{ display: "block", margin: "60px auto" }} />
          ) : !result ? (
            <Empty description="选择区间后查看偏离归因" />
          ) : !attribOptions.gain && !attribOptions.loss ? (
            <Empty description="区间内无可归因数据" />
          ) : (
            <div>
              <div
                style={{
                  fontSize: 12,
                  color: POS_COLOR,
                  marginBottom: 4,
                  fontWeight: 600,
                }}
              >
                正超额贡献{" "}
                {chartMode === "stock"
                  ? `（${
                      result.rows.filter((r) => r.excess_contrib_pct > 0)
                        .length
                    } 只）`
                  : `（${
                      slotRows.filter((s) => s.excess_contrib_pct > 0).length
                    } 个槽位）`}
              </div>
              {attribOptions.gain ? (
                <ReactECharts
                  option={attribOptions.gain}
                  style={{ height: isMobile ? 260 : 360 }}
                />
              ) : (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="无正贡献"
                />
              )}

              <div
                style={{
                  fontSize: 12,
                  color: NEG_COLOR,
                  marginTop: 16,
                  marginBottom: 4,
                  fontWeight: 600,
                }}
              >
                负超额贡献{" "}
                {chartMode === "stock"
                  ? `（${
                      result.rows.filter((r) => r.excess_contrib_pct < 0)
                        .length
                    } 只）`
                  : `（${
                      slotRows.filter((s) => s.excess_contrib_pct < 0).length
                    } 个槽位）`}
              </div>
              {attribOptions.loss ? (
                <ReactECharts
                  option={attribOptions.loss}
                  style={{ height: isMobile ? 260 : 360 }}
                />
              ) : (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="无负贡献"
                />
              )}
            </div>
          )}
        </Card>
      )}

      {!tooManyDays && (
        <Card
          title="每日超额"
          size={isMobile ? "small" : "default"}
          style={{ marginTop: 12 }}
        >
          {loadingPeriod ? (
            <Spin style={{ display: "block", margin: "60px auto" }} />
          ) : dailyExcessOption ? (
            <ReactECharts
              option={dailyExcessOption}
              style={{ height: isMobile ? 220 : 280 }}
            />
          ) : (
            <Empty description="区间内无可归因数据" />
          )}
        </Card>
      )}

      {!tooManyDays && result && result.rows.length > 0 && (
        <Card
          title={
            <Space wrap size={[12, 8]}>
              <span>偏离归因明细</span>
              <Segmented
                value={tableSort}
                onChange={(v) => setTableSort(v as "gain" | "loss")}
                options={[
                  { label: "正贡献", value: "gain" },
                  { label: "负贡献", value: "loss" },
                ]}
                size={isMobile ? "small" : "middle"}
              />
              <Tag>{result.rows.length} 只</Tag>
            </Space>
          }
          size={isMobile ? "small" : "default"}
          style={{ marginTop: 12 }}
        >
          <Table<DeviationRow>
            dataSource={sortedRows}
            columns={tableColumns as any}
            rowKey="stock_code"
            size={isMobile ? "small" : "middle"}
            pagination={{
              defaultPageSize: 20,
              showSizeChanger: true,
              pageSizeOptions: [10, 20, 50, 100],
              size: isMobile ? "small" : "default",
            }}
            scroll={{ x: 980 }}
          />
        </Card>
      )}
    </div>
  );
}
