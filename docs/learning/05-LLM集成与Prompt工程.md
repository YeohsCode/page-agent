# PageAgent LLM 集成与 Prompt 工程

## 🤖 LLM 是如何被使用的？

### 核心问题：每次都需要 LLM 吗？

**是的，每次执行自动化任务都需要 LLM。** PageAgent 的工作方式是：

1. **每一步（step）** 都需要调用一次 LLM
2. LLM 负责"观察页面→思考→选择动作"
3. 一个任务通常需要 3-20 步，即 3-20 次 LLM 调用
4. 没有"录制回放"模式——每次运行都是实时推理

这意味着：
- ✅ 灵活性极高，能应对动态变化的网页
- ⚠️ 每次运行都产生 LLM API 费用
- ⚠️ 执行速度取决于 LLM 响应速度

## 📝 System Prompt 详解

系统提示词位于 `packages/core/src/prompts/system_prompt.md`，是整个 Agent 的"大脑说明书"。

### Prompt 结构

```
┌─────────────────────────────────────┐
│  角色定义                            │  "你是一个浏览器自动化 AI Agent..."
├─────────────────────────────────────┤
│  语言设置                            │  动态替换：English/中文
├─────────────────────────────────────┤
│  输入格式说明                        │  解释 agent_history、browser_state 等
├─────────────────────────────────────┤
│  浏览器规则                          │  如何正确操作网页的规则
├─────────────────────────────────────┤
│  能力边界                            │  只能处理单页面、失败也是OK的...
├─────────────────────────────────────┤
│  任务完成规则                        │  何时调用 done、如何判断成功
├─────────────────────────────────────┤
│  推理规则                            │  如何进行反思和规划
├─────────────────────────────────────┤
│  示例                                │  好的输出模式示例
├─────────────────────────────────────┤
│  输出格式                            │  JSON 结构定义
└─────────────────────────────────────┘
```

### 关键规则摘要

1. **只与有索引的元素交互**：`[0]<button>` 中的 `0` 是索引
2. **默认只显示可见区域元素**：需要滚动才能看到更多
3. **不要重复同一操作超过 3 次**
4. **遇到验证码要告知用户**
5. **可以的，失败是可以接受的**——不要过度尝试造成破坏
6. **两种任务模式**：
   - 精确步骤指令 → 严格按步骤执行
   - 开放式任务 → 自主规划

## 📊 User Prompt 组装

每一步发送给 LLM 的用户消息由 `#assembleUserPrompt()` 动态组装：

```xml
<!-- 1. 可选指令 -->
<instructions>
    <system_instructions>全局指令（开发者配置的）</system_instructions>
    <page_instructions>页面级指令（按 URL 动态获取）</page_instructions>
    <llms_txt>网站的 /llms.txt 内容（实验性）</llms_txt>
</instructions>

<!-- 2. Agent 状态 -->
<agent_state>
    <user_request>点击登录按钮</user_request>
    <step_info>Step 2 of 40 max possible steps
    Current time: 2026/3/21 23:00:00</step_info>
</agent_state>

<!-- 3. 历史记录 -->
<agent_history>
    <step_1>
    Evaluation of Previous Step: 成功导航到首页
    Memory: 首页已加载，可以看到登录按钮
    Next Goal: 点击登录按钮
    Action Results: ✅ Clicked element (登录)
    </step_1>
    <sys>Page navigated to → https://example.com/login</sys>
</agent_history>

<!-- 4. 浏览器状态 -->
<browser_state>
Current Page: [Example](https://example.com/login)
Page info: 1920x1080px viewport, 1920x2400px total page size...

Interactive elements from top layer of the current page inside the viewport:

[Start of page]
[0]<input placeholder="用户名"/>
[1]<input type="password" placeholder="密码"/>
[2]<button>登录</button>
[3]<a>忘记密码？</a>
... 300 pixels below ...
</browser_state>
```

## 🔄 "反思后行动" 模型

PageAgent 采用 **Reflection-Before-Action** 心智模型。每次 LLM 输出必须包含反思：

```json
{
    "evaluation_previous_goal": "上一步点击了登录按钮，页面跳转到登录表单。Verdict: Success",
    "memory": "用户需要登录。当前在登录页面，看到用户名和密码输入框。",
    "next_goal": "在用户名输入框中输入用户提供的用户名",
    "action": {
        "input_text": {
            "index": 0,
            "text": "admin@example.com"
        }
    }
}
```

这种设计的好处：
- 让 LLM 先评估结果再行动，减少盲目操作
- 通过 memory 字段保持跨步骤的记忆
- 通过 next_goal 强制规划，提高任务成功率

## 🔌 如何接入不同的 LLM

### 基本配置

```typescript
const agent = new PageAgent({
    model: 'qwen3.5-plus',                          // 模型名称
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',  // API 地址
    apiKey: 'sk-your-key',                           // API 密钥
    language: 'zh-CN',                               // Agent 语言
})
```

### 支持的 LLM 提供商

只要兼容 OpenAI 格式的 `/chat/completions` 接口就能用：

| 提供商 | baseURL | 模型示例 |
|--------|---------|----------|
| 阿里云·百炼 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen3.5-plus` |
| OpenAI | `https://api.openai.com/v1` | `gpt-5.2` |
| Anthropic | `https://api.anthropic.com/v1` | `claude-sonnet-4-20250514` |
| 本地 Ollama | `http://localhost:11434/v1` | `qwen3:14b` |

### 高级配置

```typescript
const agent = new PageAgent({
    model: 'gpt-5.2',
    baseURL: 'https://api.openai.com/v1',
    apiKey: 'sk-...',

    temperature: 0.7,           // 温度（会被模型补丁覆盖）
    maxRetries: 3,              // LLM 调用失败重试次数
    maxSteps: 40,               // 单个任务最大步数

    // 自定义 fetch（用于代理、自定义 header 等）
    customFetch: async (url, init) => {
        init.headers['X-Custom'] = 'value'
        return fetch(url, init)
    },

    // 关闭命名工具选择（修复某些模型的兼容性问题）
    disableNamedToolChoice: false,
})
```

## 💰 Token 用量

每一步的 token 消耗大致分布：
- **System Prompt**：~2000 tokens（固定开销）
- **页面内容**：500-5000 tokens（取决于页面复杂度）
- **历史记录**：随步数线性增长
- **LLM 输出**：~200-500 tokens

一个典型的 5 步任务可能消耗 **20,000-50,000 tokens**。
