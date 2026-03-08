# TypeScript Agent 实现

这是 learn-claude-code 项目中所有 Python agent 的 TypeScript 版本实现。

## 快速开始

### 安装依赖

```bash
npm install
```

### 配置环境变量

在项目根目录创建 `.env` 文件（或使用已有的）:

```bash
ANTHROPIC_API_KEY=your_api_key_here
MODEL_ID=claude-sonnet-4-6
# 可选：使用兼容 Anthropic 的其他提供商
# ANTHROPIC_BASE_URL=https://api.example.com
```

### 运行 Agent

使用 npm scripts:

```bash
npm run s01  # 基础 agent 循环
npm run s02  # 工具调度
npm run s03  # TodoWrite 机制
npm run s04  # 子代理模式
npm run s05  # 技能加载
npm run s06  # 上下文压缩
npm run s07  # 任务系统
npm run s08  # 后台任务
npm run s09  # 代理团队
npm run s10  # 团队协议
npm run s11  # 自主代理
npm run s12  # Worktree 隔离
npm run full # 完整版本
```

或直接使用 tsx:

```bash
npx tsx s01_agent_loop.ts
npx tsx s02_tool_use.ts
# ... 等等
```

## 文件说明

### Phase 1: THE LOOP

- **s01_agent_loop.ts** (4.3K) - 基础 agent 循环
  - 核心模式: `while stop_reason == "tool_use"`
  - 单一工具: bash 命令执行

- **s02_tool_use.ts** (6.8K) - 工具调度
  - 工具调度映射: `{tool_name: handler}`
  - 工具: bash, read_file, write_file, edit_file

### Phase 2: PLANNING & KNOWLEDGE

- **s03_todo_write.ts** (10K) - TodoWrite 机制
  - TodoManager 类管理任务状态
  - 支持 pending/in_progress/completed 状态
  - Nag reminder: 3轮未更新自动提醒

- **s04_subagent.ts** (9.4K) - 子代理模式
  - 独立消息上下文
  - 父代理只接收摘要
  - 防止递归派发

- **s05_skill_loading.ts** (10K) - 技能加载
  - SkillLoader 扫描 skills/ 目录
  - YAML frontmatter 解析
  - 两层加载: 列表 + 按需加载

- **s06_context_compact.ts** (11K) - 上下文压缩
  - 三层压缩策略:
    - microCompact: 每轮清理旧 tool_result
    - autoCompact: token > 50000 自动压缩
    - compact 工具: 手动触发
  - 保存完整记录到 .transcripts/

### Phase 3: PERSISTENCE

- **s07_task_system.ts** (12K) - 任务系统
  - JSON 文件持久化
  - 任务依赖图 (blockedBy/blocks)
  - TaskManager CRUD 操作

- **s08_background_tasks.ts** (11K) - 后台任务
  - child_process.exec 后台执行
  - BackgroundManager 管理队列
  - 通知队列机制

### Phase 4: TEAMS

- **s09_agent_teams.ts** (19K) - 代理团队
  - JSONL 消息收件箱
  - TeammateManager 管理团队
  - MessageBus 团队通信

- **s10_team_protocols.ts** (23K) - 团队协议
  - 关闭协议
  - 计划审批协议
  - FSM 状态管理

- **s11_autonomous_agents.ts** (26K) - 自主代理
  - 任务自动认领
  - 空闲轮询
  - 身份重注入

- **s12_worktree_task_isolation.ts** (24K) - Worktree 隔离
  - EventBus 事件追踪
  - WorktreeManager git worktree 操作
  - 任务与 worktree 绑定

### 完整版本

- **s_full.ts** - 整合所有机制
  - 包含所有 Phase 1-4 的功能
  - 生产级特性组合

## 技术栈

- **TypeScript** - 类型安全
- **@anthropic-ai/sdk** - Anthropic API 客户端
- **dotenv** - 环境变量管理
- **tsx** - TypeScript 执行器
- **Node.js 内置模块**:
  - `child_process` - 命令执行和后台任务
  - `fs` - 文件系统操作
  - `readline` - 交互式输入
  - `path` - 路径处理

## 与 Python 版本的差异

1. **异步处理**: 使用 `async/await` 替代 Python 的同步调用
2. **后台任务**: 使用 `child_process.exec` 替代 `threading.Thread`
3. **类型系统**: 完整的 TypeScript 类型定义
4. **模块系统**: ES Modules (`import/export`)
5. **JSON 处理**: 原生 JSON 支持,无需额外库

## 开发建议

- 使用 VSCode 获得完整的类型提示
- 运行前确保 `.env` 配置正确
- 查看 Python 版本的注释了解设计理念
- 从 s01 开始逐步学习,理解渐进式架构

## 相关资源

- [Python 版本](../) - 原始实现
- [项目文档](../../docs/) - 详细文档
- [Web 平台](../../web/) - 交互式学习平台

## License

与主项目保持一致
