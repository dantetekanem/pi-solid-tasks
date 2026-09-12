/**
 * task-store.ts — File-backed task store with CRUD, dependency management, and file locking.
 *
 * Session-scoped (default): in-memory Map — no disk I/O.
 * Shared (PI_TASK_LIST_ID set): ~/.pi/tasks/<listId>.json with file locking.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { Task, TaskBatchItem, TaskCreateOptions, TaskCreatePosition, TaskStatus, TaskStoreData } from "./types.js";

function sortById(a: Task, b: Task): number {
  return Number(a.id) - Number(b.id);
}

function compareTaskOrder(a: Task, b: Task): number {
  return a.order - b.order || sortById(a, b);
}

function sortByQueue(a: Task, b: Task): number {
  const completedRank = (task: Task) => task.status === "completed" ? 1 : 0;
  return completedRank(a) - completedRank(b) || compareTaskOrder(a, b);
}

function sortByStatus(a: Task, b: Task): number {
  const rank = (s: string) => s === "completed" ? 0 : s === "in_progress" ? 1 : 2;
  return rank(a.status) - rank(b.status) || compareTaskOrder(a, b);
}

function sortByRecent(a: Task, b: Task): number {
  return b.updatedAt - a.updatedAt || sortById(a, b);
}

function sortByOldest(a: Task, b: Task): number {
  return a.updatedAt - b.updatedAt || sortById(a, b);
}

const SORT_FNS = {
  queue: sortByQueue,
  id: sortById,
  status: sortByStatus,
  recent: sortByRecent,
  oldest: sortByOldest,
};

const TASKS_DIR = join(homedir(), ".pi", "tasks");
export const MAX_PARALLEL_RUNNING_TASKS = 4;
const LOCK_RETRY_MS = 50;
const LOCK_MAX_RETRIES = 100; // 5s max

/** Simple file-based locking. */
function acquireLock(lockPath: string): void {
  for (let i = 0; i < LOCK_MAX_RETRIES; i++) {
    try {
      // O_EXCL: fail if file exists
      writeFileSync(lockPath, `${process.pid}`, { flag: "wx" });
      return;
    } catch (e: any) {
      if (e.code === "EEXIST") {
        // Check for stale lock (process no longer running)
        try {
          const pid = parseInt(readFileSync(lockPath, "utf-8"), 10);
          if (pid && !isProcessRunning(pid)) {
            unlinkSync(lockPath);
            continue;
          }
        } catch { /* ignore read errors */ }
        // Wait and retry
        const start = Date.now();
        while (Date.now() - start < LOCK_RETRY_MS) { /* busy wait */ }
        continue;
      }
      throw e;
    }
  }
  throw new Error(`Failed to acquire lock: ${lockPath}`);
}

function releaseLock(lockPath: string): void {
  try { unlinkSync(lockPath); } catch { /* ignore */ }
}

function isProcessRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export class TaskPositionError extends Error {
  override name = "TaskPositionError";
}

export type TaskUpdateErrorCode = "missing_dependency" | "self_dependency" | "dependency_cycle" | "blocked" | "invalid_status" | "invalid_hierarchy" | "owner_busy" | "parallel_limit";

export class TaskUpdateError extends Error {
  override name = "TaskUpdateError";

  constructor(
    readonly code: TaskUpdateErrorCode,
    message: string,
    readonly taskIds: string[] = [],
  ) {
    super(message);
  }
}

type DependencyGraph = Map<string, Set<string>>;

export class TaskStore {
  private filePath: string | undefined;
  private lockPath: string | undefined;

  // In-memory state (always kept in sync)
  private nextId = 1;
  private tasks = new Map<string, Task>();

  constructor(listIdOrPath?: string) {
    if (!listIdOrPath) return;
    const isAbsPath = isAbsolute(listIdOrPath);
    const filePath = isAbsPath ? listIdOrPath : join(TASKS_DIR, `${listIdOrPath}.json`);
    mkdirSync(dirname(filePath), { recursive: true });
    this.filePath = filePath;
    this.lockPath = filePath + ".lock";
    this.load();
  }

  /** Read store from disk (file-backed mode only). */
  private load(): void {
    if (!this.filePath) return;
    if (!existsSync(this.filePath)) return;
    try {
      const data: TaskStoreData = JSON.parse(readFileSync(this.filePath, "utf-8"));
      this.nextId = data.nextId;
      this.tasks.clear();
      const tasks = data.tasks
        .map((task, index) => ({
          ...task,
          order: Number.isFinite(task.order) ? task.order : index,
        }))
        .sort(compareTaskOrder);
      for (const [index, task] of tasks.entries()) {
        task.order = index;
        this.tasks.set(task.id, task);
      }
      const normalizedGraph = this.normalizedDependencyGraph(this.dependencyGraph());
      if (normalizedGraph) this.applyDependencyGraph(normalizedGraph, false);
      this.refreshGroupStatuses();
    } catch { /* corrupt file — start fresh */ }
  }

  /** Write store to disk atomically (file-backed mode only). */
  private save(): void {
    if (!this.filePath) return;
    const data: TaskStoreData = {
      nextId: this.nextId,
      tasks: Array.from(this.tasks.values()).sort(compareTaskOrder),
    };
    const tmpPath = this.filePath + ".tmp";
    writeFileSync(tmpPath, JSON.stringify(data, null, 2));
    renameSync(tmpPath, this.filePath);
  }

  /** Execute a mutation with file locking (if file-backed). */
  private withLock<T>(fn: () => T): T {
    if (!this.lockPath) return fn();
    acquireLock(this.lockPath);
    try {
      this.load(); // Re-read latest state
      const result = fn();
      this.save();
      return result;
    } finally {
      releaseLock(this.lockPath);
    }
  }

  private orderedTasks(): Task[] {
    return Array.from(this.tasks.values()).sort(compareTaskOrder);
  }

  private isGroup(task: Task | undefined): boolean {
    return task?.kind === "group";
  }

  private hasChildren(id: string): boolean {
    return Array.from(this.tasks.values()).some(task => task.parentId === id);
  }

  private refreshGroupStatuses(): void {
    const visiting = new Set<string>();
    const derive = (group: Task): TaskStatus => {
      if (!this.isGroup(group) || visiting.has(group.id)) return group.status;
      visiting.add(group.id);
      const children = Array.from(this.tasks.values()).filter(task => task.parentId === group.id);
      const statuses = children.map(child => this.isGroup(child) ? derive(child) : child.status);
      visiting.delete(group.id);
      const status: TaskStatus = statuses.length === 0 || statuses.every(value => value === "pending")
        ? "pending"
        : statuses.every(value => value === "completed") ? "completed" : "in_progress";
      group.status = status;
      return status;
    };
    for (const task of this.tasks.values()) if (this.isGroup(task)) derive(task);
  }

  private validateCreateOptions(options: TaskCreateOptions): void {
    if (options.parentId === undefined) return;
    const parent = this.tasks.get(options.parentId);
    if (!parent) throw new TaskUpdateError("invalid_hierarchy", `Parent task #${options.parentId} does not exist`, [options.parentId]);
    if (!this.isGroup(parent)) throw new TaskUpdateError("invalid_hierarchy", `Parent task #${options.parentId} must be a group`, [options.parentId]);
    if (options.kind === "group" || parent.parentId !== undefined) {
      throw new TaskUpdateError("invalid_hierarchy", "Subtasks have one level only: a root group can contain executable tasks, not subgroups", [options.parentId]);
    }
  }

  private createIndex(position: TaskCreatePosition, openTasks: Task[]): number {
    if (position.type === "beginning") return 0;
    if (position.type === "end") return openTasks.length;

    const anchor = this.tasks.get(position.taskId);
    if (!anchor) throw new TaskPositionError(`Task #${position.taskId} not found`);
    if (anchor.status === "completed") {
      throw new TaskPositionError(`Task #${position.taskId} is completed; choose an open task as the position anchor`);
    }

    const anchorIndex = openTasks.findIndex(task => task.id === anchor.id);
    return position.type === "before" ? anchorIndex : anchorIndex + 1;
  }

  create(
    subject: string,
    description: string,
    activeForm?: string,
    metadata?: Record<string, any>,
    position: TaskCreatePosition = { type: "end" },
    options: TaskCreateOptions = {},
  ): Task {
    return this.withLock(() => {
      this.validateCreateOptions(options);
      const ordered = this.orderedTasks();
      const openTasks = ordered.filter(task => task.status !== "completed");
      const completedTasks = ordered.filter(task => task.status === "completed");
      const insertionIndex = this.createIndex(position, openTasks);
      const now = Date.now();
      const task: Task = {
        id: String(this.nextId++),
        subject,
        description,
        status: "pending",
        order: 0,
        kind: options.kind,
        parentId: options.parentId,
        activeForm,
        owner: undefined,
        metadata: metadata ?? {},
        blocks: [],
        blockedBy: [],
        createdAt: now,
        updatedAt: now,
      };

      openTasks.splice(insertionIndex, 0, task);
      for (const [index, orderedTask] of [...openTasks, ...completedTasks].entries()) {
        orderedTask.order = index;
      }
      this.tasks.set(task.id, task);
      this.refreshGroupStatuses();
      return task;
    });
  }

  /** Isolate create/start previews; neither operation mutates nested metadata. */
  private memorySnapshot(): TaskStore {
    const snapshot = new TaskStore();
    snapshot.nextId = this.nextId;
    snapshot.tasks = new Map(Array.from(this.tasks, ([id, task]) => [id, {
      ...task, blocks: [...task.blocks], blockedBy: [...task.blockedBy],
    }]));
    return snapshot;
  }

  createInBatch(items: TaskBatchItem[]): Task[] {
    return this.withLock(() => {
      if (!Array.isArray(items) || items.length === 0) {
        throw new TaskUpdateError("invalid_hierarchy", "A batch must contain at least one task");
      }
      const staged = this.memorySnapshot(); // After the locked reload, never before it.
      const created: Task[] = [];
      const append = (item: TaskBatchItem, path: string, parentId?: string): void => {
        if (!item || typeof item.subject !== "string" || typeof item.description !== "string" ||
          (item.activeForm !== undefined && typeof item.activeForm !== "string") ||
          (item.metadata !== undefined && (!item.metadata || typeof item.metadata !== "object" || Array.isArray(item.metadata))) ||
          (item.kind !== undefined && item.kind !== "task" && item.kind !== "group") ||
          (parentId !== undefined && ("kind" in item || "parentId" in item || "children" in item)) ||
          (item.kind === "group" && item.parentId !== undefined) ||
          (item.children !== undefined && (item.kind !== "group" || !Array.isArray(item.children)))) {
          throw new TaskUpdateError("invalid_hierarchy", `Invalid batch item at ${path}: use root groups with one level of executable children`);
        }
        const task = staged.create(item.subject, item.description, item.activeForm, item.metadata, undefined, {
          kind: item.kind, parentId: parentId ?? item.parentId,
        });
        created.push(task);
        for (const [index, child] of (item.children ?? []).entries()) append(child, `${path}.children[${index}]`, task.id);
      };
      for (const [index, item] of items.entries()) append(item, `tasks[${index}]`);
      this.tasks = staged.tasks;
      this.nextId = staged.nextId;
      return created;
    });
  }

  get(id: string): Task | undefined {
    if (this.filePath) this.load();
    this.refreshGroupStatuses();
    return this.tasks.get(id);
  }

  /** List all tasks, sorted by the given order (defaults to open task order, then completed). */
  list(sortOrder: "queue" | "id" | "status" | "recent" | "oldest" = "queue"): Task[] {
    if (this.filePath) this.load();
    this.refreshGroupStatuses();
    return Array.from(this.tasks.values()).sort(SORT_FNS[sortOrder]);
  }

  /** Advisory selection only: the eventual start still validates the current store. */
  nextReadyTask(owner?: string): Task | undefined {
    const tasks = this.list();
    const preview = this.memorySnapshot();
    for (const task of tasks) {
      if (this.isGroup(task) || task.status !== "pending" || (task.owner && task.owner !== owner)) continue;
      try {
        preview.update(task.id, { status: "in_progress", owner });
        return task;
      } catch (error) {
        if (!(error instanceof TaskUpdateError)) throw error;
      }
    }
    return undefined;
  }

  /** Build the canonical blocker -> dependent graph from both persisted edge directions. */
  private dependencyGraph(): DependencyGraph {
    const graph: DependencyGraph = new Map();
    for (const task of this.tasks.values()) graph.set(task.id, new Set());

    for (const task of this.tasks.values()) {
      const dependents = graph.get(task.id)!;
      for (const dependentId of task.blocks) dependents.add(dependentId);
      for (const blockerId of task.blockedBy) {
        const blockerDependents = graph.get(blockerId) ?? new Set<string>();
        blockerDependents.add(task.id);
        graph.set(blockerId, blockerDependents);
      }
    }
    return graph;
  }

  private cloneDependencyGraph(graph: DependencyGraph): DependencyGraph {
    return new Map(Array.from(graph, ([taskId, dependents]) => [taskId, new Set(dependents)]));
  }

  private pathExists(graph: DependencyGraph, startId: string, targetId: string): boolean {
    const pending = [startId];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (current === targetId) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      for (const dependentId of graph.get(current) ?? []) pending.push(dependentId);
    }
    return false;
  }

  private graphReferencesKnownTasks(graph: DependencyGraph): boolean {
    for (const [blockerId, dependents] of graph) {
      if (!this.tasks.has(blockerId)) return false;
      for (const dependentId of dependents) {
        if (!this.tasks.has(dependentId)) return false;
      }
    }
    return true;
  }

  private graphIsAcyclic(graph: DependencyGraph): boolean {
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (taskId: string): boolean => {
      if (visiting.has(taskId)) return false;
      if (visited.has(taskId)) return true;
      visiting.add(taskId);
      for (const dependentId of graph.get(taskId) ?? []) {
        if (!visit(dependentId)) return false;
      }
      visiting.delete(taskId);
      visited.add(taskId);
      return true;
    };

    return Array.from(graph.keys()).every(visit);
  }

  /** Return the unique reachability-preserving reduction for a valid dependency DAG. */
  private normalizedDependencyGraph(graph: DependencyGraph): DependencyGraph | undefined {
    if (!this.graphReferencesKnownTasks(graph) || !this.graphIsAcyclic(graph)) return undefined;

    const reduced = this.cloneDependencyGraph(graph);
    const edges = Array.from(graph, ([blockerId, dependents]) =>
      Array.from(dependents, dependentId => [blockerId, dependentId] as [string, string])
    ).flat();

    for (const [blockerId, dependentId] of edges) {
      const dependents = reduced.get(blockerId)!;
      dependents.delete(dependentId);
      if (!this.pathExists(reduced, blockerId, dependentId)) dependents.add(dependentId);
    }
    return reduced;
  }

  private applyDependencyGraph(graph: DependencyGraph, updateTimestamps = true): void {
    const orderedIds = this.orderedTasks().map(task => task.id);
    const now = Date.now();
    for (const task of this.tasks.values()) {
      const nextBlocks = orderedIds.filter(dependentId => graph.get(task.id)?.has(dependentId));
      const nextBlockedBy = orderedIds.filter(blockerId => graph.get(blockerId)?.has(task.id));
      const changed =
        task.blocks.length !== nextBlocks.length ||
        task.blocks.some((taskId, index) => taskId !== nextBlocks[index]) ||
        task.blockedBy.length !== nextBlockedBy.length ||
        task.blockedBy.some((taskId, index) => taskId !== nextBlockedBy[index]);
      if (!changed) continue;
      task.blocks = nextBlocks;
      task.blockedBy = nextBlockedBy;
      if (updateTimestamps) task.updatedAt = now;
    }
  }

  /** Validate the complete candidate edge set without mutating stored tasks. */
  private proposedDependencyGraph(
    taskId: string,
    addBlocks: string[] = [],
    addBlockedBy: string[] = [],
  ): { graph: DependencyGraph; addedEdges: Array<[string, string]>; normalized: boolean } {
    const graph = this.dependencyGraph();
    const proposedEdges: Array<[blockerId: string, dependentId: string]> = [
      ...addBlocks.map(dependentId => [taskId, dependentId] as [string, string]),
      ...addBlockedBy.map(blockerId => [blockerId, taskId] as [string, string]),
    ];
    const addedEdges: Array<[string, string]> = [];

    for (const [blockerId, dependentId] of proposedEdges) {
      if (!this.tasks.has(blockerId)) {
        throw new TaskUpdateError(
          "missing_dependency",
          `Cannot add dependency: task #${blockerId} does not exist`,
          [blockerId],
        );
      }
      if (!this.tasks.has(dependentId)) {
        throw new TaskUpdateError(
          "missing_dependency",
          `Cannot add dependency: task #${dependentId} does not exist`,
          [dependentId],
        );
      }
      if (this.isGroup(this.tasks.get(blockerId)) || this.isGroup(this.tasks.get(dependentId))) {
        throw new TaskUpdateError(
          "invalid_hierarchy",
          "Dependencies can only connect executable leaf tasks, not groups",
          [blockerId, dependentId],
        );
      }
      if (blockerId === dependentId) {
        throw new TaskUpdateError(
          "self_dependency",
          `Task #${taskId} cannot depend on itself`,
          [taskId],
        );
      }

      const dependents = graph.get(blockerId)!;
      if (dependents.has(dependentId)) continue;
      if (this.pathExists(graph, dependentId, blockerId)) {
        throw new TaskUpdateError(
          "dependency_cycle",
          `Cannot add dependency #${blockerId} -> #${dependentId}: it would create a cycle`,
          [blockerId, dependentId],
        );
      }
      dependents.add(dependentId);
      addedEdges.push([blockerId, dependentId]);
    }

    const normalizedGraph = this.normalizedDependencyGraph(graph);
    return {
      graph: normalizedGraph ?? graph,
      addedEdges,
      normalized: normalizedGraph !== undefined,
    };
  }

  private unfinishedBlockerIds(taskId: string, graph: DependencyGraph): string[] {
    const blockerIds: string[] = [];
    for (const [blockerId, dependents] of graph) {
      if (dependents.has(taskId)) blockerIds.push(blockerId);
    }

    const order = new Map(this.orderedTasks().map((task, index) => [task.id, index]));
    return blockerIds
      .filter(blockerId => this.tasks.get(blockerId)?.status !== "completed")
      .sort((a, b) => (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER));
  }

  update(id: string, fields: {
    status?: TaskStatus | "deleted";
    subject?: string;
    description?: string;
    activeForm?: string;
    owner?: string;
    metadata?: Record<string, any>;
    addBlocks?: string[];
    addBlockedBy?: string[];
  }): { task: Task | undefined; changedFields: string[]; warnings: string[] } {
    return this.withLock(() => {
      const task = this.tasks.get(id);
      if (!task) return { task: undefined, changedFields: [], warnings: [] };

      const changedFields: string[] = [];
      const warnings: string[] = [];

      // Handle deletion
      if (fields.status === "deleted") {
        if (this.hasChildren(id)) {
          throw new TaskUpdateError(
            "invalid_hierarchy",
            `Cannot delete parent task #${id} while it has children`,
            [id],
          );
        }
        this.tasks.delete(id);
        // Clean up dependency edges pointing to this task
        for (const t of this.tasks.values()) {
          t.blocks = t.blocks.filter(bid => bid !== id);
          t.blockedBy = t.blockedBy.filter(bid => bid !== id);
        }
        this.refreshGroupStatuses();
        return { task: undefined, changedFields: ["deleted"], warnings: [] };
      }

      if (this.isGroup(task)) {
        if (fields.status !== undefined) {
          throw new TaskUpdateError("invalid_hierarchy", `Group #${id} status is derived from its children`, [id]);
        }
        if (fields.owner !== undefined) {
          throw new TaskUpdateError("invalid_hierarchy", `Group #${id} cannot have an owner`, [id]);
        }
      }

      // Validate the full candidate graph and status invariants before mutating any field.
      const dependencyUpdate = this.proposedDependencyGraph(id, fields.addBlocks, fields.addBlockedBy);
      const { graph: dependencyGraph, addedEdges, normalized } = dependencyUpdate;
      const statusFor = (taskId: string): TaskStatus =>
        taskId === id && fields.status && fields.status !== "deleted"
          ? fields.status
          : (this.tasks.get(taskId)?.status ?? "pending");

      if (fields.status === "in_progress" || fields.status === "completed") {
        const unfinishedBlockers = this.unfinishedBlockerIds(id, dependencyGraph);
        if (unfinishedBlockers.length > 0) {
          const action = fields.status === "completed" ? "complete" : "start";
          throw new TaskUpdateError(
            "blocked",
            `Task #${id} cannot ${action}; blocked by ${unfinishedBlockers.map(blockerId => `#${blockerId}`).join(", ")}. Complete all declared dependencies first.`,
            unfinishedBlockers,
          );
        }
      }

      for (const [blockerId, dependentId] of addedEdges) {
        if (!dependencyGraph.get(blockerId)?.has(dependentId)) continue;
        const dependentStatus = statusFor(dependentId);
        if (
          (dependentStatus === "in_progress" || dependentStatus === "completed") &&
          statusFor(blockerId) !== "completed"
        ) {
          throw new TaskUpdateError(
            "blocked",
            `Cannot add unfinished blocker #${blockerId} to ${dependentStatus} task #${dependentId}`,
            [blockerId, dependentId],
          );
        }
      }

      if (task.status === "completed" && fields.status && fields.status !== "completed") {
        const protectedDependents = Array.from(dependencyGraph.get(id) ?? [])
          .filter(dependentId => {
            const dependentStatus = statusFor(dependentId);
            return dependentStatus === "in_progress" || dependentStatus === "completed";
          });
        if (protectedDependents.length > 0) {
          throw new TaskUpdateError(
            "invalid_status",
            `Cannot reopen completed task #${id}; active or completed dependents require it: ${protectedDependents.map(dependentId => `#${dependentId}`).join(", ")}`,
            [id, ...protectedDependents],
          );
        }
      }

      if (fields.status === "in_progress" && task.status !== "in_progress") {
        const runningTasks = this.orderedTasks().filter(candidate =>
          candidate.id !== id && !this.isGroup(candidate) && candidate.status === "in_progress"
        );
        if (runningTasks.length >= MAX_PARALLEL_RUNNING_TASKS) {
          throw new TaskUpdateError(
            "parallel_limit",
            `Task #${id} cannot start. At most ${MAX_PARALLEL_RUNNING_TASKS} tasks can be in progress at once; complete one before starting another.`,
            [...runningTasks.map(candidate => candidate.id), id],
          );
        }
      }

      const effectiveOwner = fields.owner ?? task.owner;
      if (
        task.status === "in_progress" &&
        task.owner &&
        fields.owner !== undefined &&
        fields.owner !== task.owner
      ) {
        throw new TaskUpdateError(
          "owner_busy",
          `Owner ${task.owner} must finish or undo task #${id} before changing its owner`,
          [id],
        );
      }

      const isClaimingActiveTask =
        fields.status === "in_progress" ||
        (task.status === "in_progress" && fields.owner !== undefined && fields.owner !== task.owner);
      if (isClaimingActiveTask && effectiveOwner) {
        const otherOwnedTask = this.orderedTasks().find(candidate =>
          candidate.id !== id &&
          !this.isGroup(candidate) &&
          candidate.owner === effectiveOwner &&
          candidate.status !== "completed"
        );
        if (otherOwnedTask) {
          throw new TaskUpdateError(
            "owner_busy",
            `Owner ${effectiveOwner} must finish or undo task #${otherOwnedTask.id} before claiming task #${id}`,
            [otherOwnedTask.id, id],
          );
        }
      }

      if (fields.status === "in_progress") {
        const unfinishedEarlierTasks = this.orderedTasks().filter(candidate => {
          if (this.isGroup(candidate) || candidate.order >= task.order || candidate.status === "completed") return false;
          if (this.pathExists(dependencyGraph, id, candidate.id)) return false;
          return !(
            candidate.status === "in_progress" &&
            candidate.owner &&
            effectiveOwner &&
            candidate.owner !== effectiveOwner
          );
        });
        if (unfinishedEarlierTasks.length > 0) {
          const noun = unfinishedEarlierTasks.length === 1 ? "task" : "tasks";
          const verb = unfinishedEarlierTasks.length === 1 ? "is" : "are";
          throw new TaskUpdateError(
            "blocked",
            `Task #${id} cannot start before earlier ${noun} ${unfinishedEarlierTasks.map(candidate => `#${candidate.id}`).join(", ")} ${verb} completed or actively owned by another owner`,
            unfinishedEarlierTasks.map(candidate => candidate.id),
          );
        }
      }

      if (fields.status !== undefined) {
        task.status = fields.status;
        changedFields.push("status");
      }
      if (fields.subject !== undefined) {
        task.subject = fields.subject;
        changedFields.push("subject");
      }
      if (fields.description !== undefined) {
        task.description = fields.description;
        changedFields.push("description");
      }
      if (fields.activeForm !== undefined) {
        task.activeForm = fields.activeForm;
        changedFields.push("activeForm");
      }
      if (fields.owner !== undefined) {
        task.owner = fields.owner;
        changedFields.push("owner");
      }

      // Metadata: shallow merge, null deletes keys
      if (fields.metadata !== undefined) {
        for (const [key, value] of Object.entries(fields.metadata)) {
          if (value === null) {
            delete task.metadata[key];
          } else {
            task.metadata[key] = value;
          }
        }
        changedFields.push("metadata");
      }

      if (fields.addBlocks && fields.addBlocks.length > 0) changedFields.push("blocks");
      if (fields.addBlockedBy && fields.addBlockedBy.length > 0) changedFields.push("blockedBy");

      // Valid DAGs are persisted in their minimal bidirectional form. Invalid legacy
      // graphs remain untouched unless a separately validated edge is added.
      if (normalized) {
        this.applyDependencyGraph(dependencyGraph);
      } else {
        if (fields.addBlocks && fields.addBlocks.length > 0) {
          for (const targetId of fields.addBlocks) {
            if (!task.blocks.includes(targetId)) task.blocks.push(targetId);
            const target = this.tasks.get(targetId)!;
            if (!target.blockedBy.includes(id)) {
              target.blockedBy.push(id);
              target.updatedAt = Date.now();
            }
          }
        }

        if (fields.addBlockedBy && fields.addBlockedBy.length > 0) {
          for (const blockerId of fields.addBlockedBy) {
            if (!task.blockedBy.includes(blockerId)) task.blockedBy.push(blockerId);
            const blocker = this.tasks.get(blockerId)!;
            if (!blocker.blocks.includes(id)) {
              blocker.blocks.push(id);
              blocker.updatedAt = Date.now();
            }
          }
        }
      }

      task.updatedAt = Date.now();
      this.refreshGroupStatuses();
      return { task, changedFields, warnings };
    });
  }

  /** Delete a task by ID. Returns true if deleted. */
  delete(id: string): boolean {
    return this.withLock(() => {
      if (!this.tasks.has(id) || this.hasChildren(id)) return false;
      this.tasks.delete(id);
      // Clean up dependency edges
      for (const t of this.tasks.values()) {
        t.blocks = t.blocks.filter(bid => bid !== id);
        t.blockedBy = t.blockedBy.filter(bid => bid !== id);
      }
      return true;
    });
  }

  /** Remove all tasks. */
  clearAll(): number {
    return this.withLock(() => {
      const count = this.tasks.size;
      this.tasks.clear();
      return count;
    });
  }

  /** Delete the backing file (if file-backed and empty). */
  deleteFileIfEmpty(): boolean {
    if (!this.filePath || this.tasks.size > 0) return false;
    try { unlinkSync(this.filePath); } catch { /* ignore */ }
    return true;
  }

  /** Remove all completed tasks. */
  clearCompleted(): number {
    return this.withLock(() => {
      let count = 0;
      this.refreshGroupStatuses();
      const deletedIds = new Set<string>();
      const addHierarchy = (id: string): void => {
        if (deletedIds.has(id)) return;
        deletedIds.add(id);
        for (const child of this.tasks.values()) if (child.parentId === id) addHierarchy(child.id);
      };
      for (const task of this.tasks.values()) {
        if (this.isGroup(task) && !task.parentId && task.status === "completed") addHierarchy(task.id);
        if (!this.isGroup(task) && !task.parentId && task.status === "completed") deletedIds.add(task.id);
      }
      for (const id of deletedIds) {
        this.tasks.delete(id);
        count++;
      }
      // Clean up dependency edges for deleted tasks
      if (count > 0) {
        const validIds = new Set(this.tasks.keys());
        for (const t of this.tasks.values()) {
          t.blocks = t.blocks.filter(bid => validIds.has(bid));
          t.blockedBy = t.blockedBy.filter(bid => validIds.has(bid));
        }
      }
      return count;
    });
  }
}
