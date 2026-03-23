import { useEffect, useState, useCallback } from "react";
import { Table, Card, Spin, Alert, Tag, Select, Space, Button } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import { api } from "../utils/api";
import type { PendingOrdersData } from "../types";

const statusOptions = [
  { label: "待执行", value: "pending" },
  { label: "已成交", value: "executed" },
  { label: "无开盘价", value: "failed_no_price" },
  { label: "资金不足", value: "failed_no_capital" },
];

const statusTagMap: Record<string, { color: string; label: string }> = {
  pending: { color: "processing", label: "待执行" },
  executed: { color: "success", label: "已成交" },
  failed_no_price: { color: "warning", label: "无开盘价" },
  failed_no_capital: { color: "error", label: "资金不足" },
};

export default function PendingOrders() {
  const [data, setData] = useState<PendingOrdersData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [status, setStatus] = useState<string>("pending");

  const fetchOrders = useCallback((s: string) => {
    setLoading(true);
    setError("");
    api
      .pendingOrders(s)
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchOrders(status);
  }, []);

  const handleStatusChange = (v: string) => {
    setStatus(v);
    fetchOrders(v);
  };

  if (error && !data) return <Alert type="error" message={error} />;

  const columns = [
    {
      title: "挂单ID",
      dataIndex: "id",
      key: "id",
      width: 80,
    },
    {
      title: "创建日期",
      dataIndex: "create_date",
      key: "create_date",
      width: 120,
    },
    {
      title: "股票代码",
      dataIndex: "stock_code",
      key: "stock_code",
      width: 110,
    },
    {
      title: "槽位",
      dataIndex: "slot_idx",
      key: "slot_idx",
      width: 70,
      render: (v: number) => <Tag color="blue">#{v}</Tag>,
    },
    {
      title: "方向",
      dataIndex: "action",
      key: "action",
      width: 80,
      render: (v: string) => (
        <Tag color={v === "buy" ? "blue" : "volcano"}>
          {v === "buy" ? "买入" : "卖出"}
        </Tag>
      ),
    },
    {
      title: "DA预测",
      dataIndex: "da_pred",
      key: "da_pred",
      width: 100,
      render: (v: number | null) => (v != null ? v.toFixed(4) : "-"),
    },
    {
      title: "中期IQR",
      dataIndex: "zhong_iqr",
      key: "zhong_iqr",
      width: 100,
      render: (v: number | null) => (v != null ? v.toFixed(2) : "-"),
    },
    {
      title: "状态",
      dataIndex: "status",
      key: "status",
      width: 100,
      render: (v: string) => {
        const info = statusTagMap[v] || { color: "default", label: v };
        return <Tag color={info.color}>{info.label}</Tag>;
      },
    },
  ];

  return (
    <Card
      title={`挂单列表 (${data?.total ?? 0} 条)`}
      extra={
        <Space>
          <Select
            value={status}
            onChange={handleStatusChange}
            options={statusOptions}
            style={{ width: 130 }}
          />
          <Button
            icon={<ReloadOutlined />}
            onClick={() => fetchOrders(status)}
          >
            刷新
          </Button>
        </Space>
      }
    >
      {error && <Alert type="error" message={error} style={{ marginBottom: 16 }} />}
      <Table
        dataSource={data?.orders || []}
        columns={columns}
        rowKey="id"
        size="small"
        loading={loading}
        pagination={{ pageSize: 50, showTotal: (total) => `共 ${total} 条` }}
      />
    </Card>
  );
}
