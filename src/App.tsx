import { useEffect, useState } from "react";
import { Routes, Route, NavLink, useLocation, Navigate } from "react-router-dom";
import { ConfigProvider, Layout, Menu, theme, Result, Button } from "antd";
import {
  DashboardOutlined,
  StockOutlined,
  SwapOutlined,
  ThunderboltOutlined,
  FileTextOutlined,
  OrderedListOutlined,
} from "@ant-design/icons";
import { extractTokenFromUrl, clearToken } from "./utils/auth";
import ErrorBoundary from "./components/ErrorBoundary";

import Dashboard from "./pages/Dashboard";
import Holdings from "./pages/Holdings";
import Trades from "./pages/Trades";
import Signals from "./pages/Signals";
import Executions from "./pages/Executions";
import PendingOrders from "./pages/PendingOrders";

const { Header, Content, Sider } = Layout;

const menuItems = [
  { key: "/", icon: <DashboardOutlined />, label: <NavLink to="/">Dashboard</NavLink> },
  { key: "/holdings", icon: <StockOutlined />, label: <NavLink to="/holdings">持仓</NavLink> },
  { key: "/executions", icon: <FileTextOutlined />, label: <NavLink to="/executions">交割单</NavLink> },
  { key: "/pending-orders", icon: <OrderedListOutlined />, label: <NavLink to="/pending-orders">挂单</NavLink> },
  { key: "/signals", icon: <ThunderboltOutlined />, label: <NavLink to="/signals">每日信号</NavLink> },
  { key: "/trades", icon: <SwapOutlined />, label: <NavLink to="/trades">已完成交易对</NavLink> },
];

function NoToken() {
  return (
    <div style={{ display: "flex", justifyContent: "center", alignItems: "center", height: "100vh" }}>
      <Result
        status="403"
        title="需要访问令牌"
        subTitle="请使用包含 token 参数的链接访问，例如: ?token=your-token"
      />
    </div>
  );
}

function NotFound() {
  return (
    <Result
      status="404"
      title="页面不存在"
      subTitle="你访问的页面不存在，请检查 URL 或返回首页。"
      extra={
        <NavLink to="/">
          <Button type="primary">返回首页</Button>
        </NavLink>
      }
    />
  );
}

function AppContent() {
  const location = useLocation();

  const selectedKey = "/" + (location.pathname.split("/")[1] || "");

  return (
    <Layout style={{ minHeight: "100vh" }}>
      <Sider breakpoint="lg" collapsedWidth={0}>
        <div style={{ height: 48, margin: 16, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <span style={{ color: "#fff", fontWeight: 700, fontSize: 16 }}>Pattern Hunter</span>
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[selectedKey === "/" ? "/" : selectedKey]}
          items={menuItems}
        />
        <div style={{ position: "absolute", bottom: 16, width: "100%", textAlign: "center" }}>
          <Button
            type="link"
            size="small"
            danger
            onClick={() => { clearToken(); window.location.reload(); }}
          >
            清除 Token
          </Button>
        </div>
      </Sider>
      <Layout>
        <Header style={{ padding: "0 24px", background: "#141414" }}>
          <h3 style={{ color: "#fff", margin: 0, lineHeight: "64px" }}>组合跟踪仪表盘</h3>
        </Header>
        <Content style={{ margin: 24 }}>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/holdings" element={<Holdings />} />
            <Route path="/trades" element={<Trades />} />
            <Route path="/signals" element={<Signals />} />
            <Route path="/executions" element={<Executions />} />
            <Route path="/pending-orders" element={<PendingOrders />} />
            <Route path="/404" element={<NotFound />} />
            <Route path="*" element={<Navigate to="/404" replace />} />
          </Routes>
        </Content>
      </Layout>
    </Layout>
  );
}

export default function App() {
  const [hasToken, setHasToken] = useState(false);

  useEffect(() => {
    const token = extractTokenFromUrl();
    setHasToken(!!token);
  }, []);

  if (!hasToken) return <NoToken />;

  return (
    <ErrorBoundary>
      <ConfigProvider theme={{ algorithm: theme.darkAlgorithm }}>
        <AppContent />
      </ConfigProvider>
    </ErrorBoundary>
  );
}
