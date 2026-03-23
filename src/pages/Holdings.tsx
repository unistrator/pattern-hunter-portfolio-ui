import { useEffect, useState } from "react";
import { Table, Card, Spin, Alert, Tag, Tooltip } from "antd";
import { InfoCircleOutlined, ClockCircleOutlined } from "@ant-design/icons";
import { api } from "../utils/api";
import type { HoldingsData, Slot, Position } from "../types";

export default function Holdings() {
  const [data, setData] = useState<HoldingsData | null>(null);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    Promise.all([api.holdings(), api.slots()])
      .then(([holdings, slotsData]) => {
        setData(holdings);
        setSlots(slotsData);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <Spin size="large" style={{ display: "block", margin: "100px auto" }} />;
  if (error) return <Alert type="error" message={error} />;

  const valueDates = (data?.positions || [])
    .map((p) => p.value_updated_date)
    .filter((d): d is string => !!d);
  const latestValueDate = valueDates.length ? valueDates.sort().pop()! : null;

  const positionColumns = [
    { title: "股票代码", dataIndex: "stock_code", key: "stock_code" },
    { title: "买入日期", dataIndex: "buy_date", key: "buy_date" },
    { title: "买入价", dataIndex: "buy_price", key: "buy_price" },
    { title: "持股数", dataIndex: "shares", key: "shares", render: (v: number) => v.toFixed(0) },
    { title: "成本", dataIndex: "cost", key: "cost", render: (v: number) => `¥${v.toLocaleString()}` },
    {
      title: () => (
        <span>
          当前市值{" "}
          <Tooltip title="基于最近一次收盘价">
            <InfoCircleOutlined style={{ color: "rgba(255,255,255,0.45)" }} />
          </Tooltip>
        </span>
      ),
      dataIndex: "current_value",
      key: "current_value",
      render: (v: number | undefined) => v != null ? `¥${v.toLocaleString()}` : "-",
    },
    {
      title: "浮动盈亏",
      key: "pnl",
      render: (_: unknown, r: Position) => {
        if (r.current_value == null) return "-";
        const pnl = r.current_value - r.cost;
        const pnlPct = r.cost ? (pnl / r.cost) * 100 : 0;
        const color = pnl >= 0 ? "#3f8600" : "#cf1322";
        const sign = pnl >= 0 ? "+" : "";
        return (
          <span style={{ color }}>
            {sign}¥{pnl.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
            {" "}({sign}{pnlPct.toFixed(2)}%)
          </span>
        );
      },
    },
    {
      title: "槽位",
      dataIndex: "slot_idx",
      key: "slot_idx",
      render: (v: number) => <Tag color="blue">#{v}</Tag>,
    },
    { title: "大分型预测", dataIndex: "da_pred", key: "da_pred", render: (v: number) => v?.toFixed(6) ?? "-" },
    { title: "中分型IQR", dataIndex: "zhong_iqr", key: "zhong_iqr", render: (v: number) => v?.toFixed(6) ?? "-" },
  ];

  const slotColumns = [
    { title: "槽位", dataIndex: "slot_idx", key: "slot_idx", render: (v: number) => `#${v}` },
    { title: "剩余资金", dataIndex: "capital", key: "capital", render: (v: number) => `¥${v.toLocaleString()}` },
    { title: "持仓数", dataIndex: "position_count", key: "position_count" },
    {
      title: "已了结胜率",
      key: "closed_wr",
      render: (_: unknown, r: Slot) => {
        const s = r.closed_trade_stats;
        if (!s || !s.total) return "-";
        return `${s.win_rate.toFixed(1)}% (${s.winning}/${s.total}) 均收益${s.avg_profit_pct.toFixed(2)}%`;
      },
    },
    {
      title: () => (
        <span>
          持仓胜率{" "}
          <Tooltip title="基于最近一次收盘价，当天新买入持仓在快照更新前可能显示为浮亏">
            <InfoCircleOutlined style={{ color: "rgba(255,255,255,0.45)" }} />
          </Tooltip>
        </span>
      ),
      key: "open_wr",
      render: (_: unknown, r: Slot) => {
        const s = r.open_position_stats;
        if (!s || !s.total) return "-";
        return `${s.win_rate.toFixed(1)}% (${s.winning}/${s.total})`;
      },
    },
  ];

  return (
    <div>
      {latestValueDate && (
        <div style={{ marginBottom: 12, textAlign: "right" }}>
          <Tag icon={<ClockCircleOutlined />} color="processing">
            市值数据更新至 {latestValueDate}（基于收盘价）
          </Tag>
        </div>
      )}
      <Card title={`当前持仓 (${data?.positions?.length || 0} 只)`}>
        <Table
          dataSource={data?.positions || []}
          columns={positionColumns}
          rowKey="id"
          size="small"
          pagination={{ pageSize: 50 }}
        />
      </Card>

      <Card title="槽位状态" style={{ marginTop: 16 }}>
        <Table
          dataSource={slots}
          columns={slotColumns}
          rowKey="slot_idx"
          size="small"
          pagination={false}
        />
      </Card>
    </div>
  );
}
