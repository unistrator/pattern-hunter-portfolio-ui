import { useEffect, useState, useMemo } from "react";
import { Card, Col, Row, Statistic, Spin, Alert, Tag, Select } from "antd";
import {
  ArrowUpOutlined,
  ArrowDownOutlined,
  FundOutlined,
  ClockCircleOutlined,
  RiseOutlined,
  FallOutlined,
} from "@ant-design/icons";
import ReactECharts from "echarts-for-react";
import { api } from "../utils/api";
import useIsMobile from "../hooks/useIsMobile";
import type { Overview, NavPoint, IndexDailyPoint } from "../types";

const INDEX_OPTIONS = [
  { value: "000300.SH", label: "沪深300" },
  { value: "000905.SH", label: "中证500" },
  { value: "000906.SH", label: "中证800" },
  { value: "000852.SH", label: "中证1000" },
];

export default function Dashboard() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [navData, setNavData] = useState<NavPoint[]>([]);
  const [valueDate, setValueDate] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedIndex, setSelectedIndex] = useState<string>("000905.SH");
  const [indexData, setIndexData] = useState<IndexDailyPoint[]>([]);
  const [indexLoading, setIndexLoading] = useState(false);
  const isMobile = useIsMobile();

  useEffect(() => {
    Promise.all([api.overview(), api.nav(), api.holdings()])
      .then(([ov, nav, holdings]) => {
        setOverview(ov);
        setNavData(nav);
        const dates = holdings.positions
          .map((p) => p.value_updated_date)
          .filter((d): d is string => !!d);
        if (dates.length) setValueDate(dates.sort().pop()!);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!selectedIndex) return;
    setIndexLoading(true);
    const today = new Date();
    const endDate = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}`;
    api
      .indexDaily(selectedIndex, "20260101", endDate)
      .then((res) => setIndexData(res.data))
      .catch(() => setIndexData([]))
      .finally(() => setIndexLoading(false));
  }, [selectedIndex]);

  const comparisonData = useMemo(() => {
    if (!indexData.length || !navData.length) return null;

    const toYMD = (d: string) => d.replace(/-/g, "");

    const portfolioMap = new Map<string, NavPoint>();
    for (const n of navData) {
      portfolioMap.set(toYMD(n.date), n);
    }

    const indexMap = new Map<string, IndexDailyPoint>();
    for (const d of indexData) {
      indexMap.set(d.trade_date, d);
    }

    const commonDates = [...portfolioMap.keys()]
      .filter((d) => indexMap.has(d))
      .sort();

    if (commonDates.length < 2) return null;

    const firstPortfolioValue = portfolioMap.get(commonDates[0])!.total_value;
    const firstIndexClose = indexMap.get(commonDates[0])!.close;

    const dates: string[] = [];
    const portfolioNav: number[] = [];
    const indexNav: number[] = [];
    const portfolioReturns: number[] = [];
    const indexReturns: number[] = [];
    const excessReturns: number[] = [];

    for (const d of commonDates) {
      const pNav = portfolioMap.get(d)!;
      const iData = indexMap.get(d)!;

      const pNorm = pNav.total_value / firstPortfolioValue;
      const iNorm = iData.close / firstIndexClose;
      const pReturn = (pNorm - 1) * 100;
      const iReturn = (iNorm - 1) * 100;

      dates.push(d.replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3"));
      portfolioNav.push(Number(pNorm.toFixed(4)));
      indexNav.push(Number(iNorm.toFixed(4)));
      portfolioReturns.push(Number(pReturn.toFixed(2)));
      indexReturns.push(Number(iReturn.toFixed(2)));
      excessReturns.push(Number((pReturn - iReturn).toFixed(2)));
    }

    return {
      dates,
      portfolioNav,
      indexNav,
      portfolioReturns,
      indexReturns,
      excessReturns,
      latestExcess: excessReturns[excessReturns.length - 1],
      latestPortfolioReturn: portfolioReturns[portfolioReturns.length - 1],
      latestIndexReturn: indexReturns[indexReturns.length - 1],
    };
  }, [navData, indexData]);

  const lastDayStats = useMemo(() => {
    if (navData.length < 2) return null;

    const last = navData[navData.length - 1];
    const prev = navData[navData.length - 2];
    const portfolioReturn = ((last.total_value / prev.total_value) - 1) * 100;
    const lastDateYMD = last.date.replace(/-/g, "");

    const indexPoint = indexData.find(d => d.trade_date === lastDateYMD);
    const indexReturn = indexPoint?.pct_chg ?? null;

    return {
      date: last.date,
      portfolioReturn: Number(portfolioReturn.toFixed(2)),
      indexReturn: indexReturn !== null ? Number(indexReturn.toFixed(2)) : null,
    };
  }, [navData, indexData]);

  if (loading) return <Spin size="large" style={{ display: "block", margin: "100px auto" }} />;
  if (error) return <Alert type="error" message={error} />;
  if (!overview) return null;

  const dates = navData.map((n) => n.date);
  const values = navData.map((n) => n.total_value);
  const drawdowns = navData.map((n) => n.drawdown);
  const returns = navData.map((n) => n.return_pct);

  const gridMargin = isMobile
    ? { left: 50, right: 50, top: 40, bottom: 30 }
    : { left: 80, right: 80, top: 40, bottom: 30 };

  const navChartOption = {
    tooltip: {
      trigger: "axis" as const,
      confine: true,
      valueFormatter: (v: number, _name: string) => {
        if (v == null) return "-";
        return v.toString();
      },
      formatter: (params: any) => {
        if (!Array.isArray(params)) return "";
        let html = `${params[0].axisValueLabel}<br/>`;
        for (const p of params) {
          const v = p.value as number;
          const formatted =
            p.seriesName === "净值"
              ? Math.round(v).toString()
              : v.toFixed(2).replace(/\.?0+$/, "");
          html += `${p.marker} ${p.seriesName}: <b>${formatted}</b><br/>`;
        }
        return html;
      },
    },
    legend: { data: ["净值", "收益率%"] },
    xAxis: {
      type: "category" as const,
      data: dates,
      axisLabel: isMobile ? { rotate: 45, fontSize: 10 } : {},
    },
    yAxis: [
      {
        type: "value" as const,
        name: "净值",
        position: "left" as const,
        alignTicks: true,
        axisLabel: { formatter: (v: number) => Math.round(v).toString() },
      },
      {
        type: "value" as const,
        name: "收益率%",
        position: "right" as const,
        alignTicks: true,
        axisLabel: {
          formatter: (v: number) => {
            const s = v.toFixed(2);
            return s.replace(/\.?0+$/, "");
          },
        },
      },
    ],
    series: [
      {
        name: "净值",
        type: "line",
        yAxisIndex: 0,
        data: values,
        smooth: true,
        areaStyle: { opacity: 0.15 },
        lineStyle: { width: 2 },
      },
      {
        name: "收益率%",
        type: "line",
        yAxisIndex: 1,
        data: returns,
        smooth: true,
        lineStyle: { width: 1, type: "dashed" as const },
      },
    ],
    grid: gridMargin,
  };

  const ddChartOption = {
    tooltip: { trigger: "axis" as const, confine: true },
    xAxis: {
      type: "category" as const,
      data: dates,
      axisLabel: isMobile ? { rotate: 45, fontSize: 10 } : {},
    },
    yAxis: { type: "value" as const, name: "回撤%" },
    series: [
      {
        type: "line",
        data: drawdowns,
        areaStyle: { color: "rgba(255,77,79,0.3)" },
        lineStyle: { color: "#ff4d4f", width: 1 },
        itemStyle: { color: "#ff4d4f" },
      },
    ],
    grid: isMobile
      ? { left: 50, right: 16, top: 30, bottom: 30 }
      : { left: 60, right: 30, top: 30, bottom: 30 },
  };

  const cts = overview.closed_trade_stats || {} as any;
  const ops = overview.open_position_stats || {} as any;
  const isPositive = overview.total_return_pct >= 0;

  return (
    <div>
      {valueDate && (
        <div style={{ marginBottom: 12, textAlign: "right" }}>
          <Tag icon={<ClockCircleOutlined />} color="processing">
            数据更新至 {valueDate}（基于收盘价）
          </Tag>
        </div>
      )}
      <Row gutter={[12, 12]}>
        <Col xs={12} sm={6}>
          <Card size={isMobile ? "small" : "default"}>
            <Statistic
              title="总收益率"
              value={overview.total_return_pct}
              precision={2}
              suffix="%"
              valueStyle={{ color: isPositive ? "#3f8600" : "#cf1322" }}
              prefix={isPositive ? <ArrowUpOutlined /> : <ArrowDownOutlined />}
            />
          </Card>
        </Col>
        <Col xs={12} sm={6}>
          <Card size={isMobile ? "small" : "default"}>
            <Statistic
              title="最大回撤"
              value={overview.max_drawdown}
              precision={2}
              suffix="%"
              valueStyle={{ color: "#cf1322" }}
            />
          </Card>
        </Col>
        <Col xs={12} sm={6}>
          <Card size={isMobile ? "small" : "default"}>
            <Statistic title="夏普比率" value={overview.sharpe_ratio} precision={2} prefix={<FundOutlined />} />
          </Card>
        </Col>
        <Col xs={12} sm={6}>
          <Card size={isMobile ? "small" : "default"}>
            <Statistic
              title="已了结胜率"
              value={cts.win_rate ?? 0}
              precision={1}
              suffix={`% (${cts.total ?? 0}笔)`}
            />
            {!isMobile && (
              <div style={{ marginTop: 4, fontSize: 12, color: "rgba(255,255,255,0.45)" }}>
                盈{cts.winning ?? 0} / 亏{cts.losing ?? 0} · 均收益 {cts.avg_profit_pct?.toFixed(2) ?? "-"}%
              </div>
            )}
          </Card>
        </Col>
      </Row>

      <Row gutter={[12, 12]} style={{ marginTop: 12 }}>
        <Col xs={12} sm={6}>
          <Card size={isMobile ? "small" : "default"}>
            <Statistic
              title="持仓胜率"
              value={ops.win_rate ?? 0}
              precision={1}
              suffix={`% (${ops.total ?? 0}只)`}
            />
            {!isMobile && (
              <div style={{ marginTop: 4, fontSize: 12, color: "rgba(255,255,255,0.45)" }}>
                浮盈{ops.winning ?? 0} / 浮亏{ops.losing ?? 0}
              </div>
            )}
          </Card>
        </Col>
        {lastDayStats && (
          <>
            <Col xs={12} sm={6}>
              <Card size={isMobile ? "small" : "default"}>
                <Statistic
                  title="当日组合收益"
                  value={lastDayStats.portfolioReturn}
                  precision={2}
                  suffix="%"
                  valueStyle={{ color: lastDayStats.portfolioReturn >= 0 ? "#3f8600" : "#cf1322" }}
                  prefix={lastDayStats.portfolioReturn >= 0 ? <ArrowUpOutlined /> : <ArrowDownOutlined />}
                />
                <div style={{ marginTop: 4, fontSize: 12, color: "rgba(255,255,255,0.45)" }}>
                  {lastDayStats.date}
                </div>
              </Card>
            </Col>
            <Col xs={12} sm={6}>
              <Card size={isMobile ? "small" : "default"}>
                <Statistic
                  title="当日中证500"
                  value={lastDayStats.indexReturn ?? 0}
                  precision={2}
                  suffix="%"
                  valueStyle={{ color: (lastDayStats.indexReturn ?? 0) >= 0 ? "#3f8600" : "#cf1322" }}
                  prefix={(lastDayStats.indexReturn ?? 0) >= 0 ? <ArrowUpOutlined /> : <ArrowDownOutlined />}
                />
                <div style={{ marginTop: 4, fontSize: 12, color: "rgba(255,255,255,0.45)" }}>
                  {lastDayStats.date}
                </div>
              </Card>
            </Col>
          </>
        )}
      </Row>

      <Card title="净值走势" size={isMobile ? "small" : "default"} style={{ marginTop: 12 }}>
        <ReactECharts option={navChartOption} style={{ height: isMobile ? 260 : 360 }} />
      </Card>

      <Card title="回撤曲线" size={isMobile ? "small" : "default"} style={{ marginTop: 12 }}>
        <ReactECharts option={ddChartOption} style={{ height: isMobile ? 200 : 240 }} />
      </Card>

      <Card
        title={
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <span>指数对比</span>
            <Select
              value={selectedIndex}
              onChange={setSelectedIndex}
              options={INDEX_OPTIONS}
              style={{ width: 140 }}
              size="small"
            />
          </div>
        }
        size={isMobile ? "small" : "default"}
        style={{ marginTop: 12 }}
      >
        {indexLoading ? (
          <Spin style={{ display: "block", margin: "40px auto" }} />
        ) : comparisonData ? (
          <>
            <ReactECharts
              option={{
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
                legend: {
                  data: [
                    "组合净值",
                    INDEX_OPTIONS.find((o) => o.value === selectedIndex)?.label ?? selectedIndex,
                  ],
                },
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
                    name:
                      INDEX_OPTIONS.find((o) => o.value === selectedIndex)?.label ?? selectedIndex,
                    type: "line",
                    data: comparisonData.indexNav,
                    smooth: true,
                    lineStyle: { width: 2 },
                    symbol: "none",
                  },
                ],
                grid: gridMargin,
              }}
              style={{ height: isMobile ? 260 : 360 }}
            />
            <ReactECharts
              option={{
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
                  data: [
                    "组合收益率",
                    INDEX_OPTIONS.find((o) => o.value === selectedIndex)?.label + "收益率",
                    "超额收益",
                  ],
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
                    name:
                      INDEX_OPTIONS.find((o) => o.value === selectedIndex)?.label + "收益率",
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
                grid: gridMargin,
              }}
              style={{ height: isMobile ? 260 : 360 }}
            />
            <Row gutter={[12, 12]} style={{ marginTop: 12 }}>
              <Col xs={8} sm={8}>
                <Card size="small">
                  <Statistic
                    title="组合收益率"
                    value={comparisonData.latestPortfolioReturn}
                    precision={2}
                    suffix="%"
                    valueStyle={{
                      color: comparisonData.latestPortfolioReturn >= 0 ? "#3f8600" : "#cf1322",
                    }}
                    prefix={
                      comparisonData.latestPortfolioReturn >= 0 ? (
                        <ArrowUpOutlined />
                      ) : (
                        <ArrowDownOutlined />
                      )
                    }
                  />
                </Card>
              </Col>
              <Col xs={8} sm={8}>
                <Card size="small">
                  <Statistic
                    title={
                      (INDEX_OPTIONS.find((o) => o.value === selectedIndex)?.label ?? "指数") +
                      "收益率"
                    }
                    value={comparisonData.latestIndexReturn}
                    precision={2}
                    suffix="%"
                    valueStyle={{
                      color: comparisonData.latestIndexReturn >= 0 ? "#3f8600" : "#cf1322",
                    }}
                    prefix={
                      comparisonData.latestIndexReturn >= 0 ? (
                        <ArrowUpOutlined />
                      ) : (
                        <ArrowDownOutlined />
                      )
                    }
                  />
                </Card>
              </Col>
              <Col xs={8} sm={8}>
                <Card size="small">
                  <Statistic
                    title="超额收益"
                    value={comparisonData.latestExcess}
                    precision={2}
                    suffix="%"
                    valueStyle={{
                      color: comparisonData.latestExcess >= 0 ? "#3f8600" : "#cf1322",
                      fontWeight: 700,
                    }}
                    prefix={
                      comparisonData.latestExcess >= 0 ? <RiseOutlined /> : <FallOutlined />
                    }
                  />
                </Card>
              </Col>
            </Row>
          </>
        ) : (
          <Alert type="info" message="暂无可对比的数据" showIcon />
        )}
      </Card>

      <Row gutter={[12, 12]} style={{ marginTop: 12 }}>
        <Col xs={8} sm={8}>
          <Card size={isMobile ? "small" : "default"}>
            <Statistic
              title="总资产"
              value={overview.total_value}
              precision={0}
              prefix="¥"
            />
          </Card>
        </Col>
        <Col xs={8} sm={8}>
          <Card size={isMobile ? "small" : "default"}>
            <Statistic
              title="持仓市值"
              value={overview.position_value}
              precision={0}
              prefix="¥"
            />
          </Card>
        </Col>
        <Col xs={8} sm={8}>
          <Card size={isMobile ? "small" : "default"}>
            <Statistic title="当前持仓" value={overview.holding_count} suffix="只" />
          </Card>
        </Col>
      </Row>
    </div>
  );
}
