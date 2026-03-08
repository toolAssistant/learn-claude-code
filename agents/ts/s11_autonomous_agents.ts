#!/usr/bin/env tsx
/**
 * s11_autonomous_agents.ts - 自主 Agent
 *
 * 空闲循环，任务板轮询，自动认领未认领的任务，以及
 * 上下文压缩后的身份重注入。基于 s10 的协议构建。
 *
 *     队友生命周期：
 *     +-------+
 *     | spawn |
 *     +---+---+
 *         |
 *         v
 *     +-------+  tool_use    +-------+
 *     | WORK  | <----------- |  LLM  |
 *     +---+---+              +-------+
 *         |
 *         | stop_reason != tool_use
 *         v
 *     +--------+
 *     | IDLE   | 每 5 秒轮询一次，最多 60 秒
 *     +---+----+
 *         |
 *         +---> 检查收件箱 -> 有消息？ -> 恢复 WORK
 *         |
 *         +---> 扫描 .tasks/ -> 有未认领任务？ -> 认领 -> 恢复 WORK
 *         |
 *         +---> 超时 (60s) -> shutdown
 *
 *     压缩后的身份重注入：
 *     messages = [identity_block, ...remaining...]
 *     "You are 'coder', role: backend, team: my-team"
 *
 * 关键洞察："Agent 自己找工作。"
 */

import Anthropic from "@anthropic-ai/sdk";
import { config } from "dotenv";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { randomUUID } from "crypto";

// 加载环境变量
config({ override: true });

// 处理自定义 base URL
if (process.env.ANTHROPIC_BASE_URL) {
  delete process.env.ANTHROPIC_AUTH_TOKEN;
}

const WORKDIR = process.cwd();
const client = new Anthropic({
  baseURL: process.env.ANTHROPIC_BASE_URL,
});
const MODEL = process.env.MODEL_ID!;
const TEAM_DIR = path.join(WORKDIR, ".team");
const INBOX_DIR = path.join(TEAM_DIR, "inbox");
const TASKS_DIR = path.join(WORKDIR, ".tasks");  // 任务板目录

// 空闲轮询配置
const POLL_INTERVAL = 5;   // 轮询间隔：5 秒
const IDLE_TIMEOUT = 60;   // 空闲超时：60 秒

// 系统提示词：强调队友的自主性
const SYSTEM = `You are a team lead at ${WORKDIR}. Teammates are autonomous -- they find work themselves.`;

// 有效的消息类型集合
const VALID_MSG_TYPES = new Set([
  "message",
  "broadcast",
  "shutdown_request",
  "shutdown_response",
  "plan_approval_response",
]);

// -- 请求跟踪器 --
const shutdownRequests: Record<string, any> = {};  // 关闭请求映射
const planRequests: Record<string, any> = {};      // 计划请求映射

/**
 * 消息总线：基于 JSONL 文件的异步消息系统
 * 与 s09/s10 相同
 */
class MessageBus {
  private dir: string;

  constructor(inboxDir: string) {
    this.dir = inboxDir;
    fs.mkdirSync(this.dir, { recursive: true });
  }

  /**
   * 发送消息到指定队友的收件箱
   */
  send(
    sender: string,
    to: string,
    content: string,
    msgType: string = "message",
    extra?: Record<string, any>
  ): string {
    if (!VALID_MSG_TYPES.has(msgType)) {
      return `Error: Invalid type '${msgType}'. Valid: ${Array.from(VALID_MSG_TYPES).join(", ")}`;
    }
    const msg: Record<string, any> = {
      type: msgType,
      from: sender,
      content,
      timestamp: Date.now() / 1000,
    };
    if (extra) {
      Object.assign(msg, extra);
    }
    const inboxPath = path.join(this.dir, `${to}.jsonl`);
    fs.appendFileSync(inboxPath, JSON.stringify(msg) + "\n");
    return `Sent ${msgType} to ${to}`;
  }

  /**
   * 读取并清空收件箱
   */
  readInbox(name: string): any[] {
    const inboxPath = path.join(this.dir, `${name}.jsonl`);
    if (!fs.existsSync(inboxPath)) {
      return [];
    }
    const messages: any[] = [];
    const lines = fs.readFileSync(inboxPath, "utf-8").trim().split("\n");
    for (const line of lines) {
      if (line) {
        messages.push(JSON.parse(line));
      }
    }
    fs.writeFileSync(inboxPath, "");
    return messages;
  }

  /**
   * 广播消息给所有队友
   */
  broadcast(sender: string, content: string, teammates: string[]): string {
    let count = 0;
    for (const name of teammates) {
      if (name !== sender) {
        this.send(sender, name, content, "broadcast");
        count++;
      }
    }
    return `Broadcast to ${count} teammates`;
  }
}

const BUS = new MessageBus(INBOX_DIR);

// -- 任务板扫描 --

/**
 * 任务接口：描述一个任务的结构
 */
interface Task {
  id: number;           // 任务 ID
  subject: string;      // 任务主题
  description?: string; // 任务描述（可选）
  status: string;       // 任务状态：pending, in_progress, completed
  owner?: string;       // 任务所有者（可选）
  blockedBy?: number[]; // 阻塞任务列表（可选）
}

/**
 * 扫描未认领的任务
 *
 * 查找满足以下条件的任务：
 * - status 为 "pending"
 * - 没有 owner
 * - 没有被其他任务阻塞（blockedBy 为空）
 *
 * @returns 未认领的任务数组
 */
function scanUnclaimedTasks(): Task[] {
  fs.mkdirSync(TASKS_DIR, { recursive: true });
  const unclaimed: Task[] = [];
  // 读取所有任务文件
  const files = fs.readdirSync(TASKS_DIR).filter((f) => f.startsWith("task_") && f.endsWith(".json"));
  for (const file of files.sort()) {
    const task = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, file), "utf-8"));
    // 检查任务是否可认领
    if (
      task.status === "pending" &&
      !task.owner &&
      (!task.blockedBy || task.blockedBy.length === 0)
    ) {
      unclaimed.push(task);
    }
  }
  return unclaimed;
}

/**
 * 认领任务：将任务分配给指定队友
 *
 * @param taskId - 任务 ID
 * @param owner - 队友名称
 * @returns 成功消息或错误信息
 */
function claimTask(taskId: number, owner: string): string {
  const taskPath = path.join(TASKS_DIR, `task_${taskId}.json`);
  if (!fs.existsSync(taskPath)) {
    return `Error: Task ${taskId} not found`;
  }
  const task = JSON.parse(fs.readFileSync(taskPath, "utf-8"));
  // 更新任务状态
  task.owner = owner;
  task.status = "in_progress";
  fs.writeFileSync(taskPath, JSON.stringify(task, null, 2));
  return `Claimed task #${taskId} for ${owner}`;
}

/**
 * 创建身份块：用于上下文压缩后重注入身份信息
 *
 * 当对话历史被压缩后，队友可能"忘记"自己的身份。
 * 这个函数创建一个身份提醒消息，重新告诉 LLM 它是谁。
 *
 * @param name - 队友名称
 * @param role - 角色描述
 * @param teamName - 团队名称
 * @returns 身份消息块
 */
function makeIdentityBlock(name: string, role: string, teamName: string): Anthropic.MessageParam {
  return {
    role: "user",
    content: `<identity>You are '${name}', role: ${role}, team: ${teamName}. Continue your work.</identity>`,
  };
}

// -- 基础工具实现（与 s02 相同）--

/**
 * 安全路径检查：防止路径遍历攻击
 */
function safePath(p: string): string {
  const resolved = path.resolve(WORKDIR, p);
  if (!resolved.startsWith(WORKDIR)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return resolved;
}

/**
 * 执行 bash 命令
 */
function runBash(command: string): string {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot"];
  if (dangerous.some((d) => command.includes(d))) {
    return "Error: Dangerous command blocked";
  }
  try {
    const output = execSync(command, {
      cwd: WORKDIR,
      encoding: "utf-8",
      timeout: 120000,
      maxBuffer: 50000 * 1024,
    });
    return output.trim().slice(0, 50000) || "(no output)";
  } catch (error: any) {
    const stderr = error.stderr?.toString() || error.message;
    return stderr.slice(0, 50000);
  }
}

/**
 * 读取文件内容
 */
function runRead(filePath: string, limit?: number): string {
  try {
    const content = fs.readFileSync(safePath(filePath), "utf-8");
    let lines = content.split("\n");
    if (limit && limit < lines.length) {
      lines = lines.slice(0, limit);
      lines.push(`... (${content.split("\n").length - limit} more)`);
    }
    return lines.join("\n").slice(0, 50000);
  } catch (error: any) {
    return `Error: ${error.message}`;
  }
}

/**
 * 写入文件
 */
function runWrite(filePath: string, content: string): string {
  try {
    const fp = safePath(filePath);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, content);
    return `Wrote ${content.length} bytes`;
  } catch (error: any) {
    return `Error: ${error.message}`;
  }
}

/**
 * 编辑文件：替换指定文本
 */
function runEdit(filePath: string, oldText: string, newText: string): string {
  try {
    const fp = safePath(filePath);
    let content = fs.readFileSync(fp, "utf-8");
    if (!content.includes(oldText)) {
      return `Error: Text not found in ${filePath}`;
    }
    content = content.replace(oldText, newText);
    fs.writeFileSync(fp, content);
    return `Edited ${filePath}`;
  } catch (error: any) {
    return `Error: ${error.message}`;
  }
}

// -- 自主队友管理器 --

/**
 * 团队成员接口
 */
interface TeamMember {
  name: string;    // 成员名称
  role: string;    // 角色
  status: string;  // 状态：idle, working, shutdown
}

/**
 * 团队配置接口
 */
interface TeamConfig {
  team_name: string;      // 团队名称
  members: TeamMember[];  // 成员列表
}

/**
 * 自主队友管理器：支持空闲轮询和任务自动认领
 *
 * 新增功能（相比 s10）：
 * - 空闲阶段：队友完成工作后进入空闲状态
 * - 轮询机制：定期检查收件箱和任务板
 * - 自动认领：发现未认领任务时自动认领并恢复工作
 * - 身份重注入：压缩后重新注入身份信息
 */
class TeammateManager {
  private dir: string;
  private configPath: string;
  private config: TeamConfig;
  private threads: Map<string, Promise<void>>;

  constructor(teamDir: string) {
    this.dir = teamDir;
    fs.mkdirSync(this.dir, { recursive: true });
    this.configPath = path.join(this.dir, "config.json");
    this.config = this.loadConfig();
    this.threads = new Map();
  }

  private loadConfig(): TeamConfig {
    if (fs.existsSync(this.configPath)) {
      return JSON.parse(fs.readFileSync(this.configPath, "utf-8"));
    }
    return { team_name: "default", members: [] };
  }

  private saveConfig(): void {
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
  }

  private findMember(name: string): TeamMember | undefined {
    return this.config.members.find((m) => m.name === name);
  }

  /**
   * 设置成员状态并保存
   */
  private setStatus(name: string, status: string): void {
    const member = this.findMember(name);
    if (member) {
      member.status = status;
      this.saveConfig();
    }
  }

  /**
   * 生成自主队友
   */
  spawn(name: string, role: string, prompt: string): string {
    const member = this.findMember(name);
    if (member) {
      if (!["idle", "shutdown"].includes(member.status)) {
        return `Error: '${name}' is currently ${member.status}`;
      }
      member.status = "working";
      member.role = role;
    } else {
      this.config.members.push({ name, role, status: "working" });
    }
    this.saveConfig();
    const thread = this.loop(name, role, prompt);
    this.threads.set(name, thread);
    return `Spawned '${name}' (role: ${role})`;
  }

  /**
   * 自主队友的主循环：工作阶段 + 空闲阶段
   *
   * 这是 s11 的核心创新：两阶段循环
   *
   * 阶段 1 - 工作阶段 (WORK PHASE)：
   *   - 标准 agent 循环：调用 LLM -> 执行工具 -> 反馈结果
   *   - 检查收件箱消息
   *   - 如果 LLM 调用 idle 工具，进入空闲阶段
   *
   * 阶段 2 - 空闲阶段 (IDLE PHASE)：
   *   - 定期轮询（每 5 秒）
   *   - 检查收件箱：有新消息？-> 恢复工作
   *   - 扫描任务板：有未认领任务？-> 认领并恢复工作
   *   - 超时（60 秒）：没有新工作 -> 关闭
   *
   * @param name - 队友名称
   * @param role - 角色描述
   * @param prompt - 初始任务提示词
   */
  private async loop(name: string, role: string, prompt: string): Promise<void> {
    const teamName = this.config.team_name;
    // 系统提示词：告诉队友使用 idle 工具，并且会自动认领任务
    const sysPrompt = `You are '${name}', role: ${role}, team: ${teamName}, at ${WORKDIR}. Use idle tool when you have no more work. You will auto-claim new tasks.`;
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: prompt }];
    const tools = this.teammateTools();

    // 外层循环：工作 -> 空闲 -> 工作 -> ...
    while (true) {
      // -- 工作阶段：标准 agent 循环 --
      for (let i = 0; i < 50; i++) {
        // 检查收件箱
        const inbox = BUS.readInbox(name);
        for (const msg of inbox) {
          // 特殊处理：关闭请求立即退出
          if (msg.type === "shutdown_request") {
            this.setStatus(name, "shutdown");
            return;
          }
          messages.push({ role: "user", content: JSON.stringify(msg) });
        }

        // 调用 LLM
        let response: Anthropic.Message;
        try {
          response = await client.messages.create({
            model: MODEL,
            system: sysPrompt,
            messages,
            tools,
            max_tokens: 8000,
          });
        } catch (error) {
          // API 错误：设置为空闲并退出
          this.setStatus(name, "idle");
          return;
        }

        // 追加 LLM 响应
        messages.push({ role: "assistant", content: response.content });

        // 检查是否需要工具
        if (response.stop_reason !== "tool_use") {
          break;  // 任务完成，退出工作循环
        }

        // 执行工具调用
        const results: Anthropic.ToolResultBlockParam[] = [];
        let idleRequested = false;  // 标记是否请求进入空闲状态
        for (const block of response.content) {
          if (block.type === "tool_use") {
            let output: string;
            // 特殊处理：idle 工具
            if (block.name === "idle") {
              idleRequested = true;
              output = "Entering idle phase. Will poll for new tasks.";
            } else {
              output = this.exec(name, block.name, block.input as Record<string, any>);
            }
            console.log(`  [${name}] ${block.name}: ${output.slice(0, 120)}`);
            results.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: output,
            });
          }
        }

        // 将工具结果反馈给 LLM
        messages.push({ role: "user", content: results });

        // 如果请求空闲，退出工作循环
        if (idleRequested) {
          break;
        }
      }

      // -- 空闲阶段：轮询收件箱和任务板 --
      this.setStatus(name, "idle");
      let resume = false;  // 标记是否恢复工作
      const polls = Math.floor(IDLE_TIMEOUT / Math.max(POLL_INTERVAL, 1));  // 计算轮询次数

      for (let i = 0; i < polls; i++) {
        // 等待轮询间隔
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL * 1000));

        // 检查收件箱：有新消息？
        const inbox = BUS.readInbox(name);
        if (inbox.length > 0) {
          for (const msg of inbox) {
            // 特殊处理：关闭请求
            if (msg.type === "shutdown_request") {
              this.setStatus(name, "shutdown");
              return;
            }
            messages.push({ role: "user", content: JSON.stringify(msg) });
          }
          resume = true;
          break;  // 有消息，恢复工作
        }

        // 扫描任务板：有未认领任务？
        const unclaimed = scanUnclaimedTasks();
        if (unclaimed.length > 0) {
          const task = unclaimed[0];  // 取第一个未认领任务
          claimTask(task.id, name);   // 认领任务

          // 构造任务提示词
          const taskPrompt = `<auto-claimed>Task #${task.id}: ${task.subject}\n${task.description || ""}</auto-claimed>`;

          // 身份重注入：如果对话历史太短，重新注入身份
          if (messages.length <= 3) {
            messages.unshift(makeIdentityBlock(name, role, teamName));
            messages.splice(1, 0, { role: "assistant", content: `I am ${name}. Continuing.` });
          }

          // 添加任务提示词
          messages.push({ role: "user", content: taskPrompt });
          messages.push({ role: "assistant", content: `Claimed task #${task.id}. Working on it.` });

          resume = true;
          break;  // 有任务，恢复工作
        }
      }

      // 空闲超时：没有新工作，关闭
      if (!resume) {
        this.setStatus(name, "shutdown");
        return;
      }

      // 恢复工作：回到外层循环的工作阶段
      this.setStatus(name, "working");
    }
  }

  /**
   * 执行队友的工具调用
   *
   * 新增工具（相比 s10）：
   * - claim_task: 手动认领任务（除了自动认领外，也可以手动认领）
   */
  private exec(sender: string, toolName: string, args: Record<string, any>): string {
    // 基础工具
    if (toolName === "bash") {
      return runBash(args.command);
    }
    if (toolName === "read_file") {
      return runRead(args.path);
    }
    if (toolName === "write_file") {
      return runWrite(args.path, args.content);
    }
    if (toolName === "edit_file") {
      return runEdit(args.path, args.old_text, args.new_text);
    }
    // 通信工具
    if (toolName === "send_message") {
      return BUS.send(sender, args.to, args.content, args.msg_type || "message");
    }
    if (toolName === "read_inbox") {
      return JSON.stringify(BUS.readInbox(sender), null, 2);
    }
    // 协议工具
    if (toolName === "shutdown_response") {
      const reqId = args.request_id;
      if (shutdownRequests[reqId]) {
        shutdownRequests[reqId].status = args.approve ? "approved" : "rejected";
      }
      BUS.send(sender, "lead", args.reason || "", "shutdown_response", {
        request_id: reqId,
        approve: args.approve,
      });
      return `Shutdown ${args.approve ? "approved" : "rejected"}`;
    }
    if (toolName === "plan_approval") {
      const planText = args.plan || "";
      const reqId = randomUUID().slice(0, 8);
      planRequests[reqId] = { from: sender, plan: planText, status: "pending" };
      BUS.send(sender, "lead", planText, "plan_approval_response", {
        request_id: reqId,
        plan: planText,
      });
      return `Plan submitted (request_id=${reqId}). Waiting for approval.`;
    }
    // 任务工具：手动认领任务
    if (toolName === "claim_task") {
      return claimTask(args.task_id, sender);
    }
    return `Unknown tool: ${toolName}`;
  }

  /**
   * 队友可用的工具列表
   *
   * 新增工具（相比 s10）：
   * - idle: 进入空闲状态，开始轮询
   * - claim_task: 手动认领任务
   */
  private teammateTools(): Anthropic.Tool[] {
    return [
      {
        name: "bash",
        description: "Run a shell command.",
        input_schema: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
        },
      },
      {
        name: "read_file",
        description: "Read file contents.",
        input_schema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
      {
        name: "write_file",
        description: "Write content to file.",
        input_schema: {
          type: "object",
          properties: {
            path: { type: "string" },
            content: { type: "string" },
          },
          required: ["path", "content"],
        },
      },
      {
        name: "edit_file",
        description: "Replace exact text in file.",
        input_schema: {
          type: "object",
          properties: {
            path: { type: "string" },
            old_text: { type: "string" },
            new_text: { type: "string" },
          },
          required: ["path", "old_text", "new_text"],
        },
      },
      {
        name: "send_message",
        description: "Send message to a teammate.",
        input_schema: {
          type: "object",
          properties: {
            to: { type: "string" },
            content: { type: "string" },
            msg_type: { type: "string", enum: Array.from(VALID_MSG_TYPES) },
          },
          required: ["to", "content"],
        },
      },
      {
        name: "read_inbox",
        description: "Read and drain your inbox.",
        input_schema: { type: "object", properties: {} },
      },
      {
        name: "shutdown_response",
        description: "Respond to a shutdown request.",
        input_schema: {
          type: "object",
          properties: {
            request_id: { type: "string" },
            approve: { type: "boolean" },
            reason: { type: "string" },
          },
          required: ["request_id", "approve"],
        },
      },
      {
        name: "plan_approval",
        description: "Submit a plan for lead approval.",
        input_schema: {
          type: "object",
          properties: { plan: { type: "string" } },
          required: ["plan"],
        },
      },
      {
        name: "idle",
        description: "Signal that you have no more work. Enters idle polling phase.",
        input_schema: { type: "object", properties: {} },
      },
      {
        name: "claim_task",
        description: "Claim a task from the task board by ID.",
        input_schema: {
          type: "object",
          properties: { task_id: { type: "integer" } },
          required: ["task_id"],
        },
      },
    ];
  }

  /**
   * 列出所有队友及其状态
   */
  listAll(): string {
    if (this.config.members.length === 0) {
      return "No teammates.";
    }
    const lines = [`Team: ${this.config.team_name}`];
    for (const m of this.config.members) {
      lines.push(`  ${m.name} (${m.role}): ${m.status}`);
    }
    return lines.join("\n");
  }

  /**
   * 获取所有成员名称
   */
  memberNames(): string[] {
    return this.config.members.map((m) => m.name);
  }
}

const TEAM = new TeammateManager(TEAM_DIR);

// -- Lead 专用协议处理函数 --

/**
 * 处理关闭请求：向队友发送关闭请求
 */
function handleShutdownRequest(teammate: string): string {
  const reqId = randomUUID().slice(0, 8);
  shutdownRequests[reqId] = { target: teammate, status: "pending" };
  BUS.send("lead", teammate, "Please shut down gracefully.", "shutdown_request", {
    request_id: reqId,
  });
  return `Shutdown request ${reqId} sent to '${teammate}'`;
}

/**
 * 处理计划审批：批准或拒绝队友提交的计划
 */
function handlePlanReview(requestId: string, approve: boolean, feedback: string = ""): string {
  const req = planRequests[requestId];
  if (!req) {
    return `Error: Unknown plan request_id '${requestId}'`;
  }
  req.status = approve ? "approved" : "rejected";
  BUS.send("lead", req.from, feedback, "plan_approval_response", {
    request_id: requestId,
    approve,
    feedback,
  });
  return `Plan ${req.status} for '${req.from}'`;
}

/**
 * 检查关闭请求状态
 */
function checkShutdownStatus(requestId: string): string {
  return JSON.stringify(shutdownRequests[requestId] || { error: "not found" });
}

// -- Lead 工具调度映射 --

/**
 * Lead 工具处理函数映射表
 *
 * 新增工具（相比 s10）：
 * - idle: Lead 不使用空闲功能
 * - claim_task: Lead 也可以认领任务
 */
const TOOL_HANDLERS: Record<string, (args: any) => string> = {
  bash: (args) => runBash(args.command),
  read_file: (args) => runRead(args.path, args.limit),
  write_file: (args) => runWrite(args.path, args.content),
  edit_file: (args) => runEdit(args.path, args.old_text, args.new_text),
  spawn_teammate: (args) => TEAM.spawn(args.name, args.role, args.prompt),
  list_teammates: () => TEAM.listAll(),
  send_message: (args) => BUS.send("lead", args.to, args.content, args.msg_type || "message"),
  read_inbox: () => JSON.stringify(BUS.readInbox("lead"), null, 2),
  broadcast: (args) => BUS.broadcast("lead", args.content, TEAM.memberNames()),
  shutdown_request: (args) => handleShutdownRequest(args.teammate),
  shutdown_response: (args) => checkShutdownStatus(args.request_id || ""),
  plan_approval: (args) => handlePlanReview(args.request_id, args.approve, args.feedback || ""),
  idle: () => "Lead does not idle.",                    // Lead 不进入空闲状态
  claim_task: (args) => claimTask(args.task_id, "lead"), // Lead 也可以认领任务
};

const TOOLS: Anthropic.Tool[] = [
  {
    name: "bash",
    description: "Run a shell command.",
    input_schema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
  {
    name: "read_file",
    description: "Read file contents.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        limit: { type: "integer" },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write content to file.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description: "Replace exact text in file.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_text: { type: "string" },
        new_text: { type: "string" },
      },
      required: ["path", "old_text", "new_text"],
    },
  },
  {
    name: "spawn_teammate",
    description: "Spawn an autonomous teammate.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        role: { type: "string" },
        prompt: { type: "string" },
      },
      required: ["name", "role", "prompt"],
    },
  },
  {
    name: "list_teammates",
    description: "List all teammates.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "send_message",
    description: "Send a message to a teammate.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string" },
        content: { type: "string" },
        msg_type: { type: "string", enum: Array.from(VALID_MSG_TYPES) },
      },
      required: ["to", "content"],
    },
  },
  {
    name: "read_inbox",
    description: "Read and drain the lead's inbox.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "broadcast",
    description: "Send a message to all teammates.",
    input_schema: {
      type: "object",
      properties: { content: { type: "string" } },
      required: ["content"],
    },
  },
  {
    name: "shutdown_request",
    description: "Request a teammate to shut down.",
    input_schema: {
      type: "object",
      properties: { teammate: { type: "string" } },
      required: ["teammate"],
    },
  },
  {
    name: "shutdown_response",
    description: "Check shutdown request status.",
    input_schema: {
      type: "object",
      properties: { request_id: { type: "string" } },
      required: ["request_id"],
    },
  },
  {
    name: "plan_approval",
    description: "Approve or reject a teammate's plan.",
    input_schema: {
      type: "object",
      properties: {
        request_id: { type: "string" },
        approve: { type: "boolean" },
        feedback: { type: "string" },
      },
      required: ["request_id", "approve"],
    },
  },
  {
    name: "idle",
    description: "Enter idle state (for lead -- rarely used).",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "claim_task",
    description: "Claim a task from the board by ID.",
    input_schema: {
      type: "object",
      properties: { task_id: { type: "integer" } },
      required: ["task_id"],
    },
  },
];

/**
 * Lead 的 agent 循环：与 s10 相同
 * 每次循环前检查收件箱
 */
async function agentLoop(messages: Anthropic.MessageParam[]): Promise<void> {
  while (true) {
    // 检查收件箱
    const inbox = BUS.readInbox("lead");
    if (inbox.length > 0) {
      messages.push({
        role: "user",
        content: `<inbox>${JSON.stringify(inbox, null, 2)}</inbox>`,
      });
      messages.push({
        role: "assistant",
        content: "Noted inbox messages.",
      });
    }
    // 调用 LLM
    const response = await client.messages.create({
      model: MODEL,
      system: SYSTEM,
      messages,
      tools: TOOLS,
      max_tokens: 8000,
    });
    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") {
      return;
    }
    // 执行工具
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type === "tool_use") {
        const handler = TOOL_HANDLERS[block.name];
        let output: string;
        try {
          output = handler ? handler(block.input) : `Unknown tool: ${block.name}`;
        } catch (error: any) {
          output = `Error: ${error.message}`;
        }
        console.log(`> ${block.name}: ${output.slice(0, 200)}`);
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: output,
        });
      }
    }
    messages.push({ role: "user", content: results });
  }
}

/**
 * 主函数：交互式命令行界面
 *
 * 支持的特殊命令：
 * - /team: 列出所有队友
 * - /inbox: 查看 lead 的收件箱
 * - /tasks: 列出所有任务及其状态
 * - q/exit: 退出程序
 */
async function main() {
  const history: Anthropic.MessageParam[] = [];
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = (query: string): Promise<string> =>
    new Promise((resolve) => rl.question(query, resolve));

  while (true) {
    try {
      const query = await prompt("\x1b[36ms11 >> \x1b[0m");
      if (!query || ["q", "exit", ""].includes(query.trim().toLowerCase())) {
        break;
      }
      // 特殊命令：列出队友
      if (query.trim() === "/team") {
        console.log(TEAM.listAll());
        continue;
      }
      // 特殊命令：查看收件箱
      if (query.trim() === "/inbox") {
        console.log(JSON.stringify(BUS.readInbox("lead"), null, 2));
        continue;
      }
      // 特殊命令：列出任务板
      if (query.trim() === "/tasks") {
        fs.mkdirSync(TASKS_DIR, { recursive: true });
        const files = fs.readdirSync(TASKS_DIR).filter((f) => f.startsWith("task_") && f.endsWith(".json"));
        for (const file of files.sort()) {
          const t = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, file), "utf-8"));
          const marker = { pending: "[ ]", in_progress: "[>]", completed: "[x]" }[t.status] || "[?]";
          const owner = t.owner ? ` @${t.owner}` : "";
          console.log(`  ${marker} #${t.id}: ${t.subject}${owner}`);
        }
        continue;
      }
      // 处理普通用户输入
      history.push({ role: "user", content: query });
      await agentLoop(history);
      const responseContent = history[history.length - 1];
      if (responseContent.role === "assistant" && Array.isArray(responseContent.content)) {
        for (const block of responseContent.content) {
          if (block.type === "text") {
            console.log(block.text);
          }
        }
      }
      console.log();
    } catch (error) {
      // 处理 EOF（Ctrl+D）
      if (error instanceof Error && error.message.includes("EOF")) {
        break;
      }
      throw error;
    }
  }

  rl.close();
}

// 仅当直接运行此文件时执行
if (require.main === module || (typeof import.meta !== 'undefined' && import.meta.url === `file://${process.argv[1]}`)) {
  main().catch(console.error);
}

