import { useEffect, useState } from "react";
import { Table, Card, Spin, Alert, Tag, Tooltip, List } from "antd";
import { InfoCircleOutlined, ClockCircleOutlined } from "@ant-design/icons";
import { api } from "../utils/api";
import useIsMobile from "../hooks/useIsMobile";
import type { HoldingsData, Slot, Position } from "../types";

function MobilePositionCard({ p }: { p: Position }) {
  const pnl = p.current_value != null ? p.current_value - p.cost : null;
  const pnlPct = pnl != null && p.cost ? (pnl / p.cost) * 100 : null;
  const color = pnl != null && pnl >= 0 ? "#3f8600" : "#cf1322";
  const sign = pnl != null && pnl >= 0 ? "+" : "";

  return (
    <Card size="small" style={{ marginBottom: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <span style={{ fontWeight: 600, fontSize: 15 }}>{p.stock_code}</span>
        <Tag color="blue">#{p.slot_idx}</Tag>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px 12px", fontSize: 13 }}>
        <span style={{ color: "rgba(255,255,255,0.45)" }}>买入日期</span>
        <span>{p.buy_date}</span>
        <span style={{ color: "rgba(255,255,255,0.45)" }}>买入价</span>
        <span>{p.buy_price}</span>
        <span style={{ color: "rgba(255,255,255,0.45)" }}>持股数</span>
        <span>{p.shares.toFixed(0)}</span>
        <span style={{ color: "rgba(255,255,255,0.45)" }}>成本</span>
        <span>¥{p.cost.toLocaleString()}</span>
        <span style={{ color: "rgba(255,255,255,0.45)" }}>当前市值</span>
        <span>{p.current_value != null ? `¥${p.current_value.toLocaleString()}` : "-"}</span>
        <span style={{ color: "rgba(255,255,255,0.45)" }}>浮动盈亏</span>
        <span style={{ color }}>
          {pnl != null
            ? `${sign}¥${pnl.toLocaleString(undefined, { maximumFractionDigits: 0 })} (${sign}${pnlPct!.toFixed(2)}%)`
            : "-"}
        </span>
      </div>
    </Card>
  );
}

export default function Holdings() {
  const [data, setData] = useState<HoldingsData | null>(null);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [pageSize, setPageSize] = useState(50);
  const [currentPage, setCurrentPage] = useState(1);
  const isMobile = useIsMobile();

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
    { title: "股票代码", dataIndex: "stock_code", key: "stock_code", fixed: "left" as const, width: 100 },
    { title: "买入日期", dataIndex: "buy_date", key: "buy_date", width: 110 },
    { title: "买入价", dataIndex: "buy_price", key: "buy_price", width: 80 },
    { title: "持股数", dataIndex: "shares", key: "shares", width: 80, render: (v: number) => v.toFixed(0) },
    { title: "成本", dataIndex: "cost", key: "cost", width: 100, render: (v: number) => `¥${v.toLocaleString()}` },
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
      width: 110,
      render: (v: number | undefined) => v != null ? `¥${v.toLocaleString()}` : "-",
    },
    {
      title: "浮动盈亏",
      key: "pnl",
      width: 160,
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
      width: 70,
      render: (v: number) => <Tag color="blue">#{v}</Tag>,
    },
    { title: "大分型预测", dataIndex: "da_pred", key: "da_pred", width: 110, render: (v: number) => v?.toFixed(6) ?? "-" },
    { title: "中分型IQR", dataIndex: "zhong_iqr", key: "zhong_iqr", width: 110, render: (v: number) => v?.toFixed(6) ?? "-" },
  ];

  const slotColumns = [
    { title: "槽位", dataIndex: "slot_idx", key: "slot_idx", width: 60, render: (v: number) => `#${v}` },
    { title: "剩余资金", dataIndex: "capital", key: "capital", width: 110, render: (v: number) => `¥${v.toLocaleString()}` },
    { title: "持仓数", dataIndex: "position_count", key: "position_count", width: 80 },
    {
      title: "已了结胜率",
      key: "closed_wr",
      width: 200,
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
      width: 140,
      render: (_: unknown, r: Slot) => {
        const s = r.open_position_stats;
        if (!s || !s.total) return "-";
        return `${s.win_rate.toFixed(1)}% (${s.winning}/${s.total})`;
      },
    },
  ];

  const positions = data?.positions || [];

  return (
    <div>
      {latestValueDate && (
        <div style={{ marginBottom: 12, textAlign: "right" }}>
          <Tag icon={<ClockCircleOutlined />} color="processing">
            市值数据更新至 {latestValueDate}（基于收盘价）
          </Tag>
        </div>
      )}

      {isMobile ? (
        <>
          <Card
            title={`当前持仓 (${positions.length} 只)`}
            size="small"
            style={{ marginBottom: 12 }}
            styles={{ body: { padding: 8 } }}
          >
            {positions.length === 0 ? (
              <div style={{ textAlign: "center", padding: 20, color: "rgba(255,255,255,0.45)" }}>暂无持仓</div>
            ) : (
              positions.map((p) => <MobilePositionCard key={p.id} p={p} />)
            )}
          </Card>
          <Card title="槽位状态" size="small">
            <Table
              dataSource={slots}
              columns={slotColumns}
              rowKey="slot_idx"
              size="small"
              pagination={false}
              scroll={{ x: 600 }}
            />
          </Card>
        </>
      ) : (
        <>
          <Card title={`当前持仓 (${positions.length} 只)`}>
            <Table
              dataSource={positions}
              columns={positionColumns}
              rowKey="id"
              size="small"
              pagination={{
                current: currentPage,
                pageSize,
                showSizeChanger: true,
                pageSizeOptions: ["20", "50", "100"],
                onChange: (page, size) => {
                  setCurrentPage(size !== pageSize ? 1 : page);
                  setPageSize(size);
                },
                showTotal: (total) => `共 ${total} 条`,
              }}
              scroll={{ x: 1100 }}
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
        </>
      )}
    </div>
  );
}
