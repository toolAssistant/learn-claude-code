#!/usr/bin/env tsx
/**
 * s09_agent_teams.ts - Agent 团队
 *
 * 持久化的命名 agent，使用基于文件的 JSONL 收件箱。每个队友在独立线程中
 * 运行自己的 agent 循环。通过追加式收件箱进行通信。
 *
 *     子 Agent (s04):  spawn -> 执行 -> 返回摘要 -> 销毁
 *     队友 (s09):      spawn -> 工作 -> 空闲 -> 工作 -> ... -> 关闭
 *
 *     .team/config.json                   .team/inbox/
 *     +----------------------------+      +------------------+
 *     | {"team_name": "default",   |      | alice.jsonl      |
 *     |  "members": [              |      | bob.jsonl        |
 *     |    {"name":"alice",        |      | lead.jsonl       |
 *     |     "role":"coder",        |      +------------------+
 *     |     "status":"idle"}       |
 *     |  ]}                        |      send_message("alice", "fix bug"):
 *     +----------------------------+        open("alice.jsonl", "a").write(msg)
 *
 *                                         read_inbox("alice"):
 *     spawn_teammate("alice","coder",...)   msgs = [json.loads(l) for l in ...]
 *          |                                open("alice.jsonl", "w").close()
 *          v                                return msgs  # 清空收件箱
 *     线程: alice               线程: bob
 *     +------------------+      +------------------+
 *     | agent_loop       |      | agent_loop       |
 *     | status: working  |      | status: idle     |
 *     | ... 运行工具     |      | ... 等待中 ...   |
 *     | status -> idle   |      |                  |
 *     +------------------+      +------------------+
 *
 *     5 种消息类型（全部声明，但不是全部在这里处理）：
 *     +-------------------------+-----------------------------------+
 *     | message                 | 普通文本消息                      |
 *     | broadcast               | 发送给所有队友                    |
 *     | shutdown_request        | 请求优雅关闭 (s10)                |
 *     | shutdown_response       | 批准/拒绝关闭 (s10)               |
 *     | plan_approval_response  | 批准/拒绝计划 (s10)               |
 *     +-------------------------+-----------------------------------+
 *
 * 关键洞察："可以互相对话的队友。"
 */

import Anthropic from "@anthropic-ai/sdk";
import { config } from "dotenv";
import { execSync } from "child_process";
import * as readline from "readline";
import * as fs from "fs";
import * as path from "path";

// 加载环境变量
config({ override: true });

// 处理自定义 base URL
if (process.env.ANTHROPIC_BASE_URL) {
  delete process.env.ANTHROPIC_AUTH_TOKEN;
}

// 工作目录：所有操作的根目录
const WORKDIR = process.cwd();
const client = new Anthropic({
  baseURL: process.env.ANTHROPIC_BASE_URL,
});

const MODEL = process.env.MODEL_ID!;
// 团队配置目录：存储团队信息和收件箱
const TEAM_DIR = path.join(WORKDIR, ".team");
const INBOX_DIR = path.join(TEAM_DIR, "inbox");

// 系统提示词：定义 lead 的角色
const SYSTEM = `You are a team lead at ${WORKDIR}. Spawn teammates and communicate via inboxes.`;

// 有效的消息类型集合：用于验证消息类型
const VALID_MSG_TYPES = new Set([
  "message",                  // 普通消息
  "broadcast",                // 广播消息
  "shutdown_request",         // 关闭请求 (s10)
  "shutdown_response",        // 关闭响应 (s10)
  "plan_approval_response",   // 计划审批响应 (s10)
]);

// -- 类型定义 --

/**
 * 消息接口：JSONL 收件箱中的消息格式
 */
interface Message {
  type: string;        // 消息类型
  from: string;        // 发送者名称
  content: string;     // 消息内容
  timestamp: number;   // 时间戳（秒）
  [key: string]: any;  // 额外字段（如 request_id）
}

/**
 * 团队成员接口：描述一个队友的状态
 */
interface TeamMember {
  name: string;                                // 成员名称
  role: string;                                // 角色（如 "coder", "tester"）
  status: "idle" | "working" | "shutdown";     // 状态：空闲/工作中/已关闭
}

/**
 * 团队配置接口：存储在 .team/config.json 中
 */
interface TeamConfig {
  team_name: string;      // 团队名称
  members: TeamMember[];  // 成员列表
}

/**
 * 消息总线：基于 JSONL 文件的异步消息系统
 *
 * 每个队友都有自己的 JSONL 收件箱文件（如 alice.jsonl）
 * 消息通过追加写入实现异步通信，读取时清空收件箱
 */
class MessageBus {
  private dir: string;  // 收件箱目录路径

  /**
   * 构造函数：初始化消息总线
   * @param inboxDir - 收件箱目录路径
   */
  constructor(inboxDir: string) {
    this.dir = inboxDir;
    // 确保收件箱目录存在
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true });
    }
  }

  /**
   * 发送消息到指定队友的收件箱
   * @param sender - 发送者名称
   * @param to - 接收者名称
   * @param content - 消息内容
   * @param msgType - 消息类型（默认 "message"）
   * @param extra - 额外字段（如 request_id）
   * @returns 成功消息或错误信息
   */
  send(sender: string, to: string, content: string, msgType: string = "message", extra?: any): string {
    // 验证消息类型
    if (!VALID_MSG_TYPES.has(msgType)) {
      return `Error: Invalid type '${msgType}'. Valid: ${Array.from(VALID_MSG_TYPES).join(", ")}`;
    }

    // 构造消息对象
    const msg: Message = {
      type: msgType,
      from: sender,
      content,
      timestamp: Date.now() / 1000,  // Unix 时间戳（秒）
      ...extra,  // 展开额外字段
    };

    // 追加到接收者的 JSONL 文件
    const inboxPath = path.join(this.dir, `${to}.jsonl`);
    fs.appendFileSync(inboxPath, JSON.stringify(msg) + "\n");
    return `Sent ${msgType} to ${to}`;
  }

  /**
   * 读取并清空指定队友的收件箱
   * @param name - 队友名称
   * @returns 消息数组（读取后收件箱被清空）
   */
  readInbox(name: string): Message[] {
    const inboxPath = path.join(this.dir, `${name}.jsonl`);

    // 如果收件箱不存在，返回空数组
    if (!fs.existsSync(inboxPath)) {
      return [];
    }

    // 读取所有消息
    const messages: Message[] = [];
    const lines = fs.readFileSync(inboxPath, "utf-8").trim().split("\n");
    for (const line of lines) {
      if (line) {
        messages.push(JSON.parse(line));
      }
    }

    // 清空收件箱（drain 模式）
    fs.writeFileSync(inboxPath, "");
    return messages;
  }

  /**
   * 广播消息给所有队友（除了发送者自己）
   * @param sender - 发送者名称
   * @param content - 消息内容
   * @param teammates - 所有队友名称列表
   * @returns 成功消息（包含接收者数量）
   */
  broadcast(sender: string, content: string, teammates: string[]): string {
    let count = 0;
    for (const name of teammates) {
      if (name !== sender) {  // 不发送给自己
        this.send(sender, name, content, "broadcast");
        count++;
      }
    }
    return `Broadcast to ${count} teammates`;
  }
}

// 全局消息总线实例
const BUS = new MessageBus(INBOX_DIR);

/**
 * 队友管理器：管理持久化的命名 agent 及其配置
 *
 * 负责：
 * - 加载/保存团队配置（.team/config.json）
 * - 生成队友并在独立线程中运行
 * - 管理队友的生命周期和状态
 */
class TeammateManager {
  private dir: string;                          // 团队目录
  private configPath: string;                   // 配置文件路径
  private config: TeamConfig;                   // 团队配置
  private threads: Map<string, Promise<void>> = new Map();  // 线程映射：name -> Promise

  /**
   * 构造函数：初始化队友管理器
   * @param teamDir - 团队目录路径
   */
  constructor(teamDir: string) {
    this.dir = teamDir;
    // 确保团队目录存在
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true });
    }
    this.configPath = path.join(this.dir, "config.json");
    this.config = this.loadConfig();
  }

  /**
   * 加载团队配置
   * @returns 团队配置对象
   */
  private loadConfig(): TeamConfig {
    if (fs.existsSync(this.configPath)) {
      return JSON.parse(fs.readFileSync(this.configPath, "utf-8"));
    }
    // 默认配置
    return { team_name: "default", members: [] };
  }

  /**
   * 保存团队配置到磁盘
   */
  private saveConfig(): void {
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
  }

  /**
   * 查找指定名称的成员
   * @param name - 成员名称
   * @returns 成员对象或 undefined
   */
  private findMember(name: string): TeamMember | undefined {
    return this.config.members.find((m) => m.name === name);
  }

  /**
   * 生成一个新队友或重启已有队友
   * @param name - 队友名称
   * @param role - 角色描述
   * @param prompt - 初始任务提示词
   * @returns 成功消息或错误信息
   */
  spawn(name: string, role: string, prompt: string): string {
    let member = this.findMember(name);

    if (member) {
      // 队友已存在：检查状态
      if (member.status !== "idle" && member.status !== "shutdown") {
        return `Error: '${name}' is currently ${member.status}`;
      }
      // 重启队友
      member.status = "working";
      member.role = role;
    } else {
      // 创建新队友
      member = { name, role, status: "working" };
      this.config.members.push(member);
    }
    this.saveConfig();

    // 在独立线程中启动队友循环
    const thread = this.teammateLoop(name, role, prompt);
    this.threads.set(name, thread);

    return `Spawned '${name}' (role: ${role})`;
  }

  /**
   * 队友的 agent 循环：在独立线程中运行
   * @param name - 队友名称
   * @param role - 角色描述
   * @param prompt - 初始任务提示词
   */
  private async teammateLoop(name: string, role: string, prompt: string): Promise<void> {
    // 队友的系统提示词：定义身份和能力
    const sysPrompt = `You are '${name}', role: ${role}, at ${WORKDIR}. Use send_message to communicate. Complete your task.`;
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: prompt }];
    const tools = this.teammateTools();

    // 限制循环次数防止无限循环
    for (let i = 0; i < 50; i++) {
      // 检查收件箱：将新消息注入对话历史
      const inbox = BUS.readInbox(name);
      for (const msg of inbox) {
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
      } catch {
        // API 错误：退出循环
        break;
      }

      // 追加 LLM 响应
      messages.push({
        role: "assistant",
        content: response.content,
      });

      // 检查是否需要工具
      if (response.stop_reason !== "tool_use") {
        break;  // 任务完成
      }

      // 执行工具调用
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type === "tool_use") {
          const output = this.exec(name, block.name, block.input);
          // 打印工具调用（带队友名称前缀）
          console.log(`  [${name}] ${block.name}: ${output.slice(0, 120)}`);
          results.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: output,
          });
        }
      }

      // 将工具结果反馈给 LLM
      messages.push({
        role: "user",
        content: results,
      });
    }

    // 循环结束：更新状态为 idle
    const member = this.findMember(name);
    if (member && member.status !== "shutdown") {
      member.status = "idle";
      this.saveConfig();
    }
  }

  /**
   * 执行队友的工具调用
   * @param sender - 调用者名称
   * @param toolName - 工具名称
   * @param args - 工具参数
   * @returns 工具执行结果
   */
  private exec(sender: string, toolName: string, args: any): string {
    // 基础工具：与 s02 相同
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
    // 团队通信工具
    if (toolName === "send_message") {
      return BUS.send(sender, args.to, args.content, args.msg_type || "message");
    }
    if (toolName === "read_inbox") {
      return JSON.stringify(BUS.readInbox(sender), null, 2);
    }
    return `Unknown tool: ${toolName}`;
  }

  /**
   * 获取队友可用的工具列表
   * @returns 工具定义数组
   */
  private teammateTools(): Anthropic.Tool[] {
    // 基础工具定义：与 s02 相同
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
        input_schema: {
          type: "object",
          properties: {},
        },
      },
    ];
  }

  /**
   * 列出所有队友及其状态
   * @returns 格式化的队友列表字符串
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
   * @returns 成员名称数组
   */
  memberNames(): string[] {
    return this.config.members.map((m) => m.name);
  }
}

// 全局队友管理器实例
const TEAM = new TeammateManager(TEAM_DIR);

// -- 基础工具实现（与 s02 相同）--

/**
 * 安全路径检查：防止路径遍历攻击
 * @param p - 相对路径
 * @returns 解析后的绝对路径
 * @throws 如果路径试图逃逸工作目录
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
 * @param command - 要执行的命令
 * @returns 命令输出或错误信息
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
    return "Error: Timeout (120s)";
  }
}

/**
 * 读取文件内容
 * @param filePath - 文件路径
 * @param limit - 可选：限制读取的行数
 * @returns 文件内容或错误信息
 */
function runRead(filePath: string, limit?: number): string {
  try {
    const fullPath = safePath(filePath);
    const text = fs.readFileSync(fullPath, "utf-8");
    const lines = text.split("\n");
    if (limit && limit < lines.length) {
      return [...lines.slice(0, limit), `... (${lines.length - limit} more)`].join("\n").slice(0, 50000);
    }
    return text.slice(0, 50000);
  } catch (error: any) {
    return `Error: ${error.message}`;
  }
}

/**
 * 写入文件
 * @param filePath - 文件路径
 * @param content - 要写入的内容
 * @returns 成功消息或错误信息
 */
function runWrite(filePath: string, content: string): string {
  try {
    const fullPath = safePath(filePath);
    const dir = path.dirname(fullPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fullPath, content);
    return `Wrote ${content.length} bytes`;
  } catch (error: any) {
    return `Error: ${error.message}`;
  }
}

/**
 * 编辑文件：替换指定文本
 * @param filePath - 文件路径
 * @param oldText - 要替换的旧文本
 * @param newText - 新文本
 * @returns 成功消息或错误信息
 */
function runEdit(filePath: string, oldText: string, newText: string): string {
  try {
    const fullPath = safePath(filePath);
    const content = fs.readFileSync(fullPath, "utf-8");
    if (!content.includes(oldText)) {
      return `Error: Text not found in ${filePath}`;
    }
    fs.writeFileSync(fullPath, content.replace(oldText, newText));
    return `Edited ${filePath}`;
  } catch (error: any) {
    return `Error: ${error.message}`;
  }
}

// -- Lead 工具调度映射（9 个工具）--
type ToolHandler = (input: any) => string;

/**
 * 工具处理函数映射表
 * Lead 可以使用的所有工具及其处理函数
 */
const TOOL_HANDLERS: Record<string, ToolHandler> = {
  bash: (input) => runBash(input.command),                                      // 执行命令
  read_file: (input) => runRead(input.path, input.limit),                       // 读文件
  write_file: (input) => runWrite(input.path, input.content),                   // 写文件
  edit_file: (input) => runEdit(input.path, input.old_text, input.new_text),   // 编辑文件
  spawn_teammate: (input) => TEAM.spawn(input.name, input.role, input.prompt), // 生成队友
  list_teammates: () => TEAM.listAll(),                                         // 列出队友
  send_message: (input) => BUS.send("lead", input.to, input.content, input.msg_type || "message"), // 发消息
  read_inbox: () => JSON.stringify(BUS.readInbox("lead"), null, 2),            // 读收件箱
  broadcast: (input) => BUS.broadcast("lead", input.content, TEAM.memberNames()), // 广播
};

// Lead 工具定义数组（与 s02 基础工具相同）
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
    description: "Spawn a persistent teammate that runs in its own thread.",
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
    description: "List all teammates with name, role, status.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "send_message",
    description: "Send a message to a teammate's inbox.",
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
    input_schema: {
      type: "object",
      properties: {},
    },
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
];

/**
 * Lead 的 agent 循环：与 s02 相同的循环逻辑
 * 额外功能：每次循环前检查收件箱
 *
 * @param messages - 对话历史
 */
async function agentLoop(messages: Anthropic.MessageParam[]): Promise<void> {
  while (true) {
    // 检查 lead 的收件箱：队友可能发来了消息
    const inbox = BUS.readInbox("lead");
    if (inbox.length > 0) {
      // 将收件箱消息注入对话历史
      messages.push({
        role: "user",
        content: `<inbox>${JSON.stringify(inbox, null, 2)}</inbox>`,
      });
      // 添加确认消息（让 LLM 知道已收到）
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

    // 追加 LLM 响应
    messages.push({
      role: "assistant",
      content: response.content,
    });

    // 检查是否需要工具
    if (response.stop_reason !== "tool_use") {
      return;
    }

    // 执行工具调用
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
        // 打印工具调用和结果
        console.log(`> ${block.name}: ${output.slice(0, 200)}`);
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: output,
        });
      }
    }

    // 将工具结果反馈给 LLM
    messages.push({
      role: "user",
      content: results,
    });
  }
}

/**
 * 主函数：交互式命令行界面
 *
 * 支持的特殊命令：
 * - /team: 列出所有队友
 * - /inbox: 查看 lead 的收件箱
 * - q/exit: 退出程序
 */
async function main() {
  const history: Anthropic.MessageParam[] = [];
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = (query: string): Promise<string> => new Promise((resolve) => rl.question(query, resolve));

  while (true) {
    try {
      // 显示提示符（青色）
      const query = await prompt("\x1b[36ms09 >> \x1b[0m");

      // 检查退出命令
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

      // 处理普通用户输入
      history.push({ role: "user", content: query });
      await agentLoop(history);

      // 打印 LLM 的最终响应
      const lastMessage = history[history.length - 1];
      if (lastMessage.role === "assistant" && Array.isArray(lastMessage.content)) {
        for (const block of lastMessage.content) {
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
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
