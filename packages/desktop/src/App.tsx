import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

interface AppConfig {
  model: string;
  api_key: string;
  base_url: string;
  language: string;
}

interface Workflow {
  id: string;
  name: string;
  steps: any[];
  updatedAt: string;
  sourceUrl: string;
  originalTask: string;
}

function App() {
  const [activeTab, setActiveTab] = useState<"workflows" | "settings" | "browser">("workflows");
  const [sessionActive, setSessionActive] = useState(false);
  const [sessionUrl, setSessionUrl] = useState("https://www.google.com");
  const [config, setConfig] = useState<AppConfig>({
    model: "qwen-plus",
    api_key: "",
    base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    language: "zh-CN",
  });
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [targetUrl, setTargetUrl] = useState("https://www.google.com");

  const webviewRef = useRef<HTMLDivElement>(null);

  // Load data from Rust on mount
  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    try {
      const conf = await invoke<AppConfig>("get_config");
      setConfig(conf);
      const wfStrings = await invoke<string[]>("list_workflows");
      const wfs = wfStrings.map((s: string) => JSON.parse(s));
      setWorkflows(wfs);
    } catch (e) {
      console.error("Failed to load data:", e);
    }
  }

  async function handleSaveConfig() {
    setIsSaving(true);
    try {
      await invoke("save_config", { config });
      alert("配置已保存");
    } catch (e) {
      alert("保存失败: " + e);
    } finally {
      setIsSaving(false);
    }
  }

  // Handle URL change from the address bar
  async function handleNavigate() {
    if (!sessionActive) return;
    let url = sessionUrl.trim();
    if (!/^https?:\/\//i.test(url)) {
      url = 'https://' + url;
      setSessionUrl(url);
    }
    try {
      await invoke("navigate_browser", { url });
    } catch (e) {
      console.error("Navigation failed:", e);
    }
  }

  async function launchBrowser(url: string) {
    try {
      setSessionUrl(url);
      setSessionActive(true);
      setActiveTab("browser");
      setShowModal(false);

      // Using a short timeout to ensure the DOM is painted and webviewRef is physically attached.
      setTimeout(async () => {
        const rect = webviewRef.current?.getBoundingClientRect();
        if (rect) {
          const isMac = navigator.userAgent.includes('Mac');
          const yOffset = isMac ? 28 : 0;
          await invoke("open_browser", {
            url,
            configJson: JSON.stringify({
              model: config.model,
              apiKey: config.api_key,
              baseURL: config.base_url,
              language: config.language
            }),
            x: Math.round(rect.x),
            y: Math.round(rect.y) + yOffset,
            width: Math.round(rect.width),
            height: Math.round(rect.height) - yOffset
          });
        }
      }, 50);
    } catch (e) {
      console.error("Failed to launch browser:", e);
      alert("启动浏览器失败: " + e);
    }
  }

  // Continuously sync webview size to match the placeholder
  useEffect(() => {
    if (!sessionActive || !webviewRef.current) return;
    const observer = new ResizeObserver(() => {
      // We need absolute physical position relative to client window, getBoundingClientRect gives us that
      const bound = webviewRef.current?.getBoundingClientRect();
      const isMac = navigator.userAgent.includes('Mac');
      const yOffset = isMac ? 28 : 0;
      if (bound) {
        invoke("resize_browser", {
          x: Math.round(bound.x),
          y: Math.round(bound.y) + yOffset,
          width: Math.round(bound.width),
          height: Math.round(bound.height) - yOffset
        }).catch(err => console.error(err));
      }
    });

    observer.observe(webviewRef.current);

    // Also track window resizes just in case
    const handleResize = () => {
      const bound = webviewRef.current?.getBoundingClientRect();
      const isMac = navigator.userAgent.includes('Mac');
      const yOffset = isMac ? 28 : 0;
      if (bound) {
        invoke("resize_browser", {
          x: Math.round(bound.x),
          y: Math.round(bound.y) + yOffset,
          width: Math.round(bound.width),
          height: Math.round(bound.height) - yOffset
        }).catch(err => console.error(err));
      }
    };
    window.addEventListener("resize", handleResize);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", handleResize);
    };
  }, [sessionActive, activeTab]);

  async function closeSession() {
    try {
      await invoke("close_browser");
      setSessionActive(false);
      setActiveTab("workflows");
    } catch (e) {
      console.error("Failed to close session:", e);
    }
  }

  async function handleDeleteWorkflow(id: string) {
    if (!confirm("确定要删除这个脚本吗？")) return;
    try {
      await invoke("delete_workflow", { id });
      loadData();
    } catch (e) {
      alert("删除失败: " + e);
    }
  }

  return (
    <div className="dashboard">
      <nav className="sidebar">
        <div className="logo-section">
          <div className="logo-icon">P</div>
          <span style={{ fontSize: "20px", fontWeight: "bold" }}>PageAgent</span>
        </div>

        <div
          className={`nav-item ${activeTab === "workflows" ? "active" : ""}`}
          onClick={() => { if (sessionActive) closeSession(); setActiveTab("workflows"); }}
        >
          <span>📋</span> 脚本库
        </div>

        {sessionActive && (
          <div
            className={`nav-item ${activeTab === "browser" ? "active" : ""}`}
            onClick={() => setActiveTab("browser")}
          >
            <span>🌐</span> 正在运行
          </div>
        )}

        <div
          className={`nav-item ${activeTab === "settings" ? "active" : ""}`}
          onClick={() => { if (sessionActive) closeSession(); setActiveTab("settings"); }}
        >
          <span>⚙️</span> 全局设置
        </div>

        <div style={{ marginTop: "auto" }}>
          <div className="nav-item" onClick={() => invoke("open_help_url", { url: "https://github.com/YeohsCode/page-agent" })}>
            <span>❓</span> 帮助文档
          </div>
        </div>
      </nav>

      <main className="content">
        {activeTab === "browser" ? (
          <div className="browser-container">
            <div className="browser-toolbar">
              <button className="toolbar-btn" onClick={closeSession}>✕ 退出</button>
              <input
                className="browser-address-bar"
                value={sessionUrl}
                onChange={e => setSessionUrl(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleNavigate()}
              />
              <button className="toolbar-btn primary" onClick={handleNavigate}>Go</button>
            </div>
            <div className="webview-placeholder" ref={webviewRef}>
              {/* Tauri will overlay the sub-webview here */}
              <div className="placeholder-text">浏览器加载中...</div>
            </div>
          </div>
        ) : (
          <>
            <header className="header">
              <h1>{activeTab === "workflows" ? "自动化脚本" : "设置"}</h1>
              {activeTab === "workflows" && (
                <button className="btn-primary" onClick={() => setShowModal(true)}>
                  + 启动新会话
                </button>
              )}
            </header>

            {activeTab === "workflows" ? (
              <div className="workflow-section">
                {workflows.length === 0 ? (
                  <div className="empty-state">
                    <div className="empty-icon">📂</div>
                    <p>还没有保存任何脚本，开启新会话开始录制吧！</p>
                  </div>
                ) : (
                  <div className="workflow-grid">
                    {workflows.map(wf => (
                      <div key={wf.id} className="workflow-card">
                        <div className="workflow-name">{wf.name}</div>
                        <div className="workflow-meta">
                          <span>{wf.steps?.length || 0} 步</span>
                          <span>{new Date(wf.updatedAt).toLocaleDateString()}</span>
                        </div>
                        <div className="play-overlay">
                          <div className="play-icon" onClick={(e) => { e.stopPropagation(); launchBrowser(wf.sourceUrl); }}>▶</div>
                          <div style={{ marginLeft: "12px", background: "rgba(239, 68, 68, 0.8)", padding: "8px", borderRadius: "50%", cursor: "pointer" }} onClick={(e) => { e.stopPropagation(); handleDeleteWorkflow(wf.id); }}>🗑</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <div className="quick-guide-card">
                  <h3>🚀 使用指引</h3>
                  <div className="guide-steps">
                    <div className="guide-step">
                      <div className="step-num">1</div>
                      <p>点击“启动新会话”并输入 URL 进入自动化环境。</p>
                    </div>
                    <div className="guide-step">
                      <div className="step-num">2</div>
                      <p>在顶部的地址栏随时切换 URL，在网页悬浮面板输入指令指挥 Agent。</p>
                    </div>
                    <div className="guide-step">
                      <div className="step-num">3</div>
                      <p>完成操作后点击 💾 固化为脚本，之后可一键回放。</p>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="settings-section">
                <div className="settings-form">
                  <div className="form-group">
                    <label>模型名称</label>
                    <input value={config.model} onChange={e => setConfig({ ...config, model: e.target.value })} />
                  </div>
                  <div className="form-group">
                    <label>API Key</label>
                    <input type="password" value={config.api_key} onChange={e => setConfig({ ...config, api_key: e.target.value })} />
                  </div>
                  <div className="form-group">
                    <label>Base URL</label>
                    <input value={config.base_url} onChange={e => setConfig({ ...config, base_url: e.target.value })} />
                  </div>
                  <button className="btn-primary" onClick={handleSaveConfig} disabled={isSaving}>
                    {isSaving ? "正在保存..." : "保存全局配置"}
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </main>

      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>启动新会话</h2>
            </div>
            <div className="form-group">
              <label>目标 URL</label>
              <input autoFocus value={targetUrl} onChange={e => setTargetUrl(e.target.value)} onKeyDown={e => e.key === 'Enter' && launchBrowser(targetUrl)} />
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={() => setShowModal(false)}>取消</button>
              <button className="btn-primary" onClick={() => launchBrowser(targetUrl)}>启动</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
