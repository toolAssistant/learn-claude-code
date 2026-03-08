#!/usr/bin/env tsx
/**
 * s12_worktree_task_isolation.ts - Worktree + 任务隔离
 *
 * 目录级别的隔离，用于并行任务执行。
 * 任务是控制平面，worktree 是执行平面。
 *
 *     .tasks/task_12.json
 *       {
 *         "id": 12,
 *         "subject": "实现认证重构",
 *         "status": "in_progress",
 *         "worktree": "auth-refactor"
 *       }
 *
 *     .worktrees/index.json
 *       {
 *         "worktrees": [
 *           {
 *             "name": "auth-refactor",
 *             "path": ".../.worktrees/auth-refactor",
 *             "branch": "wt/auth-refactor",
 *             "task_id": 12,
 *             "status": "active"
 *           }
 *         ]
 *       }
 *
 * 核心洞察："通过目录隔离，通过任务 ID 协调。"
 */

import Anthropic from "@anthropic-ai/sdk";
import { config } from "dotenv";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";

// 加载环境变量
config({ override: true });

// 处理自定义 base URL
if (process.env.ANTHROPIC_BASE_URL) {
  delete process.env.ANTHROPIC_AUTH_TOKEN;
}

// 工作目录
const WORKDIR = process.cwd();
const client = new Anthropic({
  baseURL: process.env.ANTHROPIC_BASE_URL,
});
const MODEL = process.env.MODEL_ID!;

/**
 * 检测 Git 仓库根目录
 * @param cwd - 当前工作目录
 * @returns Git 仓库根目录路径，如果不在 Git 仓库中则返回 null
 */
function detectRepoRoot(cwd: string): string | null {
  try {
    const output = execSync("git rev-parse --show-toplevel", {
      cwd,
      encoding: "utf-8",
      timeout: 10000,
    }).trim();
    return fs.existsSync(output) ? output : null;
  } catch {
    return null;
  }
}

// 仓库根目录：用于存储任务和 worktree 数据
const REPO_ROOT = detectRepoRoot(WORKDIR) || WORKDIR;

// 系统提示词：指导 agent 如何使用任务和 worktree 工具
const SYSTEM = `You are a coding agent at ${WORKDIR}. Use task + worktree tools for multi-task work. For parallel or risky changes: create tasks, allocate worktree lanes, run commands in those lanes, then choose keep/remove for closeout. Use worktree_events when you need lifecycle visibility.`;

/**
 * EventBus: 仅追加的生命周期事件日志，用于可观测性
 *
 * 记录所有 worktree 和任务的生命周期事件（创建、删除、绑定等）
 * 事件以 JSONL 格式存储，每行一个 JSON 对象
 */
class EventBus {
  private path: string;

  /**
   * 构造函数：初始化事件日志文件
   * @param eventLogPath - 事件日志文件路径（JSONL 格式）
   */
  constructor(eventLogPath: string) {
    this.path = eventLogPath;
    // 确保目录存在
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    // 如果文件不存在则创建空文件
    if (!fs.existsSync(this.path)) {
      fs.writeFileSync(this.path, "");
    }
  }

  /**
   * 发出事件：追加事件到日志文件
   * @param event - 事件名称（如 "worktree.create.before"）
   * @param task - 可选：关联的任务信息
   * @param worktree - 可选：关联的 worktree 信息
   * @param error - 可选：错误信息
   */
  emit(
    event: string,
    task?: Record<string, any>,
    worktree?: Record<string, any>,
    error?: string
  ): void {
    const payload: Record<string, any> = {
      event,
      ts: Date.now() / 1000,  // Unix 时间戳（秒）
      task: task || {},
      worktree: worktree || {},
    };
    if (error) {
      payload.error = error;
    }
    // 追加到文件（JSONL 格式：每行一个 JSON）
    fs.appendFileSync(this.path, JSON.stringify(payload) + "\n");
  }

  /**
   * 列出最近的事件
   * @param limit - 返回的事件数量（默认 20，最大 200）
   * @returns JSON 格式的事件列表
   */
  listRecent(limit: number = 20): string {
    const n = Math.max(1, Math.min(limit || 20, 200));
    const lines = fs.readFileSync(this.path, "utf-8").split("\n").filter((l) => l);
    const recent = lines.slice(-n);  // 取最后 n 行
    const items: any[] = [];
    for (const line of recent) {
      try {
        items.push(JSON.parse(line));
      } catch {
        // 解析失败时保留原始行
        items.push({ event: "parse_error", raw: line });
      }
    }
    return JSON.stringify(items, null, 2);
  }
}

/**
 * Task 接口：任务数据结构
 */
interface Task {
  id: number;              // 任务 ID（唯一标识）
  subject: string;         // 任务主题
  description: string;     // 任务描述
  status: string;          // 状态：pending | in_progress | completed
  owner: string;           // 任务所有者（agent 名称）
  worktree: string;        // 绑定的 worktree 名称
  blockedBy: number[];     // 阻塞此任务的其他任务 ID 列表
  created_at: number;      // 创建时间（Unix 时间戳）
  updated_at: number;      // 更新时间（Unix 时间戳）
}

/**
 * TaskManager: 持久化任务看板，支持可选的 worktree 绑定
 *
 * 任务存储在 .tasks/ 目录下，每个任务一个 JSON 文件
 * 任务可以绑定到 worktree，实现任务与执行环境的关联
 */
class TaskManager {
  private dir: string;      // 任务目录路径
  private nextId: number;   // 下一个任务 ID

  /**
   * 构造函数：初始化任务管理器
   * @param tasksDir - 任务存储目录
   */
  constructor(tasksDir: string) {
    this.dir = tasksDir;
    fs.mkdirSync(this.dir, { recursive: true });
    this.nextId = this.maxId() + 1;  // 从现有任务中找到最大 ID
  }

  /**
   * 获取当前最大任务 ID
   * @returns 最大任务 ID，如果没有任务则返回 0
   */
  private maxId(): number {
    const ids: number[] = [];
    const files = fs.readdirSync(this.dir).filter((f) => f.startsWith("task_") && f.endsWith(".json"));
    for (const file of files) {
      try {
        const id = parseInt(file.split("_")[1]);
        ids.push(id);
      } catch {}
    }
    return ids.length > 0 ? Math.max(...ids) : 0;
  }

  /**
   * 获取任务文件路径
   * @param taskId - 任务 ID
   * @returns 任务文件的完整路径
   */
  private taskPath(taskId: number): string {
    return path.join(this.dir, `task_${taskId}.json`);
  }

  /**
   * 从文件加载任务
   * @param taskId - 任务 ID
   * @returns 任务对象
   * @throws 如果任务不存在
   */
  private load(taskId: number): Task {
    const p = this.taskPath(taskId);
    if (!fs.existsSync(p)) {
      throw new Error(`Task ${taskId} not found`);
    }
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  }

  /**
   * 保存任务到文件
   * @param task - 任务对象
   */
  private save(task: Task): void {
    fs.writeFileSync(this.taskPath(task.id), JSON.stringify(task, null, 2));
  }

  /**
   * 创建新任务
   * @param subject - 任务主题
   * @param description - 任务描述（可选）
   * @returns JSON 格式的任务信息
   */
  create(subject: string, description: string = ""): string {
    const task: Task = {
      id: this.nextId,
      subject,
      description,
      status: "pending",
      owner: "",
      worktree: "",
      blockedBy: [],
      created_at: Date.now() / 1000,
      updated_at: Date.now() / 1000,
    };
    this.save(task);
    this.nextId++;
    return JSON.stringify(task, null, 2);
  }

  /**
   * 获取任务详情
   * @param taskId - 任务 ID
   * @returns JSON 格式的任务信息
   */
  get(taskId: number): string {
    return JSON.stringify(this.load(taskId), null, 2);
  }

  /**
   * 检查任务是否存在
   * @param taskId - 任务 ID
   * @returns 任务是否存在
   */
  exists(taskId: number): boolean {
    return fs.existsSync(this.taskPath(taskId));
  }

  /**
   * 更新任务状态或所有者
   * @param taskId - 任务 ID
   * @param status - 可选：新状态
   * @param owner - 可选：新所有者
   * @returns JSON 格式的更新后任务信息
   */
  update(taskId: number, status?: string, owner?: string): string {
    const task = this.load(taskId);
    if (status) {
      if (!["pending", "in_progress", "completed"].includes(status)) {
        throw new Error(`Invalid status: ${status}`);
      }
      task.status = status;
    }
    if (owner !== undefined) {
      task.owner = owner;
    }
    task.updated_at = Date.now() / 1000;
    this.save(task);
    return JSON.stringify(task, null, 2);
  }

  /**
   * 绑定任务到 worktree
   * @param taskId - 任务 ID
   * @param worktree - worktree 名称
   * @param owner - 可选：任务所有者
   * @returns JSON 格式的更新后任务信息
   */
  bindWorktree(taskId: number, worktree: string, owner: string = ""): string {
    const task = this.load(taskId);
    task.worktree = worktree;
    if (owner) {
      task.owner = owner;
    }
    // 绑定 worktree 时自动将状态改为 in_progress
    if (task.status === "pending") {
      task.status = "in_progress";
    }
    task.updated_at = Date.now() / 1000;
    this.save(task);
    return JSON.stringify(task, null, 2);
  }

  /**
   * 解绑任务的 worktree
   * @param taskId - 任务 ID
   * @returns JSON 格式的更新后任务信息
   */
  unbindWorktree(taskId: number): string {
    const task = this.load(taskId);
    task.worktree = "";
    task.updated_at = Date.now() / 1000;
    this.save(task);
    return JSON.stringify(task, null, 2);
  }

  /**
   * 列出所有任务
   * @returns 格式化的任务列表字符串
   */
  listAll(): string {
    const tasks: Task[] = [];
    const files = fs.readdirSync(this.dir).filter((f) => f.startsWith("task_") && f.endsWith(".json"));
    for (const file of files.sort()) {
      tasks.push(JSON.parse(fs.readFileSync(path.join(this.dir, file), "utf-8")));
    }
    if (tasks.length === 0) {
      return "No tasks.";
    }
    const lines: string[] = [];
    for (const t of tasks) {
      // 根据状态显示不同的标记
      const marker = { pending: "[ ]", in_progress: "[>]", completed: "[x]" }[t.status] || "[?]";
      const owner = t.owner ? ` owner=${t.owner}` : "";
      const wt = t.worktree ? ` wt=${t.worktree}` : "";
      lines.push(`${marker} #${t.id}: ${t.subject}${owner}${wt}`);
    }
    return lines.join("\n");
  }
}

// 初始化全局任务管理器和事件总线
const TASKS = new TaskManager(path.join(REPO_ROOT, ".tasks"));
const EVENTS = new EventBus(path.join(REPO_ROOT, ".worktrees", "events.jsonl"));

/**
 * WorktreeEntry 接口：worktree 条目数据结构
 */
interface WorktreeEntry {
  name: string;           // worktree 名称
  path: string;           // worktree 目录路径
  branch: string;         // Git 分支名
  task_id?: number;       // 可选：绑定的任务 ID
  status: string;         // 状态：active | removed | kept
  created_at?: number;    // 创建时间
  removed_at?: number;    // 删除时间
  kept_at?: number;       // 标记为保留的时间
}

/**
 * WorktreeIndex 接口：worktree 索引文件结构
 */
interface WorktreeIndex {
  worktrees: WorktreeEntry[];
}

/**
 * WorktreeManager: 创建/列出/运行/删除 git worktree + 生命周期索引
 *
 * 管理 Git worktree 的完整生命周期：
 * - 创建独立的工作目录和分支
 * - 在 worktree 中执行命令
 * - 跟踪 worktree 状态和任务绑定
 * - 清理或保留 worktree
 */
class WorktreeManager {
  private repoRoot: string;        // Git 仓库根目录
  private tasks: TaskManager;      // 任务管理器引用
  private events: EventBus;        // 事件总线引用
  private dir: string;             // worktree 存储目录
  private indexPath: string;       // 索引文件路径
  private gitAvailable: boolean;   // Git 是否可用

  /**
   * 构造函数：初始化 worktree 管理器
   * @param repoRoot - Git 仓库根目录
   * @param tasks - 任务管理器实例
   * @param events - 事件总线实例
   */
  constructor(repoRoot: string, tasks: TaskManager, events: EventBus) {
    this.repoRoot = repoRoot;
    this.tasks = tasks;
    this.events = events;
    this.dir = path.join(repoRoot, ".worktrees");
    fs.mkdirSync(this.dir, { recursive: true });
    this.indexPath = path.join(this.dir, "index.json");
    // 初始化索引文件
    if (!fs.existsSync(this.indexPath)) {
      fs.writeFileSync(this.indexPath, JSON.stringify({ worktrees: [] }, null, 2));
    }
    this.gitAvailable = this.isGitRepo();
  }

  /**
   * 检查是否在 Git 仓库中
   * @returns 是否在 Git 仓库中
   */
  private isGitRepo(): boolean {
    try {
      execSync("git rev-parse --is-inside-work-tree", {
        cwd: this.repoRoot,
        encoding: "utf-8",
        timeout: 10000,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 执行 Git 命令
   * @param args - Git 命令参数数组
   * @returns 命令输出
   * @throws 如果不在 Git 仓库中或命令失败
   */
  private runGit(args: string[]): string {
    if (!this.gitAvailable) {
      throw new Error("Not in a git repository. worktree tools require git.");
    }
    try {
      const output = execSync(`git ${args.join(" ")}`, {
        cwd: this.repoRoot,
        encoding: "utf-8",
        timeout: 120000,
      });
      return output.trim() || "(no output)";
    } catch (error: any) {
      const msg = (error.stdout || "") + (error.stderr || "");
      throw new Error(msg.trim() || `git ${args.join(" ")} failed`);
    }
  }

  /**
   * 加载 worktree 索引
   * @returns worktree 索引对象
   */
  private loadIndex(): WorktreeIndex {
    return JSON.parse(fs.readFileSync(this.indexPath, "utf-8"));
  }

  /**
   * 保存 worktree 索引
   * @param data - worktree 索引对象
   */
  private saveIndex(data: WorktreeIndex): void {
    fs.writeFileSync(this.indexPath, JSON.stringify(data, null, 2));
  }

  /**
   * 查找 worktree
   * @param name - worktree 名称
   * @returns worktree 条目，如果不存在则返回 undefined
   */
  private find(name: string): WorktreeEntry | undefined {
    const idx = this.loadIndex();
    return idx.worktrees.find((wt) => wt.name === name);
  }

  /**
   * 验证 worktree 名称
   * @param name - worktree 名称
   * @throws 如果名称不符合规范
   */
  private validateName(name: string): void {
    if (!/^[A-Za-z0-9._-]{1,40}$/.test(name || "")) {
      throw new Error("Invalid worktree name. Use 1-40 chars: letters, numbers, ., _, -");
    }
  }

  /**
   * 创建新的 worktree
   * @param name - worktree 名称
   * @param taskId - 可选：绑定的任务 ID
   * @param baseRef - 基准引用（默认 "HEAD"）
   * @returns JSON 格式的 worktree 信息
   * @throws 如果名称无效、已存在或任务不存在
   */
  create(name: string, taskId?: number, baseRef: string = "HEAD"): string {
    this.validateName(name);
    if (this.find(name)) {
      throw new Error(`Worktree '${name}' already exists in index`);
    }
    if (taskId !== undefined && !this.tasks.exists(taskId)) {
      throw new Error(`Task ${taskId} not found`);
    }

    const wtPath = path.join(this.dir, name);
    const branch = `wt/${name}`;  // 分支命名约定：wt/<worktree-name>

    // 发出创建前事件
    this.events.emit(
      "worktree.create.before",
      taskId !== undefined ? { id: taskId } : undefined,
      { name, base_ref: baseRef }
    );

    try {
      // 执行 git worktree add 命令
      this.runGit(["worktree", "add", "-b", branch, wtPath, baseRef]);

      // 创建索引条目
      const entry: WorktreeEntry = {
        name,
        path: wtPath,
        branch,
        task_id: taskId,
        status: "active",
        created_at: Date.now() / 1000,
      };

      // 更新索引文件
      const idx = this.loadIndex();
      idx.worktrees.push(entry);
      this.saveIndex(idx);

      // 如果指定了任务 ID，绑定任务到 worktree
      if (taskId !== undefined) {
        this.tasks.bindWorktree(taskId, name);
      }

      // 发出创建后事件
      this.events.emit(
        "worktree.create.after",
        taskId !== undefined ? { id: taskId } : undefined,
        { name, path: wtPath, branch, status: "active" }
      );
      return JSON.stringify(entry, null, 2);
    } catch (error: any) {
      // 发出创建失败事件
      this.events.emit(
        "worktree.create.failed",
        taskId !== undefined ? { id: taskId } : undefined,
        { name, base_ref: baseRef },
        error.message
      );
      throw error;
    }
  }

  /**
   * 列出所有 worktree
   * @returns 格式化的 worktree 列表字符串
   */
  listAll(): string {
    const idx = this.loadIndex();
    const wts = idx.worktrees;
    if (wts.length === 0) {
      return "No worktrees in index.";
    }
    const lines: string[] = [];
    for (const wt of wts) {
      const suffix = wt.task_id ? ` task=${wt.task_id}` : "";
      lines.push(`[${wt.status || "unknown"}] ${wt.name} -> ${wt.path} (${wt.branch || "-"})${suffix}`);
    }
    return lines.join("\n");
  }

  /**
   * 获取 worktree 的 Git 状态
   * @param name - worktree 名称
   * @returns Git 状态输出
   */
  status(name: string): string {
    const wt = this.find(name);
    if (!wt) {
      return `Error: Unknown worktree '${name}'`;
    }
    if (!fs.existsSync(wt.path)) {
      return `Error: Worktree path missing: ${wt.path}`;
    }
    try {
      const output = execSync("git status --short --branch", {
        cwd: wt.path,
        encoding: "utf-8",
        timeout: 60000,
      });
      return output.trim() || "Clean worktree";
    } catch (error: any) {
      return (error.stdout || "") + (error.stderr || "");
    }
  }

  /**
   * 在指定 worktree 中执行命令
   * @param name - worktree 名称
   * @param command - 要执行的命令
   * @returns 命令输出或错误信息
   */
  run(name: string, command: string): string {
    // 安全检查：阻止危险命令
    const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
    if (dangerous.some((d) => command.includes(d))) {
      return "Error: Dangerous command blocked";
    }

    const wt = this.find(name);
    if (!wt) {
      return `Error: Unknown worktree '${name}'`;
    }
    if (!fs.existsSync(wt.path)) {
      return `Error: Worktree path missing: ${wt.path}`;
    }

    try {
      // 在 worktree 目录中执行命令
      const output = execSync(command, {
        cwd: wt.path,  // 关键：在 worktree 目录中执行
        encoding: "utf-8",
        timeout: 300000,  // 5 分钟超时
        maxBuffer: 50000 * 1024,
      });
      return output.trim().slice(0, 50000) || "(no output)";
    } catch (error: any) {
      if (error.killed) {
        return "Error: Timeout (300s)";
      }
      const out = (error.stdout || "") + (error.stderr || "");
      return out.slice(0, 50000);
    }
  }

  /**
   * 删除 worktree
   * @param name - worktree 名称
   * @param force - 是否强制删除（即使有未提交的更改）
   * @param completeTask - 是否同时将绑定的任务标记为完成
   * @returns 成功消息
   * @throws 如果删除失败
   */
  remove(name: string, force: boolean = false, completeTask: boolean = false): string {
    const wt = this.find(name);
    if (!wt) {
      return `Error: Unknown worktree '${name}'`;
    }

    // 发出删除前事件
    this.events.emit(
      "worktree.remove.before",
      wt.task_id !== undefined ? { id: wt.task_id } : undefined,
      { name, path: wt.path }
    );

    try {
      // 构建 git worktree remove 命令
      const args = ["worktree", "remove"];
      if (force) {
        args.push("--force");
      }
      args.push(wt.path);
      this.runGit(args);

      // 如果需要，完成关联的任务
      if (completeTask && wt.task_id !== undefined) {
        const taskId = wt.task_id;
        const before = JSON.parse(this.tasks.get(taskId));
        this.tasks.update(taskId, "completed");
        this.tasks.unbindWorktree(taskId);
        this.events.emit(
          "task.completed",
          { id: taskId, subject: before.subject || "", status: "completed" },
          { name }
        );
      }

      // 更新索引：标记为已删除
      const idx = this.loadIndex();
      for (const item of idx.worktrees) {
        if (item.name === name) {
          item.status = "removed";
          item.removed_at = Date.now() / 1000;
        }
      }
      this.saveIndex(idx);

      // 发出删除后事件
      this.events.emit(
        "worktree.remove.after",
        wt.task_id !== undefined ? { id: wt.task_id } : undefined,
        { name, path: wt.path, status: "removed" }
      );
      return `Removed worktree '${name}'`;
    } catch (error: any) {
      // 发出删除失败事件
      this.events.emit(
        "worktree.remove.failed",
        wt.task_id !== undefined ? { id: wt.task_id } : undefined,
        { name, path: wt.path },
        error.message
      );
      throw error;
    }
  }

  /**
   * 标记 worktree 为保留状态
   * 用于表示这个 worktree 应该长期保留，不是临时的
   * @param name - worktree 名称
   * @returns JSON 格式的 worktree 信息
   */
  keep(name: string): string {
    const wt = this.find(name);
    if (!wt) {
      return `Error: Unknown worktree '${name}'`;
    }

    // 更新索引：标记为保留
    const idx = this.loadIndex();
    let kept: WorktreeEntry | undefined;
    for (const item of idx.worktrees) {
      if (item.name === name) {
        item.status = "kept";
        item.kept_at = Date.now() / 1000;
        kept = item;
      }
    }
    this.saveIndex(idx);

    // 发出保留事件
    this.events.emit(
      "worktree.keep",
      wt.task_id !== undefined ? { id: wt.task_id } : undefined,
      { name, path: wt.path, status: "kept" }
    );
    return kept ? JSON.stringify(kept, null, 2) : `Error: Unknown worktree '${name}'`;
  }
}

// 初始化全局 worktree 管理器
const WORKTREES = new WorktreeManager(REPO_ROOT, TASKS, EVENTS);

// === 基础工具函数 ===

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
 * @param command - 要执行的 shell 命令
 * @returns 命令输出或错误信息
 */
function runBash(command: string): string {
  // 安全检查：阻止危险命令
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((d) => command.includes(d))) {
    return "Error: Dangerous command blocked";
  }
  try {
    const output = execSync(command, {
      cwd: WORKDIR,
      encoding: "utf-8",
      timeout: 120000,  // 120秒超时
      maxBuffer: 50000 * 1024,  // 50MB 缓冲
    });
    return output.trim().slice(0, 50000) || "(no output)";
  } catch (error: any) {
    if (error.killed) {
      return "Error: Timeout (120s)";
    }
    const out = (error.stdout || "") + (error.stderr || "");
    return out.slice(0, 50000);
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
 * @param filePath - 文件路径
 * @param content - 要写入的内容
 * @returns 成功消息或错误信息
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
 * @param filePath - 文件路径
 * @param oldText - 要替换的旧文本
 * @param newText - 新文本
 * @returns 成功消息或错误信息
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

// === 工具调度映射 ===
// 将工具名称映射到对应的处理函数
// 包含基础工具、任务管理工具和 worktree 管理工具
const TOOL_HANDLERS: Record<string, (args: any) => string> = {
  // 基础工具
  bash: (args) => runBash(args.command),
  read_file: (args) => runRead(args.path, args.limit),
  write_file: (args) => runWrite(args.path, args.content),
  edit_file: (args) => runEdit(args.path, args.old_text, args.new_text),

  // 任务管理工具
  task_create: (args) => TASKS.create(args.subject, args.description || ""),
  task_list: () => TASKS.listAll(),
  task_get: (args) => TASKS.get(args.task_id),
  task_update: (args) => TASKS.update(args.task_id, args.status, args.owner),
  task_bind_worktree: (args) => TASKS.bindWorktree(args.task_id, args.worktree, args.owner || ""),

  // Worktree 管理工具
  worktree_create: (args) => WORKTREES.create(args.name, args.task_id, args.base_ref || "HEAD"),
  worktree_list: () => WORKTREES.listAll(),
  worktree_status: (args) => WORKTREES.status(args.name),
  worktree_run: (args) => WORKTREES.run(args.name, args.command),
  worktree_keep: (args) => WORKTREES.keep(args.name),
  worktree_remove: (args) => WORKTREES.remove(args.name, args.force || false, args.complete_task || false),

  // 事件查询工具
  worktree_events: (args) => EVENTS.listRecent(args.limit || 20),
};

// === 工具定义数组 ===
// 告诉 LLM 有哪些工具可用及其参数
const TOOLS: Anthropic.Tool[] = [
  // 基础工具
  {
    name: "bash",
    description: "在当前工作区执行 shell 命令（阻塞式）。",
    input_schema: {
      type: "object",
      properties: { command: { type: "string", description: "要执行的命令" } },
      required: ["command"],
    },
  },
  {
    name: "read_file",
    description: "读取文件内容。",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件路径" },
        limit: { type: "integer", description: "可选：限制读取的行数" },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "写入内容到文件。",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件路径" },
        content: { type: "string", description: "文件内容" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description: "替换文件中的精确文本。",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件路径" },
        old_text: { type: "string", description: "要替换的旧文本" },
        new_text: { type: "string", description: "新文本" },
      },
      required: ["path", "old_text", "new_text"],
    },
  },
  // 任务管理工具
  {
    name: "task_create",
    description: "在共享任务看板上创建新任务。",
    input_schema: {
      type: "object",
      properties: {
        subject: { type: "string", description: "任务主题" },
        description: { type: "string", description: "任务描述" },
      },
      required: ["subject"],
    },
  },
  {
    name: "task_list",
    description: "列出所有任务及其状态、所有者和 worktree 绑定。",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "task_get",
    description: "根据 ID 获取任务详情。",
    input_schema: {
      type: "object",
      properties: { task_id: { type: "integer", description: "任务 ID" } },
      required: ["task_id"],
    },
  },
  {
    name: "task_update",
    description: "更新任务状态或所有者。",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "integer", description: "任务 ID" },
        status: { type: "string", enum: ["pending", "in_progress", "completed"], description: "任务状态" },
        owner: { type: "string", description: "任务所有者" },
      },
      required: ["task_id"],
    },
  },
  {
    name: "task_bind_worktree",
    description: "将任务绑定到 worktree 名称。",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "integer", description: "任务 ID" },
        worktree: { type: "string", description: "worktree 名称" },
        owner: { type: "string", description: "任务所有者" },
      },
      required: ["task_id", "worktree"],
    },
  },
  // Worktree 管理工具
  {
    name: "worktree_create",
    description: "创建 git worktree 并可选地绑定到任务。",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "worktree 名称" },
        task_id: { type: "integer", description: "可选：绑定的任务 ID" },
        base_ref: { type: "string", description: "基准引用（默认 HEAD）" },
      },
      required: ["name"],
    },
  },
  {
    name: "worktree_list",
    description: "列出 .worktrees/index.json 中跟踪的所有 worktree。",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "worktree_status",
    description: "显示指定 worktree 的 git 状态。",
    input_schema: {
      type: "object",
      properties: { name: { type: "string", description: "worktree 名称" } },
      required: ["name"],
    },
  },
  {
    name: "worktree_run",
    description: "在指定 worktree 目录中执行 shell 命令。",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "worktree 名称" },
        command: { type: "string", description: "要执行的命令" },
      },
      required: ["name", "command"],
    },
  },
  {
    name: "worktree_remove",
    description: "删除 worktree 并可选地将其绑定的任务标记为完成。",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "worktree 名称" },
        force: { type: "boolean", description: "是否强制删除" },
        complete_task: { type: "boolean", description: "是否完成关联任务" },
      },
      required: ["name"],
    },
  },
  {
    name: "worktree_keep",
    description: "将 worktree 标记为保留状态而不删除它。",
    input_schema: {
      type: "object",
      properties: { name: { type: "string", description: "worktree 名称" } },
      required: ["name"],
    },
  },
  {
    name: "worktree_events",
    description: "从 .worktrees/events.jsonl 列出最近的 worktree/任务生命周期事件。",
    input_schema: {
      type: "object",
      properties: { limit: { type: "integer", description: "返回的事件数量" } },
    },
  },
];

/**
 * Agent 循环：与 s01 相同的核心循环
 * 不断调用 LLM 并执行工具，直到 LLM 停止请求工具
 *
 * @param messages - 对话历史（会被修改）
 */
async function agentLoop(messages: Anthropic.MessageParam[]): Promise<void> {
  while (true) {
    // 调用 LLM
    const response = await client.messages.create({
      model: MODEL,
      system: SYSTEM,
      messages,
      tools: TOOLS,
      max_tokens: 8000,
    });

    // 追加 LLM 响应到对话历史
    messages.push({ role: "assistant", content: response.content });

    // 如果不需要工具，退出循环
    if (response.stop_reason !== "tool_use") {
      return;
    }

    // 执行所有工具调用
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type === "tool_use") {
        const handler = TOOL_HANDLERS[block.name];
        let output: string;
        try {
          // 调用对应的工具处理函数
          output = handler ? handler(block.input) : `Unknown tool: ${block.name}`;
        } catch (error: any) {
          output = `Error: ${error.message}`;
        }
        // 打印工具调用结果（前 200 个字符）
        console.log(`> ${block.name}: ${output.slice(0, 200)}`);
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: output,
        });
      }
    }
    // 将工具结果反馈给 LLM
    messages.push({ role: "user", content: results });
  }
}

/**
 * 主函数：交互式命令行界面
 * 实现 REPL 循环，让用户与 agent 交互
 */
async function main() {
  console.log(`Repo root for s12: ${REPO_ROOT}`);
  if (!WORKTREES["gitAvailable"]) {
    console.log("Note: Not in a git repo. worktree_* tools will return errors.");
  }

  // 对话历史
  const history: Anthropic.MessageParam[] = [];

  // 创建 readline 接口
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // 封装 readline.question 为 Promise
  const prompt = (query: string): Promise<string> =>
    new Promise((resolve) => rl.question(query, resolve));

  // 主循环：读取用户输入并处理
  while (true) {
    try {
      // 显示提示符并等待输入
      const query = await prompt("\x1b[36ms12 >> \x1b[0m");

      // 检查退出命令
      if (!query || ["q", "exit", ""].includes(query.trim().toLowerCase())) {
        break;
      }

      // 将用户输入添加到历史
      history.push({ role: "user", content: query });

      // 调用 agent 循环处理
      await agentLoop(history);

      // 提取并打印 LLM 的最终响应
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


