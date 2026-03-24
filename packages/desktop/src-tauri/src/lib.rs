use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager, Runtime, LogicalPosition, LogicalSize};
use tauri_plugin_opener::OpenerExt;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AppConfig {
    pub model: String,
    pub api_key: String,
    pub base_url: String,
    pub language: String,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            model: "qwen-plus".to_string(),
            api_key: "".to_string(),
            base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1".to_string(),
            language: "zh-CN".to_string(),
        }
    }
}

fn get_config_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let mut path = app.path().app_config_dir().map_err(|e| e.to_string())?;
    if !path.exists() {
        fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    }
    path.push("config.json");
    Ok(path)
}

fn get_workflows_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let mut path = app.path().app_data_dir().map_err(|e| e.to_string())?;
    path.push("workflows");
    if !path.exists() {
        fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    }
    Ok(path)
}

#[tauri::command]
async fn get_config<R: Runtime>(app: AppHandle<R>) -> Result<AppConfig, String> {
    let path = get_config_path(&app)?;
    if !path.exists() { return Ok(AppConfig::default()); }
    let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&content).map_err(|e| e.to_string())
}

#[tauri::command]
async fn save_config<R: Runtime>(app: AppHandle<R>, config: AppConfig) -> Result<(), String> {
    let path = get_config_path(&app)?;
    let content = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    fs::write(path, content).map_err(|e| e.to_string())
}

#[tauri::command]
async fn save_workflow<R: Runtime>(app: AppHandle<R>, id: String, workflow_json: String) -> Result<(), String> {
    let mut path = get_workflows_dir(&app)?;
    path.push(format!("{}.json", id));
    fs::write(path, workflow_json).map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_workflows<R: Runtime>(app: AppHandle<R>) -> Result<Vec<String>, String> {
    let dir = get_workflows_dir(&app)?;
    let mut workflows = Vec::new();
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.path().extension().and_then(|s| s.to_str()) == Some("json") {
            let content = fs::read_to_string(entry.path()).map_err(|e| e.to_string())?;
            workflows.push(content);
        }
    }
    Ok(workflows)
}

#[tauri::command]
async fn delete_workflow<R: Runtime>(app: AppHandle<R>, id: String) -> Result<(), String> {
    let mut path = get_workflows_dir(&app)?;
    path.push(format!("{}.json", id));
    if path.exists() { fs::remove_file(path).map_err(|e| e.to_string())?; }
    Ok(())
}

#[tauri::command]
async fn navigate_browser<R: Runtime>(app: AppHandle<R>, url: String) -> Result<(), String> {
    if let Some(webview) = app.get_webview("session-view") {
        let parsed_url = url.parse().map_err(|e| format!("{}", e))?;
        let _ = webview.navigate(parsed_url);
    }
    Ok(())
}

#[tauri::command]
async fn close_browser<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    if let Some(webview) = app.get_webview("session-view") {
        let _ = webview.close();
    }
    Ok(())
}

#[tauri::command]
async fn open_browser<R: Runtime>(app: AppHandle<R>, url: String, config_json: String, x: i32, y: i32, width: i32, height: i32) -> Result<(), String> {
    // 1. Cleanup
    let _ = close_browser(app.clone()).await;

    // 2. Locate Agent Script
    let possible_paths = vec![
        PathBuf::from("/Volumes/Andrew ek 4T/PageAgent/code/packages/page-agent/dist/iife/page-agent.demo.js"),
        PathBuf::from("../../page-agent/dist/iife/page-agent.demo.js"),
    ];

    let mut agent_script = String::new();
    for p in possible_paths {
        if p.exists() {
            if let Ok(content) = fs::read_to_string(&p) {
                agent_script = content;
                break;
            }
        }
    }

    if agent_script.is_empty() {
        agent_script = "alert('ERROR: page-agent.demo.js not found!');".to_string();
    }

    // 3. Create Sub-Webview attached to the main window
    let main_window = app.get_window("main").ok_or("Main window not found")?;
    
    // Create builder
    let builder = tauri::webview::WebviewBuilder::new(
        "session-view",
        tauri::WebviewUrl::External(url.parse().map_err(|e| format!("Invalid URL: {}", e))?),
    )
    .initialization_script(&format!(
        "window.PAGE_AGENT_CONFIG = {};\n{}",
        config_json,
        agent_script
    ))
    .devtools(true);

    // In v2, we must use `add_child` on the parent window for WebviewBuilder
    let _webview = main_window.add_child(
        builder,
        LogicalPosition::new(x as f64, y as f64),
        LogicalSize::new(width as f64, height as f64)
    ).map_err(|e| format!("Failed to build sub-webview: {:?}", e))?;

    Ok(())
}

#[tauri::command]
async fn resize_browser<R: Runtime>(app: AppHandle<R>, x: i32, y: i32, width: i32, height: i32) -> Result<(), String> {
    if let Some(webview) = app.get_webview("session-view") {
        let _ = webview.set_position(tauri::Position::Logical(LogicalPosition::new(x as f64, y as f64)));
        let _ = webview.set_size(tauri::Size::Logical(LogicalSize::new(width as f64, height as f64)));
    }
    Ok(())
}

#[tauri::command]
async fn execute_agent_task<R: Runtime>(app: AppHandle<R>, task: String) -> Result<(), String> {
    if let Some(webview) = app.get_webview("session-view") {
        // Evaluate JavaScript to run the task on the injected PageAgent instance
        let js_code = format!(
            r#"
            (function() {{
                if (window.pageAgent) {{
                    window.pageAgent.execute(`{}`);
                    return "OK";
                }} else {{
                    console.error('PageAgent not injected yet.');
                    return "ERROR: Agent not ready";
                }}
            }})()
            "#,
            task.replace('`', "\\`").replace('$', "\\$")
        );
        let _ = webview.eval(&js_code);
    } else {
        return Err("No active browser session found".to_string());
    }
    Ok(())
}

#[tauri::command]
async fn open_help_url<R: Runtime>(app: AppHandle<R>, url: String) -> Result<(), String> {
    app.opener().open_url(url, None::<String>).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_config, save_config, save_workflow, list_workflows, delete_workflow,
            open_browser, close_browser, navigate_browser, resize_browser, open_help_url,
            execute_agent_task
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
