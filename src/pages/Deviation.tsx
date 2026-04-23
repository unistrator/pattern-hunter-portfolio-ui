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

        // 用收盘价计算权重（停牌时 close 为 null，权重无法估，跳过当日）
        if (it.close == null) {
          r.has_suspended_day = true;
          r.active_days += 1;
          // 当日没有 pct_chg 也无法贡献，但 latest_slot_idx 仍记
          if (it.slot_idx?.length) lastSlotByCode.set(code, it.slot_idx);
          if (d === lastDay) {
            r.held_at_end = it.shares > 0;
            r.latest_slot_idx = it.slot_idx ?? [];
          }
          continue;
        }

        const w = (it.shares * it.close) / totalValue; // 0~1
        positionWeightSum += w;

        r.active_days += 1;
        r.sum_weight += w;

        if (it.slot_idx?.length) lastSlotByCode.set(code, it.slot_idx);
        if (d === lastDay) {
          r.held_at_end = it.shares > 0;
          r.latest_slot_idx = it.slot_idx ?? [];
        }

        const stockPct = it.pct_chg; // null 表示停牌或缺数据
        if (stockPct == null) {
          r.missing_pct_days += 1;
          // 不参与贡献，但权重已计
          // 累乘序列也跳过
          continue;
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

        // 累乘准备：股票区间真实涨跌 = Π(1 + pct_chg/100) − 1
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
  const headerTag = summary && (
    <Tag color={pnlColor(summary.actualExcess) === POS_COLOR ? "green" : pnlColor(summary.actualExcess) === NEG_COLOR ? "red" : "default"}>
      {tradingDays.length}d · 实际超额{" "}
      {fmtPct(summary.actualExcess)}
    </Tag>
  );

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
              <Tooltip title="实际超额 = 区间组合收益 − 区间基准收益（点对点复合）">
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
          <Statistic
            title={
              <Tooltip title="超配（含选股 alpha 为正）的股票数 / 累计超额贡献">
                <span>
                  正超额贡献 <InfoCircleOutlined style={{ fontSize: 11 }} />
                </span>
              </Tooltip>
            }
            value={summary.positives}
            suffix="只"
            valueStyle={{ color: POS_COLOR }}
          />
          <div style={{ marginTop: 4, fontSize: 11, color: POS_COLOR }}>
            合计 {fmtPct(summary.positiveSum, 2)}
          </div>
        </Card>
      </Col>
      <Col xs={12} sm={6}>
        <Card size={isMobile ? "small" : "default"}>
          <Statistic
            title={
              <Tooltip title="持仓中跑输基准的股票（拖累超额）">
                <span>
                  负超额贡献 <InfoCircleOutlined style={{ fontSize: 11 }} />
                </span>
              </Tooltip>
            }
            value={summary.negatives}
            suffix="只"
            valueStyle={{ color: NEG_COLOR }}
          />
          <div style={{ marginTop: 4, fontSize: 11, color: NEG_COLOR }}>
            合计 {fmtPct(summary.negativeSum, 2)}
          </div>
        </Card>
      </Col>
      <Col xs={12} sm={6}>
        <Card size={isMobile ? "small" : "default"}>
          <Statistic
            title="最大正/负贡献"
            value={
              summary.topGainer
                ? summary.topGainer.stock_code
                : summary.topLoser
                ? summary.topLoser.stock_code
                : "—"
            }
            valueStyle={{
              color: summary.topGainer ? POS_COLOR : NEG_COLOR,
              fontSize: isMobile ? 16 : 18,
            }}
          />
          <div style={{ marginTop: 4, fontSize: 11 }}>
            {summary.topGainer && (
              <span style={{ color: POS_COLOR }}>
                {summary.topGainer.stock_code}{" "}
                {fmtPct(summary.topGainer.excess_contrib_pct, 2)}
              </span>
            )}
            {summary.topGainer && summary.topLoser && (
              <span style={{ color: NEUTRAL_COLOR }}> · </span>
            )}
            {summary.topLoser && (
              <span style={{ color: NEG_COLOR }}>
                {summary.topLoser.stock_code}{" "}
                {fmtPct(summary.topLoser.excess_contrib_pct, 2)}
              </span>
            )}
          </div>
        </Card>
      </Col>
    </Row>
  );

  const partialErrorList = Array.from(partialErrors.entries());

  // 指数对比图：净值（归一化）
  const navCompareOption = comparisonData && {
    tooltip: {
      trigger: "axis" as const,
      confine: true,
      formatter: (params: any) => {
        if (!Array.isArray(params)) return "";
        let html = `${params[0].axisValueLabel}<br/>`;
        for (const p of params) {
          html += `${p.marker} ${p.seriesName}: <b>${(p.value as number).toFixed(4)}</b><br/>`;
        }
        return html;
      },
    },
    legend: { data: ["组合净值", indexLabel] },
    xAxis: {
      type: "category" as const,
      data: comparisonData.dates,
      axisLabel: isMobile ? { rotate: 45, fontSize: 10 } : {},
    },
    yAxis: {
      type: "value" as const,
      name: "归一化净值",
      scale: true,
      axisLabel: { formatter: (v: number) => v.toFixed(2) },
    },
    series: [
      {
        name: "组合净值",
        type: "line",
        data: comparisonData.portfolioNav,
        smooth: true,
        lineStyle: { width: 2 },
        symbol: "none",
      },
      {
        name: indexLabel,
        type: "line",
        data: comparisonData.indexNav,
        smooth: true,
        lineStyle: { width: 2 },
        symbol: "none",
      },
    ],
    grid: isMobile
      ? { left: 50, right: 50, top: 40, bottom: 30 }
      : { left: 80, right: 80, top: 40, bottom: 30 },
  };

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
            采用 <b>主动持仓近似法</b>：每只股票超额贡献 = Σ 当日权重 × (个股当日涨跌 − 基准当日涨跌)。
            假设基准成分股权重 ≈ 0（因后端暂不提供 <code>/api/index_weight</code>），所有持仓股都视为
            <b> 超配</b>，未持有的成分股视为 <b>低配</b>（其影响合并到「现金拖累」中）。
            真实 Brinson 配置/选股拆分需待指数成分股权重接口就绪后升级。
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
            {headerTag}
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
          title={`净值对比（区间归一化 · 起始日 = 1.00）`}
          size={isMobile ? "small" : "default"}
          style={{ marginTop: 12 }}
        >
          {loadingPeriod ? (
            <Spin style={{ display: "block", margin: "60px auto" }} />
          ) : navCompareOption ? (
            <ReactECharts
              option={navCompareOption}
              style={{ height: isMobile ? 260 : 360 }}
            />
          ) : (
            <Empty description="区间内组合或基准数据不足，无法绘制对比图" />
          )}
        </Card>
      )}

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
    </div>
  );
}
