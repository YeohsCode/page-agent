# Workflow 步骤固化功能使用指南

## 📌 功能概述

PageAgent Workflow 功能允许你：
1. 用 LLM 执行一次自动化任务
2. **保存**操作步骤为 Workflow
3. **回放** Workflow，**无需 LLM**，速度更快、零费用
4. 当页面变化时，**更新**（重新用 LLM 生成）
5. **导入/导出** JSON 文件，跨设备/跨用户共享

## 🚀 快速开始

### 1. 录制 Workflow（保存 LLM 执行的步骤）

```typescript
import { PageAgent } from 'page-agent'
import { fromHistory, WorkflowStore } from '@page-agent/workflow'

// 创建 Agent 并执行任务
const agent = new PageAgent({
    model: 'qwen3.5-plus',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKey: 'sk-xxx',
})

const result = await agent.execute('在搜索框输入 PageAgent 并点击搜索')

// 任务完成后，将执行历史转换为 Workflow
if (result.success) {
    const workflow = fromHistory(
        result.history,                    // Agent 执行历史
        '搜索 PageAgent',                  // Workflow 名称
        '在搜索框输入 PageAgent 并点击搜索', // 原始任务描述
        window.location.href               // 当前页面 URL
    )

    // 保存到 localStorage
    const store = new WorkflowStore()
    store.save(workflow)
    console.log('✅ Workflow 已保存:', workflow.id)
}
```

### 2. 回放 Workflow（无需 LLM）

```typescript
import { PageController } from '@page-agent/page-controller'
import { WorkflowPlayer, WorkflowStore } from '@page-agent/workflow'

// 加载保存的 Workflow
const store = new WorkflowStore()
const workflows = store.list()
const workflow = workflows[0]  // 获取最近保存的

// 创建 Player（只需要 PageController，不需要 LLM）
const pageController = new PageController({ enableMask: true })
const player = new WorkflowPlayer(pageController)

// 监听事件
player.addEventListener('stepstart', (e) => {
    const { stepIndex, step } = (e as CustomEvent).detail
    console.log(`▶ 步骤 ${stepIndex + 1}: ${step.description}`)
})

player.addEventListener('stepcomplete', (e) => {
    const { result } = (e as CustomEvent).detail
    console.log(`✅ ${result.message} (${result.duration}ms)`)
})

player.addEventListener('stepfailed', (e) => {
    const { result } = (e as CustomEvent).detail
    console.log(`❌ ${result.message}`)
})

// 开始回放
const result = await player.play(workflow)
console.log(`回放完成: ${result.completedSteps}/${result.totalSteps} 步成功`)
```

### 3. 停止正在运行的 Workflow

```typescript
// 在回放过程中随时调用
player.stop()
```

### 4. 更新 Workflow（基于 LLM 重新生成）

```typescript
import { PageAgent } from 'page-agent'
import { fromHistory, WorkflowStore } from '@page-agent/workflow'

const store = new WorkflowStore()
const oldWorkflow = store.get('workflow-id')

if (oldWorkflow) {
    // 使用原始任务描述重新执行
    const agent = new PageAgent({
        model: 'qwen3.5-plus',
        baseURL: '...',
        apiKey: '...',
    })

    const result = await agent.execute(oldWorkflow.originalTask)

    if (result.success) {
        // 创建新版本的 Workflow
        const newWorkflow = fromHistory(
            result.history,
            oldWorkflow.name,
            oldWorkflow.originalTask,
            window.location.href
        )

        // 保持相同 ID，增加版本号
        newWorkflow.id = oldWorkflow.id
        newWorkflow.version = oldWorkflow.version + 1

        store.save(newWorkflow)
        console.log(`✅ Workflow 已更新至 v${newWorkflow.version}`)
    }
}
```

### 5. 导出 Workflow 为 JSON 文件

```typescript
const store = new WorkflowStore()
const workflow = store.get('workflow-id')

if (workflow) {
    // 下载为 JSON 文件
    store.downloadAsFile(workflow)

    // 或获取 JSON 字符串
    const json = store.exportToJSON(workflow)
    console.log(json)
}
```

### 6. 导入 Workflow

```typescript
const store = new WorkflowStore()

// 从 JSON 字符串导入
const json = '{"id":"...","name":"...","steps":[...]}'
const workflow = store.importFromJSON(json)
store.save(workflow)

// 从文件导入（配合 <input type="file"> 使用）
const fileInput = document.querySelector('input[type="file"]')
fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0]
    if (file) {
        const workflow = await store.importFromFile(file)
        store.save(workflow)
        console.log('✅ Workflow 导入成功:', workflow.name)
    }
})
```

## 📐 Workflow JSON 结构

```json
{
    "id": "m1abc123def",
    "name": "搜索 PageAgent",
    "description": "",
    "createdAt": "2026-03-22T01:30:00.000Z",
    "updatedAt": "2026-03-22T01:30:00.000Z",
    "sourceUrl": "https://www.baidu.com",
    "version": 1,
    "originalTask": "在搜索框输入 PageAgent 并点击搜索",
    "steps": [
        {
            "index": 0,
            "action": "input_text",
            "params": { "index": 1, "text": "PageAgent" },
            "selector": {
                "cssSelector": "#kw",
                "tagName": "input",
                "textContent": "",
                "attributes": {
                    "id": "kw",
                    "name": "wd",
                    "placeholder": "请输入搜索内容"
                }
            },
            "description": "在搜索输入框中输入 PageAgent",
            "waitAfter": 0.5
        },
        {
            "index": 1,
            "action": "click_element_by_index",
            "params": { "index": 5 },
            "selector": {
                "cssSelector": "#su",
                "tagName": "input",
                "attributes": {
                    "id": "su",
                    "type": "submit"
                }
            },
            "description": "点击搜索按钮",
            "waitAfter": 0.5
        }
    ]
}
```

## ⚠️ 注意事项

1. **元素定位**：回放时通过 CSS 选择器、id、文本内容等多种策略定位元素。如果页面结构大幅变化，可能定位失败。此时需要"更新"（重新用 LLM 生成）。
2. **跨域限制**：Workflow 只能在同源页面上回放。
3. **动态内容**：如果页面内容高度动态（如时间戳），回放时的文本输入可能不符合预期。
4. **存储空间**：Workflow 保存在 localStorage 中，有 5MB 大小限制。大量 Workflow 建议导出为 JSON 文件。

## 📦 包信息

- 包名：`@page-agent/workflow`
- 源码位置：`packages/workflow/`
- 依赖：仅依赖 `@page-agent/page-controller`（不依赖 LLM）
