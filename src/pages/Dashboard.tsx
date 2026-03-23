import { useEffect, useState } from "react";
import { Card, Col, Row, Statistic, Spin, Alert, Tag } from "antd";
import {
  ArrowUpOutlined,
  ArrowDownOutlined,
  FundOutlined,
  ClockCircleOutlined,
} from "@ant-design/icons";
import ReactECharts from "echarts-for-react";
import { api } from "../utils/api";
import type { Overview, NavPoint } from "../types";

export default function Dashboard() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [navData, setNavData] = useState<NavPoint[]>([]);
  const [valueDate, setValueDate] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

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

  if (loading) return <Spin size="large" style={{ display: "block", margin: "100px auto" }} />;
  if (error) return <Alert type="error" message={error} />;
  if (!overview) return null;

  const dates = navData.map((n) => n.date);
  const values = navData.map((n) => n.total_value);
  const drawdowns = navData.map((n) => n.drawdown);
  const returns = navData.map((n) => n.return_pct);

  const navChartOption = {
    tooltip: {
      trigger: "axis" as const,
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
    xAxis: { type: "category" as const, data: dates },
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
    grid: { left: 80, right: 80, top: 40, bottom: 30 },
  };

  const ddChartOption = {
    tooltip: { trigger: "axis" as const },
    xAxis: { type: "category" as const, data: dates },
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
    grid: { left: 60, right: 30, top: 30, bottom: 30 },
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
      <Row gutter={[16, 16]}>
        <Col xs={12} sm={6}>
          <Card>
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
          <Card>
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
          <Card>
            <Statistic title="夏普比率" value={overview.sharpe_ratio} precision={2} prefix={<FundOutlined />} />
          </Card>
        </Col>
        <Col xs={12} sm={6}>
          <Card>
            <Statistic
              title="已了结胜率"
              value={cts.win_rate ?? 0}
              precision={1}
              suffix={`% (${cts.total ?? 0}笔)`}
            />
            <div style={{ marginTop: 4, fontSize: 12, color: "rgba(255,255,255,0.45)" }}>
              盈{cts.winning ?? 0} / 亏{cts.losing ?? 0} · 均收益 {cts.avg_profit_pct?.toFixed(2) ?? "-"}%
            </div>
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={12} sm={6}>
          <Card>
            <Statistic
              title="持仓胜率"
              value={ops.win_rate ?? 0}
              precision={1}
              suffix={`% (${ops.total ?? 0}只)`}
            />
            <div style={{ marginTop: 4, fontSize: 12, color: "rgba(255,255,255,0.45)" }}>
              浮盈{ops.winning ?? 0} / 浮亏{ops.losing ?? 0}
            </div>
          </Card>
        </Col>
      </Row>

      <Card title="净值走势" style={{ marginTop: 16 }}>
        <ReactECharts option={navChartOption} style={{ height: 360 }} />
      </Card>

      <Card title="回撤曲线" style={{ marginTop: 16 }}>
        <ReactECharts option={ddChartOption} style={{ height: 240 }} />
      </Card>

      <Row gutter={16} style={{ marginTop: 16 }}>
        <Col span={8}>
          <Card>
            <Statistic title="总资产" value={overview.total_value} precision={0} prefix="¥" />
          </Card>
        </Col>
        <Col span={8}>
          <Card>
            <Statistic title="持仓市值" value={overview.position_value} precision={0} prefix="¥" />
          </Card>
        </Col>
        <Col span={8}>
          <Card>
            <Statistic title="当前持仓" value={overview.holding_count} suffix="只" />
          </Card>
        </Col>
      </Row>
    </div>
  );
}
