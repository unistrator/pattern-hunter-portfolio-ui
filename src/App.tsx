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
  PieChartOutlined,
  BarChartOutlined,
  AimOutlined,
} from "@ant-design/icons";
import { Analytics } from "@vercel/analytics/react";
import { extractTokenFromUrl, clearToken } from "./utils/auth";
import ErrorBoundary from "./components/ErrorBoundary";
import useIsMobile from "./hooks/useIsMobile";

import Dashboard from "./pages/Dashboard";
import Holdings from "./pages/Holdings";
import Trades from "./pages/Trades";
import Signals from "./pages/Signals";
import Executions from "./pages/Executions";
import PendingOrders from "./pages/PendingOrders";
import Contributions from "./pages/Contributions";
import PeriodContributions from "./pages/PeriodContributions";
import Deviation from "./pages/Deviation";

const { Header, Content, Sider } = Layout;

const menuItems = [
  { key: "/", icon: <DashboardOutlined />, label: <NavLink to="/">Dashboard</NavLink> },
  { key: "/holdings", icon: <StockOutlined />, label: <NavLink to="/holdings">持仓</NavLink> },
  { key: "/executions", icon: <FileTextOutlined />, label: <NavLink to="/executions">交割单</NavLink> },
  { key: "/pending-orders", icon: <OrderedListOutlined />, label: <NavLink to="/pending-orders">挂单</NavLink> },
  { key: "/signals", icon: <ThunderboltOutlined />, label: <NavLink to="/signals">每日信号</NavLink> },
  { key: "/trades", icon: <SwapOutlined />, label: <NavLink to="/trades">已完成交易对</NavLink> },
  { key: "/contributions", icon: <PieChartOutlined />, label: <NavLink to="/contributions">单日贡献</NavLink> },
  { key: "/period-contributions", icon: <BarChartOutlined />, label: <NavLink to="/period-contributions">区间贡献</NavLink> },
  { key: "/deviation", icon: <AimOutlined />, label: <NavLink to="/deviation">偏离归因</NavLink> },
];

const mobileNavItems = [
  { key: "/", icon: <DashboardOutlined />, label: "总览", to: "/" },
  { key: "/holdings", icon: <StockOutlined />, label: "持仓", to: "/holdings" },
  { key: "/executions", icon: <FileTextOutlined />, label: "交割", to: "/executions" },
  { key: "/pending-orders", icon: <OrderedListOutlined />, label: "挂单", to: "/pending-orders" },
  { key: "/signals", icon: <ThunderboltOutlined />, label: "信号", to: "/signals" },
  { key: "/trades", icon: <SwapOutlined />, label: "交易", to: "/trades" },
  { key: "/contributions", icon: <PieChartOutlined />, label: "单日贡献", to: "/contributions" },
  { key: "/period-contributions", icon: <BarChartOutlined />, label: "区间贡献", to: "/period-contributions" },
  { key: "/deviation", icon: <AimOutlined />, label: "偏离归因", to: "/deviation" },
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

function MobileBottomNav({ selectedKey }: { selectedKey: string }) {
  return (
    <nav className="mobile-bottom-nav">
      {mobileNavItems.map((item) => (
        <NavLink
          key={item.key}
          to={item.to}
          className={`nav-item${selectedKey === item.key ? " active" : ""}`}
        >
          {item.icon}
          <span>{item.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}

function MobileHeader() {
  return (
    <div
      style={{
        position: "sticky",
        top: 0,
        zIndex: 999,
        background: "#141414",
        borderBottom: "1px solid #303030",
        padding: "10px 16px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
      }}
    >
      <span style={{ color: "#fff", fontWeight: 700, fontSize: 15 }}>Pattern Hunter</span>
      <Button
        type="link"
        size="small"
        danger
        onClick={() => { clearToken(); window.location.reload(); }}
      >
        清除 Token
      </Button>
    </div>
  );
}

function AppContent() {
  const location = useLocation();
  const isMobile = useIsMobile();

  const selectedKey = "/" + (location.pathname.split("/")[1] || "");

  const routeContent = (
    <Routes>
      <Route path="/" element={<Dashboard />} />
      <Route path="/holdings" element={<Holdings />} />
      <Route path="/contributions" element={<Contributions />} />
      <Route path="/period-contributions" element={<PeriodContributions />} />
      <Route path="/deviation" element={<Deviation />} />
      <Route path="/trades" element={<Trades />} />
      <Route path="/signals" element={<Signals />} />
      <Route path="/executions" element={<Executions />} />
      <Route path="/pending-orders" element={<PendingOrders />} />
      <Route path="/404" element={<NotFound />} />
      <Route path="*" element={<Navigate to="/404" replace />} />
    </Routes>
  );

  if (isMobile) {
    return (
      <div style={{ minHeight: "100vh", background: "#000" }}>
        <MobileHeader />
        <div className="mobile-content" style={{ padding: 12 }}>
          {routeContent}
        </div>
        <MobileBottomNav selectedKey={selectedKey} />
      </div>
    );
  }

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
          {routeContent}
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
      <Analytics />
    </ErrorBoundary>
  );
}
